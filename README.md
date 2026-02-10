# 🔥 Kamino Yield Optimizer

**Autonomous AI-powered DeFi yield optimizer for Solana.** Manages capital across Kamino K-Lend, Multiply vaults, LP positions, and Jupiter swaps to maximize risk-adjusted returns with full fee accounting.

> Built by an autonomous AI agent (Prometheus/ClawdBot) that manages real DeFi positions on Solana mainnet.

## ✨ What Makes This Different

Most yield optimizers are simple rate-chasers. This one is different:

1. **Full Fee Accounting** — Every rebalance decision considers tx fees, slippage, IL risk, swap costs, withdrawal fees, deposit fees, opportunity cost, and break-even time. No decision is made unless it's profitable after ALL costs.

2. **Spike Protection** — Won't chase APY spikes. Yield must sustain above current position for >1 hour before the optimizer acts.

3. **Multi-Strategy Decision Engine** — Compares 5 strategies simultaneously:
   - Hold JitoSOL (baseline ~5.6% staking yield)
   - K-Lend supply (SOL or JitoSOL, best market)
   - Multiply (leveraged staking, only when spread > 1%)
   - LP vaults (concentrated liquidity, JitoSOL-SOL)
   - Cross-protocol opportunities (Marginfi, Drift, Meteora via DeFi Llama)

4. **Real Money** — This runs on mainnet with real capital. Not a simulation. Every feature was built because the agent needed it to manage actual DeFi positions.

5. **AI Agent Native** — Designed for autonomous agents. Clean CLI, JSON output mode, continuous agent mode, and integration with the ClawdBot agent framework.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   AUTONOMOUS AGENT LAYER                    │
│  ┌───────────┐  ┌────────────┐  ┌──────────────────────┐   │
│  │  Scanner   │  │ Portfolio   │  │   Rebalancer          │   │
│  │ (live      │  │ (multi-     │  │ (fee-aware decision   │   │
│  │  rates)    │  │  strategy)  │  │  engine + execution)  │   │
│  └─────┬─────┘  └──────┬─────┘  └──────────┬───────────┘   │
│        │               │                    │               │
│  ┌─────┴───────────────┴────────────────────┴───────────┐   │
│  │              Strategy Executor                        │   │
│  ├──────────┬──────────────┬───────────┬───────────────┤   │
│  │ K-Lend   │  Multiply    │ LP Vaults │  Cross-Proto  │   │
│  │ (supply/ │ (leveraged   │ (conc.    │ (DeFi Llama   │   │
│  │  borrow) │  staking)    │  liq.)    │  comparison)  │   │
│  └──────────┴──────────────┴───────────┴───────────────┘   │
│        │                                                    │
│  ┌─────┴───────────────────────────────────────────────┐    │
│  │     Jupiter V6 API (routing + swaps)                │    │
│  └─────────────────────┬───────────────────────────────┘    │
│                        │                                    │
│  ┌─────────────────────┴───────────────────────────────┐    │
│  │     Solana Blockchain (mainnet-beta)                │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/ZeroTimeDrift/kamino-yield-optimizer.git
cd kamino-yield-optimizer
npm install
```

### 2. Setup Wallet

```bash
npx ts-node src/generate-wallet.ts
# Creates config/wallet.json — fund this address with SOL
```

### 3. Scan Rates

```bash
npx ts-node src/index.ts scan
```

### 4. Run Optimizer (dry-run by default)

```bash
npx ts-node src/index.ts optimize          # Dry run
npx ts-node src/index.ts optimize --live   # Real transactions
```

### 5. Run Tests

```bash
npm test
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `scan` | Scan live rates across all Kamino markets + cross-protocol |
| `optimize` | Run full multi-strategy optimization cycle |
| `rebalance` | Evaluate positions & execute rebalance decisions |
| `portfolio` | Show current portfolio snapshot with allocations |
| `status` | Quick wallet balance & position overview |
| `backtest` | Historical performance analysis with strategy comparison |
| `agent` | Run in autonomous mode (continuous 30min cycles) |

### Options

| Flag | Description |
|------|-------------|
| `--dry-run` | Simulate without executing (default) |
| `--live` | Execute real on-chain transactions |
| `--json` | Output structured JSON for programmatic use |
| `--verbose` | Show detailed execution logs |

## The Decision Engine

The rebalancer is the brain. Here's how it thinks:

### Fee Model (All Costs Accounted)

```
Total Switch Cost = tx_fees + withdrawal_fee + deposit_fee
                  + slippage + jupiter_fee + IL_risk + opportunity_cost
```

| Cost Component | Source | Estimate |
|----------------|--------|----------|
| TX fees | Solana network | 0.000005-0.0005 SOL/tx |
| Withdrawal fee | Kamino LP | ~0.1% of position |
| Deposit fee | Kamino LP | ~0.05% (internal swap) |
| Slippage | Jupiter swap | 0.3-1.0% (size-dependent) |
| Jupiter fee | Platform | ~0.1% |
| IL risk | LP vault | ~0.1% / 30 days (JitoSOL-SOL) |
| Opportunity cost | Transit time | ~5 min of current yield |

### Decision Criteria (ALL must pass)

1. **Break-even < 7 days** — Switch cost must be recovered within a week
2. **Net improvement > 1% APY** — After all fees, the new strategy must beat current by 1%+
3. **Sustained yield** — New strategy must maintain higher yield for >1 hour (no spike chasing)

### Scoring Formula

```
Score = Net_APY - (Switch_Cost / Capital × 100 × 365/30)
```

The score represents the 30-day adjusted APY, accounting for entry costs.

## Strategies

### Hold JitoSOL (~5.6% APY)
The baseline. Zero cost, zero risk beyond SOL price exposure. JitoSOL earns native Jito staking yield automatically.

