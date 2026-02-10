#!/usr/bin/env ts-node
/**
 * Kamino Yield Optimizer — CLI Entry Point
 *
 * An autonomous AI-powered DeFi yield optimizer for Solana.
 * Manages capital across Kamino K-Lend, Multiply, LP Vaults,
 * and Jupiter swaps to maximize risk-adjusted returns.
 *
 * Usage:
 *   npx ts-node src/index.ts <command> [options]
 *
 * Commands:
 *   scan         — Scan live rates across all Kamino markets
 *   optimize     — Run full multi-strategy optimization cycle
 *   rebalance    — Evaluate and execute rebalance decisions
 *   portfolio    — Show current portfolio snapshot
 *   backtest     — Run historical performance analysis
 *   status       — Quick wallet + position status
 *   agent        — Run in autonomous agent mode (continuous)
 *
 * Options:
 *   --dry-run    — Simulate without executing (default: true)
 *   --live       — Execute real transactions (USE WITH CAUTION)
 *   --json       — Output in JSON format
 *   --verbose    — Show detailed logs
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

import { runScanner, fetchLiveJitoStakingApy } from './scanner';
import { runRebalancer, shouldRebalance, scoreStrategies, StrategyId } from './rebalancer';
import { KaminoClient } from './kamino-client';
import { MultiplyClient } from './multiply-client';
import { JupiterClient } from './jupiter-client';
import { LiquidityClient } from './liquidity-client';
import { PortfolioManager, PortfolioSnapshot } from './portfolio';
import { scanAllProtocols } from './multi-protocol-scanner';
import { Settings, TOKEN_MINTS, KAMINO_MARKETS } from './types';

// ─── Config ─────────────────────────────────────────────────────

const CONFIG_DIR = path.join(__dirname, '../config');

function loadSettings(): Settings {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'settings.json'), 'utf-8'));
}

function loadWallet(): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'wallet.json'), 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

// ─── Helpers ────────────────────────────────────────────────────

async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = (await res.json()) as any;
    return data.solana?.usd || 200;
  } catch {
    return 200;
  }
}

function printBanner(command: string) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          🔥 KAMINO YIELD OPTIMIZER — Autonomous DeFi        ║');
  console.log('║                 AI-Powered Yield Management                 ║');
  console.log(`║          Command: ${command.padEnd(41)}║`);
  console.log(`║          ${new Date().toISOString().padEnd(49)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
}

// ─── Commands ───────────────────────────────────────────────────

async function cmdScan(jsonOutput: boolean) {
  printBanner('scan');
  const result = await runScanner();

  if (jsonOutput) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      stakingApy: result.stakingApy,
      stakingApySource: result.stakingApySource,
      reserves: result.reserves.map(r => ({
        symbol: r.symbol,
        market: r.market,
        supplyApy: r.supplyApy,
        borrowApy: r.borrowApy,
        utilization: r.utilization,
      })),
      multiply: result.multiply.map(m => ({
        name: m.name,
        market: m.market,
        stakingApy: m.stakingApy,
        borrowCost: m.borrowCost,
        spread: m.spread,
        netApyAt3x: m.netApyAt3x,
      })),
    }, null, 2));
  }

  // Also scan cross-protocol
  console.log('\n📡 Cross-Protocol Comparison...\n');
  try {
    const crossProtocol = await scanAllProtocols();
    const top10 = crossProtocol
      .filter(y => y.apy > 0 && y.tvl > 100000)
      .slice(0, 10);

    console.log('┌──────────────┬────────────────────────────────┬────────┬────────────┬──────────┐');
    console.log('│  Protocol    │  Pool                          │  APY   │  TVL       │  Risk    │');
    console.log('├──────────────┼────────────────────────────────┼────────┼────────────┼──────────┤');
    for (const y of top10) {
      const proto = y.protocol.padEnd(12);
      const pool = y.pool.slice(0, 30).padEnd(30);
      const apy = (y.apy.toFixed(2) + '%').padStart(7);
      const tvl = ('$' + (y.tvl / 1e6).toFixed(1) + 'M').padStart(10);
      const risk = y.risk.padEnd(8);
      console.log(`│  ${proto}│  ${pool}│ ${apy}│ ${tvl}│  ${risk}│`);
    }
    console.log('└──────────────┴────────────────────────────────┴────────┴────────────┴──────────┘');
  } catch (err: any) {
    console.log(`   ⚠️  Cross-protocol scan failed: ${err.message}`);
  }
}

async function cmdOptimize(dryRun: boolean, jsonOutput: boolean) {
  printBanner(dryRun ? 'optimize (dry-run)' : 'optimize (LIVE)');

  const settings = loadSettings();
  settings.dryRun = dryRun;

  // Import and run the v2 optimizer
  const { runOptimizeV2 } = await import('./optimize-v2');
  await runOptimizeV2();
}

async function cmdRebalance(dryRun: boolean, jsonOutput: boolean) {
  printBanner(dryRun ? 'rebalance (dry-run)' : 'rebalance (LIVE)');

  const settings = loadSettings();
  settings.dryRun = dryRun;

  const wallet = loadWallet();
  const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });

  const recommendation = await runRebalancer(settings, wallet, connection);

  if (jsonOutput) {
    console.log('\n' + JSON.stringify({
      timestamp: recommendation.timestamp.toISOString(),
      shouldRebalance: recommendation.shouldRebalance,
      currentStrategy: recommendation.currentStrategy.id,
      bestAlternative: recommendation.bestAlternative?.strategy.id ?? null,
      breakEvenDays: recommendation.bestAlternative?.breakEvenDays ?? null,
      reasoning: recommendation.reasoning,
      strategies: recommendation.allStrategies.map(s => ({
        id: s.strategy.id,
        grossApy: s.grossApy.toFixed(2),
        netApy: s.netApy.toFixed(2),
        score: s.score.toFixed(4),
        breakEvenDays: s.breakEvenDays,
        switchCostSol: s.switchCost.totalCostSol.toFixed(6),
      })),
    }, null, 2));
  }
}

async function cmdPortfolio(jsonOutput: boolean) {
  printBanner('portfolio');

  const settings = loadSettings();
  const wallet = loadWallet();
  const solPrice = await getSolPrice();
  const solPriceDec = new Decimal(solPrice);

  const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });
  const kaminoClient = new KaminoClient(settings.rpcUrl);
  const multiplyClient = new MultiplyClient(settings.rpcUrl, settings.multiply);
  const liquidityClient = new LiquidityClient(settings.rpcUrl);

  await kaminoClient.initialize();

  const portfolioMgr = new PortfolioManager(
    connection,
    kaminoClient,
    multiplyClient,
    settings.portfolio,
    liquidityClient,
  );

  const snapshot = await portfolioMgr.getSnapshot(wallet.publicKey, solPriceDec);
  portfolioMgr.printSummary(snapshot);

  if (jsonOutput) {
    console.log('\n' + JSON.stringify({
      timestamp: new Date().toISOString(),
      totalValueUsd: snapshot.totalValueUsd.toFixed(2),
      blendedApy: snapshot.blendedApy.toFixed(2),
      solPrice,
      balances: {
        SOL: snapshot.balances.SOL.toFixed(6),
        USDC: snapshot.balances.USDC.toFixed(2),
        JitoSOL: snapshot.balances.JitoSOL.toFixed(6),
      },
      klendPositions: snapshot.klendPositions.length,
      multiplyPositions: snapshot.multiplyPositions.length,
      liquidityPositions: snapshot.liquidityPositions.length,
      allocations: snapshot.allocations.map(a => ({
        strategy: a.strategy,
        token: a.token,
        targetWeight: a.targetWeight,
        currentWeight: a.currentWeight,
        drift: a.drift,
        valueUsd: a.currentValueUsd.toFixed(2),
        apy: a.currentApy.toFixed(2),
      })),
    }, null, 2));
  }
}

async function cmdStatus(jsonOutput: boolean) {
  printBanner('status');

  const settings = loadSettings();
  const wallet = loadWallet();
  const solPrice = await getSolPrice();

  const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });
  const kaminoClient = new KaminoClient(settings.rpcUrl);

  // Quick balance check (minimal RPC calls)
  const solBalance = await connection.getBalance(wallet.publicKey);
  const solBalanceDec = new Decimal(solBalance).div(LAMPORTS_PER_SOL);

  let jitosolBalance = new Decimal(0);
  try {
    jitosolBalance = await kaminoClient.getTokenBalance(wallet.publicKey, TOKEN_MINTS.JitoSOL);
  } catch {}

  let usdcBalance = new Decimal(0);
  try {
    usdcBalance = await kaminoClient.getTokenBalance(wallet.publicKey, TOKEN_MINTS.USDC);
  } catch {}

  const totalUsd = solBalanceDec.mul(solPrice)
    .plus(jitosolBalance.mul(solPrice).mul(1.26)) // JitoSOL ≈ 1.26 SOL
    .plus(usdcBalance);

  // Fetch JitoSOL staking APY
  let stakingApy = 5.57;
  try {
    const liveApy = await fetchLiveJitoStakingApy();
    stakingApy = liveApy.apy;
  } catch {}

  // Read last performance log
  let lastAction = 'No history';
  try {
    const perfLog = fs.readFileSync(path.join(CONFIG_DIR, 'performance.jsonl'), 'utf-8');
    const lines = perfLog.trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    lastAction = `${last.timestamp} — ${last.action}`;
  } catch {}

  console.log('┌──────────────────────────────────────────────────────────┐');
  console.log('│                    💼 WALLET STATUS                      │');
  console.log('├──────────────────────────────────────────────────────────┤');
  console.log(`│  Address:    ${wallet.publicKey.toBase58().slice(0, 20)}...          │`);
  console.log(`│  SOL:        ${solBalanceDec.toFixed(6).padEnd(12)} ($${solBalanceDec.mul(solPrice).toFixed(2).padEnd(8)})     │`);
  console.log(`│  JitoSOL:    ${jitosolBalance.toFixed(6).padEnd(12)} ($${jitosolBalance.mul(solPrice).mul(1.26).toFixed(2).padEnd(8)})     │`);
  console.log(`│  USDC:       ${usdcBalance.toFixed(2).padEnd(12)} ($${usdcBalance.toFixed(2).padEnd(8)})     │`);
  console.log(`│  Total:      $${totalUsd.toFixed(2).padEnd(46)}│`);
  console.log(`│  Staking:    ${stakingApy.toFixed(2)}% APY (JitoSOL)                     │`);
  console.log('├──────────────────────────────────────────────────────────┤');
  console.log(`│  Last:       ${lastAction.slice(0, 44).padEnd(44)}│`);
  console.log('└──────────────────────────────────────────────────────────┘');

  if (jsonOutput) {
    console.log('\n' + JSON.stringify({
      wallet: wallet.publicKey.toBase58(),
      balances: {
        SOL: solBalanceDec.toFixed(6),
        JitoSOL: jitosolBalance.toFixed(6),
        USDC: usdcBalance.toFixed(2),
      },
      totalUsd: totalUsd.toFixed(2),
      solPrice,
      stakingApy,
      lastAction,
    }, null, 2));
  }
}

async function cmdBacktest(jsonOutput: boolean) {
  printBanner('backtest');

  // Load historical performance data
  const perfPath = path.join(CONFIG_DIR, 'performance.jsonl');
  const rebalancerPath = path.join(CONFIG_DIR, 'rebalancer-log.jsonl');

  let perfEntries: any[] = [];
  let rebalancerEntries: any[] = [];

  try {
    const perfData = fs.readFileSync(perfPath, 'utf-8');
    perfEntries = perfData.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {}

  try {
    const rebalData = fs.readFileSync(rebalancerPath, 'utf-8');
    rebalancerEntries = rebalData.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {}

  console.log(`📊 Performance history: ${perfEntries.length} entries`);
  console.log(`⚖️  Rebalancer decisions: ${rebalancerEntries.length} entries`);

  if (perfEntries.length === 0) {
    console.log('\n   No performance data yet. Run `optimize` or `rebalance` to start tracking.');
    return;
  }

  // Analyze performance
  const first = perfEntries[0];
  const last = perfEntries[perfEntries.length - 1];
  const startValue = parseFloat(first.totalValueUsd);
  const endValue = parseFloat(last.totalValueUsd);
  const pnl = endValue - startValue;
  const pnlPct = startValue > 0 ? ((pnl / startValue) * 100) : 0;

  const startDate = new Date(first.timestamp);
  const endDate = new Date(last.timestamp);
  const daysDiff = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
  const annualizedReturn = daysDiff > 0 ? (pnlPct * 365 / daysDiff) : 0;

  // Count actions
  const actionCount = perfEntries.filter(e => e.action !== 'No action').length;
  const rebalanceCount = rebalancerEntries.filter(e => e.shouldRebalance).length;

  // APY distribution
  const apys = perfEntries.map(e => parseFloat(e.blendedApy)).filter(a => !isNaN(a) && a > 0);
  const avgApy = apys.length > 0 ? apys.reduce((a, b) => a + b, 0) / apys.length : 0;
  const maxApy = apys.length > 0 ? Math.max(...apys) : 0;
  const minApy = apys.length > 0 ? Math.min(...apys) : 0;

  console.log('\n┌──────────────────────────────────────────────────────────┐');
  console.log('│              📈 PERFORMANCE ANALYSIS                     │');
  console.log('├──────────────────────────────────────────────────────────┤');
  console.log(`│  Period:        ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0].padEnd(16)}    │`);
  console.log(`│  Duration:      ${daysDiff.toFixed(1)} days                               │`);
  console.log(`│  Start Value:   $${startValue.toFixed(2).padEnd(40)}│`);
  console.log(`│  End Value:     $${endValue.toFixed(2).padEnd(40)}│`);
  console.log(`│  P&L:           $${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)                     │`);
  console.log(`│  Annualized:    ${annualizedReturn >= 0 ? '+' : ''}${annualizedReturn.toFixed(2)}%                                │`);
  console.log('├──────────────────────────────────────────────────────────┤');
  console.log(`│  Avg APY:       ${avgApy.toFixed(2)}%                                 │`);
  console.log(`│  Max APY:       ${maxApy.toFixed(2)}%                                 │`);
  console.log(`│  Min APY:       ${minApy.toFixed(2)}%                                 │`);
  console.log(`│  Actions:       ${actionCount} / ${perfEntries.length} cycles                        │`);
  console.log(`│  Rebalances:    ${rebalanceCount} recommended                          │`);
  console.log('└──────────────────────────────────────────────────────────┘');

  if (jsonOutput) {
    console.log('\n' + JSON.stringify({
      period: { start: first.timestamp, end: last.timestamp, days: daysDiff },
      performance: { startValue, endValue, pnl, pnlPct, annualizedReturn },
      apy: { avg: avgApy, max: maxApy, min: minApy },
      activity: { totalCycles: perfEntries.length, actionsTaken: actionCount, rebalancesRecommended: rebalanceCount },
    }, null, 2));
  }
}

async function cmdAgent(dryRun: boolean, verbose: boolean) {
  printBanner('agent (autonomous mode)');

  console.log('🤖 Starting autonomous agent mode...');
  console.log('   The agent will continuously monitor and optimize yields.');
  console.log(`   Mode: ${dryRun ? 'DRY RUN (simulation only)' : '⚡ LIVE (real transactions)'}`);
  console.log('   Cycle interval: 30 minutes');
  console.log('   Press Ctrl+C to stop.\n');

  const CYCLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  let cycleCount = 0;

  const runCycle = async () => {
    cycleCount++;
    const cycleStart = Date.now();
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🔄 AGENT CYCLE #${cycleCount} — ${new Date().toISOString()}`);
    console.log(`${'═'.repeat(60)}\n`);

    const settings = loadSettings();
    settings.dryRun = dryRun;

    try {
      // Step 1: Scan rates
      console.log('📡 Step 1: Scanning rates...');
      await runScanner();

      // Step 2: Run rebalancer
      console.log('\n⚖️  Step 2: Evaluating positions...');
      const wallet = loadWallet();
      const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });
      const recommendation = await runRebalancer(settings, wallet, connection);

      // Step 3: Log decision
      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      console.log(`\n✅ Cycle #${cycleCount} complete in ${elapsed}s`);
      console.log(`   Decision: ${recommendation.shouldRebalance ? '🔄 REBALANCE' : '✅ HOLD'}`);
      console.log(`   Next cycle in ${CYCLE_INTERVAL_MS / 60000} minutes\n`);

    } catch (err: any) {
      console.error(`❌ Cycle #${cycleCount} failed: ${err.message}`);
      if (verbose) console.error(err.stack);
    }
  };

  // Run first cycle immediately
  await runCycle();

  // Schedule subsequent cycles
  const interval = setInterval(runCycle, CYCLE_INTERVAL_MS);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Agent shutting down gracefully...');
    clearInterval(interval);
    console.log(`   Completed ${cycleCount} cycles.`);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {}); // never resolves
}

// ─── CLI Parser ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const flags = new Set(args.slice(1));

  const dryRun = !flags.has('--live');
  const jsonOutput = flags.has('--json');
  const verbose = flags.has('--verbose');

  switch (command) {
    case 'scan':
      await cmdScan(jsonOutput);
      break;

    case 'optimize':
      await cmdOptimize(dryRun, jsonOutput);
      break;

    case 'rebalance':
      await cmdRebalance(dryRun, jsonOutput);
      break;

    case 'portfolio':
      await cmdPortfolio(jsonOutput);
      break;

    case 'status':
      await cmdStatus(jsonOutput);
      break;

    case 'backtest':
      await cmdBacktest(jsonOutput);
      break;

    case 'agent':
      await cmdAgent(dryRun, verbose);
      break;

    case 'help':
    default:
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║          🔥 KAMINO YIELD OPTIMIZER — Autonomous DeFi        ║
║                 AI-Powered Yield Management                 ║
╚══════════════════════════════════════════════════════════════╝

Usage: npx ts-node src/index.ts <command> [options]

Commands:
  scan         Scan live rates across all Kamino markets & protocols
  optimize     Run full multi-strategy optimization cycle
  rebalance    Evaluate positions & execute rebalance decisions
  portfolio    Show current portfolio snapshot with allocations
  status       Quick wallet balance & position status
  backtest     Analyze historical performance & P&L
  agent        Run in autonomous mode (continuous monitoring)

Options:
  --dry-run    Simulate without executing (default)
  --live       Execute real transactions (USE WITH CAUTION)
  --json       Output structured JSON
  --verbose    Show detailed logs

Examples:
  npx ts-node src/index.ts scan                   # Scan all rates
  npx ts-node src/index.ts optimize --live         # Run optimizer with real txs
  npx ts-node src/index.ts rebalance --json        # Evaluate rebalance (JSON)
  npx ts-node src/index.ts agent                   # Run autonomous agent
  npx ts-node src/index.ts backtest                # Performance analysis

Architecture:
  ┌─────────────────────────────────────────────────┐
  │              AUTONOMOUS AGENT                    │
  │  ┌───────────┐  ┌───────────┐  ┌────────────┐  │
  │  │  Scanner   │  │ Portfolio  │  │ Rebalancer │  │
  │  │  (rates)   │  │ (tracking) │  │ (decisions)│  │
  │  └─────┬─────┘  └─────┬─────┘  └─────┬──────┘  │
  │        │              │              │           │
  │  ┌─────┴──────────────┴──────────────┴──────┐   │
  │  │            Strategy Executor              │   │
  │  ├──────────┬────────────┬─────────────────┤   │
  │  │ K-Lend   │  Multiply  │   LP Vaults     │   │
  │  │ (supply) │ (leverage) │ (concentrated)  │   │
  │  └──────────┴────────────┴─────────────────┘   │
  │        │                                        │
  │  ┌─────┴─────────────────────────────────────┐  │
  │  │     Jupiter V6 (swaps + routing)          │  │
  │  └───────────────────────────────────────────┘  │
  │        │                                        │
  │  ┌─────┴─────────────────────────────────────┐  │
  │  │     Solana Blockchain (mainnet-beta)      │  │
  │  └───────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────┘

Safety:
  • Gas buffer: always maintains 0.01 SOL for fees
  • Break-even: only rebalances if payback < 7 days
  • Spike protection: yield must sustain > 1 hour
  • Dry-run by default: no real transactions without --live
  • Full fee accounting: tx fees, slippage, IL, opportunity cost
`);
      break;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err.message || err);
    process.exit(1);
  });
