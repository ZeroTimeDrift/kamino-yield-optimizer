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

### Option D: Kamino Liquidity Vaults (SOL/JitoSOL LP)
- Would add ~5-15% from market-making fees
- BUT: requires depositing into Kamino smart contracts
- Impermanent loss risk is low (correlated assets) but non-zero
- Would need to implement kliquidity-sdk deposit logic
- **Action: EVALUATE LATER** — may be worth building for the additional 5-10%

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

## 8. Technical Notes

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
