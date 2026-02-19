/**
 * Kamino Yield Optimizer v2 — Multi-Strategy
 *
 * Enhanced optimizer supporting:
 * - K-Lend (supply/borrow) across multiple tokens
 * - Multiply (leveraged staking) for JitoSOL<>SOL
 * - Jupiter swaps for rebalancing
 * - Portfolio allocation tracking
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

import { KaminoClient } from './kamino-client';
import { MultiplyClient } from './multiply-client';
import { JupiterClient } from './jupiter-client';
import { LiquidityClient } from './liquidity-client';
import { PortfolioManager, PortfolioSnapshot, RebalanceAction } from './portfolio';
import {
  Settings,
  PerformanceLogEntry,
  TOKEN_MINTS,
} from './types';

// ─── Helpers ───────────────────────────────────────────────────

const COINGECKO_SOL_PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch(COINGECKO_SOL_PRICE_URL);
    const data = (await res.json()) as any;
    return data.solana?.usd || 200;
  } catch {
    return 200;
  }
}

function loadSettings(): Settings {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
}

function loadWallet(): Keypair {
  const walletPath = path.join(__dirname, '../config/wallet.json');
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function logPerformance(entry: PerformanceLogEntry) {
  const logPath = path.join(__dirname, '../config/performance.jsonl');
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🚀 KAMINO YIELD OPTIMIZER v2 — MULTI-STRATEGY');
  console.log(`     ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const settings = loadSettings();
  const wallet = loadWallet();
  const solPrice = await getSolPrice();
  const solPriceDec = new Decimal(solPrice);

  console.log(`💳 Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`💲 SOL price: $${solPrice.toFixed(2)}`);
  console.log(`🧪 Dry run: ${settings.dryRun ? 'YES' : 'NO'}\n`);

  // Initialize clients
  const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });
  const kaminoClient = new KaminoClient(settings.rpcUrl);
  const multiplyClient = new MultiplyClient(settings.rpcUrl, settings.multiply);
  const jupiterClient = new JupiterClient(connection, settings.jupiter);
  const liquidityClient = new LiquidityClient(settings.rpcUrl);
  const portfolioMgr = new PortfolioManager(
    connection,
    kaminoClient,
    multiplyClient,
    settings.portfolio,
    liquidityClient
  );

  await kaminoClient.initialize();

  // ─── Step 1: Get portfolio snapshot ────────────────────────
  console.log('📊 Building portfolio snapshot...\n');
  const snapshot = await portfolioMgr.getSnapshot(
    wallet.publicKey,
    solPriceDec
  );

  portfolioMgr.printSummary(snapshot);

  const actions: string[] = [];

  // ─── Step 2: Scan K-Lend rates ────────────────────────────
  console.log('\n🔍 Scanning K-Lend rates...');
  const vaults = await kaminoClient.getReserves();
  const topVaults = vaults.slice(0, 8);
  for (const v of topVaults) {
    const marker = v.apy.gt(5) ? '🔥' : v.apy.gt(2) ? '✨' : '  ';
    console.log(`   ${marker} ${v.name.padEnd(15)} ${v.apy.toFixed(2).padStart(6)}% APY`);
  }

  // ─── Step 3: Check Multiply rates ────────────────────────
  console.log('\n🔄 Checking Multiply opportunities...');
  const multiplyCheck = await multiplyClient.shouldOpenPosition();
  console.log(`   ${multiplyCheck.profitable ? '✅' : '❌'} ${multiplyCheck.reason}`);

  // ─── Step 3b: Scan LP Vault rates ──────────────────────────
  console.log('\n🏊 Scanning liquidity vault opportunities...');
  try {
    const lpVaults = await liquidityClient.listJitoSolVaults();
    if (lpVaults.length > 0) {
      for (const v of lpVaults.slice(0, 3)) {
        const marker = v.totalApy.gt(10) ? '🔥' : v.totalApy.gt(5) ? '✨' : '  ';
        const rangeStr = v.outOfRange ? '⚠️ OUT' : 'IN RANGE';
        console.log(`   ${marker} ${v.name.padEnd(20)} ${v.totalApy.toFixed(2).padStart(6)}% APY  TVL: $${v.tvlUsd.toFixed(0)}  ${rangeStr}`);
      }
    } else {
      console.log('   No JitoSOL-SOL LP vaults found.');
    }
  } catch (err: any) {
    console.log(`   ⚠️  LP vault scan failed: ${err.message}`);
  }

  // ─── Step 3c: Check LP positions ──────────────────────────
  if (snapshot.liquidityPositions.length > 0) {
    console.log('\n💧 Active LP Positions:');
    for (const pos of snapshot.liquidityPositions) {
      console.log(`   ${pos.name}: ${pos.sharesAmount.toFixed(6)} shares (~$${pos.valueUsd.toFixed(2)}) @ ${pos.currentApy.toFixed(2)}% APY`);
    }
  }

  // ─── Step 4: Monitor existing Multiply positions ──────────
  console.log('\n📡 Monitoring Multiply positions...');
  const multiplyHealth = await multiplyClient.monitorPositions(wallet.publicKey);

  if (multiplyHealth.positions.length === 0) {
    console.log('   No active Multiply positions.');
  } else {
    for (const pos of multiplyHealth.positions) {
      console.log(
        `   ${pos.collateralToken}/${pos.debtToken}: ${pos.leverage.toFixed(1)}x | LTV: ${pos.ltv.mul(100).toFixed(1)}% | Net APY: ${pos.netApy.toFixed(2)}%`
      );
    }
  }

  for (const w of multiplyHealth.warnings) {
    console.log(`   ${w}`);
    actions.push(w);
  }

  // ─── Step 5: Determine rebalance actions ──────────────────
  console.log('\n⚖️  Computing rebalance actions...');
  const rebalanceActions = portfolioMgr.computeRebalanceActions(snapshot);

  if (rebalanceActions.length === 0) {
    console.log('   ✅ Portfolio is within allocation targets — no rebalancing needed.');
  } else {
    for (const action of rebalanceActions) {
      console.log(`   📋 ${action.type}: ${action.amountUi.toFixed(4)} ${action.token} — ${action.reason}`);
    }
  }

  // ─── Step 6: Execute rebalance actions ────────────────────
  if (rebalanceActions.length > 0) {
    console.log('\n⚡ Executing rebalance actions...');

    for (const action of rebalanceActions) {
      try {
        await executeAction(action, {
          wallet,
          kaminoClient,
          jupiterClient,
          multiplyClient,
          dryRun: settings.dryRun,
          gasBuffer: settings.gasBufferSol,
          solBalance: snapshot.balances.SOL,
          settings,
          multiplyCheck,
        });
        actions.push(`${action.type}: ${action.amountUi.toFixed(4)} ${action.token} — ${action.reason}`);
      } catch (err: any) {
        console.log(`   ❌ Failed ${action.type}: ${err.message}`);
        actions.push(`FAILED ${action.type}: ${err.message}`);
      }
    }
  }

  // ─── Step 7: K-Lend rebalancing (existing logic) ─────────
  console.log('\n🔄 Checking K-Lend position rebalancing...');

  for (const pos of snapshot.klendPositions) {
    const betterVault = vaults.find(
      (v) =>
        v.token === pos.token &&
        v.address !== pos.vaultAddress &&
        v.apy.minus(pos.currentApy).gte(settings.minYieldImprovement) &&
        v.apy.gt(0)
    );

    if (betterVault) {
      const apyGain = betterVault.apy.minus(pos.currentApy);
      console.log(
        `   💡 ${pos.vaultName} → ${betterVault.name} (+${apyGain.toFixed(2)}% APY)`
      );
      actions.push(
        `K-Lend rebalance opportunity: ${pos.vaultName} → ${betterVault.name} (+${apyGain.toFixed(2)}%)`
      );
    }
  }

  // ─── Step 8: Auto-deposit idle SOL ────────────────────────
  const availableSol = snapshot.balances.SOL.minus(settings.gasBufferSol);

  if (availableSol.gt(0.003)) {
    const bestSolVault = vaults.find((v) => v.token === 'SOL' && v.apy.gt(0));
    if (bestSolVault) {
      console.log(
        `\n💰 Idle SOL: ${availableSol.toFixed(6)} — best vault: ${bestSolVault.name} @ ${bestSolVault.apy.toFixed(2)}%`
      );

      if (!settings.dryRun) {
        try {
          const sig = await kaminoClient.deposit(wallet, 'SOL', availableSol);
          console.log(`   ✅ Deposited ${availableSol.toFixed(6)} SOL → ${sig.slice(0, 20)}...`);
          actions.push(`Deposited ${availableSol.toFixed(4)} SOL to ${bestSolVault.name}`);
        } catch (err: any) {
          console.log(`   ❌ Deposit failed: ${err.message}`);
        }
      } else {
        console.log(`   🧪 DRY RUN — would deposit ${availableSol.toFixed(6)} SOL`);
      }
    }
  }

  // ─── Step 9: Log performance ──────────────────────────────
  logPerformance({
    timestamp: new Date().toISOString(),
    solBalance: snapshot.balances.SOL.toFixed(6),
    usdcBalance: snapshot.balances.USDC.toFixed(2),
    jitosolBalance: snapshot.balances.JitoSOL.toFixed(6),
    klendValueUsd: snapshot.klendPositions
      .reduce((sum, p) => sum.plus(p.valueUsd), new Decimal(0))
      .toFixed(2),
    multiplyValueUsd: snapshot.multiplyPositions
      .reduce((sum, p) => sum.plus(p.netValueUsd), new Decimal(0))
      .plus(snapshot.liquidityPositions.reduce((sum, p) => sum.plus(p.valueUsd), new Decimal(0)))
      .toFixed(2),
    totalValueUsd: snapshot.totalValueUsd.toFixed(2),
    blendedApy: snapshot.blendedApy.toFixed(2),
    action: actions.length > 0 ? actions.join('; ') : 'No action',
  });

  // ─── Summary ──────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                     📈 OPTIMIZER v2 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Total Value:   $${snapshot.totalValueUsd.toFixed(2)}`);
  console.log(`   Blended APY:   ${snapshot.blendedApy.toFixed(2)}%`);
  console.log(`   K-Lend:        ${snapshot.klendPositions.length} positions`);
  console.log(`   Multiply:      ${snapshot.multiplyPositions.length} positions`);
  console.log(`   LP Vaults:     ${snapshot.liquidityPositions.length} positions`);
  console.log(`   Actions:       ${actions.length > 0 ? actions.length + ' executed' : 'None needed'}`);
  if (actions.length > 0) {
    for (const a of actions) {
      console.log(`                  - ${a}`);
    }
  }
  console.log(`   Runtime:       ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

// ─── Action executor ───────────────────────────────────────────

interface ExecuteContext {
  wallet: Keypair;
  kaminoClient: KaminoClient;
  jupiterClient: JupiterClient;
  multiplyClient: MultiplyClient;
  dryRun: boolean;
  gasBuffer: number;
  solBalance: Decimal;
  settings: Settings;
  multiplyCheck: { profitable: boolean; reason: string; bestOpportunity?: any; bestMarket?: any };
}

async function executeAction(
  action: RebalanceAction,
  ctx: ExecuteContext
): Promise<void> {
  // Safety: never drop SOL below gas buffer
  if (action.token === 'SOL') {
    const afterBalance = ctx.solBalance.minus(action.amountUi);
    if (afterBalance.lt(ctx.gasBuffer)) {
      const safeAmount = ctx.solBalance.minus(ctx.gasBuffer);
      if (safeAmount.lte(0)) {
        console.log(`   ⚠️  Skipping ${action.type}: would violate gas buffer`);
        return;
      }
      action.amountUi = safeAmount;
      console.log(`   ⚠️  Capped to ${safeAmount.toFixed(6)} SOL (gas buffer)`);
    }
  }

  switch (action.type) {
    case 'swap': {
      const result = await ctx.jupiterClient.executeSwap(
        action.from,
        action.to,
        action.amountUi,
        ctx.wallet,
        ctx.dryRun
      );
      if (result.signature) {
        console.log(`   ✅ Swap: ${result.signature.slice(0, 20)}...`);
      }
      break;
    }

    case 'deposit': {
      if (ctx.dryRun) {
        console.log(`   🧪 DRY RUN — would deposit ${action.amountUi.toFixed(4)} ${action.token} to ${action.to}`);
        return;
      }
      const sig = await ctx.kaminoClient.deposit(ctx.wallet, action.token, action.amountUi);
      console.log(`   ✅ Deposit: ${sig.slice(0, 20)}...`);
      break;
    }

    case 'withdraw': {
      if (ctx.dryRun) {
        console.log(`   🧪 DRY RUN — would withdraw ${action.amountUi.toFixed(4)} ${action.token}`);
        return;
      }
      const sig = await ctx.kaminoClient.withdraw(ctx.wallet, action.token, action.amountUi);
      console.log(`   ✅ Withdraw: ${sig.slice(0, 20)}...`);
      break;
    }

    case 'openMultiply': {
      // Safety: don't open if spread is too low
      if (!ctx.multiplyCheck.profitable) {
        console.log(`   ⚠️  Skipping multiply open: ${ctx.multiplyCheck.reason}`);
        return;
      }

      // Determine best LST and market from multiply analysis
      let lstSymbol = 'JitoSOL';
      let lstMint = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
      let targetMarket = ctx.settings.multiply?.preferredMarket ?? '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
      let targetLeverage = ctx.settings.multiply?.maxLeverage ?? 5;

      if (ctx.multiplyCheck.bestOpportunity) {
        lstSymbol = ctx.multiplyCheck.bestOpportunity.symbol;
        lstMint = ctx.multiplyCheck.bestOpportunity.mint;
        targetMarket = ctx.multiplyCheck.bestOpportunity.marketAddress;
        targetLeverage = ctx.multiplyCheck.bestOpportunity.maxLeverage * 0.8;
      }

      const result = await ctx.multiplyClient.openPosition(
        ctx.wallet,
        lstSymbol,
        lstMint,
        action.amountUi,
        targetLeverage,
        targetMarket,
        ctx.dryRun
      );
      console.log(`   ${result.success ? '✅' : '⚠️'} ${result.message}`);
      break;
    }

    case 'closeMultiply': {
      const positions = await ctx.multiplyClient.getUserMultiplyPositions(ctx.wallet.publicKey);
      if (positions.length > 0) {
        const closeResult = await ctx.multiplyClient.closePosition(ctx.wallet, positions[0], ctx.dryRun);
        console.log(`   ${closeResult.success ? '✅' : '⚠️'} ${closeResult.message}`);
      } else {
        console.log(`   ⚠️  No multiply position found to close`);
      }
      break;
    }

    default:
      console.log(`   ⚠️  Unknown action type: ${action.type}`);
  }
}

// ─── Entry point ───────────────────────────────────────────────

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err.message || err);
    process.exit(1);
  });

// Export for use by optimize-cron.ts
export { main as runOptimizeV2 };