### K-Lend Supply (variable APY)
Deposit tokens into Kamino lending reserves. Scans Main, Jito, and Altcoins markets. JitoSOL supply is interesting because you STACK K-Lend yield on top of staking yield.

### Multiply (leveraged staking)
Opens JitoSOL↔SOL leveraged positions. Only when staking APY > borrow cost + 1% minimum spread. Zero historical liquidations on LST↔SOL pairs (stake-rate pricing). Currently often unprofitable due to high SOL borrow rates.

### LP Vaults (concentrated liquidity)
Kamino-managed concentrated liquidity positions (JitoSOL-SOL). Higher yield from trading fees but with IL risk. Our model estimates IL at ~0.1%/month for correlated pairs.

### Cross-Protocol (read-only comparison)
Scans yields from Marginfi, Drift, Solend, Meteora, Orca, Raydium via DeFi Llama API. Currently informational only — cross-protocol execution planned.

## Backtesting

Run strategy comparisons against historical or synthetic yield data:

```bash
npx ts-node src/backtester.ts --days 90
```

Compares: hold vs optimizer vs aggressive vs klend_only vs lp_only. Shows returns, drawdown, fees, and alpha over passive holding.

## Safety Features

| Feature | Description |
|---------|-------------|
| 🔒 Dry-run default | No real transactions without `--live` flag |
| ⛽ Gas buffer | Always maintains 0.01 SOL minimum for fees |
| 📊 Break-even check | Rejects switches with payback > 7 days |
| ⏰ Spike protection | Requires sustained yield improvement (>1hr) |
| 📉 LTV monitoring | Alerts when Multiply LTV exceeds 85% |
| 🔁 Retry logic | Exponential backoff for RPC rate limits |
| 🔐 Local signing | Private keys never leave the server |
| 📝 Decision logging | Every decision logged with full reasoning |

## File Structure

```
kamino-yield-optimizer/
├── src/
│   ├── index.ts              # CLI entry point (all commands)
│   ├── scanner.ts            # Multi-market rate scanner
│   ├── rebalancer.ts         # Fee-aware decision engine (1200+ lines)
│   ├── optimize-v2.ts        # Multi-strategy optimizer
│   ├── portfolio.ts          # Portfolio allocation manager
│   ├── backtester.ts         # Historical strategy backtesting
│   ├── kamino-client.ts      # Kamino K-Lend SDK wrapper
│   ├── multiply-client.ts    # Leveraged staking manager
│   ├── liquidity-client.ts   # LP vault operations
│   ├── jupiter-client.ts     # Jupiter V6 swap integration
│   ├── multi-protocol-scanner.ts # Cross-protocol yield scanner
│   ├── types.ts              # TypeScript types & constants
│   └── __tests__/
│       ├── rebalancer.test.ts  # Decision engine tests
│       └── fee-model.test.ts   # Fee calculation tests
├── config/
│   ├── settings.json         # Configuration
│   ├── wallet.json           # Solana keypair (gitignored)
│   ├── performance.jsonl     # Performance tracking log
│   ├── rebalancer-log.jsonl  # Decision audit trail
│   └── rate-history.json     # Historical rate data
├── jest.config.js
├── tsconfig.json
├── package.json
└── README.md
```

## Configuration

`config/settings.json`:

```json
{
  "rpcUrl": "https://api.mainnet-beta.solana.com",
  "dryRun": true,
  "riskTolerance": "balanced",
  "minYieldImprovement": 0.5,
  "gasBufferSol": 0.01,
  "portfolio": {
    "allocations": {
      "klendUsdc": 0.60,
      "multiply": 0.30,
      "gasReserve": 0.10
    },
    "rebalanceThreshold": 0.10
  },
  "multiply": {
    "maxLeverage": 5,
    "minSpread": 1.0,
    "maxLtv": 0.85
  },
  "jupiter": {
    "slippageBps": 50,
    "preferDirect": true
  }
}
```

## Tech Stack

- **Runtime:** Node.js / TypeScript
- **Blockchain:** Solana (web3.js + @solana/kit)
- **DeFi SDKs:** @kamino-finance/klend-sdk, @kamino-finance/kliquidity-sdk
- **Swaps:** Jupiter V6 API
- **Data:** CoinGecko (prices), Jito API (staking APY), DeFi Llama (cross-protocol)
- **Testing:** Jest + ts-jest
- **Agent Framework:** ClawdBot (optional, for autonomous operation)

## How the AI Agent Uses This

This optimizer was built by and for an AI agent (Prometheus). In production:

1. **Cron mode** — Runs every 2 hours via ClawdBot cron
2. **Agent decisions** — The AI agent reviews optimizer output and can override or adjust
3. **Learning** — Decision logs feed back into the agent's memory for strategy refinement
4. **Reporting** — Agent reports significant events to the human operator

The human operator (Hevar) granted full DeFi autonomy: *"Make these decisions yourself."*

## Performance

With ~$216 in capital (1.867 JitoSOL):
- **Current yield:** ~5.6% APY (passive JitoSOL staking)
- **Infrastructure cost:** ~$0/month (runs on existing server)
- **Decision quality:** Fee model correctly avoids unprofitable rebalances
- **Uptime:** Monitored via cron, auto-recovers from RPC failures

## License

MIT

## Credits

Built with:
- [@kamino-finance/klend-sdk](https://github.com/Kamino-Finance/klend-sdk)
- [@kamino-finance/kliquidity-sdk](https://github.com/Kamino-Finance/kliquidity-sdk)
- [Jupiter V6 API](https://station.jup.ag/docs/apis/swap-api)
- [DeFi Llama API](https://defillama.com/docs/api)
