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
import { Settings, TOKEN_MINTS, TOKEN_DECIMALS } from './types';

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

interface TokenPrices {
  sol: Decimal;
  jitoSol: Decimal;
  kmno: Decimal;
  /** All prices keyed by symbol (SOL, JitoSOL, mSOL, dSOL, pSOL, ORCA, PYTH, JUP, RAY, WIF, BONK, USDC, etc.) */
  bySymbol: Record<string, Decimal>;
}

/** CoinGecko id → token symbol mapping for price lookups */
const COINGECKO_IDS: Record<string, string> = {
  'solana': 'SOL',
  'jito-staked-sol': 'JitoSOL',
  'marinade-staked-sol': 'mSOL',
  'drift-staked-sol': 'dSOL',
  'kamino': 'KMNO',
  'orca': 'ORCA',
  'pyth-network': 'PYTH',
  'jupiter-exchange-solana': 'JUP',
  'raydium': 'RAY',
  'dogwifcoin': 'WIF',
  'bonk': 'BONK',
};

/** Tokens NOT on CoinGecko — priced relative to SOL */
const SOL_PEGGED_TOKENS: Record<string, number> = {
  'pSOL': 1.04, // Sanctum pSOL — staked SOL, ~4% premium
};

async function getTokenPrices(): Promise<TokenPrices> {
  const ids = Object.keys(COINGECKO_IDS).join(',');
  const bySymbol: Record<string, Decimal> = {};
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const data = await res.json() as any;
    for (const [geckoId, symbol] of Object.entries(COINGECKO_IDS)) {
      if (data[geckoId]?.usd) {
        bySymbol[symbol] = new Decimal(data[geckoId].usd);
      }
    }
  } catch {
    // Fallback prices
    bySymbol['SOL'] = new Decimal(80);
    bySymbol['JitoSOL'] = new Decimal(90);
  }

  // Ensure core prices exist with sensible fallbacks
  if (!bySymbol['SOL']) bySymbol['SOL'] = new Decimal(80);
  if (!bySymbol['JitoSOL']) bySymbol['JitoSOL'] = bySymbol['SOL'].mul(1.08);
  if (!bySymbol['mSOL']) bySymbol['mSOL'] = bySymbol['SOL'].mul(1.09);
  if (!bySymbol['dSOL']) bySymbol['dSOL'] = bySymbol['SOL'].mul(1.12);
  if (!bySymbol['pSOL']) bySymbol['pSOL'] = bySymbol['SOL'];
  if (!bySymbol['KMNO']) bySymbol['KMNO'] = new Decimal(0.04);
  if (!bySymbol['USDC']) bySymbol['USDC'] = new Decimal(1);
  if (!bySymbol['USDT']) bySymbol['USDT'] = new Decimal(1);

  // LSTs not on CoinGecko — estimate from SOL price with staking premiums
  const lstPremiums: Record<string, number> = {
    'bSOL': 1.06, 'vSOL': 1.05, 'hSOL': 1.05, 'JSOL': 1.06,
    'JupSOL': 1.08, 'bbSOL': 1.06, 'hubSOL': 1.05, 'bonkSOL': 1.05,
    'cgntSOL': 1.05, 'laineSOL': 1.05, 'stakeSOL': 1.05, 'bnSOL': 1.06,
    'cdcSOL': 1.05, 'strongSOL': 1.05,
  };
  for (const [sym, mult] of Object.entries(lstPremiums)) {
    if (!bySymbol[sym]) bySymbol[sym] = bySymbol['SOL'].mul(mult);
  }

  // SOL-pegged tokens not on CoinGecko
  for (const [sym, mult] of Object.entries(SOL_PEGGED_TOKENS)) {
    if (!bySymbol[sym]) bySymbol[sym] = bySymbol['SOL'].mul(mult);
  }

  return {
    sol: bySymbol['SOL'],
    jitoSol: bySymbol['JitoSOL'],
    kmno: bySymbol['KMNO'],
    bySymbol,
  };
}

/** Build reverse lookup: mint address → symbol */
function buildMintToSymbol(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [symbol, mint] of Object.entries(TOKEN_MINTS)) {
    map[mint] = symbol;
  }
  return map;
}

const MINT_TO_SYMBOL = buildMintToSymbol();

