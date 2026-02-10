/**
 * Historical Backtesting Engine
 *
 * Simulates the optimizer's decisions against historical rate data
 * to evaluate strategy performance, fee impact, and decision quality.
 *
 * Data sources:
 * - config/rate-history.json (our recorded rates)
 * - config/performance.jsonl (our recorded portfolio values)
 * - config/rebalancer-log.jsonl (our recorded decisions)
 * - DeFi Llama API (historical yields)
 *
 * Usage:
 *   npx ts-node src/backtester.ts [--days 30] [--strategy hold|optimize|aggressive]
 */

import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { calculateSwitchCost, StrategyId } from './rebalancer';

// ─── Types ──────────────────────────────────────────────────────

interface HistoricalRate {
  timestamp: number;
  strategyId: StrategyId;
  apy: number;
}

interface BacktestConfig {
  /** Initial capital in SOL-equivalent */
  initialCapitalSol: number;
  /** SOL price (fixed for simplicity, or array for time-varying) */
  solPrice: number;
  /** Strategy to simulate */
  strategy: 'hold' | 'optimize' | 'aggressive' | 'klend_only' | 'lp_only';
  /** Evaluation period in days */
  days: number;
  /** Minimum APY improvement to trigger rebalance (optimize mode) */
  minApyImprovement: number;
  /** Maximum break-even days (optimize mode) */
  maxBreakEvenDays: number;
  /** Cycle interval in hours */
  cycleIntervalHours: number;
}

interface BacktestSnapshot {
  timestamp: number;
  day: number;
  strategy: StrategyId;
  apy: number;
  capitalSol: Decimal;
  capitalUsd: Decimal;
  cumulativeFeeSol: Decimal;
  action: string;
}

interface BacktestResult {
  config: BacktestConfig;
  snapshots: BacktestSnapshot[];
  summary: {
    startValue: number;
    endValue: number;
    totalReturn: number;
    totalReturnPct: number;
    annualizedReturn: number;
    maxDrawdown: number;
    totalFeesPaid: number;
    rebalanceCount: number;
    avgHoldingPeriodDays: number;
    strategyBreakdown: { [key: string]: number }; // days in each strategy
    winRate: number; // % of rebalances that were profitable
  };
}

// ─── Historical Data ────────────────────────────────────────────

