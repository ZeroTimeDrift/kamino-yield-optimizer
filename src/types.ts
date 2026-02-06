import Decimal from 'decimal.js';

// ─── Strategy Types ─────────────────────────────────────────────

export enum StrategyType {
  KLEND = 'klend',
  MULTIPLY = 'multiply',
  LIQUIDITY = 'liquidity',
}

// ─── Existing Interfaces (preserved) ────────────────────────────

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
  // New multi-strategy settings
  portfolio?: PortfolioSettings;
  multiply?: MultiplySettings;
  jupiter?: JupiterSettings;
}

export interface RiskProfile {
  maxPositionPercent: number;
  minVaultAgeDays: number;
  minTvlUsd: number;
  allowLpVaults: boolean;
}

// ─── New Interfaces ─────────────────────────────────────────────

/** Kamino Multiply position state */
export interface MultiplyPosition {
  /** Public key of the obligation account */
  obligationAddress: string;
  /** Market the position is in */
  marketAddress: string;
  /** Collateral token symbol (e.g. JitoSOL) */
  collateralToken: string;
  /** Debt token symbol (e.g. SOL) */
  debtToken: string;
  /** Collateral amount in UI units */
  collateralAmount: Decimal;
  /** Debt amount in UI units */
  debtAmount: Decimal;
  /** Net value in USD */
  netValueUsd: Decimal;
  /** Current effective leverage (collateral / equity) */
  leverage: Decimal;
  /** Current loan-to-value ratio (0-1) */
  ltv: Decimal;
  /** Max allowed LTV before liquidation */
  maxLtv: Decimal;
  /** Collateral supply APY */
  collateralApy: Decimal;
  /** Borrow cost APY */
  borrowApy: Decimal;
  /** Net APY (staking yield * leverage - borrow cost * (leverage-1)) */
  netApy: Decimal;
  /** Strategy type tag */
  strategy: StrategyType.MULTIPLY;
}

/** Portfolio allocation target and current state */
export interface PortfolioAllocation {
  /** Strategy identifier */
  strategy: StrategyType;
  /** Human label */
  label: string;
  /** Token symbol */
  token: string;
  /** Target allocation as a fraction (0-1) */
  targetWeight: number;
  /** Current allocation as a fraction (0-1) */
  currentWeight: number;
  /** Current value in USD */
  currentValueUsd: Decimal;
  /** Current APY */
  currentApy: Decimal;
  /** Drift from target (currentWeight - targetWeight) */
  drift: number;
}

/** Jupiter V6 quote response (simplified) */
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRoutePlan[];
}

export interface JupiterRoutePlan {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

/** Jupiter swap transaction response */
export interface JupiterSwapResponse {
  swapTransaction: string; // base64-encoded versioned transaction
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

/** Portfolio-level settings */
export interface PortfolioSettings {
  allocations: {
    klendUsdc: number;  // e.g. 0.60
    multiply: number;   // e.g. 0.30
    gasReserve: number; // e.g. 0.10
  };
  rebalanceThreshold: number; // drift fraction to trigger rebalance (e.g. 0.10)
}

/** Multiply-specific settings */
export interface MultiplySettings {
  maxLeverage: number;   // e.g. 5
  minSpread: number;     // min (stakingAPY - borrowAPY) to open, e.g. 1.0 (percent)
  maxLtv: number;        // alert threshold, e.g. 0.85
  preferredMarket: string; // Jito market address
}

/** Jupiter-specific settings */
export interface JupiterSettings {
  slippageBps: number;    // e.g. 50 (0.5%)
  preferDirect: boolean;  // prefer direct routes
  maxAccounts: number;    // max accounts for tx size
}

/** Performance log entry (extended) */
export interface PerformanceLogEntry {
  timestamp: string;
  solBalance: string;
  usdcBalance: string;
  jitosolBalance: string;
  klendValueUsd: string;
  multiplyValueUsd: string;
  totalValueUsd: string;
  blendedApy: string;
  action: string;
}

// ─── Constants ──────────────────────────────────────────────────

export const TOKEN_MINTS: { [key: string]: string } = {
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'SOL': 'So11111111111111111111111111111111111111112',
  'JitoSOL': 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'mSOL': 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
};

export const TOKEN_DECIMALS: { [key: string]: number } = {
  'USDC': 6,
  'USDT': 6,
  'SOL': 9,
  'JitoSOL': 9,
  'mSOL': 9,
  'BONK': 5,
};

export const KNOWN_VAULTS: { [key: string]: string } = {
  'USDC_EARN_MAIN': 'HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E',
  'SOL_EARN_MAIN': 'D6qrPVfqPRREozFNXaAMt9XWsxDcz8DkYSKJxvvZLK4c',
};

/** Known Kamino market addresses */
export const KAMINO_MARKETS = {
  MAIN: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
  JITO: 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek', // Jito isolated market
  ALTCOINS: 'ByYiZxp8QrdN9qbdtaAiePN8AAr3qvTPppNJDpf5DVJ5',
};
