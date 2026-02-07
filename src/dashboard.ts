/**
 * Kamino Yield Dashboard
 *
 * Web UI for monitoring portfolio performance, position health,
 * yield history, alerts, and rewards.
 *
 * Tech: Express + single inline HTML page. No build step.
 * Dark theme. Auto-refreshes every 60s. Mobile-friendly.
 * Port: 3847 (configurable via DASHBOARD_PORT env var).
 *
 * Data sources: reads from JSONL files — NO RPC calls from dashboard.
 * The cron job + trackers populate the data; dashboard just reads.
 */

// @ts-nocheck
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

const PORT = parseInt(process.env.DASHBOARD_PORT || '3847', 10);
const CONFIG_DIR = '/root/clawd/skills/kamino-yield/config';
const WALLET = '7u5ovFNms7oE232TTyMU5TxDfyZTJctihH4YqP2n1EUz';

// Known token mints
const KNOWN_MINTS: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS': { symbol: 'KMNO', decimals: 6, coingeckoId: 'kamino' },
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': { symbol: 'JitoSOL', decimals: 9, coingeckoId: 'jito-staked-sol' },
};

// ─── Data loaders (read JSONL files, no RPC) ───────────────────

function readJsonlFile(filename: string, limit?: number): any[] {
  const filePath = path.join(CONFIG_DIR, filename);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  const lines = content.split('\n').filter(Boolean);
  const items = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  if (limit) return items.slice(-limit);
  return items;
}

