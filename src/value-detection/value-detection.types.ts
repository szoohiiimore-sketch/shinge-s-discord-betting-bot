export type ValueDetectionDecision =
  | 'DETECTED'
  | 'REJECTED'
  | 'INSUFFICIENT_MARKET_DATA'
  | 'INVALID_DATA'
  | 'ODDS_FILTERED';

export interface ValueDetectionResult {
  readonly matchesAnalyzed: number;
  readonly opportunitiesDetected: number;
  readonly opportunitiesRejected: number;
  readonly opportunitiesSkipped: number;
  readonly durationMs: number;
}

export interface ValueOpportunityInsert {
  readonly matchId: string;
  readonly sport: string;
  readonly bookmaker: string;
  readonly outcome: string;
  readonly bookmakerOdds: number;
  readonly fairOdds: number;
  readonly edgePercentage: number;
  readonly consensusProbability: number;
  readonly consensusBookmakers: string[];
  readonly capturedAt: Date;
}
