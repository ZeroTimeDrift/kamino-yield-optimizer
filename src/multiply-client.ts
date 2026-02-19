/**
 * Kamino Multiply Client - SDK-based Implementation
 * 
 * Uses the official Kamino SDK leverage functions for single-transaction
 * flash loan operations instead of manual iterative borrow loops.
 *
 * Key changes from the previous version:
 * - Uses getDepositWithLeverageIxs for opening positions
 * - Uses getWithdrawWithLeverageIxs for closing positions
 * - Uses getAdjustLeverageIxs for adjusting leverage
 * - Uses MultiplyObligation with tag=1 for proper Kamino UI integration
 * - Integrates with Jupiter API for swap quotes and instructions
 * - Single atomic transactions via flash loans instead of multi-tx loops
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import { 
  createSolanaRpc, 
  address, 
  Address, 
  TransactionSigner, 
  Instruction,
  Option,
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
  AccountRole,
} from '@solana/kit';
import { 
  KaminoMarket, 
  PROGRAM_ID,
  getDepositWithLeverageIxs,
  getWithdrawWithLeverageIxs,
  getAdjustLeverageIxs,
  getScopeRefreshIxForObligationAndReserves,
  getUserLutAddressAndSetupIxs,
  getLookupTableAccounts,
} from '@kamino-finance/klend-sdk';
import { 
  MultiplyObligation,
  VanillaObligation,
  ObligationTypeTag,
  ObligationType 
} from '@kamino-finance/klend-sdk';
import Decimal from 'decimal.js';
import {
  MultiplyPosition,
  MultiplySettings,
  StrategyType,
  TOKEN_MINTS,
  TOKEN_DECIMALS,
  KAMINO_MARKETS,
} from './types';
import {
  fetchJitoApy,
  fetchReserves,
  fetchUserObligations,
  findReserve,
  ApiReserve,
  ApiObligation,
  scanMultiplyOpportunities,
  MultiplyOpportunity,
} from './kamino-api';

// ─── Types ──────────────────────────────────────────────────────

/** Per-market multiply rate analysis */
export interface MultiplyRates {
  market: string;
  marketAddress: string;
  jitosolStakingApy: Decimal;
  solBorrowApy: Decimal;
  spread: Decimal;
  netApyAt2x: Decimal;
  netApyAt3x: Decimal;
  netApyAt5x: Decimal;
  maxLtv: number;
}

/** Result of shouldOpenPosition — includes all markets */
export interface MultiplyAnalysis {
  profitable: boolean;
  reason: string;
  allMarketRates: MultiplyRates[];
  bestMarket: MultiplyRates | null;
  /** Multi-LST opportunities from Sanctum (new) */
  multiLstOpportunities?: MultiplyOpportunity[];
  /** Best opportunity across all LSTs and markets (new) */
  bestOpportunity?: MultiplyOpportunity | null;
}

/** Jupiter quote response (simplified) */
interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  priceImpactPct?: string;
}

/** Jupiter swap response */
interface JupiterSwapResponse {
  swapTransaction: string; // base64 serialized transaction
  lastValidBlockHeight?: number;
}

/** SDK-compatible swap quote */
interface SwapQuote<T = JupiterQuote> {
  priceAInB: Decimal;
  quoteResponse?: T;
}

/** SDK-compatible swap instructions */
interface SwapIxs<T = JupiterQuote> {
  preActionIxs: Instruction[];
  swapIxs: Instruction[];
  lookupTables: any[]; // AddressLookupTable accounts
  quote: SwapQuote<T>;
}

/** SDK swap inputs */
interface SwapInputs {
  inputAmountLamports: Decimal;
  minOutAmountLamports?: Decimal;
  inputMint: Address;
  outputMint: Address;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Calculate net APY at a given leverage */
function calcNetApy(stakingApy: Decimal, borrowApy: Decimal, leverage: number): Decimal {
  const lev = new Decimal(leverage);
  return stakingApy.mul(lev).minus(borrowApy.mul(lev.minus(1)));
}

// Retry helper for network operations
async function retry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      const isRateLimit = err.message?.includes('429') || err.message?.includes('Too Many');
      const wait = isRateLimit ? delayMs * (i + 2) : delayMs;
      console.log(`   ⏳ Multiply retry ${i + 1}/${maxRetries} in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('Max retries exceeded');
}

// ─── Known Markets ──────────────────────────────────────────────

const MULTIPLY_MARKETS = [
  { name: 'Main', address: KAMINO_MARKETS.MAIN },
  { name: 'Jito', address: KAMINO_MARKETS.JITO },
];

// ─── Jupiter Integration ───────────────────────────────────────

const JUPITER_API_BASE = 'https://public.jupiterapi.com';

/** Get Jupiter quote */
async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: Decimal,
  slippageBps: number = 50
): Promise<JupiterQuote> {
  const amountLamports = amount.toFixed(0);
  const url = `${JUPITER_API_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.status} ${response.statusText}`);
  }
  
  return response.json() as Promise<JupiterQuote>;
}

/** Get Jupiter swap instructions */
async function getJupiterSwapIxs(
  quote: JupiterQuote,
  userPubkey: string
): Promise<{ swapTransaction: string; lastValidBlockHeight?: number }> {
  const response = await fetch(`${JUPITER_API_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userPubkey,
      wrapAndUnwrapSol: true,
    }),
  });
  
  if (!response.ok) {
    throw new Error(`Jupiter swap failed: ${response.status} ${response.statusText}`);
  }
  
  return response.json() as Promise<JupiterSwapResponse>;
}

// ─── Client ─────────────────────────────────────────────────────

export class MultiplyClient {
  private connection: Connection;
  private rpc: ReturnType<typeof createSolanaRpc>;
  private settings: MultiplySettings;
  private markets: Map<string, KaminoMarket> = new Map();

  constructor(rpcUrl: string, settings?: Partial<MultiplySettings>) {
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    this.rpc = createSolanaRpc(rpcUrl);
    this.settings = {
      maxLeverage: settings?.maxLeverage ?? 5,
      minSpread: settings?.minSpread ?? 1.0,
      maxLtv: settings?.maxLtv ?? 0.85,
      preferredMarket: settings?.preferredMarket ?? KAMINO_MARKETS.JITO,
    };
  }

