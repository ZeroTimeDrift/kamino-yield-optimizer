# Kamino Yield Optimizer

Autonomous DeFi yield farming skill for Solana. Deploys capital to Kamino Finance lending vaults and rebalances to maximize returns.

## Overview

This skill allows an agent to:
- Generate and manage a Solana wallet
- Scan Kamino lending vaults for best yields
- Auto-deposit idle funds
- Rebalance to higher-yielding vaults
- Track performance over time

## Setup

### 1. Install

```bash
cd skills/kamino-yield
npm install
```

### 2. Generate Wallet

```bash
npx ts-node src/generate-wallet.ts
```

Outputs:
```
🔐 Wallet generated!
   Public Key: 7u5ovFNms7oE232TTyMU5TxDfyZTJctihH4YqP2n1EUz
   Path: config/wallet.json

⚠️  Fund this wallet with SOL for gas and tokens to optimize.
```

### 3. Fund & Run

Send SOL to the wallet address, then:

```bash
npx ts-node src/optimize-cron.ts
```

## Usage

### Manual Commands

```bash
# Run full optimization cycle
npx ts-node src/optimize-cron.ts

# Generate new wallet (if needed)
npx ts-node src/generate-wallet.ts
```

### Cron Setup (Clawdbot)

The skill should run every 2 hours:

```
Schedule: 30 */2 * * *
Command: cd /path/to/skills/kamino-yield && npx ts-node src/optimize-cron.ts
```

## Configuration

Edit `config/settings.json`:

```json
{
  "rpcUrl": "https://api.mainnet-beta.solana.com",
  "dryRun": false,
  "riskTolerance": "balanced"
}
```

| Option | Description |
|--------|-------------|
| `rpcUrl` | Solana RPC endpoint |
| `dryRun` | `true` = simulate only, `false` = execute |
| `riskTolerance` | `conservative`, `balanced`, or `aggressive` |

## How It Works

1. **Scan**: Fetches all Kamino lending vaults and their APYs
2. **Analyze**: Checks current positions against available vaults
3. **Rebalance**: If a better vault exists (>0.25% APY gain), moves funds
4. **Deploy**: Auto-deposits any idle SOL (keeps 0.005 SOL for gas)
5. **Log**: Records performance to `config/performance.jsonl`

## Example Output

```
═══════════════════════════════════════════════════════════
     🚀 KAMINO YIELD OPTIMIZER - AGGRESSIVE MODE
═══════════════════════════════════════════════════════════

💳 Wallet: 7u5ovFNms7oE232TTyMU5TxDfyZTJctihH4YqP2n1EUz
   SOL: 0.022 (~$2.24) @ $102/SOL

🔍 Scanning all vaults...
   🔥 FDUSD Earn       67.03% APY
   ✨ SOL Earn          3.34% APY
   ✨ USDC Earn         3.31% APY

📊 Current positions...
   SOL Earn: 0.01 SOL @ 3.34% APY

⚡ Auto-depositing 0.017 SOL...
   ✅ Done! Tx: KvpU7CjM...

═══════════════════════════════════════════════════════════
   Total Value: $3.26 | Actions: 1 executed
═══════════════════════════════════════════════════════════
```

## Files

```
kamino-yield/
├── config/
│   ├── wallet.json         # Keypair (SECRET - don't share!)
│   ├── settings.json       # Configuration
│   └── performance.jsonl   # Yield tracking
├── src/
│   ├── kamino-client.ts    # SDK wrapper
│   ├── optimize-cron.ts    # Main optimizer
│   └── generate-wallet.ts  # Wallet generator
├── SKILL.md                # This file
└── README.md               # Detailed documentation
```

## Safety

- Private key stays local (never transmitted)
- Gas buffer always maintained (0.005 SOL)
- Dry run mode for testing
- Retry logic for RPC failures

## Dependencies

- `@kamino-finance/klend-sdk` - Kamino protocol SDK
- `@solana/web3.js` - Solana base SDK
- `@solana/kit` - Modern Solana utilities
- `decimal.js` - Precise math

## Limitations

- Currently optimizes tokens you already hold (no cross-token swaps)
- Public RPC may rate limit (use private RPC for reliability)
- Yields are variable and can change rapidly

## Future Enhancements

- Jupiter integration for cross-token yield chasing
- Support for Kamino Liquidity (LP) vaults
- Telegram alerts on rebalances
- Multi-wallet support
