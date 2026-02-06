# Kamino Yield Optimizer

Autonomous multi-strategy DeFi yield optimizer on Solana. Manages capital across Kamino K-Lend, Multiply vaults, and token swaps via Jupiter to maximize risk-adjusted returns.

## What It Does

- **Multi-market scanning** — Scans K-Lend rates across Main, Jito, and Altcoins markets (80+ reserves)
- **Multiply monitoring** — Tracks JitoSOL<>SOL leveraged staking spreads and manages positions
- **Jupiter swaps** — SOL↔USDC, SOL→JitoSOL with slippage protection
- **Portfolio management** — Target allocation tracking with automatic drift detection
- **Auto-rebalancing** — Moves funds to higher-yield strategies when thresholds are met
- **Safety guards** — Gas buffer, min spread checks, LTV alerts, dry-run mode
- **Performance tracking** — Logs every action to `config/performance.jsonl`
- **Runs autonomously** via cron (every 2 hours)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  MULTI-STRATEGY OPTIMIZER                │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  optimize-v2.ts  ←── Main entry point                    │
│    ├── scanner.ts        Rate scanning across markets    │
│    ├── portfolio.ts      Allocation tracking & drift     │
│    ├── kamino-client.ts  K-Lend deposits/withdrawals     │
│    ├── multiply-client.ts  Leveraged position mgmt       │
│    └── jupiter-client.ts   Token swaps (SOL↔USDC)       │
│                                                          │
│  Target Portfolio:                                       │
│    60% USDC (K-Lend, highest rate market)                │
│    30% JitoSOL<>SOL Multiply (5x leverage)               │
│    10% SOL gas reserve                                   │
│                                                          │
│  Safety:                                                 │
│    • Gas buffer: 0.01 SOL minimum                        │
│    • Multiply min spread: 1% (staking - borrow)          │
│    • LTV alert threshold: 85%                            │
│    • Rebalance min gain: 0.5% APY improvement            │
│    • Dry-run mode for testing                            │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
cd skills/kamino-yield
npm install
```

### 2. Generate Wallet (if new)

```bash
npx ts-node src/generate-wallet.ts
```

Creates `config/wallet.json`. Fund the generated address with SOL + USDC.

### 3. Scan Current Rates

```bash
npx ts-node src/scanner.ts
```

Shows live APYs across all Kamino markets, Multiply opportunities, and top picks.

### 4. Run Full Optimizer

```bash
npx ts-node src/optimize-v2.ts
```

Runs the complete multi-strategy optimization cycle. Respects `dryRun` setting.

### 5. Run Legacy Optimizer (K-Lend only)

```bash
npx ts-node src/optimize-cron.ts
```

Original single-strategy optimizer — still works, untouched.

## File Structure

```
kamino-yield/
├── config/
│   ├── wallet.json           # Solana keypair (KEEP SECRET)
│   ├── settings.json         # Full configuration
│   └── performance.jsonl     # Performance tracking log
├── src/
│   ├── optimize-v2.ts        # Multi-strategy optimizer (main)
│   ├── optimize-cron.ts      # Legacy single-strategy optimizer
│   ├── scanner.ts            # Rate scanner across all markets
│   ├── portfolio.ts          # Portfolio allocation manager
│   ├── kamino-client.ts      # Kamino K-Lend SDK wrapper
│   ├── multiply-client.ts    # Kamino Multiply position manager
│   ├── jupiter-client.ts     # Jupiter V6 swap integration
│   ├── generate-wallet.ts    # Wallet generation utility
│   └── types.ts              # TypeScript types & constants
├── scripts/
│   ├── optimize.sh           # Shell wrapper
│   ├── scan.sh               # Quick scan wrapper
│   └── status.sh             # Status check wrapper
├── package.json
├── tsconfig.json
├── SKILL.md
└── README.md
```

## Configuration

`config/settings.json`:

| Section | Field | Description | Default |
|---------|-------|-------------|---------|
| root | `rpcUrl` | Solana RPC endpoint | mainnet-beta |
| root | `dryRun` | Simulate without executing | `true` |
| root | `riskTolerance` | conservative/balanced/aggressive | `balanced` |
| portfolio | `targets` | Allocation targets by strategy | 60/30/10 |
| portfolio | `rebalanceThreshold` | Max drift before rebalancing | `0.10` (10%) |
| multiply | `maxLeverage` | Maximum leverage for Multiply | `5` |
| multiply | `minSpread` | Min staking-borrow spread | `0.01` (1%) |
| multiply | `maxLTV` | LTV alert threshold | `0.85` (85%) |
| jupiter | `slippageBps` | Max slippage in basis points | `50` (0.5%) |

## Strategies

### K-Lend (Simple Lending)
Deposits tokens into Kamino lending reserves. Scans Main, Jito, and Altcoins markets for the best rate per token. Auto-rebalances between markets when a better rate appears.

### Multiply (Leveraged Staking)
Opens JitoSOL<>SOL leveraged positions on Kamino's Jito isolated market. Earns amplified staking yield minus borrow costs. Only opens when spread is favorable (staking APY - borrow APY > min spread). Zero historical liquidations on LST<>SOL pairs due to stake-rate pricing.

### Jupiter Swaps
Converts between tokens to match target portfolio allocation. Uses Jupiter V6 API for best routing and price. Supports SOL↔USDC and SOL→JitoSOL.

## Safety Features

- **Gas buffer**: Always maintains 0.01 SOL for transaction fees
- **Min spread check**: Won't open Multiply positions if spread < 1%
- **LTV monitoring**: Logs warnings if Multiply LTV exceeds 85%
- **Dry-run mode**: Full simulation without real transactions (default: ON)
- **Rebalance threshold**: Only moves funds for >0.5% APY improvement
- **Retry logic**: Exponential backoff for RPC rate limits
- **Local signing**: Private keys never leave your server

## Example Scanner Output

```
══════════════════════════════════════════════════════
  📊 KAMINO RATE SCANNER
