/**
 * Kamino Rate Watcher — WebSocket-based real-time monitoring
 * 
 * Subscribes to Kamino reserve accounts via Solana WebSocket (Helius).
 * Gets notified instantly when reserve state changes (borrow/supply rates).
 * 
 * Alerts when:
 *   - Multiply spread turns positive (SOL borrow < JitoSOL staking yield)
 *   - Borrow rates hit inflection points (>20% change from baseline)
 *   - Supply rates spike on any JitoSOL market
 * 
 * Runs as a persistent background service.
 * Usage: npx ts-node src/rate-watcher.ts
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createSolanaRpc, address } from '@solana/kit';
import { KaminoMarket, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { RangeMonitor, RangeAlert } from './range-monitor';

// ─── Config ──────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, '..', 'config', 'settings.json');
const STATE_PATH = path.join(__dirname, '..', 'config', 'watcher-state.json');
const ALERT_PATH = path.join(__dirname, '..', 'config', 'alerts.jsonl');

const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
const HTTP_URL = settings.rpcUrl;
const WS_URL = HTTP_URL.replace('https://', 'wss://').replace('http://', 'ws://');

// Reserve accounts to watch (SOL + JitoSOL across markets)
const WATCHED_RESERVES: Record<string, { market: string; symbol: string }> = {
  'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q': { market: 'Main', symbol: 'SOL' },
  'EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW': { market: 'Main', symbol: 'JITOSOL' },
  'DmaDuxw9NZMAZhsSrGnYSbd7rg6bvqqx3Y76MTkFubRY': { market: 'Jito', symbol: 'SOL' },
};

const KAMINO_MARKETS: Record<string, string> = {
  Main: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
  Jito: 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek',
};

const JITOSOL_STAKING_YIELD = 5.57;
const RATE_CHANGE_THRESHOLD = 0.15; // 15% relative change triggers alert
const DEBOUNCE_MS = 120_000; // Debounce to max 1 rate check every 2 minutes
const LP_CHECK_INTERVAL_MS = 1800_000; // Check LP yields every 30 minutes
const RANGE_CHECK_INTERVAL_MS = 600_000; // Check LP range every 10 minutes
const NEAR_BOUNDARY_THRESHOLD_PCT = 5; // Warn when within 5% of range edge
const HEALTH_LOG_INTERVAL_MS = 600_000; // Log health every 10 minutes
const RECONNECT_DELAY_MS = 5_000; // Reconnect after 5s on disconnect
const OPTIMIZER_CRON_ID = 'b8cd4bb8-bf75-4977-a55d-c0b433f73687';
const TRIGGER_COOLDOWN_MS = 300_000; // Don't trigger more than once every 5 minutes
let lastTriggerTime = 0;

// Active vault we're monitoring
const ACTIVE_VAULT = 'HCntzqDU5wXSWjwgLQP5hqh3kLHRYizKtPErvSCyggXd';

// ─── Types ───────────────────────────────────────────────
interface RateSnapshot {
  timestamp: string;
  market: string;
  solBorrowApy: number;
  solSupplyApy: number;
  jitosolSupplyApy: number;
  multiplySpread: number;
  profitable: boolean;
}

interface WatcherState {
  startedAt: string;
  lastUpdate: string;
  mode: string;
  wsUpdates: number;
  pollFallbacks: number;
  currentRates: Record<string, RateSnapshot>;
  rateHistory: RateSnapshot[];
  alerts: { timestamp: string; type: string; message: string }[];
  lastMultiplyPositive: string | null;
  stakingYield: number;
  subscriptionIds: number[];
}

// ─── State Management ────────────────────────────────────
function loadState(): WatcherState {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    state.mode = 'websocket';
    state.wsUpdates = state.wsUpdates || 0;
    state.pollFallbacks = state.pollFallbacks || 0;
    state.subscriptionIds = [];
    return state;
  } catch {
    return {
      startedAt: new Date().toISOString(),
      lastUpdate: '',
      mode: 'websocket',
      wsUpdates: 0,
      pollFallbacks: 0,
      currentRates: {},
      rateHistory: [],
      alerts: [],
      lastMultiplyPositive: null,
      stakingYield: JITOSOL_STAKING_YIELD,
      subscriptionIds: [],
    };
  }
}

function saveState(state: WatcherState) {
  if (state.rateHistory.length > 2000) {
    state.rateHistory = state.rateHistory.slice(-2000);
  }
  if (state.alerts.length > 200) {
    state.alerts = state.alerts.slice(-200);
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function emitAlert(state: WatcherState, type: string, message: string, triggerOptimizer = false) {
  const alert = { timestamp: new Date().toISOString(), type, message };
  state.alerts.push(alert);
  fs.appendFileSync(ALERT_PATH, JSON.stringify(alert) + '\n');
  console.log(`\n🚨 ALERT [${type}]: ${message}\n`);

  if (triggerOptimizer) {
    triggerCronJob(type);
  }
}

function triggerCronJob(reason: string) {
  const now = Date.now();
  if (now - lastTriggerTime < TRIGGER_COOLDOWN_MS) {
    console.log(`  ⏳ Trigger cooldown (${Math.round((TRIGGER_COOLDOWN_MS - (now - lastTriggerTime)) / 1000)}s remaining)`);
    return;
  }
  lastTriggerTime = now;

  console.log(`  🚀 Triggering optimizer cron (reason: ${reason})...`);
  try {
    execSync(
      `clawdbot cron run --id ${OPTIMIZER_CRON_ID} --text "TRIGGERED by rate-watcher: ${reason}. Check alerts and take action. If MULTIPLY_POSITIVE, evaluate deploying into the position. Message Hevar on Telegram with what you find and any actions taken."`,
      { timeout: 10_000, encoding: 'utf8' }
    );
    console.log(`  ✅ Optimizer cron triggered`);
  } catch (err: any) {
    console.error(`  ❌ Failed to trigger cron: ${err.message?.slice(0, 60)}`);
    // Fallback: write trigger file for next scheduled run
    fs.writeFileSync(
      path.join(__dirname, '..', 'config', 'trigger.json'),
      JSON.stringify({ reason, timestamp: new Date().toISOString() })
    );
  }
}

// ─── Rate Calculation ────────────────────────────────────
async function fetchMarketRates(connection: Connection, marketName: string): Promise<RateSnapshot | null> {
  const addr = KAMINO_MARKETS[marketName];
  if (!addr) return null;

  try {
    const rpc = createSolanaRpc(HTTP_URL);
    const slot = BigInt(await connection.getSlot());
    const market = await KaminoMarket.load(rpc, address(addr), 400, PROGRAM_ID);
    if (!market) return null;
    await market.loadReserves();

    let solBorrowApy = 0, solSupplyApy = 0, jitosolSupplyApy = 0;

    for (const [, reserve] of market.reserves) {
      const symbol = ((reserve as any).symbol || '').toUpperCase();
      if (symbol === 'SOL') {
        solBorrowApy = (reserve.totalBorrowAPY(slot) || 0) * 100;
        solSupplyApy = (reserve.totalSupplyAPY(slot) || 0) * 100;
      } else if (symbol === 'JITOSOL') {
        jitosolSupplyApy = (reserve.totalSupplyAPY(slot) || 0) * 100;
      }
    }

    const multiplySpread = JITOSOL_STAKING_YIELD - solBorrowApy;

    return {
      timestamp: new Date().toISOString(),
      market: marketName,
      solBorrowApy,
      solSupplyApy,
      jitosolSupplyApy,
      multiplySpread,
      profitable: multiplySpread > 0,
    };
  } catch (err: any) {
    console.error(`  ⚠️ Failed to fetch ${marketName}: ${err.message?.slice(0, 60)}`);
    return null;
  }
}

// ─── Inflection Detection ────────────────────────────────
function detectInflections(state: WatcherState, snapshot: RateSnapshot) {
  const prev = state.currentRates[snapshot.market];
  if (!prev) return;

  // Multiply spread turned positive — TRIGGER OPTIMIZER
  if (snapshot.profitable && !prev.profitable) {
    emitAlert(state, 'MULTIPLY_POSITIVE',
      `🟢 ${snapshot.market}: Multiply spread POSITIVE! ` +
      `SOL borrow: ${snapshot.solBorrowApy.toFixed(2)}% → Spread: +${snapshot.multiplySpread.toFixed(2)}%. ` +
      `5x net: ~${(snapshot.multiplySpread * 5 + JITOSOL_STAKING_YIELD).toFixed(1)}% APY`,
      true // trigger optimizer
    );
    state.lastMultiplyPositive = snapshot.timestamp;
  }

  // Spread turned negative — TRIGGER OPTIMIZER (may need to unwind)
  if (!snapshot.profitable && prev.profitable) {
    emitAlert(state, 'MULTIPLY_NEGATIVE',
      `🔴 ${snapshot.market}: Multiply spread NEGATIVE. ` +
      `SOL borrow: ${snapshot.solBorrowApy.toFixed(2)}% → Spread: ${snapshot.multiplySpread.toFixed(2)}%`,
      true // trigger optimizer
    );
  }

  // Large rate change — TRIGGER OPTIMIZER
  if (prev.solBorrowApy > 0.5) {
    const rateChange = Math.abs(snapshot.solBorrowApy - prev.solBorrowApy) / prev.solBorrowApy;
    if (rateChange > RATE_CHANGE_THRESHOLD) {
      const dir = snapshot.solBorrowApy > prev.solBorrowApy ? '📈' : '📉';
      emitAlert(state, 'RATE_INFLECTION',
        `${dir} ${snapshot.market}: SOL borrow ${(rateChange * 100).toFixed(0)}% move ` +
        `(${prev.solBorrowApy.toFixed(2)}% → ${snapshot.solBorrowApy.toFixed(2)}%) | ` +
        `Spread: ${snapshot.multiplySpread.toFixed(2)}%`,
        true // trigger optimizer
      );
    }
  }

  // JitoSOL supply spike — TRIGGER OPTIMIZER
  if (snapshot.jitosolSupplyApy > 1 && prev.jitosolSupplyApy < 0.5) {
    emitAlert(state, 'JITOSOL_SUPPLY_SPIKE',
      `📈 ${snapshot.market}: JitoSOL supply APY spiked to ${snapshot.jitosolSupplyApy.toFixed(2)}%`,
      true // trigger optimizer
    );
  }
}

// ─── LP Yield Check ──────────────────────────────────────
async function checkLPYields(state: WatcherState) {
  try {
    const resp = await fetch('https://yields.llama.fi/pools');
    const data = await resp.json() as any;

    const pools = (data.data || [])
      .filter((p: any) =>
        p.chain === 'Solana' &&
        p.symbol?.toUpperCase().includes('JITOSOL') &&
        (p.tvlUsd || 0) > 500000
      )
      .sort((a: any, b: any) => (b.apy || 0) - (a.apy || 0));

    const best = pools[0];
    if (best && best.apy > 20) {
      const recent = state.alerts.find(a =>
        a.type === 'LP_HIGH_YIELD' &&
        a.message.includes(best.project) &&
        Date.now() - new Date(a.timestamp).getTime() < 3600_000
      );
      if (!recent) {
        emitAlert(state, 'LP_HIGH_YIELD',
          `💰 ${best.project} | ${best.symbol} paying ${best.apy.toFixed(1)}% APY (TVL: $${(best.tvlUsd / 1e6).toFixed(1)}M)`
        );
      }
    }
  } catch { /* silent */ }
}

