/**
 * Yield Tracker
 *
 * Tracks actual returns over time to measure if the strategy is working.
 * Captures portfolio snapshots and calculates performance metrics.
 *
 * CONSERVATIVE WITH RPC: Uses LiquidityClient.getVaultDetails() for vault data
 * and batches calls. SOL price from CoinGecko (no RPC).
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { LiquidityClient, LiquidityVaultInfo, LiquidityPosition, JITOSOL_SOL_STRATEGIES } from './liquidity-client';
import { Settings, TOKEN_MINTS } from './types';

// ─── Types ──────────────────────────────────────────────────────

export interface YieldHistoryEntry {
  timestamp: string;
  portfolioTotalValueSol: string;
  portfolioTotalValueUsd: string;
  positions: PositionEntry[];
  idleJitoSol: string;
  walletSolBalance: string;
  cumulativeYieldSol: string;
  cumulativeYieldUsd: string;
  impermanentLoss?: {
    lpValueSol: string;
    holdValueSol: string;
    lossPercent: string;
  };
  solPriceUsd: string;
  jitosolToSolRatio: string;
}

export interface PositionEntry {
  strategy: string;
  address: string;
  valueSol: string;
  valueUsd: string;
  apy: string;
  tokenAAmount: string;
  tokenBAmount: string;
  tokenASymbol: string;
  tokenBSymbol: string;
  inRange: boolean;
}

export interface PerformanceMetrics {
  deployedDaysAgo: number;
  totalEarnedSol: Decimal;
  totalEarnedUsd: Decimal;
  actualApy: Decimal;
  vsHoldingPercent: Decimal;
  impermanentLossPercent: Decimal | null;
  snapshotCount: number;
}

// ─── History file path ──────────────────────────────────────────

const HISTORY_FILE = path.join(__dirname, '..', 'config', 'yield-history.jsonl');

// ─── Helpers ────────────────────────────────────────────────────

async function getSolPrice(): Promise<Decimal> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json() as any;
    return new Decimal(data.solana?.usd ?? 170);
  } catch {
    return new Decimal(170);
  }
}

function loadHistory(): YieldHistoryEntry[] {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const content = fs.readFileSync(HISTORY_FILE, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean) as YieldHistoryEntry[];
}

// ─── Main class ─────────────────────────────────────────────────

export class YieldTracker {
  private liquidityClient: LiquidityClient;
  private connection: Connection;
  private wallet: Keypair;

  constructor(rpcUrl: string, connection: Connection, wallet: Keypair) {
    this.liquidityClient = new LiquidityClient(rpcUrl);
    this.connection = connection;
    this.wallet = wallet;
  }

  /**
   * Record current portfolio state to yield-history.jsonl
   * Makes ~3 RPC calls total (balance check + LP position fetch + vault details)
   */
  async captureSnapshot(): Promise<YieldHistoryEntry> {
    console.log('📊 Capturing portfolio snapshot...');

    const solPrice = await getSolPrice();

    // 1. Get wallet SOL balance (1 RPC call)
    const solLamports = await this.connection.getBalance(this.wallet.publicKey);
    const walletSolBalance = new Decimal(solLamports).div(LAMPORTS_PER_SOL);

    // 2. Get JitoSOL balance (1 RPC call)
    let idleJitoSol = new Decimal(0);
    try {
      const jitosolMint = new PublicKey(TOKEN_MINTS.JitoSOL);
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: jitosolMint }
      );
      for (const { account } of tokenAccounts.value) {
        const data = account.data;
        // SPL token amount is at offset 64, 8 bytes LE
        const amount = data.readBigUInt64LE(64);
        idleJitoSol = idleJitoSol.plus(new Decimal(amount.toString()).div(1e9));
      }
    } catch (err) {
      console.log(`   ⚠️ Failed to get JitoSOL balance: ${(err as Error).message}`);
    }

    // 3. Get LP positions (batched RPC via Kamino SDK)
    const positions: PositionEntry[] = [];
    let totalValueSol = walletSolBalance.plus(idleJitoSol); // SOL + idle JitoSOL (~= SOL)
    let jitosolToSolRatio = new Decimal(1);

    try {
      const lpPositions = await this.liquidityClient.getUserPositions(this.wallet.publicKey);

      for (const lp of lpPositions) {
        // Token amounts represent SOL-equivalent value for JitoSOL-SOL pairs
        const posValueSol = lp.tokenAAmount.plus(lp.tokenBAmount);
        const posValueUsd = posValueSol.mul(solPrice);
        totalValueSol = totalValueSol.plus(posValueSol);

        // Check if strategy is in range
        let inRange = true;
        try {
          const vaultDetails = await this.liquidityClient.getVaultDetails(lp.strategyAddress);
          if (vaultDetails) {
            inRange = !vaultDetails.outOfRange;
            // Get JitoSOL/SOL ratio from pool price
            if (vaultDetails.poolPrice.gt(0)) {
              jitosolToSolRatio = vaultDetails.poolPrice;
            }
          }
        } catch { /* use defaults */ }

        positions.push({
          strategy: 'LP Vault',
          address: lp.strategyAddress,
          valueSol: posValueSol.toFixed(6),
          valueUsd: posValueUsd.toFixed(2),
          apy: lp.currentApy.toFixed(2),
          tokenAAmount: lp.tokenAAmount.toFixed(6),
          tokenBAmount: lp.tokenBAmount.toFixed(6),
          tokenASymbol: 'SOL',
          tokenBSymbol: 'JitoSOL',
          inRange,
        });
      }
    } catch (err) {
      console.log(`   ⚠️ Failed to get LP positions: ${(err as Error).message}`);
    }

    const totalValueUsd = totalValueSol.mul(solPrice);

    // 4. Calculate cumulative yield from first snapshot
    const history = loadHistory();
    let cumulativeYieldSol = new Decimal(0);
    let cumulativeYieldUsd = new Decimal(0);
    if (history.length > 0) {
      const firstValue = new Decimal(history[0].portfolioTotalValueSol);
      cumulativeYieldSol = totalValueSol.minus(firstValue);
      cumulativeYieldUsd = cumulativeYieldSol.mul(solPrice);
    }

    // 5. Estimate impermanent loss for LP positions
    let impermanentLoss: YieldHistoryEntry['impermanentLoss'] | undefined;
    if (positions.length > 0 && history.length > 0) {
      impermanentLoss = this.estimateImpermanentLossFromHistory(
        positions, history[0], totalValueSol, jitosolToSolRatio
      );
    }

    const entry: YieldHistoryEntry = {
      timestamp: new Date().toISOString(),
      portfolioTotalValueSol: totalValueSol.toFixed(6),
      portfolioTotalValueUsd: totalValueUsd.toFixed(2),
      positions,
      idleJitoSol: idleJitoSol.toFixed(6),
      walletSolBalance: walletSolBalance.toFixed(6),
      cumulativeYieldSol: cumulativeYieldSol.toFixed(6),
      cumulativeYieldUsd: cumulativeYieldUsd.toFixed(2),
      impermanentLoss,
      solPriceUsd: solPrice.toFixed(2),
      jitosolToSolRatio: jitosolToSolRatio.toFixed(6),
    };

    // Append to JSONL
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
    console.log(`💾 Snapshot: ${totalValueSol.toFixed(4)} SOL ($${totalValueUsd.toFixed(2)}) | Yield: ${cumulativeYieldSol.toFixed(4)} SOL`);

    return entry;
  }

  /**
   * Calculate actual returns over a period
   */
  calculateReturns(since: Date): PerformanceMetrics {
    const history = loadHistory();
    if (history.length === 0) {
      throw new Error('No yield history found. Run captureSnapshot() first.');
    }

    const sinceMs = since.getTime();
    const startEntry = history.find(e => new Date(e.timestamp).getTime() >= sinceMs) || history[0];
    const endEntry = history[history.length - 1];

    const startValue = new Decimal(startEntry.portfolioTotalValueSol);
    const endValue = new Decimal(endEntry.portfolioTotalValueSol);
    const startValueUsd = new Decimal(startEntry.portfolioTotalValueUsd);
    const endValueUsd = new Decimal(endEntry.portfolioTotalValueUsd);

    const earnedSol = endValue.minus(startValue);
    const earnedUsd = endValueUsd.minus(startValueUsd);

    const startTime = new Date(startEntry.timestamp).getTime();
    const endTime = new Date(endEntry.timestamp).getTime();
    const daysDiff = Math.max((endTime - startTime) / (1000 * 60 * 60 * 24), 0.01);

    // Annualized return (APY)
    const returnPct = startValue.gt(0) ? earnedSol.div(startValue) : new Decimal(0);
    const annualized = returnPct.div(daysDiff).mul(365).mul(100);

    // vs just holding: compare SOL value growth vs SOL price growth
    const startSolPrice = new Decimal(startEntry.solPriceUsd);
    const endSolPrice = new Decimal(endEntry.solPriceUsd);
    const solPriceGrowth = startSolPrice.gt(0)
      ? endSolPrice.minus(startSolPrice).div(startSolPrice).mul(100)
      : new Decimal(0);
    const vsHolding = annualized.minus(solPriceGrowth);

    // IL from latest entry
    let ilPercent: Decimal | null = null;
    if (endEntry.impermanentLoss) {
      ilPercent = new Decimal(endEntry.impermanentLoss.lossPercent);
    }

    return {
      deployedDaysAgo: daysDiff,
      totalEarnedSol: earnedSol,
      totalEarnedUsd: earnedUsd,
      actualApy: annualized,
      vsHoldingPercent: vsHolding,
      impermanentLossPercent: ilPercent,
      snapshotCount: history.length,
    };
  }

  /**
   * Get human-readable performance summary
   */
  getPerformanceSummary(): string {
    const history = loadHistory();
    if (history.length === 0) {
      return '📊 No yield tracking data yet. First snapshot pending.';
    }

    try {
      const metrics = this.calculateReturns(new Date(history[0].timestamp));
      const latest = history[history.length - 1];

      const lines = [
        `📊 **Portfolio Performance**`,
        `⏱️ Tracking: ${metrics.deployedDaysAgo.toFixed(1)} days (${metrics.snapshotCount} snapshots)`,
        `💰 Total Value: ${new Decimal(latest.portfolioTotalValueSol).toFixed(4)} SOL ($${new Decimal(latest.portfolioTotalValueUsd).toFixed(2)})`,
        `📈 Earned: ${metrics.totalEarnedSol.toFixed(4)} SOL ($${metrics.totalEarnedUsd.toFixed(2)})`,
        `🎯 Actual APY: ${metrics.actualApy.toFixed(2)}%`,
        `🆚 vs Holding: ${metrics.vsHoldingPercent.gt(0) ? '+' : ''}${metrics.vsHoldingPercent.toFixed(2)}%`,
      ];

      if (metrics.impermanentLossPercent !== null) {
        lines.push(`⚠️ IL estimate: ${metrics.impermanentLossPercent.toFixed(4)}%`);
      }

      return lines.join('\n');
    } catch (err) {
      return `❌ ${(err as Error).message}`;
    }
  }

  /**
   * Estimate IL by comparing LP value vs "just holding" from first snapshot
   */
  private estimateImpermanentLossFromHistory(
    currentPositions: PositionEntry[],
    firstEntry: YieldHistoryEntry,
    currentTotalSol: Decimal,
    jitosolToSolRatio: Decimal,
  ): YieldHistoryEntry['impermanentLoss'] | undefined {
    // Current LP value in SOL
    let lpValueSol = new Decimal(0);
    for (const pos of currentPositions) {
      lpValueSol = lpValueSol.plus(new Decimal(pos.valueSol));
    }

    if (lpValueSol.isZero()) return undefined;

    // If we had just held the initial portfolio (no LP), what would it be worth?
    // Initial total value (first snapshot) appreciated by JitoSOL staking ratio change
    const initialTotalSol = new Decimal(firstEntry.portfolioTotalValueSol);
    const initialRatio = new Decimal(firstEntry.jitosolToSolRatio || '1');
    const ratioChange = jitosolToSolRatio.gt(0) && initialRatio.gt(0)
      ? jitosolToSolRatio.div(initialRatio)
      : new Decimal(1);

    // Hold value = initial value * ratio appreciation (JitoSOL earns staking yield)
    const holdValueSol = initialTotalSol.mul(ratioChange);
    const lossPercent = holdValueSol.gt(0)
      ? lpValueSol.minus(holdValueSol).div(holdValueSol).mul(100)
      : new Decimal(0);

    return {
      lpValueSol: lpValueSol.toFixed(6),
      holdValueSol: holdValueSol.toFixed(6),
      lossPercent: lossPercent.toFixed(4),
    };
  }
}

/**
 * Load yield history (for dashboard use)
 */
export function getYieldHistory(): YieldHistoryEntry[] {
  return loadHistory();
}

/**
 * Factory function
 */
export function createYieldTracker(
  connection: Connection,
  wallet: Keypair,
  settings: Settings
): YieldTracker {
  return new YieldTracker(settings.rpcUrl, connection, wallet);
}

// ─── CLI Runner ─────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const settingsPath = path.join(__dirname, '../config/settings.json');
    const settings: Settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const walletPath = path.join(__dirname, '../config/wallet.json');
    const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });

    const tracker = new YieldTracker(settings.rpcUrl, connection, wallet);
    await tracker.captureSnapshot();
    console.log('\n' + tracker.getPerformanceSummary());
  })().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err.message || err);
    process.exit(1);
  });
}
