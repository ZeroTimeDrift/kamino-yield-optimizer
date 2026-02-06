/**
 * Kamino Yield Optimizer - Cron Entry Point
 *
 * Runs every 2h (or when triggered by rate-watcher).
 * Integrates the auto-rebalancer for intelligent fee-aware decisions.
 * Includes yield tracking, range monitoring, rewards tracking, and gas checks.
 *
 * Flow:
 * 1. Gas reserve check — abort non-essential ops if SOL too low
 * 2. Yield tracker snapshot
 * 3. Range monitor — check LP positions are in range
 * 4. Run rebalancer (full fee accounting, strategy comparison)
 * 5. Rewards tracker (every ~8h, not every run)
 * 6. Log clean summary
 *
 * Error isolation: each module runs in its own try/catch.
 * One module failing does NOT kill the whole cron.
 */

import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { runRebalancer } from './rebalancer';
import { createYieldTracker } from './yield-tracker';
import { createRangeMonitor, RangeAlert } from './range-monitor';
import { createRewardsTracker } from './rewards-tracker';

// ─── Config ──────────────────────────────────────────────────────
const MIN_SOL_BALANCE = 0.003; // Minimum SOL for gas; below this, skip non-essential ops
const REWARDS_INTERVAL_HOURS = 8; // Only run rewards tracker every ~8h
const LAST_REWARDS_FILE = path.join(__dirname, '../config/last-rewards-run.txt');

// ─── Types ───────────────────────────────────────────────────────
interface ModuleResult {
  name: string;
  status: 'ok' | 'skipped' | 'failed';
  message: string;
  durationMs: number;
}

interface CronSummary {
  timestamp: string;
  solBalance: string;
  gasOk: boolean;
  modules: ModuleResult[];
  totalDurationMs: number;
}

// ─── Helpers ─────────────────────────────────────────────────────

async function loadSettings() {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
}