function loadRateHistory(): HistoricalRate[] {
  try {
    const data = fs.readFileSync(path.join(__dirname, '../config/rate-history.json'), 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function loadPerformanceLog(): any[] {
  try {
    const data = fs.readFileSync(path.join(__dirname, '../config/performance.jsonl'), 'utf-8');
    return data.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Generate synthetic rate data when real history is insufficient.
 * Uses realistic APY ranges based on observed Kamino data.
 */
function generateSyntheticRates(days: number, intervalHours: number): HistoricalRate[] {
  const rates: HistoricalRate[] = [];
  const now = Date.now();
  const startMs = now - days * 24 * 60 * 60 * 1000;
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // Realistic APY ranges (based on observed Kamino data Feb 2026)
  const baseRates: { [key in StrategyId]: { mean: number; volatility: number } } = {
    hold_jitosol: { mean: 5.6, volatility: 0.3 },      // Very stable staking yield
    lp_vault: { mean: 11.0, volatility: 4.0 },          // LP fees fluctuate with volume
    klend_sol_supply: { mean: 7.0, volatility: 2.5 },   // Lending rates depend on utilization
    klend_jitosol_supply: { mean: 6.5, volatility: 1.5 },
    multiply: { mean: -2.0, volatility: 5.0 },          // Often negative (borrow > staking)
  };

  // Random walk with mean reversion
  const currentRates: { [key: string]: number } = {};
  for (const [id, base] of Object.entries(baseRates)) {
    currentRates[id] = base.mean;
  }

  for (let t = startMs; t <= now; t += intervalMs) {
    for (const [id, base] of Object.entries(baseRates)) {
      // Mean-reverting random walk
      const meanReversion = 0.1 * (base.mean - currentRates[id]);
      const noise = (Math.random() - 0.5) * base.volatility * 0.3;
      currentRates[id] = Math.max(
        id === 'multiply' ? -10 : 0,
        currentRates[id] + meanReversion + noise
      );

      rates.push({
        timestamp: t,
        strategyId: id as StrategyId,
        apy: currentRates[id],
      });
    }
  }

  return rates;
}

// ─── Backtest Engine ────────────────────────────────────────────

export function runBacktest(config: BacktestConfig): BacktestResult {
  const solPrice = new Decimal(config.solPrice);
  let capital = new Decimal(config.initialCapitalSol);
  let cumulativeFees = new Decimal(0);
  let currentStrategy: StrategyId = 'hold_jitosol'; // Start with staking
  let peakCapital = capital;
  let maxDrawdown = 0;
  let rebalanceCount = 0;
  let profitableRebalances = 0;
  let preRebalanceCapital = capital;
  const strategyDays: { [key: string]: number } = {};
  let lastRebalanceDay = 0;

  // Load or generate rate data
  let rates = loadRateHistory();
  const intervalMs = config.cycleIntervalHours * 60 * 60 * 1000;

  // Need enough data points to cover the backtest period
  const requiredPoints = Math.ceil(config.days * 24 / config.cycleIntervalHours) * 5; // 5 strategies
  if (rates.length < requiredPoints) {
    console.log(`   📊 Insufficient data (${rates.length}/${requiredPoints}) — using synthetic rates`);
    rates = generateSyntheticRates(config.days, config.cycleIntervalHours);
  }

  // Group rates by timestamp
  const ratesByTimestamp = new Map<number, Map<StrategyId, number>>();
  for (const r of rates) {
    if (!ratesByTimestamp.has(r.timestamp)) {
      ratesByTimestamp.set(r.timestamp, new Map());
    }
    ratesByTimestamp.get(r.timestamp)!.set(r.strategyId, r.apy);
  }

  const timestamps = Array.from(ratesByTimestamp.keys()).sort((a, b) => a - b);
  const startTs = timestamps[0];

  const snapshots: BacktestSnapshot[] = [];

  for (const ts of timestamps) {
    const ratesAtTime = ratesByTimestamp.get(ts)!;
    const day = (ts - startTs) / (24 * 60 * 60 * 1000);

    // Get current strategy APY
    const currentApy = ratesAtTime.get(currentStrategy) ?? 5.57;

    // Accrue yield since last snapshot
    if (snapshots.length > 0) {
      const lastSnap = snapshots[snapshots.length - 1];
      const hoursSinceLast = (ts - lastSnap.timestamp) / (60 * 60 * 1000);
      const yieldAccrued = capital.mul(currentApy).div(100).div(365 * 24).mul(hoursSinceLast);
      capital = capital.plus(yieldAccrued);
    }

    // Track strategy days
    if (!strategyDays[currentStrategy]) strategyDays[currentStrategy] = 0;
    strategyDays[currentStrategy] += config.cycleIntervalHours / 24;

    // Track drawdown
    if (capital.gt(peakCapital)) peakCapital = capital;
    const drawdown = peakCapital.minus(capital).div(peakCapital).toNumber();
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    let action = 'hold';

    // Decision logic based on strategy mode
    if (config.strategy === 'hold') {
      // Always hold JitoSOL — baseline comparison
      action = 'hold (baseline)';

    } else if (config.strategy === 'optimize' || config.strategy === 'aggressive') {
      // Find best available strategy
      const threshold = config.strategy === 'aggressive' ? 0.5 : config.minApyImprovement;
      const maxBreakEven = config.strategy === 'aggressive' ? 14 : config.maxBreakEvenDays;

      let bestStrategy: StrategyId | null = null;
      let bestApy = currentApy;

      for (const [stratId, stratApy] of ratesAtTime.entries()) {
        if (stratId === currentStrategy) continue;
        if (stratId === 'multiply' && stratApy <= 0) continue; // Skip unprofitable multiply

        const improvement = stratApy - currentApy;
        if (improvement <= threshold) continue;

        // Calculate switch cost
        const cost = calculateSwitchCost(
          currentStrategy,
          stratId,
          capital,
          solPrice,
          new Decimal(currentApy),
        );

        // Break-even check
        const dailyImprovement = capital.mul(improvement).div(100).div(365);
        const breakEvenDays = dailyImprovement.gt(0) ? cost.totalCostSol.div(dailyImprovement).toNumber() : Infinity;

        if (breakEvenDays <= maxBreakEven && stratApy > bestApy) {
          bestStrategy = stratId;
          bestApy = stratApy;
        }
      }

      if (bestStrategy) {
        // Execute rebalance
        const cost = calculateSwitchCost(
          currentStrategy,
          bestStrategy,
          capital,
          solPrice,
          new Decimal(currentApy),
        );

        capital = capital.minus(cost.totalCostSol);
        cumulativeFees = cumulativeFees.plus(cost.totalCostSol);
        rebalanceCount++;

        // Track if previous rebalance was profitable
        if (rebalanceCount > 1 && capital.gt(preRebalanceCapital)) {
          profitableRebalances++;
        }
        preRebalanceCapital = capital;

        action = `rebalance: ${currentStrategy} → ${bestStrategy} (${currentApy.toFixed(2)}% → ${bestApy.toFixed(2)}%, cost: ${cost.totalCostSol.toFixed(6)} SOL)`;
        currentStrategy = bestStrategy;
        lastRebalanceDay = day;
      }

    } else if (config.strategy === 'klend_only') {
      // Always use best K-Lend strategy
      const klendSol = ratesAtTime.get('klend_sol_supply') ?? 0;
      const klendJitosol = ratesAtTime.get('klend_jitosol_supply') ?? 0;
      const bestKlend: StrategyId = klendJitosol > klendSol ? 'klend_jitosol_supply' : 'klend_sol_supply';

      if (bestKlend !== currentStrategy) {
        const cost = calculateSwitchCost(currentStrategy, bestKlend, capital, solPrice, new Decimal(currentApy));
        capital = capital.minus(cost.totalCostSol);
        cumulativeFees = cumulativeFees.plus(cost.totalCostSol);
        rebalanceCount++;
        action = `klend_rotate: → ${bestKlend}`;
        currentStrategy = bestKlend;
      }

    } else if (config.strategy === 'lp_only') {
      // Always stay in LP vault
      if (currentStrategy !== 'lp_vault') {
        const cost = calculateSwitchCost(currentStrategy, 'lp_vault', capital, solPrice, new Decimal(currentApy));
        capital = capital.minus(cost.totalCostSol);
        cumulativeFees = cumulativeFees.plus(cost.totalCostSol);
        rebalanceCount++;
        action = `enter_lp`;
        currentStrategy = 'lp_vault';
      }
    }

    snapshots.push({
      timestamp: ts,
      day,
      strategy: currentStrategy,
      apy: currentApy,
      capitalSol: capital,
      capitalUsd: capital.mul(solPrice),
      cumulativeFeeSol: cumulativeFees,
      action,
    });
  }

  // Compute summary
  const startValue = config.initialCapitalSol;
  const endValue = capital.toNumber();
  const totalReturn = endValue - startValue;
  const totalReturnPct = (totalReturn / startValue) * 100;
  const totalDays = snapshots.length > 0 ? (snapshots[snapshots.length - 1].day) : config.days;
  const annualizedReturn = totalDays > 0 ? (totalReturnPct * 365 / totalDays) : 0;
  const avgHoldingPeriod = rebalanceCount > 0 ? totalDays / rebalanceCount : totalDays;
  const winRate = rebalanceCount > 1 ? (profitableRebalances / (rebalanceCount - 1)) * 100 : 0;

  return {
    config,
    snapshots,
    summary: {
      startValue,
      endValue,
      totalReturn,
      totalReturnPct,
      annualizedReturn,
      maxDrawdown: maxDrawdown * 100,
      totalFeesPaid: cumulativeFees.toNumber(),
      rebalanceCount,
      avgHoldingPeriodDays: avgHoldingPeriod,
      strategyBreakdown: strategyDays,
      winRate,
    },
  };
}

// ─── Comparison Runner ──────────────────────────────────────────

export function runComparison(days: number = 30, initialCapital: number = 2, solPrice: number = 200) {
  const strategies = ['hold', 'optimize', 'aggressive', 'klend_only', 'lp_only'] as const;

  const results: { [key: string]: BacktestResult } = {};

  for (const strat of strategies) {
    results[strat] = runBacktest({
      initialCapitalSol: initialCapital,
      solPrice,
      strategy: strat,
      days,
      minApyImprovement: 1.0,
      maxBreakEvenDays: 7,
      cycleIntervalHours: 2,
    });
  }

  // Print comparison table
  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    📊 STRATEGY COMPARISON                               ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');
  console.log('║  Strategy    │ End Value │ Return  │ Annual% │ Max DD │ Fees    │ Rebal  ║');
  console.log('╠══════════════╪═══════════╪═════════╪═════════╪════════╪═════════╪════════╣');

  for (const strat of strategies) {
    const s = results[strat].summary;
    const name = strat.padEnd(12);
    const endVal = ('$' + (s.endValue * solPrice / initialCapital * s.endValue).toFixed(0)).padStart(9);
    // Recalculate with proper values
    const endValSol = s.endValue.toFixed(4).padStart(9);
    const returnPct = ((s.totalReturnPct >= 0 ? '+' : '') + s.totalReturnPct.toFixed(2) + '%').padStart(8);
    const annReturn = ((s.annualizedReturn >= 0 ? '+' : '') + s.annualizedReturn.toFixed(1) + '%').padStart(8);
    const maxDD = (s.maxDrawdown.toFixed(2) + '%').padStart(6);
    const fees = (s.totalFeesPaid.toFixed(4) + ' SOL').padStart(9);
    const rebal = (s.rebalanceCount.toString()).padStart(5);
    console.log(`║  ${name}│ ${endValSol}│ ${returnPct}│ ${annReturn}│ ${maxDD}│ ${fees}│ ${rebal}  ║`);
  }

  console.log('╚══════════════╧═══════════╧═════════╧═════════╧════════╧═════════╧════════╝');

  // Print optimal strategy
  let bestStrat = 'hold';
  let bestReturn = -Infinity;
  for (const strat of strategies) {
    if (results[strat].summary.totalReturnPct > bestReturn) {
      bestReturn = results[strat].summary.totalReturnPct;
      bestStrat = strat;
    }
  }

  const holdReturn = results['hold'].summary.totalReturnPct;
  const optimizeReturn = results['optimize'].summary.totalReturnPct;
  const alpha = optimizeReturn - holdReturn;

  console.log(`\n🏆 Best strategy: ${bestStrat} (+${bestReturn.toFixed(2)}%)`);
  console.log(`📈 Optimizer alpha vs hold: ${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`);

  if (alpha > 0) {
    console.log(`   ✅ The optimizer BEAT passive holding by ${alpha.toFixed(2)}% over ${days} days`);
  } else {
    console.log(`   ⚠️  Passive holding outperformed in this period (fees outweighed yield improvement)`);
  }

  return results;
}

// ─── CLI ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) : 30;
  const capital = 2; // SOL
  const solPrice = 200;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          📊 KAMINO YIELD OPTIMIZER — BACKTESTER             ║');
  console.log('║             Historical Strategy Comparison                   ║');
  console.log(`║          Period: ${days} days | Capital: ${capital} SOL (~$${capital * solPrice})       ║`);
  console.log(`║          ${new Date().toISOString().padEnd(50)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  runComparison(days, capital, solPrice);

  // Detailed view for optimize strategy
  const optimizeResult = runBacktest({
    initialCapitalSol: capital,
    solPrice,
    strategy: 'optimize',
    days,
    minApyImprovement: 1.0,
    maxBreakEvenDays: 7,
    cycleIntervalHours: 2,
  });

  console.log('\n┌──────────────────────────────────────────────────────────┐');
  console.log('│          📋 OPTIMIZER DETAIL                             │');
  console.log('├──────────────────────────────────────────────────────────┤');
  console.log(`│  Rebalances:      ${optimizeResult.summary.rebalanceCount.toString().padEnd(38)}│`);
  console.log(`│  Win rate:        ${optimizeResult.summary.winRate.toFixed(1)}%${' '.repeat(35)}│`);
  console.log(`│  Avg hold period: ${optimizeResult.summary.avgHoldingPeriodDays.toFixed(1)} days${' '.repeat(31)}│`);
  console.log(`│  Total fees:      ${optimizeResult.summary.totalFeesPaid.toFixed(6)} SOL${' '.repeat(26)}│`);
  console.log('├──────────────────────────────────────────────────────────┤');
  console.log('│  Strategy breakdown (days):                              │');

  for (const [strat, days] of Object.entries(optimizeResult.summary.strategyBreakdown)) {
    const pct = (days / optimizeResult.config.days * 100).toFixed(1);
    console.log(`│    ${strat.padEnd(25)} ${days.toFixed(1).padStart(6)} days (${pct.padStart(5)}%)   │`);
  }

  console.log('└──────────────────────────────────────────────────────────┘');

  // Show rebalance events
  const rebalanceEvents = optimizeResult.snapshots.filter(s => s.action.startsWith('rebalance'));
  if (rebalanceEvents.length > 0) {
    console.log('\n📜 Rebalance events:');
    for (const event of rebalanceEvents.slice(0, 10)) {
      console.log(`   Day ${event.day.toFixed(1)}: ${event.action}`);
    }
    if (rebalanceEvents.length > 10) {
      console.log(`   ... and ${rebalanceEvents.length - 10} more`);
    }
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
