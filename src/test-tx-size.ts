// @ts-nocheck
/**
 * Test: Verify the executeSdkInstructions rewrite produces a tx that fits in 1232 bytes
 * This mimics closePosition logic but only checks size — does NOT send.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  createSolanaRpc,
  address,
  Address,
  none,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  partiallySignTransactionMessageWithSigners,
  getTransactionEncoder,
  compileTransactionMessage,
  getCompiledTransactionMessageEncoder,
  AccountRole,
  Instruction,
} from '@solana/kit';
import {
  KaminoMarket,
  PROGRAM_ID,
  getWithdrawWithLeverageIxs,
  MultiplyObligation,
  VanillaObligation,
} from '@kamino-finance/klend-sdk';
import { MultiplyClient } from './multiply-client';
import Decimal from 'decimal.js';
import * as fs from 'fs';

const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=726a9138-ef71-4b59-a820-ca2478c2b20a';

async function main() {
  const keypairData = JSON.parse(fs.readFileSync('config/wallet.json', 'utf8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const conn = new Connection(RPC_URL, 'confirmed');

  console.log('Wallet:', wallet.publicKey.toBase58());

  // Use MultiplyClient to get positions
  const client = new MultiplyClient(RPC_URL);
  const positions = await client.getUserMultiplyPositions(wallet.publicKey);

  if (positions.length === 0) {
    console.log('No multiply positions found');
    return;
  }

  const pos = positions[0];
  console.log(`\nPosition: ${pos.collateralToken}/${pos.debtToken} @ ${pos.leverage.toFixed(2)}x`);
  console.log(`  Collateral: ${pos.collateralAmount.toFixed(6)} ${pos.collateralToken}`);
  console.log(`  Debt: ${pos.debtAmount.toFixed(6)} ${pos.debtToken}`);
  console.log(`  Market: ${pos.marketAddress.slice(0, 12)}...`);
  console.log(`  Obligation: ${pos.obligationAddress}`);

  // Load market via SDK
  const rpc = createSolanaRpc(RPC_URL);
  console.log('\nLoading market...');
  const market = await KaminoMarket.load(rpc, address(pos.marketAddress), 400, PROGRAM_ID);
  if (!market) throw new Error('Failed to load market');

  const currentSlot = await conn.getSlot('confirmed');
  const owner = await createKeyPairSignerFromBytes(wallet.secretKey as any);

  // Find reserves
  const reserves = market.getReserves();
  const collReserve = reserves.find((r: any) =>
    r.getLiquidityMint().toString().toLowerCase() === pos.collateralMint.toLowerCase()
  );
  const debtReserve = reserves.find((r: any) => r.symbol.toUpperCase() === 'SOL');

  if (!collReserve || !debtReserve) throw new Error('Reserves not found');

  // Load obligation
  let obligation: any;
  if (pos.obligationAddress) {
    obligation = await market.getObligationByAddress(address(pos.obligationAddress));
  }
  if (!obligation) {
    const multiplyOblType = new MultiplyObligation(
      address(pos.collateralMint), address('So11111111111111111111111111111111'),
      PROGRAM_ID, 0
    );
    obligation = await market.getObligationByWallet(owner.address, multiplyOblType);
  }
  if (!obligation) {
    const vanillaOblType = new VanillaObligation(PROGRAM_ID);
    obligation = await market.getObligationByWallet(owner.address, vanillaOblType);
  }
  if (!obligation) throw new Error('Could not load obligation');
  console.log(`Obligation loaded: ${obligation.obligationAddress?.toString?.()?.slice(0, 12)}...`);

  // Create Jupiter quoter/swapper
  const quoter = (client as any).createJupiterQuoter();
  const swapper = (client as any).createJupiterSwapper(wallet.publicKey.toBase58());

  const deposited = new Decimal(pos.collateralAmount.toString()).mul(1e9);
  const borrowed = new Decimal(pos.debtAmount.toString()).mul(1e9);
  const solBalance = await conn.getBalance(wallet.publicKey);

  console.log('\nGetting withdraw-with-leverage instructions from SDK...');
  const withdrawResults = await getWithdrawWithLeverageIxs({
    owner,
    kaminoMarket: market,
    collReserveAddress: address(collReserve.address.toString()),
    debtReserveAddress: address(debtReserve.address.toString()),
    obligation,
    deposited,
    borrowed,
    referrer: none(),
    currentSlot: BigInt(currentSlot),
    withdrawAmount: deposited,
    priceCollToDebt: new Decimal('1.05'),
    slippagePct: new Decimal(0.005),
    isClosingPosition: true,
    selectedTokenMint: address(pos.collateralMint),
    budgetAndPriorityFeeIxs: undefined,
    scopeRefreshIx: [],
    quoteBufferBps: new Decimal(50),
    quoter,
    swapper,
    useV2Ixs: true,
    userSolBalanceLamports: solBalance,
  } as any);

  console.log(`SDK returned ${withdrawResults.length} tx batch(es)`);

  for (let i = 0; i < withdrawResults.length; i++) {
    const result = withdrawResults[i];
    const ixs: Instruction[] = result.ixs;
    const luts = result.lookupTables || [];

    console.log(`\n=== Batch ${i + 1}: ${ixs.length} ixs, ${luts.length} LUTs ===`);

    // Count unique accounts and CPI signers
    const allAccounts = new Set<string>();
    let cpiSignerCount = 0;
    for (const ix of ixs) {
      if (!ix.accounts) continue;
      for (const acc of ix.accounts) {
        allAccounts.add(acc.address as string);
        if ((acc.role === AccountRole.WRITABLE_SIGNER || acc.role === AccountRole.READONLY_SIGNER) 
            && acc.address !== owner.address) {
          cpiSignerCount++;
        }
      }
    }
    console.log(`  Unique accounts: ${allAccounts.size}`);
    console.log(`  CPI signer references: ${cpiSignerCount}`);

    // ─── Method 1: OLD approach (web3.js bridge) — for comparison ───
    console.log('\n--- OLD method (web3.js bridge, no CPI demotion) ---');
    try {
      const { TransactionMessage, TransactionInstruction } = require('@solana/web3.js');
      
      const txInstructions = ixs.map((ix: any) => new TransactionInstruction({
        programId: new PublicKey(ix.programAddress.toString()),
        keys: (ix.accounts || []).map((acc: any) => ({
          pubkey: new PublicKey(acc.address.toString()),
          isSigner: acc.role === AccountRole.WRITABLE_SIGNER || acc.role === AccountRole.READONLY_SIGNER,
          isWritable: acc.role === AccountRole.WRITABLE_SIGNER || acc.role === AccountRole.WRITABLE,
        })),
        data: Buffer.from(ix.data),
      }));

      const lutAccounts: any[] = [];
      for (const lut of luts) {
        const lutAddr = lut.address?.toString();
        if (!lutAddr) continue;
        const lutInfo = await conn.getAddressLookupTable(new PublicKey(lutAddr));
        if (lutInfo.value) lutAccounts.push(lutInfo.value);
      }

      const latestBlockhash = await conn.getLatestBlockhash('confirmed');
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: txInstructions,
      }).compileToV0Message(lutAccounts);
      
      const vtx = new VersionedTransaction(messageV0);
      vtx.sign([wallet]);
      const serialized = vtx.serialize();
      console.log(`  OLD tx size: ${serialized.length}/1232 bytes — ${serialized.length <= 1232 ? '✅' : '❌ TOO LARGE'}`);
    } catch (e: any) {
      console.log(`  OLD method FAILED: ${e.message}`);
    }

    // ─── Method 2: NEW approach (kit v2 native with CPI demotion) ───
    console.log('\n--- NEW method (kit v2 native + CPI demotion + LUT compression) ---');
    try {
      // Demote CPI signers
      const demotedIxs: Instruction[] = ixs.map(ix => {
        if (!ix.accounts) return ix;
        const newAccounts = ix.accounts.map(acc => {
          if (acc.address === owner.address) return acc;
          if (acc.role === AccountRole.WRITABLE_SIGNER) {
            return { ...acc, role: AccountRole.WRITABLE };
          }
          if (acc.role === AccountRole.READONLY_SIGNER) {
            return { ...acc, role: AccountRole.READONLY };
          }
          return acc;
        });
        return { ...ix, accounts: newAccounts };
      });

      // Build LUT record (plain object, NOT Map)
      const lutRecord: Record<string, readonly Address[]> = {};
      for (const lut of luts) {
        const lutAddr = lut.address?.toString();
        if (!lutAddr) continue;
        const rawAddresses = lut.data?.state?.addresses || lut.data?.addresses || [];
        const kitAddresses: Address[] = rawAddresses.map((a: any) =>
          address(typeof a === 'string' ? a : a.toBase58 ? a.toBase58() : String(a))
        );
        if (kitAddresses.length > 0) {
          lutRecord[address(lutAddr) as string] = kitAddresses;
          console.log(`  LUT ${lutAddr.slice(0, 12)}...: ${kitAddresses.length} entries`);
        }
      }

      const latestBlockhash = await conn.getLatestBlockhash('confirmed');

      let txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        msg => setTransactionMessageFeePayer(owner.address, msg),
        msg => setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: latestBlockhash.blockhash as any, lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight) },
          msg
        ),
        msg => appendTransactionMessageInstructions(demotedIxs, msg),
      );

      // Apply LUT compression
      if (Object.keys(lutRecord).length > 0) {
        txMessage = compressTransactionMessageUsingAddressLookupTables(txMessage, lutRecord);
      }

      // Compile to check structure
      const compiled = compileTransactionMessage(txMessage);
      console.log(`  Static accounts: ${compiled.staticAccounts.length}`);
      console.log(`  Address table lookups: ${(compiled.addressTableLookups || []).length}`);
      for (const atl of (compiled.addressTableLookups || [])) {
        console.log(`    LUT ${String(atl.lookupTableAddress).slice(0, 12)}...: ${atl.writableIndexes.length}W + ${atl.readonlyIndexes.length}R = ${atl.writableIndexes.length + atl.readonlyIndexes.length} compressed`);
      }

      // Sign
      const signedTx = await partiallySignTransactionMessageWithSigners(txMessage);

      // Encode
      const txEncoder = getTransactionEncoder();
      const wireFormat = txEncoder.encode(signedTx);
      console.log(`  NEW tx size: ${wireFormat.length}/1232 bytes — ${wireFormat.length <= 1232 ? '✅ FITS!' : '❌ TOO LARGE'}`);

      if (wireFormat.length <= 1232) {
        console.log('\n🎉 SUCCESS: Transaction fits within Solana limit with new method!');
        
        // Optionally simulate
        console.log('\nSimulating transaction...');
        const simResult = await conn.simulateTransaction(
          VersionedTransaction.deserialize(wireFormat),
          { commitment: 'confirmed' }
        );
        if (simResult.value.err) {
          console.log('  Simulation error:', JSON.stringify(simResult.value.err));
          console.log('  Logs:', simResult.value.logs?.slice(-5));
        } else {
          console.log('  ✅ Simulation succeeded!');
          console.log('  CU used:', simResult.value.unitsConsumed);
        }
      }
    } catch (e: any) {
      console.log(`  NEW method FAILED: ${e.message}`);
      console.log('  Stack:', e.stack?.split('\n').slice(1, 4).join('\n'));
    }
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  console.error(e.stack?.split('\n').slice(1, 5).join('\n'));
});
