/**
 * Kamino Rates — Single Source of Truth
 *
 * Fetches ALL Kamino yields from DeFi Llama + Jito API.
 * This is the authoritative rate source for the optimizer.
 *
 * Products covered:
 * - K-Lend (kamino-lend): supply/borrow rates
 * - Liquidity Vaults (kamino-liquidity): concentrated LP
 * - JitoSOL staking yield (Jito API)
 *
 * Goal: Grow SOL through yield on Kamino.
 */

import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────

export interface KaminoPool {
  /** DeFi Llama pool ID */
  poolId: string;
  /** Token symbol(s) */
  symbol: string;
  /** Product type */
  product: 'klend' | 'liquidity' | 'staking';
  /** Total APY (base + rewards) */
  apy: number;
  /** Base APY (fees/interest only) */
  apyBase: number;
  /** Reward APY (KMNO incentives) */
  apyReward: number;
  /** TVL in USD */
  tvlUsd: number;
  /** Exposure type: single, multi */
  exposure: string;
  /** Whether this involves IL risk */
  hasIlRisk: boolean;
  /** Tokens involved */
  tokens: string[];
  /** Risk level based on TVL + correlation */
  risk: 'low' | 'medium' | 'high';
  /** URL to Kamino UI */
  url: string;
}

export interface KaminoRates {
  timestamp: string;
  /** JitoSOL native staking yield */
  jitoStakingApy: number;
  jitoStakingSource: string;
  /** All Kamino pools */
  pools: KaminoPool[];
  /** Best yield per category */
  best: {
    klendSol: KaminoPool | null;
    klendStablecoin: KaminoPool | null;
    klendLst: KaminoPool | null;
    lpCorrelated: KaminoPool | null;
    lpUncorrelated: KaminoPool | null;
    overall: KaminoPool | null;
  };
}

// ─── Constants ──────────────────────────────────────────────────

const DEFILLAMA_POOLS_URL = 'https://yields.llama.fi/pools';
const JITO_STATS_URL = 'https://kobe.mainnet.jito.network/api/v1/stake_pool_stats';
const CACHE_FILE = path.join(__dirname, '../config/kamino-rates-cache.json');
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Tokens we consider "SOL-correlated" (low IL risk when paired)
const SOL_CORRELATED = new Set([
  'SOL', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'DSOL', 'VSOL',
  'HSOL', 'BONKSOL', 'CGNTSOL', 'STKESOL', 'LAINESOL', 'FWDSOL',
  'DFDVSOL', 'NXSOL',
]);

const STABLECOINS = new Set([
  'USDC', 'USDT', 'PYUSD', 'USDS', 'USDG', 'CASH', 'EURC',
  'FDUSD', 'SYRUPUSDC',
]);

// ─── Cache ──────────────────────────────────────────────────────

interface CacheEntry {
  timestamp: number;
  data: KaminoRates;
}

function loadCache(): CacheEntry | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCache(data: KaminoRates) {
  const entry: CacheEntry = { timestamp: Date.now(), data };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2));
}

// ─── JitoSOL Staking APY ───────────────────────────────────────

