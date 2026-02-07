/**
 * Reposition: Withdraw JitoSOL from Ethena Market → Deposit in Main Market → Borrow USDG
 * Uses klend-sdk v7 with @solana/kit (v2 RPC)
 */
const {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  address,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  appendTransactionMessageInstruction,
  getComputeUnitEstimateForTransactionMessageFactory,
} = require('@solana/kit');
const { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID } = require('@kamino-finance/klend-sdk');
const { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } = require('@solana-program/compute-budget');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=726a9138-ef71-4b59-a820-ca2478c2b20a';
const WSS_URL = 'wss://mainnet.helius-rpc.com/?api-key=726a9138-ef71-4b59-a820-ca2478c2b20a';
const ETHENA_MARKET_ADDR = address('H6rHXmXoCQvq8Ue81MqNh7ow5ysPa1dSozwW3PU1dDH6');
const MAIN_MARKET_ADDR = address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const WALLET_PATH = path.join(__dirname, '../config/wallet.json');

async function setup() {
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WSS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  
  const walletData = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(walletData));
  
  console.log('🔑 Wallet:', signer.address);
  const balance = await rpc.getBalance(signer.address).send();
  console.log('💰 SOL:', (Number(balance.value) / 1e9).toFixed(6));
  
  return { rpc, rpcSubscriptions, signer, sendAndConfirm };
}

async function buildAndSend(rpc, signer, sendAndConfirm, instructions, label) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  
  // Prepend compute budget
  const computeIxs = [
    getSetComputeUnitLimitInstruction({ units: 800_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: 50_000n }),
  ];
  
  const allIxs = [...computeIxs, ...instructions];
  
  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(signer.address, m),
    m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    m => appendTransactionMessageInstructions(allIxs, m),
  );
  
  // Sign
  const signedTx = await signTransactionMessageWithSigners(txMessage);
  const sig = getSignatureFromTransaction(signedTx);
  console.log(`📡 ${label} TX:`, sig);
  
  // Send and confirm
  await sendAndConfirm(signedTx, { commitment: 'confirmed' });
  console.log(`✅ ${label} confirmed!`);
  return sig;
}

async function step1_withdraw(rpc, signer, sendAndConfirm) {
  console.log('\n=== STEP 1: Withdraw JitoSOL from Ethena Market ===');
  
  const market = await KaminoMarket.load(rpc, ETHENA_MARKET_ADDR, 400, PROGRAM_ID);
  if (!market) throw new Error('Failed to load Ethena market');
  
  const jitosolReserve = market.getReserves().find(r => r.getTokenSymbol() === 'JITOSOL');
  if (!jitosolReserve) throw new Error('JitoSOL reserve not found');
  console.log('JitoSOL reserve:', jitosolReserve.address);
  
  // Get obligation
  const obligation = await market.getObligationByWallet(signer.address, new VanillaObligation(PROGRAM_ID));
  if (!obligation) throw new Error('No obligation in Ethena market');
  console.log('Obligation:', obligation.obligationAddress);
  
  const deposits = obligation.getDeposits();
  const jitosolDep = deposits.find(d => d.mintAddress === JITOSOL_MINT);
  if (!jitosolDep) throw new Error('No JitoSOL deposit found');
  
  // Use the raw amount (cToken amount from the position)
  const amount = jitosolDep.amount;
  console.log('Deposit amount:', amount.toString(), '(~$' + jitosolDep.marketValueRefreshed?.toFixed(2) + ')');
  
  const currentSlot = BigInt(await rpc.getSlot().send());
  
  const action = await KaminoAction.buildWithdrawTxns({
    kaminoMarket: market,
    amount: amount.toFixed(0),
    reserveAddress: jitosolReserve.address,
    owner: signer,
    obligation: new VanillaObligation(PROGRAM_ID),
    currentSlot,
    includeAtaIxs: true,
    useV2Ixs: true,
  });
  
  const allIxs = [
    ...action.setupIxs,
    ...action.lendingIxs,
    ...action.cleanupIxs,
  ].filter(Boolean);
  
  console.log('Instructions:', allIxs.length, '|', action.lendingIxsLabels.join(', '));
  
  const sig = await buildAndSend(rpc, signer, sendAndConfirm, allIxs, 'Withdraw');
  return sig;
}

