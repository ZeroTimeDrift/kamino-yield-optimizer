# Kamino Yield Research — JitoSOL Strategy
**Updated:** 2026-02-06T17:10Z (live data)
**Wallet:** `7u5ovFNms7oE232TTyMU5TxDfyZTJctihH4YqP2n1EUz`
**Holdings:** 1.999 JitoSOL (~$400) + 0.005 SOL (gas)

---

## 1. Current Rates (Live Data — Per Market)

### JitoSOL Staking Yield
| Metric | Value | Source |
|--------|-------|--------|
| **Live APY** | **5.57%** | Jito API (`kobe.mainnet.jito.network`) |
| 7-day avg APY | 5.83% | Jito API |
| Pool token value | 1.260 SOL | SolanaCompass |
| Total SOL staked | 13.7M SOL | Jito API |
| Previous hardcoded | 7.00% | ❌ Was 25% too high! |

### SOL Borrow Rates Per Market
| Market | Address | SOL Borrow Rate | JitoSOL Available | Notes |
|--------|---------|-----------------|-------------------|-------|
| **Main** | `7u3HeHxY...` | **12.47%** | Yes (0.7% util) | Best for Multiply (lower borrow) |
| **Jito** | `DxXdAyU3...` | **13.31%** | No | Isolated market, higher borrow |
| **Altcoins** | `ByYiZxp8...` | 0.00% | No | No SOL reserve |

> **Key finding:** The Jito isolated market has a HIGHER SOL borrow rate (13.31%) than Main market (12.47%), contrary to our initial assumption that JTO incentives and eMode would make it cheaper. The Jito market doesn't even have a JitoSOL reserve — it's primarily for stablecoins and JLP.

### Top K-Lend Supply Rates
| Token | Supply APY | Borrow APY | Utilization | Market |
|-------|-----------|-----------|------------|--------|
| SOL | 9.78% | 12.47% | 93.4% | Main |
| USDG | 6.37% | 8.15% | 95.2% | Main |
| CASH | 5.67% | 7.32% | 95.2% | Main |
| USDC | 5.24% | 12.60% | 53.8% | Altcoins |
| USDC | 3.91% | 5.43% | 91.5% | Main |
| USDC | 3.57% | 4.45% | 89.5% | Jito |
| JitoSOL | 0.00% | 1.32% | 0.7% | Main |

---

## 2. Multiply Spread Analysis (Per Market)

### JitoSOL<>SOL Multiply
| Metric | Main Market | Jito Market |
|--------|-------------|-------------|
| Staking yield | 5.57% | 5.57% |
| SOL borrow cost | 12.47% | 13.31% |
| **Spread** | **-6.90%** | **-7.74%** |
| Net APY @ 2x | -1.33% | -2.17% |
| Net APY @ 3x | -8.23% | -9.92% |
| Net APY @ 5x | -22.04% | -25.41% |
| Max LTV | 85% | 90% |

### Why Multiply Doesn't Work Right Now
- **SOL utilization is 93.4%** in Main market — nearly all supplied SOL is being borrowed
- This drives borrow rates to 12.47%, far above the 5.57% JitoSOL staking yield
- Even at 2x leverage (minimal), you'd lose -1.33% per year
- **Break-even point:** SOL borrow rate needs to drop below **5.57%** for positive spread, and below **~4.6%** for a worthwhile 1% minimum spread
- SOL utilization would need to drop to roughly ~70% for borrow rates to enter profitable territory

### Historical Context
- SOL borrow rates are cyclically high during bull markets (high demand for leverage)
- In quieter market conditions, SOL borrow often drops to 3-6%
- When rates normalize, Multiply at 3-5x leverage on Jito market (90% LTV) becomes very attractive

---

## 3. Strategy Analysis

### Option A: JitoSOL Multiply — ❌ NOT PROFITABLE
- Spread: -6.90% (Main) to -7.74% (Jito)
- Would lose money at ALL leverage levels
- **Action: DO NOT DEPLOY**

### Option B: K-Lend JitoSOL Supply — ❌ WORTHLESS
- Supply APY: 0.00% (nobody borrows JitoSOL)
- Adds smart contract risk for zero additional yield
- **Action: DO NOT DEPLOY**

### Option C: Hold JitoSOL in Wallet — ✅ BEST OPTION
- Earns 5.57% staking APY passively via JitoSOL appreciation
- Zero smart contract risk beyond Jito stake pool
- Zero liquidation risk
- Full liquidity — can deploy instantly when conditions improve
- **Action: HOLD**

