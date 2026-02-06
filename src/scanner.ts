/**
 * Kamino Rate Scanner
 * Scans and displays current rates across ALL Kamino products.
 * Run standalone: npx ts-node src/scanner.ts
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createSolanaRpc, address } from '@solana/kit';
import { KaminoMarket, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { KAMINO_MARKETS, TOKEN_MINTS, Settings } from './types';

// Retry helper
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
  netApyAt3x: number;
  netApyAt5x: number;
  maxLtv: number;
  market: string;
}

async function loadSettings(): Promise<Settings> {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
}

async function scanMarket(
  rpc: ReturnType<typeof createSolanaRpc>,
  connection: Connection,
  marketAddress: string,
  marketName: string
): Promise<{ reserves: ReserveRate[]; multiplyOpps: MultiplyRate[] }> {
  const reserves: ReserveRate[] = [];
  const multiplyOpps: MultiplyRate[] = [];

  let market: KaminoMarket | null = null;
  try {
    market = await retry(
      () => KaminoMarket.load(rpc, address(marketAddress), 400, PROGRAM_ID),
      2, 3000
    );
  } catch (err: any) {
    console.log(`   ⚠️  Could not load ${marketName} market: ${err.message}`);
    return { reserves, multiplyOpps };
  }

  if (!market) return { reserves, multiplyOpps };

  const slot = BigInt(await retry(() => connection.getSlot()));
  const allReserves = market.getReserves();

  // Track rates for multiply calculations
  let jitosolSupplyApy = 0;
  let solBorrowApy = 0;
  let msolSupplyApy = 0;

  for (const reserve of allReserves) {
    try {
      const symbol = reserve.symbol?.toUpperCase() || 'UNKNOWN';
      const mint = reserve.getLiquidityMint().toString();
      const supplyApy = (reserve.totalSupplyAPY(slot) || 0) * 100;
      const borrowApy = (reserve.totalBorrowAPY(slot) || 0) * 100;
      const totalSupplyDec = new Decimal(reserve.getTotalSupply()?.toString() || '0');
      const totalSupply = totalSupplyDec.toNumber();
      // Estimate borrow from utilization or set to 0
      let totalBorrow = 0;
      try {
        // Some SDK versions expose getBorrowedAmount or similar
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

      // Track for multiply calculations
      if (mint === TOKEN_MINTS['JitoSOL']) jitosolSupplyApy = supplyApy;
      if (mint === TOKEN_MINTS['mSOL']) msolSupplyApy = supplyApy;
      if (mint === TOKEN_MINTS['SOL']) solBorrowApy = borrowApy;
    } catch {
      // Skip reserves that fail
    }
  }

  // Calculate multiply opportunities
  if (jitosolSupplyApy > 0 && solBorrowApy > 0) {
    // JitoSOL staking yield is higher than pure supply APY — estimate ~7-8%
    const stakingApy = Math.max(jitosolSupplyApy, 7.0);
    const spread = stakingApy - solBorrowApy;
    multiplyOpps.push({
      name: 'JitoSOL<>SOL Multiply',
      collateral: 'JitoSOL',
      debt: 'SOL',
      stakingApy,
      borrowCost: solBorrowApy,
      spread,
      netApyAt3x: stakingApy * 3 - solBorrowApy * 2,
      netApyAt5x: stakingApy * 5 - solBorrowApy * 4,
      maxLtv: 90,
      market: marketName,
    });
  }

  if (msolSupplyApy > 0 && solBorrowApy > 0) {
    const stakingApy = Math.max(msolSupplyApy, 7.0);
    const spread = stakingApy - solBorrowApy;
    multiplyOpps.push({
      name: 'mSOL<>SOL Multiply',
      collateral: 'mSOL',
      debt: 'SOL',
      stakingApy,
      borrowCost: solBorrowApy,
      spread,
      netApyAt3x: stakingApy * 3 - solBorrowApy * 2,
      netApyAt5x: stakingApy * 5 - solBorrowApy * 4,
      maxLtv: 85,
      market: marketName,
    });
  }

  return { reserves, multiplyOpps };
}

async function main() {
  const startTime = Date.now();
  const settings = await loadSettings();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       🔭 KAMINO RATE SCANNER — All Products');
  console.log(`       ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════════');

  const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });
  const rpc = createSolanaRpc(settings.rpcUrl);

  // Scan markets
  const marketsToScan: [string, string][] = [
    [KAMINO_MARKETS.MAIN, 'Main'],
    [KAMINO_MARKETS.JITO, 'Jito'],
    [KAMINO_MARKETS.ALTCOINS, 'Altcoins'],
  ];

  const allReserves: ReserveRate[] = [];
  const allMultiply: MultiplyRate[] = [];

  for (const [addr, name] of marketsToScan) {
    console.log(`\n📡 Scanning ${name} market (${addr.slice(0, 8)}...)...`);
    const { reserves, multiplyOpps } = await scanMarket(rpc, connection, addr, name);
    allReserves.push(...reserves);
    allMultiply.push(...multiplyOpps);
    console.log(`   Found ${reserves.length} reserves`);

    // Rate limit between market loads
    await new Promise(r => setTimeout(r, 1000));
  }

  // ─── K-Lend Supply Rates ────────────────────────────────────
  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log('│                 📈 K-LEND SUPPLY RATES                    │');
  console.log('├──────────┬──────────┬──────────┬──────────┬───────────────┤');
  console.log('│  Token   │ Supply % │ Borrow % │  Util %  │    Market     │');
  console.log('├──────────┼──────────┼──────────┼──────────┼───────────────┤');

  // Sort by supply APY descending
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

  // ─── Multiply Opportunities ─────────────────────────────────
  if (allMultiply.length > 0) {
    console.log('\n┌───────────────────────────────────────────────────────────┐');
    console.log('│              🔄 MULTIPLY OPPORTUNITIES                    │');
    console.log('├──────────────────┬────────┬────────┬────────┬────────────┤');
    console.log('│  Strategy        │ Spread │ 3x APY │ 5x APY │  Market    │');
    console.log('├──────────────────┼────────┼────────┼────────┼────────────┤');

    for (const m of allMultiply) {
      const profitable = m.spread > 1 ? '✅' : m.spread > 0 ? '⚠️' : '❌';
      const name = m.name.padEnd(17);
      const spread = m.spread.toFixed(2).padStart(6);
      const net3x = m.netApyAt3x.toFixed(2).padStart(6);
      const net5x = m.netApyAt5x.toFixed(2).padStart(6);
      const mkt = m.market.padEnd(9);
      console.log(`│${profitable}${name}│ ${spread}%│ ${net3x}%│ ${net5x}%│ ${mkt}  │`);
    }

    console.log('└──────────────────┴────────┴────────┴────────┴────────────┘');

    // Details
    for (const m of allMultiply) {
      console.log(`\n   ${m.name} (${m.market}):`);
      console.log(`     Staking yield: ${m.stakingApy.toFixed(2)}%  |  Borrow cost: ${m.borrowCost.toFixed(2)}%  |  Max LTV: ${m.maxLtv}%`);
      console.log(`     Net APY: 2x=${(m.stakingApy * 2 - m.borrowCost).toFixed(2)}%  3x=${m.netApyAt3x.toFixed(2)}%  5x=${m.netApyAt5x.toFixed(2)}%`);
    }
  }

  // ─── Top picks per token ────────────────────────────────────
  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log('│                   🏆 TOP PICKS                            │');
  console.log('├───────────────────────────────────────────────────────────┤');

  const tokens = ['SOL', 'USDC', 'USDT', 'JITOSOL', 'MSOL'];
  for (const token of tokens) {
    const best = sortedReserves.find(
      r => r.symbol === token && r.supplyApy > 0
    );
    if (best) {
      console.log(`│  ${token.padEnd(8)} → ${best.supplyApy.toFixed(2)}% supply in ${best.market.padEnd(10)}           │`);
    }
  }

  console.log('└───────────────────────────────────────────────────────────┘');

  // ─── Summary ────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n⏱  Scanned ${allReserves.length} reserves across ${marketsToScan.length} markets in ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════════════\n');
}

// Allow standalone execution
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Scanner error:', err.message || err);
    process.exit(1);
  });
