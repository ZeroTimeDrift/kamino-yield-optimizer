/**
 * Kamino Liquidity Vault Client
 *
 * Manages concentrated liquidity LP positions on Kamino Finance.
 * Kamino liquidity vaults automate concentrated liquidity positions on
 * Orca CLMM, Raydium, and Meteora DEXes.
 *
 * Key operations:
 * - List available vaults (strategies) for a token pair
 * - Get vault details (APY, TVL, position range, token composition)
 * - Deposit tokens into a vault (dual-sided or single-sided)
 * - Withdraw shares from a vault
 * - Check user's LP positions and their value
 */

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createSolanaRpc, address, Address, createKeyPairSignerFromBytes } from '@solana/kit';
import { Kamino, StrategiesFilters, WhirlpoolAprApy, KaminoPosition } from '@kamino-finance/kliquidity-sdk';
import Decimal from 'decimal.js';
import { TOKEN_MINTS, TOKEN_DECIMALS } from './types';

// ─── Known JITOSOL-SOL strategy addresses ──────────────────────
// These are the main Kamino liquidity vaults for the JitoSOL<>SOL pair

export const JITOSOL_SOL_STRATEGIES = {
  // SOL-JitoSOL vaults (tokenA=SOL, tokenB=JitoSOL)
  SOL_JITOSOL_1: '5QgwaBQzzMAHdxpaVUgb4KrpXELgNTaEYXycUvNvRxr6',
  SOL_JITOSOL_2: 'HCntzqDU5wXSWjwgLQP5hqh3kLHRYizKtPErvSCyggXd',
  // JitoSOL-SOL vaults (tokenA=JitoSOL, tokenB=SOL)
  JITOSOL_SOL_1: '4Zuhh9SD6iQyaPx9vTt2cqHpAcwM7JDvUMkqNmyv6oSD',
  JITOSOL_SOL_2: 'EDn9raynT4V2sDPSuT92gpphQzarUgi3mJDuEm149uZ4',
  JITOSOL_SOL_3: 'GrsqRMeKdwXxTLv4QKVeL1qMhHqKqjo3ZabuNwFQAzNi',
};

// All target strategy addresses for quick lookup
export const TARGET_STRATEGIES = Object.values(JITOSOL_SOL_STRATEGIES);

// ─── Types ─────────────────────────────────────────────────────

export interface LiquidityVaultInfo {
  /** On-chain strategy address */
  address: string;
  /** Human-readable name */
  name: string;
  /** DEX the vault uses (Orca/Raydium/Meteora) */
  dex: string;
  /** Token A mint */
  tokenAMint: string;
  /** Token B mint */
  tokenBMint: string;
  /** Token A symbol */
  tokenASymbol: string;
  /** Token B symbol */
  tokenBSymbol: string;
  /** Share (kToken) mint */
  shareMint: string;
  /** Total APY (fees + rewards) */
  totalApy: Decimal;
  /** Fee APY component */
  feeApy: Decimal;
  /** Rewards APY components */
  rewardsApy: Decimal[];
  /** TVL in USD */
  tvlUsd: Decimal;
  /** Current share price */
  sharePrice: Decimal;
  /** Position range (lower price) */
  priceLower: Decimal;
  /** Position range (upper price) */
  priceUpper: Decimal;
  /** Current pool price */
  poolPrice: Decimal;
  /** Whether strategy is out of range */
  outOfRange: boolean;
  /** Token A amount in vault */
  tokenAAmount: Decimal;
  /** Token B amount in vault */
  tokenBAmount: Decimal;
  /** Vault type (PEGGED, NON_PEGGED, STABLE) */
  strategyType: string;
  /** Vault status */
  status: string;
}

export interface LiquidityPosition {
  /** Strategy address */
  strategyAddress: string;
  /** Strategy name */
  name: string;
  /** Share mint address */
  shareMint: string;
  /** Number of kToken shares held */
  sharesAmount: Decimal;
  /** Value of shares in USD */
  valueUsd: Decimal;
  /** Token A amount (user's share) */
  tokenAAmount: Decimal;
  /** Token B amount (user's share) */
  tokenBAmount: Decimal;
  /** Current APY */
  currentApy: Decimal;
  /** DEX */
  dex: string;
}

// ─── Retry helper ──────────────────────────────────────────────