async function fetchJitoStakingApy(): Promise<{ apy: number; source: string }> {
  try {
    const res = await fetch(JITO_STATS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const apyEntries = data.apy;
    if (!apyEntries || apyEntries.length === 0) throw new Error('No APY data');
    const latest = apyEntries[apyEntries.length - 1];
    return { apy: latest.data * 100, source: 'jito-api' };
  } catch {
    return { apy: 5.94, source: 'fallback' };
  }
}

// ─── DeFi Llama Kamino Pools ────────────────────────────────────

function classifyPool(symbol: string, project: string): { hasIlRisk: boolean; tokens: string[]; risk: 'low' | 'medium' | 'high' } {
  const tokens = symbol.split('-').map(t => t.trim().toUpperCase());

  // Single asset (K-Lend supply)
  if (tokens.length === 1) {
    return { hasIlRisk: false, tokens, risk: 'low' };
  }

  // Both tokens are SOL-correlated → low IL risk
  if (tokens.every(t => SOL_CORRELATED.has(t))) {
    return { hasIlRisk: false, tokens, risk: 'low' };
  }

  // Both stablecoins → low IL risk
  if (tokens.every(t => STABLECOINS.has(t))) {
    return { hasIlRisk: false, tokens, risk: 'low' };
  }

  // One SOL-correlated + one stablecoin → medium IL risk
  if (tokens.some(t => SOL_CORRELATED.has(t)) && tokens.some(t => STABLECOINS.has(t))) {
    return { hasIlRisk: true, tokens, risk: 'medium' };
  }

  // Everything else → high IL risk
  return { hasIlRisk: true, tokens, risk: 'high' };
}

async function fetchKaminoPools(): Promise<KaminoPool[]> {
  const res = await fetch(DEFILLAMA_POOLS_URL);
  if (!res.ok) throw new Error(`DeFi Llama HTTP ${res.status}`);
  const data = (await res.json() as any).data;

  const kaminoPools = data.filter((p: any) =>
    (p.project === 'kamino-lend' || p.project === 'kamino-liquidity') &&
    p.chain === 'Solana'
  );

  return kaminoPools.map((p: any) => {
    const { hasIlRisk, tokens, risk } = classifyPool(p.symbol || '', p.project || '');
    const product = p.project === 'kamino-lend' ? 'klend' : 'liquidity';
    const isKlend = product === 'klend';

    return {
      poolId: p.pool || '',
      symbol: p.symbol || '?',
      product,
      apy: p.apy || 0,
      apyBase: p.apyBase || 0,
      apyReward: p.apyReward || 0,
      tvlUsd: p.tvlUsd || 0,
      exposure: p.exposure || (isKlend ? 'single' : 'multi'),
      hasIlRisk,
      tokens,
      risk,
      url: isKlend
        ? 'https://app.kamino.finance/lending/reserve/' + (p.pool || '').split('-')[0]
        : 'https://app.kamino.finance/liquidity/' + (p.pool || '').split('-')[0],
    } as KaminoPool;
  });
}

// ─── Main Fetch ─────────────────────────────────────────────────

export async function fetchKaminoRates(forceRefresh = false): Promise<KaminoRates> {
  // Check cache
  if (!forceRefresh) {
    const cached = loadCache();
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
      return cached.data;
    }
  }

  // Fetch in parallel
  const [jitoResult, pools] = await Promise.all([
    fetchJitoStakingApy(),
    fetchKaminoPools(),
  ]);

  // Add JitoSOL staking as a virtual pool
  pools.push({
    poolId: 'jito-staking',
    symbol: 'JITOSOL (staking)',
    product: 'staking',
    apy: jitoResult.apy,
    apyBase: jitoResult.apy,
    apyReward: 0,
    tvlUsd: 0,
    exposure: 'single',
    hasIlRisk: false,
    tokens: ['JITOSOL'],
    risk: 'low',
    url: 'https://stake.jito.network/',
  });

  // Sort by APY descending
  pools.sort((a, b) => b.apy - a.apy);

  // Find best in each category
  const klendPools = pools.filter(p => p.product === 'klend');
  const lpPools = pools.filter(p => p.product === 'liquidity');

  const best = {
    klendSol: klendPools.find(p => p.tokens.includes('SOL') && p.apy > 0) || null,
    klendStablecoin: klendPools.find(p => p.tokens.some(t => STABLECOINS.has(t)) && p.apy > 0) || null,
    klendLst: klendPools.find(p => p.tokens.some(t => SOL_CORRELATED.has(t) && t !== 'SOL') && p.apy > 0) || null,
    lpCorrelated: lpPools.find(p => !p.hasIlRisk && p.apy > 0 && p.tvlUsd > 10000) || null,
    lpUncorrelated: lpPools.find(p => p.hasIlRisk && p.apy > 0 && p.tvlUsd > 100000) || null,
    overall: pools.find(p => p.apy > 0) || null,
  };

  const result: KaminoRates = {
    timestamp: new Date().toISOString(),
    jitoStakingApy: jitoResult.apy,
    jitoStakingSource: jitoResult.source,
    pools,
    best,
  };

  saveCache(result);
  return result;
}

// ─── Pretty Printer ─────────────────────────────────────────────

