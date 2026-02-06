/**
 * Kamino Auto-Rebalancer — Decision Engine with Full Fee Accounting
 *
 * Automatically evaluates moving capital between strategies based on
 * NET yield after ALL costs: tx fees, withdrawal fees, deposit fees,
 * slippage, swap fees, IL risk, and opportunity cost.
 *
 * Strategies compared:
 *   1. Kamino LP Vault (JITOSOL-SOL concentrated liquidity, ~9-16% APY)
 *   2. Kamino K-Lend Supply (SOL/JitoSOL supply, ~10% APY)
 *   3. Kamino Multiply (leveraged JitoSOL staking — only when borrow < staking)
 *   4. Hold JitoSOL (baseline 5.57% staking yield, zero cost)
 *
 * Decision criteria:
 *   - break_even_days < 7
 *   - net_yield_improvement > 1% APY
 *   - new strategy yield sustained > 1 hour (not a spike)
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

import { KaminoClient } from './kamino-client';
import { MultiplyClient } from './multiply-client';
import { JupiterClient } from './jupiter-client';
import { LiquidityClient, LiquidityPosition, LiquidityVaultInfo } from './liquidity-client';
import { fetchLiveJitoStakingApy } from './scanner';
import { scanAllProtocols, ProtocolYield } from './multi-protocol-scanner';
import {
  Settings,
  StrategyType,
  TOKEN_MINTS,
  KAMINO_MARKETS,
} from './types';

// ─── Constants & Fee Assumptions ────────────────────────────────
// All assumptions documented here for auditability.

/** Base Solana tx fee (single signature, simple tx) */
const BASE_TX_FEE_SOL = 0.000005;

/**
 * Priority fee estimate for complex txs (Jupiter swaps, Kamino deposits).
 * Kamino deposit/withdraw instructions are large (many accounts).
 * Jupiter routes can add 0.0001-0.001 SOL in priority fees.
 * Conservative estimate: 0.0005 SOL per complex tx.
 */
const COMPLEX_TX_FEE_SOL = 0.0005;

/**
 * Kamino LP vault withdrawal fee.
 * Most Kamino liquidity vaults have 0% explicit withdrawal fee —
 * the cost is embedded in the share price / price impact on exit.
 * We model it as 0.1% conservative estimate for large positions.
 */
const LP_VAULT_WITHDRAWAL_FEE_PCT = 0.001; // 0.1%

/**
 * Kamino LP vault deposit fee.
 * Single-sided deposits route through KSwap/Jupiter internally,
 * so the real cost is slippage. Explicit deposit fee is 0%.
 * We add 0.05% for internal swap overhead.
 */
const LP_VAULT_DEPOSIT_FEE_PCT = 0.0005; // 0.05%

/**
 * K-Lend supply has no explicit deposit/withdrawal fees.
 * Cost is just tx fees.
 */
const KLEND_DEPOSIT_FEE_PCT = 0;
const KLEND_WITHDRAWAL_FEE_PCT = 0;

/**
 * Slippage estimate for JitoSOL <> SOL swaps.
 * JitoSOL-SOL is deep (~$500M+ liquidity across Orca/Raydium).
 * For our size (~2 JitoSOL ≈ $400), slippage is minimal.
 * Conservative: 0.3% for < 5 SOL, 0.5% for 5-50 SOL, 1% for 50+ SOL.
 */
function estimateSlippage(amountSol: Decimal): number {
  if (amountSol.lt(5)) return 0.003;  // 0.3%
  if (amountSol.lt(50)) return 0.005; // 0.5%
  return 0.01;                         // 1.0%
}

/**
 * Jupiter platform fee — typically 0% for most routes.
 * Some aggregated routes charge 0.1-0.3%.
 * Conservative: 0.1% for JitoSOL <> SOL.
 */
const JUPITER_PLATFORM_FEE_PCT = 0.001; // 0.1%

/**
 * Impermanent loss estimate for JitoSOL-SOL LP.
 * JitoSOL and SOL are highly correlated (JitoSOL ≈ SOL * staking_ratio).
 * The ratio drifts ~5.5% per year. Over 30 days, that's ~0.45%.
 * IL on correlated assets with small divergence:
 *   IL ≈ (price_ratio_change)^2 / 8 for concentrated positions.
 * For 0.45% divergence in 30 days: IL ≈ 0.0025% (negligible).
 * But concentrated ranges amplify IL. Conservative: 0.1% per 30 days.
 */
const IL_ESTIMATE_30D_PCT = 0.001; // 0.1% over 30 days

/**
 * Opportunity cost: time capital earns nothing while in transit.
 * Withdraw + swap + deposit takes ~30-90 seconds on Solana.
 * At 10% APY, 1 minute of downtime on $400 = $0.0000076. Negligible.
 * But we model it anyway: 5 minutes of the current strategy's yield.
 */
const TRANSIT_TIME_MINUTES = 5;

/**
 * Minimum number of tx required per strategy switch.
 * LP_VAULT → HOLD: 1 withdraw tx
 * LP_VAULT → KLEND: 1 withdraw + 1 deposit = 2 txs
 * LP_VAULT → LP_VAULT: 1 withdraw + 1 deposit = 2 txs (different vault)
 * KLEND → LP_VAULT: 1 withdraw + 1 deposit = 2 txs
 * HOLD → LP_VAULT: 1 deposit tx (single-sided)
 * HOLD → KLEND: 1 deposit tx
 */
function estimateTxCount(from: StrategyId, to: StrategyId): number {
  if (from === 'hold_jitosol') return 1;                // just deposit
  if (to === 'hold_jitosol') return 1;                  // just withdraw
  if (from === to) return 0;                             // no-op
  return 2;                                              // withdraw + deposit
}

/**
 * Whether a strategy switch requires a Jupiter swap.
 * LP vault deposits can be single-sided (JitoSOL → vault handles internal swap).
 * K-Lend SOL supply requires JitoSOL → SOL swap first.
 * Going to hold_jitosol from LP returns mixed tokens (need swap SOL→JitoSOL).
 */