async function retry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      const isRateLimit = err.message?.includes('429') || err.message?.includes('Too Many');
      const wait = isRateLimit ? delayMs * (i + 2) : delayMs;
      console.log(`   ⏳ Liquidity retry ${i + 1}/${maxRetries} in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('Max retries exceeded');
}

// ─── Mint → Symbol mapping ─────────────────────────────────────

const MINT_TO_SYMBOL: Record<string, string> = {};
for (const [symbol, mint] of Object.entries(TOKEN_MINTS)) {
  MINT_TO_SYMBOL[mint] = symbol;
}

function mintToSymbol(mint: string): string {
  return MINT_TO_SYMBOL[mint] || mint.slice(0, 6) + '...';
}

// ─── Main Client ───────────────────────────────────────────────

export class LiquidityClient {
  private connection: Connection;
  private rpc: ReturnType<typeof createSolanaRpc>;
  private kamino: Kamino;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    this.rpc = createSolanaRpc(rpcUrl);
    this.kamino = new Kamino('mainnet-beta', this.rpc as any);
  }

  // ─── List Vaults ───────────────────────────────────────────

  /**
   * List all JITOSOL-SOL liquidity vaults with details.
   * Fetches on-chain strategy data + APY from DEX APIs.
   */
  async listJitoSolVaults(): Promise<LiquidityVaultInfo[]> {
    console.log('🔍 Fetching JitoSOL-SOL liquidity vaults...');

    const vaults: LiquidityVaultInfo[] = [];

    for (const stratAddr of TARGET_STRATEGIES) {
      try {
        const vault = await retry(() => this.getVaultDetails(stratAddr));
        if (vault) {
          vaults.push(vault);
        }
        // Rate limit courtesy
        await new Promise(r => setTimeout(r, 500));
      } catch (err: any) {
        console.log(`   ⚠️  Failed to fetch vault ${stratAddr.slice(0, 8)}: ${err.message}`);
      }
    }

    // Sort by APY descending
    vaults.sort((a, b) => b.totalApy.minus(a.totalApy).toNumber());

    return vaults;
  }

  /**
   * List all available Kamino liquidity vaults matching optional filters.
   * Can filter by strategy type, status, and community flag.
   */
  async listAllVaults(filters?: StrategiesFilters): Promise<LiquidityVaultInfo[]> {
    console.log('🔍 Fetching all Kamino liquidity vaults...');

    const strategiesWithAddresses = await retry(() =>
      this.kamino.getAllStrategiesWithFilters(filters || { strategyCreationStatus: 'LIVE' })
    );

    console.log(`   Found ${strategiesWithAddresses.length} strategies`);

    const vaults: LiquidityVaultInfo[] = [];

    // Only process strategies involving our target tokens
    const targetMints = new Set([TOKEN_MINTS.JitoSOL, TOKEN_MINTS.SOL]);

    for (const strat of strategiesWithAddresses) {
      const tokenAMint = strat.strategy.tokenAMint.toString();
      const tokenBMint = strat.strategy.tokenBMint.toString();

      // Filter for strategies with at least one target token
      if (!targetMints.has(tokenAMint) && !targetMints.has(tokenBMint)) {
        continue;
      }

      // Only process JitoSOL-SOL pairs
      if (!(targetMints.has(tokenAMint) && targetMints.has(tokenBMint))) {
        continue;
      }

      try {
        const vault = await this.buildVaultInfoFromStrategy(strat);
        if (vault) vaults.push(vault);
      } catch (err: any) {
        // Skip problematic vaults
      }
    }

    vaults.sort((a, b) => b.totalApy.minus(a.totalApy).toNumber());
    return vaults;
  }

  // ─── Vault Details ─────────────────────────────────────────

  /**
   * Get detailed information about a specific vault.
   */
  async getVaultDetails(strategyAddress: string): Promise<LiquidityVaultInfo | null> {
    const stratAddr = address(strategyAddress);

    // Fetch strategy on-chain state
    const strategy = await retry(() => this.kamino.getStrategyByAddress(stratAddr));
    if (!strategy) {
      console.log(`   ⚠️  Strategy ${strategyAddress.slice(0, 8)} not found`);
      return null;
    }

    // Get share data (price + balances)
    const shareData = await retry(() => this.kamino.getStrategyShareData(stratAddr));

    // Get APY/APR
    let aprApy: WhirlpoolAprApy;
    try {
      aprApy = await retry(() => this.kamino.getStrategyAprApy(stratAddr));
    } catch {
      aprApy = {
        totalApr: new Decimal(0),
        totalApy: new Decimal(0),
        feeApr: new Decimal(0),
        feeApy: new Decimal(0),
        rewardsApr: [],
        rewardsApy: [],
        priceLower: new Decimal(0),
        priceUpper: new Decimal(0),
        poolPrice: new Decimal(0),
        strategyOutOfRange: false,
      };
    }

    // Get position range
    let range = { lowerPrice: new Decimal(0), upperPrice: new Decimal(0) };
    try {
      range = await retry(() => this.kamino.getStrategyRange(stratAddr));
    } catch {
      // Use APR/APY data for range if direct fetch fails
      range = { lowerPrice: aprApy.priceLower, upperPrice: aprApy.priceUpper };
    }

    const tokenAMint = strategy.tokenAMint.toString();
    const tokenBMint = strategy.tokenBMint.toString();

    // Determine DEX
    let dex = 'Unknown';
    try {
      const stratWithAddr = { address: stratAddr, strategy };
      // Infer DEX from strategy fields
      if (strategy.pool.toString() !== '11111111111111111111111111111111') {
        // Check if it's Orca, Raydium, or Meteora based on SDK detection
        dex = 'CLMM'; // Will be refined below
      }
    } catch {}

    // Determine vault type
    const tokenADecimals = Number(strategy.tokenAMintDecimals.toString());
    const tokenBDecimals = Number(strategy.tokenBMintDecimals.toString());

    return {
      address: strategyAddress,
      name: `${mintToSymbol(tokenAMint)}-${mintToSymbol(tokenBMint)} LP`,
      dex,
      tokenAMint,
      tokenBMint,
      tokenASymbol: mintToSymbol(tokenAMint),
      tokenBSymbol: mintToSymbol(tokenBMint),
      shareMint: strategy.sharesMint.toString(),
      totalApy: aprApy.totalApy.mul(100), // Convert to percentage
      feeApy: aprApy.feeApy.mul(100),
      rewardsApy: aprApy.rewardsApy.map(r => r.mul(100)),
      tvlUsd: shareData.balance.computedHoldings.totalSum,
      sharePrice: shareData.price,
      priceLower: range.lowerPrice,
      priceUpper: range.upperPrice,
      poolPrice: aprApy.poolPrice,
      outOfRange: aprApy.strategyOutOfRange,
      tokenAAmount: shareData.balance.tokenAAmounts,
      tokenBAmount: shareData.balance.tokenBAmounts,
      strategyType: 'NON_PEGGED',
      status: 'LIVE',
    };
  }

  // ─── User Positions ────────────────────────────────────────

  /**
   * Get all Kamino liquidity positions for a wallet.
   * Returns positions across all strategies the user has shares in.
   */
  async getUserPositions(walletPubkey: PublicKey): Promise<LiquidityPosition[]> {
    const walletAddr = address(walletPubkey.toBase58());
    const positions: LiquidityPosition[] = [];

    try {
      const kaminoPositions = await retry(() =>
        this.kamino.getUserPositions(walletAddr)
      );

      if (!kaminoPositions || kaminoPositions.length === 0) {
        return positions;
      }

      console.log(`   Found ${kaminoPositions.length} liquidity position(s)`);

      for (const kpos of kaminoPositions) {
        try {
          // Get share data and APY for each strategy
          const shareData = await retry(() =>
            this.kamino.getStrategyShareData(kpos.strategy)
          );

          let aprApy: WhirlpoolAprApy;
          try {
            aprApy = await retry(() =>
              this.kamino.getStrategyAprApy(kpos.strategy)
            );
          } catch {
            aprApy = {
              totalApr: new Decimal(0), totalApy: new Decimal(0),
              feeApr: new Decimal(0), feeApy: new Decimal(0),
              rewardsApr: [], rewardsApy: [],
              priceLower: new Decimal(0), priceUpper: new Decimal(0),
              poolPrice: new Decimal(0), strategyOutOfRange: false,
            };
          }

          // Calculate user's share of the vault
          const sharesAmount = kpos.sharesAmount;
          const sharePrice = shareData.price;
          const valueUsd = sharesAmount.mul(sharePrice);

          // Estimate token amounts based on share of total
          const strategy = await retry(() =>
            this.kamino.getStrategyByAddress(kpos.strategy)
          );

          let tokenAMint = '';
          let tokenBMint = '';
          let tokenAAmount = new Decimal(0);
          let tokenBAmount = new Decimal(0);

          if (strategy) {
            tokenAMint = strategy.tokenAMint.toString();
            tokenBMint = strategy.tokenBMint.toString();

            // Get token amounts per share
            try {
              const tokensPerShare = await retry(() =>
                this.kamino.getTokenAAndBPerShare(kpos.strategy)
              );
              tokenAAmount = tokensPerShare.a.mul(sharesAmount);
              tokenBAmount = tokensPerShare.b.mul(sharesAmount);
            } catch {
              // Estimate from total vault balances
              tokenAAmount = shareData.balance.tokenAAmounts.mul(sharesAmount).div(shareData.price.gt(0) ? shareData.price : new Decimal(1));
              tokenBAmount = shareData.balance.tokenBAmounts.mul(sharesAmount).div(shareData.price.gt(0) ? shareData.price : new Decimal(1));
            }
          }

          positions.push({
            strategyAddress: kpos.strategy.toString(),
            name: `${mintToSymbol(tokenAMint)}-${mintToSymbol(tokenBMint)} LP`,
            shareMint: kpos.shareMint.toString(),
            sharesAmount,
            valueUsd,
            tokenAAmount,
            tokenBAmount,
            currentApy: aprApy.totalApy.mul(100),
            dex: kpos.strategyDex || 'Unknown',
          });

          // Rate limit courtesy
          await new Promise(r => setTimeout(r, 300));
        } catch (err: any) {
          console.log(`   ⚠️  Error processing position ${kpos.strategy.toString().slice(0, 8)}: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.log(`   ⚠️  Could not fetch liquidity positions: ${err.message}`);
    }

    return positions;
  }

  // ─── Deposit ───────────────────────────────────────────────

  /**
   * Deposit tokens into a Kamino liquidity vault (dual-sided).
   *
   * @param wallet - Wallet keypair
   * @param strategyAddress - Strategy to deposit into
   * @param amountA - Amount of token A (in UI units, e.g. 1.5 SOL)
   * @param amountB - Amount of token B (in UI units, e.g. 1.5 JitoSOL)
   * @param dryRun - If true, simulate without executing
   */
  async deposit(
    wallet: Keypair,
    strategyAddress: string,
    amountA: Decimal,
    amountB: Decimal,
    dryRun: boolean = true
  ): Promise<{ success: boolean; message: string; signature?: string }> {
    const stratAddr = address(strategyAddress);

    // Get strategy details
    const strategy = await retry(() => this.kamino.getStrategyByAddress(stratAddr));
    if (!strategy) {
      return { success: false, message: `Strategy ${strategyAddress.slice(0, 8)} not found` };
    }

    const tokenASymbol = mintToSymbol(strategy.tokenAMint.toString());
    const tokenBSymbol = mintToSymbol(strategy.tokenBMint.toString());

    // Calculate proportional deposit amounts
    const [propAmountA, propAmountB] = await retry(() =>
      this.kamino.calculateAmountsToBeDeposited(stratAddr, amountA, amountB)
    );

    console.log(`   Deposit: ${propAmountA.toFixed(6)} ${tokenASymbol} + ${propAmountB.toFixed(6)} ${tokenBSymbol}`);

    if (dryRun) {
      // Get share price to estimate shares received
      const shareData = await retry(() => this.kamino.getStrategyShareData(stratAddr));
      const estimatedValue = propAmountA.plus(propAmountB); // rough USD estimate
      const estimatedShares = shareData.price.gt(0)
        ? estimatedValue.div(shareData.price)
        : new Decimal(0);

      return {
        success: true,
        message: `DRY RUN — Would deposit ${propAmountA.toFixed(6)} ${tokenASymbol} + ${propAmountB.toFixed(6)} ${tokenBSymbol} into ${tokenASymbol}-${tokenBSymbol} vault. Estimated shares: ${estimatedShares.toFixed(6)} (share price: $${shareData.price.toFixed(6)})`,
      };
    }

    try {
      // Create the signer from wallet keypair
      const signer = await createKeyPairSignerFromBytes(wallet.secretKey);

      // Build deposit instruction
      const depositIx = await retry(() =>
        this.kamino.deposit(stratAddr, propAmountA, propAmountB, signer)
      );

      // Build transaction
      const tx = new Transaction();
      tx.add(convertInstruction(depositIx));
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [wallet],
        { commitment: 'confirmed' }
      );

      return {
        success: true,
        message: `Deposited ${propAmountA.toFixed(6)} ${tokenASymbol} + ${propAmountB.toFixed(6)} ${tokenBSymbol} into ${tokenASymbol}-${tokenBSymbol} vault`,
        signature,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Deposit failed: ${err.message}`,
      };
    }
  }

  /**
   * Single-sided deposit of token A into a vault.
   * The SDK handles swapping the excess token internally via KSwap/Jupiter.
   *
   * @param wallet - Wallet keypair
   * @param strategyAddress - Strategy to deposit into
   * @param amount - Amount of token A (in UI units)
   * @param slippageBps - Slippage tolerance in basis points (default 50 = 0.5%)
   * @param dryRun - If true, simulate without executing
   */
  async singleSidedDepositA(
    wallet: Keypair,
    strategyAddress: string,
    amount: Decimal,
    slippageBps: number = 50,
    dryRun: boolean = true
  ): Promise<{ success: boolean; message: string; signature?: string }> {
    const stratAddr = address(strategyAddress);

    const strategy = await retry(() => this.kamino.getStrategyByAddress(stratAddr));
    if (!strategy) {
      return { success: false, message: `Strategy ${strategyAddress.slice(0, 8)} not found` };
    }

    const tokenASymbol = mintToSymbol(strategy.tokenAMint.toString());
    const tokenBSymbol = mintToSymbol(strategy.tokenBMint.toString());

    if (dryRun) {
      const shareData = await retry(() => this.kamino.getStrategyShareData(stratAddr));
      return {
        success: true,
        message: `DRY RUN — Would single-sided deposit ${amount.toFixed(6)} ${tokenASymbol} into ${tokenASymbol}-${tokenBSymbol} vault (slippage: ${slippageBps}bps, share price: $${shareData.price.toFixed(6)})`,
      };
    }

    try {
      const signer = await createKeyPairSignerFromBytes(wallet.secretKey);

      const result = await retry(() =>
        this.kamino.singleSidedDepositTokenA(
          stratAddr,
          amount,
          signer,
          new Decimal(slippageBps),
          undefined, // profiler
          undefined, // swapIxsBuilder (uses default KSwap)
          undefined, // initialUserTokenAtaBalances
          undefined, // priceAInB
          true, // includeAtaIxns
        )
      );

      // Build and send transaction
      const tx = new Transaction();
      for (const ix of result.instructions) {
        tx.add(convertInstruction(ix));
      }
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [wallet],
        { commitment: 'confirmed' }
      );

      return {
        success: true,
        message: `Single-sided deposited ${amount.toFixed(6)} ${tokenASymbol} into ${tokenASymbol}-${tokenBSymbol} vault`,
        signature,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Single-sided deposit failed: ${err.message}`,
      };
    }
  }

  /**
   * Single-sided deposit of token B into a vault.
   */
  async singleSidedDepositB(
    wallet: Keypair,
    strategyAddress: string,
    amount: Decimal,
    slippageBps: number = 50,
    dryRun: boolean = true
  ): Promise<{ success: boolean; message: string; signature?: string }> {
    const stratAddr = address(strategyAddress);

    const strategy = await retry(() => this.kamino.getStrategyByAddress(stratAddr));
    if (!strategy) {
      return { success: false, message: `Strategy ${strategyAddress.slice(0, 8)} not found` };
    }

    const tokenASymbol = mintToSymbol(strategy.tokenAMint.toString());
    const tokenBSymbol = mintToSymbol(strategy.tokenBMint.toString());

    if (dryRun) {
      const shareData = await retry(() => this.kamino.getStrategyShareData(stratAddr));
      return {
        success: true,
        message: `DRY RUN — Would single-sided deposit ${amount.toFixed(6)} ${tokenBSymbol} into ${tokenASymbol}-${tokenBSymbol} vault (slippage: ${slippageBps}bps, share price: $${shareData.price.toFixed(6)})`,
      };
    }

    try {
      const signer = await createKeyPairSignerFromBytes(wallet.secretKey);

      const result = await retry(() =>
        this.kamino.singleSidedDepositTokenB(
          stratAddr,
          amount,
          signer,
          new Decimal(slippageBps),
          undefined, undefined, undefined, undefined, true,
        )
      );

      const tx = new Transaction();
      for (const ix of result.instructions) {
        tx.add(convertInstruction(ix));
      }
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [wallet],
        { commitment: 'confirmed' }
      );

      return {
        success: true,
        message: `Single-sided deposited ${amount.toFixed(6)} ${tokenBSymbol} into ${tokenASymbol}-${tokenBSymbol} vault`,
        signature,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Single-sided deposit failed: ${err.message}`,
      };
    }
  }

  // ─── Withdraw ──────────────────────────────────────────────

  /**
   * Withdraw shares from a Kamino liquidity vault.
   *
   * @param wallet - Wallet keypair
   * @param strategyAddress - Strategy to withdraw from
   * @param sharesAmount - Number of shares (kTokens) to withdraw
   * @param dryRun - If true, simulate without executing
   */
  async withdraw(
    wallet: Keypair,
    strategyAddress: string,
    sharesAmount: Decimal,
    dryRun: boolean = true
  ): Promise<{ success: boolean; message: string; signature?: string }> {
    const stratAddr = address(strategyAddress);

    const strategy = await retry(() => this.kamino.getStrategyByAddress(stratAddr));
    if (!strategy) {
      return { success: false, message: `Strategy ${strategyAddress.slice(0, 8)} not found` };
    }

    const tokenASymbol = mintToSymbol(strategy.tokenAMint.toString());
    const tokenBSymbol = mintToSymbol(strategy.tokenBMint.toString());

    // Get current value of shares
    const shareData = await retry(() => this.kamino.getStrategyShareData(stratAddr));
    const withdrawValue = sharesAmount.mul(shareData.price);

    // Estimate token amounts returned
    let tokenAEstimate = new Decimal(0);
    let tokenBEstimate = new Decimal(0);
    try {
      const tokensPerShare = await retry(() => this.kamino.getTokenAAndBPerShare(stratAddr));
      tokenAEstimate = tokensPerShare.a.mul(sharesAmount);
      tokenBEstimate = tokensPerShare.b.mul(sharesAmount);
    } catch {}

    if (dryRun) {
      return {
        success: true,
        message: `DRY RUN — Would withdraw ${sharesAmount.toFixed(6)} shares (~$${withdrawValue.toFixed(2)}) from ${tokenASymbol}-${tokenBSymbol} vault. Estimated return: ~${tokenAEstimate.toFixed(6)} ${tokenASymbol} + ~${tokenBEstimate.toFixed(6)} ${tokenBSymbol}`,
      };
    }

    try {
      const signer = await createKeyPairSignerFromBytes(wallet.secretKey);

      const withdrawResult = await retry(() =>
        this.kamino.withdrawShares(stratAddr, sharesAmount, signer)
      );

      const tx = new Transaction();
      for (const ix of withdrawResult.prerequisiteIxs) {
        tx.add(convertInstruction(ix));
      }
      tx.add(convertInstruction(withdrawResult.withdrawIx));
      if (withdrawResult.closeSharesAtaIx) {
        tx.add(convertInstruction(withdrawResult.closeSharesAtaIx));
      }
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [wallet],
        { commitment: 'confirmed' }
      );

      return {
        success: true,
        message: `Withdrew ${sharesAmount.toFixed(6)} shares from ${tokenASymbol}-${tokenBSymbol} vault`,
        signature,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Withdraw failed: ${err.message}`,
      };
    }
  }

  /**
   * Withdraw ALL shares from a strategy.
   */
  async withdrawAll(
    wallet: Keypair,
    strategyAddress: string,
    dryRun: boolean = true
  ): Promise<{ success: boolean; message: string; signature?: string }> {
    const stratAddr = address(strategyAddress);

    const strategy = await retry(() => this.kamino.getStrategyByAddress(stratAddr));
    if (!strategy) {
      return { success: false, message: `Strategy ${strategyAddress.slice(0, 8)} not found` };
    }

    const tokenASymbol = mintToSymbol(strategy.tokenAMint.toString());
    const tokenBSymbol = mintToSymbol(strategy.tokenBMint.toString());

    if (dryRun) {
      return {
        success: true,
        message: `DRY RUN — Would withdraw ALL shares from ${tokenASymbol}-${tokenBSymbol} vault`,
      };
    }

    try {
      const signer = await createKeyPairSignerFromBytes(wallet.secretKey);

      const withdrawResult = await retry(() =>
        this.kamino.withdrawAllShares(stratAddr, signer)
      );

      if (!withdrawResult) {
        return { success: false, message: 'No shares to withdraw' };
      }

      const tx = new Transaction();
      for (const ix of withdrawResult.prerequisiteIxs) {
        tx.add(convertInstruction(ix));
      }
      tx.add(convertInstruction(withdrawResult.withdrawIx));
      if (withdrawResult.closeSharesAtaIx) {
        tx.add(convertInstruction(withdrawResult.closeSharesAtaIx));
      }
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [wallet],
        { commitment: 'confirmed' }
      );

      return {
        success: true,
        message: `Withdrew all shares from ${tokenASymbol}-${tokenBSymbol} vault`,
        signature,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Withdraw all failed: ${err.message}`,
      };
    }
  }

  // ─── Helper: build vault info from strategy ────────────────

  private async buildVaultInfoFromStrategy(strat: any): Promise<LiquidityVaultInfo | null> {
    const stratAddr = strat.address;
    const strategy = strat.strategy;

    try {
      const shareData = await retry(() => this.kamino.getStrategyShareData(stratAddr));

      let aprApy: WhirlpoolAprApy;
      try {
        aprApy = await retry(() => this.kamino.getStrategyAprApy(stratAddr));
      } catch {
        aprApy = {
          totalApr: new Decimal(0), totalApy: new Decimal(0),
          feeApr: new Decimal(0), feeApy: new Decimal(0),
          rewardsApr: [], rewardsApy: [],
          priceLower: new Decimal(0), priceUpper: new Decimal(0),
          poolPrice: new Decimal(0), strategyOutOfRange: false,
        };
      }

      let range = { lowerPrice: aprApy.priceLower, upperPrice: aprApy.priceUpper };
      try {
        range = await retry(() => this.kamino.getStrategyRange(stratAddr));
      } catch {}

      const tokenAMint = strategy.tokenAMint.toString();
      const tokenBMint = strategy.tokenBMint.toString();

      return {
        address: stratAddr.toString(),
        name: `${mintToSymbol(tokenAMint)}-${mintToSymbol(tokenBMint)} LP`,
        dex: 'CLMM',
        tokenAMint,
        tokenBMint,
        tokenASymbol: mintToSymbol(tokenAMint),
        tokenBSymbol: mintToSymbol(tokenBMint),
        shareMint: strategy.sharesMint.toString(),
        totalApy: aprApy.totalApy.mul(100),
        feeApy: aprApy.feeApy.mul(100),
        rewardsApy: aprApy.rewardsApy.map((r: Decimal) => r.mul(100)),
        tvlUsd: shareData.balance.computedHoldings.totalSum,
        sharePrice: shareData.price,
        priceLower: range.lowerPrice,
        priceUpper: range.upperPrice,
        poolPrice: aprApy.poolPrice,
        outOfRange: aprApy.strategyOutOfRange,
        tokenAAmount: shareData.balance.tokenAAmounts,
        tokenBAmount: shareData.balance.tokenBAmounts,
        strategyType: 'NON_PEGGED',
        status: 'LIVE',
      };
    } catch {
      return null;
    }
  }

  /**
   * Print a summary of available vaults.
   */
  printVaultSummary(vaults: LiquidityVaultInfo[]): void {
    console.log('\n┌────────────────────────────────────────────────────────────────┐');
    console.log('│              🏊 KAMINO LIQUIDITY VAULTS                        │');
    console.log('├────────────────────────────────────────────────────────────────┤');

    if (vaults.length === 0) {
      console.log('│  No vaults found.                                              │');
    } else {
      for (const v of vaults) {
        const range = v.outOfRange ? '⚠️ OUT OF RANGE' : `${v.priceLower.toFixed(4)} - ${v.priceUpper.toFixed(4)}`;
        console.log(`│  ${v.name.padEnd(20)} ${v.totalApy.toFixed(2).padStart(7)}% APY  TVL: $${v.tvlUsd.toFixed(0).padStart(10)} │`);
        console.log(`│    Address: ${v.address.slice(0, 16)}...  Range: ${range.padEnd(25)} │`);
        console.log(`│    Fee APY: ${v.feeApy.toFixed(2)}%  Share: $${v.sharePrice.toFixed(6)}  ${v.dex.padEnd(8)}      │`);
      }
    }

    console.log('└────────────────────────────────────────────────────────────────┘');
  }

  /**
   * Print a summary of user's LP positions.
   */
  printPositionSummary(positions: LiquidityPosition[]): void {
    console.log('\n┌────────────────────────────────────────────────────────────────┐');
    console.log('│              💧 LP POSITIONS                                   │');
    console.log('├────────────────────────────────────────────────────────────────┤');

    if (positions.length === 0) {
      console.log('│  No active LP positions.                                       │');
    } else {
      let totalValue = new Decimal(0);
      for (const p of positions) {
        totalValue = totalValue.plus(p.valueUsd);
        console.log(`│  ${p.name.padEnd(20)} ${p.currentApy.toFixed(2).padStart(7)}% APY  $${p.valueUsd.toFixed(2).padStart(10)} │`);
        console.log(`│    Shares: ${p.sharesAmount.toFixed(6)}  ${p.dex.padEnd(8)}                          │`);
        console.log(`│    Tokens: ${p.tokenAAmount.toFixed(4)} A + ${p.tokenBAmount.toFixed(4)} B                    │`);
      }
      console.log('├────────────────────────────────────────────────────────────────┤');
      console.log(`│  Total LP Value: $${totalValue.toFixed(2).padStart(10)}                                │`);
    }

    console.log('└────────────────────────────────────────────────────────────────┘');
  }
}

// ─── Instruction Converter ─────────────────────────────────────
// Convert @solana/kit instruction to web3.js TransactionInstruction

function convertInstruction(ix: any): any {
  // If it's already a web3.js instruction, return as-is
  if (ix.programId instanceof PublicKey) {
    return ix;
  }

  // Convert from @solana/kit format
  return {
    programId: new PublicKey(ix.programAddress?.toString() || ix.programId?.toString()),
    keys: (ix.accounts || []).map((acc: any) => ({
      pubkey: new PublicKey(acc.address?.toString() || acc.pubkey?.toString()),
      isSigner: acc.role === 3 || acc.role === 2 || acc.signer === true,
      isWritable: acc.role === 1 || acc.role === 3 || acc.writable === true,
    })),
    data: Buffer.from(ix.data || []),
  };
}

// ─── CLI Runner ────────────────────────────────────────────────

async function main() {
  const fs = await import('fs');
  const path = await import('path');

  const settingsPath = path.join(__dirname, '../config/settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

  const walletPath = path.join(__dirname, '../config/wallet.json');
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🏊 KAMINO LIQUIDITY VAULT SCANNER');
  console.log(`     ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`💳 Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`🧪 Dry run: ${settings.dryRun ? 'YES' : 'NO'}\n`);

  const client = new LiquidityClient(settings.rpcUrl);

  // 1. List JitoSOL-SOL vaults
  const vaults = await client.listJitoSolVaults();
  client.printVaultSummary(vaults);

  // 2. Check user positions
  console.log('\n📊 Checking LP positions...');
  const positions = await client.getUserPositions(wallet.publicKey);
  client.printPositionSummary(positions);

  // 3. Find best vault
  if (vaults.length > 0) {
    const best = vaults[0];
    console.log(`\n🏆 Best vault: ${best.name} @ ${best.totalApy.toFixed(2)}% APY (TVL: $${best.tvlUsd.toFixed(0)})`);

    // 4. Dry-run deposit test
    if (settings.dryRun) {
      console.log('\n🧪 Testing dry-run deposit...');
      const depositResult = await client.singleSidedDepositB(
        wallet,
        best.address,
        new Decimal(0.1), // 0.1 JitoSOL test
        50, // 0.5% slippage
        true
      );
      console.log(`   ${depositResult.success ? '✅' : '❌'} ${depositResult.message}`);

      console.log('\n🧪 Testing dry-run withdraw...');
      const withdrawResult = await client.withdraw(
        wallet,
        best.address,
        new Decimal(0.01), // 0.01 shares
        true
      );
      console.log(`   ${withdrawResult.success ? '✅' : '❌'} ${withdrawResult.message}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('     ✅ LIQUIDITY VAULT SCAN COMPLETE');
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Run if called directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error:', err.message || err);
      process.exit(1);
    });
}