  /**
   * Ensure user has a Kamino lookup table (LUT) set up for this market.
   * 
   * The Kamino SDK expects each user to have a user-specific LUT containing market
   * accounts (reserves, obligations, etc.). This dramatically reduces transaction 
   * size by compressing ~30 Kamino accounts into LUT references.
   * 
   * If the user LUT doesn't exist, this method creates it by executing the setup
   * transactions from getUserLutAddressAndSetupIxs.
   * 
   * @returns The user LUT address, or null if creation failed
   */
  async ensureUserLut(
    market: KaminoMarket,
    wallet: Keypair,
    collReserveAddress?: Address,
    debtReserveAddress?: Address,
  ): Promise<Address | null> {
    try {
      const owner = await createKeyPairSignerFromBytes(wallet.secretKey as unknown as Uint8Array);
      
      // Check if user already has a LUT that exists on-chain
      const [, userMetadata] = await market.getUserMetadata(owner.address);
      if (userMetadata?.userLookupTable) {
        const lutAddr = userMetadata.userLookupTable as Address;
        // Verify it actually exists on chain (metadata can be stale)
        const lutPubkey = new PublicKey(lutAddr as string);
        const lutInfo = await this.connection.getAddressLookupTable(lutPubkey);
        if (lutInfo.value && lutInfo.value.state.addresses.length > 0) {
          console.log(`   📋 User LUT exists: ${(lutAddr as string).slice(0, 12)}... (${lutInfo.value.state.addresses.length} addresses)`);
          return lutAddr;
        }
        console.log(`   ⚠️  User LUT metadata found but account ${lutInfo.value ? 'empty' : 'missing'} on-chain, recreating...`);
      }

      console.log(`   🔧 Creating user LUT for Kamino market...`);
      
      // Build reserve addresses for the LUT
      const multiplyReserves = (collReserveAddress && debtReserveAddress) 
        ? [{ coll: collReserveAddress, debt: debtReserveAddress }] 
        : [];

      const [lutAddress, setupIxsBatches] = await getUserLutAddressAndSetupIxs(
        market,
        owner,
        none(), // referrer
        true,   // withExtendLut
        multiplyReserves, // multiplyReserveAddresses
        [],     // leverageReserveAddresses
        undefined, // repayWithCollObligation
        owner,  // payer
      );

      console.log(`   📋 User LUT address: ${(lutAddress as string).slice(0, 12)}...`);
      console.log(`   📤 Setup requires ${setupIxsBatches.length} transaction(s)`);

      // Execute each setup batch as a separate transaction
      for (let i = 0; i < setupIxsBatches.length; i++) {
        const batchIxs = setupIxsBatches[i] as Instruction[];
        if (!batchIxs || batchIxs.length === 0) continue;

        const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
        
        let txMessage = pipe(
          createTransactionMessage({ version: 0 }),
          msg => setTransactionMessageFeePayer(owner.address, msg),
          msg => setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: latestBlockhash.blockhash as any, lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight) },
            msg
          ),
          msg => appendTransactionMessageInstructions(batchIxs, msg),
        );

        const signedTx = await partiallySignTransactionMessageWithSigners(txMessage);
        const txEncoder = getTransactionEncoder();
        const wireFormat = txEncoder.encode(signedTx);

        const sig = await this.connection.sendRawTransaction(Buffer.from(wireFormat), {
          skipPreflight: false,
          maxRetries: 3,
        });

