/**
 * Kamino Yield Optimizer - Main Entry Point
 * 
 * Usage:
 *   npx ts-node src/index.ts scan      - Scan vaults and show APYs
 *   npx ts-node src/index.ts status    - Show current positions
 *   npx ts-node src/index.ts optimize  - Run full optimization cycle
 *   npx ts-node src/index.ts deposit <vault> <amount> - Manual deposit
 *   npx ts-node src/index.ts withdraw <vault> <amount> - Manual withdraw
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { KaminoClient } from './kamino-client';
import { 
  VaultInfo, 
  Position, 
  RebalanceOpportunity, 
  Settings,
  TOKEN_MINTS,
} from './types';

const SOL_PRICE_USD = 150; // TODO: Fetch dynamically
const GAS_COST_SOL = 0.000005;

async function loadSettings(): Promise<Settings> {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  return JSON.parse(raw) as Settings;
}

async function loadWallet(): Promise<Keypair> {
  const walletPath = path.join(__dirname, '../config/wallet.json');
  
  if (!fs.existsSync(walletPath)) {
    console.log('❌ Wallet not found. Generating new wallet...');
    const keypair = Keypair.generate();
    fs.writeFileSync(walletPath, JSON.stringify(Array.from(keypair.secretKey)));
    console.log(`✅ Wallet created: ${keypair.publicKey.toBase58()}`);
    console.log('⚠️  Fund this wallet with SOL for gas before continuing.');
    return keypair;
  }
  
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function findRebalanceOpportunities(
  positions: Position[],
  vaults: VaultInfo[],
  settings: Settings
): RebalanceOpportunity[] {
  const opportunities: RebalanceOpportunity[] = [];
  
  for (const position of positions) {
    const currentVault = vaults.find(v => v.address === position.vaultAddress);
    if (!currentVault) continue;
    
    // Find better vaults for same token
    const betterVaults = vaults.filter(v => 
      v.token === position.token &&
      v.address !== position.vaultAddress &&
      v.apy.gt(currentVault.apy)
    );
    
    for (const targetVault of betterVaults) {
      const apyGain = targetVault.apy.minus(currentVault.apy);
      
      if (apyGain.lt(settings.minYieldImprovement)) continue;
      
      // Calculate fees
      const withdrawalFee = position.valueUsd.mul(currentVault.withdrawalFeePercent).div(100);
      const depositFee = position.valueUsd.mul(targetVault.depositFeePercent).div(100);
      const gasCost = new Decimal(GAS_COST_SOL * 2 * SOL_PRICE_USD);
      const totalFees = withdrawalFee.plus(depositFee).plus(gasCost);
      
      // Monthly gain
      const monthlyYieldGain = position.valueUsd.mul(apyGain).div(100).div(12);
      
      // Break-even
      const breakEvenDays = totalFees.div(monthlyYieldGain.div(30)).toNumber();
      
      const isProfitable = breakEvenDays <= settings.timeHorizonDays && 
                          position.valueUsd.gte(settings.minRebalanceAmountUsd);
      
      opportunities.push({
        fromVault: currentVault,
        toVault: targetVault,
        token: position.token,
        amount: position.tokenAmount,
        currentApy: currentVault.apy,
        newApy: targetVault.apy,
        apyGain,
        estimatedFees: totalFees,
        estimatedMonthlyGain: monthlyYieldGain,
        breakEvenDays: Math.ceil(breakEvenDays),
        isProfitable,
      });
    }
  }
  
  opportunities.sort((a, b) => b.estimatedMonthlyGain.minus(a.estimatedMonthlyGain).toNumber());
  return opportunities;
}

async function scan(client: KaminoClient, settings: Settings) {
  console.log('🔍 Scanning Kamino vaults...\n');
  
  const vaults = await client.getReserves();
  const profile = settings.riskProfiles[settings.riskTolerance];
  
  // Filter and sort
  const filtered = vaults
    .filter(v => v.tvlUsd.gte(profile.minTvlUsd) && v.isActive)
    .sort((a, b) => b.apy.minus(a.apy).toNumber());
  
  console.log(`Found ${filtered.length} vaults (${settings.riskTolerance} risk profile):\n`);
  
  for (const vault of filtered) {
    console.log(`  ${vault.name.padEnd(20)} ${vault.apy.toFixed(2).padStart(6)}% APY  ($${formatNumber(vault.tvlUsd)} TVL)`);
  }
  
  return filtered;
}

async function status(client: KaminoClient, wallet: Keypair) {
  console.log('📊 Current positions:\n');
  
  const positions = await client.getUserPositions(wallet.publicKey);
  const solBalance = await client.getSolBalance(wallet.publicKey);
  
  console.log(`  Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`  SOL Balance: ${solBalance.toFixed(4)} SOL ($${solBalance.mul(SOL_PRICE_USD).toFixed(2)})\n`);
  
  if (positions.length === 0) {
    console.log('  No positions found in Kamino vaults.');
    return positions;
  }
  
  let totalValue = new Decimal(0);
  let weightedApy = new Decimal(0);
  
  for (const pos of positions) {
    console.log(`  ${pos.vaultName}: ${pos.tokenAmount} ${pos.token} ($${pos.valueUsd.toFixed(2)}) @ ${pos.currentApy.toFixed(2)}% APY`);
    totalValue = totalValue.plus(pos.valueUsd);
    weightedApy = weightedApy.plus(pos.currentApy.mul(pos.valueUsd));
  }
  
  if (!totalValue.isZero()) {
    weightedApy = weightedApy.div(totalValue);
  }
  
  console.log(`\n  Total Value: $${totalValue.toFixed(2)}`);
  console.log(`  Weighted APY: ${weightedApy.toFixed(2)}%`);
  console.log(`  Est. Monthly: $${totalValue.mul(weightedApy).div(100).div(12).toFixed(2)}`);
  
  return positions;
}

async function optimize(client: KaminoClient, wallet: Keypair, settings: Settings) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           🌾 Kamino Yield Optimizer');
  console.log(`           ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Scan vaults
  const vaults = await scan(client, settings);
  
  // Get positions
  console.log('\n');
  const positions = await status(client, wallet);
  
  // Find opportunities
  console.log('\n🔄 Analyzing rebalance opportunities...\n');
  const opportunities = findRebalanceOpportunities(positions, vaults, settings);
  
  if (opportunities.length === 0) {
    console.log('  No rebalance opportunities found.\n');
    return;
  }
  
  for (const opp of opportunities) {
    const status = opp.isProfitable ? '✅' : '❌';
    console.log(`  ${status} ${opp.token}: ${opp.currentApy.toFixed(2)}% → ${opp.newApy.toFixed(2)}% (+${opp.apyGain.toFixed(2)}%)`);
    console.log(`     Fees: $${opp.estimatedFees.toFixed(4)}, Monthly gain: $${opp.estimatedMonthlyGain.toFixed(2)}, Break-even: ${opp.breakEvenDays}d`);
  }
  
  // Execute profitable rebalances
  const profitable = opportunities.filter(o => o.isProfitable);
  
  if (profitable.length === 0) {
    console.log('\n  No profitable rebalances at this time.\n');
    return;
  }
  
  console.log(`\n⚡ Executing ${profitable.length} rebalance(s)...\n`);
  
  for (const opp of profitable) {
    if (settings.dryRun) {
      console.log(`  [DRY RUN] Would move ${opp.amount} ${opp.token}:`);
      console.log(`    From: ${opp.fromVault?.name}`);
      console.log(`    To: ${opp.toVault.name}`);
      console.log(`    APY gain: +${opp.apyGain.toFixed(2)}%\n`);
    } else {
      try {
        console.log(`  Moving ${opp.amount} ${opp.token} to ${opp.toVault.name}...`);
        
        // Withdraw from current vault
        if (opp.fromVault) {
          const withdrawTx = await client.withdraw(
            wallet,
            opp.fromVault.address,
            opp.amount,
            opp.fromVault.tokenMint
          );
          console.log(`    Withdraw tx: ${withdrawTx.slice(0, 8)}...`);
        }
        
        // Deposit to new vault
        const depositTx = await client.deposit(
          wallet,
          opp.toVault.address,
          opp.amount,
          opp.toVault.tokenMint
        );
        console.log(`    Deposit tx: ${depositTx.slice(0, 8)}...`);
        console.log(`    ✅ Success!\n`);
      } catch (error: any) {
        console.error(`    ❌ Error: ${error.message}\n`);
      }
    }
  }
  
  console.log('═══════════════════════════════════════════════════════════\n');
}

function formatNumber(n: Decimal): string {
  const num = n.toNumber();
  if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
  return num.toFixed(0);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'optimize';
  
  const settings = await loadSettings();
  const wallet = await loadWallet();
  const client = new KaminoClient(settings.rpcUrl);
  
  await client.initialize();
  
  switch (command) {
    case 'scan':
      await scan(client, settings);
      break;
    case 'status':
      await status(client, wallet);
      break;
    case 'optimize':
      await optimize(client, wallet, settings);
      break;
    case 'deposit':
      const depositVault = args[1];
      const depositAmount = new Decimal(args[2] || 0);
      console.log(`Depositing ${depositAmount} to ${depositVault}...`);
      // TODO: Implement manual deposit
      break;
    case 'withdraw':
      const withdrawVault = args[1];
      const withdrawAmount = new Decimal(args[2] || 0);
      console.log(`Withdrawing ${withdrawAmount} from ${withdrawVault}...`);
      // TODO: Implement manual withdraw
      break;
    default:
      console.log('Usage: npx ts-node src/index.ts <scan|status|optimize|deposit|withdraw>');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
