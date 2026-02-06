/**
 * Kamino Multiply Client
 * Manages leveraged staking positions (e.g. JitoSOL<>SOL).
 *
 * Multiply works by:
 * 1. Deposit JitoSOL as collateral
 * 2. Borrow SOL against it
 * 3. Swap borrowed SOL → JitoSOL
 * 4. Deposit the new JitoSOL as more collateral
 * 5. Repeat until target leverage reached
 *
 * Net APY = stakingAPY * leverage - borrowAPY * (leverage - 1)
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createSolanaRpc, address } from '@solana/kit';
import { KaminoMarket, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import Decimal from 'decimal.js';
import {
  MultiplyPosition,
  MultiplySettings,
  StrategyType,
  TOKEN_MINTS,
  KAMINO_MARKETS,
} from './types';
import { fetchLiveJitoStakingApy } from './scanner';

// Retry helper
async function retry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      const isRateLimit = err.message?.includes('429') || err.message?.includes('Too Many');
      const wait = isRateLimit ? delayMs * (i + 2) : delayMs;
      console.log(`   ⏳ Multiply retry ${i + 1}/${maxRetries} in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('Max retries exceeded');
}

export class MultiplyClient {
  private connection: Connection;
  private rpc: ReturnType<typeof createSolanaRpc>;
  private settings: MultiplySettings;
  private markets: Map<string, KaminoMarket> = new Map();

  constructor(rpcUrl: string, settings?: Partial<MultiplySettings>) {
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    this.rpc = createSolanaRpc(rpcUrl);
    this.settings = {
      maxLeverage: settings?.maxLeverage ?? 5,
      minSpread: settings?.minSpread ?? 1.0,
      maxLtv: settings?.maxLtv ?? 0.85,
      preferredMarket: settings?.preferredMarket ?? KAMINO_MARKETS.JITO,
    };
  }

  /**
   * Load a Kamino market by address.
   */
  async loadMarket(marketAddress: string): Promise<KaminoMarket> {
    if (this.markets.has(marketAddress)) {
      return this.markets.get(marketAddress)!;
    }

    console.log(`   📡 Loading market ${marketAddress.slice(0, 8)}...`);
    const market = await retry(() =>
      KaminoMarket.load(this.rpc, address(marketAddress), 400, PROGRAM_ID)
    );
    if (!market) throw new Error(`Failed to load market: ${marketAddress}`);

    this.markets.set(marketAddress, market);
    return market;
  }

  /**
   * Get current rates for JitoSOL<>SOL multiply strategy.
   * Returns borrow rate for SOL and supply rate for JitoSOL in the given market.
   */
  async getMultiplyRates(marketAddress?: string): Promise<{
    jitosolSupplyApy: Decimal;
    solBorrowApy: Decimal;
    spread: Decimal;
    maxLtv: Decimal;
    netApyAt5x: Decimal;
  }> {
    const addr = marketAddress || this.settings.preferredMarket;

    // Try loading the Jito market first, fall back to main market
    let market: KaminoMarket;
    try {
      market = await this.loadMarket(addr);
    } catch {
      console.log(`   ⚠️  Jito market not available, falling back to main market`);
      market = await this.loadMarket(KAMINO_MARKETS.MAIN);
    }

    const slot = BigInt(await this.connection.getSlot());
    const reserves = market.getReserves();

    let jitosolSupplyApy = new Decimal(0);
    let solBorrowApy = new Decimal(0);
    let maxLtv = new Decimal(0.85);

    for (const reserve of reserves) {
      const symbol = reserve.symbol?.toUpperCase();
      const mint = reserve.getLiquidityMint().toString();

      if (mint === TOKEN_MINTS.JitoSOL || symbol === 'JITOSOL') {
        const supplyApy = reserve.totalSupplyAPY(slot);
        jitosolSupplyApy = new Decimal(supplyApy || 0).mul(100);

        // Try to get max LTV from reserve config
        try {
          const config = reserve.state?.config;
          if (config?.loanToValuePct) {
            maxLtv = new Decimal(config.loanToValuePct).div(100);
          }
        } catch {}
      }

      if (mint === TOKEN_MINTS.SOL || symbol === 'SOL') {
        const borrowApy = reserve.totalBorrowAPY(slot);
        solBorrowApy = new Decimal(borrowApy || 0).mul(100);
      }
    }

    // Fetch LIVE JitoSOL staking yield from Jito API instead of hardcoding
    let jitoStakingYield: Decimal;
    try {
      const liveApy = await fetchLiveJitoStakingApy();
      jitoStakingYield = new Decimal(liveApy.apy);
      console.log(`   📊 Live JitoSOL staking APY: ${jitoStakingYield.toFixed(2)}% (${liveApy.source})`);
    } catch {
      // Fallback to supply APY or conservative estimate
      jitoStakingYield = jitosolSupplyApy.gt(0)
        ? jitosolSupplyApy
        : new Decimal(5.57); // fallback based on recent data
      console.log(`   ⚠️  Using fallback JitoSOL APY: ${jitoStakingYield.toFixed(2)}%`);
    }

    const spread = jitoStakingYield.minus(solBorrowApy);

    // Net APY at 5x: stakingYield * leverage - borrowCost * (leverage - 1)
    const leverage = new Decimal(5);
    const netApyAt5x = jitoStakingYield
      .mul(leverage)
      .minus(solBorrowApy.mul(leverage.minus(1)));

    return {
      jitosolSupplyApy: jitoStakingYield,
      solBorrowApy,
      spread,
      maxLtv,
      netApyAt5x,
    };
  }

  /**
   * Scan existing Multiply-style positions for a wallet.
   * Looks for obligations with both deposits (JitoSOL) and borrows (SOL).
   */
  async getUserMultiplyPositions(
    walletPubkey: PublicKey,
    marketAddress?: string
  ): Promise<MultiplyPosition[]> {
    const positions: MultiplyPosition[] = [];
    const addr = marketAddress || this.settings.preferredMarket;

    let market: KaminoMarket;
    try {
      market = await this.loadMarket(addr);
    } catch {
      // Try main market if Jito market fails
      try {
        market = await this.loadMarket(KAMINO_MARKETS.MAIN);
      } catch {
        return positions;
      }
    }

    const slot = BigInt(await this.connection.getSlot());
    const walletAddr = address(walletPubkey.toBase58());

    try {
      // Get all obligations for this wallet in this market
      const obligations = await retry(
        () => market.getAllUserObligations(walletAddr),
        2,
        3000
      );

      if (!obligations || obligations.length === 0) return positions;

      for (const obligation of obligations) {
        let collateralAmount = new Decimal(0);
        let collateralToken = '';
        let collateralApy = new Decimal(0);
        let debtAmount = new Decimal(0);
        let debtToken = '';
        let borrowApy = new Decimal(0);
        let collateralValueUsd = new Decimal(0);
        let debtValueUsd = new Decimal(0);

        // Parse deposits (collateral)
        for (const [reserveAddr, deposit] of obligation.deposits.entries()) {
          const reserve = market.getReserveByAddress(reserveAddr);
          if (!reserve) continue;
          const mint = reserve.getLiquidityMint().toString();

          if (mint === TOKEN_MINTS.JitoSOL) {
            collateralToken = 'JitoSOL';
            collateralAmount = new Decimal(deposit.amount?.toString() || 0).div(1e9);
            collateralValueUsd = new Decimal(deposit.marketValueRefreshed?.toString() || 0);
            collateralApy = new Decimal(reserve.totalSupplyAPY(slot) || 0).mul(100);
          }
        }

        // Parse borrows (debt)
        for (const [reserveAddr, borrow] of obligation.borrows.entries()) {
          const reserve = market.getReserveByAddress(reserveAddr);
          if (!reserve) continue;
          const mint = reserve.getLiquidityMint().toString();

          if (mint === TOKEN_MINTS.SOL) {
            debtToken = 'SOL';
            debtAmount = new Decimal(borrow.amount?.toString() || 0).div(LAMPORTS_PER_SOL);
            debtValueUsd = new Decimal(borrow.marketValueRefreshed?.toString() || 0);
            borrowApy = new Decimal(reserve.totalBorrowAPY(slot) || 0).mul(100);
          }
        }

        // Only include as Multiply position if it has both collateral and debt
        if (collateralToken && debtToken && collateralAmount.gt(0) && debtAmount.gt(0)) {
          const netValueUsd = collateralValueUsd.minus(debtValueUsd);
          const leverage = collateralValueUsd.gt(0) && netValueUsd.gt(0)
            ? collateralValueUsd.div(netValueUsd)
            : new Decimal(1);
          const ltv = collateralValueUsd.gt(0)
            ? debtValueUsd.div(collateralValueUsd)
            : new Decimal(0);
          const netApy = collateralApy
            .mul(leverage)
            .minus(borrowApy.mul(leverage.minus(1)));

          positions.push({
            obligationAddress: obligation.obligationAddress?.toString() || 'unknown',
            marketAddress: addr,
            collateralToken,
            debtToken,
            collateralAmount,
            debtAmount,
            netValueUsd,
            leverage,
            ltv,
            maxLtv: new Decimal(this.settings.maxLtv),
            collateralApy,
            borrowApy,
            netApy,
            strategy: StrategyType.MULTIPLY,
          });
        }
      }
    } catch (err: any) {
      console.log(`   ⚠️  Could not fetch multiply positions: ${err.message}`);
    }

    return positions;
  }

  /**
   * Check if it's profitable to open a Multiply position.
   */
  async shouldOpenPosition(): Promise<{
    profitable: boolean;
    reason: string;
    rates: Awaited<ReturnType<MultiplyClient['getMultiplyRates']>>;
  }> {
    const rates = await this.getMultiplyRates();

    if (rates.spread.lt(this.settings.minSpread)) {
      return {
        profitable: false,
        reason: `Spread too low: ${rates.spread.toFixed(2)}% (min: ${this.settings.minSpread}%)`,
        rates,
      };
    }

    if (rates.netApyAt5x.lte(0)) {
      return {
        profitable: false,
        reason: `Negative net APY at 5x: ${rates.netApyAt5x.toFixed(2)}%`,
        rates,
      };
    }

    return {
      profitable: true,
      reason: `Spread: ${rates.spread.toFixed(2)}%, Net APY @5x: ${rates.netApyAt5x.toFixed(2)}%`,
      rates,
    };
  }

  /**
   * Monitor health of existing Multiply positions.
   */
  async monitorPositions(
    walletPubkey: PublicKey
  ): Promise<{ healthy: boolean; warnings: string[]; positions: MultiplyPosition[] }> {
    const warnings: string[] = [];
    const positions = await this.getUserMultiplyPositions(walletPubkey);

    for (const pos of positions) {
      // Check LTV
      if (pos.ltv.gt(this.settings.maxLtv)) {
        warnings.push(
          `⚠️ HIGH LTV on ${pos.collateralToken}/${pos.debtToken}: ${pos.ltv.mul(100).toFixed(1)}% (max: ${new Decimal(this.settings.maxLtv).mul(100).toFixed(0)}%)`
        );
      }

      // Check if still profitable
      if (pos.netApy.lte(0)) {
        warnings.push(
          `⚠️ NEGATIVE APY on ${pos.collateralToken}/${pos.debtToken}: ${pos.netApy.toFixed(2)}% — consider closing`
        );
      }

      // Check if spread has compressed
      const spread = pos.collateralApy.minus(pos.borrowApy);
      if (spread.lt(this.settings.minSpread)) {
        warnings.push(
          `⚠️ LOW SPREAD on ${pos.collateralToken}/${pos.debtToken}: ${spread.toFixed(2)}% — monitor closely`
        );
      }
    }

    return {
      healthy: warnings.length === 0,
      warnings,
      positions,
    };
  }

  /**
   * Placeholder for opening a multiply position.
   * In production, this would:
   * 1. Swap SOL → JitoSOL via Jupiter
   * 2. Deposit JitoSOL as collateral
   * 3. Borrow SOL
   * 4. Loop steps 1-3 until target leverage
   *
   * This is structurally sound but requires live funds to test.
   */
  async openPosition(
    _wallet: Keypair,
    _amountSol: Decimal,
    _targetLeverage: number,
    dryRun: boolean = true
  ): Promise<{ success: boolean; message: string }> {
    if (!dryRun) {
      // In production, implement the loop:
      // 1. JupiterClient.executeSwap('SOL', 'JitoSOL', amount)
      // 2. KaminoClient.deposit(wallet, 'JitoSOL', amount) into Jito market
      // 3. KaminoClient.borrow(wallet, 'SOL', borrowAmount) from Jito market
      // 4. Repeat 1-3 until leverage reached
      return {
        success: false,
        message: 'Live multiply position opening not yet implemented — use Kamino UI for now',
      };
    }

    const profitCheck = await this.shouldOpenPosition();
    if (!profitCheck.profitable) {
      return {
        success: false,
        message: `Would not open: ${profitCheck.reason}`,
      };
    }

    return {
      success: true,
      message: `DRY RUN — Would open ${_targetLeverage}x JitoSOL/SOL position with ${_amountSol} SOL. ${profitCheck.reason}`,
    };
  }

  /**
   * Placeholder for closing/unwinding a multiply position.
   */
  async closePosition(
    _wallet: Keypair,
    _position: MultiplyPosition,
    dryRun: boolean = true
  ): Promise<{ success: boolean; message: string }> {
    if (!dryRun) {
      return {
        success: false,
        message: 'Live multiply position closing not yet implemented — use Kamino UI for now',
      };
    }

    return {
      success: true,
      message: `DRY RUN — Would close ${_position.leverage.toFixed(1)}x ${_position.collateralToken}/${_position.debtToken} position (net value: $${_position.netValueUsd.toFixed(2)})`,
    };
  }
}
