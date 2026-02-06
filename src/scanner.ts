/**
 * Kamino Rate Scanner v2
 * Scans and displays current rates across ALL Kamino products.
 * Per-market Multiply spread calculations with live JitoSOL staking yield.
 * Run standalone: npx ts-node src/scanner.ts
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createSolanaRpc, address } from '@solana/kit';
import { KaminoMarket, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { KAMINO_MARKETS, TOKEN_MINTS, Settings } from './types';

// ─── Retry helper ───────────────────────────────────────────────
async function retry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      const isRateLimit = err.message?.includes('429') || err.message?.includes('Too Many');
      const wait = isRateLimit ? delayMs * (i + 2) : delayMs;
      console.log(`   ⏳ Retry ${i + 1}/${maxRetries} in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('Max retries exceeded');
}

// ─── Types ──────────────────────────────────────────────────────
interface ReserveRate {
  symbol: string;
  mint: string;
  supplyApy: number;
  borrowApy: number;
  totalSupply: number;
  totalBorrow: number;
  utilization: number;
  market: string;
}

interface MultiplyRate {
  name: string;
  collateral: string;
  debt: string;
  stakingApy: number;
  borrowCost: number;
  spread: number;
  netApyAt2x: number;
  netApyAt3x: number;
  netApyAt5x: number;
  maxLtv: number;
  market: string;
  marketAddress: string;
}

// ─── Live JitoSOL APY ──────────────────────────────────────────
const JITO_STATS_URL = 'https://kobe.mainnet.jito.network/api/v1/stake_pool_stats';

async function fetchLiveJitoStakingApy(): Promise<{ apy: number; source: string }> {
  try {
    const res = await fetch(JITO_STATS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;

    // The API returns an array of { data: number, date: string } entries
    // data is the APY as a decimal (e.g., 0.0557 = 5.57%)
    const apyEntries = data.apy;
    if (!apyEntries || apyEntries.length === 0) {
      throw new Error('No APY data in response');
    }

    // Get latest entry
    const latest = apyEntries[apyEntries.length - 1];
    const apyPercent = latest.data * 100; // Convert to percentage

    // Also compute 7-day average for comparison
    const recentEntries = apyEntries.slice(-7);
    const avgApy = recentEntries.reduce((sum: number, e: any) => sum + e.data, 0) / recentEntries.length * 100;

    console.log(`   📊 Jito API: latest=${apyPercent.toFixed(2)}%, 7d-avg=${avgApy.toFixed(2)}%, date=${latest.date}`);

    return { apy: apyPercent, source: 'jito-api-live' };
  } catch (err: any) {
    console.log(`   ⚠️  Failed to fetch live Jito APY: ${err.message}, using fallback`);
    // Fallback: use solanacompass data or hardcoded conservative estimate
    return { apy: 5.94, source: 'fallback-solanacompass' };
  }
}

// ─── Settings ───────────────────────────────────────────────────
async function loadSettings(): Promise<Settings> {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
}

// ─── Market Scanner ─────────────────────────────────────────────
async function scanMarket(
  rpc: ReturnType<typeof createSolanaRpc>,
  connection: Connection,
  marketAddress: string,
  marketName: string
): Promise<{ reserves: ReserveRate[]; solBorrowApy: number; hasJitoSOL: boolean }> {
  const reserves: ReserveRate[] = [];
  let solBorrowApy = 0;
  let hasJitoSOL = false;

  let market: KaminoMarket | null = null;
  try {
    market = await retry(
      () => KaminoMarket.load(rpc, address(marketAddress), 400, PROGRAM_ID),
      2, 3000
    );
  } catch (err: any) {
    console.log(`   ⚠️  Could not load ${marketName} market: ${err.message}`);
    return { reserves, solBorrowApy, hasJitoSOL };
  }

  if (!market) return { reserves, solBorrowApy, hasJitoSOL };

  const slot = BigInt(await retry(() => connection.getSlot()));
  const allReserves = market.getReserves();

  for (const reserve of allReserves) {
    try {
      const symbol = reserve.symbol?.toUpperCase() || 'UNKNOWN';
      const mint = reserve.getLiquidityMint().toString();
      const supplyApy = (reserve.totalSupplyAPY(slot) || 0) * 100;
      const borrowApy = (reserve.totalBorrowAPY(slot) || 0) * 100;
      const totalSupplyDec = new Decimal(reserve.getTotalSupply()?.toString() || '0');
      const totalSupply = totalSupplyDec.toNumber();
      let totalBorrow = 0;
      try {
        const borrowedAmount = (reserve as any).getBorrowedAmount?.() || (reserve as any).totalBorrow?.();
        totalBorrow = borrowedAmount ? new Decimal(borrowedAmount.toString()).toNumber() : 0;
      } catch { totalBorrow = 0; }
      const utilization = totalSupply > 0 ? (totalBorrow / totalSupply) * 100 : 0;

      reserves.push({
        symbol,
        mint,
        supplyApy,
        borrowApy,
        totalSupply,
        totalBorrow,
        utilization,
        market: marketName,
      });

      // Track per-market SOL borrow rate
      if (mint === TOKEN_MINTS['SOL']) {
        solBorrowApy = borrowApy;
      }

      // Check if JitoSOL exists in this market
      if (mint === TOKEN_MINTS['JitoSOL']) {
        hasJitoSOL = true;
      }
    } catch {
      // Skip reserves that fail
    }
  }

  return { reserves, solBorrowApy, hasJitoSOL };
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  const settings = await loadSettings();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       🔭 KAMINO RATE SCANNER v2 — Per-Market Spreads');
  console.log(`       ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════════');

  const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });
  const rpc = createSolanaRpc(settings.rpcUrl);

  // ─── Fetch live JitoSOL staking APY ──────────────────────────
  console.log('\n📊 Fetching live JitoSOL staking APY...');
  const jitoApy = await fetchLiveJitoStakingApy();
  const stakingApy = jitoApy.apy;

  // ─── Scan markets ────────────────────────────────────────────
  const marketsToScan: [string, string][] = [
    [KAMINO_MARKETS.MAIN, 'Main'],
    [KAMINO_MARKETS.JITO, 'Jito'],
    [KAMINO_MARKETS.ALTCOINS, 'Altcoins'],
  ];

  const allReserves: ReserveRate[] = [];
  const perMarketData: Map<string, { solBorrowApy: number; hasJitoSOL: boolean; address: string }> = new Map();

  for (const [addr, name] of marketsToScan) {
    console.log(`\n📡 Scanning ${name} market (${addr.slice(0, 8)}...)...`);
    const { reserves, solBorrowApy, hasJitoSOL } = await scanMarket(rpc, connection, addr, name);
    allReserves.push(...reserves);
    perMarketData.set(name, { solBorrowApy, hasJitoSOL, address: addr });
    console.log(`   Found ${reserves.length} reserves | SOL borrow: ${solBorrowApy.toFixed(2)}%`);

    // Rate limit between market loads
    await new Promise(r => setTimeout(r, 1000));
  }

  // ─── K-Lend Supply Rates ────────────────────────────────────
  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log('│                 📈 K-LEND SUPPLY RATES                    │');
  console.log('├──────────┬──────────┬──────────┬──────────┬───────────────┤');
  console.log('│  Token   │ Supply % │ Borrow % │  Util %  │    Market     │');
  console.log('├──────────┼──────────┼──────────┼──────────┼───────────────┤');

  const sortedReserves = [...allReserves].sort((a, b) => b.supplyApy - a.supplyApy);

  for (const r of sortedReserves) {
    const marker = r.supplyApy > 10 ? '🔥' : r.supplyApy > 3 ? '✨' : '  ';
    const sym = r.symbol.padEnd(8);
    const supply = r.supplyApy.toFixed(2).padStart(7);
    const borrow = r.borrowApy.toFixed(2).padStart(7);
    const util = r.utilization.toFixed(1).padStart(7);
    const mkt = r.market.padEnd(12);
    console.log(`│${marker}${sym}│ ${supply}% │ ${borrow}% │ ${util}% │ ${mkt}  │`);
  }

  console.log('└──────────┴──────────┴──────────┴──────────┴───────────────┘');

  // ─── Per-Market SOL Borrow Rates ────────────────────────────
  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log('│              💰 SOL BORROW RATES PER MARKET               │');
  console.log('├──────────────────┬──────────┬──────────────────────────────┤');
  console.log('│  Market          │ SOL Brw% │  Notes                       │');
  console.log('├──────────────────┼──────────┼──────────────────────────────┤');

  for (const [name, data] of perMarketData) {
    const mktName = name.padEnd(16);
    const rate = data.solBorrowApy.toFixed(2).padStart(7);
    const jito = data.hasJitoSOL ? 'Has JitoSOL' : 'No JitoSOL';
    const notes = jito.padEnd(28);
    console.log(`│  ${mktName}│ ${rate}% │  ${notes}│`);
  }

  console.log('└──────────────────┴──────────┴──────────────────────────────┘');

  // ─── Multiply Opportunities (Per-Market) ─────────────────────
  const allMultiply: MultiplyRate[] = [];

  // Build Multiply opportunities for each market that has SOL borrowing
  for (const [name, data] of perMarketData) {
    if (data.solBorrowApy <= 0) continue;

    const spread = stakingApy - data.solBorrowApy;

    // JitoSOL Multiply
    // Note: Jito market has eMode with 90% LTV for JitoSOL/SOL
    // Main market has ~85% LTV
    const maxLtv = name === 'Jito' ? 90 : 85;

    allMultiply.push({
      name: 'JitoSOL<>SOL',
      collateral: 'JitoSOL',
      debt: 'SOL',
      stakingApy,
      borrowCost: data.solBorrowApy,
      spread,
      netApyAt2x: stakingApy * 2 - data.solBorrowApy * 1,
      netApyAt3x: stakingApy * 3 - data.solBorrowApy * 2,
      netApyAt5x: stakingApy * 5 - data.solBorrowApy * 4,
      maxLtv,
      market: name,
      marketAddress: data.address,
    });
  }

  // Also check mSOL in main market
  const mainData = perMarketData.get('Main');
  if (mainData && mainData.solBorrowApy > 0) {
    const msolReserve = allReserves.find(r => r.mint === TOKEN_MINTS['mSOL']);
    if (msolReserve) {
      // mSOL staking yield is similar to JitoSOL (~5-6%)
      const msolStaking = stakingApy * 0.95; // mSOL typically slightly lower
      allMultiply.push({
        name: 'mSOL<>SOL',
        collateral: 'mSOL',
        debt: 'SOL',
        stakingApy: msolStaking,
        borrowCost: mainData.solBorrowApy,
        spread: msolStaking - mainData.solBorrowApy,
        netApyAt2x: msolStaking * 2 - mainData.solBorrowApy * 1,
        netApyAt3x: msolStaking * 3 - mainData.solBorrowApy * 2,
        netApyAt5x: msolStaking * 5 - mainData.solBorrowApy * 4,
        maxLtv: 85,
        market: 'Main',
        marketAddress: mainData.address,
      });
    }
  }

  if (allMultiply.length > 0) {
    console.log('\n┌────────────────────────────────────────────────────────────────────────┐');
    console.log('│              🔄 MULTIPLY OPPORTUNITIES (Per-Market)                     │');
    console.log('├──────────────────┬────────┬────────┬────────┬────────┬─────┬────────────┤');
    console.log('│  Strategy        │ Stk APY│ Brw Cst│ Spread │ 3x APY │ LTV │  Market    │');
    console.log('├──────────────────┼────────┼────────┼────────┼────────┼─────┼────────────┤');

    // Sort by spread descending (best first)
    allMultiply.sort((a, b) => b.spread - a.spread);

    for (const m of allMultiply) {
      const profitable = m.spread > 1 ? '✅' : m.spread > 0 ? '⚠️ ' : '❌';
      const name = m.name.padEnd(16);
      const stk = m.stakingApy.toFixed(2).padStart(6);
      const brw = m.borrowCost.toFixed(2).padStart(6);
      const spread = m.spread.toFixed(2).padStart(6);
      const net3x = m.netApyAt3x.toFixed(2).padStart(6);
      const ltv = `${m.maxLtv}%`.padStart(4);
      const mkt = m.market.padEnd(9);
      console.log(`│${profitable}${name}│ ${stk}%│ ${brw}%│ ${spread}%│ ${net3x}%│ ${ltv}│ ${mkt}  │`);
    }

    console.log('└──────────────────┴────────┴────────┴────────┴────────┴─────┴────────────┘');

    // Detailed breakdowns
    for (const m of allMultiply) {
      console.log(`\n   ${m.name} (${m.market} market):`);
      console.log(`     JitoSOL staking: ${m.stakingApy.toFixed(2)}% (${jitoApy.source})`);
      console.log(`     SOL borrow cost: ${m.borrowCost.toFixed(2)}%  |  Spread: ${m.spread.toFixed(2)}%  |  Max LTV: ${m.maxLtv}%`);
      console.log(`     Net APY: 2x=${m.netApyAt2x.toFixed(2)}%  3x=${m.netApyAt3x.toFixed(2)}%  5x=${m.netApyAt5x.toFixed(2)}%`);
      if (m.spread < 0) {
        console.log(`     ⛔ NEGATIVE SPREAD — Multiply would lose money at any leverage > 1x`);
      } else if (m.netApyAt3x < 0) {
        console.log(`     ⚠️  Only profitable at low leverage (< 3x)`);
      }
    }
  }

  // ─── JitoSOL Staking Yield Summary ──────────────────────────
  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log('│              🏦 JitoSOL STAKING YIELD                     │');
  console.log('├───────────────────────────────────────────────────────────┤');
  console.log(`│  Live APY:    ${stakingApy.toFixed(2)}%  (source: ${jitoApy.source.padEnd(22)})  │`);
  console.log(`│  Pool Token:  1 JitoSOL = ~1.260 SOL                      │`);
  console.log(`│  TVL:         ~13.7M SOL staked                           │`);
  console.log('└───────────────────────────────────────────────────────────┘');

  // ─── Top Picks ──────────────────────────────────────────────
  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log('│                   🏆 TOP PICKS                            │');
  console.log('├───────────────────────────────────────────────────────────┤');

  const tokens = ['SOL', 'USDC', 'USDT', 'JITOSOL', 'MSOL'];
  for (const token of tokens) {
    const best = sortedReserves.find(r => r.symbol === token && r.supplyApy > 0);
    if (best) {
      console.log(`│  ${token.padEnd(8)} → ${best.supplyApy.toFixed(2)}% supply in ${best.market.padEnd(10)}           │`);
    }
  }

  // Best Multiply
  const bestMultiply = allMultiply[0]; // already sorted by spread
  if (bestMultiply) {
    const tag = bestMultiply.spread > 0 ? '✅' : '❌';
    console.log(`│  Multiply → ${bestMultiply.spread.toFixed(2)}% spread in ${bestMultiply.market} market ${tag}       │`);
  }

  console.log('└───────────────────────────────────────────────────────────┘');

  // ─── Strategy Recommendation ────────────────────────────────
  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log('│              📋 STRATEGY RECOMMENDATION                   │');
  console.log('├───────────────────────────────────────────────────────────┤');

  const bestJitoMultiply = allMultiply.find(m => m.collateral === 'JitoSOL');
  if (bestJitoMultiply && bestJitoMultiply.spread > 0 && bestJitoMultiply.netApyAt2x > 0) {
    console.log(`│  ✅ JitoSOL Multiply is PROFITABLE in ${bestJitoMultiply.market} market     │`);
    console.log(`│     Spread: ${bestJitoMultiply.spread.toFixed(2)}% | Best at 2x: ${bestJitoMultiply.netApyAt2x.toFixed(2)}%               │`);
    console.log(`│     Action: Deploy 1 JitoSOL into Multiply                │`);
  } else if (bestJitoMultiply) {
    console.log(`│  ❌ JitoSOL Multiply is NOT profitable right now          │`);
    console.log(`│     Best spread: ${bestJitoMultiply.spread.toFixed(2)}% (${bestJitoMultiply.market} market)            │`);
    console.log(`│     SOL borrow cost (${bestJitoMultiply.borrowCost.toFixed(2)}%) > staking yield (${stakingApy.toFixed(2)}%)   │`);
    console.log(`│     Action: HOLD JitoSOL, wait for rates to improve       │`);
    console.log(`│     Target: SOL borrow < ${(stakingApy - 1).toFixed(1)}% for profitable Multiply  │`);
  }

  console.log('└───────────────────────────────────────────────────────────┘');

  // ─── Summary ────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n⏱  Scanned ${allReserves.length} reserves across ${marketsToScan.length} markets in ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Return structured data for programmatic use
  return {
    stakingApy,
    stakingApySource: jitoApy.source,
    markets: Object.fromEntries(perMarketData),
    multiply: allMultiply,
    reserves: allReserves,
  };
}

// Export for programmatic use
export { main as runScanner, fetchLiveJitoStakingApy };
export type { ReserveRate, MultiplyRate };

// Allow standalone execution (only when run directly, not when imported)
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Scanner error:', err.message || err);
      process.exit(1);
    });
}
