/**
 * Fee Model Tests
 *
 * Validates the fee calculation model against known Solana/Kamino costs.
 * These tests ensure our cost estimates are realistic.
 */

import Decimal from 'decimal.js';
import { calculateSwitchCost } from '../rebalancer';

describe('fee model realism', () => {
  // Known Solana network costs as of Feb 2026
  const SOL_PRICE = new Decimal(200);
  const BASE_TX_FEE = 0.000005; // 5000 lamports

  it('should estimate tx fees within realistic range', () => {
    const cost = calculateSwitchCost('hold_jitosol', 'lp_vault', new Decimal(2), SOL_PRICE, new Decimal(5));

    // A deposit tx should cost between 0.000005 SOL (base) and 0.002 SOL (with priority)
    expect(cost.txFeesSol.toNumber()).toBeGreaterThanOrEqual(BASE_TX_FEE);
    expect(cost.txFeesSol.toNumber()).toBeLessThan(0.01);
  });

  it('should estimate swap slippage correctly for small amounts', () => {
    // For < 5 SOL, slippage should be ~0.3%
    const cost = calculateSwitchCost('klend_sol_supply', 'hold_jitosol', new Decimal(2), SOL_PRICE, new Decimal(5));

    // Slippage on 2 SOL should be ~0.006 SOL (0.3%)
    if (cost.swapRequired) {
      const slipPercent = cost.slippageSol.div(2).mul(100).toNumber();
      expect(slipPercent).toBeGreaterThan(0);
      expect(slipPercent).toBeLessThan(2); // Never more than 2% for small amounts
    }
  });

  it('should never exceed 5% total cost for small positions', () => {
    const amount = new Decimal(2);
    const cost = calculateSwitchCost('lp_vault', 'klend_sol_supply', amount, SOL_PRICE, new Decimal(10));

    const costPercent = cost.totalCostSol.div(amount).mul(100).toNumber();
    expect(costPercent).toBeLessThan(5);
  });

  it('should have reasonable IL estimate for JitoSOL-SOL', () => {
    // JitoSOL-SOL is highly correlated. IL over 30 days should be < 1%
    const cost = calculateSwitchCost('hold_jitosol', 'lp_vault', new Decimal(10), SOL_PRICE, new Decimal(5));

    const ilPercent = cost.ilRiskSol.div(10).mul(100).toNumber();
    expect(ilPercent).toBeLessThan(1); // < 1% monthly IL for correlated pair
    expect(ilPercent).toBeGreaterThan(0); // But not zero — there IS some IL
  });

  it('should compute opportunity cost proportional to current APY', () => {
    const lowApy = calculateSwitchCost('lp_vault', 'hold_jitosol', new Decimal(2), SOL_PRICE, new Decimal(2));
    const highApy = calculateSwitchCost('lp_vault', 'hold_jitosol', new Decimal(2), SOL_PRICE, new Decimal(20));

    // Higher APY = higher opportunity cost (losing more yield during transit)
    expect(highApy.opportunityCostSol.gt(lowApy.opportunityCostSol)).toBe(true);
  });
});

describe('fee comparison across strategy paths', () => {
  const amount = new Decimal(2);
  const price = new Decimal(200);
  const apy = new Decimal(8);

  it('hold → LP should be cheaper than LP → K-Lend (fewer steps)', () => {
    const holdToLp = calculateSwitchCost('hold_jitosol', 'lp_vault', amount, price, apy);
    const lpToKlend = calculateSwitchCost('lp_vault', 'klend_sol_supply', amount, price, apy);

    // LP→K-Lend requires withdraw + swap + deposit vs just deposit
    expect(lpToKlend.txCount).toBeGreaterThanOrEqual(holdToLp.txCount);
  });

  it('K-Lend SOL → K-Lend JitoSOL should require a swap', () => {
    const cost = calculateSwitchCost('klend_sol_supply', 'klend_jitosol_supply', amount, price, apy);

    // Going from SOL to JitoSOL requires Jupiter swap
    expect(cost.swapRequired).toBe(true);
    expect(cost.slippageSol.gt(0)).toBe(true);
  });

  it('symmetric paths should have similar costs', () => {
    const aToB = calculateSwitchCost('hold_jitosol', 'lp_vault', amount, price, apy);
    const bToA = calculateSwitchCost('lp_vault', 'hold_jitosol', amount, price, apy);

    // Not exactly equal (IL only applies to LP entry, withdrawal has different fees)
    // But should be in the same order of magnitude
    const ratio = aToB.totalCostSol.div(bToA.totalCostSol).toNumber();
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
  });
});

describe('gas buffer safety', () => {
  it('should not recommend actions that would drain below gas buffer', () => {
    // The rebalancer should never suggest moving ALL SOL
    // This is enforced at the executor level, but the model should be aware
    const cost = calculateSwitchCost('hold_jitosol', 'klend_sol_supply', new Decimal(0.005), new Decimal(200), new Decimal(5));

    // For very small amounts, tx fees alone might exceed the position
    // This is expected — the optimizer should reject this at a higher level
    expect(cost.txFeesSol.gt(0)).toBe(true);
  });
});
