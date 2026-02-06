/**
 * Multi-Token Portfolio Manager
 * Tracks positions across K-Lend and Multiply, calculates blended APY,
 * and determines rebalancing actions.
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Decimal from 'decimal.js';
import {
  PortfolioAllocation,
  StrategyType,
  Position,
  MultiplyPosition,
  PortfolioSettings,
  TOKEN_MINTS,
  TOKEN_DECIMALS,
} from './types';
import { KaminoClient } from './kamino-client';
import { MultiplyClient } from './multiply-client';

/** Retry helper */
async function retry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      const isRateLimit = err.message?.includes('429') || err.message?.includes('Too Many');
      const wait = isRateLimit ? delayMs * (i + 2) : delayMs;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('Max retries exceeded');
}

export interface TokenBalances {
  SOL: Decimal;
  USDC: Decimal;
  JitoSOL: Decimal;
  [key: string]: Decimal;
}

export interface PortfolioSnapshot {
  timestamp: Date;
  balances: TokenBalances;
  klendPositions: Position[];
  multiplyPositions: MultiplyPosition[];
  allocations: PortfolioAllocation[];
  totalValueUsd: Decimal;
  blendedApy: Decimal;
  solPrice: Decimal;
  jitosolPrice: Decimal;
}

export interface RebalanceAction {
  type: 'swap' | 'deposit' | 'withdraw' | 'openMultiply' | 'closeMultiply';
  from: string;
  to: string;
  amountUi: Decimal;
  token: string;
  reason: string;
}

export class PortfolioManager {
  private connection: Connection;
  private kaminoClient: KaminoClient;
  private multiplyClient: MultiplyClient;
  private settings: PortfolioSettings;

  constructor(
    connection: Connection,
    kaminoClient: KaminoClient,
    multiplyClient: MultiplyClient,
    settings?: PortfolioSettings
  ) {
    this.connection = connection;
    this.kaminoClient = kaminoClient;
    this.multiplyClient = multiplyClient;
    this.settings = settings ?? {
      allocations: {
        klendUsdc: 0.60,
        multiply: 0.30,
        gasReserve: 0.10,
      },
      rebalanceThreshold: 0.10,
    };
  }

  /**
   * Fetch all token balances for wallet.
   */
  async getBalances(walletPubkey: PublicKey): Promise<TokenBalances> {
    const solBalance = await retry(() => this.kaminoClient.getSolBalance(walletPubkey));

    const [usdcBalance, jitosolBalance] = await Promise.all([
      retry(() => this.kaminoClient.getTokenBalance(walletPubkey, TOKEN_MINTS.USDC)).catch(() => new Decimal(0)),
      retry(() => this.kaminoClient.getTokenBalance(walletPubkey, TOKEN_MINTS.JitoSOL)).catch(() => new Decimal(0)),
    ]);

    return {
      SOL: solBalance,
      USDC: usdcBalance,
      JitoSOL: jitosolBalance,
    };
  }