══════════════════════════════════════════════════════

Market: Main (84 reserves)
  🔥 SOL        Supply: 6.74%  Borrow: 8.46%
  ✨ USDC       Supply: 3.80%  Borrow: 5.52%
  ✨ USDT       Supply: 0.49%  Borrow: 2.31%

Market: Altcoins
  🔥 USDC       Supply: 5.04%  Borrow: 7.21%

Multiply Opportunities:
  JitoSOL<>SOL  Staking: 5.94%  Borrow: 7.66%
                Spread: -1.72% ❌ (min 1.00%)

Top Picks:
  1. SOL K-Lend (Main): 6.74% APY
  2. USDC K-Lend (Altcoins): 5.04% APY
  3. USDC K-Lend (Main): 3.80% APY
══════════════════════════════════════════════════════
```

## Cron Setup (Clawdbot)

Already configured as a cron job running every 2 hours:
```
Kamino yield optimizer (every 2h) — 30 */2 * * * Asia/Dubai
```

## Supported Tokens

- **SOL** — native Solana
- **USDC** — Circle USD stablecoin
- **USDT** — Tether USD
- **JitoSOL** — Jito liquid staking token
- **mSOL** — Marinade staked SOL

## Troubleshooting

### RPC Rate Limits
Public RPC rate limits aggressively. Use a private RPC (Helius, Triton) for reliability. Set in `config/settings.json`.

### Multiply Spread Negative
This is normal — borrow costs sometimes exceed staking yield. The optimizer correctly refuses to open positions. Wait for favorable conditions.

### Scanner Shows 0% APY
Some reserves have zero utilization. This is expected for less-popular tokens.

## License

MIT

## Credits

Built for autonomous agent capital management. Uses:
- [@kamino-finance/klend-sdk](https://github.com/Kamino-Finance/klend-sdk)
- [@kamino-finance/kliquidity-sdk](https://github.com/Kamino-Finance/kliquidity-sdk)
- [@solana/web3.js](https://github.com/solana-labs/solana-web3.js)
- [Jupiter V6 API](https://station.jup.ag/docs/apis/swap-api)
