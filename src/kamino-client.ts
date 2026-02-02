/**
 * Kamino Finance SDK Client - Fixed for klend-sdk v7.x with @solana/kit
 */

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createSolanaRpc, address, Address, createKeyPairSignerFromBytes } from '@solana/kit';
import { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID } from '@kamino-finance/klend-sdk';
import Decimal from 'decimal.js';
import { VaultInfo, Position, TOKEN_MINTS } from './types';

// Main Kamino market address
const MAIN_MARKET = address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

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
  private market: KaminoMarket | null = null;
  private currentSlot: bigint = 0n;
  
  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
    this.rpc = createSolanaRpc(rpcUrl);
  }
  
  async initialize(): Promise<void> {
    console.log('📡 Connecting to Kamino market...');
    this.market = await retry(() => KaminoMarket.load(this.rpc, MAIN_MARKET, 400, PROGRAM_ID));
    if (!this.market) throw new Error('Failed to load market');
    
    // Get current slot for APY calculations
    const slot = await retry(() => this.connection.getSlot());
    this.currentSlot = BigInt(slot);
    
    console.log('✅ Connected to Kamino main market');
  }
  
  async getReserves(): Promise<VaultInfo[]> {
    if (!this.market) {
      await this.initialize();
    }
    
    const vaults: VaultInfo[] = [];
    const reserves = this.market!.getReserves();
    
    // Scan ALL reserves with APY > 0
    for (const reserve of reserves) {
      try {
        const symbol = reserve.symbol?.toUpperCase();
        if (!symbol) continue;
        
        const supplyApy = reserve.totalSupplyAPY(this.currentSlot) || 0;
        const tvl = reserve.getTotalSupply() || 0;
        
        vaults.push({
          address: reserve.address.toString(),
          name: `${reserve.symbol} Earn`,
          type: 'earn',
          token: reserve.symbol || 'UNKNOWN',
          tokenMint: reserve.getLiquidityMint().toString(),
          apy: new Decimal(supplyApy).mul(100), // to percentage
          tvlUsd: new Decimal(tvl),
          depositFeePercent: new Decimal(0),
          withdrawalFeePercent: new Decimal(0.1),
          createdAt: new Date(),
          isActive: true,
        });
      } catch (error) {
        // Skip reserves that fail
      }
    }
    
    // Sort by APY descending
    vaults.sort((a, b) => b.apy.minus(a.apy).toNumber());
    
    return vaults;
  }
  
  async getUserPositions(walletPubkey: PublicKey): Promise<Position[]> {
    if (!this.market) {
      await this.initialize();
    }
    
    const positions: Position[] = [];
    
    try {
      const walletAddr = address(walletPubkey.toBase58());
      
      // Use getUserVanillaObligation instead of getAllUserObligations (fewer RPC calls)
      const obligation = await retry(
        () => this.market!.getUserVanillaObligation(walletAddr),
        2, 3000
      );
      
      if (!obligation) {
        return positions;
      }
      
      for (const [reserveAddr, deposit] of obligation.deposits.entries()) {
        const reserve = this.market!.getReserveByAddress(reserveAddr);
        if (!reserve) continue;
        
        positions.push({
          vaultAddress: reserveAddr.toString(),
          vaultName: `${reserve.symbol} Earn`,
          token: reserve.symbol || 'UNKNOWN',
          shares: new Decimal(deposit.amount?.toString() || 0),
          tokenAmount: new Decimal(deposit.amount?.toString() || 0),
          valueUsd: new Decimal(deposit.marketValueRefreshed?.toString() || 0),
          currentApy: new Decimal(reserve.totalSupplyAPY(this.currentSlot) || 0).mul(100),
          depositedAt: new Date(),
          unrealizedPnl: new Decimal(0),
        });
      }
    } catch (error: any) {
      // Don't fail if we can't fetch positions - just return empty
      console.log('   ⚠️  Could not fetch positions (rate limited)');
    }
    
    return positions;
  }
  
  async deposit(
    wallet: Keypair,
    symbol: string,
    amount: Decimal
  ): Promise<string> {
    if (!this.market) {
      await this.initialize();
    }
    
    // Find reserve by symbol
    const reserve = this.market!.getReserves().find(
      r => r.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    if (!reserve) {
      throw new Error(`Reserve not found for symbol: ${symbol}`);
    }
    
    // Get decimals for token
    const decimals = symbol.toUpperCase() === 'SOL' ? 9 : 6;
    const amountBase = amount.mul(Math.pow(10, decimals)).floor().toString();
    
    console.log(`Building deposit tx: ${amount} ${symbol} (${amountBase} base units)`);
    console.log(`Reserve address: ${reserve.address.toString()}`);
    
    // Create signer from keypair
    const signer = await createKeyPairSignerFromBytes(wallet.secretKey);
    
    const kaminoAction = await KaminoAction.buildDepositTxns({
      kaminoMarket: this.market!,
      amount: amountBase,
      reserveAddress: reserve.address,
      owner: signer,
      obligation: new VanillaObligation(PROGRAM_ID),
      useV2Ixs: true,
      scopeRefreshConfig: undefined,
      includeAtaIxs: true,
      currentSlot: this.currentSlot,
    });
    
    // Combine all instructions into one transaction
    const tx = new Transaction();
    
    for (const ix of kaminoAction.setupIxs) {
      tx.add(convertInstruction(ix));
    }
    for (const ix of kaminoAction.lendingIxs) {
      tx.add(convertInstruction(ix));
    }
    for (const ix of kaminoAction.cleanupIxs) {
      tx.add(convertInstruction(ix));
    }
    
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
  
  async withdraw(
    wallet: Keypair,
    symbol: string,
    amount: Decimal
  ): Promise<string> {
    if (!this.market) {
      await this.initialize();
    }
    
    const reserve = this.market!.getReserves().find(
      r => r.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    if (!reserve) {
      throw new Error(`Reserve not found for symbol: ${symbol}`);
    }
    
    const decimals = symbol.toUpperCase() === 'SOL' ? 9 : 6;
    const amountBase = amount.mul(Math.pow(10, decimals)).floor().toString();
    
    const signer = await createKeyPairSignerFromBytes(wallet.secretKey);
    
    const kaminoAction = await KaminoAction.buildWithdrawTxns({
      kaminoMarket: this.market!,
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
    
    for (const ix of kaminoAction.setupIxs) {
      tx.add(convertInstruction(ix));
    }
    for (const ix of kaminoAction.lendingIxs) {
      tx.add(convertInstruction(ix));
    }
    for (const ix of kaminoAction.cleanupIxs) {
      tx.add(convertInstruction(ix));
    }
    
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
  // If it's already a web3.js instruction, return as-is
  if (ix.programId instanceof PublicKey) {
    return ix;
  }
  
  // Convert from @solana/kit format
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