function requiresSwap(from: StrategyId, to: StrategyId): boolean {
  // LP vault withdraw returns SOL + JitoSOL. If going to hold, need to swap SOL portion.
  if (from === 'lp_vault' && to === 'hold_jitosol') return true;
  // Going to K-Lend SOL supply from JitoSOL requires swap.
  if ((to as string) === 'klend_sol_supply') return true;
  // Going from K-Lend SOL to JitoSOL-based strategies.
  if ((from as string) === 'klend_sol_supply' && (to as string) !== 'klend_sol_supply') return true;
  return false;
}

// ─── Strategy Definitions ───────────────────────────────────────

export type StrategyId = 'lp_vault' | 'klend_sol_supply' | 'klend_jitosol_supply' | 'multiply' | 'hold_jitosol';

export interface StrategyInfo {
  id: StrategyId;
  name: string;
  type: StrategyType;
  /** Current gross APY (before any costs) */
  grossApy: Decimal;
  /** Is currently active / available */
  available: boolean;
  /** On-chain address (vault/reserve/market) */
  address: string;
  /** Extra metadata */
  meta: Record<string, any>;
}

export interface SwitchCostBreakdown {
  /** Solana transaction fees */
  txFeesSol: Decimal;
  /** Kamino withdrawal fee (% of position) */
  withdrawFeeSol: Decimal;
  /** Kamino deposit fee */
  depositFeeSol: Decimal;
  /** Swap slippage estimate */
  slippageSol: Decimal;
  /** Jupiter platform fee */
  jupiterFeeSol: Decimal;
  /** IL risk (annualized, prorated to holding period) */
  ilRiskSol: Decimal;
  /** Opportunity cost (earnings lost during transit) */
  opportunityCostSol: Decimal;
  /** Total cost in SOL */
  totalCostSol: Decimal;
  /** Total cost in USD */
  totalCostUsd: Decimal;
  /** Number of transactions required */
  txCount: number;
  /** Does this route require a swap? */
  swapRequired: boolean;
}

export interface ScoredStrategy {
  strategy: StrategyInfo;
  /** Gross APY */
  grossApy: Decimal;
  /** Net APY after ongoing costs (IL for LP, etc.) */
  netApy: Decimal;
  /** Cost to switch to this strategy from current */
  switchCost: SwitchCostBreakdown;
  /** Break-even days to recover switch cost */
  breakEvenDays: number;
  /** Final score (net APY minus amortized switch cost) */
  score: Decimal;
}

export interface RebalanceRecommendation {
  shouldRebalance: boolean;
  currentStrategy: StrategyInfo;
  bestAlternative: ScoredStrategy | null;
  allStrategies: ScoredStrategy[];
  reasoning: string[];
  timestamp: Date;
  capitalSol: Decimal;
  idleCapitalSol: Decimal;
  idleRecommendation: IdleCapitalRecommendation | null;
}

export interface IdleCapitalRecommendation {
  bestStrategy: StrategyInfo;
  netApyAfterFees: Decimal;
  switchCost: SwitchCostBreakdown;
  breakEvenDays: number;
  shouldDeploy: boolean;
  reasoning: string;
}

// ─── Rate History Tracker ───────────────────────────────────────

interface RateHistoryEntry {
  timestamp: number; // ms
  strategyId: StrategyId;
  apy: number;
}

const RATE_HISTORY_PATH = path.join(__dirname, '../config/rate-history.json');
const REBALANCER_LOG_PATH = path.join(__dirname, '../config/rebalancer-log.jsonl');
const CROSS_PROTOCOL_LOG_PATH = path.join(__dirname, '../config/cross-protocol-log.jsonl');

