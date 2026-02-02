# Kamino Yield Optimizer

Autonomous DeFi yield farming on Solana. Deploys capital to Kamino Finance lending vaults and automatically rebalances to maximize returns.

## What It Does

- **Scans** all Kamino lending vaults for current APYs
- **Auto-deposits** idle wallet funds to highest-yield vaults
- **Rebalances** positions when better yields become available
- **Tracks** performance over time
- **Runs autonomously** via cron (every 2 hours)

## Quick Start

### 1. Install Dependencies

```bash
cd skills/kamino-yield
npm install
```

### 2. Generate Wallet

```bash
npx ts-node src/generate-wallet.ts
```

This creates `config/wallet.json` with a new Solana keypair. Save the public key — you'll need to fund it.

### 3. Fund the Wallet

Send SOL to the generated address. Minimum recommended: 0.05 SOL (for gas + initial deposit).

### 4. Configure (Optional)

Edit `config/settings.json`:

```json
{
  "rpcUrl": "https://api.mainnet-beta.solana.com",
  "dryRun": false
}
```

Set `dryRun: true` to test without executing transactions.

### 5. Run Manually

```bash
npx ts-node src/optimize-cron.ts
```

### 6. Set Up Cron (Clawdbot)

```bash
clawdbot cron add \
  --name "Kamino yield optimizer" \
  --schedule "30 */2 * * *" \
  --message "Run: cd /path/to/skills/kamino-yield && npx ts-node src/optimize-cron.ts"
```

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    OPTIMIZER FLOW                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. CONNECT                                              │
│     └─→ Load wallet from config/wallet.json              │
│     └─→ Connect to Kamino via SDK                        │
│                                                          │
│  2. SCAN VAULTS                                          │
│     └─→ Fetch all lending reserves                       │
│     └─→ Get current supply APY for each                  │
│     └─→ Sort by yield (highest first)                    │
│                                                          │
│  3. CHECK POSITIONS                                      │
│     └─→ Query user's current deposits                    │
│     └─→ Calculate current weighted APY                   │
│                                                          │
│  4. REBALANCE (if profitable)                            │
│     └─→ For each position, check if better vault exists  │
│     └─→ If APY gain > 0.25%, withdraw and redeposit      │
│     └─→ Account for gas costs                            │
│                                                          │
│  5. DEPLOY IDLE FUNDS                                    │
│     └─→ Check wallet SOL balance                         │
│     └─→ Keep 0.005 SOL for gas buffer                    │
│     └─→ Deposit remainder to best SOL vault              │
│                                                          │
│  6. LOG PERFORMANCE                                      │
│     └─→ Append to config/performance.jsonl               │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## File Structure

```
kamino-yield/
├── config/
│   ├── wallet.json           # Solana keypair (KEEP SECRET)
│   ├── settings.json         # Configuration
│   └── performance.jsonl     # Performance tracking log
├── src/
│   ├── kamino-client.ts      # Kamino SDK wrapper
│   ├── optimize-cron.ts      # Main optimizer script
│   ├── generate-wallet.ts    # Wallet generation utility
│   └── types.ts              # TypeScript types
├── scripts/
│   └── optimize.sh           # Shell wrapper for cron
├── package.json
├── tsconfig.json
├── SKILL.md                  # Skill metadata
└── README.md                 # This file
```

## Configuration Options

`config/settings.json`:

| Field | Description | Default |
|-------|-------------|---------|
| `rpcUrl` | Solana RPC endpoint | mainnet-beta |
| `dryRun` | Simulate without executing | `false` |
| `riskTolerance` | conservative/balanced/aggressive | `balanced` |
| `minYieldImprovement` | Min APY gain to trigger rebalance | `0.5` |

## Example Output

```
═══════════════════════════════════════════════════════════
     🚀 KAMINO YIELD OPTIMIZER - AGGRESSIVE MODE
     2026-02-02T07:47:46.288Z
═══════════════════════════════════════════════════════════

💳 Wallet: 7u5ovFNms7oE232TTyMU5TxDfyZTJctihH4YqP2n1EUz
   SOL: 0.022071 (~$2.24) @ $102/SOL

🔍 Scanning all vaults...

   🔥 FDUSD Earn       67.03% APY
   ✨ SOL Earn          3.34% APY
   ✨ USDC Earn         3.31% APY

📊 Current positions...
   SOL Earn: 0.010000 SOL (~$1.02) @ 3.34% APY

💰 Idle SOL detected: 0.017071 SOL
⚡ Auto-depositing...
   ✅ Deposited 0.017071 SOL

═══════════════════════════════════════════════════════════
                      📈 SUMMARY
═══════════════════════════════════════════════════════════
   Total Value: $3.26
   Actions:     Deposited 0.0171 SOL to SOL Earn
═══════════════════════════════════════════════════════════
```

## Supported Tokens

Currently optimizes for tokens you hold:
- SOL
- USDC
- USDT
- JitoSOL, mSOL, bSOL (liquid staking tokens)

## Safety Features

- **Gas buffer**: Always keeps 0.005 SOL for transaction fees
- **Min rebalance threshold**: Only moves funds if APY gain > 0.25%
- **Dry run mode**: Test without executing real transactions
- **Retry logic**: Handles RPC rate limits gracefully
- **Local signing**: Private key never leaves your server

## Extending

### Add Jupiter Swaps

To chase yields across different tokens (e.g., swap SOL → FDUSD for higher APY), you'd need to:

1. Add Jupiter SDK: `npm install @jup-ag/api`
2. Implement swap logic in `kamino-client.ts`
3. Add cross-token yield comparison in optimizer

### Add More Protocols

The architecture supports adding other Solana DeFi protocols:
- Marinade (mSOL staking)
- Jito (JitoSOL staking)
- Solend (lending)
- Drift (perpetuals yield)

## Troubleshooting

### RPC Rate Limits

If you see "429 Too Many Requests", the public RPC is rate limiting. Solutions:
- Wait and retry (built-in)
- Use a private RPC (Helius, Triton, QuickNode)

### Transaction Failures

Common causes:
- Insufficient SOL for gas
- Stale blockhash (retry usually fixes)
- Slippage on large amounts

### No Positions Found

The SDK's `getUserVanillaObligation` may fail silently if rate limited. Check logs for warnings.

## License

MIT — use freely, no warranty.

## Credits

Built for Clawdbot agents. Uses:
- [@kamino-finance/klend-sdk](https://github.com/Kamino-Finance/klend-sdk)
- [@solana/web3.js](https://github.com/solana-labs/solana-web3.js)
- [@solana/kit](https://github.com/solana-labs/solana-web3.js)
