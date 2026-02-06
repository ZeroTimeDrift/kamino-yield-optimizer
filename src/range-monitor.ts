/**
 * Out-of-Range Monitor
 *
 * Monitors Kamino LP vault positions to ensure they stay in range.
 * 4 of 5 JITOSOL-SOL LP vaults are currently out of range earning 0%.
 * If our vault goes out of range, we need to pull out immediately.
 *
 * CONSERVATIVE WITH RPC: Uses LiquidityClient.getVaultDetails() which
 * fetches strategy data + APR/APY in batched SDK calls.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { LiquidityClient, LiquidityVaultInfo, JITOSOL_SOL_STRATEGIES } from './liquidity-client';
import { Settings } from './types';

// ─── Types ──────────────────────────────────────────────────────

export interface PositionRange {
  inRange: boolean;
  poolPrice: Decimal;
  lower: Decimal;
  upper: Decimal;
  /** Positive = inside range (% to nearest edge). Negative = outside. */
  distanceToBoundaryPercent: Decimal;
  strategyAddress: string;
  tokenPair: string;
  currentApy: Decimal;
}

export interface RangeAlert {
  type: 'OUT_OF_RANGE' | 'NEAR_BOUNDARY' | 'BACK_IN_RANGE';
  strategyAddress: string;
  range: PositionRange;
  message: string;
  timestamp: string;
  actionRequired: boolean;
}

// ─── Config ─────────────────────────────────────────────────────

const ALERTS_FILE = path.join(__dirname, '..', 'config', 'alerts.jsonl');
const NEAR_BOUNDARY_THRESHOLD = 3; // Alert when <3% from edge

// ─── Main class ─────────────────────────────────────────────────

export class RangeMonitor {
  private liquidityClient: LiquidityClient;
  private wallet: Keypair;

  constructor(rpcUrl: string, wallet: Keypair) {
    this.liquidityClient = new LiquidityClient(rpcUrl);
    this.wallet = wallet;
  }

  /**
   * Check if a specific strategy is in range.
   * Makes ~3 RPC calls via Kamino SDK (strategy + shareData + aprApy).
   */
  async checkPositionRange(strategyAddress: string): Promise<PositionRange> {
    const vaultInfo = await this.liquidityClient.getVaultDetails(strategyAddress);

    if (!vaultInfo) {
      return {
        inRange: false,
        poolPrice: new Decimal(0),
        lower: new Decimal(0),
        upper: new Decimal(0),
        distanceToBoundaryPercent: new Decimal(-100),
        strategyAddress,
        tokenPair: 'Unknown',
        currentApy: new Decimal(0),
      };
    }

    const { poolPrice, priceLower, priceUpper, outOfRange, totalApy } = vaultInfo;

    let distanceToBoundary = new Decimal(0);
    if (poolPrice.gt(0) && priceLower.gt(0) && priceUpper.gt(0)) {
      if (!outOfRange) {
        // Distance to nearest boundary
        const toLower = poolPrice.minus(priceLower).div(priceLower).mul(100);
        const toUpper = priceUpper.minus(poolPrice).div(priceUpper).mul(100);
        distanceToBoundary = Decimal.min(toLower.abs(), toUpper.abs());
      } else {
        // Outside: negative distance
        const belowLower = priceLower.minus(poolPrice).div(priceLower).mul(100);
        const aboveUpper = poolPrice.minus(priceUpper).div(priceUpper).mul(100);
        distanceToBoundary = Decimal.min(belowLower.abs(), aboveUpper.abs()).neg();
      }
    }

    return {
      inRange: !outOfRange,
      poolPrice,
      lower: priceLower,
      upper: priceUpper,
      distanceToBoundaryPercent: distanceToBoundary,
      strategyAddress,
      tokenPair: `${vaultInfo.tokenASymbol}-${vaultInfo.tokenBSymbol}`,
      currentApy: totalApy,
    };
  }

