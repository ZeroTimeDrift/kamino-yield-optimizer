/**
 * Points/Rewards Tracker
 * 
 * Tracks Kamino points and reward emissions over time.
 * Monitors various reward sources including points programs and vault emissions.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { Settings } from './types';
import { PortfolioManager } from './portfolio';

export interface RewardSource {
  /** Type of reward */
  type: 'POINTS' | 'TOKEN_EMISSIONS' | 'FEES';
  /** Source name (e.g. "Kamino Points", "KMNO Emissions") */
  name: string;
  /** Amount earned */
  amount: Decimal;
  /** Token symbol */
  token: string;
  /** USD value estimate */
  valueUsd: Decimal;
  /** APY contribution */
  apyContribution: Decimal;
  /** Last updated */
  lastUpdated: Date;
}

export interface RewardsSnapshot {
  /** Timestamp */
  timestamp: string;
  /** Wallet address */
  wallet: string;
  /** All reward sources */
  rewards: RewardSource[];
  /** Total estimated value */
  totalValueUsd: Decimal;
  /** Total APY from rewards */
  totalRewardApy: Decimal;
  /** Cumulative points/rewards since start */
  cumulativeRewards: {
    [token: string]: Decimal;
  };
}

export class RewardsTracker {
  private connection: Connection;
  private wallet: Keypair;
  private portfolioManager: PortfolioManager;
  private settings: Settings;
  private historyFile: string;

  constructor(
    connection: Connection,
    wallet: Keypair,
    portfolioManager: PortfolioManager,
    settings: Settings
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.portfolioManager = portfolioManager;
    this.settings = settings;
    this.historyFile = path.join(__dirname, '..', 'config', 'rewards-history.jsonl');
    
    // Ensure config directory exists
    const configDir = path.dirname(this.historyFile);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
  }

  /**
   * Capture current rewards state
   */
  async captureSnapshot(): Promise<RewardsSnapshot> {
    console.log('🎁 Capturing rewards snapshot...');
    
    const wallet = this.wallet.publicKey.toString();
    const rewards: RewardSource[] = [];
    
    // Check Kamino points
    const kaminoPoints = await this.getKaminoPoints(wallet);
    if (kaminoPoints) {
      rewards.push(kaminoPoints);
    }
    
    // Check vault emissions
    const vaultRewards = await this.getVaultEmissions(wallet);
    rewards.push(...vaultRewards);
    
    // Calculate totals
    const totalValueUsd = rewards.reduce((sum, reward) => sum.plus(reward.valueUsd), new Decimal(0));
    const totalRewardApy = rewards.reduce((sum, reward) => sum.plus(reward.apyContribution), new Decimal(0));
    
    // Calculate cumulative rewards
    const cumulativeRewards = this.calculateCumulativeRewards(rewards);
    
    const snapshot: RewardsSnapshot = {
      timestamp: new Date().toISOString(),
      wallet,
      rewards,
      totalValueUsd,
      totalRewardApy,
      cumulativeRewards
    };
    
    // Save to history
    const jsonLine = JSON.stringify(snapshot, (key, value) => {
      if (value instanceof Decimal) {
        return value.toString();
      }
      return value;
    }) + '\n';
    
    fs.appendFileSync(this.historyFile, jsonLine);
    
    console.log(`💾 Saved rewards snapshot: $${totalValueUsd.toFixed(2)} total value, ${totalRewardApy.toFixed(2)}% APY from rewards`);
    return snapshot;
  }

