/**
 * Kamino Rates — Pure Kamino API
 *
 * Uses Kamino's own REST API (api.kamino.finance) as the single source of truth.
 * Also fetches JitoSOL staking yield from Jito API.
 *
 * Products:
 * - Liquidity Vaults (strategies/metrics) — concentrated LP with KMNO rewards
 * - K-Lend (klend-sdk on-chain) — lending/borrowing
 * - JitoSOL staking (Jito API) — baseline yield
 *
 * Goal: Grow SOL through yield on Kamino.
 */

import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────

export interface KaminoPool {
  /** Strategy address */
  address: string;
  /** Token pair */
  symbol: string;
  tokenA: string;
  tokenB: string;
  /** Product type */
  product: 'liquidity' | 'klend' | 'staking';
  /** 7-day APY (base fees + KMNO rewards) */
  apy7d: number;
  /** 24-hour APY */
  apy24h: number;
  /** 30-day APY */
  apy30d: number;
  /** Fee APY only (trading fees earned) */
  feeApy: number;
  /** KMNO reward APY */
  rewardApy: number;
  /** Total APY = max(7d, feeApy + rewardApy) */
  totalApy: number;
  /** TVL in USD */
  tvlUsd: number;
  /** Share price */
  sharePrice: number;
  /** Whether this is a correlated pair (low IL) */
  isCorrelated: boolean;
  /** Risk level */
  risk: 'low' | 'medium' | 'high';
}

export interface KaminoRates {
  timestamp: string;
  source: 'kamino-api';
  /** JitoSOL staking yield */
  jitoStakingApy: number;
  jitoStakingSource: string;
  /** All pools sorted by totalApy desc */
  pools: KaminoPool[];
  /** Best picks by category */
  best: {
    /** Best correlated LP (SOL/LST pairs — low IL) */
    correlatedLp: KaminoPool | null;
    /** Best SOL-stablecoin LP (medium IL) */
    solStableLp: KaminoPool | null;
    /** Best overall yield */
    overall: KaminoPool | null;
    /** Best for pure SOL growth (low risk) */
    solGrowth: KaminoPool | null;
  };
  /** Total pools scanned */
  totalPools: number;
  /** Active pools (TVL > $1k) */
  activePools: number;
}

// ─── Constants ──────────────────────────────────────────────────

const KAMINO_API = 'https://api.kamino.finance/strategies/metrics?env=mainnet-beta';
const JITO_API = 'https://kobe.mainnet.jito.network/api/v1/stake_pool_stats';
const CACHE_FILE = path.join(__dirname, '../config/kamino-rates-cache.json');
const CACHE_DURATION_MS = 5 * 60 * 1000;

// SOL-correlated tokens — pairs of these have minimal IL
const SOL_FAMILY = new Set([
  'SOL', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'DSOL', 'VSOL',
  'HSOL', 'BONKSOL', 'CGNTSOL', 'STKESOL', 'LAINESOL', 'FWDSOL',
  'DFDVSOL', 'NXSOL', 'EZSOL', 'KYSOL', 'WFRAGSOL', 'SCNSOL',
]);

const STABLECOINS = new Set([
  'USDC', 'USDT', 'PYUSD', 'USDS', 'USDG', 'CASH', 'EURC',
  'FDUSD', 'SYRUPUSDC', 'USDH', 'UXD', 'USD1', 'HYUSD', 'USDU',
]);

// ─── Cache ──────────────────────────────────────────────────────

function loadCache(): { timestamp: number; data: KaminoRates } | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { return null; }
}

function saveCache(data: KaminoRates) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), data }, null, 2));
}

// ─── Jito Staking APY ──────────────────────────────────────────

