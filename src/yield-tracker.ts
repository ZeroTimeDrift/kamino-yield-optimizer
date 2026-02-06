/**
 * Yield Tracker
 * 
 * Tracks actual returns over time to measure if the strategy is working.
 * Captures portfolio snapshots and calculates performance metrics.
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { PortfolioManager, PortfolioSnapshot } from './portfolio';
import { LiquidityClient } from './liquidity-client';
import { Settings, TOKEN_MINTS } from './types';

export interface YieldHistoryEntry {
  timestamp: string;
  portfolioTotalValueSol: string;
  portfolioTotalValueUsd: string;
  positions: {
    strategy: string;
    address: string;
    value: string;
    apy: string;
  }[];
  cumulativeYieldSol: string;
  cumulativeYieldUsd: string;
  impermanentLoss?: {
    currentValueSol: string;
    holdingValueSol: string;
    lossPercent: string;
  };
  solPriceUsd: string;
}

export interface PerformanceMetrics {
  deployedDaysAgo: number;
  totalEarnedSol: Decimal;
  totalEarnedUsd: Decimal;
  actualApy: Decimal;
  vsHoldingDiff: Decimal;
  impermanentLoss?: Decimal;
}

export class YieldTracker {
  private connection: Connection;
  private wallet: Keypair;
  private portfolioManager: PortfolioManager;
  private liquidityClient: LiquidityClient;
  private settings: Settings;
  private historyFile: string;

  constructor(
    connection: Connection,
    wallet: Keypair,
    portfolioManager: PortfolioManager,
    liquidityClient: LiquidityClient,
    settings: Settings
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.portfolioManager = portfolioManager;
    this.liquidityClient = liquidityClient;
    this.settings = settings;
    this.historyFile = path.join(__dirname, '..', 'config', 'yield-history.jsonl');
    
    // Ensure config directory exists
    const configDir = path.dirname(this.historyFile);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
  }

  /**
   * Record current portfolio state to yield history
   */
  async captureSnapshot(): Promise<YieldHistoryEntry> {
    console.log('📊 Capturing portfolio snapshot...');
    
    const snapshot = await this.portfolioManager.getSnapshot();
    const solPrice = await this.getSolPrice();
    
    // Calculate total portfolio value
    const totalValueSol = this.calculateTotalValueSol(snapshot);
    const totalValueUsd = totalValueSol.mul(solPrice);
    
    // Get position breakdown
    const positions = this.getPositionBreakdown(snapshot, solPrice);
    
    // Calculate cumulative yield
    const cumulativeYield = await this.calculateCumulativeYield(totalValueSol, totalValueUsd);
    
    // Calculate impermanent loss for LP positions
    const impermanentLoss = await this.estimateImpermanentLoss(snapshot, totalValueSol);
    
    const entry: YieldHistoryEntry = {
      timestamp: new Date().toISOString(),
      portfolioTotalValueSol: totalValueSol.toString(),
      portfolioTotalValueUsd: totalValueUsd.toString(),
      positions,
      cumulativeYieldSol: cumulativeYield.sol.toString(),
      cumulativeYieldUsd: cumulativeYield.usd.toString(),
      impermanentLoss: impermanentLoss ? {
        currentValueSol: impermanentLoss.currentValue.toString(),
        holdingValueSol: impermanentLoss.holdingValue.toString(),
        lossPercent: impermanentLoss.lossPercent.toString()
      } : undefined,
      solPriceUsd: solPrice.toString()
    };
    
    // Append to JSONL file
    const jsonLine = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.historyFile, jsonLine);
    
    console.log(`💾 Saved snapshot: ${totalValueSol.toFixed(4)} SOL ($${totalValueUsd.toFixed(2)})`);
    return entry;
  }

  /**
   * Calculate actual returns over a period
   */
  async calculateReturns(since: Date): Promise<PerformanceMetrics> {
    const history = this.loadHistory();
    
    if (history.length === 0) {
      throw new Error('No yield history found. Run captureSnapshot() first.');
    }
    
    // Find starting point
    const sinceTime = since.getTime();
    const startEntry = history.find(entry => new Date(entry.timestamp).getTime() >= sinceTime);
    const endEntry = history[history.length - 1];
    
    if (!startEntry) {
      throw new Error(`No data found since ${since.toISOString()}`);
    }
    
    // Calculate returns
    const startValue = new Decimal(startEntry.portfolioTotalValueSol);
    const endValue = new Decimal(endEntry.portfolioTotalValueSol);
    const startValueUsd = new Decimal(startEntry.portfolioTotalValueUsd);
    const endValueUsd = new Decimal(endEntry.portfolioTotalValueUsd);
    
    const earnedSol = endValue.minus(startValue);
    const earnedUsd = endValueUsd.minus(startValueUsd);
    
    // Calculate time period
    const startTime = new Date(startEntry.timestamp);
    const endTime = new Date(endEntry.timestamp);
    const daysDiff = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);
    
    // Calculate APY
    const returnPercent = earnedSol.div(startValue);
    const annualizedReturn = returnPercent.div(daysDiff).mul(365);
    
    // Calculate vs holding comparison (using SOL price changes)
    const startSolPrice = new Decimal(startEntry.solPriceUsd);
    const endSolPrice = new Decimal(endEntry.solPriceUsd);
    const solPriceReturn = endSolPrice.minus(startSolPrice).div(startSolPrice);
    const vsHolding = annualizedReturn.minus(solPriceReturn);
    
    // Get impermanent loss from latest entry
    const impermanentLoss = endEntry.impermanentLoss ? 
      new Decimal(endEntry.impermanentLoss.lossPercent) : undefined;
    
    return {
      deployedDaysAgo: daysDiff,
      totalEarnedSol: earnedSol,
      totalEarnedUsd: earnedUsd,
      actualApy: annualizedReturn.mul(100), // Convert to percentage
      vsHoldingDiff: vsHolding.mul(100),
      impermanentLoss
    };
  }

  /**
   * Get human-readable performance summary
   */
  async getPerformanceSummary(since?: Date): Promise<string> {
    const history = this.loadHistory();
    
    if (history.length === 0) {
      return '📊 No yield tracking data available yet. Run captureSnapshot() first.';
    }
    
    // Use oldest entry as default start
    const startDate = since || new Date(history[0].timestamp);
    
    try {
      const metrics = await this.calculateReturns(startDate);
      
      const summary = [
        `📊 **Portfolio Performance Summary**`,
        `⏱️ Deployed: ${metrics.deployedDaysAgo.toFixed(1)} days ago`,
        `💰 Earned: ${metrics.totalEarnedSol.toFixed(4)} SOL ($${metrics.totalEarnedUsd.toFixed(2)})`,
        `📈 Actual APY: ${metrics.actualApy.toFixed(2)}%`,
        `🆚 vs Holding SOL: ${metrics.vsHoldingDiff.gt(0) ? '+' : ''}${metrics.vsHoldingDiff.toFixed(2)}%`
      ];
      
      if (metrics.impermanentLoss) {
        summary.push(`⚠️ Impermanent Loss: ${metrics.impermanentLoss.toFixed(2)}%`);
      }
      
      return summary.join('\n');
    } catch (error) {
      return `❌ Error calculating returns: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Estimate impermanent loss for LP positions
   */
  async estimateImpermanentLoss(snapshot: PortfolioSnapshot, totalValueSol: Decimal): Promise<{
    currentValue: Decimal;
    holdingValue: Decimal;
    lossPercent: Decimal;
  } | null> {
    const lpPositions = snapshot.liquidityPositions;
    if (lpPositions.length === 0) {
      return null;
    }
    
    // For JitoSOL-SOL LP: calculate what the position would be worth if just held JitoSOL
    let totalLpValue = new Decimal(0);
    let totalHoldingValue = new Decimal(0);
    
    for (const position of lpPositions) {
      // Current LP value (already in SOL terms)
      const currentValue = new Decimal(position.valueUsd).div(await this.getSolPrice());
      totalLpValue = totalLpValue.plus(currentValue);
      
      // Estimate what it would be worth if just held the underlying tokens
      // This is a simplified calculation - in reality we'd need the exact entry amounts
      // For now, assume equal weighting and use current token amounts
      const tokenASol = new Decimal(position.tokenAAmount);
      const tokenBSol = new Decimal(position.tokenBAmount);
      
      if (position.tokenASymbol === 'SOL') {
        totalHoldingValue = totalHoldingValue.plus(tokenASol).plus(tokenBSol);
      } else if (position.tokenBSymbol === 'SOL') {
        totalHoldingValue = totalHoldingValue.plus(tokenASol).plus(tokenBSol);
      } else {
        // Both non-SOL tokens - convert to SOL equivalent
        totalHoldingValue = totalHoldingValue.plus(currentValue);
      }
    }
    
    if (totalHoldingValue.isZero()) {
      return null;
    }
    
    const lossPercent = totalLpValue.minus(totalHoldingValue).div(totalHoldingValue).mul(100);
    
    return {
      currentValue: totalLpValue,
      holdingValue: totalHoldingValue,
      lossPercent
    };
  }

  private calculateTotalValueSol(snapshot: PortfolioSnapshot): Decimal {
    let total = new Decimal(0);
    
    // SOL balance
    total = total.plus(snapshot.balances.SOL || new Decimal(0));
    
    // K-Lend positions (convert USDC to SOL equivalent)
    for (const position of snapshot.klendPositions) {
      if (position.token === 'SOL' || position.token === 'JitoSOL') {
        total = total.plus(position.tokenAmount);
      }
      // For USDC positions, we'd need to convert - skip for now
    }
    
    // Multiply positions
    for (const position of snapshot.multiplyPositions) {
      // Net value is already in USD, convert to SOL
      // This is approximate - would need current SOL price
      const solEquivalent = position.netValueUsd.div(100); // rough estimate
      total = total.plus(solEquivalent);
    }
    
    // Liquidity positions
    for (const position of snapshot.liquidityPositions) {
      // Assuming position value is in SOL terms for JitoSOL-SOL pairs
      const tokenASol = new Decimal(position.tokenAAmount);
      const tokenBSol = new Decimal(position.tokenBAmount);
      total = total.plus(tokenASol).plus(tokenBSol);
    }
    
    return total;
  }

  private getPositionBreakdown(snapshot: PortfolioSnapshot, solPrice: Decimal) {
    const positions: any[] = [];
    
    // K-Lend positions
    for (const position of snapshot.klendPositions) {
      positions.push({
        strategy: 'K-Lend',
        address: position.vaultAddress,
        value: position.valueUsd.toString(),
        apy: position.currentApy.toString()
      });
    }
    
    // Multiply positions
    for (const position of snapshot.multiplyPositions) {
      positions.push({
        strategy: 'Multiply',
        address: position.obligationAddress,
        value: position.netValueUsd.toString(),
        apy: position.netApy.toString()
      });
    }
    
    // Liquidity positions
    for (const position of snapshot.liquidityPositions) {
      const valueSol = new Decimal(position.tokenAAmount).plus(position.tokenBAmount);
      const valueUsd = valueSol.mul(solPrice);
      positions.push({
        strategy: 'Liquidity',
        address: position.strategyAddress,
        value: valueUsd.toString(),
        apy: position.apy.toString()
      });
    }
    
    return positions;
  }

  private async calculateCumulativeYield(currentValueSol: Decimal, currentValueUsd: Decimal): Promise<{
    sol: Decimal;
    usd: Decimal;
  }> {
    const history = this.loadHistory();
    
    if (history.length === 0) {
      return { sol: new Decimal(0), usd: new Decimal(0) };
    }
    
    // Use first entry as baseline
    const firstEntry = history[0];
    const initialValueSol = new Decimal(firstEntry.portfolioTotalValueSol);
    const initialValueUsd = new Decimal(firstEntry.portfolioTotalValueUsd);
    
    return {
      sol: currentValueSol.minus(initialValueSol),
      usd: currentValueUsd.minus(initialValueUsd)
    };
  }

  private async getSolPrice(): Promise<Decimal> {
    try {
      // Simple price fetch - in production you'd use a proper price feed
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const data = await response.json();
      return new Decimal(data.solana.usd);
    } catch (error) {
      console.warn('Failed to fetch SOL price, using default:', error);
      return new Decimal(100); // Fallback price
    }
  }

  private loadHistory(): YieldHistoryEntry[] {
    if (!fs.existsSync(this.historyFile)) {
      return [];
    }
    
    const content = fs.readFileSync(this.historyFile, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    return lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (error) {
        console.warn('Failed to parse history line:', line);
        return null;
      }
    }).filter(entry => entry !== null);
  }
}

/**
 * Create YieldTracker instance from settings
 */
export async function createYieldTracker(
  connection: Connection,
  wallet: Keypair,
  settings: Settings
): Promise<YieldTracker> {
  const { PortfolioManager } = await import('./portfolio');
  const { LiquidityClient } = await import('./liquidity-client');
  
  const portfolioManager = new PortfolioManager(connection, wallet, settings);
  const liquidityClient = new LiquidityClient(connection, wallet);
  
  return new YieldTracker(connection, wallet, portfolioManager, liquidityClient, settings);
}