#!/usr/bin/env ts-node
/**
 * Kamino Yield Optimizer - Main Entry Point
 * 
 * Commands:
 *   scan     - Show all vaults and APYs
 *   status   - Show wallet and positions (mock for now)
 *   optimize - Run optimization cycle
 */

import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { KaminoApiClient } from './api-client';
import { VaultInfo, Position, RebalanceOpportunity, Settings } from './types';

const SOL_PRICE_USD = 150;
const GAS_COST_SOL = 0.000005;

function loadSettings(): Settings {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
}

function formatNumber(n: number | Decimal): string {
  const num = typeof n === 'number' ? n : n.toNumber();
  if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
  return num.toFixed(2);
}

async function scan(client: KaminoApiClient, settings: Settings): Promise<VaultInfo[]> {
  console.log('\n🔍 Scanning Kamino vaults...\n');
  
  const vaults = await client.getVaults();
  const profile = settings.riskProfiles[settings.riskTolerance];
  
  // Filter by risk profile
  const filtered = vaults
    .filter(v => v.tvlUsd.gte(profile.minTvlUsd) && v.isActive)
    .sort((a, b) => b.apy.minus(a.apy).toNumber());
  
  console.log(`Found ${filtered.length} vaults (${settings.riskTolerance} risk profile):\n`);
  console.log('  Vault               APY      TVL');
  console.log('  ─────────────────────────────────────');
  
  for (const vault of filtered) {
    const apy = vault.apy.toFixed(2).padStart(5);
    const tvl = formatNumber(vault.tvlUsd);
    console.log(`  ${vault.name.padEnd(18)} ${apy}%   $${tvl}`);
  }
  
  return filtered;
}

// Mock positions for now - would come from on-chain in production
function getMockPositions(vaults: VaultInfo[]): Position[] {
  // Simulate having some positions
  const usdcVault = vaults.find(v => v.token === 'USDC');
  const solVault = vaults.find(v => v.token === 'SOL');
  
  const positions: Position[] = [];
  
  if (usdcVault) {
    positions.push({
      vaultAddress: usdcVault.address,
      vaultName: usdcVault.name,
      token: 'USDC',
      shares: new Decimal(500),
      tokenAmount: new Decimal(500),
      valueUsd: new Decimal(500),
      currentApy: usdcVault.apy,
      depositedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      unrealizedPnl: new Decimal(500 * 0.075 * 14 / 365), // ~14 days of yield
    });
  }
  
  if (solVault) {
    positions.push({
      vaultAddress: solVault.address,
      vaultName: solVault.name,
      token: 'SOL',
      shares: new Decimal(2.5),
      tokenAmount: new Decimal(2.5),
      valueUsd: new Decimal(2.5 * SOL_PRICE_USD),
      currentApy: solVault.apy,
      depositedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      unrealizedPnl: new Decimal(2.5 * SOL_PRICE_USD * 0.062 * 7 / 365),
    });
  }
  
  return positions;
}

async function status(client: KaminoApiClient, settings: Settings): Promise<Position[]> {
  console.log('\n📊 Current Positions\n');
  
  const vaults = await client.getVaults();
  const positions = getMockPositions(vaults);
  
  // Mock wallet info
  const walletPubkey = 'AgentWallet...XXX';
  const solBalance = 0.5;
  
  console.log(`  Wallet: ${walletPubkey}`);
  console.log(`  SOL Balance: ${solBalance} SOL ($${(solBalance * SOL_PRICE_USD).toFixed(2)})\n`);
  
  if (positions.length === 0) {
    console.log('  No positions found.\n');
    return positions;
  }
  
  console.log('  Position           Amount        Value     APY    P&L');
  console.log('  ────────────────────────────────────────────────────────');
  
  let totalValue = new Decimal(0);
  let totalPnl = new Decimal(0);
  let weightedApy = new Decimal(0);
  
  for (const pos of positions) {
    const amount = `${pos.tokenAmount.toFixed(2)} ${pos.token}`.padEnd(12);
    const value = `$${pos.valueUsd.toFixed(2)}`.padEnd(10);
    const apy = `${pos.currentApy.toFixed(1)}%`.padStart(5);
    const pnl = pos.unrealizedPnl.gte(0) 
      ? `+$${pos.unrealizedPnl.toFixed(2)}` 
      : `-$${pos.unrealizedPnl.abs().toFixed(2)}`;
    
    console.log(`  ${pos.vaultName.padEnd(18)} ${amount} ${value} ${apy}   ${pnl}`);
    
    totalValue = totalValue.plus(pos.valueUsd);
    totalPnl = totalPnl.plus(pos.unrealizedPnl);
    weightedApy = weightedApy.plus(pos.currentApy.mul(pos.valueUsd));
  }
  
  if (!totalValue.isZero()) {
    weightedApy = weightedApy.div(totalValue);
  }
  
  const monthlyEst = totalValue.mul(weightedApy).div(100).div(12);
  
  console.log('  ────────────────────────────────────────────────────────');
  console.log(`  Total Value: $${totalValue.toFixed(2)}`);
  console.log(`  Weighted APY: ${weightedApy.toFixed(2)}%`);
  console.log(`  Unrealized P&L: ${totalPnl.gte(0) ? '+' : ''}$${totalPnl.toFixed(2)}`);
  console.log(`  Est. Monthly Yield: $${monthlyEst.toFixed(2)}\n`);
  
  return positions;
}

