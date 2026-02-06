/**
 * Kamino Yield Monitor
 * Continuously tracks all JitoSOL yield opportunities across Kamino products
 * and alerts when profitable positions appear.
 * 
 * Run via cron: npx ts-node src/monitor.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFILLAMA_API = 'https://yields.llama.fi/pools';
const STATE_FILE = path.join(__dirname, '..', 'config', 'monitor-state.json');

interface YieldOpportunity {
  pool: string;
  project: string;
  symbol: string;
  apy: number;
  apyBase: number;
  apyReward: number;
  tvlUsd: number;
  ilRisk: string;
  chain: string;
}

interface MonitorState {
  lastCheck: string;
  lastAlertedPools: Record<string, number>; // pool id -> apy when last alerted
  bestYield: number;
  bestPool: string;
}

function loadState(): MonitorState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      lastCheck: '',
      lastAlertedPools: {},
      bestYield: 5.57, // baseline JitoSOL staking yield
      bestPool: 'jito-staking (hold)',
    };
  }
}

function saveState(state: MonitorState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchYields(): Promise<YieldOpportunity[]> {
  const resp = await fetch(DEFILLAMA_API);
  const data = await resp.json() as any;
  
  return (data.data || [])
    .filter((p: any) => 
      p.chain === 'Solana' && 
      p.symbol && 
      p.symbol.toUpperCase().includes('JITOSOL') &&
      (p.tvlUsd || 0) > 100000 // Min $100k TVL
    )
    .map((p: any) => ({
      pool: p.pool,
      project: p.project,
      symbol: p.symbol,
      apy: p.apy || 0,
      apyBase: p.apyBase || 0,
      apyReward: p.apyReward || 0,
      tvlUsd: p.tvlUsd || 0,
      ilRisk: p.ilRisk || 'unknown',
      chain: p.chain,
    }))
    .sort((a: YieldOpportunity, b: YieldOpportunity) => b.apy - a.apy);
}

async function main() {
  const state = loadState();
  const pools = await fetchYields();
  
  const HOLD_YIELD = 5.57; // JitoSOL base staking APY
  const ALERT_THRESHOLD = 2.0; // Alert if opportunity is >2% above holding
  const MIN_TVL = 500_000; // Only alert for pools with >$500k TVL
  
  console.log('═══════════════════════════════════════════════');
  console.log('  🔍 JITOSOL YIELD MONITOR');
  console.log('  Baseline: ' + HOLD_YIELD + '% (hold JitoSOL)');
  console.log('  Alert threshold: >' + (HOLD_YIELD + ALERT_THRESHOLD) + '% APY');
  console.log('═══════════════════════════════════════════════');
  
  // Categorize opportunities
  const singleSided = pools.filter(p => p.ilRisk === 'no');
  const lpPools = pools.filter(p => p.ilRisk === 'yes' && p.tvlUsd >= MIN_TVL);
  
  console.log('\n📊 SINGLE-SIDED (No IL Risk):');
  for (const p of singleSided) {
    const marker = p.apy > HOLD_YIELD + ALERT_THRESHOLD ? '🟢' : '⚪';
    console.log(`  ${marker} ${p.apy.toFixed(2)}% | $${(p.tvlUsd/1e6).toFixed(1)}M TVL | ${p.project} | ${p.symbol}`);
  }
  
  console.log('\n📊 LP POOLS (IL Risk, TVL >$500k):');
  for (const p of lpPools) {
    const marker = p.apy > HOLD_YIELD + ALERT_THRESHOLD ? '🟢' : '⚪';
    console.log(`  ${marker} ${p.apy.toFixed(2)}% | $${(p.tvlUsd/1e6).toFixed(1)}M TVL | ${p.project} | ${p.symbol}`);
  }
  
  // Find actionable opportunities
  const actionable = pools.filter(p => 
    p.apy > HOLD_YIELD + ALERT_THRESHOLD && 
    p.tvlUsd >= MIN_TVL
  );
  
  // Check for NEW opportunities (not already alerted)
  const newOpportunities = actionable.filter(p => {
    const lastAlerted = state.lastAlertedPools[p.pool];
    if (!lastAlerted) return true;
    // Re-alert if APY changed by >5%
    return Math.abs(p.apy - lastAlerted) > 5;
  });
  
  // Update state
  const bestPool = pools[0];
  state.lastCheck = new Date().toISOString();
  state.bestYield = bestPool?.apy || HOLD_YIELD;
  state.bestPool = bestPool ? `${bestPool.project} ${bestPool.symbol}` : 'jito-staking (hold)';
  
  if (newOpportunities.length > 0) {
    console.log('\n🚨 NEW OPPORTUNITIES ABOVE THRESHOLD:');
    for (const p of newOpportunities) {
      const premium = (p.apy - HOLD_YIELD).toFixed(1);
      console.log(`  🟢 ${p.project} | ${p.symbol} | ${p.apy.toFixed(2)}% APY (+${premium}% vs hold)`);
      console.log(`     TVL: $${(p.tvlUsd/1e6).toFixed(1)}M | IL Risk: ${p.ilRisk}`);
      state.lastAlertedPools[p.pool] = p.apy;
    }
    // Output ALERT flag for cron to pick up
    console.log('\nALERT:OPPORTUNITY_FOUND');
  } else if (actionable.length > 0) {
    console.log('\n✅ Known opportunities still active (already alerted)');
    console.log('ALERT:NONE_NEW');
  } else {
    console.log('\n⏳ No opportunities above threshold. Best to hold JitoSOL at ' + HOLD_YIELD + '%');
    console.log('ALERT:HOLD');
  }
  
  // Multiply spread check (separate from LP pools)
  console.log('\n📐 MULTIPLY SPREAD:');
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const { createSolanaRpc, address } = await import('@solana/kit');
    const { KaminoMarket, PROGRAM_ID } = await import('@kamino-finance/klend-sdk');
    const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8'));
    const rpc = createSolanaRpc(settings.rpcUrl);
    const connection = new Connection(settings.rpcUrl);
    const slot = BigInt(await connection.getSlot());
    
    const markets = {
      'Main': '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
      'Jito': 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek',
    };
    
    for (const [name, addr] of Object.entries(markets)) {
      try {
        const market = await KaminoMarket.load(rpc, address(addr), 400, PROGRAM_ID);
        if (!market) continue;
        await market.loadReserves();
        
        for (const [, reserve] of market.reserves) {
          const symbol = (reserve as any).symbol || '';
          if (symbol === 'SOL') {
            const borrowApy = (reserve.totalBorrowAPY(slot) || 0) * 100;
            const stakingYield = HOLD_YIELD;
            const spread = stakingYield - borrowApy;
            const profitable = spread > 0;
            console.log(`  ${profitable ? '🟢' : '🔴'} ${name}: SOL borrow ${borrowApy.toFixed(2)}% | Spread: ${spread.toFixed(2)}% | ${profitable ? 'PROFITABLE' : 'UNPROFITABLE'}`);
            if (profitable) {
              console.log(`     At 5x: ${(spread * 5 + stakingYield).toFixed(2)}% net APY`);
            }
          }
        }
      } catch (e: any) {
        console.log(`  ⚠️ ${name}: Failed to load (${e.message?.slice(0, 50)})`);
      }
    }
  } catch (e: any) {
    console.log(`  ⚠️ Could not check Multiply: ${e.message?.slice(0, 80)}`);
  }
  
  saveState(state);
  console.log('\n═══════════════════════════════════════════════');
}

main().catch(console.error);