### Option D: Kamino Liquidity Vaults (SOL/JitoSOL LP) — ✅ IMPLEMENTED
- Best vault: SOL-JitoSOL on Orca CLMM — **9.64% APY** (TVL: $7.5M)
- JitoSOL-SOL vault: $3.3M TVL, currently out of range (0% APY)
- Impermanent loss risk is low (highly correlated assets, tight pegged range)
- Single-sided deposit supported — can deposit JitoSOL only (SDK swaps internally)
- **Integration:** `src/liquidity-client.ts` — uses `@kamino-finance/kliquidity-sdk`
- **Action: READY TO DEPLOY** — depositing JitoSOL into the best vault adds ~4% yield over holding
- The combined yield would be: 5.57% (staking) + ~4% (LP fees) = ~9.6% total

#### Live Vault Data (2026-02-06)
| Vault | Address | APY | TVL | Range | Status |
|-------|---------|-----|-----|-------|--------|
| SOL-JitoSOL LP | `HCntzqDU...` | 9.64% | $7.5M | 0.7938-0.7956 | IN RANGE ✅ |
| SOL-JitoSOL LP | `5QgwaBQz...` | 0.00% | $1.6M | — | OUT OF RANGE ⚠️ |
| JitoSOL-SOL LP | `4Zuhh9SD...` | 0.00% | $3.3M | — | OUT OF RANGE ⚠️ |
| JitoSOL-SOL LP | `GrsqRMeK...` | 0.00% | $10 | — | OUT OF RANGE ⚠️ |
| JitoSOL-SOL LP | `EDn9rayn...` | 0.00% | $0 | — | OUT OF RANGE ⚠️ |

#### Key Insights
- Only 1 of 5 JitoSOL-SOL vaults is currently in range and earning
- The in-range vault (HCntzqDU...) has the most TVL ($7.5M) — Kamino actively manages its position
- Out-of-range vaults earn 0% APY until rebalanced
- Fee APY (9.64%) comes from market-making on concentrated liquidity — no rewards/incentives
- The vault is on Orca CLMM with a very tight range (0.7938-0.7956), maximizing fee capture

---

## 4. Capital Deployment Decision

### Decision: **HOLD — Do Not Deploy**

**Reasoning:**
1. Multiply spread is deeply negative (-6.90% best case)
2. K-Lend JitoSOL supply yields 0%
3. Holding JitoSOL still earns 5.57% passively from staking
4. On $400 portfolio, the 5.57% yields ~$22/year — deploying into negative-spread Multiply would REDUCE this
5. Smart contract risk is not justified for zero or negative additional yield
6. We preserve full liquidity to deploy when conditions improve

### What Was NOT Deployed
| Asset | Amount | Reason |
|-------|--------|--------|
| 1.999 JitoSOL | ~$400 | Multiply spread negative in all markets |
| 0.005 SOL | ~$1 | Gas reserve — untouched |

### Current Positions
| Asset | Location | Amount | Earning |
|-------|----------|--------|---------|
| JitoSOL | Wallet | 1.999 | 5.57% staking APY |
| SOL | Wallet | 0.005 | Gas reserve |
| K-Lend | None | 0 | — |
| Multiply | None | 0 | — |

---

## 5. What Changed in This Update

### Scanner Improvements (v2)
1. **Per-market SOL borrow rates** — now shows Main (12.47%), Jito (13.31%), Altcoins (N/A) separately
2. **Per-market Multiply spreads** — calculates opportunities for each market independently
3. **Live JitoSOL staking APY** — fetched from Jito API (`kobe.mainnet.jito.network/api/v1/stake_pool_stats`)
   - Was hardcoded at 7.0%, actual is 5.57% — a 25% overestimate!
   - Falls back to 5.94% (SolanaCompass) if API fails
4. **Strategy recommendation** — automated profitable/unprofitable assessment
5. **mSOL<>SOL** multiply also tracked with estimated staking yield

### Key Data Corrections
| Metric | Old (Hardcoded) | New (Live) | Difference |
|--------|-----------------|------------|------------|
| JitoSOL staking APY | 7.00% | 5.57% | -1.43% |
| SOL borrow (Main) | 12.49% | 12.47% | -0.02% |
| SOL borrow (Jito) | 13.31% | 13.31% | Same |
| Multiply spread (Main) | -5.49% | -6.90% | -1.41% worse |
| Multiply spread (Jito) | not tracked | -7.74% | New |

---

## 6. Risk Assessment

### Holding JitoSOL (Current Strategy)
| Risk | Level | Mitigation |
|------|-------|------------|
| JitoSOL de-peg | Low | Liquid staking is well-tested, $13.7M TVL |
| Jito stake pool exploit | Very Low | Audited, SPL stake pool program |
| SOL price decline | Medium | Inherent market risk, not yield-related |
| Opportunity cost | Low | 5.57% is reasonable for passive yield |

### If We Had Deployed Multiply
| Risk | Level | Impact |
|------|-------|--------|
| Negative spread | **CERTAIN** | -6.90% drag on returns |
| Liquidation at high leverage | Medium | LTV approaching limits in volatile markets |
| Smart contract risk | Medium | Additional Kamino lending protocol exposure |
| Gas costs for loops | Low | Multiple transactions for leveraging |

