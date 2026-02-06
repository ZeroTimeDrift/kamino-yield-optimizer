import fetch from 'node-fetch';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Connection } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { VaultInfo, Settings } from './types';
import { KaminoClient } from './kamino-client';

// ─── Interface Definitions ──────────────────────────────────────

export interface ProtocolYield {
  protocol: string;        // "kamino", "marginfi", "drift", etc
  pool: string;            // "K-Lend SOL Supply", "JITOSOL-SOL LP", etc
  type: 'lending' | 'lp' | 'staking' | 'leverage';
  tokenIn: string;         // What you deposit
  apy: number;             // Total APY %
  apyBase: number;         // Base APY (fees/interest)
  apyReward: number;       // Reward APY (token incentives)
  tvl: number;             // USD TVL
  risk: 'low' | 'medium' | 'high';  // Based on TVL, audit status, protocol maturity
  url: string;             // Direct link to the pool
  notes: string;           // Any caveats
}

interface DefiLlamaPool {
  chain: string;
  project: string;
  symbol: string;
  pool: string;
  apy: number;
  apyBase: number;
  apyReward: number;
  tvlUsd: number;
  url?: string;
  underlyingTokens?: string[];
  poolMeta?: string;
  exposure?: string;
  il7d?: number;
  apyBase7d?: number;
  predictions?: {
    predictedClass: string;
    predictedProbability: number;
  };
}

interface CacheEntry {
  timestamp: number;
  data: ProtocolYield[];
}

// ─── Configuration ──────────────────────────────────────────────

const CACHE_FILE = '/root/clawd/skills/kamino-yield/config/protocol-rates.json';
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes in milliseconds
const DEFILLAMA_API = 'https://yields.llama.fi/pools';

// Known protocol risk assessments based on TVL, audits, track record
const PROTOCOL_RISK: { [key: string]: 'low' | 'medium' | 'high' } = {
  'kamino': 'low',
  'solend': 'low',
  'marginfi': 'medium',
  'drift': 'medium',
  'meteora': 'medium',
  'raydium': 'low',
  'orca': 'low',
  'marinade': 'low',
  'jito': 'low'
};

// Protocol URLs
const PROTOCOL_URLS: { [key: string]: string } = {
  'kamino': 'https://app.kamino.finance/lending',
  'solend': 'https://solend.fi/dashboard',
  'marginfi': 'https://app.marginfi.com/',
  'drift': 'https://app.drift.trade/',
  'meteora': 'https://app.meteora.ag/vaults',
  'raydium': 'https://raydium.io/clmm/',
  'orca': 'https://www.orca.so/pools',
  'marinade': 'https://marinade.finance/',
  'jito': 'https://stake.jito.network/'
};

// ─── Utility Functions ──────────────────────────────────────────

function loadCache(): CacheEntry | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(data) as CacheEntry;
  } catch (error) {
    console.warn(`Failed to load cache: ${error}`);
    return null;
  }
}

function saveCache(data: ProtocolYield[]): void {
  try {
    const cacheEntry: CacheEntry = {
      timestamp: Date.now(),
      data
    };
    writeFileSync(CACHE_FILE, JSON.stringify(cacheEntry, null, 2));
    console.log(`✅ Cached ${data.length} yield opportunities`);
  } catch (error) {
    console.warn(`Failed to save cache: ${error}`);
  }
}

function isCacheValid(cache: CacheEntry | null): boolean {
  if (!cache) return false;
  return (Date.now() - cache.timestamp) < CACHE_DURATION;
}

function normalizeTokenSymbol(symbol: string): string {
  // Normalize common token name variations
  const normalized = symbol.toUpperCase();
  if (normalized.includes('JITO')) return 'JITOSOL';
  if (normalized.includes('MSOL')) return 'MSOL';
  if (normalized.includes('STSOL')) return 'STSOL';
  if (normalized === 'WSOL') return 'SOL';
  return normalized;
}

function assessRisk(protocol: string, tvl: number): 'low' | 'medium' | 'high' {
  const baseRisk = PROTOCOL_RISK[protocol.toLowerCase()] || 'high';
  
  // Adjust based on TVL
  if (tvl > 10_000_000 && baseRisk !== 'high') {
    return baseRisk === 'medium' ? 'low' : 'low';
  }
  if (tvl > 1_000_000 && baseRisk === 'high') {
    return 'medium';
  }
  
  return baseRisk;
}

