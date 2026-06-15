export type ValueDetectionDecision =
  | 'DETECTED'
  | 'DETECTED_SHADOW'
  | 'REJECTED'
  | 'INSUFFICIENT_MARKET_DATA'
  | 'INVALID_DATA'
  | 'ODDS_FILTERED'
  | 'EXCHANGE_EXCLUDED'
  | 'SUPPRESSED';

/** Which live detection track produced an opportunity (4-track A/B). */
export type DetectionModelName = 'LEGACY' | 'PINNACLE_LED' | 'LOW_ODDS_LEGACY' | 'LOW_ODDS_PINNACLE_LED' | 'SHARP_FINAL' | 'SHARP_FINAL_LOW' | 'SHARP_FINAL_V2' | 'SHARP_FINAL_LOW_V2' | 'LEGACY_QUALITY';

export interface ValueDetectionResult {
  readonly matchesAnalyzed: number;
  /** Production opportunities: edge >= PRODUCTION_EDGE_THRESHOLD (3%). Triggers Discord alerts. */
  readonly opportunitiesDetected: number;
  /** Opportunities detected by the parallel LEGACY model (always production tier). */
  readonly legacyOpportunitiesDetected: number;
  /** Opportunities claimed by the LOW ODDS tracks (both families). */
  readonly lowOddsOpportunitiesDetected: number;
  /** Shadow opportunities: edge >= SHADOW_EDGE_THRESHOLD (2%) and < PRODUCTION_EDGE_THRESHOLD (3%). Stored silently for CLV/calibration analysis only. */
  readonly shadowOpportunitiesDetected: number;
  readonly opportunitiesRejected: number;
  readonly opportunitiesSkipped: number;
  readonly durationMs: number;
}

export interface ValueOpportunityInsert {
  readonly matchId: string;
  readonly sport: string;
  /** The soft candidate bookmaker offering the value price (never the reference book). */
  readonly bookmaker: string;
  readonly outcome: string;
  /** The candidate bookmaker's price. */
  readonly bookmakerOdds: number;
  /** De-vigged fair odds derived from the reference book (Pinnacle). */
  readonly fairOdds: number;
  readonly edgePercentage: number;
  /** De-vigged fair probability derived from the reference book (Pinnacle). */
  readonly consensusProbability: number;
  /** The reference book(s) the fair price was derived from — ['pinnacle'] under the Pinnacle-led model. */
  readonly consensusBookmakers: string[];
  readonly capturedAt: Date;
  /**
   * When true, edge was in the shadow tier (>= 2% and < 3%).
   * Shadow rows are stored for CLV/calibration analysis but never send Discord alerts
   * and are excluded from production ROI metrics.
   */
  readonly isShadow: boolean;
  /**
   * Pinnacle price movement % for the alerted outcome over the trailing window at capture:
   * (latest price / oldest price in window − 1) × 100. Negative = price shortened (market
   * moved toward the outcome). Null when no earlier Pinnacle snapshot exists in the window.
   * Analytics only — never used by detection, alerting, or settlement.
   */
  readonly pinnacleMove1h: number | null;
  readonly pinnacleMove6h: number | null;
  readonly pinnacleMove24h: number | null;
  /** Producing model — attribution survives the entire pipeline. */
  readonly model: DetectionModelName;
  /** Legacy-family confidence grade (A/B/C); null for pinnacle-family rows. */
  readonly confidence?: string | null;
}