---

## 7. Monitoring & Triggers

### When to Re-evaluate
- **SOL borrow rate drops below 5%** → Multiply becomes potentially profitable
- **SOL utilization drops below 75%** → Rates likely dropping
- **JitoSOL staking APY rises above 7%** → Wider spread possible
- **New Kamino vaults launch** → Check for JitoSOL-specific vaults

### Scanner Cron
The scanner can be run periodically to check conditions:
```bash
cd /root/clawd/skills/kamino-yield
npx ts-node src/scanner.ts
```

### Rate Targets for Deployment
| Scenario | SOL Borrow | Staking APY | Spread | Action |
|----------|-----------|-------------|--------|--------|
| Current | 12.47% | 5.57% | -6.90% | HOLD |
| Break-even | 5.57% | 5.57% | 0.00% | HOLD |
| Minimum viable | <4.6% | >5.5% | >1.0% | Deploy 2x |
| Good conditions | <3.0% | >6.0% | >3.0% | Deploy 3-5x |

---

## 8. Liquidity Vault Integration (NEW)

### SDK Used
`@kamino-finance/kliquidity-sdk` v8.5.9 (already in package.json)

### File: `src/liquidity-client.ts`
Complete client for Kamino Liquidity vaults with:
1. **`listJitoSolVaults()`** — Lists 5 known JitoSOL-SOL vaults with APY, TVL, range, share price
2. **`getVaultDetails(address)`** — Full details for any vault (APY, TVL, range, token composition)
3. **`getUserPositions(wallet)`** — Checks wallet for active LP positions with value and APY
4. **`deposit(wallet, strategy, amountA, amountB, dryRun)`** — Dual-sided deposit
5. **`singleSidedDepositA/B(wallet, strategy, amount, slippage, dryRun)`** — Single-sided deposit with internal swap
6. **`withdraw(wallet, strategy, shares, dryRun)`** — Withdraw specific amount of shares
7. **`withdrawAll(wallet, strategy, dryRun)`** — Withdraw all shares

### Integration Points
- **`src/portfolio.ts`** — Updated to track LP positions alongside K-Lend and Multiply
  - `PortfolioSnapshot` now includes `liquidityPositions` array
  - LP value included in total portfolio value and blended APY
  - New `LP_VAULT` strategy type in allocations
- **`src/optimize-v2.ts`** — Updated to scan LP vaults during optimization runs
  - Scans JitoSOL-SOL vaults for APY comparison
  - Shows active LP positions in monitoring
  - Includes LP value in performance logging

### Dry-Run Testing Results
- ✅ Vault listing works — fetches 5 vaults in ~30s
- ✅ APY/TVL/range data correct for in-range vaults
- ✅ Single-sided deposit dry-run successful
- ✅ Withdraw dry-run successful with share value estimation
- ✅ Position tracking returns empty (correct — no deposits yet)
- ✅ `dryRun` flag from settings.json is respected

### How Deposits Work
1. SDK fetches on-chain strategy state (token ratios, pool price, position range)
2. For single-sided: SDK calculates optimal swap via KSwap/Jupiter
3. Creates deposit instruction with proper token amounts
4. Transaction includes ATA creation if needed
5. Shares (kTokens) minted to depositor's wallet

### Risk Considerations for LP Vaults
| Risk | Level | Notes |
|------|-------|-------|
| Smart contract | Low-Medium | Kamino is audited, $2B+ TVL |
| Impermanent loss | Very Low | JitoSOL-SOL are highly correlated |
| Out-of-range | Medium | Vault may go out of range, earning 0% until rebalanced |
| Withdrawal fees | Low | ~0.1% typical |
| Concentration risk | Medium | Tight range means high fee capture but higher IL if de-peg |

---

## 9. Technical Notes

### Jito API Endpoint
```
GET https://kobe.mainnet.jito.network/api/v1/stake_pool_stats
```
Returns JSON with `apy` array of `{data: float, date: string}` entries.
APY values are decimals (e.g., 0.0557 = 5.57%).

### Kamino Market Addresses
| Market | Address | Purpose |
|--------|---------|---------|
| Main | `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` | Primary lending, most assets |
| Jito | `DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek` | Jito isolated market (stables, JLP) |
| Altcoins | `ByYiZxp8QrdN9qbdtaAiePN8AAr3qvTPppNJDpf5DVJ5` | Memecoins, altcoins |

### Important Discovery
The Jito market does NOT contain a JitoSOL reserve. It has: USDC, USDG, USD1, PYUSD, USDT, JLP, SOL.
JitoSOL Multiply positions use the Main market for JitoSOL collateral. The "Jito market" name is misleading — it's an isolated market for Jito-related products but the SOL borrow there is actually more expensive.
