/**
 * Out-of-Range Monitor
 * 
 * Monitors Kamino LP vault positions to ensure they stay in range.
 * 4 of 5 JITOSOL-SOL LP vaults are currently out of range earning 0%.
 * If our vault goes out of range, we're earning nothing and need to pull out.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import { LiquidityClient, LiquidityVaultInfo, LiquidityPosition } from './liquidity-client';
import { PortfolioManager } from './portfolio';
import { Settings } from './types';

export interface PositionRange {
  /** Whether the position is currently in range */
  inRange: boolean;
  /** Current pool price */
  poolPrice: Decimal;
  /** Lower price boundary */
  lower: Decimal;
  /** Upper price boundary */
  upper: Decimal;
  /** Distance to nearest boundary as percentage (positive = in range) */
  distanceToBoundary: Decimal;
  /** Strategy address */
  strategyAddress: string;
  /** Pool token pair */
  tokenPair: string;
  /** Current fee tier earning rate */
  currentFeeRate: Decimal;
}

export interface RangeAlert {
  /** Alert type */
  type: 'OUT_OF_RANGE' | 'NEAR_BOUNDARY' | 'BACK_IN_RANGE';
  /** Strategy address */
  strategyAddress: string;
  /** Position range info */
  range: PositionRange;
  /** Alert message */
  message: string;
  /** Timestamp */
  timestamp: Date;
  /** Whether action is recommended */
  actionRequired: boolean;
}

export class RangeMonitor {
  private connection: Connection;
  private wallet: Keypair;
  private liquidityClient: LiquidityClient;
  private portfolioManager: PortfolioManager;
  private settings: Settings;
  private alertThreshold: Decimal;

  constructor(
    connection: Connection,
    wallet: Keypair,
    liquidityClient: LiquidityClient,
    portfolioManager: PortfolioManager,
    settings: Settings,
    alertThresholdPercent = 5
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.liquidityClient = liquidityClient;
    this.portfolioManager = portfolioManager;
    this.settings = settings;
    this.alertThreshold = new Decimal(alertThresholdPercent);
  }

  /**
   * Check if a specific position is in range
   */
  async checkPositionRange(strategyAddress: string): Promise<PositionRange> {
    console.log(`🔍 Checking range for strategy: ${strategyAddress}`);
    
    try {
      // Get strategy details
      const strategy = await this.liquidityClient.getStrategyDetails(strategyAddress);
      
      if (!strategy) {
        throw new Error(`Strategy not found: ${strategyAddress}`);
      }
      
      // Get pool price
      const poolPrice = await this.getPoolPrice(strategy);
      
      // Determine if in range
      const inRange = poolPrice.gte(strategy.lowerPrice) && poolPrice.lte(strategy.upperPrice);
      
      // Calculate distance to boundaries
      const distanceToLower = poolPrice.minus(strategy.lowerPrice).div(strategy.lowerPrice).mul(100);
      const distanceToUpper = strategy.upperPrice.minus(poolPrice).div(strategy.upperPrice).mul(100);
      const distanceToBoundary = Decimal.min(distanceToLower, distanceToUpper);
      
      return {
        inRange,
        poolPrice,
        lower: strategy.lowerPrice,
        upper: strategy.upperPrice,
        distanceToBoundary: inRange ? distanceToBoundary : new Decimal(-1).mul(Decimal.min(distanceToLower.abs(), distanceToUpper.abs())),
        strategyAddress,
        tokenPair: `${strategy.tokenASymbol}-${strategy.tokenBSymbol}`,
        currentFeeRate: strategy.apy || new Decimal(0)
      };
    } catch (error) {
      console.error(`❌ Failed to check range for ${strategyAddress}:`, error);
      
      // Return a fallback range status
      return {
        inRange: false,
        poolPrice: new Decimal(0),
        lower: new Decimal(0),
        upper: new Decimal(0),
        distanceToBoundary: new Decimal(-100),
        strategyAddress,
        tokenPair: 'Unknown',
        currentFeeRate: new Decimal(0)
      };
    }
  }

  /**
   * Monitor all active LP positions
   */
  async monitorPositions(wallet: string): Promise<RangeAlert[]> {
    console.log('📡 Monitoring all LP positions for range issues...');
    
    const alerts: RangeAlert[] = [];
    
    try {
      // Get current portfolio snapshot
      const snapshot = await this.portfolioManager.getSnapshot();
      const liquidityPositions = snapshot.liquidityPositions;
      
      if (liquidityPositions.length === 0) {
        console.log('ℹ️ No liquidity positions found');
        return alerts;
      }
      
      console.log(`📊 Checking ${liquidityPositions.length} liquidity positions`);
      
      // Check each position
      for (const position of liquidityPositions) {
        const range = await this.checkPositionRange(position.strategyAddress);
        
        console.log(`📍 ${position.strategyAddress.slice(0, 8)}... - Range: ${range.inRange ? '✅ In' : '❌ Out'} | Distance: ${range.distanceToBoundary.toFixed(2)}%`);
        
        // Generate alerts based on range status
        const positionAlerts = this.generateAlerts(range, position);
        alerts.push(...positionAlerts);
      }
      
      if (alerts.length > 0) {
        console.log(`🚨 Generated ${alerts.length} range alerts`);
      } else {
        console.log('✅ All positions are in acceptable range');
      }
      
      return alerts;
    } catch (error) {
      console.error('❌ Failed to monitor positions:', error);
      return [];
    }
  }

