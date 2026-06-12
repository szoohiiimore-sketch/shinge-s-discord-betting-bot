/**
 * Historical Backtesting Engine — offline research platform.
 *
 * HARD RULE: nothing here may ever be imported by the live application
 * (src/main.ts dependency graph). Engine entry points live in scripts/backtest.
 * The engine shares pure functions WITH live code (detector-core,
 * idea-aggregation) — never the reverse.
 */
export type {
  CadenceMode,
  MovementFilterConfig,
  BacktestRunConfig,
  ReplaySnapshotRow,
  ReplayDetection,
  ReplayResult,
} from './types';
export { replaySnapshots } from './replay';
export {
  fetchHistoricalOdds,
  fetchHistoricalEvents,
  historicalOddsCreditCost,
} from './historical-api';
export type { HistoricalApiConfig, HistoricalOddsResponse, HistoricalEventsResponse } from './historical-api';
export { runBackfill } from './backfill';
export type { BackfillPlan, BackfillSummary } from './backfill';
export {
  createRun,
  loadReplayRows,
  insertDetections,
  markRunStatus,
  getCodeVersion,
  MOVEMENT_WARMUP_HOURS,
} from './run-store';
export { scoreRunClv } from './scoring';
export type { ClvScoreSummary } from './scoring';
export { renderRunReport, renderRunComparison, clvStats, ideasForTier, loadReportRows } from './reporting';
export type { ReportRow, ClvStats } from './reporting';
export { inferResults, settleRun, loadInplayEvidence, WIN_PRICE, LOSS_PRICE, minElapsedMinutes } from './results';
export type { ResultInferenceSummary, RunSettlementSummary, OutcomeEvidence } from './results';
export { loadRoiRows, ideasAtThreshold, roiStats, roiLine, segmentRoi, movementClass6h } from './roi-reporting';
export type { RoiRow, RoiStats } from './roi-reporting';
export { legacyDetectFromBatch, LEGACY_DETECTOR_CONFIG } from '@/value-detection/legacy-detector-core';
export type { LegacyDetectorConfig } from '@/value-detection/legacy-detector-core';
