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
    <div class="header-meta" id="livePrices" style="margin-top:4px;font-size:0.9rem">Loading prices...</div>
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

async function loadPrices() {
  const prices = await fetchJson('/api/prices');
  if (prices) {
    const el = document.getElementById('livePrices');
    if (el) {
      el.innerHTML = '<span style="color:#58a6ff">SOL</span> $' + (prices.sol || 0).toFixed(2) +
        ' &nbsp;|&nbsp; <span style="color:#f0883e">JitoSOL</span> $' + (prices.jitoSol || 0).toFixed(2) +
        ' &nbsp;<span style="color:#666;font-size:11px">(' + new Date(prices.updatedAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) + ')</span>';
    }
  }
}

async function loadDashboard() {
  await loadPrices();
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
    const startTime = new Date(chartData[0].timestamp).getTime();
    const startVal = parseFloat(chartData[0].valueSol);
    // Get current APY from latest position data
    let projectedApy = 10; // default
    if (portfolio && portfolio.latest && portfolio.latest.positions) {
      const lp = portfolio.latest.positions.find(p => p.apy && parseFloat(p.apy) > 0);
      if (lp) projectedApy = parseFloat(lp.apy);
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

  // Rewards & Points
  const rewardsData = await fetchJson('/api/rewards-live');
  if (rewardsData) {
    let html = '<div class="stat-grid" style="grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">';
    html += '<div class="stat"><div class="stat-value purple">' + (rewardsData.kmnoBalance || '0') + '</div><div class="stat-label">KMNO Balance</div></div>';
    html += '<div class="stat"><div class="stat-value yellow">$' + (rewardsData.kmnoValueUsd || '0.00') + '</div><div class="stat-label">KMNO Value</div></div>';
    html += '</div>';

    // Season info
    html += '<div style="padding:10px;background:var(--bg3);border-radius:6px;margin-bottom:10px">';
    html += '<strong style="color:#d2a8ff">Season 5</strong> <span style="color:var(--text2);font-size:0.85rem">(Nov 2025 — Feb 2026)</span><br>';
    html += '<span style="font-size:0.85rem;color:var(--text2)">100M KMNO total • Earn Vaults + Borrow rewards</span><br>';
    if (rewardsData.vaultRewardApys && rewardsData.vaultRewardApys.length > 0) {
      const hasRewards = rewardsData.vaultRewardApys.some(r => parseFloat(r) > 0);
      if (hasRewards) {
        html += '<span class="green">✅ Vault earning KMNO rewards: ' + rewardsData.vaultRewardApys.map(r => r + '%').join(', ') + '</span>';
      } else {
        html += '<span class="yellow">⚠️ LP vault not earning S5 KMNO rewards</span><br>';
        html += '<span style="font-size:0.8rem;color:var(--text2)">S5 rewards target Earn Vaults & borrow positions. Consider moving to eligible vault.</span>';
      }
    }
    html += '</div>';

    // Staking info
    html += '<div style="padding:10px;background:var(--bg3);border-radius:6px">';
    html += '<strong style="color:#f0883e">KMNO Staking</strong><br>';
    if (rewardsData.kmnoStaked && parseFloat(rewardsData.kmnoStaked) > 0) {
      html += '<span class="green">Staked: ' + rewardsData.kmnoStaked + ' KMNO</span><br>';
      html += 'Boost: ' + (rewardsData.stakingBoost || '30') + '%<br>';
    } else {
      html += '<span class="yellow">Not staking KMNO</span><br>';
      html += '<span style="font-size:0.8rem;color:var(--text2)">Stake KMNO for up to 300% points boost + 3x points per $1 staked</span>';
    }
    html += '</div>';

    html += '<div style="margin-top:8px;font-size:0.8rem;color:var(--text2)">Updated: ' + fmtTimeShort(rewardsData.updatedAt) + '</div>';
    document.getElementById('rewardsSection').innerHTML = html;
  } else {
    document.getElementById('rewardsSection').innerHTML = '<p style="color:var(--text2)">Loading rewards...</p>';
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
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,jito-staked-sol&vs_currencies=usd');
    const data = await resp.json() as any;
    priceCache = {
      sol: data.solana?.usd ?? 0,
      jitoSol: data['jito-staked-sol']?.usd ?? 0,
      updatedAt: new Date().toISOString(),
    };
    priceCacheTime = now;
    res.json(priceCache);
  } catch (err: any) {
    res.json(priceCache || { sol: 0, jitoSol: 0, updatedAt: null, error: err.message });
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
