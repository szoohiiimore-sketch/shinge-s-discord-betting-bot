/**
 * Historical Backtesting Engine — shared types.
 *
 * IMPORTANT: nothing under src/backtest may ever be imported by the live
 * application. The engine is offline-only (driven by scripts/backtest/*) and
 * writes exclusively to the historical_* / backtest_* tables.
 * See docs/audits/HISTORICAL_BACKTESTING_ENGINE_DESIGN.md.
 */
import type { DetectorConfig } from '@/value-detection/detector-core';

export type CadenceMode = 'live-cadence' | 'full-resolution';

/**
 * Optional movement filter — a research feature expressed as config, never a
 * code fork. A candidate passes when its reference movement over the window
 * satisfies the bounds. Example (steam-in only): { window: '6h', maxMovePct: -1 }.
 */
export interface MovementFilterConfig {
  readonly window: '1h' | '6h' | '24h';
  /** Keep candidates with movement >= this (price drifting out). */
  readonly minMovePct?: number;
  /** Keep candidates with movement <= this (negative = price shortening / steam-in). */
  readonly maxMovePct?: number;
  /** When true, candidates with no movement history are dropped too. Default: kept. */
  readonly dropNullMovement?: boolean;
}

/**
 * Full configuration of one backtest run. Frozen (JSON-serialized into
 * backtest_runs.config) before the replay starts — no mid-run changes.
 */
export interface BacktestRunConfig {
  readonly name: string;
  /**
   * Which detection model the replay runs. Default 'pinnacle-led' (the shared
   * production core). 'legacy' uses the reconstructed pre-rewrite model
   * (src/backtest/legacy-detector-core.ts) with its 12h-window dedup.
   */
  readonly model?: 'pinnacle-led' | 'legacy';
  /** Legacy model parameters; defaults to LEGACY_DETECTOR_CONFIG when model='legacy'. */
  readonly legacy?: import('@/value-detection/legacy-detector-core').LegacyDetectorConfig;
  /** Universe fixed ex ante (survivorship-bias guard) — never derived from results. */
  readonly sportKeys: readonly string[];
  readonly periodStart: string; // ISO timestamp
  readonly periodEnd: string;   // ISO timestamp
  readonly cadenceMode: CadenceMode;
  /** live-cadence poll interval (minutes) when a sport has no explicit entry. */
  readonly liveCadenceDefaultMinutes: number;
  /** Per-sport poll intervals mirroring the production scheduler tiers. */
  readonly liveCadenceMinutesBySport?: Readonly<Record<string, number>>;
  /** The shared pure detector configuration — same shape production runs. */
  readonly detector: DetectorConfig;
  readonly movementFilter?: MovementFilterConfig;
}

/** One historical snapshot row as consumed by the replay engine. */
export interface ReplaySnapshotRow {
  readonly eventId: string;
  readonly sportKey: string;
  readonly bookmaker: string;
  readonly outcome: string;
  readonly price: number;
  readonly snapshotAt: Date;
  readonly commenceTime: Date;
}

/** One replay detection with its full feature vector (ML feature store row). */
export interface ReplayDetection {
  readonly eventId: string;
  readonly sportKey: string;
  readonly bookmaker: string;
  readonly outcome: string;
  readonly bookmakerOdds: number;
  readonly fairOdds: number;
  readonly edgePercentage: number;
  readonly consensusProbability: number;
  readonly isShadow: boolean;
  readonly detectedAt: Date;
  readonly commenceTime: Date;
  readonly referenceOverround: number;
  readonly bookmakerFamily: string;
  readonly minutesToKickoff: number;
  readonly pinnacleMove1h: number | null;
  readonly pinnacleMove6h: number | null;
  readonly pinnacleMove24h: number | null;
  readonly priceGapPct: number | null;
  readonly corroborationK: number;
}

export interface ReplayResult {
  readonly detections: readonly ReplayDetection[];
  /** Number of (sport, timestamp) cursor steps actually evaluated under the cadence mode. */
  readonly cursorsEvaluated: number;
  /** Number of (event, cursor) batches run through the detector core. */
  readonly batchesDetected: number;
  /** Per-decision tallies (unconditioned denominators — survivorship guard). */
  readonly decisionCounts: Readonly<Record<string, number>>;
  /** Candidates dropped by the movement filter (replay-only concept). */
  readonly movementFiltered: number;
  /** Candidates suppressed by run-scoped permanent dedup (mirrors live semantics). */
  readonly dedupSuppressed: number;
  /** (event, cursor) batches skipped because the cursor was at/after commence time. */
  readonly inPlaySkipped: number;
}
