import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import bs58 from 'bs58';

const walletPath = path.join(__dirname, '../config/wallet.json');

// Generate new keypair
const keypair = Keypair.generate();

// Save as JSON array (compatible with solana-keygen format)
fs.writeFileSync(walletPath, JSON.stringify(Array.from(keypair.secretKey)));

console.log('🔐 Wallet generated!');
console.log(`   Public Key: ${keypair.publicKey.toBase58()}`);
console.log(`   Path: ${walletPath}`);
console.log('\n⚠️  Fund this wallet with SOL for gas and tokens to optimize.');
console.log('   Send SOL to the address above to get started.');