// ─── WebSocket Subscription ──────────────────────────────
async function subscribeToReserves(connection: Connection, state: WatcherState) {
  const debounceTimers: Record<string, NodeJS.Timeout> = {};

  for (const [reserveAddr, info] of Object.entries(WATCHED_RESERVES)) {
    const pubkey = new PublicKey(reserveAddr);

    console.log(`  📡 Subscribing to ${info.market}/${info.symbol} (${reserveAddr.slice(0, 12)}...)`);

    try {
      const subId = connection.onAccountChange(
        pubkey,
        async (_accountInfo) => {
          // Debounce rapid updates
          const key = `${info.market}-${info.symbol}`;
          if (debounceTimers[key]) clearTimeout(debounceTimers[key]);

          debounceTimers[key] = setTimeout(async () => {
            state.wsUpdates++;
            console.log(`  ⚡ [WS] ${info.market}/${info.symbol} changed (update #${state.wsUpdates})`);

            // Re-fetch full market rates (need all reserves for calculation)
            const snapshot = await fetchMarketRates(connection, info.market);
            if (snapshot) {
              detectInflections(state, snapshot);
              state.currentRates[snapshot.market] = snapshot;
              state.rateHistory.push(snapshot);
              state.lastUpdate = snapshot.timestamp;

              const icon = snapshot.profitable ? '🟢' : '🔴';
              console.log(`  ${icon} ${snapshot.market}: borrow ${snapshot.solBorrowApy.toFixed(2)}% | spread ${snapshot.multiplySpread.toFixed(2)}% | supply ${snapshot.solSupplyApy.toFixed(2)}%`);

              saveState(state);
            }
          }, DEBOUNCE_MS);
        },
        'confirmed'
      );

      state.subscriptionIds.push(subId);
      console.log(`  ✅ Subscribed (id: ${subId})`);
    } catch (err: any) {
      console.error(`  ❌ Failed to subscribe to ${info.market}/${info.symbol}: ${err.message?.slice(0, 60)}`);
    }
  }
}

