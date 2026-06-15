/**
 * Historical CSV replay seed — AGGREGATE-ONLY summary of the football-data.co.uk
 * replay (scripts/backtest/csv-replay.ts). This is the ONLY thing that survives
 * the replay: the replay itself is in-memory, temporary, and disposable and
 * writes NO ValueOpportunity rows, NO settlement rows, NO backtest_* rows, NO
 * Redis, NO Supabase. See docs/audits/HISTORICAL_CSV_REPLAY_SYSTEM.md.
 *
 * Kept strictly separate from Live (real settlements) and Historical (the
 * immutable in-play-inferred backtest seed). /roi renders all three side by side.
 */
import type { DetectionModelValue } from './reporting-config';

export interface CsvModelStats {
  /** Matches the model was evaluated over (had a usable Pinnacle reference). */
  readonly matchesProcessed: number;
  /** Settled idea-level alerts (every CSV match has a known result → all settle). */
  readonly alerts: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly winRatePct: number | null;
  readonly avgOdds: number | null;
  readonly avgEdgePct: number | null;
  /** Idea-level flat-1u ROI — identical methodology to the live/seed reporting. */
  readonly roiPct: number | null;
  readonly profitUnits: number;
}

export interface CsvDataset {
  readonly files: number;
  readonly matchesTotal: number;
  readonly matchesWithReference: number;
  readonly leagues: number;
  readonly seasons: number;
  readonly dateRange: string;
  /** Matches detected on pre-match odds (high fidelity). */
  readonly prematchMatches: number;
  /** Matches detected on closing-only odds (approximation — sharper lines, fewer books). */
  readonly closingOnlyMatches: number;
}

export interface HistoricalCsvSeed {
  readonly generatedAt: string;
  readonly dataset: CsvDataset;
  /** All matches (pre-match + closing-only). Headline for /roi (max sample). */
  readonly models: Readonly<Record<DetectionModelValue, CsvModelStats>>;
  /** High-fidelity subset: matches detected on PRE-MATCH odds only. */
  readonly modelsPrematch: Readonly<Record<DetectionModelValue, CsvModelStats>>;
}

export { HISTORICAL_CSV_SEED } from './historical-csv-seed.data';