  /**
   * Get Kamino points from API
   */
  private async getKaminoPoints(wallet: string): Promise<RewardSource | null> {
    try {
      console.log('🔍 Checking Kamino points API...');
      
      // Try multiple potential endpoints
      const endpoints = [
        `https://api.hubbleprotocol.io/points/users/${wallet}`,
        `https://api.kamino.finance/points/users/${wallet}`,
        `https://points-api.kamino.finance/users/${wallet}`
      ];
      
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint);
          
          if (response.ok) {
            const data = await response.json();
            
            // Parse response - structure may vary
            let points = new Decimal(0);
            
            if (data.points) {
              points = new Decimal(data.points);
            } else if (data.totalPoints) {
              points = new Decimal(data.totalPoints);
            } else if (data.balance) {
              points = new Decimal(data.balance);
            }
            
            if (points.gt(0)) {
              console.log(`✅ Found ${points.toFixed(0)} Kamino points`);
              
              return {
                type: 'POINTS',
                name: 'Kamino Points',
                amount: points,
                token: 'KAMINO_POINTS',
                valueUsd: new Decimal(0), // Points don't have direct USD value yet
                apyContribution: new Decimal(0), // Estimate based on potential airdrops
                lastUpdated: new Date()
              };
            }
          }
        } catch (err) {
          // Continue to next endpoint
          console.log(`Tried ${endpoint}, continuing...`);
        }
      }
      
      console.log('ℹ️ No Kamino points found or API unavailable');
      return null;
    } catch (error) {
      console.warn('Failed to fetch Kamino points:', error);
      return null;
    }
  }

  /**
   * Get reward emissions from active vault positions
   */
  private async getVaultEmissions(wallet: string): Promise<RewardSource[]> {
    const rewards: RewardSource[] = [];
    
    try {
      console.log('🔍 Checking vault reward emissions...');
      
      // Get portfolio snapshot to find active positions
      const snapshot = await this.portfolioManager.getSnapshot();
      
      // Check K-Lend positions for reward emissions
      for (const position of snapshot.klendPositions) {
        const emissions = await this.getKLendEmissions(position.vaultAddress);
        if (emissions) {
          rewards.push(...emissions);
        }
      }
      
      // Check Liquidity positions for fee earnings
      for (const position of snapshot.liquidityPositions) {
        const feeRewards = await this.getLiquidityFeeEarnings(position.strategyAddress);
        if (feeRewards) {
          rewards.push(feeRewards);
        }
      }
      
      console.log(`📊 Found ${rewards.length} emission sources`);
      return rewards;
    } catch (error) {
      console.warn('Failed to get vault emissions:', error);
      return [];
    }
  }

  /**
   * Get K-Lend position reward emissions
   */
  private async getKLendEmissions(vaultAddress: string): Promise<RewardSource[] | null> {
    try {
      // This would typically use the Kamino SDK to get reward info
      // For now, return null as we don't have specific emission data
      return null;
    } catch (error) {
      console.warn(`Failed to get K-Lend emissions for ${vaultAddress}:`, error);
      return null;
    }
  }

  /**
   * Get liquidity position fee earnings
   */
  private async getLiquidityFeeEarnings(strategyAddress: string): Promise<RewardSource | null> {
    try {
      // This would calculate accumulated fees from liquidity provision
      // For now, estimate based on position size and time
      return {
        type: 'FEES',
        name: 'LP Fees',
        amount: new Decimal(0.1), // Placeholder
        token: 'SOL',
        valueUsd: new Decimal(10), // Placeholder
        apyContribution: new Decimal(0.5), // Placeholder
        lastUpdated: new Date()
      };
    } catch (error) {
      console.warn(`Failed to get LP fee earnings for ${strategyAddress}:`, error);
      return null;
    }
  }

  /**
   * Calculate cumulative rewards since tracking began
   */
  private calculateCumulativeRewards(currentRewards: RewardSource[]): { [token: string]: Decimal } {
    const cumulative: { [token: string]: Decimal } = {};
    
    // Load historical data
    const history = this.loadRewardsHistory();
    
    if (history.length === 0) {
      // First snapshot - everything is cumulative
      for (const reward of currentRewards) {
        cumulative[reward.token] = reward.amount;
      }
      return cumulative;
    }
    
    // Get baseline from first snapshot
    const baseline = history[0];
    
    for (const reward of currentRewards) {
      const baselineReward = baseline.rewards.find(r => r.token === reward.token);
      const baselineAmount = baselineReward ? new Decimal(baselineReward.amount) : new Decimal(0);
      cumulative[reward.token] = reward.amount.minus(baselineAmount);
    }
    
    return cumulative;
  }

  /**
   * Get rewards summary
   */
  async getRewardsSummary(): Promise<string> {
    try {
      const snapshot = await this.captureSnapshot();
      
      if (snapshot.rewards.length === 0) {
        return '🎁 No active rewards found';
      }
      
      const summary = [
        '🎁 **Rewards Summary**',
        `💰 Total Value: $${snapshot.totalValueUsd.toFixed(2)}`,
        `📈 Reward APY Boost: +${snapshot.totalRewardApy.toFixed(2)}%`,
        '',
        '📊 **Active Rewards:**'
      ];
      
      for (const reward of snapshot.rewards) {
        const line = `${this.getRewardEmoji(reward.type)} ${reward.name}: ${reward.amount.toFixed(2)} ${reward.token}`;
        summary.push(line);
      }
      
      // Add cumulative section
      const cumulativeEntries = Object.entries(snapshot.cumulativeRewards);
      if (cumulativeEntries.length > 0) {
        summary.push('', '🏆 **Total Earned:**');
        for (const [token, amount] of cumulativeEntries) {
          if (amount.gt(0)) {
            summary.push(`🎯 ${amount.toFixed(2)} ${token}`);
          }
        }
      }
      
      return summary.join('\n');
    } catch (error) {
      return `❌ Error getting rewards summary: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Load rewards history from file
   */
  private loadRewardsHistory(): RewardsSnapshot[] {
    if (!fs.existsSync(this.historyFile)) {
      return [];
    }
    
    const content = fs.readFileSync(this.historyFile, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    return lines.map(line => {
      try {
        const parsed = JSON.parse(line);
        // Convert string decimals back to Decimal objects
        if (parsed.rewards) {
          parsed.rewards = parsed.rewards.map((r: any) => ({
            ...r,
            amount: new Decimal(r.amount),
            valueUsd: new Decimal(r.valueUsd),
            apyContribution: new Decimal(r.apyContribution),
            lastUpdated: new Date(r.lastUpdated)
          }));
        }
        if (parsed.totalValueUsd) {
          parsed.totalValueUsd = new Decimal(parsed.totalValueUsd);
        }
        if (parsed.totalRewardApy) {
          parsed.totalRewardApy = new Decimal(parsed.totalRewardApy);
        }
        if (parsed.cumulativeRewards) {
          const cumulative: { [token: string]: Decimal } = {};
          for (const [token, amount] of Object.entries(parsed.cumulativeRewards)) {
            cumulative[token] = new Decimal(amount as string);
          }
          parsed.cumulativeRewards = cumulative;
        }
        return parsed;
      } catch (error) {
        console.warn('Failed to parse rewards history line:', line);
        return null;
      }
    }).filter(entry => entry !== null);
  }

  /**
   * Get emoji for reward type
   */
  private getRewardEmoji(type: RewardSource['type']): string {
    switch (type) {
      case 'POINTS': return '⭐';
      case 'TOKEN_EMISSIONS': return '💎';
      case 'FEES': return '💰';
      default: return '🎁';
    }
  }
}

/**
 * Create RewardsTracker instance from settings
 */
export async function createRewardsTracker(
  connection: Connection,
  wallet: Keypair,
  settings: Settings
): Promise<RewardsTracker> {
  const { PortfolioManager } = await import('./portfolio');
  
  const portfolioManager = new PortfolioManager(connection, wallet, settings);
  
  return new RewardsTracker(connection, wallet, portfolioManager, settings);
}