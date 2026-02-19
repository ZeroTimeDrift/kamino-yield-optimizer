/**
 * Kamino Finance Client — REST API for reads, SDK for writes
 *
 * REFACTORED: All read operations (reserves, APYs, positions) now use the
 * api.kamino.finance REST API instead of loading full markets via SDK/RPC.
 * SDK is only used for deposit/withdraw transaction building/signing.
 */

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createSolanaRpc, address, Address, createKeyPairSignerFromBytes } from '@solana/kit';
import { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import Decimal from 'decimal.js';
import { VaultInfo, Position, TOKEN_MINTS } from './types';
import {
  fetchReserves,
  fetchUserObligations,
  findReserve,
  ApiReserve,
  ApiObligation,
} from './kamino-api';

// Main Kamino market address
const MAIN_MARKET_PUBKEY = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const MAIN_MARKET = address(MAIN_MARKET_PUBKEY);

// Retry helper with exponential backoff
async function retry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      const isRateLimit = err.message?.includes('429') || err.message?.includes('Too Many');
      const wait = isRateLimit ? delayMs * (i + 2) : delayMs;
      console.log(`   ⏳ Retry ${i + 1}/${maxRetries} in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('Max retries exceeded');
}

export class KaminoClient {
  private connection: Connection;
  private rpc: ReturnType<typeof createSolanaRpc>;
  private rpcUrl: string;
  // SDK market is lazy-loaded only when needed for writes
  private market: KaminoMarket | null = null;
  private currentSlot: bigint = 0n;
  // Cache reserves from REST API
  private cachedReserves: ApiReserve[] | null = null;
  private reservesCacheTime = 0;
  private readonly RESERVE_CACHE_MS = 60_000; // 1 minute

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    this.rpc = createSolanaRpc(rpcUrl);
  }

  /**
   * Initialize is now lightweight — just fetches reserves via REST API.
   * SDK market is only loaded when needed for transaction building.
   */
  async initialize(): Promise<void> {
    console.log('📡 Connecting to Kamino market via REST API...');
    this.cachedReserves = await fetchReserves(MAIN_MARKET_PUBKEY);
    this.reservesCacheTime = Date.now();
    console.log(`✅ Loaded ${this.cachedReserves.length} reserves from REST API`);
  }

  /**
   * Lazy-load the SDK market only when needed (for deposit/withdraw).
   */
  private async ensureMarket(): Promise<KaminoMarket> {
    if (this.market) return this.market;
    console.log('   📡 Loading SDK market for transaction building...');
    this.market = await retry(() => KaminoMarket.load(this.rpc, MAIN_MARKET, 400, PROGRAM_ID));
    if (!this.market) throw new Error('Failed to load market');
    const slot = await retry(() => this.connection.getSlot());
    this.currentSlot = BigInt(slot);
    return this.market;
  }

  /**
   * Get cached reserves or refresh from REST API.
   */
  private async getApiReserves(): Promise<ApiReserve[]> {
    if (this.cachedReserves && Date.now() - this.reservesCacheTime < this.RESERVE_CACHE_MS) {
      return this.cachedReserves;
    }
    this.cachedReserves = await fetchReserves(MAIN_MARKET_PUBKEY);
    this.reservesCacheTime = Date.now();
    return this.cachedReserves;
  }

  /**
   * Get reserves as VaultInfo using REST API (no SDK/RPC needed).
   */
  async getReserves(): Promise<VaultInfo[]> {
    const apiReserves = await this.getApiReserves();

    const vaults: VaultInfo[] = apiReserves
      .filter(r => r.supplyApy > 0.01) // skip dust APY
      .map(r => ({
        address: r.reserve,
        name: `${r.liquidityToken} Earn`,
        type: 'earn' as const,
        token: r.liquidityToken,
        tokenMint: r.liquidityTokenMint,
        apy: new Decimal(r.supplyApy),
        tvlUsd: new Decimal(r.totalSupplyUsd),
        depositFeePercent: new Decimal(0),
        withdrawalFeePercent: new Decimal(0.1),
        createdAt: new Date(),
        isActive: true,
      }));

    // Sort by APY descending
    vaults.sort((a, b) => b.apy.minus(a.apy).toNumber());

    return vaults;
  }

  /**
   * Get user positions using REST API (no SDK/RPC needed).
   */
  async getUserPositions(walletPubkey: PublicKey): Promise<Position[]> {
    const walletStr = walletPubkey.toBase58();
    const obligations = await fetchUserObligations(MAIN_MARKET_PUBKEY, walletStr);

    if (obligations.length === 0) return [];

    // Get reserves for APY lookup
    const apiReserves = await this.getApiReserves();

    const positions: Position[] = [];

    for (const obligation of obligations) {
      for (const deposit of obligation.deposits) {
        // Look up the reserve to get current APY
        const reserve = apiReserves.find(
          r => r.reserve === deposit.reserveAddress || r.liquidityTokenMint === deposit.mintAddress
        );

        positions.push({
          vaultAddress: deposit.reserveAddress,
          vaultName: `${deposit.symbol} Earn`,
          token: deposit.symbol || 'UNKNOWN',
          shares: new Decimal(deposit.depositedAmount || 0),
          tokenAmount: new Decimal(deposit.depositedAmount || 0),
          valueUsd: new Decimal(deposit.marketValue || 0),
          currentApy: new Decimal(reserve?.supplyApy || 0),
          depositedAt: new Date(),
          unrealizedPnl: new Decimal(0),
        });
      }
    }

    return positions;
  }

  /**
   * Deposit tokens — requires SDK for transaction building.
   */
  async deposit(
    wallet: Keypair,
    symbol: string,
    amount: Decimal
  ): Promise<string> {
    const market = await this.ensureMarket();

    // Find reserve by symbol
    const reserve = market.getReserves().find(
      r => r.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    if (!reserve) {
      throw new Error(`Reserve not found for symbol: ${symbol}`);
    }

    const decimals = symbol.toUpperCase() === 'SOL' ? 9 : 6;
    const amountBase = amount.mul(Math.pow(10, decimals)).floor().toString();

    console.log(`Building deposit tx: ${amount} ${symbol} (${amountBase} base units)`);
    console.log(`Reserve address: ${reserve.address.toString()}`);

    const signer = await createKeyPairSignerFromBytes(wallet.secretKey);

    const kaminoAction = await KaminoAction.buildDepositTxns({
      kaminoMarket: market,
      amount: amountBase,
      reserveAddress: reserve.address,
      owner: signer,
      obligation: new VanillaObligation(PROGRAM_ID),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      includeAtaIxs: true,
      currentSlot: this.currentSlot,
    });

    const tx = new Transaction();
    for (const ix of kaminoAction.setupIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.lendingIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.cleanupIxs) tx.add(convertInstruction(ix));

    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [wallet],
      { commitment: 'confirmed' }
    );

    return signature;
  }

  /**
   * Withdraw tokens — requires SDK for transaction building.
   */
  async withdraw(
    wallet: Keypair,
    symbol: string,
    amount: Decimal
  ): Promise<string> {
    const market = await this.ensureMarket();

    const reserve = market.getReserves().find(
      r => r.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    if (!reserve) {
      throw new Error(`Reserve not found for symbol: ${symbol}`);
    }

    const decimals = symbol.toUpperCase() === 'SOL' ? 9 : 6;
    const amountBase = amount.mul(Math.pow(10, decimals)).floor().toString();

    const signer = await createKeyPairSignerFromBytes(wallet.secretKey);

    const kaminoAction = await KaminoAction.buildWithdrawTxns({
      kaminoMarket: market,
      amount: amountBase,
      reserveAddress: reserve.address,
      owner: signer,
      obligation: new VanillaObligation(PROGRAM_ID),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      includeAtaIxs: true,
      currentSlot: this.currentSlot,
    });

    const tx = new Transaction();
    for (const ix of kaminoAction.setupIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.lendingIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.cleanupIxs) tx.add(convertInstruction(ix));

    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [wallet],
      { commitment: 'confirmed' }
    );

    return signature;
  }

  /**
   * Borrow tokens — requires SDK for transaction building.
   * Used by multiply strategy to borrow SOL against LST collateral.
   */
  async borrow(
    wallet: Keypair,
    symbol: string,
    amount: Decimal,
    marketAddress?: string
  ): Promise<string> {
    const market = marketAddress
      ? await this.loadMarketByAddress(marketAddress)
      : await this.ensureMarket();

    const reserve = market.getReserves().find(
      r => r.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    if (!reserve) {
      throw new Error(`Reserve not found for symbol: ${symbol}`);
    }

    const decimals = symbol.toUpperCase() === 'SOL' ? 9 : (symbol.toUpperCase() === 'USDC' || symbol.toUpperCase() === 'USDT' ? 6 : 9);
    const amountBase = amount.mul(Math.pow(10, decimals)).floor().toString();

    console.log(`Building borrow tx: ${amount} ${symbol} (${amountBase} base units)`);
    console.log(`Reserve address: ${reserve.address.toString()}`);

    const signer = await createKeyPairSignerFromBytes(wallet.secretKey);
    const slot = await retry(() => this.connection.getSlot());
    const currentSlot = BigInt(slot);

    const kaminoAction = await KaminoAction.buildBorrowTxns({
      kaminoMarket: market,
      amount: amountBase,
      reserveAddress: reserve.address,
      owner: signer,
      obligation: new VanillaObligation(PROGRAM_ID),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      includeAtaIxs: true,
      currentSlot,
    });

    const tx = new Transaction();
    for (const ix of kaminoAction.setupIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.lendingIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.cleanupIxs) tx.add(convertInstruction(ix));

    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [wallet],
      { commitment: 'confirmed' }
    );

    return signature;
  }

  /**
   * Repay borrowed tokens — requires SDK for transaction building.
   * Used by multiply strategy to unwind positions.
   */
  async repay(
    wallet: Keypair,
    symbol: string,
    amount: Decimal,
    marketAddress?: string
  ): Promise<string> {
    const market = marketAddress
      ? await this.loadMarketByAddress(marketAddress)
      : await this.ensureMarket();

    const reserve = market.getReserves().find(
      r => r.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    if (!reserve) {
      throw new Error(`Reserve not found for symbol: ${symbol}`);
    }

    const decimals = symbol.toUpperCase() === 'SOL' ? 9 : (symbol.toUpperCase() === 'USDC' || symbol.toUpperCase() === 'USDT' ? 6 : 9);
    const amountBase = amount.mul(Math.pow(10, decimals)).floor().toString();

    console.log(`Building repay tx: ${amount} ${symbol} (${amountBase} base units)`);
    console.log(`Reserve address: ${reserve.address.toString()}`);

    const signer = await createKeyPairSignerFromBytes(wallet.secretKey);
    const slot = await retry(() => this.connection.getSlot());
    const currentSlot = BigInt(slot);

    const kaminoAction = await KaminoAction.buildRepayTxns({
      kaminoMarket: market,
      amount: amountBase,
      reserveAddress: reserve.address,
      owner: signer,
      obligation: new VanillaObligation(PROGRAM_ID),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      includeAtaIxs: true,
      currentSlot,
    });

    const tx = new Transaction();
    for (const ix of kaminoAction.setupIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.lendingIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.cleanupIxs) tx.add(convertInstruction(ix));

    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [wallet],
      { commitment: 'confirmed' }
    );

    return signature;
  }

  /**
   * Load a specific market by address (for multi-market operations).
   * Caches loaded markets.
   */
  private marketCache: Map<string, KaminoMarket> = new Map();

  private async loadMarketByAddress(marketAddr: string): Promise<KaminoMarket> {
    if (this.marketCache.has(marketAddr)) {
      return this.marketCache.get(marketAddr)!;
    }

    console.log(`   📡 Loading SDK market ${marketAddr.slice(0, 8)}... for transaction building`);
    const market = await retry(() =>
      KaminoMarket.load(this.rpc, address(marketAddr), 400, PROGRAM_ID)
    );
    if (!market) throw new Error(`Failed to load market: ${marketAddr}`);
    this.marketCache.set(marketAddr, market);
    return market;
  }

  /**
   * Deposit tokens to a specific market (not just the main market).
   */
  async depositToMarket(
    wallet: Keypair,
    symbol: string,
    amount: Decimal,
    marketAddress: string
  ): Promise<string> {
    const market = await this.loadMarketByAddress(marketAddress);

    const reserve = market.getReserves().find(
      r => r.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    if (!reserve) {
      throw new Error(`Reserve not found for symbol: ${symbol} in market ${marketAddress.slice(0, 8)}`);
    }

    const decimals = symbol.toUpperCase() === 'SOL' ? 9 : (symbol.toUpperCase() === 'USDC' || symbol.toUpperCase() === 'USDT' ? 6 : 9);
    const amountBase = amount.mul(Math.pow(10, decimals)).floor().toString();

    console.log(`Building deposit tx: ${amount} ${symbol} (${amountBase} base units) → market ${marketAddress.slice(0, 8)}`);

    const signer = await createKeyPairSignerFromBytes(wallet.secretKey);
    const slot = await retry(() => this.connection.getSlot());
    const currentSlot = BigInt(slot);

    const kaminoAction = await KaminoAction.buildDepositTxns({
      kaminoMarket: market,
      amount: amountBase,
      reserveAddress: reserve.address,
      owner: signer,
      obligation: new VanillaObligation(PROGRAM_ID),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      includeAtaIxs: true,
      currentSlot,
    });

    const tx = new Transaction();
    for (const ix of kaminoAction.setupIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.lendingIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.cleanupIxs) tx.add(convertInstruction(ix));

    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [wallet],
      { commitment: 'confirmed' }
    );

    return signature;
  }

  /**
   * Withdraw tokens from a specific market.
   */
  async withdrawFromMarket(
    wallet: Keypair,
    symbol: string,
    amount: Decimal,
    marketAddress: string
  ): Promise<string> {
    const market = await this.loadMarketByAddress(marketAddress);

    const reserve = market.getReserves().find(
      r => r.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    if (!reserve) {
      throw new Error(`Reserve not found for symbol: ${symbol} in market ${marketAddress.slice(0, 8)}`);
    }

    const decimals = symbol.toUpperCase() === 'SOL' ? 9 : (symbol.toUpperCase() === 'USDC' || symbol.toUpperCase() === 'USDT' ? 6 : 9);
    const amountBase = amount.mul(Math.pow(10, decimals)).floor().toString();

    console.log(`Building withdraw tx: ${amount} ${symbol} (${amountBase} base units) ← market ${marketAddress.slice(0, 8)}`);

    const signer = await createKeyPairSignerFromBytes(wallet.secretKey);
    const slot = await retry(() => this.connection.getSlot());
    const currentSlot = BigInt(slot);

    const kaminoAction = await KaminoAction.buildWithdrawTxns({
      kaminoMarket: market,
      amount: amountBase,
      reserveAddress: reserve.address,
      owner: signer,
      obligation: new VanillaObligation(PROGRAM_ID),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      includeAtaIxs: true,
      currentSlot,
    });

    const tx = new Transaction();
    for (const ix of kaminoAction.setupIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.lendingIxs) tx.add(convertInstruction(ix));
    for (const ix of kaminoAction.cleanupIxs) tx.add(convertInstruction(ix));

    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [wallet],
      { commitment: 'confirmed' }
    );

    return signature;
  }

  async getSolBalance(walletPubkey: PublicKey): Promise<Decimal> {
    const balance = await this.connection.getBalance(walletPubkey);
    return new Decimal(balance).div(LAMPORTS_PER_SOL);
  }

  async getTokenBalance(walletPubkey: PublicKey, tokenMint: string): Promise<Decimal> {
    try {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(
        walletPubkey,
        { mint: new PublicKey(tokenMint) }
      );

      if (accounts.value.length === 0) return new Decimal(0);

      const balance = accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
      return new Decimal(balance || 0);
    } catch {
      return new Decimal(0);
    }
  }
}

// Convert @solana/kit instruction to web3.js TransactionInstruction
function convertInstruction(ix: any): any {
  if (ix.programId instanceof PublicKey) return ix;
  return {
    programId: new PublicKey(ix.programAddress?.toString() || ix.programId?.toString()),
    keys: (ix.accounts || []).map((acc: any) => ({
      pubkey: new PublicKey(acc.address?.toString() || acc.pubkey?.toString()),
      isSigner: acc.role === 3 || acc.role === 2 || acc.signer === true,
      isWritable: acc.role === 1 || acc.role === 3 || acc.writable === true,
    })),
    data: Buffer.from(ix.data || []),
  };
}
