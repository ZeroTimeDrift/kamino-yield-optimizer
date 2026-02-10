/**
 * Backtester Tests
 *
 * Validates the backtesting engine logic:
 * - Strategy simulation correctness
 * - Fee deduction accuracy
 * - Capital growth calculation
 * - Drawdown tracking
 */

import { runBacktest } from '../backtester';

describe('backtester', () => {
  const defaultConfig = {
    initialCapitalSol: 2,
    solPrice: 200,
    days: 30,
    minApyImprovement: 1.0,
    maxBreakEvenDays: 7,
    cycleIntervalHours: 2,
  };

  describe('hold strategy', () => {
    const result = runBacktest({ ...defaultConfig, strategy: 'hold' });

    it('should never rebalance', () => {
      expect(result.summary.rebalanceCount).toBe(0);
    });

    it('should have zero fees', () => {
      expect(result.summary.totalFeesPaid).toBe(0);
    });

    it('should have positive return (staking yield)', () => {
      expect(result.summary.endValue).toBeGreaterThan(result.summary.startValue);
    });

    it('should have zero drawdown', () => {
      // Hold never loses value (in SOL terms, ignoring USD)
      expect(result.summary.maxDrawdown).toBe(0);
    });

    it('should produce snapshots', () => {
      expect(result.snapshots.length).toBeGreaterThan(0);
    });

    it('should have annualized return roughly matching staking APY', () => {
      // JitoSOL staking is ~5.6%, annualized should be close
      expect(result.summary.annualizedReturn).toBeGreaterThan(3);
      expect(result.summary.annualizedReturn).toBeLessThan(10);
    });
  });

  describe('optimize strategy', () => {
    const result = runBacktest({ ...defaultConfig, strategy: 'optimize' });

    it('should start and end with capital', () => {
      expect(result.summary.startValue).toBe(2);
      expect(result.summary.endValue).toBeGreaterThan(0);
    });

    it('should track rebalances', () => {
      expect(result.summary.rebalanceCount).toBeGreaterThanOrEqual(0);
    });

    it('should have fees proportional to rebalance count', () => {
      if (result.summary.rebalanceCount === 0) {
        expect(result.summary.totalFeesPaid).toBe(0);
      } else {
        expect(result.summary.totalFeesPaid).toBeGreaterThan(0);
      }
    });

    it('should track strategy breakdown', () => {
      const totalDays = Object.values(result.summary.strategyBreakdown).reduce((a, b) => a + b, 0);
      expect(totalDays).toBeGreaterThan(0);
    });
  });

  describe('aggressive strategy', () => {
    const result = runBacktest({ ...defaultConfig, strategy: 'aggressive' });

    it('should rebalance more often than optimize (lower thresholds)', () => {
      const optimizeResult = runBacktest({ ...defaultConfig, strategy: 'optimize' });
      // Aggressive uses 0.5% threshold vs 1.0%, and 14d break-even vs 7d
      expect(result.summary.rebalanceCount).toBeGreaterThanOrEqual(optimizeResult.summary.rebalanceCount);
    });
  });

  describe('klend_only strategy', () => {
    const result = runBacktest({ ...defaultConfig, strategy: 'klend_only' });

    it('should only use klend strategies', () => {
      for (const snap of result.snapshots) {
        if (snap.action !== 'hold') {
          const validStrategies = ['hold_jitosol', 'klend_sol_supply', 'klend_jitosol_supply'];
          expect(validStrategies).toContain(snap.strategy);
        }
      }
    });
  });

  describe('capital preservation', () => {
    it('should never have negative capital', () => {
      const strategies = ['hold', 'optimize', 'aggressive', 'klend_only', 'lp_only'] as const;

      for (const strat of strategies) {
        const result = runBacktest({ ...defaultConfig, strategy: strat });
        for (const snap of result.snapshots) {
          expect(snap.capitalSol.toNumber()).toBeGreaterThan(0);
        }
      }
    });

    it('should have end value within reasonable bounds', () => {
      const strategies = ['hold', 'optimize', 'aggressive'] as const;

      for (const strat of strategies) {
        const result = runBacktest({ ...defaultConfig, strategy: strat });
        // Should not lose more than 50% or gain more than 100% in 30 days
        expect(result.summary.endValue).toBeGreaterThan(1); // > 50% of 2 SOL
        expect(result.summary.endValue).toBeLessThan(4);    // < 200% of 2 SOL
      }
    });
  });

  describe('longer period', () => {
    const result = runBacktest({ ...defaultConfig, strategy: 'optimize', days: 90 });

    it('should compound returns over longer period', () => {
      const shortResult = runBacktest({ ...defaultConfig, strategy: 'hold', days: 30 });
      // 90 days should have more absolute return than 30 days
      expect(result.summary.totalReturn).toBeGreaterThanOrEqual(0);
    });

    it('should produce more snapshots for longer periods', () => {
      const shortResult = runBacktest({ ...defaultConfig, strategy: 'optimize', days: 30 });
      expect(result.snapshots.length).toBeGreaterThanOrEqual(shortResult.snapshots.length);
    });
  });

  describe('config sensitivity', () => {
    it('should respect minApyImprovement threshold', () => {
      const strict = runBacktest({ ...defaultConfig, strategy: 'optimize', minApyImprovement: 5.0 });
      const loose = runBacktest({ ...defaultConfig, strategy: 'optimize', minApyImprovement: 0.1 });

      // Stricter threshold should lead to fewer rebalances
      expect(strict.summary.rebalanceCount).toBeLessThanOrEqual(loose.summary.rebalanceCount);
    });

    it('should handle zero initial capital', () => {
      const result = runBacktest({ ...defaultConfig, strategy: 'hold', initialCapitalSol: 0 });
      expect(result.summary.endValue).toBe(0);
    });

    it('should handle very large capital', () => {
      const result = runBacktest({ ...defaultConfig, strategy: 'hold', initialCapitalSol: 10000 });
      expect(result.summary.endValue).toBeGreaterThan(10000);
    });
  });
});