  /**
   * Get a full portfolio snapshot.
   */
  async getSnapshot(
    walletPubkey: PublicKey,
    solPrice: Decimal,
    jitosolPrice?: Decimal
  ): Promise<PortfolioSnapshot> {
    const jitoPx = jitosolPrice ?? solPrice.mul(1.07); // rough JitoSOL/SOL premium

    // Fetch balances and positions in parallel
    const [balances, klendPositions, multiplyMonitor] = await Promise.all([
      this.getBalances(walletPubkey),
      this.kaminoClient.getUserPositions(walletPubkey),
      this.multiplyClient.monitorPositions(walletPubkey),
    ]);

    const multiplyPositions = multiplyMonitor.positions;

    // Calculate values
    const walletSolValue = balances.SOL.mul(solPrice);
    const walletUsdcValue = balances.USDC;
    const walletJitosolValue = balances.JitoSOL.mul(jitoPx);

    // K-Lend position value (only USDC-denominated positions for allocation tracking)
    let klendUsdcValue = new Decimal(0);
    let klendOtherValue = new Decimal(0);
    let klendWeightedApy = new Decimal(0);

    for (const pos of klendPositions) {
      const tokenAmount = pos.token === 'SOL'
        ? pos.tokenAmount.div(LAMPORTS_PER_SOL)
        : pos.tokenAmount.div(new Decimal(10).pow(TOKEN_DECIMALS[pos.token] ?? 6));

      let posValueUsd: Decimal;
      if (pos.token === 'SOL') {
        posValueUsd = tokenAmount.mul(solPrice);
        klendOtherValue = klendOtherValue.plus(posValueUsd);
      } else if (pos.token === 'USDC' || pos.token === 'USDT') {
        posValueUsd = tokenAmount;
        klendUsdcValue = klendUsdcValue.plus(posValueUsd);
      } else if (pos.token === 'JitoSOL') {
        posValueUsd = tokenAmount.mul(jitoPx);
        klendOtherValue = klendOtherValue.plus(posValueUsd);
      } else {
        posValueUsd = tokenAmount; // fallback
        klendOtherValue = klendOtherValue.plus(posValueUsd);
      }

      klendWeightedApy = klendWeightedApy.plus(pos.currentApy.mul(posValueUsd));
    }

    // Multiply position value
    let multiplyValue = new Decimal(0);
    let multiplyWeightedApy = new Decimal(0);
    for (const pos of multiplyPositions) {
      multiplyValue = multiplyValue.plus(pos.netValueUsd);
      multiplyWeightedApy = multiplyWeightedApy.plus(pos.netApy.mul(pos.netValueUsd));
    }

    const totalKlendValue = klendUsdcValue.plus(klendOtherValue);
    const totalValue = walletSolValue
      .plus(walletUsdcValue)
      .plus(walletJitosolValue)
      .plus(totalKlendValue)
      .plus(multiplyValue);

    // Calculate blended APY
    let blendedApy = new Decimal(0);
    const totalInvested = totalKlendValue.plus(multiplyValue);
    if (totalInvested.gt(0)) {
      const totalWeightedApy = klendWeightedApy.plus(multiplyWeightedApy);
      blendedApy = totalWeightedApy.div(totalInvested);
    }

    // Build allocation breakdown
    const allocations: PortfolioAllocation[] = [];

    if (totalValue.gt(0)) {
      const klendUsdcWeight = klendUsdcValue.div(totalValue).toNumber();
      allocations.push({
        strategy: StrategyType.KLEND,
        label: 'K-Lend USDC',
        token: 'USDC',
        targetWeight: this.settings.allocations.klendUsdc,
        currentWeight: klendUsdcWeight,
        currentValueUsd: klendUsdcValue,
        currentApy: totalKlendValue.gt(0)
          ? klendWeightedApy.div(totalKlendValue)
          : new Decimal(0),
        drift: klendUsdcWeight - this.settings.allocations.klendUsdc,
      });

      const multiplyWeight = multiplyValue.div(totalValue).toNumber();
      allocations.push({
        strategy: StrategyType.MULTIPLY,
        label: 'JitoSOL Multiply',
        token: 'JitoSOL',
        targetWeight: this.settings.allocations.multiply,
        currentWeight: multiplyWeight,
        currentValueUsd: multiplyValue,
        currentApy: multiplyValue.gt(0)
          ? multiplyWeightedApy.div(multiplyValue)
          : new Decimal(0),
        drift: multiplyWeight - this.settings.allocations.multiply,
      });

      const gasValue = walletSolValue;
      const gasWeight = gasValue.div(totalValue).toNumber();
      allocations.push({
        strategy: StrategyType.KLEND, // gas reserve is just wallet SOL
        label: 'SOL Gas Reserve',
        token: 'SOL',
        targetWeight: this.settings.allocations.gasReserve,
        currentWeight: gasWeight,
        currentValueUsd: gasValue,
        currentApy: new Decimal(0),
        drift: gasWeight - this.settings.allocations.gasReserve,
      });
    }

    return {
      timestamp: new Date(),
      balances,
      klendPositions,
      multiplyPositions,
      allocations,
      totalValueUsd: totalValue,
      blendedApy,
      solPrice,
      jitosolPrice: jitoPx,
    };
  }

