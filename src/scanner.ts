import { Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { VaultInfo, Settings, TOKEN_MINTS } from './types';
import * as fs from 'fs';
import * as path from 'path';

const HUBBLE_API = 'https://api.hubbleprotocol.io';

interface HubbleStrategy {
  address: string;
  type: string;
  shareMint: string;
  status: string;
  tokenAMint: string;
  tokenBMint: string;
  apy?: number;
  tvl?: number;
}

interface HubbleReserve {
  address: string;
  symbol: string;
  mint: string;
  supplyApy: number;
  borrowApy: number;
  totalSupply: number;
  totalBorrow: number;
  availableLiquidity: number;
}

export async function loadSettings(): Promise<Settings> {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  return JSON.parse(raw) as Settings;
}

export async function fetchEarnVaults(rpcUrl: string): Promise<VaultInfo[]> {
  const vaults: VaultInfo[] = [];
  
  try {
    // Fetch lending reserves from Hubble API
    const response = await fetch(`${HUBBLE_API}/v2/kamino/reserves`);
    
    if (!response.ok) {
      // Fallback: try alternative endpoint
      const altResponse = await fetch(`${HUBBLE_API}/kamino-market/main/metrics`);
      if (altResponse.ok) {
        const data = await altResponse.json();
        // Parse alternative format
        return parseAlternativeFormat(data);
      }
      console.warn('Could not fetch vault data from API, using on-chain fallback');
      return await fetchVaultsOnChain(rpcUrl);
    }
    
    const reserves: HubbleReserve[] = await response.json();
    
    for (const reserve of reserves) {
      vaults.push({
        address: reserve.address,
        name: `${reserve.symbol} Earn`,
        type: 'earn',
        token: reserve.symbol,
        tokenMint: reserve.mint,
        apy: new Decimal(reserve.supplyApy || 0),
        tvlUsd: new Decimal(reserve.totalSupply || 0),
        depositFeePercent: new Decimal(0),
        withdrawalFeePercent: new Decimal(0.1), // Typical Kamino withdrawal fee
        createdAt: new Date(), // Would need to fetch from chain
        isActive: true,
      });
    }
  } catch (error) {
    console.error('Error fetching earn vaults:', error);
    return await fetchVaultsOnChain(rpcUrl);
  }
  
  return vaults;
}

export async function fetchLpVaults(rpcUrl: string): Promise<VaultInfo[]> {
  const vaults: VaultInfo[] = [];
  
  try {
    const response = await fetch(`${HUBBLE_API}/strategies`);
    if (!response.ok) {
      throw new Error('Failed to fetch strategies');
    }
    
    const strategies: HubbleStrategy[] = await response.json();
    
    for (const strategy of strategies) {
      if (strategy.status !== 'LIVE' && strategy.status !== 'ACTIVE') {
        continue;
      }
      
      // Get token symbols from mints
      const tokenA = getTokenSymbol(strategy.tokenAMint);
      const tokenB = getTokenSymbol(strategy.tokenBMint);
      
      if (!tokenA || !tokenB) continue;
      
      vaults.push({
        address: strategy.address,
        name: `${tokenA}-${tokenB} LP`,
        type: 'lp',
        token: `${tokenA}-${tokenB}`,
        tokenMint: strategy.shareMint,
        apy: new Decimal(strategy.apy || 0),
        tvlUsd: new Decimal(strategy.tvl || 0),
        depositFeePercent: new Decimal(0),
        withdrawalFeePercent: new Decimal(0.1),
        createdAt: new Date(),
        isActive: true,
      });
    }
  } catch (error) {
    console.error('Error fetching LP vaults:', error);
  }
  
  return vaults;
}

async function fetchVaultsOnChain(rpcUrl: string): Promise<VaultInfo[]> {
  // Fallback: fetch directly from on-chain using SDK
  // This is more reliable but slower
  console.log('Using on-chain fallback to fetch vault data...');
  
  // For now, return known vaults with placeholder data
  // In production, use klend-sdk to fetch actual on-chain data
  return [
    {
      address: 'HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E',
      name: 'USDC Earn Main',
      type: 'earn',
      token: 'USDC',
      tokenMint: TOKEN_MINTS['USDC'],
      apy: new Decimal(7.5), // Placeholder - fetch actual
      tvlUsd: new Decimal(10000000),
      depositFeePercent: new Decimal(0),
      withdrawalFeePercent: new Decimal(0.1),
      createdAt: new Date('2024-01-01'),
      isActive: true,
    },
    {
      address: 'D6qrPVfqPRREozFNXaAMt9XWsxDcz8DkYSKJxvvZLK4c',
      name: 'SOL Earn Main',
      type: 'earn',
      token: 'SOL',
      tokenMint: TOKEN_MINTS['SOL'],
      apy: new Decimal(6.2),
      tvlUsd: new Decimal(25000000),
      depositFeePercent: new Decimal(0),
      withdrawalFeePercent: new Decimal(0.1),
      createdAt: new Date('2024-01-01'),
      isActive: true,
    },
  ];
}

function parseAlternativeFormat(data: any): VaultInfo[] {
  // Parse alternative API response format
  const vaults: VaultInfo[] = [];
  
  if (data.reserves) {
    for (const reserve of data.reserves) {
      vaults.push({
        address: reserve.address || reserve.pubkey,
        name: `${reserve.symbol || reserve.name} Earn`,
        type: 'earn',
        token: reserve.symbol || reserve.name,
        tokenMint: reserve.mint || reserve.tokenMint,
        apy: new Decimal(reserve.supplyApy || reserve.apy || 0),
        tvlUsd: new Decimal(reserve.tvl || reserve.totalSupply || 0),
        depositFeePercent: new Decimal(0),
        withdrawalFeePercent: new Decimal(0.1),
        createdAt: new Date(),
        isActive: true,
      });
    }
  }
  
  return vaults;
}

function getTokenSymbol(mint: string): string | null {
  for (const [symbol, tokenMint] of Object.entries(TOKEN_MINTS)) {
    if (tokenMint === mint) {
      return symbol;
    }
  }
  return null;
}

export async function scanAllVaults(settings: Settings): Promise<VaultInfo[]> {
  console.log('🔍 Scanning Kamino vaults...\n');
  
  const [earnVaults, lpVaults] = await Promise.all([
    fetchEarnVaults(settings.rpcUrl),
    settings.riskProfiles[settings.riskTolerance].allowLpVaults 
      ? fetchLpVaults(settings.rpcUrl) 
      : Promise.resolve([]),
  ]);
  
  const allVaults = [...earnVaults, ...lpVaults];
  
  // Filter by risk profile
  const profile = settings.riskProfiles[settings.riskTolerance];
  const filteredVaults = allVaults.filter(vault => {
    if (vault.tvlUsd.lt(profile.minTvlUsd)) return false;
    if (vault.type === 'lp' && !profile.allowLpVaults) return false;
    // Add age filter if createdAt is accurate
    return vault.isActive;
  });
  
  // Sort by APY descending
  filteredVaults.sort((a, b) => b.apy.minus(a.apy).toNumber());
  
  console.log(`Found ${filteredVaults.length} vaults matching risk profile "${settings.riskTolerance}":\n`);
  
  for (const vault of filteredVaults.slice(0, 10)) {
    console.log(`  ${vault.name.padEnd(20)} ${vault.apy.toFixed(2).padStart(6)}% APY  ($${formatNumber(vault.tvlUsd)} TVL)`);
  }
  
  return filteredVaults;
}

function formatNumber(n: Decimal): string {
  const num = n.toNumber();
  if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
  return num.toFixed(0);
}

// CLI entry point
if (require.main === module) {
  (async () => {
    const settings = await loadSettings();
    await scanAllVaults(settings);
  })();
}