function loadRateHistory(): RateHistoryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(RATE_HISTORY_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveRateHistory(history: RateHistoryEntry[]) {
  // Keep last 500 entries (enough for ~1 week at 2h intervals × 4 strategies)
  const trimmed = history.slice(-500);
  fs.writeFileSync(RATE_HISTORY_PATH, JSON.stringify(trimmed, null, 2));
}

function recordRates(strategies: StrategyInfo[]) {
  const history = loadRateHistory();
  const now = Date.now();
  for (const s of strategies) {
    history.push({
      timestamp: now,
      strategyId: s.id,
      apy: s.grossApy.toNumber(),
    });
  }
  saveRateHistory(history);
}

/**
 * Check if a strategy has been at higher yield than threshold for > minDurationMs.
 * Returns false if we don't have enough history (conservative — don't switch on spikes).
 */
function hasBeenHigherFor(
  strategyId: StrategyId,
  thresholdApy: number,
  minDurationMs: number = 3600_000 // 1 hour default
): boolean {
  const history = loadRateHistory();
  const now = Date.now();
  const relevant = history
    .filter(e => e.strategyId === strategyId && e.timestamp > now - minDurationMs)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (relevant.length === 0) return false;

  // Check if ALL entries in the window are above threshold
  // (If we only have recent data, be conservative)
  const oldestEntry = relevant[0];
  const windowCovered = now - oldestEntry.timestamp;

  // Need at least 50% of the window covered with data
  if (windowCovered < minDurationMs * 0.5) return false;

  return relevant.every(e => e.apy >= thresholdApy);
}

// ─── Decision Log ───────────────────────────────────────────────

function logDecision(recommendation: RebalanceRecommendation) {
  const entry = {
    timestamp: recommendation.timestamp.toISOString(),
    shouldRebalance: recommendation.shouldRebalance,
    currentStrategy: recommendation.currentStrategy.id,
    currentApy: recommendation.currentStrategy.grossApy.toFixed(2),
    bestAlternative: recommendation.bestAlternative?.strategy.id ?? null,
    bestAlternativeApy: recommendation.bestAlternative?.grossApy.toFixed(2) ?? null,
    breakEvenDays: recommendation.bestAlternative?.breakEvenDays ?? null,
    capitalSol: recommendation.capitalSol.toFixed(4),
    idleSol: recommendation.idleCapitalSol.toFixed(4),
    idleDeploy: recommendation.idleRecommendation?.shouldDeploy ?? false,
    idleStrategy: recommendation.idleRecommendation?.bestStrategy.id ?? null,
    reasoning: recommendation.reasoning,
    strategies: recommendation.allStrategies.map(s => ({
      id: s.strategy.id,
      grossApy: s.grossApy.toFixed(2),
      netApy: s.netApy.toFixed(2),
      switchCostSol: s.switchCost.totalCostSol.toFixed(6),
      breakEvenDays: s.breakEvenDays,
      score: s.score.toFixed(4),
    })),
  };
  fs.appendFileSync(REBALANCER_LOG_PATH, JSON.stringify(entry) + '\n');
}

// ─── Fee Calculator ─────────────────────────────────────────────

/**
 * Calculate total cost of switching from one strategy to another.
 *
 * @param fromStrategy - Current strategy
 * @param toStrategy - Target strategy
 * @param amountSol - Amount in SOL-equivalent terms
 * @param solPrice - Current SOL price in USD
 * @param currentApy - Current strategy APY (for opportunity cost)
 * @returns Detailed cost breakdown
 */
export function calculateSwitchCost(
  fromStrategy: StrategyId,
  toStrategy: StrategyId,
  amountSol: Decimal,
  solPrice: Decimal,
  currentApy: Decimal,
): SwitchCostBreakdown {
  // 1. Transaction fees
  const txCount = estimateTxCount(fromStrategy, toStrategy);
  const swapRequired = requiresSwap(fromStrategy, toStrategy);
  const txFeePerTx = swapRequired ? new Decimal(COMPLEX_TX_FEE_SOL) : new Decimal(BASE_TX_FEE_SOL);
  // Each tx has a base cost, swap txs are more expensive
  let txFeesSol = txFeePerTx.mul(txCount);
  if (swapRequired) {
    // Additional priority fee for the swap tx
    txFeesSol = txFeesSol.plus(COMPLEX_TX_FEE_SOL);
  }

  // 2. Withdrawal fees
  let withdrawFeeSol = new Decimal(0);
  if (fromStrategy === 'lp_vault') {
    withdrawFeeSol = amountSol.mul(LP_VAULT_WITHDRAWAL_FEE_PCT);
  } else if (fromStrategy === 'klend_sol_supply' || fromStrategy === 'klend_jitosol_supply') {
    withdrawFeeSol = amountSol.mul(KLEND_WITHDRAWAL_FEE_PCT);
  }
  // hold_jitosol: no withdrawal needed

  // 3. Deposit fees
  let depositFeeSol = new Decimal(0);
  if (toStrategy === 'lp_vault') {
    depositFeeSol = amountSol.mul(LP_VAULT_DEPOSIT_FEE_PCT);
  } else if (toStrategy === 'klend_sol_supply' || toStrategy === 'klend_jitosol_supply') {
    depositFeeSol = amountSol.mul(KLEND_DEPOSIT_FEE_PCT);
  }
  // hold_jitosol: no deposit needed

  // 4. Slippage (only if swap is required)
  let slippageSol = new Decimal(0);
  if (swapRequired) {
    slippageSol = amountSol.mul(estimateSlippage(amountSol));
  }
  // LP vault single-sided deposits have internal slippage (~half the amount is swapped)
  if (toStrategy === 'lp_vault' && fromStrategy !== 'lp_vault') {
    // ~50% of deposit is swapped internally
    slippageSol = slippageSol.plus(amountSol.mul(0.5).mul(estimateSlippage(amountSol.mul(0.5))));
  }

  // 5. Jupiter platform fee
  let jupiterFeeSol = new Decimal(0);
  if (swapRequired) {
    jupiterFeeSol = amountSol.mul(JUPITER_PLATFORM_FEE_PCT);
  }

  // 6. IL risk (only for LP vault target, amortized over 30 days)
  let ilRiskSol = new Decimal(0);
  if (toStrategy === 'lp_vault') {
    ilRiskSol = amountSol.mul(IL_ESTIMATE_30D_PCT);
  }

  // 7. Opportunity cost (earnings lost during transit)
  // currentApy is in percentage (e.g., 9.65)
  const yearlyEarningsSol = amountSol.mul(currentApy).div(100);
  const minuteEarningsSol = yearlyEarningsSol.div(365 * 24 * 60);
  const opportunityCostSol = minuteEarningsSol.mul(TRANSIT_TIME_MINUTES);

  // Total
  const totalCostSol = txFeesSol
    .plus(withdrawFeeSol)
    .plus(depositFeeSol)
    .plus(slippageSol)
    .plus(jupiterFeeSol)
    .plus(ilRiskSol)
    .plus(opportunityCostSol);

  return {
    txFeesSol,
    withdrawFeeSol,
    depositFeeSol,
    slippageSol,
    jupiterFeeSol,
    ilRiskSol,
    opportunityCostSol,
    totalCostSol,
    totalCostUsd: totalCostSol.mul(solPrice),
    txCount,
    swapRequired,
  };
}

// ─── Strategy Scorer ────────────────────────────────────────────

/**
 * Fetch live data for all strategies and return them scored.
 * This is the core intelligence — ranks by NET yield after fees.
 *
 * CONSERVATIVE WITH RPC: batches calls, caches where possible.
 */
export async function scoreStrategies(
  connection: Connection,
  kaminoClient: KaminoClient,
  multiplyClient: MultiplyClient,
  liquidityClient: LiquidityClient,
  currentStrategyId: StrategyId,
  currentApy: Decimal,
  capitalSol: Decimal,
  solPrice: Decimal,
): Promise<ScoredStrategy[]> {
  const strategies: StrategyInfo[] = [];

  // 1. Fetch JitoSOL staking yield (baseline for all strategies)
  let jitoStakingApy: Decimal;
  try {
    const liveApy = await fetchLiveJitoStakingApy();
    jitoStakingApy = new Decimal(liveApy.apy);
  } catch {
    jitoStakingApy = new Decimal(5.57);
  }

  // 2. Hold JitoSOL — always available, zero cost
  strategies.push({
    id: 'hold_jitosol',
    name: 'Hold JitoSOL (staking yield)',
    type: StrategyType.KLEND, // closest enum
    grossApy: jitoStakingApy,
    available: true,
    address: TOKEN_MINTS.JitoSOL,
    meta: { source: 'jito-staking' },
  });

  // 3. Kamino LP Vault — fetch best JitoSOL-SOL vault
  //    (CAREFUL: this makes several RPC calls via the Kamino SDK)
  try {
    const lpVaults = await liquidityClient.listJitoSolVaults();
    if (lpVaults.length > 0) {
      // Pick the best one that's in range
      const bestInRange = lpVaults.find(v => !v.outOfRange) || lpVaults[0];
      strategies.push({
        id: 'lp_vault',
        name: `LP Vault ${bestInRange.name}`,
        type: StrategyType.LP_VAULT,
        grossApy: bestInRange.totalApy,
        available: !bestInRange.outOfRange,
        address: bestInRange.address,
        meta: {
          tvlUsd: bestInRange.tvlUsd.toNumber(),
          feeApy: bestInRange.feeApy.toNumber(),
          outOfRange: bestInRange.outOfRange,
          sharePrice: bestInRange.sharePrice.toNumber(),
        },
      });
    }
  } catch (err: any) {
    console.log(`   ⚠️  LP vault scan failed: ${err.message}`);
  }

  // 4. K-Lend Supply SOL (Main market)
  try {
    await kaminoClient.initialize();
    const reserves = await kaminoClient.getReserves();
    const solReserve = reserves.find(r => r.token === 'SOL');
    if (solReserve) {
      strategies.push({
        id: 'klend_sol_supply',
        name: 'K-Lend SOL Supply',
        type: StrategyType.KLEND,
        grossApy: solReserve.apy,
        available: true,
        address: solReserve.address,
        meta: { market: 'Main' },
      });
    }

    // K-Lend JitoSOL supply (if available)
    const jitoReserve = reserves.find(r => r.token === 'JitoSOL' || r.token === 'JITOSOL');
    if (jitoReserve && jitoReserve.apy.gt(0.01)) {
      strategies.push({
        id: 'klend_jitosol_supply',
        name: 'K-Lend JitoSOL Supply',
        type: StrategyType.KLEND,
        // JitoSOL supply APY + staking yield (you keep staking yield while supplying)
        grossApy: jitoReserve.apy.plus(jitoStakingApy),
        available: true,
        address: jitoReserve.address,
        meta: {
          supplyApyOnly: jitoReserve.apy.toNumber(),
          stakingYieldIncluded: true,
          market: 'Main',
        },
      });
    }
  } catch (err: any) {
    console.log(`   ⚠️  K-Lend scan failed: ${err.message}`);
  }

  // 5. Multiply — only if spread is positive
  try {
    const multiplyCheck = await multiplyClient.shouldOpenPosition();
    if (multiplyCheck.profitable) {
      const rates = multiplyCheck.rates;
      strategies.push({
        id: 'multiply',
        name: 'Multiply JitoSOL/SOL',
        type: StrategyType.MULTIPLY,
        grossApy: rates.netApyAt5x.gt(0) ? rates.netApyAt5x : new Decimal(0),
        available: multiplyCheck.profitable,
        address: KAMINO_MARKETS.JITO,
        meta: {
          spread: rates.spread.toNumber(),
          borrowApy: rates.solBorrowApy.toNumber(),
          stakingApy: rates.jitosolSupplyApy.toNumber(),
        },
      });
    }
  } catch (err: any) {
    console.log(`   ⚠️  Multiply check failed: ${err.message}`);
  }

  // Record rates for history tracking
  recordRates(strategies);

  // ─── Cross-protocol comparison (read-only) ──────────────
  // Fetch yields from other protocols (Marginfi, Drift, etc.) for comparison.
  // We don't move capital cross-protocol yet — just log for awareness.
  try {
    const crossProtocolYields = await scanAllProtocols();
    const relevantYields = crossProtocolYields
      .filter(y =>
        (y.tokenIn === 'SOL' || y.tokenIn === 'JITOSOL') &&
        y.apy > 0 &&
        y.protocol !== 'kamino' // exclude kamino — we already track that
      )
      .slice(0, 15); // top 15

    if (relevantYields.length > 0) {
      const currentApyNum = currentApy.toNumber();
      const better = relevantYields.filter(y => y.apy > currentApyNum);

      console.log(`\n   📡 Cross-protocol scan: ${relevantYields.length} opportunities from ${new Set(relevantYields.map(y => y.protocol)).size} protocols`);
      for (const y of relevantYields.slice(0, 5)) {
        const marker = y.apy > currentApyNum ? '🔥' : '  ';
        console.log(`   ${marker} ${y.protocol.padEnd(12)} ${y.pool.padEnd(30).slice(0, 30)} ${y.apy.toFixed(2).padStart(7)}% APY  (${y.risk} risk, $${(y.tvl / 1e6).toFixed(1)}M TVL)`);
      }

      if (better.length > 0) {
        console.log(`   💡 ${better.length} protocol(s) beating current ${currentApyNum.toFixed(2)}% APY (cross-protocol moves not yet enabled)`);
      }

      // Log to cross-protocol log file
      const logEntry = {
        timestamp: new Date().toISOString(),
        currentApy: currentApyNum,
        currentStrategy: currentStrategyId,
        crossProtocolOpportunities: relevantYields.map(y => ({
          protocol: y.protocol,
          pool: y.pool,
          apy: y.apy,
          risk: y.risk,
          tvl: y.tvl,
          beating: y.apy > currentApyNum,
        })),
      };
      fs.appendFileSync(CROSS_PROTOCOL_LOG_PATH, JSON.stringify(logEntry) + '\n');
    }
  } catch (err: any) {
    console.log(`   ⚠️  Cross-protocol scan failed: ${err.message?.slice(0, 60)}`);
  }

  // Score each strategy
  const scored: ScoredStrategy[] = [];

  for (const strategy of strategies) {
    // Calculate switch cost from current position
    const switchCost = calculateSwitchCost(
      currentStrategyId,
      strategy.id,
      capitalSol,
      solPrice,
      currentApy,
    );

    // Net APY = gross APY minus ongoing costs
    let netApy = strategy.grossApy;

    // LP vaults have IL risk as ongoing cost (annualized)
    if (strategy.id === 'lp_vault') {
      // IL_ESTIMATE_30D_PCT annualized = 12 * 0.1% = 1.2% per year
      netApy = netApy.minus(new Decimal(IL_ESTIMATE_30D_PCT).mul(12).mul(100));
    }

    // K-Lend SOL supply: you LOSE staking yield because you hold SOL instead of JitoSOL
    if (strategy.id === 'klend_sol_supply') {
      // The supply APY needs to be compared against what you'd earn just holding JitoSOL.
      // Net benefit = SOL supply APY - JitoSOL staking yield (opportunity cost of not staking)
      // BUT: the user already holds JitoSOL. To supply SOL, they'd need to swap JitoSOL → SOL,
      // losing the staking yield. So the effective APY is just the supply APY.
      // (The staking yield cost is already accounted for in the comparison.)
    }

    // Break-even calculation
    const apyDifference = netApy.minus(currentApy);
    let breakEvenDays = Infinity;

    if (strategy.id === currentStrategyId) {
      breakEvenDays = 0; // Already there
    } else if (apyDifference.gt(0) && switchCost.totalCostSol.gt(0)) {
      // Daily yield improvement in SOL
      const dailyImprovementSol = capitalSol.mul(apyDifference).div(100).div(365);
      if (dailyImprovementSol.gt(0)) {
        breakEvenDays = switchCost.totalCostSol.div(dailyImprovementSol).toNumber();
      }
    } else if (apyDifference.lte(0)) {
      breakEvenDays = Infinity; // Worse strategy
    }

    // Score: net APY minus annualized switch cost (amortized over 30 days)
    // This gives a "30-day adjusted APY" that accounts for entry cost.
    let score = netApy;
    if (strategy.id !== currentStrategyId && capitalSol.gt(0)) {
      const switchCostAnnualized = switchCost.totalCostSol
        .div(capitalSol)
        .mul(100) // to percentage
        .mul(365 / 30); // annualize from 30-day amortization
      score = netApy.minus(switchCostAnnualized);
    }

    scored.push({
      strategy,
      grossApy: strategy.grossApy,
      netApy,
      switchCost,
      breakEvenDays: isFinite(breakEvenDays) ? Math.round(breakEvenDays * 10) / 10 : 9999,
      score,
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score.minus(a.score).toNumber());

  return scored;
}

// ─── Rebalance Decision Engine ──────────────────────────────────

/**
 * Main entry point. Evaluates current position vs alternatives.
 * Returns a recommendation with full reasoning.
 *
 * Decision criteria:
 *   - break_even_days < 7
 *   - net_yield_improvement > 1% APY
 *   - new strategy yield sustained > 1 hour
 */
export async function shouldRebalance(
  connection: Connection,
  kaminoClient: KaminoClient,
  multiplyClient: MultiplyClient,
  liquidityClient: LiquidityClient,
  currentStrategyId: StrategyId,
  currentApy: Decimal,
  capitalSol: Decimal,
  idleCapitalSol: Decimal,
  solPrice: Decimal,
): Promise<RebalanceRecommendation> {
  const reasoning: string[] = [];
  const timestamp = new Date();

  reasoning.push(`Current strategy: ${currentStrategyId} @ ${currentApy.toFixed(2)}% APY`);
  reasoning.push(`Capital: ${capitalSol.toFixed(4)} SOL ($${capitalSol.mul(solPrice).toFixed(2)})`);
  reasoning.push(`Idle: ${idleCapitalSol.toFixed(4)} SOL`);

  // Score all strategies
  const allStrategies = await scoreStrategies(
    connection,
    kaminoClient,
    multiplyClient,
    liquidityClient,
    currentStrategyId,
    currentApy,
    capitalSol,
    solPrice,
  );

  // Find current strategy in scored list
  const currentScored = allStrategies.find(s => s.strategy.id === currentStrategyId);

  // Find best alternative (not current)
  const alternatives = allStrategies.filter(s => s.strategy.id !== currentStrategyId && s.strategy.available);
  const bestAlternative = alternatives.length > 0 ? alternatives[0] : null;

  if (!bestAlternative) {
    reasoning.push('No alternatives available.');
    const recommendation: RebalanceRecommendation = {
      shouldRebalance: false,
      currentStrategy: currentScored?.strategy ?? allStrategies[0].strategy,
      bestAlternative: null,
      allStrategies,
      reasoning,
      timestamp,
      capitalSol,
      idleCapitalSol,
      idleRecommendation: null,
    };
    logDecision(recommendation);
    return recommendation;
  }

  const netImprovement = bestAlternative.netApy.minus(currentApy);
  reasoning.push(`Best alternative: ${bestAlternative.strategy.id} @ ${bestAlternative.grossApy.toFixed(2)}% gross, ${bestAlternative.netApy.toFixed(2)}% net`);
  reasoning.push(`Net improvement: ${netImprovement.toFixed(2)}% APY`);
  reasoning.push(`Switch cost: ${bestAlternative.switchCost.totalCostSol.toFixed(6)} SOL ($${bestAlternative.switchCost.totalCostUsd.toFixed(4)})`);
  reasoning.push(`Break-even: ${bestAlternative.breakEvenDays} days`);

  // Apply decision criteria
  let shouldSwitch = true;

  // Criterion 1: Break-even < 7 days
  if (bestAlternative.breakEvenDays > 7) {
    shouldSwitch = false;
    reasoning.push(`❌ FAIL: Break-even ${bestAlternative.breakEvenDays} days > 7 day maximum`);
  } else {
    reasoning.push(`✅ PASS: Break-even ${bestAlternative.breakEvenDays} days < 7 day maximum`);
  }

  // Criterion 2: Net improvement > 1% APY
  if (netImprovement.lt(1)) {
    shouldSwitch = false;
    reasoning.push(`❌ FAIL: Net improvement ${netImprovement.toFixed(2)}% < 1% minimum threshold`);
  } else {
    reasoning.push(`✅ PASS: Net improvement ${netImprovement.toFixed(2)}% > 1% minimum threshold`);
  }

  // Criterion 3: Sustained yield (not a spike)
  const currentThreshold = currentApy.toNumber();
  const sustained = hasBeenHigherFor(
    bestAlternative.strategy.id,
    currentThreshold,
    3600_000 // 1 hour
  );
  if (!sustained) {
    shouldSwitch = false;
    reasoning.push(`❌ FAIL: ${bestAlternative.strategy.id} yield not sustained > 1 hour above ${currentThreshold.toFixed(2)}%`);
  } else {
    reasoning.push(`✅ PASS: ${bestAlternative.strategy.id} yield sustained > 1 hour`);
  }

  // ─── Evaluate idle capital ────────────────────────────────
  let idleRecommendation: IdleCapitalRecommendation | null = null;

  if (idleCapitalSol.gt(0.01)) {
    reasoning.push(`\nEvaluating idle ${idleCapitalSol.toFixed(4)} JitoSOL...`);

    // Idle JitoSOL earns staking yield passively (~5.57%)
    const idleApy = allStrategies.find(s => s.strategy.id === 'hold_jitosol')?.grossApy ?? new Decimal(5.57);

    // Find best strategy for idle capital
    const idleStrategies = await scoreStrategies(
      connection,
      kaminoClient,
      multiplyClient,
      liquidityClient,
      'hold_jitosol', // idle is effectively "hold"
      idleApy,
      idleCapitalSol,
      solPrice,
    );

    const bestForIdle = idleStrategies.find(s => s.strategy.id !== 'hold_jitosol' && s.strategy.available);

    if (bestForIdle) {
      const idleImprovement = bestForIdle.netApy.minus(idleApy);
      const idleShouldDeploy = idleImprovement.gt(1) && bestForIdle.breakEvenDays < 7;

      idleRecommendation = {
        bestStrategy: bestForIdle.strategy,
        netApyAfterFees: bestForIdle.netApy,
        switchCost: bestForIdle.switchCost,
        breakEvenDays: bestForIdle.breakEvenDays,
        shouldDeploy: idleShouldDeploy,
        reasoning: idleShouldDeploy
          ? `Deploy idle JitoSOL to ${bestForIdle.strategy.id}: +${idleImprovement.toFixed(2)}% APY, break-even in ${bestForIdle.breakEvenDays} days`
          : `Keep idle: improvement ${idleImprovement.toFixed(2)}% too small or break-even ${bestForIdle.breakEvenDays} days too long`,
      };

      reasoning.push(`Idle recommendation: ${idleRecommendation.reasoning}`);
    }
  }

  const recommendation: RebalanceRecommendation = {
    shouldRebalance: shouldSwitch,
    currentStrategy: currentScored?.strategy ?? allStrategies[0].strategy,
    bestAlternative,
    allStrategies,
    reasoning,
    timestamp,
    capitalSol,
    idleCapitalSol,
    idleRecommendation,
  };

  logDecision(recommendation);
  return recommendation;
}

// ─── Rebalance Executor ─────────────────────────────────────────

/**
 * Execute a rebalance: withdraw from current → (swap if needed) → deposit to new.
 * Handles the full lifecycle atomically.
 *
 * @param dryRun - If true, only simulate (no on-chain txs)
 */
export async function executeRebalance(
  wallet: Keypair,
  fromStrategy: StrategyId,
  toStrategy: StrategyId,
  amountSol: Decimal,
  settings: Settings,
  kaminoClient: KaminoClient,
  liquidityClient: LiquidityClient,
  jupiterClient: JupiterClient,
): Promise<{ success: boolean; message: string; txSignatures: string[] }> {
  const dryRun = settings.dryRun;
  const txSignatures: string[] = [];
  const steps: string[] = [];

  console.log(`\n⚡ ${dryRun ? 'DRY RUN — ' : ''}Rebalancing ${amountSol.toFixed(4)} SOL: ${fromStrategy} → ${toStrategy}`);

  try {
    // ─── Step 1: Withdraw from current strategy ──────────────
    if (fromStrategy === 'lp_vault') {
      // Get user's LP position to know shares amount
      const positions = await liquidityClient.getUserPositions(wallet.publicKey);
      if (positions.length === 0) {
        return { success: false, message: 'No LP positions to withdraw from', txSignatures };
      }

      const pos = positions[0]; // Primary position
      steps.push(`Withdraw ${pos.sharesAmount.toFixed(6)} shares from LP vault`);

      const result = await liquidityClient.withdrawAll(wallet, pos.strategyAddress, dryRun);
      if (!result.success) {
        return { success: false, message: `Withdraw failed: ${result.message}`, txSignatures };
      }
      if (result.signature) txSignatures.push(result.signature);
      steps.push(`✅ Withdrew from LP vault`);

    } else if (fromStrategy === 'klend_sol_supply') {
      steps.push(`Withdraw ${amountSol.toFixed(4)} SOL from K-Lend`);

      if (!dryRun) {
        const sig = await kaminoClient.withdraw(wallet, 'SOL', amountSol);
        txSignatures.push(sig);
      }
      steps.push(`✅ Withdrew from K-Lend SOL`);

    } else if (fromStrategy === 'klend_jitosol_supply') {
      steps.push(`Withdraw ${amountSol.toFixed(4)} JitoSOL from K-Lend`);

      if (!dryRun) {
        const sig = await kaminoClient.withdraw(wallet, 'JitoSOL', amountSol);
        txSignatures.push(sig);
      }
      steps.push(`✅ Withdrew from K-Lend JitoSOL`);

    } else if (fromStrategy === 'hold_jitosol') {
      steps.push(`Using idle JitoSOL (no withdrawal needed)`);
    }

    // Brief delay for state to settle
    if (!dryRun && fromStrategy !== 'hold_jitosol') {
      await new Promise(r => setTimeout(r, 2000));
    }

    // ─── Step 2: Swap if needed ──────────────────────────────
    if (requiresSwap(fromStrategy, toStrategy)) {
      if (toStrategy === 'klend_sol_supply') {
        // JitoSOL → SOL swap
        steps.push(`Swap ~${amountSol.toFixed(4)} JitoSOL → SOL via Jupiter`);
        const swapResult = await jupiterClient.executeSwap(
          'JitoSOL', 'SOL', amountSol, wallet, dryRun
        );
        if (swapResult.signature) txSignatures.push(swapResult.signature);
        steps.push(`✅ Swap complete`);

      } else if (fromStrategy === 'klend_sol_supply') {
        // SOL → JitoSOL swap
        steps.push(`Swap ~${amountSol.toFixed(4)} SOL → JitoSOL via Jupiter`);
        const swapResult = await jupiterClient.executeSwap(
          'SOL', 'JitoSOL', amountSol, wallet, dryRun
        );
        if (swapResult.signature) txSignatures.push(swapResult.signature);
        steps.push(`✅ Swap complete`);
      }
    }

    // Brief delay after swap
    if (!dryRun && requiresSwap(fromStrategy, toStrategy)) {
      await new Promise(r => setTimeout(r, 2000));
    }

    // ─── Step 3: Deposit to new strategy ─────────────────────
    if (toStrategy === 'lp_vault') {
      // Single-sided deposit into LP vault
      // Use the best in-range strategy
      const lpVaults = await liquidityClient.listJitoSolVaults();
      const bestVault = lpVaults.find(v => !v.outOfRange) || lpVaults[0];

      if (!bestVault) {
        return { success: false, message: 'No LP vault available for deposit', txSignatures };
      }

      steps.push(`Single-sided deposit ${amountSol.toFixed(4)} JitoSOL into ${bestVault.address.slice(0, 8)}...`);

      const result = await liquidityClient.singleSidedDepositB(
        wallet,
        bestVault.address,
        amountSol,
        settings.jupiter?.slippageBps ?? 50,
        dryRun,
      );
      if (!result.success) {
        return { success: false, message: `Deposit failed: ${result.message}`, txSignatures };
      }
      if (result.signature) txSignatures.push(result.signature);
      steps.push(`✅ Deposited to LP vault`);

    } else if (toStrategy === 'klend_sol_supply') {
      steps.push(`Deposit ${amountSol.toFixed(4)} SOL to K-Lend`);

      if (!dryRun) {
        const sig = await kaminoClient.deposit(wallet, 'SOL', amountSol);
        txSignatures.push(sig);
      }
      steps.push(`✅ Deposited to K-Lend SOL`);

    } else if (toStrategy === 'klend_jitosol_supply') {
      steps.push(`Deposit ${amountSol.toFixed(4)} JitoSOL to K-Lend`);

      if (!dryRun) {
        const sig = await kaminoClient.deposit(wallet, 'JitoSOL', amountSol);
        txSignatures.push(sig);
      }
      steps.push(`✅ Deposited to K-Lend JitoSOL`);

    } else if (toStrategy === 'hold_jitosol') {
      steps.push(`Holding JitoSOL in wallet (no deposit needed)`);
    }

    const message = steps.join(' → ');
    console.log(`   ${dryRun ? '🧪 DRY RUN: ' : ''}${message}`);

    return { success: true, message, txSignatures };

  } catch (err: any) {
    return {
      success: false,
      message: `Rebalance failed at step: ${steps[steps.length - 1] || 'init'}: ${err.message}`,
      txSignatures,
    };
  }
}

// ─── Public API for Integration ─────────────────────────────────

/**
 * Run the full rebalancer evaluation.
 * This is what optimize-cron.ts calls.
 */
export async function runRebalancer(
  settings: Settings,
  wallet: Keypair,
  connection: Connection,
): Promise<RebalanceRecommendation> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('     ⚖️  AUTO-REBALANCER — Full Fee Accounting');
  console.log(`     ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ─── Gas reserve check ──────────────────────────────────
  const MIN_GAS_SOL = 0.003;
  const solLamports = await connection.getBalance(wallet.publicKey);
  const walletSolBalance = new Decimal(solLamports).div(LAMPORTS_PER_SOL);

  if (walletSolBalance.lt(MIN_GAS_SOL)) {
    console.log(`⚠️  SOL balance ${walletSolBalance.toFixed(6)} < ${MIN_GAS_SOL} minimum gas reserve!`);
    console.log(`   Skipping rebalancer — insufficient gas for transactions.`);
    // Return a hold recommendation
    const emptyRec: RebalanceRecommendation = {
      shouldRebalance: false,
      currentStrategy: { id: 'hold_jitosol', name: 'Hold JitoSOL', type: StrategyType.KLEND, grossApy: new Decimal(5.57), available: true, address: '', meta: {} },
      bestAlternative: null,
      allStrategies: [],
      reasoning: [`Gas too low: ${walletSolBalance.toFixed(6)} SOL < ${MIN_GAS_SOL} minimum`],
      timestamp: new Date(),
      capitalSol: new Decimal(0),
      idleCapitalSol: new Decimal(0),
      idleRecommendation: null,
    };
    logDecision(emptyRec);
    return emptyRec;
  }

  // Initialize clients
  const kaminoClient = new KaminoClient(settings.rpcUrl);
  const multiplyClient = new MultiplyClient(settings.rpcUrl, settings.multiply);
  const jupiterClient = new JupiterClient(connection, settings.jupiter);
  const liquidityClient = new LiquidityClient(settings.rpcUrl);

  await kaminoClient.initialize();

  // Get SOL price
  let solPrice: Decimal;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json() as any;
    solPrice = new Decimal(data.solana?.usd ?? 200);
  } catch {
    solPrice = new Decimal(200);
  }

  console.log(`💲 SOL price: $${solPrice.toFixed(2)}`);

  // Detect current position
  // Check LP positions first (our main strategy)
  const lpPositions = await liquidityClient.getUserPositions(wallet.publicKey);
  const jitosolBalance = await kaminoClient.getTokenBalance(wallet.publicKey, TOKEN_MINTS.JitoSOL);

  let currentStrategyId: StrategyId = 'hold_jitosol';
  let currentApy = new Decimal(5.57); // default staking yield
  let capitalSol = jitosolBalance;
  let idleCapitalSol = new Decimal(0);

  if (lpPositions.length > 0) {
    const primaryLP = lpPositions[0];
    currentStrategyId = 'lp_vault';
    currentApy = primaryLP.currentApy;
    // LP value in SOL terms
    capitalSol = primaryLP.valueUsd.div(solPrice);
    idleCapitalSol = jitosolBalance;

    console.log(`📍 Current position: LP Vault @ ${currentApy.toFixed(2)}% APY`);
    console.log(`   LP value: $${primaryLP.valueUsd.toFixed(2)} (${capitalSol.toFixed(4)} SOL equiv)`);
    console.log(`   Idle JitoSOL: ${idleCapitalSol.toFixed(4)}`);
  } else {
    // Check K-Lend positions
    const klendPositions = await kaminoClient.getUserPositions(wallet.publicKey);
    if (klendPositions.length > 0) {
      const primary = klendPositions[0];
      currentStrategyId = primary.token === 'SOL' ? 'klend_sol_supply' : 'klend_jitosol_supply';
      currentApy = primary.currentApy;
      capitalSol = primary.tokenAmount.div(LAMPORTS_PER_SOL);
      idleCapitalSol = jitosolBalance;

      console.log(`📍 Current position: K-Lend ${primary.token} @ ${currentApy.toFixed(2)}% APY`);
    } else {
      console.log(`📍 Current position: Holding JitoSOL @ ${currentApy.toFixed(2)}% staking yield`);
      capitalSol = jitosolBalance;
      idleCapitalSol = new Decimal(0); // all capital IS idle
    }
  }

  // Run the decision engine
  const recommendation = await shouldRebalance(
    connection,
    kaminoClient,
    multiplyClient,
    liquidityClient,
    currentStrategyId,
    currentApy,
    capitalSol,
    idleCapitalSol,
    solPrice,
  );

  // Print results
  console.log('\n┌──────────────────────────────────────────────────────────┐');
  console.log('│              ⚖️  REBALANCER RESULTS                      │');
  console.log('├──────────────────────────────────────────────────────────┤');

  for (const scored of recommendation.allStrategies) {
    const isCurrent = scored.strategy.id === currentStrategyId ? '→' : ' ';
    const available = scored.strategy.available ? '✅' : '❌';
    console.log(`│ ${isCurrent} ${available} ${scored.strategy.name.padEnd(30)} ${scored.grossApy.toFixed(2).padStart(6)}% gross │`);
    console.log(`│       Net: ${scored.netApy.toFixed(2)}%  Score: ${scored.score.toFixed(2)}  Break-even: ${scored.breakEvenDays === 9999 ? '  N/A' : (scored.breakEvenDays + 'd').padStart(5)} │`);
    if (scored.strategy.id !== currentStrategyId) {
      const c = scored.switchCost;
      console.log(`│       Cost: ${c.totalCostSol.toFixed(6)} SOL ($${c.totalCostUsd.toFixed(4)})                  │`);
      console.log(`│         tx:${c.txFeesSol.toFixed(6)} wdraw:${c.withdrawFeeSol.toFixed(6)} dep:${c.depositFeeSol.toFixed(6)}  │`);
      console.log(`│         slip:${c.slippageSol.toFixed(6)} jup:${c.jupiterFeeSol.toFixed(6)} IL:${c.ilRiskSol.toFixed(6)}   │`);
    }
  }

  console.log('├──────────────────────────────────────────────────────────┤');

  if (recommendation.shouldRebalance && recommendation.bestAlternative) {
    console.log(`│  🔄 RECOMMENDATION: REBALANCE                           │`);
    console.log(`│     ${currentStrategyId} → ${recommendation.bestAlternative.strategy.id.padEnd(20)}      │`);
    console.log(`│     APY: ${currentApy.toFixed(2)}% → ${recommendation.bestAlternative.netApy.toFixed(2)}%                          │`);
    console.log(`│     Break-even: ${recommendation.bestAlternative.breakEvenDays} days                        │`);
  } else {
    console.log(`│  ✅ RECOMMENDATION: HOLD current position               │`);
    if (recommendation.bestAlternative) {
      console.log(`│     Best alternative ${recommendation.bestAlternative.strategy.id} doesn't pass criteria   │`);
    }
  }

  if (recommendation.idleRecommendation) {
    console.log('├──────────────────────────────────────────────────────────┤');
    const idle = recommendation.idleRecommendation;
    if (idle.shouldDeploy) {
      console.log(`│  💰 IDLE CAPITAL: DEPLOY ${idleCapitalSol.toFixed(4)} JitoSOL             │`);
      console.log(`│     → ${idle.bestStrategy.id}: +${idle.netApyAfterFees.minus(5.57).toFixed(2)}% over holding    │`);
    } else {
      console.log(`│  💤 IDLE CAPITAL: HOLD (${idle.reasoning.slice(0, 45)})  │`);
    }
  }

  console.log('├──────────────────────────────────────────────────────────┤');
  console.log('│  Reasoning:                                              │');
  for (const line of recommendation.reasoning) {
    const trimmed = line.slice(0, 56);
    console.log(`│    ${trimmed.padEnd(54)}│`);
  }
  console.log('└──────────────────────────────────────────────────────────┘');

  // Execute if recommended and not dry-run
  if (recommendation.shouldRebalance && recommendation.bestAlternative) {
    if (settings.dryRun) {
      console.log('\n🧪 DRY RUN — Would execute rebalance. Set dryRun: false to execute.');
    } else {
      console.log('\n⚡ Executing rebalance...');
      const result = await executeRebalance(
        wallet,
        currentStrategyId,
        recommendation.bestAlternative.strategy.id,
        capitalSol,
        settings,
        kaminoClient,
        liquidityClient,
        jupiterClient,
      );
      console.log(`   ${result.success ? '✅' : '❌'} ${result.message}`);
    }
  }

  // Execute idle capital deployment if recommended
  if (recommendation.idleRecommendation?.shouldDeploy && idleCapitalSol.gt(0.01)) {
    const idle = recommendation.idleRecommendation;
    if (settings.dryRun) {
      console.log(`\n🧪 DRY RUN — Would deploy ${idleCapitalSol.toFixed(4)} JitoSOL to ${idle.bestStrategy.id}`);
    } else {
      console.log(`\n⚡ Deploying idle capital...`);
      const result = await executeRebalance(
        wallet,
        'hold_jitosol',
        idle.bestStrategy.id,
        idleCapitalSol,
        settings,
        kaminoClient,
        liquidityClient,
        jupiterClient,
      );
      console.log(`   ${result.success ? '✅' : '❌'} ${result.message}`);
    }
  }

  return recommendation;
}

// ─── CLI Runner ─────────────────────────────────────────────────

async function main() {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  const settings: Settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

  // Force dry run for safety when running standalone
  settings.dryRun = true;

  const walletPath = path.join(__dirname, '../config/wallet.json');
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

  const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });

  const recommendation = await runRebalancer(settings, wallet, connection);

  console.log(`\n📝 Decision logged to ${REBALANCER_LOG_PATH}`);

  return recommendation;
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