        await this.connection.confirmTransaction(
          { signature: sig, ...latestBlockhash },
          'confirmed'
        );
        console.log(`   ✅ LUT setup tx ${i + 1}/${setupIxsBatches.length}: ${sig.slice(0, 16)}...`);
      }

      // Wait a moment for the LUT to activate
      console.log(`   ⏳ Waiting for LUT activation...`);
      await new Promise(r => setTimeout(r, 2000));

      return lutAddress;
    } catch (err: any) {
      console.log(`   ⚠️  User LUT setup failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Extend the user LUT with any accounts from the SDK instructions that aren't
   * already covered by existing LUTs (Jupiter swap LUTs + user LUT).
   * 
   * This ensures all Kamino program accounts, reserves, market addresses, etc.
   * are in the LUT for maximum transaction compression.
   */
  private async extendUserLutWithMissingAccounts(
    sdkIxs: Instruction[],
    swapLookupTables: any[],
    userLutAddress: Address,
    wallet: Keypair,
  ): Promise<void> {
    const owner = await createKeyPairSignerFromBytes(wallet.secretKey as unknown as Uint8Array);
    const ownerAddress = owner.address;
    
    // Collect all unique accounts from instructions (excluding fee payer)
    const allAccounts = new Set<string>();
    for (const ix of sdkIxs) {
      allAccounts.add(String(ix.programAddress));
      for (const acc of (ix.accounts || [])) {
        const addr = String(acc.address);
        if (addr !== String(ownerAddress)) {
          allAccounts.add(addr);
        }
      }
    }

    // Collect all addresses already in existing LUTs
    const coveredAddresses = new Set<string>();
    
    // From swap LUTs
    for (const lut of (swapLookupTables || [])) {
      const rawAddresses = lut.data?.state?.addresses || lut.data?.addresses || [];
      for (const a of rawAddresses) {
        coveredAddresses.add(typeof a === 'string' ? a : a.toBase58 ? a.toBase58() : String(a));
      }
    }
    
    // From user LUT
    try {
      const userLutPubkey = new PublicKey(userLutAddress as string);
      const lutInfo = await this.connection.getAddressLookupTable(userLutPubkey);
      if (lutInfo.value) {
        for (const a of lutInfo.value.state.addresses) {
          coveredAddresses.add(a.toBase58());
        }
      }
    } catch {}

    // Find missing accounts
    const missingAccounts: Address[] = [];
    for (const acct of allAccounts) {
      if (!coveredAddresses.has(acct)) {
        missingAccounts.push(address(acct));
      }
    }

    if (missingAccounts.length === 0) {
      console.log(`   ✅ All accounts covered by existing LUTs`);
      return;
    }

    console.log(`   🔧 Extending user LUT with ${missingAccounts.length} missing accounts...`);

    // Extend the LUT in chunks of 20 (Solana limit per extend instruction)
    const { extendLookupTableIxs } = require('@kamino-finance/klend-sdk');
    const chunkSize = 20;
    for (let i = 0; i < missingAccounts.length; i += chunkSize) {
      const chunk = missingAccounts.slice(i, i + chunkSize);
      const extendIxs = extendLookupTableIxs(owner, userLutAddress, chunk, owner);

      for (const extendIx of extendIxs) {
        const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
        
        let txMessage = pipe(
          createTransactionMessage({ version: 0 }),
          msg => setTransactionMessageFeePayer(ownerAddress, msg),
          msg => setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: latestBlockhash.blockhash as any, lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight) },
            msg
          ),
          msg => appendTransactionMessageInstructions([extendIx], msg),
        );

        const signedTx = await partiallySignTransactionMessageWithSigners(txMessage);
        const txEncoder = getTransactionEncoder();
        const wireFormat = txEncoder.encode(signedTx);

        const sig = await this.connection.sendRawTransaction(Buffer.from(wireFormat), {
          skipPreflight: false,
          maxRetries: 3,
        });

        await this.connection.confirmTransaction(
          { signature: sig, ...latestBlockhash },
          'confirmed'
        );
        console.log(`   ✅ LUT extended: +${chunk.length} accounts (${sig.slice(0, 16)}...)`);
      }
    }

    // Wait for LUT to update
    await new Promise(r => setTimeout(r, 1000));
  }

  /**
   * Patch RefreshObligation instructions to include ALL reserves referenced by the obligation.
   * 
   * The SDK builds RefreshObligation with only the coll/debt reserves from the multiply pair,
   * but if the obligation has legacy positions in other reserves (e.g. dust USDG borrow),
   * the on-chain program requires all reserves as remaining accounts.
   */
  private patchRefreshObligationIxs(
    ixs: Instruction[],
    obligation: any,
    market: KaminoMarket,
  ): Instruction[] {
    if (!obligation?.state) return ixs;

    // Collect deposit and borrow reserves in obligation order
    const NULL_KEY = '11111111111111111111111111111111';
    const depositReserves: string[] = [];
    const borrowReserves: string[] = [];
    
    for (const dep of (obligation.state.deposits || [])) {
      const addr = dep.depositReserve?.toString();
      if (addr && addr !== NULL_KEY && !depositReserves.includes(addr)) {
        depositReserves.push(addr);
      }
    }
    for (const bor of (obligation.state.borrows || [])) {
      const addr = bor.borrowReserve?.toString();
      if (addr && addr !== NULL_KEY && !borrowReserves.includes(addr)) {
        borrowReserves.push(addr);
      }
    }

    const totalReserves = new Set([...depositReserves, ...borrowReserves]).size;
    if (totalReserves <= 2) return ixs; // No extra reserves to add

    // RefreshObligation discriminator: [33, 132, 147, 228, 151, 192, 72, 89]
    const REFRESH_DISC = Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]);
    const klendProgram = String(PROGRAM_ID);

    let refreshCount = 0;
    return ixs.map((ix, ixIndex) => {
      if (String(ix.programAddress) !== klendProgram) return ix;
      if (!ix.data || ix.data.length < 8) return ix;
      
      // Check discriminator
      const disc = Buffer.from(ix.data.slice(0, 8));
      if (!disc.equals(REFRESH_DISC)) return ix;

      refreshCount++;
      const fixedAccounts = (ix.accounts || []).slice(0, 2);
      const existing = (ix.accounts || []).slice(2);

      if (refreshCount === 1) {
        // FIRST RefreshObligation (before repay): needs all deposit + borrow reserves
        // Format: [unique_deposit_reserves..., unique_borrow_reserves...]
        // A reserve CAN appear in both lists (e.g. SOL in deposits AND borrows)
        const reserveAccs: Array<{address: Address, role: typeof AccountRole.WRITABLE}> = [];
        const addedDeps = new Set<string>();
        for (const r of depositReserves) {
          if (!addedDeps.has(r)) { addedDeps.add(r); reserveAccs.push({ address: address(r), role: AccountRole.WRITABLE }); }
        }
        const addedBors = new Set<string>();
        for (const r of borrowReserves) {
          if (!addedBors.has(r)) { addedBors.add(r); reserveAccs.push({ address: address(r), role: AccountRole.WRITABLE }); }
        }
        
        if (reserveAccs.length !== existing.length) {
          console.log(`   🔧 Patching RefreshObligation #1: ${existing.length} → ${reserveAccs.length} remaining accounts`);
        }
        return { ...ix, accounts: [...fixedAccounts, ...reserveAccs] };
      } else {
        // SUBSEQUENT RefreshObligation (after repay/withdraw): the SOL debt was just repaid,
        // so the obligation now has fewer borrow reserves. Use unique reserves (not deposits+borrows).
        const uniqueReserves = [...new Set([...depositReserves, ...borrowReserves])];
        const reserveAccs = uniqueReserves.map(r => ({ address: address(r), role: AccountRole.WRITABLE }));
        
        if (reserveAccs.length !== existing.length) {
          console.log(`   🔧 Patching RefreshObligation #${refreshCount}: ${existing.length} → ${reserveAccs.length} remaining accounts`);
        }
        return { ...ix, accounts: [...fixedAccounts, ...reserveAccs] };
      }
    });
  }

  /**
   * Execute SDK instructions natively via @solana/kit v2.
   * 
   * Uses compressTransactionMessageUsingAddressLookupTables for proper LUT compression
   * and partiallySignTransactionMessageWithSigners for CPI-compatible signing.
   * 
   * Key design:
   * 1. CPI signers are demoted to non-signer roles (they sign via CPI on-chain, not in the tx)
   * 2. Jupiter swap LUTs + Kamino user LUT are used for maximum compression
   * 3. RefreshObligation instructions are patched with all obligation reserves
   * 4. If the tx is still too large, extends the user LUT with missing accounts and retries
   */
  private async executeSdkInstructions(
    sdkIxs: Instruction[],
    lookupTables: any[],
    wallet: Keypair,
    label: string,
    userLutAddress?: Address | null,
    obligation?: any,
    market?: KaminoMarket,
  ): Promise<string> {
    const owner = await createKeyPairSignerFromBytes(wallet.secretKey as unknown as Uint8Array);
    const ownerAddress = owner.address;

    // Patch RefreshObligation instructions with all obligation reserves
    let patchedIxs = sdkIxs;
    if (obligation && market) {
      patchedIxs = this.patchRefreshObligationIxs(sdkIxs, obligation, market);
    }

    // Demote CPI signers: PDA accounts that sign via CPI, not actual transaction signers.
    const demotedIxs: Instruction[] = patchedIxs.map(ix => {
      if (!ix.accounts) return ix;
      const newAccounts = ix.accounts.map(acc => {
        if (acc.address === ownerAddress) return acc;
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

    console.log(`   📋 ${demotedIxs.length} ixs, ${(lookupTables || []).length} swap LUTs`);

    // Build and try to send, with one retry after extending LUT if too large
    for (let attempt = 0; attempt < 2; attempt++) {
      // Build LUT record for compression
      const lutRecord: { [key: Address]: Address[] } = {};
      
      // Add Jupiter/swap LUTs
      for (const lut of (lookupTables || [])) {
        const lutAddr = lut.address?.toString();
        if (!lutAddr) continue;
        
        const rawAddresses = lut.data?.state?.addresses || lut.data?.addresses || [];
        const kitAddresses: Address[] = rawAddresses.map((a: any) => 
          address(typeof a === 'string' ? a : a.toBase58 ? a.toBase58() : String(a))
        );
        
        if (kitAddresses.length > 0) {
          lutRecord[address(lutAddr)] = kitAddresses;
        }
      }

      // Add user LUT (Kamino market accounts) if available
      if (userLutAddress) {
        try {
          const userLutPubkey = new PublicKey(userLutAddress as string);
          const lutInfo = await this.connection.getAddressLookupTable(userLutPubkey);
          if (lutInfo.value) {
            const userLutAddresses: Address[] = lutInfo.value.state.addresses.map(
              (a: PublicKey) => address(a.toBase58())
            );
            lutRecord[userLutAddress] = userLutAddresses;
            console.log(`   📋 User LUT: ${userLutAddresses.length} Kamino addresses`);
          }
        } catch (err: any) {
          console.log(`   ⚠️  Failed to fetch user LUT: ${err.message}`);
        }
      }

      const totalLuts = Object.keys(lutRecord).length;
      console.log(`   🔍 Total LUTs for compression: ${totalLuts}`);

      // Get blockhash
      const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');

      // Build transaction message
      let txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        msg => setTransactionMessageFeePayer(ownerAddress, msg),
        msg => setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: latestBlockhash.blockhash as any, lastValidBlockHeight: BigInt(latestBlockhash.lastValidBlockHeight) },
          msg
        ),
        msg => appendTransactionMessageInstructions(demotedIxs, msg),
      );

      // Debug: check Cz4cm3c1 role before compression
      const debugTarget = 'Cz4cm3c1TqiuHHpqn2xE7A1eEmLRrrMeoBcQEKmiAEnS';
      for (let i = 0; i < demotedIxs.length; i++) {
        for (const acc of (demotedIxs[i].accounts || [])) {
          if (String(acc.address) === debugTarget) {
            console.log(`   🔍 DEBUG: Cz4cm3c1 in ix ${i}: role=${acc.role} (${['RO','RO_SIGN','WR','WR_SIGN'][acc.role]})`);
          }
        }
      }
      
      // Apply LUT compression
      if (totalLuts > 0) {
        txMessage = compressTransactionMessageUsingAddressLookupTables(txMessage, lutRecord);
        console.log(`   🗜️  LUT compression applied`);
      }

      // Sign
      const signedTx = await partiallySignTransactionMessageWithSigners(txMessage);

      // Encode to wire format
      const txEncoder = getTransactionEncoder();
      const wireFormat = txEncoder.encode(signedTx);
      console.log(`   📦 Tx size: ${wireFormat.length}/1232 bytes`);

      if (wireFormat.length <= 1232) {
        // Transaction fits! Send it.
        const sig = await this.connection.sendRawTransaction(Buffer.from(wireFormat), {
          skipPreflight: false,
          maxRetries: 2,
        });

        await this.connection.confirmTransaction(
          { signature: sig, ...latestBlockhash },
          'confirmed'
        );
        console.log(`   ✅ ${label} confirmed: ${sig.slice(0, 20)}...`);
        return sig;
      }

      // Transaction too large — extend user LUT with missing accounts
      if (attempt === 0 && userLutAddress) {
        console.log(`   ⚠️  Tx too large (${wireFormat.length} bytes), extending user LUT...`);
        await this.extendUserLutWithMissingAccounts(
          sdkIxs, lookupTables, userLutAddress, wallet
        );
        // Retry with the extended LUT
        continue;
      }

      throw new Error(
        `Transaction too large: ${wireFormat.length} bytes (limit 1232) even after LUT extension.`
      );
    }

    throw new Error('Unexpected: exited retry loop without returning');
  }

  /**
   * Load a Kamino market by address for SDK operations.
   */
  async loadMarket(marketAddress: string): Promise<KaminoMarket> {
    if (this.markets.has(marketAddress)) {
      return this.markets.get(marketAddress)!;
    }

    console.log(`   📡 Loading market ${marketAddress.slice(0, 8)}... (SDK)`);
    const market = await retry(() =>
      KaminoMarket.load(this.rpc, address(marketAddress), 400, PROGRAM_ID)
    );
    if (!market) throw new Error(`Failed to load market: ${marketAddress}`);

    this.markets.set(marketAddress, market);
    return market;
  }

  /**
   * Get multiply rates for a single market via REST API.
   * Pure math — no SDK loading.
   */
  async getMarketRates(
    marketName: string,
    marketAddress: string,
    jitoStakingApy: Decimal,
  ): Promise<MultiplyRates | null> {
    try {
      const reserves = await fetchReserves(marketAddress);
      const solReserve = findReserve(reserves, 'SOL');

      if (!solReserve) {
        console.log(`   ⚠️  No SOL reserve in ${marketName} market`);
        return null;
      }

      const solBorrowApy = new Decimal(solReserve.borrowApy);

      // Find JitoSOL reserve for maxLtv
      const jitosolReserve = findReserve(reserves, 'JITOSOL');
      const maxLtv = jitosolReserve?.maxLtv ?? 0.85;

      const spread = jitoStakingApy.minus(solBorrowApy);

      return {
        market: marketName,
        marketAddress,
        jitosolStakingApy: jitoStakingApy,
        solBorrowApy,
        spread,
        netApyAt2x: calcNetApy(jitoStakingApy, solBorrowApy, 2),
        netApyAt3x: calcNetApy(jitoStakingApy, solBorrowApy, 3),
        netApyAt5x: calcNetApy(jitoStakingApy, solBorrowApy, 5),
        maxLtv,
      };
    } catch (err: any) {
      console.log(`   ⚠️  Failed to fetch rates for ${marketName}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get multiply rates for ALL known markets via REST API.
   * Returns rates sorted by spread (best first).
   */
  async getAllMarketRates(): Promise<MultiplyRates[]> {
    // Fetch JitoSOL staking APY once
    let jitoStakingApy: Decimal;
    try {
      const jitoResult = await fetchJitoApy();
      jitoStakingApy = new Decimal(jitoResult.apy);
    } catch {
      jitoStakingApy = new Decimal(5.94); // fallback
    }

    // Fetch rates for all markets in parallel
    const results = await Promise.all(
      MULTIPLY_MARKETS.map(m => this.getMarketRates(m.name, m.address, jitoStakingApy))
    );

    return results
      .filter((r): r is MultiplyRates => r !== null)
      .sort((a, b) => b.spread.minus(a.spread).toNumber());
  }

  /**
   * Get current rates for JitoSOL<>SOL multiply strategy (legacy interface).
   * Uses REST API — no SDK loading.
   */
  async getMultiplyRates(marketAddress?: string): Promise<{
    jitosolSupplyApy: Decimal;
    solBorrowApy: Decimal;
    spread: Decimal;
    maxLtv: Decimal;
    netApyAt5x: Decimal;
  }> {
    const allRates = await this.getAllMarketRates();

    // If a specific market was requested, find it; otherwise pick the best
    let rates: MultiplyRates | undefined;
    if (marketAddress) {
      rates = allRates.find(r => r.marketAddress === marketAddress);
    }
    if (!rates) {
      rates = allRates[0]; // best spread
    }

    if (!rates) {
      // No market data available — return zeros
      return {
        jitosolSupplyApy: new Decimal(0),
        solBorrowApy: new Decimal(0),
        spread: new Decimal(0),
        maxLtv: new Decimal(0.85),
        netApyAt5x: new Decimal(0),
      };
    }

    return {
      jitosolSupplyApy: rates.jitosolStakingApy,
      solBorrowApy: rates.solBorrowApy,
      spread: rates.spread,
      maxLtv: new Decimal(rates.maxLtv),
      netApyAt5x: rates.netApyAt5x,
    };
  }

  /**
   * Scan existing Multiply-style positions for a wallet via REST API.
   * Looks for obligations with both deposits (JitoSOL) and borrows (SOL).
   */
  async getUserMultiplyPositions(
    walletPubkey: PublicKey,
    marketAddress?: string
  ): Promise<MultiplyPosition[]> {
    const positions: MultiplyPosition[] = [];
    const marketsToCheck = marketAddress
      ? [{ name: 'Custom', address: marketAddress }]
      : MULTIPLY_MARKETS;

    // Fetch JitoSOL staking APY for net APY calculations
    let jitoStakingApy: Decimal;
    try {
      const jitoResult = await fetchJitoApy();
      jitoStakingApy = new Decimal(jitoResult.apy);
    } catch {
      jitoStakingApy = new Decimal(5.94);
    }

    for (const market of marketsToCheck) {
      try {
        // Fetch reserves and obligations in parallel
        const [reserves, obligations] = await Promise.all([
          fetchReserves(market.address),
          fetchUserObligations(market.address, walletPubkey.toBase58()),
        ]);

        // Build a lookup from reserve address → reserve data
        const reserveMap = new Map<string, ApiReserve>();
        for (const r of reserves) {
          reserveMap.set(r.reserve, r);
        }

        for (const oblig of obligations) {
          // Find JitoSOL deposit and SOL borrow
          let collateralAmount = new Decimal(0);
          let collateralToken = '';
          let collateralValueUsd = new Decimal(0);
          let debtAmount = new Decimal(0);
          let debtToken = '';
          let debtValueUsd = new Decimal(0);

          // Detect largest non-SOL deposit as collateral (supports JitoSOL, pSOL, any LST)
          // and SOL borrow as debt
          for (const dep of oblig.deposits) {
            const sym = dep.symbol.toUpperCase();
            if (sym !== 'SOL' && sym !== 'USDC' && sym !== 'USDT') {
              // depositedAmount from parser may be in base units — convert to UI amount
              const rawAmount = new Decimal(dep.depositedAmount);
              const depDecimals = TOKEN_DECIMALS[dep.symbol] ?? 9;
              const uiAmount = rawAmount.gt(1e6) ? rawAmount.div(new Decimal(10).pow(depDecimals)) : rawAmount;
              if (uiAmount.gt(collateralAmount)) {
                collateralToken = dep.symbol;
                collateralAmount = uiAmount;
                collateralValueUsd = dep.marketValue > 0 ? new Decimal(dep.marketValue) : new Decimal(0);
              }
            }
          }

          for (const bor of oblig.borrows) {
            if (bor.symbol.toUpperCase() === 'SOL') {
              debtToken = 'SOL';
              // borrowedAmount from parser should already be in UI units (kamino-api.ts handles SF conversion)
              debtAmount = new Decimal(bor.borrowedAmount);
              debtValueUsd = bor.marketValue > 0 ? new Decimal(bor.marketValue) : new Decimal(0);
            }
          }

          // Use refreshedStats USD values when individual marketValues are 0
          if (collateralValueUsd.eq(0) && oblig.depositedValue > 0) {
            collateralValueUsd = new Decimal(oblig.depositedValue);
          }
          if (debtValueUsd.eq(0) && oblig.borrowedValue > 0) {
            debtValueUsd = new Decimal(oblig.borrowedValue);
          }

          // Only include as Multiply position if it has both collateral and debt
          if (collateralToken && debtToken && collateralAmount.gt(0) && debtAmount.gt(0)) {
            const netValueUsd = collateralValueUsd.minus(debtValueUsd);
            const leverage = collateralValueUsd.gt(0) && netValueUsd.gt(0)
              ? collateralValueUsd.div(netValueUsd)
              : new Decimal(1);
            const ltv = collateralValueUsd.gt(0)
              ? debtValueUsd.div(collateralValueUsd)
              : new Decimal(0);

            // Get SOL borrow APY from reserves
            const solReserve = findReserve(reserves, 'SOL');
            const borrowApy = solReserve ? new Decimal(solReserve.borrowApy) : new Decimal(0);

            const netApy = calcNetApy(jitoStakingApy, borrowApy, leverage.toNumber());

            // Resolve collateral mint from reserves
            const collateralReserve = reserves.find(
              r => r.liquidityToken.toUpperCase() === collateralToken.toUpperCase()
            );
            const collateralMint = collateralReserve?.liquidityTokenMint || TOKEN_MINTS[collateralToken] || '';

            positions.push({
              obligationAddress: oblig.obligationAddress,
              marketAddress: market.address,
              collateralToken,
              collateralMint,
              debtToken,
              collateralAmount,
              debtAmount,
              netValueUsd,
              leverage,
              ltv,
              maxLtv: new Decimal(this.settings.maxLtv),
              collateralApy: jitoStakingApy,
              borrowApy,
              netApy,
              strategy: StrategyType.MULTIPLY,
            });
          }
        }
      } catch (err: any) {
        console.log(`   ⚠️  Could not fetch positions from ${market.name}: ${err.message}`);
      }
    }

    return positions;
  }

  /**
   * Check if it's profitable to open a Multiply position.
   * Uses REST API for all reads — returns rates for ALL markets.
   * Now also scans ALL LSTs via Sanctum for the best opportunity.
   */
  async shouldOpenPosition(): Promise<MultiplyAnalysis> {
    // Fetch legacy JitoSOL-only rates for backwards compatibility
    const allRates = await this.getAllMarketRates();

    // NEW: Scan all LSTs × all markets using real Sanctum yields
    let multiLstOpportunities: MultiplyOpportunity[] = [];
    let bestOpportunity: MultiplyOpportunity | null = null;
    try {
      multiLstOpportunities = await scanMultiplyOpportunities();
      bestOpportunity = multiLstOpportunities.find(o => o.profitable) ?? null;
    } catch (err: any) {
      console.log(`   ⚠️  Multi-LST scan failed: ${err.message}`);
    }

    // Determine best market from legacy rates
    const bestMarket = allRates.length > 0 ? allRates[0] : null;

    // Determine profitability: prefer multi-LST scanner results if available
    if (bestOpportunity) {
      return {
        profitable: true,
        reason: `Best: ${bestOpportunity.symbol} in ${bestOpportunity.market} — Yield: ${bestOpportunity.nativeYield.toFixed(2)}%, Spread: ${bestOpportunity.spread.toFixed(2)}%, Best Net APY: ${bestOpportunity.bestNetApy.toFixed(2)}% @ ${(bestOpportunity.maxLeverage * 0.8).toFixed(1)}x`,
        allMarketRates: allRates,
        bestMarket,
        multiLstOpportunities,
        bestOpportunity,
      };
    }

    // Fall back to legacy JitoSOL-only analysis
    if (!bestMarket) {
      return {
        profitable: false,
        reason: 'No market data available',
        allMarketRates: [],
        bestMarket: null,
        multiLstOpportunities,
        bestOpportunity: null,
      };
    }

    if (bestMarket.spread.lt(this.settings.minSpread)) {
      return {
        profitable: false,
        reason: `Best spread too low: ${bestMarket.spread.toFixed(2)}% in ${bestMarket.market} (min: ${this.settings.minSpread}%)`,
        allMarketRates: allRates,
        bestMarket,
        multiLstOpportunities,
        bestOpportunity: null,
      };
    }

    if (bestMarket.netApyAt5x.lte(0)) {
      return {
        profitable: false,
        reason: `Negative net APY at 5x in ${bestMarket.market}: ${bestMarket.netApyAt5x.toFixed(2)}%`,
        allMarketRates: allRates,
        bestMarket,
        multiLstOpportunities,
        bestOpportunity: null,
      };
    }

    return {
      profitable: true,
      reason: `Best: ${bestMarket.market} — Spread: ${bestMarket.spread.toFixed(2)}%, Net APY @5x: ${bestMarket.netApyAt5x.toFixed(2)}%`,
      allMarketRates: allRates,
      bestMarket,
      multiLstOpportunities,
      bestOpportunity: null,
    };
  }

  /**
   * Monitor health of existing Multiply positions via REST API.
   */
  async monitorPositions(
    walletPubkey: PublicKey
  ): Promise<{ healthy: boolean; warnings: string[]; positions: MultiplyPosition[] }> {
    const warnings: string[] = [];
    const positions = await this.getUserMultiplyPositions(walletPubkey);

    for (const pos of positions) {
      // Check LTV
      if (pos.ltv.gt(this.settings.maxLtv)) {
        warnings.push(
          `⚠️ HIGH LTV on ${pos.collateralToken}/${pos.debtToken}: ${pos.ltv.mul(100).toFixed(1)}% (max: ${new Decimal(this.settings.maxLtv).mul(100).toFixed(0)}%)`
        );
      }

      // Check if still profitable
      if (pos.netApy.lte(0)) {
        warnings.push(
          `⚠️ NEGATIVE APY on ${pos.collateralToken}/${pos.debtToken}: ${pos.netApy.toFixed(2)}% — consider closing`
        );
      }

      // Check if spread has compressed
      const spread = pos.collateralApy.minus(pos.borrowApy);
      if (spread.lt(this.settings.minSpread)) {
        warnings.push(
          `⚠️ LOW SPREAD on ${pos.collateralToken}/${pos.debtToken}: ${spread.toFixed(2)}% — monitor closely`
        );
      }
    }

    return {
      healthy: warnings.length === 0,
      warnings,
      positions,
    };
  }

  /**
   * Check health of an existing position without opening a new one.
   */
  async checkPositionHealth(
    walletPubkey: PublicKey,
    marketAddress?: string
  ): Promise<{ healthy: boolean; warnings: string[]; positions: MultiplyPosition[] }> {
    return this.monitorPositions(walletPubkey);
  }

  // ─── SDK-based Position Management ─────────────────────────────

  /**
   * Create SDK-compatible quoter function for Jupiter.
   */
  private createJupiterQuoter() {
    return async (
      inputs: SwapInputs,
      klendAccounts: Address[]
    ): Promise<SwapQuote<JupiterQuote>> => {
      try {
        const inputMintStr = inputs.inputMint.toString();
        const outputMintStr = inputs.outputMint.toString();
        const amountLamports = inputs.inputAmountLamports;

        const quote = await getJupiterQuote(
          inputMintStr,
          outputMintStr,
          amountLamports,
          50 // 0.5% slippage
        );

        // Calculate price ratio: how much output per unit input
        const inputAmount = new Decimal(quote.inAmount);
        const outputAmount = new Decimal(quote.outAmount);
        const priceAInB = inputAmount.gt(0) ? outputAmount.div(inputAmount) : new Decimal(0);

        return {
          priceAInB,
          quoteResponse: quote,
        };
      } catch (err: any) {
        throw new Error(`Jupiter quoter failed: ${err.message}`);
      }
    };
  }

  /**
   * Create SDK-compatible swapper function for Jupiter.
   */
  private createJupiterSwapper(userPubkey: string) {
    return async (
      inputs: SwapInputs,
      klendAccounts: Address[],
      quote: SwapQuote<JupiterQuote>
    ): Promise<SwapIxs<JupiterQuote>[]> => {
      try {
        if (!quote.quoteResponse) {
          throw new Error('No quote response available');
        }

        const swapResponse = await getJupiterSwapIxs(quote.quoteResponse, userPubkey);
        
        // Deserialize the Jupiter swap transaction
        const txBuffer = Buffer.from(swapResponse.swapTransaction, 'base64');
        const tx = VersionedTransaction.deserialize(txBuffer);
        const msg = tx.message;
        
        // Resolve all account keys (static + lookup tables)
        // Track which LUT-resolved keys are writable vs readonly
        const allKeys = [...msg.staticAccountKeys];
        const lutWritableKeyIndexes = new Set<number>(); // track writable LUT-resolved keys
        
        const sdkLookupTables: any[] = [];
        if (msg.addressTableLookups && msg.addressTableLookups.length > 0) {
          for (const lutLookup of msg.addressTableLookups) {
            const lutInfo = await this.connection.getAddressLookupTable(lutLookup.accountKey);
            if (lutInfo.value) {
              // Add writable addresses first, tracking their position in allKeys
              for (const idx of lutLookup.writableIndexes) {
                lutWritableKeyIndexes.add(allKeys.length);
                allKeys.push(lutInfo.value.state.addresses[idx]);
              }
              // Then readonly addresses
              for (const idx of lutLookup.readonlyIndexes) {
                allKeys.push(lutInfo.value.state.addresses[idx]);
              }
              sdkLookupTables.push({
                address: address(lutLookup.accountKey.toBase58()),
                data: lutInfo.value,
              });
            }
          }
        }

        // Convert compiled instructions to SDK Instruction format
        const numSigners = msg.header.numRequiredSignatures;
        const numReadonlySigned = msg.header.numReadonlySignedAccounts;
        const numReadonlyUnsigned = msg.header.numReadonlyUnsignedAccounts;
        const numStatic = msg.staticAccountKeys.length;
        
        const instructions: Instruction[] = msg.compiledInstructions.map((ix: any) => {
          const programId = allKeys[ix.programIdIndex];
          
          const accounts = ix.accountKeyIndexes.map((keyIdx: number) => {
            const isSigner = keyIdx < numSigners;
            let isWritable: boolean;
            
            if (keyIdx < numStatic) {
              // Static account: use header to determine writability
              isWritable = isSigner 
                ? keyIdx < (numSigners - numReadonlySigned)
                : keyIdx < (numStatic - numReadonlyUnsigned);
            } else {
              // LUT-resolved account: use tracked writable indexes
              isWritable = lutWritableKeyIndexes.has(keyIdx);
            }
            
            let role = 0; // READONLY
            if (isSigner && isWritable) role = 3;  // WRITABLE_SIGNER
            else if (isSigner) role = 1;            // READONLY_SIGNER
            else if (isWritable) role = 2;          // WRITABLE
            
            return {
              address: address(allKeys[keyIdx].toBase58()),
              role,
            };
          });
          
          return {
            programAddress: address(programId.toBase58()),
            accounts,
            data: new Uint8Array(ix.data),
          } as Instruction;
        });

        return [{
          preActionIxs: [],
          swapIxs: instructions,
          lookupTables: sdkLookupTables,
          quote,
        }];
      } catch (err: any) {
        throw new Error(`Jupiter swapper failed: ${err.message}`);
      }
    };
  }

  /**
   * Get current SOL price in collateral token for SDK price calculations.
   */
  private async getPriceDebtToColl(debtMint: string, collMint: string): Promise<Decimal> {
    try {
      // Use Jupiter quote to get current exchange rate
      const quoter = this.createJupiterQuoter();
      const inputs: SwapInputs = {
        inputAmountLamports: new Decimal(LAMPORTS_PER_SOL), // 1 SOL
        inputMint: address(debtMint),
        outputMint: address(collMint),
      };
      
      const quote = await quoter(inputs, []);
      return quote.priceAInB; // SOL price in LST terms
    } catch (err: any) {
      console.log(`   ⚠️  Failed to get price ${debtMint}->${collMint}: ${err.message}`);
      // Fallback: assume LST is slightly more valuable than SOL
      return new Decimal(0.95); // 1 SOL = 0.95 LST (conservative)
    }
  }

  /**
   * Open a leveraged multiply position using SDK flash loan.
   *
   * @param wallet - Keypair for signing transactions
   * @param lstSymbol - LST token symbol (e.g. 'JitoSOL', 'JupSOL', 'dSOL')
   * @param lstMint - LST mint address
   * @param amountLst - Initial LST amount to deposit
   * @param targetLeverage - Target leverage (e.g. 1.5, 2.0, 3.0)
   * @param marketAddress - Kamino market address to use
   * @param dryRun - If true, only simulate
   */
  async openPosition(
    wallet: Keypair,
    lstSymbol: string,
    lstMint: string,
    amountLst: Decimal,
    targetLeverage: number,
    marketAddress: string,
    dryRun: boolean = false
  ): Promise<{ success: boolean; message: string; txSignatures: string[]; finalLeverage: number }> {
    console.log(`\n🔄 ${dryRun ? 'DRY RUN — ' : ''}Opening Multiply Position (SDK)`);
    console.log(`   LST: ${lstSymbol} (${lstMint.slice(0, 8)}...)`);
    console.log(`   Amount: ${amountLst.toFixed(6)} ${lstSymbol}`);
    console.log(`   Target leverage: ${targetLeverage}x`);
    console.log(`   Market: ${marketAddress.slice(0, 8)}...`);

    if (dryRun) {
      // For dry run, just return simulated success
      return {
        success: true,
        message: `DRY RUN — Would open ${targetLeverage}x ${lstSymbol}/SOL position`,
        txSignatures: [],
        finalLeverage: targetLeverage,
      };
    }

    try {
      // Load market and get reserve data
      const market = await this.loadMarket(marketAddress);
      const currentSlot = await this.connection.getSlot('confirmed');
      
      // Convert wallet to SDK format
      const owner = await createKeyPairSignerFromBytes(wallet.secretKey);
      
      // Find reserves
      const reserves = market.getReserves();
      const collReserve = reserves.find(r => 
        r.getLiquidityMint().toString().toLowerCase() === lstMint.toLowerCase()
      );
      const debtReserve = reserves.find(r => 
        r.symbol.toUpperCase() === 'SOL'
      );

      if (!collReserve) {
        throw new Error(`${lstSymbol} reserve not found in market`);
      }
      if (!debtReserve) {
        throw new Error(`SOL reserve not found in market`);
      }

      const collReserveAddress = address(collReserve.address.toString());
      const debtReserveAddress = address(debtReserve.address.toString());
      
      // Get current price: debt (SOL) to collateral (LST)
      const priceDebtToColl = await this.getPriceDebtToColl(
        TOKEN_MINTS.SOL,
        lstMint
      );

      // Create MultiplyObligation for proper UI integration (tag=1)
      const obligation = new MultiplyObligation(
        address(lstMint), // collateral token mint
        address(TOKEN_MINTS.SOL), // debt token mint
        PROGRAM_ID, // program ID
        0 // obligation ID
      );

      // Get scope refresh instructions (fallback to empty array if unavailable)
      let scopeRefreshIx: any[] = [];
      try {
        const scopeResult = await getScopeRefreshIxForObligationAndReserves(
          market, collReserve, debtReserve, obligation, undefined
        );
        if (scopeResult && Array.isArray(scopeResult)) scopeRefreshIx = scopeResult;
      } catch {}

      // Create Jupiter quoter and swapper
      const quoter = this.createJupiterQuoter();
      const swapper = this.createJupiterSwapper(wallet.publicKey.toBase58());

      // SDK expects UI units (not lamports) — it converts internally via numberToLamportsDecimal
      const depositAmount = amountLst;

      // Call SDK leverage function
      const leverageResults = await getDepositWithLeverageIxs({
        owner,
        kaminoMarket: market,
        debtReserveAddress,
        collReserveAddress,
        depositAmount,
        priceDebtToColl,
        slippagePct: new Decimal(0.005), // 0.5% slippage
        obligation: null, // creating new obligation
        referrer: none(),  
        currentSlot: BigInt(currentSlot),
        targetLeverage: new Decimal(targetLeverage),
        selectedTokenMint: address(lstMint),
        obligationTypeTagOverride: ObligationTypeTag.Multiply, // tag = 1
        scopeRefreshIx,
        budgetAndPriorityFeeIxs: undefined,
        quoteBufferBps: new Decimal(50), // 0.5% quote buffer
        quoter,
        swapper,
        elevationGroupOverride: undefined,
        useV2Ixs: true,
        rollOver: false,
      });

      if (leverageResults.length === 0) {
        throw new Error('No instructions generated by SDK');
      }

      // Ensure user LUT exists for Kamino account compression
      const userLutAddress = await this.ensureUserLut(market, wallet, collReserveAddress, debtReserveAddress);

      const txSignatures: string[] = [];
      
      // Execute the leverage instructions
      for (const result of leverageResults) {
        const instructions = result.ixs;
        
        console.log(`   📤 Building leverage tx with ${instructions.length} instructions...`);
        const sig = await this.executeSdkInstructions(
          instructions, result.lookupTables || [], wallet, 'Leverage', userLutAddress, null, market
        );
        txSignatures.push(sig);
      }

      return {
        success: true,
        message: `Multiply position opened: ${targetLeverage}x ${lstSymbol}/SOL via SDK flash loan`,
        txSignatures,
        finalLeverage: targetLeverage,
      };

    } catch (err: any) {
      console.log(`   ❌ SDK leverage failed: ${err.message}`);
      return {
        success: false,
        message: `SDK leverage failed: ${err.message}`,
        txSignatures: [],
        finalLeverage: 1,
      };
    }
  }

  /**
   * Close a leveraged multiply position using SDK flash loan.
   *
   * @param wallet - Keypair for signing transactions  
   * @param position - Current multiply position to close
   * @param dryRun - If true, only simulate
   */
  async closePosition(
    wallet: Keypair,
    position: MultiplyPosition,
    dryRun: boolean = true
  ): Promise<{ success: boolean; message: string; txSignatures: string[] }> {
    console.log(`\n🔄 ${dryRun ? 'DRY RUN — ' : ''}Closing Multiply Position (SDK)`);
    console.log(`   Position: ${position.leverage.toFixed(2)}x ${position.collateralToken}/${position.debtToken}`);
    console.log(`   Market: ${position.marketAddress.slice(0, 8)}...`);

    if (dryRun) {
      return {
        success: true,
        message: `DRY RUN — Would close ${position.collateralToken}/SOL position via SDK`,
        txSignatures: [],
      };
    }

    try {
      // Load market
      const market = await this.loadMarket(position.marketAddress);
      const currentSlot = await this.connection.getSlot('confirmed');
      
      // Convert wallet to SDK format
      const owner = await createKeyPairSignerFromBytes(wallet.secretKey);

      // Find reserves
      const reserves = market.getReserves();
      const collReserve = reserves.find(r => 
        r.getLiquidityMint().toString().toLowerCase() === position.collateralMint.toLowerCase()
      );
      const debtReserve = reserves.find(r => 
        r.symbol.toUpperCase() === 'SOL'
      );

      if (!collReserve || !debtReserve) {
        throw new Error('Could not find reserves in market');
      }

      const collReserveAddress = address(collReserve.address.toString());
      const debtReserveAddress = address(debtReserve.address.toString());

      // Load existing obligation from on-chain data
      let obligation: any;
      if (position.obligationAddress) {
        obligation = await market.getObligationByAddress(address(position.obligationAddress));
      }
      if (!obligation) {
        // Try loading by wallet with different obligation types
        const multiplyOblType = new MultiplyObligation(
          address(position.collateralMint),
          address(TOKEN_MINTS.SOL),
          PROGRAM_ID, 0
        );
        obligation = await market.getObligationByWallet(address(wallet.publicKey.toBase58()), multiplyOblType);
      }
      if (!obligation) {
        // Fall back to Vanilla obligation type
        const vanillaOblType = new VanillaObligation(PROGRAM_ID);
        obligation = await market.getObligationByWallet(address(wallet.publicKey.toBase58()), vanillaOblType);
      }
      if (!obligation) {
        throw new Error('Could not load obligation from market');
      }
      console.log(`   ✅ Loaded obligation: ${obligation.obligationAddress?.toString?.()?.slice(0,8) || 'unknown'}...`);

      // Get current price: collateral (LST) to debt (SOL)  
      const priceCollToDebt = await this.getPriceDebtToColl(
        TOKEN_MINTS.SOL,
        position.collateralMint
      ).then(p => new Decimal(1).div(p)); // invert price

      // Get scope refresh instructions (fallback to empty array if unavailable)
      let scopeRefreshIx: any[] = [];
      try {
        const scopeResult = await getScopeRefreshIxForObligationAndReserves(
          market, collReserve, debtReserve, obligation, undefined
        );
        if (scopeResult && Array.isArray(scopeResult)) scopeRefreshIx = scopeResult;
      } catch {}

      // Create Jupiter quoter and swapper
      const quoter = this.createJupiterQuoter();
      const swapper = this.createJupiterSwapper(wallet.publicKey.toBase58());

      // SDK expects UI units (not lamports) — it converts internally via numberToLamportsDecimal
      const deposited = position.collateralAmount;
      const borrowed = position.debtAmount;

      // Get user SOL balance for gas calculations
      const solBalance = await this.connection.getBalance(wallet.publicKey);

      // Call SDK withdraw with leverage (close position)
      const withdrawResults = await getWithdrawWithLeverageIxs({
        owner,
        kaminoMarket: market,
        debtReserveAddress,
        collReserveAddress,
        obligation: obligation as any, // Type casting for compatibility
        deposited,
        borrowed,
        referrer: none(),
        currentSlot: BigInt(currentSlot),
        withdrawAmount: deposited, // withdraw all collateral
        priceCollToDebt,
        slippagePct: new Decimal(0.005), // 0.5% slippage
        isClosingPosition: true,
        selectedTokenMint: address(position.collateralMint),
        budgetAndPriorityFeeIxs: undefined,
        scopeRefreshIx,
        quoteBufferBps: new Decimal(50),
        quoter,
        swapper,
        useV2Ixs: true,
        userSolBalanceLamports: solBalance,
      });

      // Ensure user LUT exists for Kamino account compression
      const userLutAddress = await this.ensureUserLut(market, wallet, collReserveAddress, debtReserveAddress);

      const txSignatures: string[] = [];

      // Execute the withdraw instructions
      for (const result of withdrawResults) {
        console.log(`   📤 Building withdraw tx with ${result.ixs.length} instructions...`);
        const sig = await this.executeSdkInstructions(
          result.ixs, result.lookupTables || [], wallet, 'Withdraw', userLutAddress, obligation, market
        );
        txSignatures.push(sig);
      }

      return {
        success: true,
        message: `Multiply position closed via SDK flash loan`,
        txSignatures,
      };

    } catch (err: any) {
      console.log(`   ❌ SDK withdraw failed: ${err.message}`);
      console.log(`   Stack: ${err.stack?.split('\n').slice(1,6).join('\n')}`);
      return {
        success: false,
        message: `SDK withdraw failed: ${err.message}`,
        txSignatures: [],
      };
    }
  }

  /**
   * Adjust leverage on an existing multiply position using SDK.
   *
   * @param wallet - Keypair for signing transactions
   * @param position - Current multiply position
   * @param targetLeverage - New target leverage
   * @param dryRun - If true, only simulate
   */
  async adjustLeverage(
    wallet: Keypair,
    position: MultiplyPosition,
    targetLeverage: number,
    dryRun: boolean = true
  ): Promise<{ success: boolean; message: string; txSignatures: string[] }> {
    console.log(`\n🔄 ${dryRun ? 'DRY RUN — ' : ''}Adjusting Leverage (SDK)`);
    console.log(`   Current: ${position.leverage.toFixed(2)}x → Target: ${targetLeverage}x`);
    console.log(`   Position: ${position.collateralToken}/${position.debtToken}`);

    if (dryRun) {
      return {
        success: true,
        message: `DRY RUN — Would adjust leverage ${position.leverage.toFixed(2)}x → ${targetLeverage}x`,
        txSignatures: [],
      };
    }

    try {
      // Load market
      const market = await this.loadMarket(position.marketAddress);
      const currentSlot = await this.connection.getSlot('confirmed');
      
      // Convert wallet to SDK format
      const owner = await createKeyPairSignerFromBytes(wallet.secretKey);

      // Find reserves
      const reserves = market.getReserves();
      const collReserve = reserves.find(r => 
        r.getLiquidityMint().toString().toLowerCase() === position.collateralMint.toLowerCase()
      );
      const debtReserve = reserves.find(r => 
        r.symbol.toUpperCase() === 'SOL'
      );

      if (!collReserve || !debtReserve) {
        throw new Error('Could not find reserves in market');
      }

      const collReserveAddress = address(collReserve.address.toString());
      const debtReserveAddress = address(debtReserve.address.toString());

      // Create obligation type
      const obligation = new MultiplyObligation(
        address(position.collateralMint),
        address(TOKEN_MINTS.SOL),
        PROGRAM_ID,
        0
      );

      // Get prices
      const priceDebtToColl = await this.getPriceDebtToColl(
        TOKEN_MINTS.SOL,
        position.collateralMint
      );
      const priceCollToDebt = new Decimal(1).div(priceDebtToColl);

      // Get scope refresh instructions (fallback to empty array if unavailable)
      let scopeRefreshIx: any[] = [];
      try {
        const scopeResult = await getScopeRefreshIxForObligationAndReserves(
          market, collReserve, debtReserve, obligation, undefined
        );
        if (scopeResult && Array.isArray(scopeResult)) scopeRefreshIx = scopeResult;
      } catch {}

      // Create Jupiter quoter and swapper
      const quoter = this.createJupiterQuoter();
      const swapper = this.createJupiterSwapper(wallet.publicKey.toBase58());

      // SDK expects UI units (not lamports) — it converts internally
      const depositedLamports = position.collateralAmount;
      const borrowedLamports = position.debtAmount;

      // Get user SOL balance
      const solBalance = await this.connection.getBalance(wallet.publicKey);

      // Call SDK adjust leverage
      const adjustResults = await getAdjustLeverageIxs({
        owner,
        kaminoMarket: market,
        debtReserveAddress,
        collReserveAddress,
        obligation: obligation as any,
        depositedLamports,
        borrowedLamports,
        referrer: none(),
        currentSlot: BigInt(currentSlot),
        targetLeverage: new Decimal(targetLeverage),
        priceCollToDebt,
        priceDebtToColl,
        slippagePct: new Decimal(0.005), // 0.5% slippage
        budgetAndPriorityFeeIxs: undefined,
        scopeRefreshIx,
        quoteBufferBps: new Decimal(50),
        quoter,
        swapper,
        useV2Ixs: true,
        withdrawSlotOffset: 150,
        userSolBalanceLamports: solBalance,
      });

      // Ensure user LUT exists for Kamino account compression
      const userLutAddress = await this.ensureUserLut(market, wallet, collReserveAddress, debtReserveAddress);

      const txSignatures: string[] = [];

      // Execute the adjust instructions
      for (const result of adjustResults) {
        const instructions = result.ixs;
        
        console.log(`   📤 Building adjust tx with ${instructions.length} instructions...`);
        const sig = await this.executeSdkInstructions(
          instructions, result.lookupTables || [], wallet, 'Adjust', userLutAddress, obligation as any, market
        );
        txSignatures.push(sig);
      }

      return {
        success: true,
        message: `Leverage adjusted: ${position.leverage.toFixed(2)}x → ${targetLeverage}x via SDK`,
        txSignatures,
      };

    } catch (err: any) {
      console.log(`   ❌ SDK adjust failed: ${err.message}`);
      return {
        success: false,
        message: `SDK adjust failed: ${err.message}`,
        txSignatures: [],
      };
    }
  }
}