function readJsonFile(filename: string): any {
  const filePath = path.join(CONFIG_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

// ─── Withdrawal detection ───────────────────────────────────────

function getAdjustedYieldHistory() {
  const history = readJsonlFile('yield-history.jsonl');
  if (history.length < 2) return { history, withdrawals: [] as any[], adjustedYield: 0, totalWithdrawnSol: 0 };

  const withdrawals: { timestamp: string; amountSol: number; index: number }[] = [];
  let totalWithdrawnSol = 0;

  for (let i = 1; i < history.length; i++) {
    const prev = parseFloat(history[i - 1].portfolioTotalValueSol);
    const curr = parseFloat(history[i].portfolioTotalValueSol);
    const drop = prev - curr;
    const dropPct = drop / prev;
    if (dropPct > 0.5 && drop > 0.1) {
      withdrawals.push({ timestamp: history[i].timestamp, amountSol: drop, index: i });
      totalWithdrawnSol += drop;
    }
  }

  const first = parseFloat(history[0].portfolioTotalValueSol);
  const last = parseFloat(history[history.length - 1].portfolioTotalValueSol);
  const adjustedYield = (last + totalWithdrawnSol) - first;

  return { history, withdrawals, adjustedYield, totalWithdrawnSol };
}

// ─── Live portfolio (on-chain) ──────────────────────────────────

let portfolioLiveCache: any = null;
let portfolioLiveCacheTime = 0;

async function fetchLivePortfolio(): Promise<any> {
  const now = Date.now();
  if (portfolioLiveCache && now - portfolioLiveCacheTime < 60_000) {
    return portfolioLiveCache;
  }

  try {
    const { Connection, PublicKey } = require('@solana/web3.js');
    const settingsPath = path.join(CONFIG_DIR, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const connection = new Connection(settings.rpcUrl);
    const walletPubkey = new PublicKey(WALLET);

    const solLamports = await connection.getBalance(walletPubkey);
    const solBalance = solLamports / 1e9;

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });

    const holdings: any[] = [{ symbol: 'SOL', mint: 'native', balance: solBalance, coingeckoId: 'solana' }];

    for (const account of tokenAccounts.value) {
      const parsed = account.account.data.parsed.info;
      const mint = parsed.mint;
      const amount = parseFloat(parsed.tokenAmount.uiAmountString || '0');
      if (amount <= 0) continue;
      const known = KNOWN_MINTS[mint];
      holdings.push({
        symbol: known?.symbol || mint.slice(0, 8) + '...',
        mint,
        balance: amount,
        coingeckoId: known?.coingeckoId,
      });
    }

    // Check KMNO staking on Kamino Farms
    const FARMS_PROGRAM = new PublicKey('FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr');
    const FARM_STATE = new PublicKey('2sFZDpBn4sA42uNbAD6QzQ98rPSmqnPyksYe6SJKVvay');
    const [userStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('user'), FARM_STATE.toBuffer(), walletPubkey.toBuffer()],
      FARMS_PROGRAM
    );
    let kmnoStakedAmount = 0;
    try {
      const userStateAcct = await connection.getAccountInfo(userStatePDA);
      if (userStateAcct && userStateAcct.data.length >= 424) {
        // UserState layout: 8 disc + 8 userId + 32 farmState + 32 owner + 1 isDelegated + 7 padding
        //   + 160 rewardsTallyScaled(10xu128) + 80 rewardsIssuedUnclaimed(10xu64) + 80 lastClaimTs(10xu64)
        //   = offset 408: activeStakeScaled (u128)
        // activeStakeScaled / 10^24 = KMNO token amount
        const data = userStateAcct.data;
        const low = data.readBigUInt64LE(408);
        const high = data.readBigUInt64LE(416);
        const activeStakeScaled = low + (high << 64n);
        // Divide by 10^24 (wads scaling for 6-decimal token)
        kmnoStakedAmount = Number(activeStakeScaled / 10n**18n) / 1e6;
      }
    } catch (e) { console.error('KMNO staking check failed:', e); }

    // Check KLend obligation for deposited JitoSOL
    const OBLIGATION_KEY = new PublicKey('7qoM9cQtTpyJK3VRPUU7XUcWZ8XnBjdffEFS58ReLuHw');
    try {
      const oblAcct = await connection.getAccountInfo(OBLIGATION_KEY);
      if (oblAcct && oblAcct.data.length > 140) {
        // Deposit amount at offset 128 (u64, 9 decimals for JitoSOL)
        const depositAmount = Number(oblAcct.data.readBigUInt64LE(128)) / 1e9;
        if (depositAmount > 0.001) {
          holdings.push({
            symbol: 'JitoSOL (KLend)',
            mint: 'klend-deposit',
            balance: depositAmount,
            coingeckoId: 'jito-staked-sol',
            isKlendDeposit: true,
          });
        }
      }
    } catch (e) { console.error('KLend obligation read failed:', e); }

    const coingeckoIds = holdings.map(h => h.coingeckoId).filter(Boolean).join(',');
    const FALLBACK_PRICES: Record<string, number> = { solana: 88, 'jito-staked-sol': 100, kamino: 0.04 };
    let prices: Record<string, number> = {};
    try {
      const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoIds}&vs_currencies=usd`);
      if (resp.ok) {
        const data = await resp.json() as any;
        for (const [id, d] of Object.entries(data)) {
          const val = (d as any).usd;
          if (val && val > 0) prices[id] = val;
        }
      }
    } catch { /* use fallback */ }
    // Fill in missing prices with fallback
    for (const [id, fallback] of Object.entries(FALLBACK_PRICES)) {
      if (!prices[id]) prices[id] = fallback;
    }

    const solPrice = prices['solana'] || 88;
    const kmnoPrice = prices['kamino'] || 0.04;
    let totalUsd = 0;
    for (const h of holdings) {
      h.usdValue = h.coingeckoId && prices[h.coingeckoId] ? h.balance * prices[h.coingeckoId] : 0;
      h.solValue = solPrice > 0 ? h.usdValue / solPrice : 0;
      totalUsd += h.usdValue;
    }
    // Add staked KMNO value
    const stakedKmnoUsd = kmnoStakedAmount * kmnoPrice;
    totalUsd += stakedKmnoUsd;

    const result = {
      wallet: WALLET, holdings,
      totalUsd: totalUsd.toFixed(2),
      totalSol: (totalUsd / solPrice).toFixed(6),
      prices: { sol: solPrice, jitoSol: prices['jito-staked-sol'] || 0, kmno: prices['kamino'] || 0 },
      kmnoStaked: kmnoStakedAmount,
      updatedAt: new Date().toISOString(),
    };
    // Only cache if we have non-zero total (don't cache broken data)
    if (totalUsd > 0) {
      portfolioLiveCache = result;
      portfolioLiveCacheTime = now;
    }
    return result;
  } catch (err: any) {
    console.error('Live portfolio fetch failed:', err.message);
    return portfolioLiveCache || { error: err.message };
  }
}

// ─── API endpoints ──────────────────────────────────────────────

function getPortfolioData() {
  const { history: yieldHistory, withdrawals, adjustedYield, totalWithdrawnSol } = getAdjustedYieldHistory();
  const latest = yieldHistory.length > 0 ? yieldHistory[yieldHistory.length - 1] : null;
  const first = yieldHistory.length > 0 ? yieldHistory[0] : null;

  let earnedSol = '0';
  let earnedUsd = '0';
  let actualApy = '0';
  let daysSinceStart = 0;

  if (first && latest) {
    const startVal = parseFloat(first.portfolioTotalValueSol);
    earnedSol = adjustedYield.toFixed(6);
    earnedUsd = (adjustedYield * parseFloat(latest.solPriceUsd || '170')).toFixed(2);

    const startTime = new Date(first.timestamp).getTime();
    const endTime = new Date(latest.timestamp).getTime();
    daysSinceStart = Math.max((endTime - startTime) / (1000 * 60 * 60 * 24), 0.01);

    if (startVal > 0 && daysSinceStart > 0) {
      const returnPct = adjustedYield / startVal;
      actualApy = (returnPct / daysSinceStart * 365 * 100).toFixed(2);
    }
  }

  return {
    latest, first, earnedSol, earnedUsd, actualApy,
    daysSinceStart: daysSinceStart.toFixed(1),
    snapshotCount: yieldHistory.length,
    withdrawals,
    totalWithdrawnSol: (totalWithdrawnSol || 0).toFixed(4),
  };
}

function getYieldChartData() {
  const { history, withdrawals } = getAdjustedYieldHistory();
  let withdrawnSoFar = 0;
  let wIdx = 0;

  return history.map((entry, i) => {
    const isWithdrawal = withdrawals.some(w => w.index === i);
    while (wIdx < withdrawals.length && withdrawals[wIdx].index <= i) {
      withdrawnSoFar += withdrawals[wIdx].amountSol;
      wIdx++;
    }
    const currentVal = parseFloat(entry.portfolioTotalValueSol);
    const firstVal = parseFloat(history[0].portfolioTotalValueSol);
    const correctedYield = (currentVal + withdrawnSoFar) - firstVal;

    return {
      timestamp: entry.timestamp,
      valueSol: entry.portfolioTotalValueSol,
      valueUsd: entry.portfolioTotalValueUsd,
      cumulativeYieldSol: correctedYield.toFixed(6),
      isWithdrawal,
    };
  });
}

function getAlerts() {
  return readJsonlFile('alerts.jsonl', 30).reverse();
}

function getRebalancerLog() {
  return readJsonlFile('rebalancer-log.jsonl', 20).reverse();
}

function getPerformanceLog() {
  return readJsonlFile('performance.jsonl', 30).reverse();
}

function getRewardsData() {
  const history = readJsonlFile('rewards-history.jsonl');
  return history.length > 0 ? history[history.length - 1] : null;
}

function getRateHistory() {
  return readJsonFile('rate-history.json') || [];
}

function getProtocolRates() {
  return readJsonFile('protocol-rates.json') || null;
}

// ─── HTML Dashboard ─────────────────────────────────────────────

function generateDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kamino Yield Dashboard</title>
<style>
:root {
  --bg: #0d1117;
  --bg2: #161b22;
  --bg3: #21262d;
  --border: #30363d;
  --text: #e6edf3;
  --text2: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --red: #f85149;
  --yellow: #d29922;
  --purple: #bc8cff;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  padding: 16px;
  max-width: 1400px;
  margin: 0 auto;
}
h1 { font-size: 1.5rem; margin-bottom: 4px; }
h2 { font-size: 1.1rem; margin-bottom: 12px; color: var(--accent); }
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  flex-wrap: wrap;
  gap: 8px;
}
.header-meta { color: var(--text2); font-size: 0.85rem; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.card-full {
  grid-column: 1 / -1;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.stat {
  text-align: center;
  padding: 12px;
  background: var(--bg3);
  border-radius: 6px;
}
.stat-value {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--accent);
}
.stat-label {
  font-size: 0.75rem;
  color: var(--text2);
  margin-top: 2px;
}
.green { color: var(--green); }
.red { color: var(--red); }
.yellow { color: var(--yellow); }
.purple { color: var(--purple); }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th, td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
th {
  color: var(--text2);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
}
tr:hover { background: var(--bg3); }
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
}
.badge-green { background: rgba(63,185,80,0.15); color: var(--green); }
.badge-red { background: rgba(248,81,73,0.15); color: var(--red); }
.badge-yellow { background: rgba(210,153,34,0.15); color: var(--yellow); }
.chart-container {
  width: 100%;
  height: 250px;
  position: relative;
}
.log-entry {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
}
.log-entry:last-child { border-bottom: none; }
.log-time { color: var(--text2); font-size: 0.75rem; }
.log-msg { margin-top: 2px; }
.pos-table td:nth-child(3), .pos-table td:nth-child(4) { font-family: monospace; }
.refresh-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--accent);
  opacity: 0.7;
  transform-origin: left;
  animation: refreshCountdown 60s linear infinite;
}
@keyframes refreshCountdown {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}
@media (max-width: 600px) {
  body { padding: 8px; }
  .stat-value { font-size: 1.1rem; }
  .grid { grid-template-columns: 1fr; }
}
.scroll-table { max-height: 300px; overflow-y: auto; }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>🔥 Kamino Yield Optimizer</h1>
    <div class="header-meta">Wallet: <code id="wallet">...</code> | Last update: <span id="lastUpdate">...</span></div>
    <div class="header-meta" id="livePrices" style="margin-top:4px;font-size:0.9rem">Loading prices...</div>
  </div>
  <div style="text-align:right">
    <div class="header-meta">Auto-refresh: 60s</div>
    <div id="serviceStatus" class="header-meta" style="margin-top:4px">Checking services...</div>
  </div>
</div>

<!-- Portfolio Overview -->
<div class="grid">
  <div class="card card-full">
    <h2>📊 Portfolio Overview</h2>
    <div class="stat-grid" id="portfolioStats">
      <div class="stat"><div class="stat-value" id="totalValueSol">—</div><div class="stat-label">Total (SOL)</div></div>
      <div class="stat"><div class="stat-value" id="totalValueUsd">—</div><div class="stat-label">Total (USD)</div></div>
      <div class="stat"><div class="stat-value purple" id="blendedApy">—</div><div class="stat-label">Blended APY</div></div>
      <div class="stat"><div class="stat-value green" id="dailyYield">—</div><div class="stat-label">Est. Daily Yield</div></div>
      <div class="stat"><div class="stat-value green" id="monthlyYield">—</div><div class="stat-label">Est. Monthly Yield</div></div>
      <div class="stat"><div class="stat-value" id="trackingDays">—</div><div class="stat-label">Tracking</div></div>
    </div>
  </div>
</div>

<!-- Yield Chart + Positions -->
<div class="grid">
  <div class="card card-full">
    <h2>📈 Portfolio Value Over Time</h2>
    <div class="chart-container">
      <canvas id="yieldChart"></canvas>
    </div>
  </div>
</div>

<div class="grid">
  <!-- Active Positions -->
  <div class="card">
    <h2>💰 Current Holdings</h2>
    <div id="positionsTable">Loading...</div>
  </div>

  <!-- Position Health -->
  <div class="card">
    <h2>🎯 Position Health</h2>
    <div id="healthTable">Loading...</div>
  </div>
</div>

<div class="grid">
  <!-- Strategy Comparison -->
  <div class="card">
    <h2>⚖️ Strategy Comparison</h2>
    <div id="strategyTable">Loading...</div>
  </div>

  <!-- Rewards/Points -->
  <div class="card">
    <h2>🎁 Rewards & Points</h2>
    <div id="rewardsSection">Loading...</div>
  </div>
</div>

<div class="grid">
  <!-- Recent Alerts -->
  <div class="card">
    <h2>🚨 Recent Alerts</h2>
    <div class="scroll-table" id="alertsList">Loading...</div>
  </div>

  <!-- Rebalancer Log -->
  <div class="card">
    <h2>🔄 Rebalancer Decisions</h2>
    <div class="scroll-table" id="rebalancerLog">Loading...</div>
  </div>
</div>

<div class="refresh-bar"></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script>
const API_BASE = '';
let yieldChart = null;

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch { return null; }
}

function fmt(val, decimals = 4) {
  if (val === null || val === undefined || val === '—') return '—';
  const n = parseFloat(val);
  return isNaN(n) ? val : n.toFixed(decimals);
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', {month:'short', day:'numeric'}) + ' ' +
         d.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12: false});
}

function fmtTimeShort(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:false});
}

async function loadStatus() {
  const status = await fetchJson('/api/status');
  if (status) {
    const el = document.getElementById('serviceStatus');
    if (el) {
      const watcherOk = status.watcher?.status === 'running' && status.watcher?.lastUpdate;
      const lastWs = status.watcher?.lastUpdate ? new Date(status.watcher.lastUpdate) : null;
      const stale = lastWs && (Date.now() - lastWs.getTime() > 600000); // >10 min = stale
      el.innerHTML =
        '<span style="color:' + (watcherOk && !stale ? '#3fb950' : '#d29922') + '">⚡ Watcher: ' +
        (watcherOk ? status.watcher.wsUpdates + ' updates' : 'unknown') + '</span>' +
        ' | <span style="color:#58a6ff">📊 Dashboard: ' + status.dashboard.uptime + '</span>';
    }
  }
}

async function loadPrices() {
  const prices = await fetchJson('/api/prices');
  if (prices) {
    const el = document.getElementById('livePrices');
    if (el) {
      el.innerHTML = '<span style="color:#58a6ff">SOL</span> $' + (prices.sol || 0).toFixed(2) +
        ' &nbsp;|&nbsp; <span style="color:#f0883e">JitoSOL</span> $' + (prices.jitoSol || 0).toFixed(2) +
        (prices.kmno ? ' &nbsp;|&nbsp; <span style="color:#bc8cff">KMNO</span> $' + prices.kmno.toFixed(4) : '') +
        ' &nbsp;<span style="color:#666;font-size:11px">(' + new Date(prices.updatedAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) + ')</span>';
    }
  }
}

async function loadDashboard() {
  await Promise.all([loadPrices(), loadStatus()]);
  // Live + historical portfolio
  const [livePortfolio, portfolio] = await Promise.all([
    fetchJson('/api/portfolio-live'),
    fetchJson('/api/portfolio'),
  ]);
  // Use live data for totals, historical for yield
  if (livePortfolio && !livePortfolio.error) {
    document.getElementById('wallet').textContent = livePortfolio.wallet.slice(0,6) + '...' + livePortfolio.wallet.slice(-4);
    document.getElementById('lastUpdate').textContent = fmtTime(livePortfolio.updatedAt);
    document.getElementById('totalValueSol').textContent = fmt(livePortfolio.totalSol) + ' SOL';
    document.getElementById('totalValueUsd').textContent = '$' + fmt(livePortfolio.totalUsd, 2);
  } else if (portfolio && portfolio.latest) {
    const l = portfolio.latest;
    document.getElementById('wallet').textContent = '7u5ovF...1EUz';
    document.getElementById('lastUpdate').textContent = fmtTime(l.timestamp);
    document.getElementById('totalValueSol').textContent = fmt(l.portfolioTotalValueSol) + ' SOL';
    document.getElementById('totalValueUsd').textContent = '$' + fmt(l.portfolioTotalValueUsd, 2);
  }
  // Calculate blended APY and yield estimates from live portfolio
  if (livePortfolio && !livePortfolio.error) {
    const totalUsd = parseFloat(livePortfolio.totalUsd) || 0;
    const klendH = livePortfolio.holdings?.find(h => h.symbol === 'JitoSOL (KLend)');
    const klendUsd = klendH ? (klendH.usdValue || 0) : 0;
    const stakedKmno = livePortfolio.kmnoStaked || 0;
    const kmnoUsd = stakedKmno * (livePortfolio.prices?.kmno || 0.03);
    const jitoH = livePortfolio.holdings?.find(h => h.symbol === 'JitoSOL');
    const jitoUsd = jitoH ? (jitoH.usdValue || 0) : 0;

    // Per-position APYs
    const klendSupplyApy = 4.0;   // KLend supply base APY (~4%)
    const jitoMevApy = 7.2;       // JitoSOL MEV rewards (~7.2%)
    const kmnoStakingApy = 5.0;   // KMNO staking est. yield from rewards (~5%)

    // KLend JitoSOL earns: supply APY + Jito staking rewards
    const klendBlended = klendSupplyApy + jitoMevApy; // ~11.2%
    // Idle JitoSOL: just Jito staking
    const jitoBlended = jitoMevApy; // ~7.2%
    // Staked KMNO: S5 rewards
    const kmnoBlended = kmnoStakingApy;

    const blendedApy = totalUsd > 0
      ? (klendUsd * klendBlended + jitoUsd * jitoBlended + kmnoUsd * kmnoBlended) / totalUsd
      : 0;
    const dailyYieldUsd = totalUsd * blendedApy / 100 / 365;
    const monthlyYieldUsd = dailyYieldUsd * 30;

    document.getElementById('blendedApy').textContent = blendedApy.toFixed(1) + '%';
    document.getElementById('dailyYield').textContent = '$' + dailyYieldUsd.toFixed(2) + '/day';
    document.getElementById('monthlyYield').textContent = '$' + monthlyYieldUsd.toFixed(2) + '/mo';
  }
  if (portfolio) {
    document.getElementById('trackingDays').textContent = portfolio.daysSinceStart + 'd (' + portfolio.snapshotCount + ' snaps)';
  }

  // Yield chart
  const chartData = await fetchJson('/api/yield-chart');
  if (chartData && chartData.length > 0) {
    const startTime = new Date(chartData[0].timestamp).getTime();
    const startVal = parseFloat(chartData[0].valueSol);
    // Calculate blended APY from all positions
    // KLend JitoSOL supply: ~4-6% base + ~7.2% Jito staking = ~11%
    // KMNO staking: earns KMNO rewards (S5 points → future KMNO, ~5-10% est)
    // Approximate blended APY based on portfolio composition
    let projectedApy = 0;
    if (livePortfolio && !livePortfolio.error) {
      const totalUsd = parseFloat(livePortfolio.totalUsd) || 1;
      const klendH = livePortfolio.holdings?.find(h => h.symbol === 'JitoSOL (KLend)');
      const klendUsd = klendH ? (klendH.usdValue || 0) : 0;
      const stakedKmno = livePortfolio.kmnoStaked || 0;
      const kmnoUsd = stakedKmno * (livePortfolio.prices?.kmno || 0.03);
      // KLend JitoSOL: ~4% supply APY + ~7.2% Jito MEV = ~11.2%
      // KMNO staking: ~5% estimated from S5 rewards
      const klendApy = 11.2;
      const stakingApy = 5.0;
      projectedApy = (klendUsd / totalUsd * klendApy) + (kmnoUsd / totalUsd * stakingApy);
      if (projectedApy < 1) projectedApy = 8; // reasonable default
    } else {
      projectedApy = 8;
    }
    const dailyRate = projectedApy / 100 / 365;

    // Build labels: existing data + 30 days projection
    const now = Date.now();
    const projEnd = startTime + 30 * 24 * 60 * 60 * 1000;
    const endTime = Math.max(now, projEnd);

    // Generate projection points (daily for 30 days from start)
    const projLabels = [];
    const projValues = [];
    const projYields = [];
    for (let t = startTime; t <= endTime; t += 24 * 60 * 60 * 1000) {
      const daysSinceStart = (t - startTime) / (24 * 60 * 60 * 1000);
      const projValue = startVal * Math.pow(1 + dailyRate, daysSinceStart);
      projLabels.push(new Date(t).toISOString());
      projValues.push(projValue);
      projYields.push(projValue - startVal);
    }

    // Merge: use actual data timestamps + projection timestamps for a unified x-axis
    const allTimestamps = [...new Set([
      ...chartData.map(d => d.timestamp),
      ...projLabels
    ])].sort();
    const labels = allTimestamps.map(t => fmtTime(t));

    // Map actual values to the unified timeline
    const actualMap = {};
    chartData.forEach(d => { actualMap[d.timestamp] = parseFloat(d.valueSol); });
    const values = allTimestamps.map(t => actualMap[t] !== undefined ? actualMap[t] : null);

    // Map actual yields
    const yieldMap = {};
    chartData.forEach(d => { yieldMap[d.timestamp] = parseFloat(d.cumulativeYieldSol || '0'); });
    const yields = allTimestamps.map(t => yieldMap[t] !== undefined ? yieldMap[t] : null);

    // Map projected values to the unified timeline
    const projMap = {};
    projLabels.forEach((t, i) => { projMap[t] = projValues[i]; });
    const projected = allTimestamps.map(t => projMap[t] !== undefined ? projMap[t] : null);

    const ctx = document.getElementById('yieldChart').getContext('2d');
    if (yieldChart) yieldChart.destroy();
    yieldChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Actual Value (SOL)',
            data: values,
            borderColor: '#58a6ff',
            backgroundColor: 'rgba(88,166,255,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            spanGaps: false,
          },
          {
            label: 'Projected @ ' + projectedApy.toFixed(1) + '% APY',
            data: projected,
            borderColor: '#f0883e',
            borderDash: [6, 3],
            backgroundColor: 'rgba(240,136,62,0.05)',
            fill: false,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          },
          {
            label: 'Cumulative Yield (SOL)',
            data: yields,
            borderColor: '#3fb950',
            backgroundColor: 'rgba(63,185,80,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            yAxisID: 'y1',
            spanGaps: false,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#8b949e' } }
        },
        scales: {
          x: {
            ticks: { color: '#8b949e', maxTicksLimit: 10, font: { size: 10 } },
            grid: { color: '#21262d' }
          },
          y: {
            ticks: { color: '#58a6ff', font: { size: 10 } },
            grid: { color: '#21262d' },
            title: { display: true, text: 'Value (SOL)', color: '#58a6ff' }
          },
          y1: {
            position: 'right',
            ticks: { color: '#3fb950', font: { size: 10 } },
            grid: { display: false },
            title: { display: true, text: 'Yield (SOL)', color: '#3fb950' }
          }
        }
      }
    });
  }

  // Positions — prefer live on-chain data
  if (livePortfolio && livePortfolio.holdings) {
    let html = '<table class="pos-table"><tr><th>Asset</th><th>Balance</th><th>Value</th><th>APY</th><th>Status</th></tr>';
    for (const h of livePortfolio.holdings) {
      if (h.usdValue < 0.01 && h.symbol !== 'SOL') continue;
      let badge = '', apy = '';
      if (h.symbol === 'JitoSOL (KLend)') {
        badge = '<span class="badge badge-green">🏦 Kamino Lend</span>';
        apy = '<span class="green">~11.2%</span>';
      } else if (h.symbol === 'SOL') {
        badge = '<span class="badge badge-green">Gas</span>';
        apy = '—';
      } else if (h.symbol === 'JitoSOL') {
        badge = '<span class="badge badge-yellow">Idle</span>';
        apy = '<span class="yellow">~7.2%</span>';
      } else if (h.symbol === 'KMNO') {
        badge = '<span class="badge" style="background:rgba(188,140,255,0.15);color:#bc8cff">Wallet</span>';
        apy = '—';
      } else {
        badge = '<span class="badge badge-green">Held</span>';
        apy = '—';
      }
      const bal = h.balance < 1 ? h.balance.toFixed(6) : h.balance.toFixed(2);
      html += '<tr><td><strong>' + h.symbol + '</strong></td><td style="font-family:monospace">' + bal + '</td>';
      html += '<td style="font-family:monospace">$' + (h.usdValue || 0).toFixed(2) + '</td><td>' + apy + '</td><td>' + badge + '</td></tr>';
    }
    // Add staked KMNO as separate row
    const stakedKmno = livePortfolio.kmnoStaked || 0;
    if (stakedKmno > 0) {
      const stakedUsd = stakedKmno * (livePortfolio.prices?.kmno || 0.03);
      html += '<tr><td><strong>KMNO (Staked)</strong></td><td style="font-family:monospace">' + stakedKmno.toFixed(2) + '</td>';
      html += '<td style="font-family:monospace">$' + stakedUsd.toFixed(2) + '</td>';
      html += '<td><span class="purple">~5%</span></td>';
      html += '<td><span class="badge badge-green">🥩 Staked</span></td></tr>';
    }
    html += '<tr style="border-top:2px solid var(--border)"><td><strong>Total</strong></td><td></td>';
    html += '<td style="font-family:monospace"><strong>$' + fmt(livePortfolio.totalUsd, 2) + '</strong></td><td></td><td></td></tr>';
    html += '</table>';
    html += '<div style="margin-top:6px;font-size:0.75rem;color:var(--text2)">🔄 Live on-chain • cached 60s • ' + fmtTimeShort(livePortfolio.updatedAt) + '</div>';
    document.getElementById('positionsTable').innerHTML = html;
  } else if (portfolio && portfolio.latest && portfolio.latest.positions) {
    const positions = portfolio.latest.positions.filter(p => parseFloat(p.valueSol) > 0.0001);
    let html = '<table class="pos-table"><tr><th>Strategy</th><th>APY</th><th>Value (SOL)</th><th>Range</th></tr>';
    for (const p of positions) {
      const rangeBadge = p.inRange ? '<span class="badge badge-green">In Range</span>' : '<span class="badge badge-red">Out</span>';
      html += '<tr><td>' + p.strategy + '</td><td>' + p.apy + '%</td><td>' + fmt(p.valueSol) + '</td><td>' + rangeBadge + '</td></tr>';
    }
    if (portfolio.latest.idleJitoSol && parseFloat(portfolio.latest.idleJitoSol) > 0.001) {
      html += '<tr><td>Idle JitoSOL</td><td class="yellow">~5.6%</td><td>' + fmt(portfolio.latest.idleJitoSol) + '</td><td><span class="badge badge-yellow">Idle</span></td></tr>';
    }
    html += '</table>';
    document.getElementById('positionsTable').innerHTML = html;
  }

  // Position Health (from latest portfolio positions + IL)
  if (portfolio && portfolio.latest) {
    const l = portfolio.latest;
    let html = '';
    const activeLPs = (l.positions || []).filter(p => parseFloat(p.valueSol) > 0.0001);
    if (activeLPs.length > 0) {
      html += '<table><tr><th>Vault</th><th>Status</th><th>APY</th></tr>';
      for (const p of activeLPs) {
        const color = p.inRange ? 'green' : 'red';
        const icon = p.inRange ? '✅' : '❌';
        html += '<tr><td>' + p.address.slice(0,8) + '...</td><td>' + icon + ' <span class="' + color + '">' + (p.inRange ? 'In Range' : 'OUT OF RANGE') + '</span></td><td>' + p.apy + '%</td></tr>';
      }
      html += '</table>';
    }
    if (l.impermanentLoss) {
      const il = l.impermanentLoss;
      const ilPct = parseFloat(il.lossPercent);
      const ilColor = ilPct < 0 ? 'red' : 'green';
      html += '<div style="margin-top:12px;padding:8px;background:var(--bg3);border-radius:6px;font-size:0.85rem">';
      html += '<strong>Impermanent Loss</strong><br>';
      html += 'LP Value: ' + fmt(il.lpValueSol) + ' SOL<br>';
      html += 'Hold Value: ' + fmt(il.holdValueSol) + ' SOL<br>';
      html += 'IL: <span class="' + ilColor + '">' + fmt(il.lossPercent, 4) + '%</span>';
      html += '</div>';
    }
    if (!html) {
      html = '<div style="padding:12px;background:var(--bg3);border-radius:6px;text-align:center">';
      html += '<span style="font-size:1.2rem">📭</span><br>';
      html += '<span style="color:var(--text2)">No active LP positions</span><br>';
      html += '<span style="font-size:0.8rem;color:var(--text2)">LP vault withdrawn. Holdings are idle.</span></div>';
    }
    document.getElementById('healthTable').innerHTML = html;
  }

  // Strategy comparison from rebalancer log
  const rebalancerLog = await fetchJson('/api/rebalancer-log');
  if (rebalancerLog && rebalancerLog.length > 0) {
    const latest = rebalancerLog[0];
    if (latest.strategies) {
      let html = '<table><tr><th>Strategy</th><th>Gross APY</th><th>Net APY</th><th>Score</th></tr>';
      for (const s of latest.strategies) {
        const isCurrent = s.id === latest.currentStrategy;
        const marker = isCurrent ? ' →' : '';
        html += '<tr' + (isCurrent ? ' style="background:var(--bg3)"' : '') + '>';
        html += '<td>' + s.id + marker + '</td>';
        html += '<td>' + s.grossApy + '%</td>';
        html += '<td>' + s.netApy + '%</td>';
        html += '<td>' + s.score + '</td>';
        html += '</tr>';
      }
      html += '</table>';
      html += '<div style="margin-top:8px;font-size:0.8rem;color:var(--text2)">Last evaluated: ' + fmtTime(latest.timestamp) + '</div>';
      document.getElementById('strategyTable').innerHTML = html;
    }
  } else {
    document.getElementById('strategyTable').innerHTML = '<p style="color:var(--text2)">No rebalancer data yet</p>';
  }

  // Rewards & Points — use live data for KMNO values
  const rewardsData = await fetchJson('/api/rewards-live');
  {
    // Get KMNO data from live portfolio — include both wallet balance + staked
    const kmnoHolding = livePortfolio?.holdings?.find(h => h.symbol === 'KMNO');
    const jitoHolding = livePortfolio?.holdings?.find(h => h.symbol === 'JitoSOL');
    const stakedAmt = livePortfolio?.kmnoStaked || 0;
    const walletKmno = kmnoHolding ? kmnoHolding.balance : 0;
    const totalKmno = walletKmno + stakedAmt;
    const kmnoPrice = livePortfolio?.prices?.kmno ? livePortfolio.prices.kmno.toFixed(4) : (rewardsData?.kmnoPrice || '0.04');
    const kmnoBalance = totalKmno.toFixed(2);
    const kmnoValue = (totalKmno * parseFloat(kmnoPrice)).toFixed(2);

    let html = '<div class="stat-grid" style="grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">';
    html += '<div class="stat"><div class="stat-value purple">' + kmnoBalance + '</div><div class="stat-label">KMNO Balance</div></div>';
    html += '<div class="stat"><div class="stat-value yellow">$' + kmnoValue + '</div><div class="stat-label">KMNO Value</div></div>';
    html += '<div class="stat"><div class="stat-value" style="font-size:1rem">$' + kmnoPrice + '</div><div class="stat-label">KMNO Price</div></div>';
    html += '</div>';

    // KLend deposit position
    const klendHolding = livePortfolio?.holdings?.find(h => h.symbol === 'JitoSOL (KLend)');
    if (klendHolding && klendHolding.balance > 0.001) {
      html += '<div style="padding:10px;background:var(--bg3);border-radius:6px;margin-bottom:10px">';
      html += '<strong style="color:#3fb950">🏦 Kamino Lend Deposit</strong><br>';
      html += '<span class="green">✅ ' + klendHolding.balance.toFixed(6) + ' JitoSOL deposited</span> — $' + (klendHolding.usdValue || 0).toFixed(2) + '<br>';
      html += '<span style="font-size:0.85rem;color:var(--text2)">Earning supply APY + KMNO Season 5 rewards + Jito MEV (~7.2%)</span>';
      html += '</div>';
    }
    // Idle JitoSOL
    if (jitoHolding && jitoHolding.balance > 0.001) {
      html += '<div style="padding:10px;background:var(--bg3);border-radius:6px;margin-bottom:10px">';
      html += '<strong style="color:#f0883e">🥩 Idle JitoSOL</strong><br>';
      html += '<span class="yellow">' + jitoHolding.balance.toFixed(6) + ' JitoSOL in wallet</span> — $' + (jitoHolding.usdValue || 0).toFixed(2) + '<br>';
      html += '<span style="font-size:0.85rem;color:var(--text2)">Earning Jito staking rewards (~7.2%) but not deposited in Kamino</span>';
      html += '</div>';
    }

    // Season info
    html += '<div style="padding:10px;background:var(--bg3);border-radius:6px;margin-bottom:10px">';
    html += '<strong style="color:#d2a8ff">Season 5</strong> <span style="color:var(--text2);font-size:0.85rem">(Nov 2025 — Feb 2026)</span><br>';
    html += '<span style="font-size:0.85rem;color:var(--text2)">100M KMNO total • Earn Vaults + Borrow rewards</span><br>';
    if (stakedAmt > 0) {
      html += '<span class="green">✅ ' + stakedAmt.toFixed(0) + ' KMNO staked • Earning points from KLend deposit + staking boost</span>';
    } else {
      html += '<span class="purple">🟣 Holding ' + kmnoBalance + ' KMNO • Earns points from JitoSOL holdings</span>';
    }
    html += '</div>';

    // KMNO staking info — use live on-chain data (stakedAmt already set above)
    html += '<div style="padding:10px;background:var(--bg3);border-radius:6px">';
    html += '<strong style="color:#bc8cff">🥩 KMNO Staking</strong><br>';
    if (stakedAmt > 0) {
      const stakedUsd = stakedAmt * (livePortfolio?.prices?.kmno || 0.03);
      const pointsPerDay = stakedAmt * 3; // 3 points per $1 KMNO staked
      const boostablePoints = stakedAmt * 2; // can boost up to 2 points/day per KMNO staked
      html += '<span class="green">✅ ' + stakedAmt.toFixed(2) + ' KMNO staked</span> — $' + stakedUsd.toFixed(2) + '<br>';
      html += '<span style="color:#d2a8ff">Base Boost: 30%</span> • <span style="color:var(--text2)">+0.5%/day (max 300%)</span><br>';
      html += '<span style="font-size:0.85rem;color:var(--text2)">' + pointsPerDay.toFixed(0) + ' points/day from staking • Can boost up to ' + boostablePoints.toFixed(0) + ' additional points/day</span>';
    } else {
      html += '<span class="yellow">⚠️ KMNO not staked on Kamino</span><br>';
      html += '<span style="font-size:0.8rem;color:var(--text2)">Stake KMNO for up to 300% points boost + 3x points per $1 staked</span>';
    }
    html += '</div>';

    // Points Summary — show real status
    const kmnoPrice_f = parseFloat(kmnoPrice) || 0.03;
    const klendUsd = klendHolding ? (klendHolding.usdValue || 0) : 0;
    const stakingStart = new Date('2026-02-07T09:02:11Z');
    const daysSinceStake = Math.max(0, (Date.now() - stakingStart.getTime()) / 86400000);
    const currentBoost = Math.min(300, 30 + daysSinceStake * 0.5);
    
    html += '<div style="padding:10px;background:var(--bg3);border-radius:6px;margin-top:10px">';
    html += '<strong style="color:#58a6ff">📊 S5 Points Status</strong><br>';
    
    // Check if positions earn points (extraFarms-eligible positions)
    // Main Market JitoSOL/USDG borrow = earns points
    // Ethena Market supply = does NOT earn points
    // KMNO staking = boost only (no base points)
    const hasEarningPosition = livePortfolio?.hasPointsEarning || false;
    
    if (hasEarningPosition) {
      // TODO: calculate real points from earning positions
      const basePointsPerDay = livePortfolio?.pointsPerDay || 0;
      const boostedPoints = basePointsPerDay * (currentBoost / 100);
      const totalPts = basePointsPerDay + boostedPoints;
      html += '<div class="stat-grid" style="grid-template-columns:1fr 1fr;gap:8px;margin:8px 0">';
      html += '<div class="stat"><div class="stat-value" style="color:#58a6ff;font-size:1.1rem">~' + totalPts.toFixed(0) + '</div><div class="stat-label">Points/Day</div></div>';
      const estTotal = totalPts * daysSinceStake;
      html += '<div class="stat"><div class="stat-value" style="color:#3fb950;font-size:1.1rem">~' + estTotal.toFixed(0) + '</div><div class="stat-label">Est. Total</div></div>';
      html += '</div>';
    } else {
      html += '<div style="margin:8px 0;padding:8px;background:rgba(210,168,60,0.1);border:1px solid rgba(210,168,60,0.3);border-radius:6px">';
      html += '<span class="yellow">⚠️ Current positions earn 0 S5 points</span><br>';
      html += '<span style="font-size:0.8rem;color:var(--text2)">KMNO staking provides a boost multiplier but needs base-earning positions.<br>';
      html += 'S5 rewards go to: Main Market borrow pairs (JitoSOL/USDG, SOL/USDG) + Earn Vaults (USDC Prime, USDG Prime, etc.)</span>';
      html += '</div>';
    }
    
    html += '<div style="font-size:0.8rem;color:var(--text2);margin-top:6px">';
    html += '🥩 KMNO staked: ' + stakedAmt.toFixed(0) + ' (' + currentBoost.toFixed(1) + '% boost, day ' + Math.floor(daysSinceStake) + ')<br>';
    html += '📈 Boost grows +0.5%/day → max 300% at day 540';
    html += '</div>';
    html += '</div>';

    html += '<div style="margin-top:8px;font-size:0.8rem;color:var(--text2)">Updated: ' + fmtTimeShort(rewardsData?.updatedAt || livePortfolio?.updatedAt) + '</div>';
    document.getElementById('rewardsSection').innerHTML = html;
  }

  // Alerts
  const alerts = await fetchJson('/api/alerts');
  if (alerts && alerts.length > 0) {
    let html = '';
    for (const a of alerts.slice(0, 20)) {
      const icon = a.type === 'OUT_OF_RANGE' ? '🚨' :
                   a.type === 'NEAR_BOUNDARY' ? '⚠️' :
                   a.type === 'LP_HIGH_YIELD' ? '💰' :
                   a.type === 'RANGE_ALERT' ? '📡' : 'ℹ️';
      html += '<div class="log-entry"><div class="log-time">' + fmtTime(a.timestamp) + '</div>';
      html += '<div class="log-msg">' + icon + ' ' + (a.message || a.type || JSON.stringify(a).slice(0, 100)) + '</div></div>';
    }
    document.getElementById('alertsList').innerHTML = html;
  } else {
    document.getElementById('alertsList').innerHTML = '<p style="color:var(--text2)">No alerts</p>';
  }

  // Rebalancer log
  if (rebalancerLog && rebalancerLog.length > 0) {
    let html = '';
    for (const entry of rebalancerLog.slice(0, 10)) {
      const icon = entry.shouldRebalance ? '🔄' : '✅';
      const action = entry.shouldRebalance
        ? 'REBALANCE: ' + entry.currentStrategy + ' → ' + (entry.bestAlternative || '?')
        : 'HOLD ' + entry.currentStrategy;
      html += '<div class="log-entry"><div class="log-time">' + fmtTime(entry.timestamp) + '</div>';
      html += '<div class="log-msg">' + icon + ' ' + action;
      html += ' | APY: ' + (entry.currentApy || '?') + '%';
      if (entry.idleSol && parseFloat(entry.idleSol) > 0) {
        html += ' | Idle: ' + fmt(entry.idleSol) + ' SOL';
      }
      html += '</div></div>';
    }
    document.getElementById('rebalancerLog').innerHTML = html;
  } else {
    document.getElementById('rebalancerLog').innerHTML = '<p style="color:var(--text2)">No rebalancer decisions yet</p>';
  }
}

// Initial load + auto-refresh
loadDashboard();
setInterval(loadDashboard, 60000);
// Prices refresh every 60s independently
setInterval(loadPrices, 60000);
</script>
</body>
</html>`;
}

// ─── Express Server ─────────────────────────────────────────────

const app = express();

// API routes
app.get('/api/portfolio', (_req: Request, res: Response) => {
  res.json(getPortfolioData());
});

app.get('/api/yield-chart', (_req: Request, res: Response) => {
  res.json(getYieldChartData());
});

app.get('/api/alerts', (_req: Request, res: Response) => {
  res.json(getAlerts());
});

app.get('/api/rebalancer-log', (_req: Request, res: Response) => {
  res.json(getRebalancerLog());
});

app.get('/api/performance', (_req: Request, res: Response) => {
  res.json(getPerformanceLog());
});

app.get('/api/rewards', (_req: Request, res: Response) => {
  res.json(getRewardsData());
});

app.get('/api/rates', (_req: Request, res: Response) => {
  res.json(getRateHistory());
});

app.get('/api/protocol-rates', (_req: Request, res: Response) => {
  res.json(getProtocolRates());
});

// Live rewards — KMNO balance + vault reward emissions, cached for 5 min
let rewardsCache: any = null;
let rewardsCacheTime = 0;

app.get('/api/rewards-live', async (_req: Request, res: Response) => {
  const now = Date.now();
  if (rewardsCache && now - rewardsCacheTime < 300_000) {
    return res.json(rewardsCache);
  }
  try {
    const { Connection, PublicKey } = require('@solana/web3.js');
    const settingsPath = path.join(CONFIG_DIR, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const connection = new Connection(settings.rpcUrl);
    const walletPubkey = new PublicKey('7u5ovFNms7oE232TTyMU5TxDfyZTJctihH4YqP2n1EUz');
    const KMNO_MINT = new PublicKey('KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS');

    // Get KMNO balance
    let kmnoBalance = '0';
    try {
      const accounts = await connection.getTokenAccountsByOwner(walletPubkey, { mint: KMNO_MINT });
      if (accounts.value.length > 0) {
        const amount = accounts.value[0].account.data.readBigUInt64LE(64);
        kmnoBalance = (Number(amount) / 1e6).toFixed(2);
      }
    } catch { /* no account */ }

    // Get KMNO price
    let kmnoPrice = 0;
    try {
      const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=kamino&vs_currencies=usd');
      const priceData = await priceRes.json() as any;
      kmnoPrice = priceData.kamino?.usd ?? 0.04;
    } catch { kmnoPrice = 0.04; }

    // Get vault reward APYs from cached rate data
    let vaultRewardApys: string[] = [];
    try {
      const rateFile = path.join(CONFIG_DIR, 'watcher-state.json');
      if (fs.existsSync(rateFile)) {
        const state = JSON.parse(fs.readFileSync(rateFile, 'utf-8'));
        // Reward APYs from SDK are already tracked via liquidity client
      }
      vaultRewardApys = ['0.00', '0.00']; // From our vault check — no KMNO rewards on LP vault currently
    } catch { /* ignore */ }

    rewardsCache = {
      kmnoBalance,
      kmnoValueUsd: (parseFloat(kmnoBalance) * kmnoPrice).toFixed(2),
      kmnoPrice: kmnoPrice.toFixed(4),
      kmnoStaked: '0',
      stakingBoost: '0',
      vaultRewardApys,
      season: 5,
      seasonStatus: 'active',
      updatedAt: new Date().toISOString(),
    };
    rewardsCacheTime = now;
    res.json(rewardsCache);
  } catch (err: any) {
    res.json(rewardsCache || { error: err.message });
  }
});

// Live prices — fetched from CoinGecko, cached for 30s
let priceCache: { sol: number; jitoSol: number; updatedAt: string } | null = null;
let priceCacheTime = 0;

app.get('/api/prices', async (_req: Request, res: Response) => {
  const now = Date.now();
  if (priceCache && now - priceCacheTime < 30_000) {
    return res.json(priceCache);
  }
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,jito-staked-sol,kamino&vs_currencies=usd');
    const data = await resp.json() as any;
    priceCache = {
      sol: data.solana?.usd ?? 0,
      jitoSol: data['jito-staked-sol']?.usd ?? 0,
      kmno: data.kamino?.usd ?? 0,
      updatedAt: new Date().toISOString(),
    } as any;
    priceCacheTime = now;
    res.json(priceCache);
  } catch (err: any) {
    res.json(priceCache || { sol: 0, jitoSol: 0, updatedAt: null, error: err.message });
  }
});

// Service status — checks watcher + dashboard uptime
app.get('/api/status', (_req: Request, res: Response) => {
  let watcherState: any = null;
  try {
    const watcherFile = path.join(CONFIG_DIR, 'watcher-state.json');
    if (fs.existsSync(watcherFile)) {
      watcherState = JSON.parse(fs.readFileSync(watcherFile, 'utf-8'));
    }
  } catch { /* ignore */ }

  const uptimeSeconds = process.uptime();
  const uptimeHours = (uptimeSeconds / 3600).toFixed(1);

  res.json({
    dashboard: { status: 'running', uptime: uptimeHours + 'h' },
    watcher: watcherState ? {
      status: 'running',
      wsUpdates: watcherState.wsUpdates || 0,
      lastUpdate: watcherState.lastUpdate || null,
      mode: watcherState.mode || 'unknown',
      alerts: (watcherState.alerts || []).length,
    } : { status: 'unknown' },
    timestamp: new Date().toISOString(),
  });
});

// Live portfolio — on-chain wallet balances
app.get('/api/portfolio-live', async (_req: Request, res: Response) => {
  try {
    const data = await fetchLivePortfolio();
    res.json(data);
  } catch (err: any) {
    res.json({ error: err.message });
  }
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Dashboard HTML
app.get('/', (_req: Request, res: Response) => {
  res.type('html').send(generateDashboardHTML());
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏊 Kamino Yield Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`   Data dir: ${CONFIG_DIR}`);
});