// ─── DefiLlama Integration ──────────────────────────────────────

async function fetchDefiLlamaYields(): Promise<ProtocolYield[]> {
  console.log('🔄 Fetching yields from DefiLlama API...');
  
  try {
    const response = await fetch(DEFILLAMA_API);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const pools = await response.json() as { data: DefiLlamaPool[] };
    
    // Filter for Solana + our target tokens
    const relevantPools = pools.data.filter(pool => 
      pool.chain === 'Solana' && 
      pool.tvlUsd > 10000 && // Minimum TVL filter
      pool.apy !== null &&
      (
        pool.symbol.includes('SOL') ||
        pool.symbol.includes('JITO') ||
        pool.symbol.includes('mSOL') ||
        pool.symbol.includes('stSOL')
      )
    );
    
    console.log(`📊 Found ${relevantPools.length} relevant Solana pools`);
    
    return relevantPools.map(pool => {
      const protocol = pool.project.toLowerCase();
      const tokenIn = normalizeTokenSymbol(pool.symbol.split('-')[0]);
      
      return {
        protocol,
        pool: `${pool.project} ${pool.symbol}`,
        type: pool.symbol.includes('-') ? 'lp' : 'lending',
        tokenIn,
        apy: pool.apy || 0,
        apyBase: pool.apyBase || 0,
        apyReward: pool.apyReward || 0,
        tvl: pool.tvlUsd,
        risk: assessRisk(protocol, pool.tvlUsd),
        url: pool.url || PROTOCOL_URLS[protocol] || '',
        notes: pool.poolMeta || ''
      } as ProtocolYield;
    });
    
  } catch (error) {
    console.error(`❌ Failed to fetch DefiLlama data: ${error}`);
    return [];
  }
}

// ─── Kamino Direct Integration ──────────────────────────────────

async function fetchKaminoYields(): Promise<ProtocolYield[]> {
  console.log('🔄 Fetching Kamino yields via SDK...');
  
  try {
    const settings: Settings = JSON.parse(readFileSync('/root/clawd/skills/kamino-yield/config/settings.json', 'utf-8'));
    
    // Use KaminoClient to get reserves
    const kaminoClient = new KaminoClient(settings.rpcUrl);
    await kaminoClient.initialize();
    const kaminoVaults = await kaminoClient.getReserves();
    
    const yields: ProtocolYield[] = kaminoVaults.map((vault: VaultInfo) => ({
      protocol: 'kamino',
      pool: `K-Lend ${vault.name}`,
      type: vault.type === 'lp' ? 'lp' : 'lending',
      tokenIn: vault.token.toUpperCase(),
      apy: vault.apy.toNumber(),
      apyBase: vault.apy.toNumber(), // K-Lend is mostly base yield
      apyReward: 0,
      tvl: vault.tvlUsd.toNumber(),
      risk: 'low', // Kamino is well-audited with high TVL
      url: 'https://app.kamino.finance/lending',
      notes: `Deposit fee: ${vault.depositFeePercent.toNumber()}%, Withdrawal fee: ${vault.withdrawalFeePercent.toNumber()}%`
    }));
    
    console.log(`📊 Found ${yields.length} Kamino lending pools`);
    return yields;
    
  } catch (error) {
    console.error(`❌ Failed to fetch Kamino data: ${error}`);
    return [];
  }
}

// ─── Main Scanner Functions ─────────────────────────────────────

export async function scanAllProtocols(): Promise<ProtocolYield[]> {
  console.log('🚀 Starting multi-protocol yield scan...');
  
  // Check cache first
  const cache = loadCache();
  if (isCacheValid(cache)) {
    console.log('✅ Using cached data (< 10 minutes old)');
    return cache!.data;
  }
  
  // Fetch fresh data
  const [defiLlamaYields, kaminoYields] = await Promise.all([
    fetchDefiLlamaYields(),
    fetchKaminoYields()
  ]);
  
  // Combine and deduplicate
  const allYields = [...kaminoYields, ...defiLlamaYields];
  
  // Remove duplicates (prefer Kamino direct data over DefiLlama)
  const uniqueYields = allYields.filter((yield1, index, self) => 
    index === self.findIndex(yield2 => 
      yield2.protocol === yield1.protocol && 
      yield2.tokenIn === yield1.tokenIn &&
      yield2.type === yield1.type
    )
  );
  
  // Sort by APY descending
  const sortedYields = uniqueYields.sort((a, b) => b.apy - a.apy);
  
  // Cache results
  saveCache(sortedYields);
  
  console.log(`✅ Found ${sortedYields.length} yield opportunities across ${new Set(sortedYields.map(y => y.protocol)).size} protocols`);
  
  return sortedYields;
}