  /**
   * Monitor all active LP positions for the wallet.
   * Returns alerts for out-of-range or near-boundary conditions.
   */
  async monitorPositions(): Promise<RangeAlert[]> {
    console.log('📡 Monitoring LP positions for range issues...');
    const alerts: RangeAlert[] = [];

    try {
      const positions = await this.liquidityClient.getUserPositions(this.wallet.publicKey);

      if (positions.length === 0) {
        console.log('ℹ️ No active LP positions found');
        return alerts;
      }

      console.log(`📊 Checking ${positions.length} LP position(s)`);

      for (const pos of positions) {
        const range = await this.checkPositionRange(pos.strategyAddress);

        const statusIcon = range.inRange ? '✅' : '❌';
        console.log(`   ${statusIcon} ${pos.strategyAddress.slice(0, 8)}... ${range.tokenPair} | ` +
          `Price: ${range.poolPrice.toFixed(6)} | Range: [${range.lower.toFixed(6)}, ${range.upper.toFixed(6)}] | ` +
          `Distance: ${range.distanceToBoundaryPercent.toFixed(2)}%`);

        if (!range.inRange) {
          const alert: RangeAlert = {
            type: 'OUT_OF_RANGE',
            strategyAddress: range.strategyAddress,
            range,
            message: `🚨 LP position OUT OF RANGE! ${range.tokenPair} vault earning 0%. ` +
              `Pool: ${range.poolPrice.toFixed(6)}, Range: [${range.lower.toFixed(6)}, ${range.upper.toFixed(6)}]`,
            timestamp: new Date().toISOString(),
            actionRequired: true,
          };
          alerts.push(alert);
          this.saveAlert(alert);
        } else if (range.distanceToBoundaryPercent.lt(NEAR_BOUNDARY_THRESHOLD)) {
          const alert: RangeAlert = {
            type: 'NEAR_BOUNDARY',
            strategyAddress: range.strategyAddress,
            range,
            message: `⚠️ LP position approaching boundary! ${range.tokenPair} is ` +
              `${range.distanceToBoundaryPercent.toFixed(2)}% from edge. ` +
              `Pool: ${range.poolPrice.toFixed(6)}`,
            timestamp: new Date().toISOString(),
            actionRequired: true,
          };
          alerts.push(alert);
          this.saveAlert(alert);
        }
      }

      if (alerts.length === 0) {
        console.log('✅ All LP positions in range');
      } else {
        console.log(`🚨 ${alerts.length} alert(s) generated`);
      }
    } catch (err) {
      console.error(`❌ Range monitor failed: ${(err as Error).message}`);
    }

    return alerts;
  }

  /**
   * Check all 5 JITOSOL-SOL vaults and return range info.
   * Useful for the dashboard to show which vaults are healthy.
   */
  async checkAllJitoSolVaults(): Promise<PositionRange[]> {
    const results: PositionRange[] = [];
    const vaultAddresses = Object.values(JITOSOL_SOL_STRATEGIES);

    for (const addr of vaultAddresses) {
      try {
        const range = await this.checkPositionRange(addr);
        results.push(range);
        // Rate limit courtesy
        await new Promise(r => setTimeout(r, 300));
      } catch {
        results.push({
          inRange: false,
          poolPrice: new Decimal(0),
          lower: new Decimal(0),
          upper: new Decimal(0),
          distanceToBoundaryPercent: new Decimal(-100),
          strategyAddress: addr,
          tokenPair: 'JitoSOL-SOL',
          currentApy: new Decimal(0),
        });
      }
    }

    return results;
  }

  /**
   * Quick health check: returns true if any position is out of range
   */
  async hasUrgentIssues(): Promise<boolean> {
    const alerts = await this.monitorPositions();
    return alerts.some(a => a.type === 'OUT_OF_RANGE');
  }

  private saveAlert(alert: RangeAlert) {
    const line = JSON.stringify({
      timestamp: alert.timestamp,
      type: alert.type,
      strategy: alert.strategyAddress,
      message: alert.message,
      inRange: alert.range.inRange,
      poolPrice: alert.range.poolPrice.toFixed(6),
      lower: alert.range.lower.toFixed(6),
      upper: alert.range.upper.toFixed(6),
      distance: alert.range.distanceToBoundaryPercent.toFixed(2),
    }) + '\n';
    fs.appendFileSync(ALERTS_FILE, line);
  }
}

/**
 * Load recent alerts (for dashboard use)
 */
export function getRecentAlerts(limit = 20): any[] {
  if (!fs.existsSync(ALERTS_FILE)) return [];
  const lines = fs.readFileSync(ALERTS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Factory function
 */
export function createRangeMonitor(
  connection: Connection,
  wallet: Keypair,
  settings: Settings
): RangeMonitor {
  return new RangeMonitor(settings.rpcUrl, wallet);
}

// ─── CLI Runner ─────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const settingsPath = path.join(__dirname, '../config/settings.json');
    const settings: Settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const walletPath = path.join(__dirname, '../config/wallet.json');
    const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

    const monitor = new RangeMonitor(settings.rpcUrl, wallet);
    const alerts = await monitor.monitorPositions();
    if (alerts.length > 0) {
      console.log('\n🚨 Alerts:');
      for (const a of alerts) console.log(`   ${a.message}`);
    }
  })().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err.message || err);
    process.exit(1);
  });
}