async function fetchJitoApy(): Promise<{ apy: number; source: string }> {
  try {
    const res = await fetch(JITO_API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const entries = data.apy;
    if (!entries?.length) throw new Error('No data');
    return { apy: entries[entries.length - 1].data * 100, source: 'jito-api' };
  } catch {
    return { apy: 5.94, source: 'fallback' };
  }
}

// ─── Kamino Strategy Metrics ────────────────────────────────────

function classifyPair(tokenA: string, tokenB: string): { isCorrelated: boolean; risk: 'low' | 'medium' | 'high' } {
  const a = tokenA.toUpperCase();
  const b = tokenB.toUpperCase();

  // Both SOL family → correlated, low IL
  if (SOL_FAMILY.has(a) && SOL_FAMILY.has(b)) return { isCorrelated: true, risk: 'low' };
  // Both stablecoins → correlated, low risk
  if (STABLECOINS.has(a) && STABLECOINS.has(b)) return { isCorrelated: true, risk: 'low' };
  // SOL + stablecoin → uncorrelated, medium risk
  if ((SOL_FAMILY.has(a) && STABLECOINS.has(b)) || (STABLECOINS.has(a) && SOL_FAMILY.has(b))) return { isCorrelated: false, risk: 'medium' };
  // Everything else → high risk
  return { isCorrelated: false, risk: 'high' };
}

async function fetchKaminoStrategies(): Promise<KaminoPool[]> {
  const res = await fetch(KAMINO_API);
  if (!res.ok) throw new Error(`Kamino API HTTP ${res.status}`);
  const data = await res.json() as any[];

  const pools: KaminoPool[] = [];

  for (const s of data) {
    const tvl = parseFloat(s.totalValueLocked || '0');
    if (tvl < 1000) continue; // Skip dust

    const kapy = s.kaminoApy?.vault || {};
    const apy7d = parseFloat(kapy.apy7d || '0') * 100;
    const apy24h = parseFloat(kapy.apy24h || '0') * 100;
    const apy30d = parseFloat(kapy.apy30d || '0') * 100;
    const rewardApy = parseFloat(kapy.krewardsApy7d || '0') * 100;

    const vault = s.apy?.vault || {};
    const feeApy = parseFloat(vault.feeApy || '0') * 100;

    // Total = best estimate of current yield
    const totalApy = Math.max(apy7d, feeApy + rewardApy);
    if (totalApy <= 0 && apy24h <= 0) continue; // No yield

    const { isCorrelated, risk } = classifyPair(s.tokenA, s.tokenB);

    pools.push({
      address: s.strategy || '',
      symbol: `${s.tokenA}-${s.tokenB}`,
      tokenA: s.tokenA,
      tokenB: s.tokenB,
      product: 'liquidity',
      apy7d,
      apy24h,
      apy30d,
      feeApy,
      rewardApy,
      totalApy,
      tvlUsd: tvl,
      sharePrice: parseFloat(s.sharePrice || '0'),
      isCorrelated,
      risk,
    });
  }

  pools.sort((a, b) => b.totalApy - a.totalApy);
  return pools;
}

// ─── Main Fetch ─────────────────────────────────────────────────

export async function fetchKaminoRates(forceRefresh = false): Promise<KaminoRates> {
  if (!forceRefresh) {
    const cached = loadCache();
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
      return cached.data;
    }
  }

  const [jito, pools] = await Promise.all([
    fetchJitoApy(),
    fetchKaminoStrategies(),
  ]);

  // Add JitoSOL staking as virtual pool
  pools.push({
    address: 'jito-staking',
    symbol: 'JITOSOL (staking)',
    tokenA: 'JITOSOL',
    tokenB: '',
    product: 'staking',
    apy7d: jito.apy,
    apy24h: jito.apy,
    apy30d: jito.apy,
    feeApy: jito.apy,
    rewardApy: 0,
    totalApy: jito.apy,
    tvlUsd: 0,
    sharePrice: 1,
    isCorrelated: true,
    risk: 'low',
  });

  pools.sort((a, b) => b.totalApy - a.totalApy);

  // Best picks
  const lpPools = pools.filter(p => p.product === 'liquidity');
  const correlatedLps = lpPools.filter(p => p.isCorrelated && p.tvlUsd > 10000);
  const solStableLps = lpPools.filter(p => p.risk === 'medium' && p.tvlUsd > 50000 &&
    (SOL_FAMILY.has(p.tokenA.toUpperCase()) || SOL_FAMILY.has(p.tokenB.toUpperCase())));

  // For SOL growth: best option that involves SOL or LSTs
  const solPools = pools.filter(p =>
    SOL_FAMILY.has(p.tokenA.toUpperCase()) || SOL_FAMILY.has(p.tokenB.toUpperCase())
  );

  const result: KaminoRates = {
    timestamp: new Date().toISOString(),
    source: 'kamino-api',
    jitoStakingApy: jito.apy,
    jitoStakingSource: jito.source,
    pools,
    best: {
      correlatedLp: correlatedLps[0] || null,
      solStableLp: solStableLps[0] || null,
      overall: pools[0] || null,
      solGrowth: solPools[0] || null,
    },
    totalPools: pools.length,
    activePools: pools.filter(p => p.totalApy > 0).length,
  };

  saveCache(result);
  return result;
}

