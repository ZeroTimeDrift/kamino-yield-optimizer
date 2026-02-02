/**
 * Kamino Yield Optimizer - AGGRESSIVE MODE
 * Maximizes yield by:
 * - Scanning ALL available vaults
 * - Auto-depositing idle balances
 * - Rebalancing to highest APY vaults
 * - Tracking performance over time
 */

import { KaminoClient } from './kamino-client';
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

// Config
const GAS_BUFFER_SOL = 0.005; // Buffer for gas + ATA creation fees
const MIN_DEPOSIT_SOL = 0.003; // Deposit anything above this
const MIN_REBALANCE_APY_GAIN = 0.25; // Rebalance for even 0.25% APY improvement
const COINGECKO_SOL_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

interface PerformanceLog {
  timestamp: string;
  solBalance: string;
  positionValue: string;
  totalValue: string;
  apy: string;
  action: string;
}

async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch(COINGECKO_SOL_PRICE_URL);
    const data = await res.json() as any;
    return data.solana?.usd || 200;
  } catch {
    return 200; // Fallback
  }
}

async function loadSettings() {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
}

async function loadWallet(): Promise<Keypair> {
  const walletPath = path.join(__dirname, '../config/wallet.json');
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function logPerformance(log: PerformanceLog) {
  const logPath = path.join(__dirname, '../config/performance.jsonl');
  fs.appendFileSync(logPath, JSON.stringify(log) + '\n');
}

async function main() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🚀 KAMINO YIELD OPTIMIZER - AGGRESSIVE MODE');
  console.log(`     ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const settings = await loadSettings();
  const wallet = await loadWallet();
  const client = new KaminoClient(settings.rpcUrl);
  const solPrice = await getSolPrice();
  
  await client.initialize();
  
  // 1. Current state
  const solBalance = await client.getSolBalance(wallet.publicKey);
  const solValueUsd = solBalance.mul(solPrice);
  
  console.log(`💳 Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`   SOL: ${solBalance.toFixed(6)} (~$${solValueUsd.toFixed(2)}) @ $${solPrice.toFixed(0)}/SOL`);
  
  // 2. Scan ALL vaults and sort by APY
  console.log('\n🔍 Scanning all vaults...\n');
  const vaults = await client.getReserves();
  
  // Show top 10 by APY
  const topVaults = vaults.slice(0, 10);
  for (const v of topVaults) {
    const marker = v.apy.gt(5) ? '🔥' : v.apy.gt(2) ? '✨' : '  ';
    console.log(`   ${marker} ${v.name.padEnd(15)} ${v.apy.toFixed(2).padStart(6)}% APY`);
  }
  
  // 3. Get current positions
  console.log('\n📊 Current positions...');
  const positions = await client.getUserPositions(wallet.publicKey);
  
  let totalPositionValue = new Decimal(0);
  let currentWeightedApy = new Decimal(0);
  let actions: string[] = [];
  
  if (positions.length === 0) {
    console.log('   No active positions.\n');
  } else {
    for (const pos of positions) {
      // Convert from lamports to SOL for display
      const tokenAmount = pos.token === 'SOL' 
        ? pos.tokenAmount.div(LAMPORTS_PER_SOL) 
        : pos.tokenAmount.div(1e6);
      const valueUsd = tokenAmount.mul(pos.token === 'SOL' ? solPrice : 1);
      
      console.log(`   ${pos.vaultName}: ${tokenAmount.toFixed(6)} ${pos.token} (~$${valueUsd.toFixed(2)}) @ ${pos.currentApy.toFixed(2)}% APY`);
      
      totalPositionValue = totalPositionValue.plus(valueUsd);
      currentWeightedApy = currentWeightedApy.plus(pos.currentApy.mul(valueUsd));
      
      // Check for better vault
      const betterVaults = vaults.filter(v => 
        v.token === pos.token && 
        v.address !== pos.vaultAddress &&
        v.apy.minus(pos.currentApy).gte(MIN_REBALANCE_APY_GAIN) &&
        v.apy.gt(0)
      );
      
      if (betterVaults.length > 0) {
        const best = betterVaults[0];
        const apyGain = best.apy.minus(pos.currentApy);
        const yearlyGainUsd = valueUsd.mul(apyGain).div(100);
        
        console.log(`      💡 Better: ${best.name} (+${apyGain.toFixed(2)}% = +$${yearlyGainUsd.toFixed(2)}/yr)`);
        
        if (!settings.dryRun) {
          console.log(`      ⚡ Rebalancing...`);
          try {
            // Withdraw
            const withdrawAmt = pos.token === 'SOL' 
              ? pos.tokenAmount.div(LAMPORTS_PER_SOL)
              : pos.tokenAmount.div(1e6);
            const wSig = await client.withdraw(wallet, pos.token, withdrawAmt);
            console.log(`         Withdrew: ${wSig.slice(0, 20)}...`);
            
            // Small delay for state to settle
            await new Promise(r => setTimeout(r, 2000));
            
            // Re-check balance and deposit
            const newBal = await client.getSolBalance(wallet.publicKey);
            const depositAmt = newBal.minus(GAS_BUFFER_SOL);
            
            if (depositAmt.gt(MIN_DEPOSIT_SOL)) {
              const dSig = await client.deposit(wallet, pos.token, depositAmt);
              console.log(`         Deposited to ${best.name}: ${dSig.slice(0, 20)}...`);
              actions.push(`Rebalanced ${depositAmt.toFixed(4)} ${pos.token} to ${best.name} (+${apyGain.toFixed(2)}% APY)`);
            }
          } catch (err: any) {
            console.log(`      ❌ Failed: ${err.message}`);
          }
        }
      }
    }
    
    if (!totalPositionValue.isZero()) {
      currentWeightedApy = currentWeightedApy.div(totalPositionValue);
    }
    console.log(`\n   Total: $${totalPositionValue.toFixed(2)} @ ${currentWeightedApy.toFixed(2)}% weighted APY`);
  }
  
  // 4. Auto-deposit idle SOL
  const availableSol = solBalance.minus(GAS_BUFFER_SOL);
  
  if (availableSol.gt(MIN_DEPOSIT_SOL)) {
    const bestSolVault = vaults.find(v => v.token === 'SOL' && v.apy.gt(0));
    
    if (bestSolVault) {
      const yearlyYield = availableSol.mul(solPrice).mul(bestSolVault.apy).div(100);
      console.log(`\n💰 Idle SOL detected: ${availableSol.toFixed(6)} SOL`);
      console.log(`   Best vault: ${bestSolVault.name} @ ${bestSolVault.apy.toFixed(2)}% APY`);
      console.log(`   Potential yield: $${yearlyYield.toFixed(2)}/year`);
      
      if (!settings.dryRun) {
        console.log(`\n⚡ Auto-depositing...`);
        try {
          const sig = await client.deposit(wallet, 'SOL', availableSol);
          console.log(`   ✅ Deposited ${availableSol.toFixed(6)} SOL`);
          console.log(`   Tx: ${sig}`);
          actions.push(`Deposited ${availableSol.toFixed(4)} SOL to ${bestSolVault.name}`);
        } catch (err: any) {
          console.log(`   ❌ Deposit failed: ${err.message}`);
        }
      }
    }
  }
  
  // 5. Final status
  const finalSolBalance = await client.getSolBalance(wallet.publicKey);
  const finalPositions = await client.getUserPositions(wallet.publicKey);
  
  let finalPositionValue = new Decimal(0);
  for (const pos of finalPositions) {
    const tokenAmount = pos.token === 'SOL' 
      ? pos.tokenAmount.div(LAMPORTS_PER_SOL) 
      : pos.tokenAmount.div(1e6);
    finalPositionValue = finalPositionValue.plus(tokenAmount.mul(pos.token === 'SOL' ? solPrice : 1));
  }
  
  const totalValue = finalSolBalance.mul(solPrice).plus(finalPositionValue);
  
  // Log performance
  logPerformance({
    timestamp: new Date().toISOString(),
    solBalance: finalSolBalance.toFixed(6),
    positionValue: finalPositionValue.toFixed(2),
    totalValue: totalValue.toFixed(2),
    apy: currentWeightedApy.toFixed(2),
    action: actions.length > 0 ? actions.join('; ') : 'No action'
  });
  
  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                      📈 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   SOL Balance: ${finalSolBalance.toFixed(6)} SOL`);
  console.log(`   Positions:   $${finalPositionValue.toFixed(2)}`);
  console.log(`   Total Value: $${totalValue.toFixed(2)}`);
  if (actions.length > 0) {
    console.log(`   Actions:     ${actions.length} executed`);
    for (const a of actions) {
      console.log(`                - ${a}`);
    }
  } else {
    console.log(`   Actions:     None needed`);
  }
  console.log(`   Runtime:     ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err.message || err);
    process.exit(1);
  });
