/**
 * Deploy idle JitoSOL into the active LP vault.
 * Single-sided deposit — no swap needed, much cheaper than full rebalance.
 *
 * Vault: HCntzqDU5wXSWjwgLQP5hqh3kLHRYizKtPErvSCyggXd
 * Token B = JitoSOL (single-sided deposit B)
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { LiquidityClient } from './liquidity-client';
import { TOKEN_MINTS } from './types';

const ACTIVE_VAULT = 'HCntzqDU5wXSWjwgLQP5hqh3kLHRYizKtPErvSCyggXd';
const MIN_GAS_SOL = 0.003;
const MAX_COST_USD = 0.50;
const SLIPPAGE_BPS = 50; // 0.5%

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     💰 DEPLOY IDLE JitoSOL TO LP VAULT');
  console.log(`     ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const settingsPath = path.join(__dirname, '../config/settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

  const walletPath = path.join(__dirname, '../config/wallet.json');
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const connection = new Connection(settings.rpcUrl, { commitment: 'confirmed' });

  console.log(`💳 Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`🏦 Vault: ${ACTIVE_VAULT}`);
  console.log(`🧪 Dry run: ${settings.dryRun ? 'YES' : 'NO'}\n`);

  // 1. Gas reserve check
  const solLamports = await connection.getBalance(wallet.publicKey);
  const solBalance = new Decimal(solLamports).div(LAMPORTS_PER_SOL);
  console.log(`⛽ SOL balance: ${solBalance.toFixed(6)} SOL`);

  if (solBalance.lt(MIN_GAS_SOL)) {
    console.log(`❌ SOL balance ${solBalance.toFixed(6)} < ${MIN_GAS_SOL} minimum. Cannot pay for tx fees.`);
    process.exit(1);
  }

  // 2. Get idle JitoSOL balance
  let idleJitoSol = new Decimal(0);
  try {
    const jitosolMint = new PublicKey(TOKEN_MINTS.JitoSOL);
    const tokenAccounts = await connection.getTokenAccountsByOwner(
      wallet.publicKey,
      { mint: jitosolMint }
    );
    for (const { account } of tokenAccounts.value) {
      const data = account.data;
      const amount = data.readBigUInt64LE(64);
      idleJitoSol = idleJitoSol.plus(new Decimal(amount.toString()).div(1e9));
    }
  } catch (err: any) {
    console.log(`❌ Failed to get JitoSOL balance: ${err.message}`);
    process.exit(1);
  }

  console.log(`💧 Idle JitoSOL: ${idleJitoSol.toFixed(6)}`);

  if (idleJitoSol.lt(0.01)) {
    console.log(`ℹ️ Idle JitoSOL ${idleJitoSol.toFixed(6)} too small to deploy. Exiting.`);
    process.exit(0);
  }

  // 3. Verify vault is in range
  const liquidityClient = new LiquidityClient(settings.rpcUrl);
  const vaultDetails = await liquidityClient.getVaultDetails(ACTIVE_VAULT);

  if (!vaultDetails) {
    console.log(`❌ Could not fetch vault details for ${ACTIVE_VAULT}`);
    process.exit(1);
  }

  console.log(`\n📊 Vault Status:`);
  console.log(`   ${vaultDetails.name} | APY: ${vaultDetails.totalApy.toFixed(2)}%`);
  console.log(`   Range: [${vaultDetails.priceLower.toFixed(6)}, ${vaultDetails.priceUpper.toFixed(6)}]`);
  console.log(`   Pool price: ${vaultDetails.poolPrice.toFixed(6)}`);
  console.log(`   Out of range: ${vaultDetails.outOfRange ? '❌ YES' : '✅ NO'}`);

  if (vaultDetails.outOfRange) {
    console.log(`\n❌ Vault is OUT OF RANGE. Not deploying — would earn 0%.`);
    process.exit(1);
  }

  // 4. Estimate costs
  // Single-sided deposit B: tx fee (~0.000005-0.0005 SOL) + internal swap slippage on ~50% of amount
  const estimatedTxFeeSol = new Decimal(0.0005); // conservative
  const internalSwapSlippage = idleJitoSol.mul(0.5).mul(0.003); // ~0.3% on half the amount
  const totalCostSol = estimatedTxFeeSol.plus(internalSwapSlippage);

  // Get SOL price
  let solPrice = new Decimal(200);
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json() as any;
    solPrice = new Decimal(data.solana?.usd ?? 200);
  } catch {}

  const totalCostUsd = totalCostSol.mul(solPrice);

  console.log(`\n💸 Estimated costs:`);
  console.log(`   Tx fee: ~${estimatedTxFeeSol.toFixed(6)} SOL`);
  console.log(`   Internal swap slippage: ~${internalSwapSlippage.toFixed(6)} SOL`);
  console.log(`   Total: ~${totalCostSol.toFixed(6)} SOL (~$${totalCostUsd.toFixed(4)})`);
  console.log(`   Max allowed: $${MAX_COST_USD}`);

  if (totalCostUsd.gt(MAX_COST_USD)) {
    console.log(`\n❌ Estimated cost $${totalCostUsd.toFixed(4)} exceeds $${MAX_COST_USD} limit. Not deploying.`);
    process.exit(1);
  }

  // 5. Calculate extra yield
  const holdApy = new Decimal(5.57);
  const lpApy = vaultDetails.totalApy;
  const apyGain = lpApy.minus(holdApy);
  const yearlyGainSol = idleJitoSol.mul(apyGain).div(100);
  const yearlyGainUsd = yearlyGainSol.mul(solPrice);

  console.log(`\n📈 Yield improvement:`);
  console.log(`   Hold: ${holdApy.toFixed(2)}% → LP: ${lpApy.toFixed(2)}% (+${apyGain.toFixed(2)}%)`);
  console.log(`   Extra yield: ~${yearlyGainSol.toFixed(6)} SOL/year (~$${yearlyGainUsd.toFixed(2)}/year)`);
  console.log(`   Break-even: ~${totalCostSol.div(yearlyGainSol.div(365)).toFixed(1)} days`);

  // 6. Execute deposit
  console.log(`\n⚡ Executing single-sided deposit of ${idleJitoSol.toFixed(6)} JitoSOL...`);

  const result = await liquidityClient.singleSidedDepositB(
    wallet,
    ACTIVE_VAULT,
    idleJitoSol,
    SLIPPAGE_BPS,
    settings.dryRun,
  );

  if (result.success) {
    console.log(`✅ ${result.message}`);
    if (result.signature) {
      console.log(`   Tx: https://solscan.io/tx/${result.signature}`);
    }

    // Log to performance
    const logEntry = {
      timestamp: new Date().toISOString(),
      action: 'deploy-idle',
      amount: idleJitoSol.toFixed(6),
      token: 'JitoSOL',
      vault: ACTIVE_VAULT,
      estimatedCostUsd: totalCostUsd.toFixed(4),
      estimatedYearlyGainUsd: yearlyGainUsd.toFixed(2),
      signature: result.signature || null,
      dryRun: settings.dryRun,
    };
    const logPath = path.join(__dirname, '../config/performance.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
  } else {
    console.log(`❌ ${result.message}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`     ${result.success ? '✅' : '❌'} DEPLOY COMPLETE`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err.message || err);
    process.exit(1);
  });