export function printKaminoRates(rates: KaminoRates) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    🏦 KAMINO YIELD SCANNER                               ║');
  console.log('║                  All Kamino Products — Pure Kamino                        ║');
  console.log(`║                  ${rates.timestamp.padEnd(54)}║`);
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');

  // JitoSOL staking
  console.log(`║  🥩 JitoSOL Staking: ${rates.jitoStakingApy.toFixed(2)}% APY (${rates.jitoStakingSource})              ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');

  // K-Lend (top 10 by APY)
  console.log('║                          📈 K-LEND (Supply)                              ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');
  const klend = rates.pools.filter(p => p.product === 'klend' && p.apy > 0).slice(0, 10);
  for (const p of klend) {
    const sym = p.symbol.padEnd(15);
    const apy = (p.apy.toFixed(2) + '%').padStart(8);
    const tvl = ('$' + (p.tvlUsd / 1e6).toFixed(1) + 'M').padStart(10);
    const risk = p.risk.padEnd(6);
    console.log(`║  ${sym} ${apy}  TVL: ${tvl}  Risk: ${risk}                       ║`);
  }
  if (klend.length === 0) console.log('║  No K-Lend pools with APY > 0                                         ║');

  // Liquidity Vaults — correlated (low IL)
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');
  console.log('║                    🏊 LIQUIDITY VAULTS (Low IL Risk)                     ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');
  const lpLow = rates.pools.filter(p => p.product === 'liquidity' && !p.hasIlRisk && p.apy > 0 && p.tvlUsd > 1000).slice(0, 10);
  for (const p of lpLow) {
    const sym = p.symbol.padEnd(20);
    const apy = (p.apy.toFixed(2) + '%').padStart(8);
    const tvl = ('$' + (p.tvlUsd / 1e6).toFixed(1) + 'M').padStart(10);
    console.log(`║  ${sym} ${apy}  TVL: ${tvl}                                   ║`);
  }
  if (lpLow.length === 0) console.log('║  No low-IL liquidity vaults with APY > 0                              ║');

  // Liquidity Vaults — uncorrelated (higher yield, IL risk)
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');
  console.log('║                    🔥 LIQUIDITY VAULTS (Higher Yield, IL Risk)           ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');
  const lpHigh = rates.pools.filter(p => p.product === 'liquidity' && p.hasIlRisk && p.apy > 0 && p.tvlUsd > 50000).slice(0, 15);
  for (const p of lpHigh) {
    const sym = p.symbol.padEnd(20);
    const apy = (p.apy.toFixed(2) + '%').padStart(8);
    const tvl = ('$' + (p.tvlUsd / 1e6).toFixed(1) + 'M').padStart(10);
    const risk = p.risk.padEnd(6);
    console.log(`║  ${sym} ${apy}  TVL: ${tvl}  Risk: ${risk}                ║`);
  }

  // Best picks
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');
  console.log('║                         🏆 BEST PICKS                                    ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════╣');
  if (rates.best.klendSol) console.log(`║  K-Lend SOL:         ${rates.best.klendSol.apy.toFixed(2)}% APY (TVL: $${(rates.best.klendSol.tvlUsd/1e6).toFixed(1)}M)                    ║`);
  if (rates.best.klendStablecoin) console.log(`║  K-Lend Stablecoin:  ${rates.best.klendStablecoin.symbol} @ ${rates.best.klendStablecoin.apy.toFixed(2)}%                              ║`);
  if (rates.best.lpCorrelated) console.log(`║  LP (low IL):        ${rates.best.lpCorrelated.symbol} @ ${rates.best.lpCorrelated.apy.toFixed(2)}%                          ║`);
  if (rates.best.lpUncorrelated) console.log(`║  LP (high yield):    ${rates.best.lpUncorrelated.symbol} @ ${rates.best.lpUncorrelated.apy.toFixed(2)}%                          ║`);
  console.log(`║  JitoSOL staking:    ${rates.jitoStakingApy.toFixed(2)}% (passive, zero cost)                         ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
}

// ─── CLI ────────────────────────────────────────────────────────

if (require.main === module) {
  fetchKaminoRates(true)
    .then(printKaminoRates)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
