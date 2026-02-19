/**
 * Jupiter V6 Swap Client
 * Handles token swaps via Jupiter aggregator API.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import Decimal from 'decimal.js';
import {
  TOKEN_MINTS,
  TOKEN_DECIMALS,
  JupiterQuote,
  JupiterSwapResponse,
  JupiterSettings,
} from './types';

const JUPITER_API = 'https://public.jupiterapi.com';

/** Retry helper – mirrors the pattern from kamino-client.ts */
async function retry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      const isRateLimit = err.message?.includes('429') || err.message?.includes('Too Many');
      const wait = isRateLimit ? delayMs * (i + 2) : delayMs;
      console.log(`   ⏳ Jupiter retry ${i + 1}/${maxRetries} in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('Max retries exceeded');
}

export class JupiterClient {
  private connection: Connection;
  private settings: JupiterSettings;

  constructor(connection: Connection, settings?: Partial<JupiterSettings>) {
    this.connection = connection;
    this.settings = {
      slippageBps: settings?.slippageBps ?? 50,
      preferDirect: settings?.preferDirect ?? false,
      maxAccounts: settings?.maxAccounts ?? 64,
    };
  }

  /**
   * Get a swap quote from Jupiter V6.
   */
  async getQuote(
    inputToken: string,
    outputToken: string,
    amountUi: Decimal,
    slippageBps?: number
  ): Promise<JupiterQuote> {
    // Accept token symbols (lookup in TOKEN_MINTS) or raw mint addresses
    const inputMint = TOKEN_MINTS[inputToken] || (inputToken.length > 30 ? inputToken : null);
    const outputMint = TOKEN_MINTS[outputToken] || (outputToken.length > 30 ? outputToken : null);
    if (!inputMint) throw new Error(`Unknown input token: ${inputToken}`);
    if (!outputMint) throw new Error(`Unknown output token: ${outputToken}`);

    const decimals = TOKEN_DECIMALS[inputToken] ?? 9;
    const amountRaw = amountUi.mul(new Decimal(10).pow(decimals)).floor().toString();
    const slippage = slippageBps ?? this.settings.slippageBps;

    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountRaw,
      slippageBps: slippage.toString(),
      onlyDirectRoutes: this.settings.preferDirect.toString(),
      maxAccounts: this.settings.maxAccounts.toString(),
    });

    const url = `${JUPITER_API}/quote?${params}`;
    console.log(`   🪐 Jupiter quote: ${amountUi} ${inputToken} → ${outputToken}`);

    const res = await retry(async () => {
      const r = await fetch(url);
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`Jupiter quote failed (${r.status}): ${body}`);
      }
      return r.json() as Promise<JupiterQuote>;
    });

    const outDecimals = TOKEN_DECIMALS[outputToken] ?? 9;
    const outUi = new Decimal(res.outAmount).div(new Decimal(10).pow(outDecimals));
    console.log(`   📊 Quote: ${amountUi} ${inputToken} → ${outUi.toFixed(6)} ${outputToken} (impact: ${res.priceImpactPct}%)`);

    return res;
  }

  /**
   * Build a swap transaction from a quote.
   * Returns a VersionedTransaction ready to sign + send.
   */
  async buildSwapTx(
    quote: JupiterQuote,
    walletPubkey: PublicKey
  ): Promise<VersionedTransaction> {
    const url = `${JUPITER_API}/swap`;

    const body = {
      quoteResponse: quote,
      userPublicKey: walletPubkey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    };

    const res = await retry(async () => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`Jupiter swap build failed (${r.status}): ${txt}`);
      }
      return r.json() as Promise<JupiterSwapResponse>;
    });

    // Decode versioned transaction
    const txBuf = Buffer.from(res.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    return tx;
  }

  /**
   * Execute a swap end-to-end.
   * Returns the transaction signature or null if dryRun.
   */
  async executeSwap(
    inputToken: string,
    outputToken: string,
    amountUi: Decimal,
    wallet: Keypair,
    dryRun: boolean = true
  ): Promise<{ signature: string | null; quote: JupiterQuote }> {
    const quote = await this.getQuote(inputToken, outputToken, amountUi);

    if (dryRun) {
      console.log(`   🧪 DRY RUN — would swap ${amountUi} ${inputToken} → ${outputToken}`);
      return { signature: null, quote };
    }

    console.log(`   ⚡ Executing swap...`);
    const tx = await this.buildSwapTx(quote, wallet.publicKey);

    // Sign
    tx.sign([wallet]);

    // Send with confirmation
    const rawTx = tx.serialize();
    const signature = await retry(async () => {
      const sig = await this.connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 2,
      });

      // Wait for confirmation
      const latestBh = await this.connection.getLatestBlockhash();
      await this.connection.confirmTransaction(
        { signature: sig, ...latestBh },
        'confirmed'
      );
      return sig;
    });

    console.log(`   ✅ Swap confirmed: ${signature}`);
    return { signature, quote };
  }

  /**
   * Get price of one token in terms of another (via 1-unit quote).
   */
  async getPrice(baseToken: string, quoteToken: string): Promise<Decimal> {
    try {
      const quote = await this.getQuote(baseToken, quoteToken, new Decimal(1));
      const outDecimals = TOKEN_DECIMALS[quoteToken] ?? 9;
      return new Decimal(quote.outAmount).div(new Decimal(10).pow(outDecimals));
    } catch {
      return new Decimal(0);
    }
  }
}