async function loadWallet(): Promise<Keypair> {
  const walletPath = path.join(__dirname, '../config/wallet.json');
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function logSummary(summary: CronSummary) {
  const logPath = path.join(__dirname, '../config/cron-summary.jsonl');
  fs.appendFileSync(logPath, JSON.stringify(summary) + '\n');
}

function shouldRunRewards(): boolean {
  try {
    if (!fs.existsSync(LAST_REWARDS_FILE)) return true;
    const lastRun = parseInt(fs.readFileSync(LAST_REWARDS_FILE, 'utf-8').trim(), 10);
    const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
    return hoursSince >= REWARDS_INTERVAL_HOURS;
  } catch {
    return true;
  }
}

function markRewardsRun() {
  fs.writeFileSync(LAST_REWARDS_FILE, String(Date.now()));
}

async function runModule(
  name: string,
  fn: () => Promise<string>,
): Promise<ModuleResult> {
  const start = Date.now();
  try {
    const message = await fn();
    return { name, status: 'ok', message, durationMs: Date.now() - start };
  } catch (err: any) {
    const message = err.message?.slice(0, 120) || 'Unknown error';
    console.error(`   ❌ ${name} failed: ${message}`);
    return { name, status: 'failed', message, durationMs: Date.now() - start };
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🚀 KAMINO YIELD OPTIMIZER — CRON');
  console.log(`     ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const settings = await loadSettings();
  const wallet = await loadWallet();
  const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });

  const modules: ModuleResult[] = [];

  // ─── Step 0: Gas Reserve Check ──────────────────────────────
  console.log('⛽ Checking gas reserve...');
  const solLamports = await connection.getBalance(wallet.publicKey);
  const solBalance = new Decimal(solLamports).div(LAMPORTS_PER_SOL);
  const gasOk = solBalance.gte(MIN_SOL_BALANCE);

  console.log(`   SOL balance: ${solBalance.toFixed(6)} SOL`);
  if (!gasOk) {
    console.log(`   ⚠️  SOL balance ${solBalance.toFixed(6)} < ${MIN_SOL_BALANCE} SOL minimum!`);
    console.log(`   ⚠️  Skipping non-essential operations to preserve gas.`);
    modules.push({
      name: 'gas-check',
      status: 'failed',
      message: `SOL balance ${solBalance.toFixed(6)} below ${MIN_SOL_BALANCE} minimum`,
      durationMs: 0,
    });
  } else {
    console.log(`   ✅ Gas reserve OK`);
    modules.push({
      name: 'gas-check',
      status: 'ok',
      message: `${solBalance.toFixed(6)} SOL`,
      durationMs: 0,
    });
  }
  console.log('');

  // ─── Step 1: Yield Tracker Snapshot ─────────────────────────
  console.log('📊 Running yield tracker...');
  const yieldResult = await runModule('yield-tracker', async () => {
    const yieldTracker = createYieldTracker(connection, wallet, settings);
    const snapshot = await yieldTracker.captureSnapshot();
    return `Portfolio: ${snapshot.portfolioTotalValueSol} SOL ($${snapshot.portfolioTotalValueUsd})`;
  });
  modules.push(yieldResult);
  console.log(`   ${yieldResult.status === 'ok' ? '✅' : '❌'} ${yieldResult.message}`);
  console.log('');

  // ─── Step 2: Range Monitor ──────────────────────────────────
  console.log('📡 Running range monitor...');
  let rangeAlerts: RangeAlert[] = [];
  const rangeResult = await runModule('range-monitor', async () => {
    const rangeMonitor = createRangeMonitor(connection, wallet, settings);
    rangeAlerts = await rangeMonitor.monitorPositions();
    if (rangeAlerts.length > 0) {
      const urgent = rangeAlerts.filter(a => a.type === 'OUT_OF_RANGE');
      if (urgent.length > 0) {
        return `🚨 ${urgent.length} OUT OF RANGE alert(s)! ${rangeAlerts.length} total alert(s)`;
      }
      return `⚠️ ${rangeAlerts.length} range alert(s)`;
    }
    return 'All LP positions in range';
  });
  modules.push(rangeResult);
  console.log(`   ${rangeResult.status === 'ok' ? '✅' : '❌'} ${rangeResult.message}`);
  console.log('');

  // ─── Step 3: Rebalancer ─────────────────────────────────────
  // Skip if gas is critically low (rebalancing costs tx fees)
  if (gasOk) {
    console.log('🔄 Running auto-rebalancer...');
    const rebalancerResult = await runModule('rebalancer', async () => {
      const result = await runRebalancer(settings, wallet, connection);
      const verdict = result.shouldRebalance ? '🔄 REBALANCE' : '✅ HOLD';
      const idle = result.idleRecommendation?.shouldDeploy ? ' | Idle: DEPLOY' : '';
      return `${verdict}${idle}`;
    });
    modules.push(rebalancerResult);
    console.log(`   ${rebalancerResult.status === 'ok' ? '✅' : '❌'} ${rebalancerResult.message}`);
  } else {
    modules.push({
      name: 'rebalancer',
      status: 'skipped',
      message: 'Skipped — insufficient gas reserve',
      durationMs: 0,
    });
    console.log('🔄 Rebalancer: SKIPPED (low gas)');
  }
  console.log('');

  // ─── Step 4: Rewards Tracker (every ~8h) ────────────────────
  if (shouldRunRewards()) {
    console.log('🎁 Running rewards tracker...');
    const rewardsResult = await runModule('rewards-tracker', async () => {
      const rewardsTracker = createRewardsTracker(connection, wallet, settings);
      const snapshot = await rewardsTracker.captureSnapshot();
      markRewardsRun();
      const kPts = snapshot.kaminoPoints?.totalPoints || '0';
      const jPts = snapshot.jitoPoints?.totalPoints || '0';
      return `Kamino=${kPts} pts, Jito=${jPts} pts`;
    });
    modules.push(rewardsResult);
    console.log(`   ${rewardsResult.status === 'ok' ? '✅' : '❌'} ${rewardsResult.message}`);
  } else {
    modules.push({
      name: 'rewards-tracker',
      status: 'skipped',
      message: 'Skipped — not due yet (runs every ~8h)',
      durationMs: 0,
    });
    console.log('🎁 Rewards tracker: SKIPPED (not due yet)');
  }
  console.log('');

  // ─── Summary ────────────────────────────────────────────────
  const totalDurationMs = Date.now() - startTime;
  const summary: CronSummary = {
    timestamp: new Date().toISOString(),
    solBalance: solBalance.toFixed(6),
    gasOk,
    modules,
    totalDurationMs,
  };
  logSummary(summary);

  const okCount = modules.filter(m => m.status === 'ok').length;
  const failCount = modules.filter(m => m.status === 'failed').length;
  const skipCount = modules.filter(m => m.status === 'skipped').length;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('                      📋 CRON SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   SOL Balance:  ${solBalance.toFixed(6)} SOL ${gasOk ? '✅' : '⚠️ LOW'}`);
  console.log(`   Modules:      ${okCount} ok / ${failCount} failed / ${skipCount} skipped`);
  for (const m of modules) {
    const icon = m.status === 'ok' ? '✅' : m.status === 'skipped' ? '⏭️' : '❌';
    console.log(`     ${icon} ${m.name.padEnd(18)} ${m.message.slice(0, 50)} (${(m.durationMs / 1000).toFixed(1)}s)`);
  }
  if (rangeAlerts.length > 0) {
    console.log(`   Range Alerts: ${rangeAlerts.length}`);
    for (const a of rangeAlerts) {
      console.log(`     🚨 ${a.type}: ${a.strategyAddress.slice(0, 8)}...`);
    }
  }
  console.log(`   Runtime:      ${(totalDurationMs / 1000).toFixed(1)}s`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err.message || err);
    process.exit(1);
  });