export async function getBestOpportunity(token: 'SOL' | 'JITOSOL', type?: string): Promise<ProtocolYield | null> {
  const allYields = await scanAllProtocols();
  
  const filtered = allYields.filter(y => {
    const tokenMatch = y.tokenIn === token || 
      (token === 'SOL' && ['SOL', 'WSOL'].includes(y.tokenIn)) ||
      (token === 'JITOSOL' && ['JITOSOL', 'JITO', 'jitoSOL'].includes(y.tokenIn));
    
    const typeMatch = !type || y.type === type;
    
    return tokenMatch && typeMatch;
  });
  
  if (filtered.length === 0) return null;
  
  // Return highest APY
  return filtered[0];
}

export async function compareToCurrentPosition(currentApy: number): Promise<{
  betterOpportunities: ProtocolYield[];
  potentialGains: number[];
}> {
  const allYields = await scanAllProtocols();
  
  const betterOpportunities = allYields
    .filter(y => y.apy > currentApy)
    .slice(0, 10); // Top 10 alternatives
  
  const potentialGains = betterOpportunities.map(y => y.apy - currentApy);
  
  return {
    betterOpportunities,
    potentialGains
  };
}

// ─── CLI Interface ─────────────────────────────────────────────

export async function main() {
  try {
    console.log('📈 Multi-Protocol Yield Scanner');
    console.log('================================');
    
    // Scan all protocols
    const yields = await scanAllProtocols();
    
    // Display top opportunities by token
    const tokens = ['SOL', 'JITOSOL'];
    
    for (const token of tokens) {
      console.log(`\n🪙 Best ${token} Opportunities:`);
      console.log('-'.repeat(50));
      
      const tokenYields = yields
        .filter(y => y.tokenIn === token || 
          (token === 'SOL' && ['SOL', 'WSOL'].includes(y.tokenIn)) ||
          (token === 'JITOSOL' && ['JITOSOL', 'JITO', 'jitoSOL'].includes(y.tokenIn)))
        .slice(0, 5);
      
      if (tokenYields.length === 0) {
        console.log('  No opportunities found');
        continue;
      }
      
      tokenYields.forEach((y, index) => {
        console.log(`  ${index + 1}. ${y.pool}`);
        console.log(`     Protocol: ${y.protocol.toUpperCase()}`);
        console.log(`     APY: ${y.apy.toFixed(2)}% (Base: ${y.apyBase.toFixed(2)}%, Reward: ${y.apyReward.toFixed(2)}%)`);
        console.log(`     TVL: $${(y.tvl / 1_000_000).toFixed(1)}M`);
        console.log(`     Risk: ${y.risk.toUpperCase()}`);
        console.log(`     Type: ${y.type}`);
        if (y.notes) console.log(`     Notes: ${y.notes}`);
        console.log('');
      });
    }
    
    // Summary statistics
    console.log('\n📊 Summary:');
    console.log('-'.repeat(20));
    const protocols = [...new Set(yields.map(y => y.protocol))];
    console.log(`Protocols scanned: ${protocols.join(', ')}`);
    console.log(`Total opportunities: ${yields.length}`);
    console.log(`Highest APY: ${yields[0]?.apy.toFixed(2)}% (${yields[0]?.protocol} - ${yields[0]?.pool})`);
    
    const avgApy = yields.reduce((sum, y) => sum + y.apy, 0) / yields.length;
    console.log(`Average APY: ${avgApy.toFixed(2)}%`);
    
    // Risk breakdown
    const riskBreakdown = yields.reduce((acc, y) => {
      acc[y.risk] = (acc[y.risk] || 0) + 1;
      return acc;
    }, {} as { [key: string]: number });
    
    console.log('\nRisk distribution:');
    Object.entries(riskBreakdown).forEach(([risk, count]) => {
      console.log(`  ${risk}: ${count} pools`);
    });
    
  } catch (error) {
    console.error(`❌ Scanner failed: ${error}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}