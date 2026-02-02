import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { 
  VaultInfo, 
  Position, 
  RebalanceOpportunity, 
  OptimizationResult, 
  ExecutedRebalance,
  Settings,
  TOKEN_MINTS,
} from './types';
import { loadSettings, scanAllVaults } from './scanner';

const SOL_PRICE_USD = 150; // Should fetch dynamically
const GAS_COST_SOL = 0.000005;

export async function loadWallet(): Promise<Keypair> {
  const walletPath = path.join(__dirname, '../config/wallet.json');
  
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet not found at ${walletPath}. Run: solana-keygen new -o ${walletPath}`);
  }
  
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

export async function getCurrentPositions(
  connection: Connection,
  wallet: PublicKey,
  vaults: VaultInfo[]
): Promise<Position[]> {
  const positions: Position[] = [];
  
  // In production, use klend-sdk to fetch actual positions:
  // const kaminoMarket = await KaminoMarket.load(connection, marketAddress);
  // const obligations = await kaminoMarket.getAllUserObligations(wallet);
  
  // For now, return mock positions for development
  // This would be replaced with actual on-chain data
  
  console.log('📊 Fetching current positions...\n');
  
  // Check token accounts and match to vault share mints
  for (const vault of vaults) {
    try {
      // Would use: const shares = await vaultSDK.getUserShares(wallet);
      // For now, placeholder logic
      
      // Mock: assume small position in first vault for testing
      if (vault.name === 'USDC Earn Main') {
        positions.push({
          vaultAddress: vault.address,
          vaultName: vault.name,
          token: vault.token,
          shares: new Decimal(100),
          tokenAmount: new Decimal(100),
          valueUsd: new Decimal(100),
          currentApy: vault.apy,
          depositedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
          unrealizedPnl: new Decimal(0.14), // ~7.5% APY for 7 days on $100
        });
      }
    } catch (error) {
      // No position in this vault
    }
  }
  
  for (const pos of positions) {
    console.log(`  ${pos.vaultName}: ${pos.tokenAmount} ${pos.token} ($${pos.valueUsd}) @ ${pos.currentApy}% APY`);
  }
  
  if (positions.length === 0) {
    console.log('  No positions found');
  }
  
  return positions;
}

export function findRebalanceOpportunities(
  positions: Position[],
  vaults: VaultInfo[],
  settings: Settings
): RebalanceOpportunity[] {
  const opportunities: RebalanceOpportunity[] = [];
  const profile = settings.riskProfiles[settings.riskTolerance];
  
  console.log('\n🔄 Analyzing rebalance opportunities...\n');
  
  // For each position, check if there's a better vault
  for (const position of positions) {
    const currentVault = vaults.find(v => v.address === position.vaultAddress);
    if (!currentVault) continue;
    
    // Find better vaults for the same token
    const betterVaults = vaults.filter(v => 
      v.token === position.token &&
      v.address !== position.vaultAddress &&
      v.apy.gt(currentVault.apy)
    );
    
    for (const targetVault of betterVaults) {
      const apyGain = targetVault.apy.minus(currentVault.apy);
      
      // Skip if gain is below threshold
      if (apyGain.lt(settings.minYieldImprovement)) continue;
      
      // Calculate fees
      const withdrawalFee = position.valueUsd.mul(currentVault.withdrawalFeePercent).div(100);
      const depositFee = position.valueUsd.mul(targetVault.depositFeePercent).div(100);
      const gasCost = new Decimal(GAS_COST_SOL * 2 * SOL_PRICE_USD); // 2 txs
      const totalFees = withdrawalFee.plus(depositFee).plus(gasCost);
      
      // Calculate monthly gain
      const monthlyYieldGain = position.valueUsd.mul(apyGain).div(100).div(12);
      
      // Break-even calculation
      const breakEvenDays = totalFees.div(monthlyYieldGain.div(30)).toNumber();
      
      // Is it profitable within time horizon?
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
  
  // Also look for fresh deposit opportunities (uninvested tokens)
  // This would check wallet token balances
  
  // Sort by monthly gain
  opportunities.sort((a, b) => b.estimatedMonthlyGain.minus(a.estimatedMonthlyGain).toNumber());
  
  for (const opp of opportunities) {
    const status = opp.isProfitable ? '✅' : '❌';
    console.log(`  ${status} ${opp.token}: ${opp.currentApy}% → ${opp.newApy}% (+${opp.apyGain.toFixed(2)}%)`);
    console.log(`     Fees: $${opp.estimatedFees.toFixed(4)}, Monthly gain: $${opp.estimatedMonthlyGain.toFixed(2)}, Break-even: ${opp.breakEvenDays}d`);
  }
  
  if (opportunities.length === 0) {
    console.log('  No profitable rebalance opportunities found');
  }
  
  return opportunities;
}

export async function executeRebalance(
  connection: Connection,
  wallet: Keypair,
  opportunity: RebalanceOpportunity,
  settings: Settings
): Promise<ExecutedRebalance> {
  console.log(`\n⚡ Executing rebalance: ${opportunity.token} → ${opportunity.toVault.name}`);
  
  if (settings.dryRun) {
    console.log('  [DRY RUN] Would execute:');
    console.log(`    1. Withdraw ${opportunity.amount} ${opportunity.token} from ${opportunity.fromVault?.name}`);
    console.log(`    2. Deposit ${opportunity.amount} ${opportunity.token} to ${opportunity.toVault.name}`);
    
    return {
      opportunity,
      withdrawTx: 'DRY_RUN',
      depositTx: 'DRY_RUN',
      success: true,
    };
  }
  
  try {
    // In production, use klend-sdk:
    // 
    // 1. Withdraw from current vault
    // const withdrawAction = await KaminoAction.buildWithdrawTxns(
    //   kaminoMarket,
    //   amount,
    //   tokenMint,
    //   wallet.publicKey,
    //   new VanillaObligation(PROGRAM_ID)
    // );
    // const withdrawTx = await sendTransactionFromAction(connection, withdrawAction, wallet);
    //
    // 2. Deposit to new vault
    // const depositAction = await KaminoAction.buildDepositTxns(
    //   kaminoMarket,
    //   amount,
    //   tokenMint,
    //   wallet.publicKey,
    //   new VanillaObligation(PROGRAM_ID)
    // );
    // const depositTx = await sendTransactionFromAction(connection, depositAction, wallet);
    
    // For now, return placeholder
    console.log('  ⚠️  Execution not yet implemented - use SDK integration');
    
    return {
      opportunity,
      withdrawTx: null,
      depositTx: '',
      success: false,
      error: 'SDK integration pending',
    };
  } catch (error: any) {
    console.error(`  ❌ Error: ${error.message}`);
    return {
      opportunity,
      withdrawTx: null,
      depositTx: '',
      success: false,
      error: error.message,
    };
  }
}

export async function runOptimization(): Promise<OptimizationResult> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           🌾 Kamino Yield Optimizer');
  console.log(`           ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const settings = await loadSettings();
  const connection = new Connection(settings.rpcUrl, 'confirmed');
  
  // Load wallet
  let wallet: Keypair;
  try {
    wallet = await loadWallet();
    console.log(`💳 Wallet: ${wallet.publicKey.toBase58().slice(0, 8)}...`);
  } catch (error: any) {
    console.error(`❌ ${error.message}`);
    throw error;
  }
  
  // Scan vaults
  const vaults = await scanAllVaults(settings);
  
  // Get current positions
  const positions = await getCurrentPositions(connection, wallet.publicKey, vaults);
  
  // Find opportunities
  const opportunities = findRebalanceOpportunities(positions, vaults, settings);
  
  // Execute profitable rebalances
  const executedRebalances: ExecutedRebalance[] = [];
  const profitableOpps = opportunities.filter(o => o.isProfitable);
  
  if (profitableOpps.length > 0) {
    console.log(`\n🎯 Found ${profitableOpps.length} profitable rebalance(s)`);
    
    for (const opp of profitableOpps) {
      const result = await executeRebalance(connection, wallet, opp, settings);
      executedRebalances.push(result);
    }
  }
  
  // Calculate totals
  const totalValueUsd = positions.reduce((sum, p) => sum.plus(p.valueUsd), new Decimal(0));
  const weightedApy = positions.reduce((sum, p) => 
    sum.plus(p.currentApy.mul(p.valueUsd)), new Decimal(0)
  ).div(totalValueUsd.isZero() ? 1 : totalValueUsd);
  
  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                      Summary');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total Value:     $${totalValueUsd.toFixed(2)}`);
  console.log(`  Weighted APY:    ${weightedApy.toFixed(2)}%`);
  console.log(`  Positions:       ${positions.length}`);
  console.log(`  Opportunities:   ${opportunities.length} (${profitableOpps.length} profitable)`);
  console.log(`  Executed:        ${executedRebalances.filter(r => r.success).length}`);
  console.log('═══════════════════════════════════════════════════════════\n');
  
  return {
    timestamp: new Date(),
    scannedVaults: vaults.length,
    currentPositions: positions,
    opportunities,
    executedRebalances,
    totalValueUsd,
    weightedApy,
  };
}

// CLI entry point
if (require.main === module) {
  runOptimization()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
