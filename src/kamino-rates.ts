/**
 * Kamino Rates — Pure Kamino API
 *
 * All data sourced directly from api.kamino.finance:
 *
 * Endpoints used:
 *   GET /kamino-market?env=mainnet-beta                           → List all markets
 *   GET /kamino-market/{market}/reserves/metrics?env=mainnet-beta → K-Lend supply/borrow APYs
 *   GET /kamino-market/{market}/leverage/metrics                  → Multiply/Leverage positions
 *   GET /strategies/metrics?env=mainnet-beta                     → LP vault APYs (fee + KMNO rewards)
 *
 * Also: Jito API for JitoSOL baseline staking yield.
 *
 * Goal: Grow SOL through yield on Kamino.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────

/** K-Lend reserve (lending market) */
export interface KlendReserve {
  reserve: string;
  liquidityToken: string;
  liquidityTokenMint: string;
  maxLtv: number;
  supplyApy: number;
  borrowApy: number;
  totalSupplyUsd: number;
  totalBorrowUsd: number;
}

/** LP vault (liquidity strategy) */
export interface LpVault {
  address: string;
  tokenA: string;
  tokenB: string;
  symbol: string;
  tvlUsd: number;
  sharePrice: number;
  /** 7-day fee APY (organic, from trading fees) */
  feeApy: number;
  /** 7-day total APY from Kamino (includes KMNO rewards) */
  // totalApy7d: number;  // COMMENTED OUT: ignoring KMNO rewards per strategy
  /** 24h fee APY */
  feeApy24h: number;
  /** Whether tokens are correlated (SOL/LST pairs = low IL) */
  isCorrelated: boolean;
  /** Risk classification */
  risk: 'low' | 'medium' | 'high';
}

/** Multiply/Leverage position metrics */
export interface MultiplyMetrics {
  depositReserve: string;
  borrowReserve: string;
  tag: string;
  tvlUsd: number;
  avgLeverage: number;
  totalDepositedUsd: number;
  totalBorrowedUsd: number;
}

/** Complete Kamino rate snapshot */
export interface KaminoRates {
  timestamp: string;
  source: 'kamino-api';
  /** Primary market address */
  market: string;
  /** JitoSOL native staking APY (baseline) */
  jitoStakingApy: number;
  jitoStakingSource: string;
  /** K-Lend reserves (supply/borrow rates) */
  klendReserves: KlendReserve[];
  /** LP vaults (fee APY only, KMNO rewards excluded) */
  lpVaults: LpVault[];
  /** Multiply/Leverage positions */
  multiplyPositions: MultiplyMetrics[];
  /** Summary for quick decision-making */
  summary: {
    /** Best K-Lend supply APY for SOL */
    klendSolSupplyApy: number;
    /** K-Lend SOL borrow APY (cost of leverage) */
    klendSolBorrowApy: number;
    /** Best K-Lend supply for JitoSOL */
    klendJitosolSupplyApy: number;
    /** Multiply spread: staking APY - borrow APY */
    multiplySpread: number;
    /** Best correlated LP fee APY (low IL) */
    bestCorrelatedLpFeeApy: number;
    bestCorrelatedLpSymbol: string;
    /** Best SOL-stablecoin LP fee APY (medium IL) */
    bestSolStableLpFeeApy: number;
    bestSolStableLpSymbol: string;
  };
}

// ─── Constants ──────────────────────────────────────────────────

const KAMINO_BASE = 'https://api.kamino.finance';
const PRIMARY_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const JITO_API = 'https://kobe.mainnet.jito.network/api/v1/stake_pool_stats';
const CACHE_FILE = path.join(__dirname, '../config/kamino-rates-cache.json');
const CACHE_DURATION_MS = 5 * 60 * 1000;

// SOL-correlated tokens — pairs of these have minimal IL
const SOL_FAMILY = new Set([
  'SOL', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'DSOL', 'VSOL',
  'HSOL', 'BONKSOL', 'CGNTSOL', 'STKESOL', 'LAINESOL', 'FWDSOL',
  'DFDVSOL', 'NXSOL', 'EZSOL', 'KYSOL', 'WFRAGSOL', 'SCNSOL',
  'PICOSL', 'JSOL', 'BBSOL', 'HUBSOL', 'STRONGSOL', 'LANTERNSOL',
  'CDCSOL', 'BNSOL', 'PSOL', 'ONYC',
]);