function findOpportunities(
  positions: Position[],
  vaults: VaultInfo[],
  settings: Settings
): RebalanceOpportunity[] {
  const opportunities: RebalanceOpportunity[] = [];
  
  for (const pos of positions) {
    const currentVault = vaults.find(v => v.address === pos.vaultAddress);
    if (!currentVault) continue;
    
    // Find better vaults for same token
    const betterVaults = vaults.filter(v =>
      v.token === pos.token &&
      v.address !== pos.vaultAddress &&
      v.apy.gt(currentVault.apy.plus(settings.minYieldImprovement))
    );
    
    for (const target of betterVaults) {
      const apyGain = target.apy.minus(currentVault.apy);
      
      // Calculate fees
      const withdrawFee = pos.valueUsd.mul(currentVault.withdrawalFeePercent).div(100);
      const depositFee = pos.valueUsd.mul(target.depositFeePercent).div(100);
      const gasCost = new Decimal(GAS_COST_SOL * 2 * SOL_PRICE_USD);
      const totalFees = withdrawFee.plus(depositFee).plus(gasCost);
      
      // Monthly gain from APY improvement
      const monthlyGain = pos.valueUsd.mul(apyGain).div(100).div(12);
      
      // Break-even days
      const breakEven = monthlyGain.isZero() ? 999 : totalFees.div(monthlyGain.div(30)).toNumber();
      
      const isProfitable = breakEven <= settings.timeHorizonDays &&
                          pos.valueUsd.gte(settings.minRebalanceAmountUsd);
      
      opportunities.push({
        fromVault: currentVault,
        toVault: target,
        token: pos.token,
        amount: pos.tokenAmount,
        currentApy: currentVault.apy,
        newApy: target.apy,
        apyGain,
        estimatedFees: totalFees,
        estimatedMonthlyGain: monthlyGain,
        breakEvenDays: Math.ceil(breakEven),
        isProfitable,
      });
    }
  }
  
  return opportunities.sort((a, b) => b.estimatedMonthlyGain.minus(a.estimatedMonthlyGain).toNumber());
}

async function optimize(client: KaminoApiClient, settings: Settings) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           🌾 Kamino Yield Optimizer');
  console.log(`           ${new Date().toISOString()}`);
  console.log(`           Risk: ${settings.riskTolerance} | Dry Run: ${settings.dryRun}`);
  console.log('═══════════════════════════════════════════════════════════');
  
  // 1. Scan vaults
  const vaults = await scan(client, settings);
  
  // 2. Get positions
  const positions = await status(client, settings);
  
  // 3. Find opportunities
  console.log('🔄 Analyzing Rebalance Opportunities\n');
  const opportunities = findOpportunities(positions, vaults, settings);
  
  if (opportunities.length === 0) {
    console.log('  No rebalance opportunities found.\n');
    console.log('  Current positions are optimally allocated.');
    return;
  }
  
  console.log('  Opportunity                    APY Change    Monthly Gain  Break-even');
  console.log('  ──────────────────────────────────────────────────────────────────────');
  
  for (const opp of opportunities) {
    const status = opp.isProfitable ? '✅' : '❌';
    const token = opp.token.padEnd(6);
    const change = `${opp.currentApy.toFixed(1)}% → ${opp.newApy.toFixed(1)}%`.padEnd(14);
    const gain = `$${opp.estimatedMonthlyGain.toFixed(2)}/mo`.padEnd(12);
    const breakEven = `${opp.breakEvenDays}d`;
    
    console.log(`  ${status} ${token} ${change} ${gain} ${breakEven}`);
  }
  
  // 4. Execute profitable rebalances
  const profitable = opportunities.filter(o => o.isProfitable);
  
  if (profitable.length === 0) {
    console.log('\n  No profitable rebalances at current thresholds.\n');
    return;
  }
  
  console.log(`\n⚡ Executing ${profitable.length} rebalance(s)...\n`);
  
  for (const opp of profitable) {
    if (settings.dryRun) {
      console.log(`  [DRY RUN] Would move ${opp.amount.toFixed(2)} ${opp.token}:`);
      console.log(`    From: ${opp.fromVault?.name} (${opp.currentApy.toFixed(1)}% APY)`);
      console.log(`    To:   ${opp.toVault.name} (${opp.newApy.toFixed(1)}% APY)`);
      console.log(`    Gain: +${opp.apyGain.toFixed(2)}% APY = $${opp.estimatedMonthlyGain.toFixed(2)}/month`);
      console.log(`    Fees: $${opp.estimatedFees.toFixed(4)} (break-even: ${opp.breakEvenDays} days)\n`);
    } else {
      console.log(`  Executing: ${opp.token} → ${opp.toVault.name}...`);
      // TODO: Actual execution via SDK
      console.log('  ⚠️  Live execution requires SDK integration and funded wallet.\n');
    }
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                    Optimization Complete');
  console.log('═══════════════════════════════════════════════════════════\n');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'optimize';
  
  const settings = loadSettings();
  const client = new KaminoApiClient();
  
  switch (command) {
    case 'scan':
      await scan(client, settings);
      break;
    case 'status':
      await status(client, settings);
      break;
    case 'optimize':
      await optimize(client, settings);
      break;
    default:
      console.log('Kamino Yield Optimizer\n');
      console.log('Usage: npx ts-node src/main.ts <command>\n');
      console.log('Commands:');
      console.log('  scan     - Show all vaults and APYs');
      console.log('  status   - Show wallet and positions');
      console.log('  optimize - Run full optimization cycle');
  }
}

main().catch(console.error);
