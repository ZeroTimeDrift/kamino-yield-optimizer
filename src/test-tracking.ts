/**
 * Test Tracking Modules
 * 
 * Test script to run yield tracker, range monitor, and rewards tracker
 * and report current portfolio snapshot and any rewards found.
 */

import { Connection, Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { createYieldTracker } from './yield-tracker';
import { createRangeMonitor } from './range-monitor';
import { createRewardsTracker } from './rewards-tracker';
import { Settings } from './types';

async function loadSettings(): Promise<Settings> {
  const settingsPath = path.join(__dirname, '../config/settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
}

async function loadWallet(): Promise<Keypair> {
  const walletPath = path.join(__dirname, '../config/wallet.json');
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

async function main() {
  console.log('🧪 Testing Kamino Tracking Modules');
  console.log('══════════════════════════════════════════════\n');

  try {
    // Load configuration
    const settings = await loadSettings();
    const wallet = await loadWallet();
    const connection = new Connection(settings.rpcUrl);

    console.log(`💳 Wallet: ${wallet.publicKey.toString()}`);
    console.log(`🌐 RPC: ${settings.rpcUrl.replace(/api-key=.*/g, 'api-key=***')}\n`);

    // Test 1: Yield Tracker
    console.log('📊 **Testing Yield Tracker**');
    console.log('──────────────────────────────');
    
    try {
      const yieldTracker = await createYieldTracker(connection, wallet, settings);
      
      // Capture current snapshot
      console.log('📸 Capturing portfolio snapshot...');
      const snapshot = await yieldTracker.captureSnapshot();
      
      console.log(`✅ Snapshot captured:`);
      console.log(`   📈 Total Value: ${parseFloat(snapshot.portfolioTotalValueSol).toFixed(4)} SOL ($${parseFloat(snapshot.portfolioTotalValueUsd).toFixed(2)})`);
      console.log(`   📊 Positions: ${snapshot.positions.length}`);
      
      for (const position of snapshot.positions) {
        console.log(`   🎯 ${position.strategy}: $${parseFloat(position.value).toFixed(2)} @ ${parseFloat(position.apy).toFixed(2)}% APY`);
      }
      
      if (snapshot.impermanentLoss) {
        const loss = parseFloat(snapshot.impermanentLoss.lossPercent);
        console.log(`   ⚠️ Impermanent Loss: ${loss.toFixed(2)}%`);
      }
      
      // Get performance summary if history exists
      const summary = await yieldTracker.getPerformanceSummary();
      console.log('\n📈 Performance Summary:');
      console.log(summary);
      
    } catch (error) {
      console.error('❌ Yield Tracker failed:', error instanceof Error ? error.message : 'Unknown error');
    }

    console.log('\n📡 **Testing Range Monitor**');
    console.log('──────────────────────────────');
    
    try {
      const rangeMonitor = await createRangeMonitor(connection, wallet, settings);
      
      // Check position ranges
      const alerts = await rangeMonitor.monitorPositions(wallet.publicKey.toString());
      
      console.log(`🔍 Range check completed: ${alerts.length} alerts`);
      
      for (const alert of alerts) {
        const status = alert.type === 'OUT_OF_RANGE' ? '🚨' : '⚠️';
        console.log(`   ${status} ${alert.message}`);
      }
      
      if (alerts.length === 0) {
        console.log('   ✅ All positions are in acceptable range');
      }
      
      // Get range summary
      const rangeSummary = await rangeMonitor.getRangeSummary();
      console.log('\n📊 Range Summary:');
      console.log(rangeSummary);
      
    } catch (error) {
      console.error('❌ Range Monitor failed:', error instanceof Error ? error.message : 'Unknown error');
    }

    console.log('\n🎁 **Testing Rewards Tracker**');
    console.log('──────────────────────────────');
    
    try {
      const rewardsTracker = await createRewardsTracker(connection, wallet, settings);
      
      // Check rewards
      const rewardsSummary = await rewardsTracker.getRewardsSummary();
      console.log(rewardsSummary);
      
    } catch (error) {
      console.error('❌ Rewards Tracker failed:', error instanceof Error ? error.message : 'Unknown error');
    }

  } catch (error) {
    console.error('💥 Test failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }

  console.log('\n✅ **Testing Complete**');
  console.log('══════════════════════════════════════════════');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('💥 Fatal error:', error);
      process.exit(1);
    });
}

export { main as testTracking };