const STABLECOINS = new Set([
  'USDC', 'USDT', 'PYUSD', 'USDS', 'USDG', 'CASH', 'EURC',
  'FDUSD', 'SYRUPUSDC', 'USDH', 'UXD', 'USD1', 'HYUSD', 'USDU',
  'PRIME', 'PST',
]);

// ─── Cache ──────────────────────────────────────────────────────

function loadCache(): { timestamp: number; data: KaminoRates } | null {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); }
  catch { return null; }
}

function saveCache(data: KaminoRates) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), data }, null, 2));
}

// ─── API Fetchers ───────────────────────────────────────────────

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchJitoApy(): Promise<{ apy: number; source: string }> {
  try {
    const data = await fetchJson(JITO_API);
    const entries = data.apy;
    if (!entries?.length) throw new Error('No data');
    return { apy: entries[entries.length - 1].data * 100, source: 'jito-api' };
  } catch {
    return { apy: 5.94, source: 'fallback' };
  }
}

async function fetchKlendReserves(market: string): Promise<KlendReserve[]> {
  const data = await fetchJson(`${KAMINO_BASE}/kamino-market/${market}/reserves/metrics?env=mainnet-beta`);
  return data
    .map((r: any) => ({
      reserve: r.reserve || '',
      liquidityToken: r.liquidityToken || '?',
      liquidityTokenMint: r.liquidityTokenMint || '',
      maxLtv: parseFloat(r.maxLtv || '0'),
      supplyApy: parseFloat(r.supplyApy || '0') * 100,
      borrowApy: parseFloat(r.borrowApy || '0') * 100,
      totalSupplyUsd: parseFloat(r.totalSupplyUsd || '0'),
      totalBorrowUsd: parseFloat(r.totalBorrowUsd || '0'),
    }))
    .filter((r: KlendReserve) => r.totalSupplyUsd > 100); // skip dust
}

function classifyPair(a: string, b: string): { isCorrelated: boolean; risk: 'low' | 'medium' | 'high' } {
  const au = a.toUpperCase(), bu = b.toUpperCase();
  if (SOL_FAMILY.has(au) && SOL_FAMILY.has(bu)) return { isCorrelated: true, risk: 'low' };
  if (STABLECOINS.has(au) && STABLECOINS.has(bu)) return { isCorrelated: true, risk: 'low' };
  if ((SOL_FAMILY.has(au) && STABLECOINS.has(bu)) || (STABLECOINS.has(au) && SOL_FAMILY.has(bu)))
    return { isCorrelated: false, risk: 'medium' };
  return { isCorrelated: false, risk: 'high' };
}

async function fetchLpVaults(): Promise<LpVault[]> {
  const data = await fetchJson(`${KAMINO_BASE}/strategies/metrics?env=mainnet-beta`);
  const vaults: LpVault[] = [];

  for (const s of data) {
    const tvl = parseFloat(s.totalValueLocked || '0');
    if (tvl < 1000) continue;

    const vault = s.apy?.vault || {};
    const feeApy = parseFloat(vault.feeApy || '0') * 100;

    const kapy = s.kaminoApy?.vault || {};
    const apy24h = parseFloat(kapy.apy24h || '0') * 100;

    // STRATEGY: Only use fee APY (organic yield). KMNO rewards commented out.
    // const rewardApy = parseFloat(kapy.krewardsApy7d || '0') * 100;

    const { isCorrelated, risk } = classifyPair(s.tokenA, s.tokenB);

    vaults.push({
      address: s.strategy || '',
      tokenA: s.tokenA,
      tokenB: s.tokenB,
      symbol: `${s.tokenA}-${s.tokenB}`,
      tvlUsd: tvl,
      sharePrice: parseFloat(s.sharePrice || '0'),
      feeApy,
      feeApy24h: apy24h, // 24h snapshot for trend
      isCorrelated,
      risk,
    });
  }

  return vaults.sort((a, b) => b.feeApy - a.feeApy);
}