// ─── Range Check ─────────────────────────────────────────
async function checkLPRange(state: WatcherState, rangeMonitor: RangeMonitor) {
  try {
    console.log(`  🔭 Checking LP range for vault ${ACTIVE_VAULT.slice(0, 8)}...`);

    const rangeInfo = await rangeMonitor.checkPositionRange(ACTIVE_VAULT);

    const distPct = rangeInfo.distanceToBoundaryPercent.toNumber();
    const statusIcon = rangeInfo.inRange ? '✅' : '❌';
    console.log(`  ${statusIcon} ${rangeInfo.tokenPair} | Price: ${rangeInfo.poolPrice.toFixed(6)} | ` +
      `Range: [${rangeInfo.lower.toFixed(6)}, ${rangeInfo.upper.toFixed(6)}] | ` +
      `Distance: ${distPct.toFixed(2)}%`);

    if (!rangeInfo.inRange) {
      // OUT OF RANGE — critical alert + trigger optimizer
      const recent = state.alerts.find(a =>
        a.type === 'OUT_OF_RANGE' &&
        Date.now() - new Date(a.timestamp).getTime() < 1800_000 // Don't spam: 30min cooldown
      );
      if (!recent) {
        emitAlert(state, 'OUT_OF_RANGE',
          `🚨 LP vault ${ACTIVE_VAULT.slice(0, 8)}... is OUT OF RANGE! ` +
          `${rangeInfo.tokenPair} earning 0%. Pool: ${rangeInfo.poolPrice.toFixed(6)}, ` +
          `Range: [${rangeInfo.lower.toFixed(6)}, ${rangeInfo.upper.toFixed(6)}]. ` +
          `Distance: ${distPct.toFixed(2)}%. Immediate action needed.`,
          true // trigger optimizer
        );
      }
    } else if (distPct < NEAR_BOUNDARY_THRESHOLD_PCT) {
      // NEAR BOUNDARY — warning
      const recent = state.alerts.find(a =>
        a.type === 'NEAR_BOUNDARY' &&
        Date.now() - new Date(a.timestamp).getTime() < 3600_000 // Don't spam: 1hr cooldown
      );
      if (!recent) {
        emitAlert(state, 'NEAR_BOUNDARY',
          `⚠️ LP vault ${ACTIVE_VAULT.slice(0, 8)}... approaching boundary! ` +
          `${rangeInfo.tokenPair} is ${distPct.toFixed(2)}% from edge (threshold: ${NEAR_BOUNDARY_THRESHOLD_PCT}%). ` +
          `Pool: ${rangeInfo.poolPrice.toFixed(6)}, Range: [${rangeInfo.lower.toFixed(6)}, ${rangeInfo.upper.toFixed(6)}].`,
          false // warning only, don't trigger optimizer yet
        );
      }
    }

    saveState(state);
  } catch (err: any) {
    console.error(`  ❌ Range check failed: ${err.message?.slice(0, 80)}`);
  }
}

