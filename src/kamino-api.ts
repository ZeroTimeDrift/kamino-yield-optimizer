/**
 * Kamino REST API Client — Centralized
 *
 * All read operations go through api.kamino.finance REST endpoints.
 * This eliminates heavy SDK/RPC calls for rate data, reserves, and positions.
 *
 * Endpoints used:
 *   GET /v2/kamino-market                                          → List all markets
 *   GET /kamino-market/{market}/reserves/metrics?env=mainnet-beta  → Reserve supply/borrow APYs
 *   GET /kamino-market/{market}/leverage/metrics                   → Multiply/Leverage positions
 *   GET /kamino-market/{market}/users/{wallet}/obligations         → User K-Lend obligations
 *   GET /strategies/metrics?env=mainnet-beta                       → LP vault APYs
 *   GET /kvaults/vaults                                            → KVault list
 *   GET /kvaults/vaults/{pubkey}/metrics                           → KVault metrics
 *   GET /kvaults/users/{pubkey}/positions                          → User KVault positions
 *
 * Also: Jito API for JitoSOL baseline staking yield.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Constants ──────────────────────────────────────────────────

export const KAMINO_BASE = 'https://api.kamino.finance';
export const JITO_API = 'https://kobe.mainnet.jito.network/api/v1/stake_pool_stats';
export const KAMINO_TOKENS_API = 'https://api.kamino.finance/tokens';
export const SANCTUM_API = 'https://extra-api.sanctum.so/v1/apy/latest';

const CACHE_DIR = path.join(__dirname, '../config');
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// SOL-correlated tokens — pairs of these have minimal IL
export const SOL_FAMILY = new Set([
  'SOL', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'DSOL', 'VSOL',
  'HSOL', 'BONKSOL', 'CGNTSOL', 'STKESOL', 'LAINESOL', 'FWDSOL',
  'DFDVSOL', 'NXSOL', 'EZSOL', 'KYSOL', 'WFRAGSOL', 'SCNSOL',
  'PICOSL', 'JSOL', 'BBSOL', 'HUBSOL', 'STRONGSOL', 'LANTERNSOL',
  'CDCSOL', 'BNSOL', 'PSOL', 'ONYC',
]);

export const STABLECOINS = new Set([
  'USDC', 'USDT', 'PYUSD', 'USDS', 'USDG', 'CASH', 'EURC',
  'FDUSD', 'SYRUPUSDC', 'USDH', 'UXD', 'USD1', 'HYUSD', 'USDU',
  'PRIME', 'PST',
]);

// ─── Types ──────────────────────────────────────────────────────

/** K-Lend reserve from REST API */
export interface ApiReserve {
  reserve: string;
  liquidityToken: string;
  liquidityTokenMint: string;
  maxLtv: number;
  supplyApy: number;     // percentage (e.g. 5.5 = 5.5%)
  borrowApy: number;     // percentage
  totalSupplyUsd: number;
  totalBorrowUsd: number;
}

/** LP vault/strategy from REST API */
export interface ApiLpVault {
  address: string;
  tokenA: string;
  tokenB: string;
  symbol: string;
  tvlUsd: number;
  sharePrice: number;
  feeApy: number;        // percentage (7d fee APY)
  feeApy24h: number;     // percentage (24h fee APY)
  isCorrelated: boolean;
  risk: 'low' | 'medium' | 'high';
}

/** Multiply/Leverage metrics from REST API */
export interface ApiMultiplyMetrics {
  depositReserve: string;
  borrowReserve: string;
  tag: string;
  tvlUsd: number;
  avgLeverage: number;
  totalDepositedUsd: number;
  totalBorrowedUsd: number;
}

/** User obligation (K-Lend position) from REST API */
export interface ApiObligation {
  obligationAddress: string;
  tag: string;
  deposits: ApiObligationDeposit[];
  borrows: ApiObligationBorrow[];
  depositedValue: number;
  borrowedValue: number;
  allowedBorrowValue: number;
  unhealthyBorrowValue: number;
  netAccountValue: number;
  loanToValue: number;
}