async function fetchMultiplyMetrics(market: string): Promise<MultiplyMetrics[]> {
  try {
    const data = await fetchJson(`${KAMINO_BASE}/kamino-market/${market}/leverage/metrics`);
    return data
      .filter((p: any) => parseFloat(p.tvl || '0') > 1000)
      .map((p: any) => ({
        depositReserve: p.depositReserve || '',
        borrowReserve: p.borrowReserve || '',
        tag: p.tag || '',
        tvlUsd: parseFloat(p.tvl || '0'),
        avgLeverage: parseFloat(p.avgLeverage || '0'),
        totalDepositedUsd: parseFloat(p.totalDepositedUsd || '0'),
        totalBorrowedUsd: parseFloat(p.totalBorrowedUsd || '0'),
      }));
  } catch {
    return [];
  }
}

// ─── Main Fetch ─────────────────────────────────────────────────

export async function fetchKaminoRates(forceRefresh = false): Promise<KaminoRates> {
  if (!forceRefresh) {
    const cached = loadCache();
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
      return cached.data;
    }
  }

  const [jito, klendReserves, lpVaults, multiplyPositions] = await Promise.all([
    fetchJitoApy(),
    fetchKlendReserves(PRIMARY_MARKET),
    fetchLpVaults(),
    fetchMultiplyMetrics(PRIMARY_MARKET),
  ]);

  // Build summary
  const solReserve = klendReserves.find(r => r.liquidityToken === 'SOL');
  const jitosolReserve = klendReserves.find(r => r.liquidityToken === 'JITOSOL');

  const correlatedLps = lpVaults
    .filter(v => v.isCorrelated && v.feeApy > 0)
    .sort((a, b) => b.feeApy - a.feeApy);

  const solStableLps = lpVaults
    .filter(v => v.risk === 'medium' && v.feeApy > 0 &&
      (SOL_FAMILY.has(v.tokenA.toUpperCase()) || SOL_FAMILY.has(v.tokenB.toUpperCase())))
    .sort((a, b) => b.feeApy - a.feeApy);

  const klendSolSupplyApy = solReserve?.supplyApy || 0;
  const klendSolBorrowApy = solReserve?.borrowApy || 0;
  const klendJitosolSupplyApy = jitosolReserve?.supplyApy || 0;
  const multiplySpread = jito.apy - klendSolBorrowApy;

  const result: KaminoRates = {
    timestamp: new Date().toISOString(),
    source: 'kamino-api',
    market: PRIMARY_MARKET,
    jitoStakingApy: jito.apy,
    jitoStakingSource: jito.source,
    klendReserves,
    lpVaults,
    multiplyPositions,
    summary: {
      klendSolSupplyApy,
      klendSolBorrowApy,
      klendJitosolSupplyApy,
      multiplySpread,
      bestCorrelatedLpFeeApy: correlatedLps[0]?.feeApy || 0,
      bestCorrelatedLpSymbol: correlatedLps[0]?.symbol || 'none',
      bestSolStableLpFeeApy: solStableLps[0]?.feeApy || 0,
      bestSolStableLpSymbol: solStableLps[0]?.symbol || 'none',
    },
  };

  saveCache(result);
  return result;
}

// ─── Pretty Printer ─────────────────────────────────────────────

