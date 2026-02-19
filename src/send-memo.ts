import { Connection, Keypair, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

async function main() {
  const walletPath = "/root/clawd/skills/kamino-yield/config/wallet.json";
  const secret = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  const conn = new Connection(RPC, "confirmed");
  
  const memo = process.argv[2];
  if (!memo) { console.error("No memo text"); process.exit(1); }
  
  const ix = new TransactionInstruction({
    keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, "utf-8"),
  });
  
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [keypair]);
  console.log("Memo TX:", sig);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