export interface ApiObligationDeposit {
  reserveAddress: string;
  mintAddress: string;
  symbol: string;
  depositedAmount: number;
  marketValue: number;
}

export interface ApiObligationBorrow {
  reserveAddress: string;
  mintAddress: string;
  symbol: string;
  borrowedAmount: number;
  marketValue: number;
}

/** Jito staking APY result */
export interface JitoApyResult {
  apy: number;   // percentage
  source: string;
}

/** Market info from /v2/kamino-market */
export interface ApiMarketInfo {
  marketPubkey: string;
  marketName: string;
}

// ─── Generic Fetch Helper ───────────────────────────────────────

async function fetchJson(url: string, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Cache Helper ───────────────────────────────────────────────

interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

function loadCache<T>(cacheKey: string): T | null {
  try {
    const filePath = path.join(CACHE_DIR, `cache-${cacheKey}.json`);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CacheEntry<T>;
    if (Date.now() - raw.timestamp < CACHE_DURATION_MS) {
      return raw.data;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCache<T>(cacheKey: string, data: T): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const filePath = path.join(CACHE_DIR, `cache-${cacheKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ timestamp: Date.now(), data }, null, 2));
  } catch {
    // Cache write failure is non-fatal
  }
}

// ─── API Fetchers ───────────────────────────────────────────────

/**
 * Fetch JitoSOL native staking APY from Jito API.
 */
export async function fetchJitoApy(): Promise<JitoApyResult> {
  try {
    const data = await fetchJson(JITO_API);
    const entries = data.apy;
    if (!entries?.length) throw new Error('No data');
    const latest = entries[entries.length - 1];
    const apyPercent = latest.data * 100;

    // Also compute 7-day average for logging
    const recentEntries = entries.slice(-7);
    const avgApy = recentEntries.reduce((sum: number, e: any) => sum + e.data, 0) / recentEntries.length * 100;

    return { apy: apyPercent, source: 'jito-api-live' };
  } catch {
    return { apy: 5.94, source: 'fallback' };
  }
}

/**
 * List all Kamino markets from /v2/kamino-market.
 */
export async function fetchMarkets(): Promise<ApiMarketInfo[]> {
  const cached = loadCache<ApiMarketInfo[]>('markets');
  if (cached) return cached;

  const data = await fetchJson(`${KAMINO_BASE}/v2/kamino-market`);
  const markets = (data || []).map((m: any) => ({
    marketPubkey: m.marketPubkey || m.address || '',
    marketName: m.marketName || m.name || 'Unknown',
  }));

  saveCache('markets', markets);
  return markets;
}

/**
 * Fetch K-Lend reserves with supply/borrow APYs for a given market.
 */
export async function fetchReserves(marketPubkey: string): Promise<ApiReserve[]> {
  const cacheKey = `reserves-${marketPubkey.slice(0, 8)}`;
  const cached = loadCache<ApiReserve[]>(cacheKey);
  if (cached) return cached;

  const data = await fetchJson(
    `${KAMINO_BASE}/kamino-market/${marketPubkey}/reserves/metrics?env=mainnet-beta`
  );

  const reserves: ApiReserve[] = data
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
    .filter((r: ApiReserve) => r.totalSupplyUsd > 100); // skip dust

  saveCache(cacheKey, reserves);
  return reserves;
}

/**
 * Fetch LP vault/strategy metrics from /strategies/metrics.
 */
export async function fetchLpVaults(): Promise<ApiLpVault[]> {
  const cached = loadCache<ApiLpVault[]>('lp-vaults');
  if (cached) return cached;

  const data = await fetchJson(`${KAMINO_BASE}/strategies/metrics?env=mainnet-beta`);
  const vaults: ApiLpVault[] = [];

  for (const s of data) {
    const tvl = parseFloat(s.totalValueLocked || '0');
    if (tvl < 1000) continue;

    const vault = s.apy?.vault || {};
    const feeApy = parseFloat(vault.feeApy || '0') * 100;

    const kapy = s.kaminoApy?.vault || {};
    const apy24h = parseFloat(kapy.apy24h || '0') * 100;

    const { isCorrelated, risk } = classifyPair(s.tokenA, s.tokenB);

    vaults.push({
      address: s.strategy || '',
      tokenA: s.tokenA,
      tokenB: s.tokenB,
      symbol: `${s.tokenA}-${s.tokenB}`,
      tvlUsd: tvl,
      sharePrice: parseFloat(s.sharePrice || '0'),
      feeApy,
      feeApy24h: apy24h,
      isCorrelated,
      risk,
    });
  }

  vaults.sort((a, b) => b.feeApy - a.feeApy);
  saveCache('lp-vaults', vaults);
  return vaults;
}

/**
 * Fetch Multiply/Leverage metrics for a given market.
 */
export async function fetchMultiplyMetrics(marketPubkey: string): Promise<ApiMultiplyMetrics[]> {
  const cacheKey = `multiply-${marketPubkey.slice(0, 8)}`;
  const cached = loadCache<ApiMultiplyMetrics[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson(
      `${KAMINO_BASE}/kamino-market/${marketPubkey}/leverage/metrics`
    );
    const metrics = data
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

    saveCache(cacheKey, metrics);
    return metrics;
  } catch {
    return [];
  }
}

/**
 * Fetch user's K-Lend obligations (positions) for a given market.
 *
 * The API returns raw on-chain data. Structure:
 * - `state.deposits[]` — raw deposit structs with `depositReserve` + `depositedAmount`
 * - `state.borrows[]` — raw borrow structs with `borrowReserve` + `borrowedAmount`
 * - `refreshedStats` — computed values: userTotalDeposit, userTotalBorrow, netAccountValue, etc.
 * - Top-level `deposits` and `borrows` may be empty objects or friendly arrays depending on API version
 *
 * We parse both formats and cross-reference with reserves for token symbols.
 */
export async function fetchUserObligations(
  marketPubkey: string,
  walletPubkey: string
): Promise<ApiObligation[]> {
  try {
    const data = await fetchJson(
      `${KAMINO_BASE}/kamino-market/${marketPubkey}/users/${walletPubkey}/obligations`
    );

    if (!Array.isArray(data)) return [];

    // Pre-fetch reserves to resolve reserve addresses → token symbols
    let reserveMap: Map<string, ApiReserve> = new Map();
    try {
      const reserves = await fetchReserves(marketPubkey);
      for (const r of reserves) {
        reserveMap.set(r.reserve, r);
      }
    } catch {}

    return data.map((o: any) => {
      const stats = o.refreshedStats || {};
      const tag = o.obligationTag || o.tag || '';

      // Parse deposits — try top-level friendly format first, then raw state
      let deposits: ApiObligationDeposit[] = [];
      const topDeposits = o.deposits;
      if (Array.isArray(topDeposits) && topDeposits.length > 0) {
        // Friendly array format
        deposits = topDeposits.map((d: any) => ({
          reserveAddress: d.reserveAddress || d.reserve || '',
          mintAddress: d.mintAddress || d.mint || '',
          symbol: d.symbol || d.liquidityToken || '?',
          depositedAmount: parseFloat(d.depositedAmount || d.amount || '0'),
          marketValue: parseFloat(d.marketValue || d.marketValueRefreshed || '0'),
        }));
      } else if (o.state?.deposits) {
        // Raw on-chain format — parse from state
        const NULL_RESERVE = '11111111111111111111111111111111';
        for (const d of o.state.deposits) {
          if (!d.depositReserve || d.depositReserve === NULL_RESERVE) continue;
          const amount = parseFloat(d.depositedAmount || '0');
          if (amount <= 0) continue;
          const reserve = reserveMap.get(d.depositReserve);
          const symbol = reserve?.liquidityToken || '?';
          const decimals = reserve ? Math.log10(Math.max(1, reserve.totalSupplyUsd / (amount || 1))) : 9;
          // Use refreshedStats for total value, or estimate from reserve data
          deposits.push({
            reserveAddress: d.depositReserve,
            mintAddress: reserve?.liquidityTokenMint || '',
            symbol,
            depositedAmount: amount,
            marketValue: 0, // will use refreshedStats total instead
          });
        }
      }

      // Parse borrows — same dual format
      let borrows: ApiObligationBorrow[] = [];
      const topBorrows = o.borrows;
      if (Array.isArray(topBorrows) && topBorrows.length > 0) {
        borrows = topBorrows.map((b: any) => ({
          reserveAddress: b.reserveAddress || b.reserve || '',
          mintAddress: b.mintAddress || b.mint || '',
          symbol: b.symbol || b.liquidityToken || '?',
          borrowedAmount: parseFloat(b.borrowedAmount || b.amount || '0'),
          marketValue: parseFloat(b.marketValue || b.marketValueRefreshed || '0'),
        }));
      } else if (o.state?.borrows) {
        const NULL_RESERVE = '11111111111111111111111111111111';
        // Kamino SF (Scale Factor) format: values are in a fixed-point representation
        // borrowedAmountSf is the raw scaled amount — divide by 2^60 to get the base unit amount
        // Then divide by 10^decimals for the UI amount
        // Alternative: use borrowedAmountOutsideElevationGroups as a base-unit approximation
        const SF_DIVISOR = 2 ** 60; // Kamino uses 60-bit fixed point
        for (const b of o.state.borrows) {
          if (!b.borrowReserve || b.borrowReserve === NULL_RESERVE) continue;
          const reserve = reserveMap.get(b.borrowReserve);
          const symbol = reserve?.liquidityToken || '?';
          
          // Try multiple sources for borrow amount (in base units)
          let baseAmount = 0;
          if (b.borrowedAmountSf) {
            // SF format: divide by 2^60 to get base units
            baseAmount = parseFloat(b.borrowedAmountSf) / SF_DIVISOR;
          } else if (b.borrowedAmount) {
            baseAmount = parseFloat(b.borrowedAmount);
          } else if (b.borrowedAmountOutsideElevationGroups) {
            baseAmount = parseFloat(b.borrowedAmountOutsideElevationGroups);
          }
          
          if (baseAmount <= 0) continue;
          
          // Convert base units to UI amount (9 decimals for SOL/LSTs, 6 for USDC, etc.)
          const decimals = symbol === 'USDC' || symbol === 'USDT' ? 6 : 9;
          const uiAmount = baseAmount / (10 ** decimals);
          
          borrows.push({
            reserveAddress: b.borrowReserve,
            mintAddress: reserve?.liquidityTokenMint || '',
            symbol,
            borrowedAmount: uiAmount,
            marketValue: 0,
          });
        }
      }

      // Use refreshedStats for USD values (most accurate)
      const depositedValue = parseFloat(stats.userTotalDeposit || o.depositedValue || '0');
      const borrowedValue = parseFloat(stats.userTotalBorrow || o.borrowedValue || '0');
      const netAccountValue = parseFloat(stats.netAccountValue || o.netAccountValue || '0');
      const allowedBorrowValue = parseFloat(stats.borrowLimit || o.allowedBorrowValue || '0');
      const unhealthyBorrowValue = parseFloat(stats.borrowLiquidationLimit || o.unhealthyBorrowValue || '0');
      const loanToValue = parseFloat(stats.borrowUtilization || o.loanToValue || '0');

      return {
        obligationAddress: o.obligationAddress || '',
        tag,
        deposits,
        borrows,
        depositedValue,
        borrowedValue,
        allowedBorrowValue,
        unhealthyBorrowValue,
        netAccountValue,
        loanToValue,
      };
    });
  } catch (err: any) {
    console.log(`   ⚠️  Could not fetch obligations: ${err.message}`);
    return [];
  }
}

// ─── Helper Functions ───────────────────────────────────────────

export function classifyPair(a: string, b: string): { isCorrelated: boolean; risk: 'low' | 'medium' | 'high' } {
  const au = a.toUpperCase(), bu = b.toUpperCase();
  if (SOL_FAMILY.has(au) && SOL_FAMILY.has(bu)) return { isCorrelated: true, risk: 'low' };
  if (STABLECOINS.has(au) && STABLECOINS.has(bu)) return { isCorrelated: true, risk: 'low' };
  if ((SOL_FAMILY.has(au) && STABLECOINS.has(bu)) || (STABLECOINS.has(au) && SOL_FAMILY.has(bu)))
    return { isCorrelated: false, risk: 'medium' };
  return { isCorrelated: false, risk: 'high' };
}

/**
 * Find a reserve by token symbol in a list of reserves.
 */
export function findReserve(reserves: ApiReserve[], symbol: string): ApiReserve | undefined {
  return reserves.find(r => r.liquidityToken.toUpperCase() === symbol.toUpperCase());
}

/**
 * Find a reserve by mint address.
 */
export function findReserveByMint(reserves: ApiReserve[], mint: string): ApiReserve | undefined {
  return reserves.find(r => r.liquidityTokenMint === mint);
}

/**
 * Find a reserve by its reserve (account) address.
 * Useful for cross-referencing multiply/leverage metrics
 * which return depositReserve/borrowReserve as pubkeys.
 */
export function findReserveByAddress(reserves: ApiReserve[], reserveAddress: string): ApiReserve | undefined {
  return reserves.find(r => r.reserve === reserveAddress);
}

/**
 * Build a map of reserve address → token symbol for a market.
 * Used to resolve pubkeys from leverage/metrics into readable names.
 */
export async function buildReserveSymbolMap(marketPubkey: string): Promise<Map<string, string>> {
  const reserves = await fetchReserves(marketPubkey);
  const map = new Map<string, string>();
  for (const r of reserves) {
    map.set(r.reserve, r.liquidityToken);
  }
  return map;
}

// ─── Token Metadata ─────────────────────────────────────────────

/** Token metadata from Kamino API */
export interface TokenMetadata {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  logoUri?: string;
  coingeckoId?: string;
}

/**
 * Fetch token metadata and logos from Kamino API.
 * Returns token information including logo URIs for UI display.
 */
export async function fetchTokenMetadata(): Promise<TokenMetadata[]> {
  try {
    const response = await fetch(KAMINO_TOKENS_API);
    if (!response.ok) {
      console.warn(`Failed to fetch token metadata: ${response.status}`);
      return [];
    }

    const tokens = await response.json() as any[];
    
    // Transform API response to our interface
    // API returns: { address, symbol, name, decimals, logoURI, extensions: { coingeckoId } }
    return tokens.map((token: any) => ({
      symbol: token.symbol || token.name,
      name: token.name || token.symbol,
      mint: token.address || token.mint,
      decimals: token.decimals || 9,
      logoUri: token.logoURI || token.logoUri || token.logo_uri || token.image,
      coingeckoId: token.extensions?.coingeckoId || token.coingecko_id || token.coingecko
    }));
  } catch (err) {
    console.warn('Error fetching token metadata:', err);
    return [];
  }
}

/**
 * Get token logo URI by symbol.
 */
export function getTokenLogo(tokenMetadata: TokenMetadata[], symbol: string): string | null {
  const token = tokenMetadata.find(t => t.symbol.toUpperCase() === symbol.toUpperCase());
  return token?.logoUri || null;
}

/**
 * Get token logo URI by mint address.
 */
export function getTokenLogoByMint(tokenMetadata: TokenMetadata[], mint: string): string | null {
  const token = tokenMetadata.find(t => t.mint === mint);
  return token?.logoUri || null;
}

// In-memory cache for token metadata (refreshed every 30 minutes)
let tokenMetadataCache: TokenMetadata[] | null = null;
let tokenMetadataCacheTime = 0;
const TOKEN_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch token metadata with in-memory caching.
 */
export async function fetchTokenMetadataCached(): Promise<TokenMetadata[]> {
  const now = Date.now();
  if (tokenMetadataCache && now - tokenMetadataCacheTime < TOKEN_CACHE_TTL) {
    return tokenMetadataCache;
  }
  tokenMetadataCache = await fetchTokenMetadata();
  tokenMetadataCacheTime = now;
  return tokenMetadataCache;
}

// ─── Sanctum LST Yield API ─────────────────────────────────────

/** LST staking yield from Sanctum */
export interface LstYield {
  symbol: string;
  mint: string;
  stakingApy: number; // percentage (e.g. 7.2 = 7.2%)
  source: string;
}

/**
 * Fetch native staking yields for LSTs from Sanctum API.
 * Returns Map<mintAddress, apyPercent>.
 * Caches for 5 minutes. Falls back gracefully if Sanctum is down.
 */
export async function fetchLstYields(mints: string[]): Promise<Map<string, number>> {
  if (mints.length === 0) return new Map();

  const cacheKey = 'sanctum-lst-yields';
  const cached = loadCache<Record<string, number>>(cacheKey);
  if (cached) {
    // Return cached data filtered to requested mints
    const result = new Map<string, number>();
    for (const mint of mints) {
      if (cached[mint] !== undefined) result.set(mint, cached[mint]);
    }
    // If we have data for most mints, return cached
    if (result.size >= mints.length * 0.5) return result;
  }

  try {
    const params = mints.map(m => `lst=${m}`).join('&');
    const url = `${SANCTUM_API}?${params}`;
    const data = await fetchJson(url);

    const apys = data?.apys;
    if (!apys || typeof apys !== 'object') {
      throw new Error('Invalid Sanctum response: no apys field');
    }

    const result = new Map<string, number>();
    const cacheObj: Record<string, number> = {};

    for (const [mint, apyStr] of Object.entries(apys)) {
      const apy = parseFloat(apyStr as string);
      if (!isNaN(apy)) {
        const apyPercent = apy * 100;
        result.set(mint, apyPercent);
        cacheObj[mint] = apyPercent;
      }
    }

    saveCache(cacheKey, cacheObj);
    return result;
  } catch (err: any) {
    console.log(`   ⚠️  Sanctum API failed: ${err.message}. Using fallback.`);
    // Return empty map — callers should handle missing data
    return new Map();
  }
}

// ─── Multi-LST Multiply Scanner ────────────────────────────────

/** Known Kamino market addresses for scanning */
const SCAN_MARKETS = [
  { name: 'Main', address: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF' },
  { name: 'Jito', address: 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek' },
  { name: 'Altcoins', address: 'ByYiZxp8QrdN9qbdtaAiePN8AAr3qvTPppNJDpf5DVJ5' },
];

/** A single multiply opportunity: LST × market combo */
export interface MultiplyOpportunity {
  symbol: string;
  mint: string;
  market: string;
  marketAddress: string;
  nativeYield: number;     // from Sanctum (percentage)
  solBorrowApy: number;    // from Kamino reserves (percentage)
  spread: number;          // nativeYield - solBorrowApy
  netApy2x: number;
  netApy3x: number;
  netApy5x: number;
  maxLtv: number;          // from reserve data (0-1)
  maxLeverage: number;     // 1 / (1 - maxLtv)
  bestNetApy: number;      // net APY at max safe leverage (maxLev * 0.8)
  profitable: boolean;
}

/**
 * Calculate net APY at a given leverage for multiply.
 * net = stakingApy * leverage - borrowApy * (leverage - 1)
 */
function calcMultiplyNetApy(stakingApy: number, borrowApy: number, leverage: number): number {
  return stakingApy * leverage - borrowApy * (leverage - 1);
}

/**
 * Scan all LST × market multiply opportunities using real Sanctum yields.
 *
 * 1. Fetches reserves from all 3 Kamino markets
 * 2. Identifies SOL-family LSTs (excluding SOL itself) from reserves
 * 3. Fetches real staking yields from Sanctum in one batch
 * 4. Calculates spreads, net APYs, max leverage for each combo
 * 5. Returns sorted by bestNetApy descending
 */
export async function scanMultiplyOpportunities(): Promise<MultiplyOpportunity[]> {
  const opportunities: MultiplyOpportunity[] = [];

  // Step 1+2: Fetch reserves from all markets and identify LSTs
  const marketReserves: { name: string; address: string; reserves: ApiReserve[] }[] = [];
  const lstMintSet = new Set<string>();
  const lstMintToSymbol = new Map<string, string>();

  for (const market of SCAN_MARKETS) {
    try {
      const reserves = await fetchReserves(market.address);
      marketReserves.push({ name: market.name, address: market.address, reserves });

      for (const r of reserves) {
        const sym = r.liquidityToken.toUpperCase();
        // It's an LST if it's in SOL_FAMILY but not SOL itself
        if (SOL_FAMILY.has(sym) && sym !== 'SOL') {
          lstMintSet.add(r.liquidityTokenMint);
          lstMintToSymbol.set(r.liquidityTokenMint, r.liquidityToken);
        }
      }
    } catch (err: any) {
      console.log(`   ⚠️  Failed to fetch reserves for ${market.name}: ${err.message}`);
    }
  }

  const lstMints = Array.from(lstMintSet);
  if (lstMints.length === 0) return opportunities;

  // Step 3: Fetch real staking yields from Sanctum
  const sanctumYields = await fetchLstYields(lstMints);

  // Step 4: For each LST × market combo, calculate opportunity
  for (const { name: marketName, address: marketAddress, reserves } of marketReserves) {
    // Find SOL reserve in this market for borrow cost
    const solReserve = reserves.find(r => r.liquidityToken.toUpperCase() === 'SOL');
    if (!solReserve || solReserve.borrowApy <= 0) continue;

    const solBorrowApy = solReserve.borrowApy;

    for (const r of reserves) {
      const sym = r.liquidityToken.toUpperCase();
      if (!SOL_FAMILY.has(sym) || sym === 'SOL') continue;

      const mint = r.liquidityTokenMint;
      const nativeYield = sanctumYields.get(mint);

      // Skip if Sanctum didn't return yield for this LST
      if (nativeYield === undefined) continue;

      const maxLtv = r.maxLtv > 0 ? r.maxLtv : 0.85;
      const maxLeverage = maxLtv < 1 ? 1 / (1 - maxLtv) : 10;
      const safeLeverage = maxLeverage * 0.8; // 80% of max for safety margin

      const spread = nativeYield - solBorrowApy;
      const netApy2x = calcMultiplyNetApy(nativeYield, solBorrowApy, 2);
      const netApy3x = calcMultiplyNetApy(nativeYield, solBorrowApy, 3);
      const netApy5x = calcMultiplyNetApy(nativeYield, solBorrowApy, 5);
      const bestNetApy = calcMultiplyNetApy(nativeYield, solBorrowApy, safeLeverage);

      opportunities.push({
        symbol: r.liquidityToken,
        mint,
        market: marketName,
        marketAddress,
        nativeYield,
        solBorrowApy,
        spread,
        netApy2x,
        netApy3x,
        netApy5x,
        maxLtv,
        maxLeverage,
        bestNetApy,
        profitable: spread > 0 && bestNetApy > 0,
      });
    }
  }

  // Step 5: Sort by bestNetApy descending
  opportunities.sort((a, b) => b.bestNetApy - a.bestNetApy);

  return opportunities;
}