  /**
   * Determine what rebalancing actions are needed.
   */
  computeRebalanceActions(snapshot: PortfolioSnapshot): RebalanceAction[] {
    const actions: RebalanceAction[] = [];
    const threshold = this.settings.rebalanceThreshold;

    if (snapshot.totalValueUsd.lte(0)) return actions;

    for (const alloc of snapshot.allocations) {
      const absDrift = Math.abs(alloc.drift);

      if (absDrift <= threshold) continue;

      const driftValueUsd = snapshot.totalValueUsd.mul(absDrift);

      if (alloc.drift < 0) {
        // Under-allocated — need to add
        if (alloc.strategy === StrategyType.KLEND && alloc.token === 'USDC') {
          // Need more USDC in K-Lend
          // Check if we have idle USDC or need to swap SOL→USDC
          if (snapshot.balances.USDC.gt(1)) {
            actions.push({
              type: 'deposit',
              from: 'wallet',
              to: 'klend-usdc',
              amountUi: Decimal.min(snapshot.balances.USDC, driftValueUsd),
              token: 'USDC',
              reason: `K-Lend USDC under-allocated by ${(absDrift * 100).toFixed(1)}%`,
            });
          } else {
            // Need to swap SOL → USDC first
            const solNeeded = driftValueUsd.div(snapshot.solPrice);
            const availableSol = snapshot.balances.SOL.minus(0.01); // keep gas buffer
            if (availableSol.gt(0.001)) {
              actions.push({
                type: 'swap',
                from: 'SOL',
                to: 'USDC',
                amountUi: Decimal.min(solNeeded, availableSol),
                token: 'SOL',
                reason: `Swap SOL→USDC for K-Lend allocation (${(absDrift * 100).toFixed(1)}% drift)`,
              });
            }
          }
        }

        if (alloc.strategy === StrategyType.MULTIPLY) {
          actions.push({
            type: 'openMultiply',
            from: 'wallet',
            to: 'multiply-jitosol',
            amountUi: driftValueUsd.div(snapshot.solPrice),
            token: 'SOL',
            reason: `Multiply under-allocated by ${(absDrift * 100).toFixed(1)}%`,
          });
        }
      } else {
        // Over-allocated — may need to reduce
        if (alloc.strategy === StrategyType.MULTIPLY && alloc.drift > threshold) {
          actions.push({
            type: 'closeMultiply',
            from: 'multiply-jitosol',
            to: 'wallet',
            amountUi: driftValueUsd.div(snapshot.solPrice),
            token: 'SOL',
            reason: `Multiply over-allocated by ${(absDrift * 100).toFixed(1)}%`,
          });
        }
      }
    }

    return actions;
  }

  /**
   * Print a clean portfolio summary.
   */
  printSummary(snapshot: PortfolioSnapshot): void {
    console.log('\n┌──────────────────────────────────────────────────────┐');
    console.log('│              📊 PORTFOLIO SUMMARY                    │');
    console.log('├──────────────────────────────────────────────────────┤');

    console.log(`│  Total Value:  $${snapshot.totalValueUsd.toFixed(2).padStart(12)}                      │`);
    console.log(`│  Blended APY:  ${snapshot.blendedApy.toFixed(2).padStart(7)}%                          │`);
    console.log('├──────────────────────────────────────────────────────┤');

    console.log('│  Wallet Balances:                                    │');
    console.log(`│    SOL:     ${snapshot.balances.SOL.toFixed(6).padStart(12)} ($${snapshot.balances.SOL.mul(snapshot.solPrice).toFixed(2)})       │`);
    console.log(`│    USDC:    ${snapshot.balances.USDC.toFixed(2).padStart(12)}                            │`);
    console.log(`│    JitoSOL: ${snapshot.balances.JitoSOL.toFixed(6).padStart(12)}                        │`);

    if (snapshot.allocations.length > 0) {
      console.log('├──────────────────────────────────────────────────────┤');
      console.log('│  Allocations:     Target   Current   Drift          │');
      for (const alloc of snapshot.allocations) {
        const target = `${(alloc.targetWeight * 100).toFixed(0)}%`.padStart(5);
        const current = `${(alloc.currentWeight * 100).toFixed(1)}%`.padStart(6);
        const drift = alloc.drift >= 0 ? `+${(alloc.drift * 100).toFixed(1)}%` : `${(alloc.drift * 100).toFixed(1)}%`;
        const driftPad = drift.padStart(6);
        const label = alloc.label.padEnd(20);
        console.log(`│    ${label} ${target}   ${current}   ${driftPad}          │`);
      }
    }

    if (snapshot.klendPositions.length > 0) {
      console.log('├──────────────────────────────────────────────────────┤');
      console.log('│  K-Lend Positions:                                   │');
      for (const pos of snapshot.klendPositions) {
        console.log(`│    ${pos.vaultName.padEnd(16)} ${pos.currentApy.toFixed(2)}% APY              │`);
      }
    }

    if (snapshot.multiplyPositions.length > 0) {
      console.log('├──────────────────────────────────────────────────────┤');
      console.log('│  Multiply Positions:                                 │');
      for (const pos of snapshot.multiplyPositions) {
        console.log(`│    ${pos.collateralToken}/${pos.debtToken} ${pos.leverage.toFixed(1)}x  LTV: ${pos.ltv.mul(100).toFixed(1)}%  APY: ${pos.netApy.toFixed(2)}%  │`);
      }
    }

    console.log('└──────────────────────────────────────────────────────┘');
  }
}