  /**
   * Get current pool price for a strategy
   */
  private async getPoolPrice(strategy: LiquidityVaultInfo): Promise<Decimal> {
    try {
      // For Kamino liquidity vaults, the pool price can be derived from token balances
      // This is a simplified implementation - in practice, you'd use the DEX's price oracle
      
      // Fetch current pool state from the strategy
      const poolData = await this.liquidityClient.getPoolState(strategy.address);
      
      if (poolData && poolData.currentPrice) {
        return new Decimal(poolData.currentPrice);
      }
      
      // Fallback: estimate from token amounts if available
      if (strategy.tokenAAmount && strategy.tokenBAmount && !strategy.tokenAAmount.isZero()) {
        return strategy.tokenBAmount.div(strategy.tokenAAmount);
      }
      
      // Last resort: use a reasonable default for JitoSOL/SOL (close to 1.0)
      if (strategy.tokenASymbol === 'SOL' && strategy.tokenBSymbol === 'JitoSOL') {
        return new Decimal(1.05); // JitoSOL trades at slight premium
      }
      
      if (strategy.tokenASymbol === 'JitoSOL' && strategy.tokenBSymbol === 'SOL') {
        return new Decimal(0.95); // Inverse ratio
      }
      
      return new Decimal(1); // Default to 1:1 ratio
    } catch (error) {
      console.warn(`Failed to get pool price for ${strategy.address}, using default:`, error);
      return new Decimal(1);
    }
  }

  /**
   * Generate alerts based on range status
   */
  private generateAlerts(range: PositionRange, position: LiquidityPosition): RangeAlert[] {
    const alerts: RangeAlert[] = [];
    const now = new Date();
    
    // Out of range alert
    if (!range.inRange) {
      alerts.push({
        type: 'OUT_OF_RANGE',
        strategyAddress: range.strategyAddress,
        range,
        message: `🚨 Position OUT OF RANGE! ${range.tokenPair} strategy earning 0%. Pool price: ${range.poolPrice.toFixed(6)}, Range: [${range.lower.toFixed(6)}, ${range.upper.toFixed(6)}]`,
        timestamp: now,
        actionRequired: true
      });
    }
    // Near boundary alert
    else if (range.distanceToBoundary.lte(this.alertThreshold)) {
      alerts.push({
        type: 'NEAR_BOUNDARY',
        strategyAddress: range.strategyAddress,
        range,
        message: `⚠️ Position approaching range boundary! ${range.tokenPair} strategy ${range.distanceToBoundary.toFixed(2)}% from edge. Pool price: ${range.poolPrice.toFixed(6)}`,
        timestamp: now,
        actionRequired: true
      });
    }
    
    return alerts;
  }

  /**
   * Get a summary of all position ranges
   */
  async getRangeSummary(): Promise<string> {
    try {
      const snapshot = await this.portfolioManager.getSnapshot();
      const liquidityPositions = snapshot.liquidityPositions;
      
      if (liquidityPositions.length === 0) {
        return '📊 No liquidity positions to monitor';
      }
      
      const summaryLines = ['📊 **LP Position Range Summary**'];
      
      for (const position of liquidityPositions) {
        const range = await this.checkPositionRange(position.strategyAddress);
        
        const status = range.inRange 
          ? `✅ In Range (${range.distanceToBoundary.toFixed(1)}% margin)`
          : `❌ Out of Range`;
        
        const earnings = range.inRange 
          ? `${range.currentFeeRate.toFixed(2)}% APY`
          : `0% APY`;
        
        summaryLines.push(
          `🎯 ${position.strategyAddress.slice(0, 8)}... ${range.tokenPair}: ${status} - ${earnings}`
        );
      }
      
      return summaryLines.join('\n');
    } catch (error) {
      return `❌ Error getting range summary: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Check if any position requires immediate attention
   */
  async hasUrgentIssues(): Promise<boolean> {
    const alerts = await this.monitorPositions(this.wallet.publicKey.toString());
    return alerts.some(alert => alert.type === 'OUT_OF_RANGE' && alert.actionRequired);
  }
}

/**
 * Create RangeMonitor instance from settings
 */
export async function createRangeMonitor(
  connection: Connection,
  wallet: Keypair,
  settings: Settings
): Promise<RangeMonitor> {
  const { LiquidityClient } = await import('./liquidity-client');
  const { PortfolioManager } = await import('./portfolio');
  
  const liquidityClient = new LiquidityClient(connection, wallet);
  const portfolioManager = new PortfolioManager(connection, wallet, settings);
  
  return new RangeMonitor(connection, wallet, liquidityClient, portfolioManager, settings);
}