/** Scan all SPL token accounts and return balances keyed by symbol */
async function getAllTokenBalances(
  connection: Connection,
  walletPubkey: PublicKey,
): Promise<Record<string, Decimal>> {
  const balances: Record<string, Decimal> = {};
  const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  try {
    const tokenAccounts = await connection.getTokenAccountsByOwner(walletPubkey, { programId: TOKEN_PROGRAM });
    for (const { account } of tokenAccounts.value) {
      const data = account.data;
      const mint = new PublicKey(data.slice(0, 32)).toBase58();
      const rawAmount = data.readBigUInt64LE(64);
      if (rawAmount === 0n) continue;

      const symbol = MINT_TO_SYMBOL[mint];
      if (!symbol) continue; // skip unknown tokens

      const decimals = TOKEN_DECIMALS[symbol] ?? 9;
      const amount = new Decimal(rawAmount.toString()).div(new Decimal(10).pow(decimals));
      balances[symbol] = (balances[symbol] || new Decimal(0)).plus(amount);
    }
  } catch (err) {
    console.log(`   ⚠️ Failed to scan token accounts: ${(err as Error).message}`);
  }

  return balances;
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

    const prices = await getTokenPrices();
    const solPrice = prices.sol;
    const jitoSolPrice = prices.jitoSol;

    // 1. Get wallet SOL balance (1 RPC call)
    const solLamports = await this.connection.getBalance(this.wallet.publicKey);
    const walletSolBalance = new Decimal(solLamports).div(LAMPORTS_PER_SOL);

    // 2. Get ALL token balances (1 RPC call — getTokenAccountsByOwner with program filter)
    const allTokenBalances = await getAllTokenBalances(this.connection, this.wallet.publicKey);
    const idleJitoSol = allTokenBalances['JitoSOL'] || new Decimal(0);

    // 2b. Price all wallet tokens
    let walletTokenValueUsd = new Decimal(0);
    const tokenBreakdown: string[] = [];
    for (const [symbol, amount] of Object.entries(allTokenBalances)) {
      const price = prices.bySymbol[symbol];
      if (price && amount.gt(0)) {
        const val = amount.mul(price);
        walletTokenValueUsd = walletTokenValueUsd.plus(val);
        if (val.gte(0.01)) {
          tokenBreakdown.push(`${symbol}: ${amount.toFixed(symbol === 'BONK' ? 0 : 6)} ($${val.toFixed(2)})`);
        }
      }
    }
    if (tokenBreakdown.length > 0) {
      console.log(`   Wallet tokens: ${tokenBreakdown.join(', ')}`);
    }

    // 3. Get LP positions (batched RPC via Kamino SDK)
    const positions: PositionEntry[] = [];
    // Total = SOL balance + all token balances
    let totalValueUsd = walletSolBalance.mul(solPrice).plus(walletTokenValueUsd);
    let totalValueSol = totalValueUsd.div(solPrice);
    let jitosolToSolRatio = jitoSolPrice.div(solPrice);

    try {
      const lpPositions = await this.liquidityClient.getUserPositions(this.wallet.publicKey);

      for (const lp of lpPositions) {
        // Token amounts properly normalized by liquidity client (fetches mint decimals)
        // Price each token correctly
        const posValueUsd = lp.tokenAAmount.mul(solPrice).plus(lp.tokenBAmount.mul(jitoSolPrice));
        const posValueSol = posValueUsd.div(solPrice);
        totalValueUsd = totalValueUsd.plus(posValueUsd);
        totalValueSol = totalValueUsd.div(solPrice);

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

    // 3b. KMNO staking (farm user state) — not captured by token scan
    const kmnoPrice = prices.kmno || new Decimal(0.04);
    try {
      const FARMS_PROGRAM = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
      const FARM_STATE = new PublicKey('2sFZDpBn4sA42uNbAD6QzQ98rPSmqnPyksYe6SJKVvay');
      const [userStatePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('user'), FARM_STATE.toBuffer(), this.wallet.publicKey.toBuffer()],
        FARMS_PROGRAM
      );
      const userStateAcct = await this.connection.getAccountInfo(userStatePDA);
      if (userStateAcct && userStateAcct.data.length >= 424) {
        const low = userStateAcct.data.readBigUInt64LE(408);
        const high = userStateAcct.data.readBigUInt64LE(416);
        const activeStakeScaled = low + (high << 64n);
        const kmnoStaked = Number(activeStakeScaled / 10n**18n) / 1e6;
        if (kmnoStaked > 0.01) {
          const stakedUsd = new Decimal(kmnoStaked).mul(kmnoPrice);
          totalValueUsd = totalValueUsd.plus(stakedUsd);
          console.log(`   KMNO staked: ${kmnoStaked.toFixed(2)} ($${stakedUsd.toFixed(2)})`);
        }
      }
    } catch (err) {
      console.log(`   ⚠️ Failed to get KMNO staking: ${(err as Error).message}`);
    }

    // 3c. KLend deposits — check obligation if it exists
    try {
      const OBLIGATION_KEY = new PublicKey('7qoM9cQtTpyJK3VRPUU7XUcWZ8XnBjdffEFS58ReLuHw');
      const oblAcct = await this.connection.getAccountInfo(OBLIGATION_KEY);
      if (oblAcct && oblAcct.data.length > 140) {
        const depositAmount = Number(oblAcct.data.readBigUInt64LE(128)) / 1e9;
        if (depositAmount > 0.001) {
          const klendUsd = new Decimal(depositAmount).mul(jitoSolPrice);
          totalValueUsd = totalValueUsd.plus(klendUsd);
          totalValueSol = totalValueUsd.div(solPrice);
          console.log(`   KLend JitoSOL: ${depositAmount.toFixed(6)} ($${klendUsd.toFixed(2)})`);
        }
      }
    } catch (err) {
      console.log(`   ⚠️ Failed to get KLend: ${(err as Error).message}`);
    }

    totalValueSol = totalValueUsd.div(solPrice);

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
    // Only compare LP positions — not the full portfolio
    let lpValueSol = new Decimal(0);
    let initialLpValueSol = new Decimal(0);

    for (const pos of currentPositions) {
      lpValueSol = lpValueSol.plus(new Decimal(pos.valueSol));
    }
    if (lpValueSol.isZero()) return undefined;

    // Get initial LP value from first snapshot's positions
    if (firstEntry.positions) {
      for (const pos of firstEntry.positions) {
        if (pos.strategy === 'LP Vault') {
          initialLpValueSol = initialLpValueSol.plus(new Decimal(pos.valueSol));
        }
      }
    }

    // If no initial LP data, use current as baseline (just started)
    if (initialLpValueSol.isZero()) {
      initialLpValueSol = lpValueSol;
    }

    // Hold value = what the LP capital would be worth if just held as JitoSOL
    // Appreciate by staking ratio change
    const initialRatio = new Decimal(firstEntry.jitosolToSolRatio || '1');
    const ratioChange = jitosolToSolRatio.gt(0) && initialRatio.gt(0)
      ? jitosolToSolRatio.div(initialRatio)
      : new Decimal(1);
    const holdValueSol = initialLpValueSol.mul(ratioChange);

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