export function printKaminoRates(rates: KaminoRates) {
  const s = rates.summary;
  const line = '─'.repeat(78);

  console.log('');
  console.log(`┌${line}┐`);
  console.log(`│  🏦 KAMINO YIELD SCANNER — Pure Kamino API                                    │`);
  console.log(`│  ${rates.timestamp}                                                   │`);
  console.log(`│  Source: api.kamino.finance  |  Market: ${rates.market.slice(0, 8)}...                     │`);
  console.log(`├${line}┤`);

  // Baseline
  console.log(`│  🥩 JitoSOL staking: ${rates.jitoStakingApy.toFixed(2)}% APY (${rates.jitoStakingSource})                              │`);
  console.log(`├${line}┤`);

  // K-Lend
  console.log(`│  📈 K-LEND SUPPLY/BORROW (fee APY only)                                      │`);
  console.log(`├${line}┤`);
  const topKlend = rates.klendReserves
    .filter(r => r.supplyApy > 0.01)
    .sort((a, b) => b.supplyApy - a.supplyApy)
    .slice(0, 12);
  for (const r of topKlend) {
    const sym = r.liquidityToken.padEnd(12);
    const sup = (r.supplyApy.toFixed(2) + '%').padStart(8);
    const bor = (r.borrowApy.toFixed(2) + '%').padStart(8);
    const tvl = ('$' + (r.totalSupplyUsd / 1e6).toFixed(1) + 'M').padStart(10);
    const ltv = (r.maxLtv * 100).toFixed(0) + '%';
    console.log(`│  ${sym} supply:${sup}  borrow:${bor}  TVL:${tvl}  LTV:${ltv.padStart(4)}           │`);
  }

  // LP Vaults — correlated
  console.log(`├${line}┤`);
  console.log(`│  🏊 LP VAULTS — Correlated Pairs (Low IL) — Fee APY Only                     │`);
  console.log(`├${line}┤`);
  const corrVaults = rates.lpVaults.filter(v => v.isCorrelated && v.feeApy > 0).slice(0, 8);
  if (corrVaults.length === 0) {
    console.log(`│  No correlated LP vaults with fee APY > 0                                    │`);
  }
  for (const v of corrVaults) {
    const sym = v.symbol.padEnd(22);
    const fee = (v.feeApy.toFixed(2) + '%').padStart(8);
    const tvl = ('$' + (v.tvlUsd / 1e6).toFixed(1) + 'M').padStart(8);
    console.log(`│  ${sym} fee:${fee}  TVL:${tvl}                                     │`);
  }

  // LP Vaults — SOL/stablecoin
  console.log(`├${line}┤`);
  console.log(`│  🔥 LP VAULTS — SOL/Stablecoin (Medium IL) — Fee APY Only                    │`);
  console.log(`├${line}┤`);
  const solStable = rates.lpVaults.filter(v => v.risk === 'medium' && v.feeApy > 0).slice(0, 8);
  for (const v of solStable) {
    const sym = v.symbol.padEnd(22);
    const fee = (v.feeApy.toFixed(2) + '%').padStart(8);
    const tvl = ('$' + (v.tvlUsd / 1e6).toFixed(1) + 'M').padStart(8);
    console.log(`│  ${sym} fee:${fee}  TVL:${tvl}                                     │`);
  }

  // Decision summary
  console.log(`├${line}┤`);
  console.log(`│  🏆 DECISION SUMMARY                                                         │`);
  console.log(`├${line}┤`);
  console.log(`│  JitoSOL staking:           ${s.klendSolSupplyApy > 0 ? rates.jitoStakingApy.toFixed(2) : '?.??'}% (baseline, zero cost)                      │`);
  console.log(`│  K-Lend SOL supply:         ${s.klendSolSupplyApy.toFixed(2)}%                                              │`);
  console.log(`│  K-Lend JitoSOL supply:     ${s.klendJitosolSupplyApy.toFixed(2)}% (+ ${rates.jitoStakingApy.toFixed(2)}% staking = ${(s.klendJitosolSupplyApy + rates.jitoStakingApy).toFixed(2)}% total)            │`);
  console.log(`│  Multiply spread:           ${s.multiplySpread.toFixed(2)}% (staking - borrow) ${s.multiplySpread > 0 ? '✅ profitable' : '❌ unprofitable'}       │`);
  console.log(`│  Best correlated LP:        ${s.bestCorrelatedLpSymbol} @ ${s.bestCorrelatedLpFeeApy.toFixed(2)}% fee APY               │`);
  console.log(`│  Best SOL/stable LP:        ${s.bestSolStableLpSymbol} @ ${s.bestSolStableLpFeeApy.toFixed(2)}% fee APY               │`);
  console.log(`└${line}┘`);
}

// ─── CLI ────────────────────────────────────────────────────────

if (require.main === module) {
  fetchKaminoRates(true)
    .then(printKaminoRates)
    .then(() => process.exit(0))
    .catch(err => { console.error('Error:', err.message); process.exit(1); });
}
