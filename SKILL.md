# Kamino Yield Optimizer

Autonomous multi-strategy DeFi yield optimizer for Solana. Deploys capital across Kamino Finance K-Lend, Multiply, and Jupiter swaps to maximize returns.

## Overview

This skill allows an agent to:
- Scan Kamino lending vaults for best yields across multiple markets
- Auto-deposit idle funds into highest-APY vaults
- Manage Kamino Multiply positions (leveraged staking)
- Swap tokens via Jupiter V6 for rebalancing
- Track a multi-token portfolio with allocation targets
- Monitor position health and rebalance automatically
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

### 3. Fund & Run

Send SOL to the wallet address, then:

```bash
# Full multi-strategy optimization
npx ts-node src/optimize-v2.ts

# Scan rates across all products (read-only)
npx ts-node src/scanner.ts

# Legacy single-strategy optimizer
npx ts-node src/optimize-cron.ts
```

## Usage

### Commands

```bash
# Rate scanner — shows all K-Lend rates, Multiply opportunities, top picks
npx ts-node src/scanner.ts

# Multi-strategy optimizer (v2) — full portfolio management
npx ts-node src/optimize-v2.ts

# Legacy optimizer — K-Lend only (backward compatible)
npx ts-node src/optimize-cron.ts
```

### Cron Setup (Clawdbot)

```
# v2 optimizer every 2 hours
30 */2 * * *  cd /root/clawd/skills/kamino-yield && npx ts-node src/optimize-v2.ts

# Rate scanner every 6 hours (logging only)
0 */6 * * *  cd /root/clawd/skills/kamino-yield && npx ts-node src/scanner.ts
```

## Configuration

Edit `config/settings.json`:

```json
{
  "rpcUrl": "https://api.mainnet-beta.solana.com",
  "dryRun": true,
  "riskTolerance": "balanced",
  "portfolio": {
    "allocations": { "klendUsdc": 0.60, "multiply": 0.30, "gasReserve": 0.10 },
    "rebalanceThreshold": 0.10
  },
  "multiply": {
    "maxLeverage": 5,
    "minSpread": 1.0,
    "maxLtv": 0.85,
    "preferredMarket": "DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek"
  },
  "jupiter": {
    "slippageBps": 50,
    "preferDirect": false,
    "maxAccounts": 64
  }
}
```

| Option | Description |
|--------|-------------|
| `rpcUrl` | Solana RPC endpoint |
| `dryRun` | `true` = simulate only, `false` = execute |
| `riskTolerance` | `conservative`, `balanced`, or `aggressive` |
| `portfolio.allocations` | Target allocation weights (must sum to ~1.0) |
| `portfolio.rebalanceThreshold` | Minimum drift before triggering rebalance |
| `multiply.maxLeverage` | Max leverage for Multiply positions |
| `multiply.minSpread` | Min staking-borrow spread to open position (%) |
| `multiply.maxLtv` | Alert/stop threshold for LTV |
| `jupiter.slippageBps` | Slippage tolerance in basis points |

## Architecture

### Modules

| File | Purpose |
|------|---------|
| `kamino-client.ts` | K-Lend SDK wrapper (deposit/withdraw/scan) |
| `multiply-client.ts` | Multiply position management (JitoSOL<>SOL) |
| `jupiter-client.ts` | Jupiter V6 swap integration |
| `portfolio.ts` | Multi-token portfolio tracking & allocation |
| `scanner.ts` | Rate scanner across all Kamino products |
| `optimize-v2.ts` | Multi-strategy optimizer (main entry) |
| `optimize-cron.ts` | Legacy K-Lend-only optimizer |
| `types.ts` | Shared type definitions |

### Strategy Flow (optimize-v2)

1. **Snapshot** — Fetch all balances, K-Lend positions, Multiply positions
2. **Scan rates** — Get current APYs across all K-Lend markets
3. **Check Multiply** — Evaluate spread and profitability
4. **Monitor health** — Check existing Multiply position LTV/APY
5. **Compute rebalance** — Compare current vs target allocation
6. **Execute actions** — Swap, deposit, withdraw as needed
7. **Safety checks** — Gas buffer, min spread, min improvement
8. **Log** — Write to performance.jsonl

### Safety Guards

- **Gas buffer**: Never drops SOL below 0.01 SOL
- **Min spread**: Won't open Multiply if staking-borrow spread < 1%
- **Min improvement**: Won't rebalance K-Lend unless >0.5% APY gain
- **LTV alerts**: Warns if Multiply LTV > 85%
- **Dry run**: All actions respect the dryRun setting

## Files

```
kamino-yield/
├── config/
│   ├── wallet.json          # Keypair (SECRET!)
│   ├── settings.json        # Configuration
│   └── performance.jsonl    # Yield tracking
├── src/
│   ├── kamino-client.ts     # K-Lend SDK wrapper
│   ├── multiply-client.ts   # Multiply management
│   ├── jupiter-client.ts    # Jupiter swap client
│   ├── portfolio.ts         # Portfolio tracker
│   ├── scanner.ts           # Rate scanner
│   ├── optimize-v2.ts       # Multi-strategy optimizer
│   ├── optimize-cron.ts     # Legacy optimizer
│   ├── types.ts             # Type definitions
│   └── generate-wallet.ts   # Wallet generator
├── scripts/
│   ├── scan.sh
│   ├── status.sh
│   └── optimize.sh
├── SKILL.md
└── README.md
```

## Dependencies

- `@kamino-finance/klend-sdk` — K-Lend protocol SDK
- `@kamino-finance/kliquidity-sdk` — Liquidity vault SDK
- `@solana/web3.js` — Solana base SDK
- `@solana/kit` — Modern Solana utilities
- `decimal.js` — Precise math
- `bs58` — Base58 encoding

## Limitations

- Public RPC may rate-limit (use Helius/Triton for reliability)
- Multiply open/close positions are dry-run only (use Kamino UI for live)
- Jupiter quotes require internet access
- Yields are variable and can change rapidly