// ─── Pretty Printer ─────────────────────────────────────────────

export function printKaminoRates(rates: KaminoRates) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    🏦 KAMINO YIELD SCANNER (Kamino API)                      ║');
  console.log(`║  ${rates.timestamp}  |  ${rates.activePools} active pools  |  Source: ${rates.source}    ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║  🥩 JitoSOL Staking: ${rates.jitoStakingApy.toFixed(2)}% APY (${rates.jitoStakingSource})                             ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');

  // Correlated LP (low IL — SOL/LST pairs)
  console.log('║  🏊 CORRELATED LP VAULTS (Low IL — SOL/LST pairs)                            ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  const corr = rates.pools.filter(p => p.isCorrelated && p.product === 'liquidity').slice(0, 8);
  for (const p of corr) {
    console.log(`║  ${p.symbol.padEnd(22)} 7d:${p.apy7d.toFixed(1).padStart(6)}%  fees:${p.feeApy.toFixed(1).padStart(5)}%  KMNO:${p.rewardApy.toFixed(1).padStart(5)}%  TVL:$${(p.tvlUsd/1e6).toFixed(1).padStart(5)}M  ║`);
  }

  // SOL-Stablecoin LP (medium IL, higher yield)
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  🔥 SOL-STABLE LP VAULTS (Medium IL — Higher Yield)                          ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  const solStable = rates.pools.filter(p => p.risk === 'medium' && p.product === 'liquidity').slice(0, 8);
  for (const p of solStable) {
    console.log(`║  ${p.symbol.padEnd(22)} 7d:${p.apy7d.toFixed(1).padStart(6)}%  fees:${p.feeApy.toFixed(1).padStart(5)}%  KMNO:${p.rewardApy.toFixed(1).padStart(5)}%  TVL:$${(p.tvlUsd/1e6).toFixed(1).padStart(5)}M  ║`);
  }

  // Best picks
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  🏆 BEST PICKS FOR SOL GROWTH                                                ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  const b = rates.best;
  if (b.correlatedLp) console.log(`║  Low IL:      ${b.correlatedLp.symbol.padEnd(18)} ${b.correlatedLp.totalApy.toFixed(2)}% total (fees:${b.correlatedLp.feeApy.toFixed(1)}% + KMNO:${b.correlatedLp.rewardApy.toFixed(1)}%)  ║`);
  if (b.solStableLp) console.log(`║  Medium IL:   ${b.solStableLp.symbol.padEnd(18)} ${b.solStableLp.totalApy.toFixed(2)}% total                         ║`);
  if (b.solGrowth) console.log(`║  Best SOL:    ${b.solGrowth.symbol.padEnd(18)} ${b.solGrowth.totalApy.toFixed(2)}% total                         ║`);
  console.log(`║  Baseline:    JITOSOL staking       ${rates.jitoStakingApy.toFixed(2)}% (zero cost, zero risk)          ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
}

// ─── CLI ────────────────────────────────────────────────────────

if (require.main === module) {
  fetchKaminoRates(true)
    .then(printKaminoRates)
    .then(() => process.exit(0))
    .catch(err => { console.error('Error:', err.message); process.exit(1); });
}
