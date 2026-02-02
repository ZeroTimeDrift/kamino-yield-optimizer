import Decimal from 'decimal.js';

export interface VaultInfo {
  address: string;
  name: string;
  type: 'earn' | 'lp';
  token: string;
  tokenMint: string;
  apy: Decimal;
  tvlUsd: Decimal;
  depositFeePercent: Decimal;
  withdrawalFeePercent: Decimal;
  createdAt: Date;
  isActive: boolean;
}

export interface Position {
  vaultAddress: string;
  vaultName: string;
  token: string;
  shares: Decimal;
  tokenAmount: Decimal;
  valueUsd: Decimal;
  currentApy: Decimal;
  depositedAt: Date;
  unrealizedPnl: Decimal;
}

export interface RebalanceOpportunity {
  fromVault: VaultInfo | null;
  toVault: VaultInfo;
  token: string;
  amount: Decimal;
  currentApy: Decimal;
  newApy: Decimal;
  apyGain: Decimal;
  estimatedFees: Decimal;
  estimatedMonthlyGain: Decimal;
  breakEvenDays: number;
  isProfitable: boolean;
}

export interface OptimizationResult {
  timestamp: Date;
  scannedVaults: number;
  currentPositions: Position[];
  opportunities: RebalanceOpportunity[];
  executedRebalances: ExecutedRebalance[];
  totalValueUsd: Decimal;
  weightedApy: Decimal;
}

export interface ExecutedRebalance {
  opportunity: RebalanceOpportunity;
  withdrawTx: string | null;
  depositTx: string;
  success: boolean;
  error?: string;
}

export interface Settings {
  riskTolerance: 'conservative' | 'balanced' | 'aggressive';
  minYieldImprovement: number;
  maxPositionPercent: number;
  minRebalanceAmountUsd: number;
  timeHorizonDays: number;
  gasBufferSol: number;
  maxSlippagePercent: number;
  tokens: string[];
  rpcUrl: string;
  dryRun: boolean;
  riskProfiles: {
    [key: string]: RiskProfile;
  };
}

export interface RiskProfile {
  maxPositionPercent: number;
  minVaultAgeDays: number;
  minTvlUsd: number;
  allowLpVaults: boolean;
}

export const TOKEN_MINTS: { [key: string]: string } = {
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'SOL': 'So11111111111111111111111111111111111111112',
  'JitoSOL': 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'mSOL': 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
};

export const KNOWN_VAULTS: { [key: string]: string } = {
  // Earn vaults (single-sided)
  'USDC_EARN_MAIN': 'HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E',
  'SOL_EARN_MAIN': 'D6qrPVfqPRREozFNXaAMt9XWsxDcz8DkYSKJxvvZLK4c',
  // Add more as discovered
};