// ─── Main ────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  🔄 Kamino Rate Watcher v2 (WebSocket)');
  console.log(`  RPC: ${HTTP_URL.replace(/api-key=.*/, 'api-key=***')}`);
  console.log(`  WS:  ${WS_URL.replace(/api-key=.*/, 'api-key=***')}`);
  console.log(`  Staking yield: ${JITOSOL_STAKING_YIELD}%`);
  console.log(`  Watching ${Object.keys(WATCHED_RESERVES).length} reserve accounts`);
  console.log('═══════════════════════════════════════════════\n');

  const connection = new Connection(HTTP_URL, {
    wsEndpoint: WS_URL,
    commitment: 'confirmed',
  });

  // Load wallet for range monitoring
  const walletPath = path.join(__dirname, '..', 'config', 'wallet.json');
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const rangeMonitor = new RangeMonitor(HTTP_URL, wallet);

  const state = loadState();
  state.startedAt = new Date().toISOString();

  // Initial fetch for baseline
  console.log('📊 Fetching initial rates...');
  for (const marketName of Object.keys(KAMINO_MARKETS)) {
    const snapshot = await fetchMarketRates(connection, marketName);
    if (snapshot) {
      state.currentRates[snapshot.market] = snapshot;
      state.rateHistory.push(snapshot);
      const icon = snapshot.profitable ? '🟢' : '🔴';
      console.log(`  ${icon} ${snapshot.market}: borrow ${snapshot.solBorrowApy.toFixed(2)}% | spread ${snapshot.multiplySpread.toFixed(2)}% | supply ${snapshot.solSupplyApy.toFixed(2)}%`);
    }
  }

  // Subscribe to reserve account changes
  console.log('\n📡 Setting up WebSocket subscriptions...');
  await subscribeToReserves(connection, state);

  // Initial LP check
  await checkLPYields(state);

  // Initial range check
  console.log('\n🔭 Checking LP position range...');
  await checkLPRange(state, rangeMonitor);

  saveState(state);

  // Periodic LP yield check (every 30 min)
  setInterval(async () => {
    await checkLPYields(state);
    saveState(state);
  }, LP_CHECK_INTERVAL_MS);

  // Periodic range check (every 10 min)
  setInterval(async () => {
    await checkLPRange(state, rangeMonitor);
  }, RANGE_CHECK_INTERVAL_MS);

  // Health log (every 5 min)
  setInterval(() => {
    const main = state.currentRates['Main'];
    const jito = state.currentRates['Jito'];
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ` +
      `WS updates: ${state.wsUpdates} | ` +
      `Main: ${main?.solBorrowApy.toFixed(2)}% borrow (${main?.multiplySpread.toFixed(2)}%) | ` +
      `Jito: ${jito?.solBorrowApy.toFixed(2)}% borrow (${jito?.multiplySpread.toFixed(2)}%) | ` +
      `Alerts: ${state.alerts.length}`
    );
  }, HEALTH_LOG_INTERVAL_MS);

  // Handle connection drops — reconnect
  connection.onSlotChange(() => { /* keepalive */ });

  console.log('\n🔍 Watching via WebSocket. Real-time updates enabled.\n');

  // Keep process alive
  process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    for (const subId of state.subscriptionIds) {
      connection.removeAccountChangeListener(subId).catch(() => {});
    }
    saveState(state);
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 Interrupted...');
    saveState(state);
    process.exit(0);
  });
}

main().catch(console.error);
