// @ts-nocheck
/**
 * Deep analysis: Which accounts are static and can we add more LUTs?
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  createSolanaRpc, address, Address, none, createKeyPairSignerFromBytes,
  pipe, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  compileTransactionMessage, AccountRole, Instruction,
} from '@solana/kit';
import {
  KaminoMarket, PROGRAM_ID, getWithdrawWithLeverageIxs,
  MultiplyObligation, VanillaObligation,
} from '@kamino-finance/klend-sdk';
import { MultiplyClient } from './multiply-client';
import Decimal from 'decimal.js';
import * as fs from 'fs';

const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=726a9138-ef71-4b59-a820-ca2478c2b20a';

async function main() {
  const keypairData = JSON.parse(fs.readFileSync('config/wallet.json', 'utf8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const conn = new Connection(RPC_URL, 'confirmed');
  const rpc = createSolanaRpc(RPC_URL);

  const client = new MultiplyClient(RPC_URL);
  const positions = await client.getUserMultiplyPositions(wallet.publicKey);
  const pos = positions[0];

  const market = await KaminoMarket.load(rpc, address(pos.marketAddress), 400, PROGRAM_ID);
  if (!market) throw new Error('Failed to load market');

  const currentSlot = await conn.getSlot('confirmed');
  const owner = await createKeyPairSignerFromBytes(wallet.secretKey as any);

  const reserves = market.getReserves();
  const collReserve = reserves.find((r: any) => r.getLiquidityMint().toString().toLowerCase() === pos.collateralMint.toLowerCase());
  const debtReserve = reserves.find((r: any) => r.symbol.toUpperCase() === 'SOL');

  let obligation = await market.getObligationByAddress(address(pos.obligationAddress));
  if (!obligation) throw new Error('No obligation');

  const quoter = (client as any).createJupiterQuoter();
  const swapper = (client as any).createJupiterSwapper(wallet.publicKey.toBase58());

  const deposited = new Decimal(pos.collateralAmount.toString()).mul(1e9);
  const borrowed = new Decimal(pos.debtAmount.toString()).mul(1e9);
  const solBalance = await conn.getBalance(wallet.publicKey);

  console.log('Getting SDK instructions...');
  const withdrawResults = await getWithdrawWithLeverageIxs({
    owner, kaminoMarket: market,
    collReserveAddress: address(collReserve.address.toString()),
    debtReserveAddress: address(debtReserve.address.toString()),
    obligation, deposited, borrowed,
    referrer: none(), currentSlot: BigInt(currentSlot),
    withdrawAmount: deposited, priceCollToDebt: new Decimal('1.05'),
    slippagePct: new Decimal(0.005), isClosingPosition: true,
    selectedTokenMint: address(pos.collateralMint),
    budgetAndPriorityFeeIxs: undefined, scopeRefreshIx: [],
    quoteBufferBps: new Decimal(50), quoter, swapper,
    useV2Ixs: true, userSolBalanceLamports: solBalance,
  } as any);

  const result = withdrawResults[0];
  const ixs: Instruction[] = result.ixs;
  const luts = result.lookupTables || [];

  // Collect all accounts with their roles
  const accountRoles = new Map<string, Set<number>>();
  const accountPrograms = new Map<string, Set<string>>(); // which programs reference this account
  for (const ix of ixs) {
    if (!ix.accounts) continue;
    for (const acc of ix.accounts) {
      const addr = acc.address as string;
      if (!accountRoles.has(addr)) accountRoles.set(addr, new Set());
      accountRoles.get(addr)!.add(acc.role);
      if (!accountPrograms.has(addr)) accountPrograms.set(addr, new Set());
      accountPrograms.get(addr)!.add(ix.programAddress as string);
    }
  }

  // Build LUT address sets
  const lutAddressSet = new Set<string>();
  const lutRecord: { [key: string]: Address[] } = {};
  for (const lut of luts) {
    const lutAddr = lut.address?.toString();
    if (!lutAddr) continue;
    const rawAddresses = lut.data?.state?.addresses || lut.data?.addresses || [];
    const kitAddresses: Address[] = rawAddresses.map((a: any) =>
      address(typeof a === 'string' ? a : a.toBase58 ? a.toBase58() : String(a))
    );
    lutRecord[address(lutAddr)] = kitAddresses;
    for (const a of kitAddresses) lutAddressSet.add(a as string);
  }

  // Demote CPI signers first
  const demotedIxs: Instruction[] = ixs.map(ix => {
    if (!ix.accounts) return ix;
    const newAccounts = ix.accounts.map(acc => {
      if (acc.address === owner.address) return acc;
      if (acc.role === AccountRole.WRITABLE_SIGNER) return { ...acc, role: AccountRole.WRITABLE };
      if (acc.role === AccountRole.READONLY_SIGNER) return { ...acc, role: AccountRole.READONLY };
      return acc;
    });
    return { ...ix, accounts: newAccounts };
  });

  // Build and compress
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

  txMessage = compressTransactionMessageUsingAddressLookupTables(txMessage, lutRecord);
  const compiled = compileTransactionMessage(txMessage);

  // Analyze static accounts
  const staticAccounts = compiled.staticAccounts;
  const compressedAccounts = new Set<string>();
  for (const atl of (compiled.addressTableLookups || [])) {
    // We can't easily resolve indexes back, but we know compressed count
  }

  console.log(`\n=== STATIC ACCOUNTS: ${staticAccounts.length} ===`);
  console.log('(These are NOT compressed into LUTs)\n');

  const walletAddr = owner.address as string;
  let writableCount = 0;
  let readonlyCount = 0;

  for (let i = 0; i < staticAccounts.length; i++) {
    const addr = staticAccounts[i] as string;
    const roles = accountRoles.get(addr);
    const programs = accountPrograms.get(addr);
    const inLut = lutAddressSet.has(addr);
    const isWallet = addr === walletAddr;
    const isProgram = programs ? false : true; // if not in any instruction accounts, it might be a program

    // Check if it's a signer in the compiled message
    const isSigner = i < compiled.header.numSignerAccounts;
    const isWritable = isSigner 
      ? i < (compiled.header.numSignerAccounts - compiled.header.numReadonlySignerAccounts)
      : i < (staticAccounts.length - compiled.header.numReadonlyNonSignerAccounts);

    if (isWritable) writableCount++;
    else readonlyCount++;

    const roleStr = isSigner ? (isWritable ? 'WRITABLE_SIGNER' : 'READONLY_SIGNER') : (isWritable ? 'WRITABLE' : 'READONLY');
    const flags = [
      isWallet ? '👤WALLET' : '',
      inLut ? '📋inLUT' : '🚫notInLUT',
      roles ? `roles:[${[...roles].map(r => AccountRole[r]).join(',')}]` : 'programID',
    ].filter(Boolean).join(' ');

    console.log(`  [${i}] ${addr.slice(0, 12)}... ${roleStr} ${flags}`);
  }

  console.log(`\nHeader: ${compiled.header.numSignerAccounts} signers, ${compiled.header.numReadonlySignerAccounts} ro-signers, ${compiled.header.numReadonlyNonSignerAccounts} ro-nonsigners`);
  console.log(`Writable: ${writableCount}, Readonly: ${readonlyCount}`);

  // Count accounts NOT in any LUT
  const notInLut = [...accountRoles.keys()].filter(a => !lutAddressSet.has(a));
  console.log(`\nAccounts NOT in any LUT: ${notInLut.length}`);
  
  // Identify writable accounts in the static list that COULD be in a LUT
  const compressible = staticAccounts.filter((addr, i) => {
    const isSigner = i < compiled.header.numSignerAccounts;
    return !isSigner && addr !== walletAddr;
  });
  console.log(`Potentially compressible (non-signer static): ${compressible.length}`);
  console.log(`If all compressed: ${staticAccounts.length - compressible.length} static accounts would remain`);
  console.log(`Estimated size: ${(staticAccounts.length - compressible.length) * 32 + 200} bytes (rough)`);
  
  // List the compressible ones
  console.log('\nCompressible accounts not in existing LUTs:');
  for (const addr of compressible) {
    const addrStr = addr as string;
    if (!lutAddressSet.has(addrStr)) {
      const progs = accountPrograms.get(addrStr);
      console.log(`  ${addrStr.slice(0, 20)}... programs: ${progs ? [...progs].map(p => p.slice(0, 8)).join(',') : 'N/A'}`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e.message); console.error(e.stack?.split('\n').slice(1, 5).join('\n')); });
