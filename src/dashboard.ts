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

// ─── API endpoints ──────────────────────────────────────────────

function getPortfolioData() {
  const yieldHistory = readJsonlFile('yield-history.jsonl');
  const latest = yieldHistory.length > 0 ? yieldHistory[yieldHistory.length - 1] : null;
  const first = yieldHistory.length > 0 ? yieldHistory[0] : null;

  let earnedSol = '0';
  let earnedUsd = '0';
  let actualApy = '0';
  let daysSinceStart = 0;

  if (first && latest) {
    const startVal = parseFloat(first.portfolioTotalValueSol);
    const endVal = parseFloat(latest.portfolioTotalValueSol);
    const earned = endVal - startVal;
    earnedSol = earned.toFixed(6);
    earnedUsd = (earned * parseFloat(latest.solPriceUsd || '170')).toFixed(2);

    const startTime = new Date(first.timestamp).getTime();
    const endTime = new Date(latest.timestamp).getTime();
    daysSinceStart = Math.max((endTime - startTime) / (1000 * 60 * 60 * 24), 0.01);

    if (startVal > 0 && daysSinceStart > 0) {
      const returnPct = earned / startVal;
      actualApy = (returnPct / daysSinceStart * 365 * 100).toFixed(2);
    }
  }

  return {
    latest,
    first,
    earnedSol,
    earnedUsd,
    actualApy,
    daysSinceStart: daysSinceStart.toFixed(1),
    snapshotCount: yieldHistory.length,
  };
}

