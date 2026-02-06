/**
 * Points/Rewards Tracker
 *
 * Tracks Kamino points, reward emissions, and other incentives.
 * Checks Hubble protocol API for points data and logs over time.
 *
 * NO RPC calls — purely HTTP API calls to points endpoints.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { Settings } from './types';

// ─── Types ──────────────────────────────────────────────────────

export interface RewardsSnapshot {
  timestamp: string;
  wallet: string;
  kaminoPoints: KaminoPointsData | null;
  jitoPoints: JitoPointsData | null;
  totalEstimatedValueUsd: string;
}

export interface KaminoPointsData {
  totalPoints: string;
  rank: number | null;
  breakdown: {
    source: string;
    points: string;
  }[];
  rawResponse: any;
}

export interface JitoPointsData {
  totalPoints: string;
  rawResponse: any;
}

// ─── Config ─────────────────────────────────────────────────────

const REWARDS_FILE = path.join(__dirname, '..', 'config', 'rewards-history.jsonl');

const KAMINO_POINTS_ENDPOINTS = [
  'https://api.hubbleprotocol.io/v2/users/{wallet}/points',
  'https://api.hubbleprotocol.io/points/users/{wallet}',
  'https://api.kamino.finance/v2/users/{wallet}/points',
];

const JITO_POINTS_ENDPOINTS = [
  'https://kaminoapi.jito.network/users/{wallet}/points',
];

// ─── Helpers ────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function loadHistory(): RewardsSnapshot[] {
  if (!fs.existsSync(REWARDS_FILE)) return [];
  const content = fs.readFileSync(REWARDS_FILE, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean) as RewardsSnapshot[];
}

// ─── Main class ─────────────────────────────────────────────────

export class RewardsTracker {
  private walletAddress: string;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress;
  }

  /**
   * Capture current rewards state from various APIs.
   * NO RPC calls — purely HTTP.
   */
  async captureSnapshot(): Promise<RewardsSnapshot> {
    console.log('🎁 Capturing rewards snapshot...');

    const kaminoPoints = await this.fetchKaminoPoints();
    const jitoPoints = await this.fetchJitoPoints();

    const snapshot: RewardsSnapshot = {
      timestamp: new Date().toISOString(),
      wallet: this.walletAddress,
      kaminoPoints,
      jitoPoints,
      totalEstimatedValueUsd: '0', // Points don't have clear USD value yet
    };

    // Append to history
    fs.appendFileSync(REWARDS_FILE, JSON.stringify(snapshot) + '\n');

    const kPts = kaminoPoints?.totalPoints || '0';
    const jPts = jitoPoints?.totalPoints || '0';
    console.log(`💾 Rewards: Kamino=${kPts} pts | Jito=${jPts} pts`);

    return snapshot;
  }

  /**
   * Fetch Kamino points from Hubble protocol API
   */
  private async fetchKaminoPoints(): Promise<KaminoPointsData | null> {
    for (const template of KAMINO_POINTS_ENDPOINTS) {
      const url = template.replace('{wallet}', this.walletAddress);
      try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) continue;

        const data = await response.json() as any;

        // Parse various response formats
        let totalPoints = '0';
        let rank: number | null = null;
        const breakdown: { source: string; points: string }[] = [];

        if (data.totalPoints !== undefined) {
          totalPoints = String(data.totalPoints);
        } else if (data.points !== undefined) {
          totalPoints = String(data.points);
        } else if (data.balance !== undefined) {
          totalPoints = String(data.balance);
        } else if (data.total !== undefined) {
          totalPoints = String(data.total);
        }

        if (data.rank !== undefined) {
          rank = Number(data.rank);
        }

        // Try to parse breakdown
        if (data.breakdown && Array.isArray(data.breakdown)) {
          for (const item of data.breakdown) {
            breakdown.push({
              source: item.source || item.name || 'Unknown',
              points: String(item.points || item.amount || 0),
            });
          }
        } else if (data.sources && typeof data.sources === 'object') {
          for (const [source, points] of Object.entries(data.sources)) {
            breakdown.push({ source, points: String(points) });
          }
        }

        if (totalPoints !== '0' || breakdown.length > 0) {
          console.log(`   ✅ Kamino points: ${totalPoints} (from ${url})`);
          return { totalPoints, rank, breakdown, rawResponse: data };
        }
      } catch (err) {
        // Continue to next endpoint
      }
    }

    console.log('   ℹ️ Kamino points API unavailable or no points found');
    return null;
  }

  /**
   * Fetch Jito points/rewards
   */
  private async fetchJitoPoints(): Promise<JitoPointsData | null> {
    for (const template of JITO_POINTS_ENDPOINTS) {
      const url = template.replace('{wallet}', this.walletAddress);
      try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) continue;

        const data = await response.json() as any;
        const totalPoints = String(data.totalPoints || data.points || data.total || 0);

        if (totalPoints !== '0') {
          console.log(`   ✅ Jito points: ${totalPoints}`);
          return { totalPoints, rawResponse: data };
        }
      } catch {
        // Continue
      }
    }

    // Try Hubble API with a specific Jito-related path
    try {
      const url = `https://api.hubbleprotocol.io/v2/users/${this.walletAddress}/rewards`;
      const response = await fetchWithTimeout(url);
      if (response.ok) {
        const data = await response.json() as any;
        if (data && (data.totalPoints || data.jito)) {
          const totalPoints = String(data.jito?.points || data.totalPoints || 0);
          return { totalPoints, rawResponse: data };
        }
      }
    } catch { /* ignore */ }

    console.log('   ℹ️ Jito points API unavailable or no points found');
    return null;
  }

  /**
   * Get rewards summary string
   */
  getRewardsSummary(): string {
    const history = loadHistory();
    if (history.length === 0) {
      return '🎁 No rewards data yet.';
    }

    const latest = history[history.length - 1];
    const lines = ['🎁 **Rewards Summary**'];

    if (latest.kaminoPoints) {
      lines.push(`⭐ Kamino Points: ${latest.kaminoPoints.totalPoints}`);
      if (latest.kaminoPoints.rank) {
        lines.push(`   Rank: #${latest.kaminoPoints.rank}`);
      }
      for (const b of latest.kaminoPoints.breakdown) {
        lines.push(`   └─ ${b.source}: ${b.points}`);
      }
    }

    if (latest.jitoPoints) {
      lines.push(`💎 Jito Points: ${latest.jitoPoints.totalPoints}`);
    }

    if (!latest.kaminoPoints && !latest.jitoPoints) {
      lines.push('ℹ️ No points data available from APIs');
    }

    // Show growth if we have history
    if (history.length >= 2) {
      const first = history[0];
      const firstKamino = parseFloat(first.kaminoPoints?.totalPoints || '0');
      const latestKamino = parseFloat(latest.kaminoPoints?.totalPoints || '0');
      if (firstKamino > 0 && latestKamino > firstKamino) {
        const growth = latestKamino - firstKamino;
        lines.push(`📈 Kamino points earned since tracking: +${growth.toFixed(0)}`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Load rewards history (for dashboard)
 */
export function getRewardsHistory(): RewardsSnapshot[] {
  return loadHistory();
}

/**
 * Factory function
 */
export function createRewardsTracker(
  connection: Connection,
  wallet: Keypair,
  settings: Settings
): RewardsTracker {
  return new RewardsTracker(wallet.publicKey.toBase58());
}

// ─── CLI Runner ─────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const settingsPath = path.join(__dirname, '../config/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const walletPath = path.join(__dirname, '../config/wallet.json');
    const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
    const wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));

    const tracker = new RewardsTracker(wallet.publicKey.toBase58());
    await tracker.captureSnapshot();
    console.log('\n' + tracker.getRewardsSummary());
  })().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err.message || err);
    process.exit(1);
  });
}