async function step2_deposit(rpc, signer, sendAndConfirm) {
  console.log('\n=== STEP 2: Deposit JitoSOL into Main Market ===');
  
  const market = await KaminoMarket.load(rpc, MAIN_MARKET_ADDR, 400, PROGRAM_ID);
  if (!market) throw new Error('Failed to load Main market');
  
  const jitosolReserve = market.getReserves().find(r => r.getTokenSymbol() === 'JITOSOL');
  if (!jitosolReserve) throw new Error('JitoSOL reserve not found in Main market');
  console.log('JitoSOL reserve:', jitosolReserve.address);
  
  // Check wallet JitoSOL balance
  const tokenAccounts = await rpc.getTokenAccountsByOwner(
    signer.address,
    { mint: address(JITOSOL_MINT) },
    { encoding: 'jsonParsed' }
  ).send();
  
  if (tokenAccounts.value.length === 0) throw new Error('No JitoSOL ATA found');
  const tokenAmount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
  console.log('JitoSOL in wallet:', tokenAmount.uiAmountString);
  
  if (Number(tokenAmount.amount) === 0) throw new Error('No JitoSOL to deposit');
  
  const currentSlot = BigInt(await rpc.getSlot().send());
  
  const action = await KaminoAction.buildDepositTxns({
    kaminoMarket: market,
    amount: tokenAmount.amount,
    reserveAddress: jitosolReserve.address,
    owner: signer,
    obligation: new VanillaObligation(PROGRAM_ID),
    currentSlot,
    includeAtaIxs: true,
    useV2Ixs: true,
  });
  
  const allIxs = [
    ...action.setupIxs,
    ...action.lendingIxs,
    ...action.cleanupIxs,
  ].filter(Boolean);
  
  console.log('Instructions:', allIxs.length, '|', action.lendingIxsLabels.join(', '));
  
  const sig = await buildAndSend(rpc, signer, sendAndConfirm, allIxs, 'Deposit');
  return sig;
}

async function step3_borrow(rpc, signer, sendAndConfirm) {
  console.log('\n=== STEP 3: Borrow USDG at ~30% LTV ===');
  
  const market = await KaminoMarket.load(rpc, MAIN_MARKET_ADDR, 400, PROGRAM_ID);
  if (!market) throw new Error('Failed to load Main market');
  
  // Get obligation to check deposit value
  const obligation = await market.getObligationByWallet(signer.address, new VanillaObligation(PROGRAM_ID));
  if (!obligation) throw new Error('No obligation in Main market');
  
  const deposits = obligation.getDeposits();
  let totalValue = 0;
  for (const dep of deposits) {
    const val = Number(dep.marketValueRefreshed || 0);
    console.log('  Deposit:', dep.mintAddress, '~$' + val.toFixed(2));
    totalValue += val;
  }
  console.log('Total deposit: $' + totalValue.toFixed(2));
  
  // Find USDG reserve
  const usdgReserve = market.getReserves().find(r => r.getTokenSymbol() === 'USDG');
  if (!usdgReserve) throw new Error('USDG reserve not found');
  console.log('USDG reserve:', usdgReserve.address);
  
  // Borrow 30% LTV
  const borrowUsd = totalValue * 0.30;
  const borrowLamports = Math.floor(borrowUsd * 1e6).toString(); // USDG = 6 decimals
  console.log('Borrowing:', borrowUsd.toFixed(2), 'USDG (~30% LTV)');
  
  const currentSlot = BigInt(await rpc.getSlot().send());
  
  const action = await KaminoAction.buildBorrowTxns({
    kaminoMarket: market,
    amount: borrowLamports,
    reserveAddress: usdgReserve.address,
    owner: signer,
    obligation: new VanillaObligation(PROGRAM_ID),
    currentSlot,
    includeAtaIxs: true,
    useV2Ixs: true,
  });
  
  const allIxs = [
    ...action.setupIxs,
    ...action.lendingIxs,
    ...action.cleanupIxs,
  ].filter(Boolean);
  
  console.log('Instructions:', allIxs.length, '|', action.lendingIxsLabels.join(', '));
  
  const sig = await buildAndSend(rpc, signer, sendAndConfirm, allIxs, 'Borrow');
  return sig;
}

async function main() {
  const { rpc, rpcSubscriptions, signer, sendAndConfirm } = await setup();
  const step = process.argv[2] || 'all';
  
  try {
    if (step === '1' || step === 'withdraw' || step === 'all') {
      await step1_withdraw(rpc, signer, sendAndConfirm);
    }
    if (step === '2' || step === 'deposit' || step === 'all') {
      await step2_deposit(rpc, signer, sendAndConfirm);
    }
    if (step === '3' || step === 'borrow' || step === 'all') {
      await step3_borrow(rpc, signer, sendAndConfirm);
    }
    
    console.log('\n🎉 Repositioning complete!');
  } catch (err) {
    console.error('❌ Failed:', err.message);
    if (err.context) console.error('Context:', JSON.stringify(err.context).substring(0, 500));
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  }
  
  // Close subscriptions
  process.exit(0);
}

main();