function getYieldChartData() {
  const history = readJsonlFile('yield-history.jsonl');
  return history.map(entry => ({
    timestamp: entry.timestamp,
    valueSol: entry.portfolioTotalValueSol,
    valueUsd: entry.portfolioTotalValueUsd,
    cumulativeYieldSol: entry.cumulativeYieldSol,
  }));
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
    <h1>🏊 Kamino Yield Dashboard</h1>
    <div class="header-meta">Wallet: <code id="wallet">...</code> | Last update: <span id="lastUpdate">...</span></div>
  </div>
  <div class="header-meta">Auto-refresh: 60s</div>
</div>

<!-- Portfolio Overview -->
<div class="grid">
  <div class="card card-full">
    <h2>📊 Portfolio Overview</h2>
    <div class="stat-grid" id="portfolioStats">
      <div class="stat"><div class="stat-value" id="totalValueSol">—</div><div class="stat-label">Total (SOL)</div></div>
      <div class="stat"><div class="stat-value" id="totalValueUsd">—</div><div class="stat-label">Total (USD)</div></div>
      <div class="stat"><div class="stat-value green" id="earnedSol">—</div><div class="stat-label">Earned (SOL)</div></div>
      <div class="stat"><div class="stat-value green" id="earnedUsd">—</div><div class="stat-label">Earned (USD)</div></div>
      <div class="stat"><div class="stat-value purple" id="actualApy">—</div><div class="stat-label">Actual APY</div></div>
      <div class="stat"><div class="stat-value" id="trackingDays">—</div><div class="stat-label">Days Tracked</div></div>
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
    <h2>💧 Active Positions</h2>
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

async function loadDashboard() {
  // Portfolio
  const portfolio = await fetchJson('/api/portfolio');
  if (portfolio) {
    const l = portfolio.latest;
    document.getElementById('wallet').textContent =
      l?.walletSolBalance !== undefined ? '7u5ovF...1EUz' : '—';
    document.getElementById('lastUpdate').textContent = l ? fmtTime(l.timestamp) : '—';
    document.getElementById('totalValueSol').textContent = l ? fmt(l.portfolioTotalValueSol) + ' SOL' : '—';
    document.getElementById('totalValueUsd').textContent = l ? '$' + fmt(l.portfolioTotalValueUsd, 2) : '—';
    document.getElementById('earnedSol').textContent = fmt(portfolio.earnedSol, 6) + ' SOL';
    document.getElementById('earnedUsd').textContent = '$' + fmt(portfolio.earnedUsd, 2);
    document.getElementById('actualApy').textContent = portfolio.actualApy + '%';
    document.getElementById('trackingDays').textContent = portfolio.daysSinceStart + 'd (' + portfolio.snapshotCount + ' snaps)';
  }

  // Yield chart
  const chartData = await fetchJson('/api/yield-chart');
  if (chartData && chartData.length > 0) {
    const labels = chartData.map(d => fmtTime(d.timestamp));
    const values = chartData.map(d => parseFloat(d.valueSol));
    const yields = chartData.map(d => parseFloat(d.cumulativeYieldSol || '0'));

    const ctx = document.getElementById('yieldChart').getContext('2d');
    if (yieldChart) yieldChart.destroy();
    yieldChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Total Value (SOL)',
            data: values,
            borderColor: '#58a6ff',
            backgroundColor: 'rgba(88,166,255,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
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

  // Positions
  if (portfolio && portfolio.latest && portfolio.latest.positions) {
    const positions = portfolio.latest.positions;
    let html = '<table class="pos-table"><tr><th>Strategy</th><th>APY</th><th>Value (SOL)</th><th>Range</th></tr>';
    for (const p of positions) {
      const rangeBadge = p.inRange
        ? '<span class="badge badge-green">In Range</span>'
        : '<span class="badge badge-red">Out of Range</span>';
      html += '<tr><td>' + p.strategy + '</td><td>' + p.apy + '%</td><td>' + fmt(p.valueSol) + '</td><td>' + rangeBadge + '</td></tr>';
    }
    if (portfolio.latest.idleJitoSol && parseFloat(portfolio.latest.idleJitoSol) > 0.001) {
      html += '<tr><td>Idle JitoSOL</td><td class="yellow">~5.6%</td><td>' + fmt(portfolio.latest.idleJitoSol) + '</td><td><span class="badge badge-yellow">Idle</span></td></tr>';
    }
    if (portfolio.latest.walletSolBalance && parseFloat(portfolio.latest.walletSolBalance) > 0) {
      html += '<tr><td>SOL (gas)</td><td>0%</td><td>' + fmt(portfolio.latest.walletSolBalance, 6) + '</td><td>—</td></tr>';
    }
    html += '</table>';
    document.getElementById('positionsTable').innerHTML = html;
  }

  // Position Health (from latest portfolio positions + IL)
  if (portfolio && portfolio.latest) {
    const l = portfolio.latest;
    let html = '';
    if (l.positions && l.positions.length > 0) {
      html += '<table><tr><th>Vault</th><th>Status</th><th>APY</th></tr>';
      for (const p of l.positions) {
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
    document.getElementById('healthTable').innerHTML = html || '<p style="color:var(--text2)">No LP positions</p>';
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

  // Rewards
  const rewards = await fetchJson('/api/rewards');
  if (rewards) {
    let html = '';
    if (rewards.kaminoPoints) {
      html += '<div class="stat" style="margin-bottom:8px"><div class="stat-value purple">' + rewards.kaminoPoints.totalPoints + '</div><div class="stat-label">Kamino Points</div></div>';
      if (rewards.kaminoPoints.rank) {
        html += '<div style="font-size:0.85rem;color:var(--text2)">Rank: #' + rewards.kaminoPoints.rank + '</div>';
      }
    }
    if (rewards.jitoPoints) {
      html += '<div class="stat" style="margin-top:8px"><div class="stat-value yellow">' + rewards.jitoPoints.totalPoints + '</div><div class="stat-label">Jito Points</div></div>';
    }
    if (!rewards.kaminoPoints && !rewards.jitoPoints) {
      html = '<p style="color:var(--text2)">No points data available</p>';
    }
    html += '<div style="margin-top:8px;font-size:0.8rem;color:var(--text2)">Last checked: ' + fmtTime(rewards.timestamp) + '</div>';
    document.getElementById('rewardsSection').innerHTML = html;
  } else {
    document.getElementById('rewardsSection').innerHTML = '<p style="color:var(--text2)">No rewards data yet</p>';
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
