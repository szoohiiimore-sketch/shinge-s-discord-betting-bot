import type { EntityWriteOutcome, SyncError } from '@/ingestion/contracts';

/**
 * Result returned by ReferenceDataIngestionService.sync().
 * Captures the outcome of a single reference data sync run (Sports + Leagues from The Odds API).
 * Workers compose this into the broader ReferenceSyncResult with timing from their own context.
 */
export interface ReferenceIngestionResult {
  readonly sports: EntityWriteOutcome;
  readonly leagues: EntityWriteOutcome;
  readonly errors: readonly SyncError[];
  readonly durationMs: number;
}

/**
 * Result returned by MatchIngestionService.ingestTraditionalSport().
 * Covers one Odds API sport key: Sports, Leagues, Teams, Matches, TeamLeagues.
 * nearTermMatchExternalIds is the list of "oa:"-prefixed match externalIds whose
 * startTime falls within the 48-hour window — these are passed to the odds worker.
 */
export interface TraditionalMatchIngestionResult {
  readonly sports: EntityWriteOutcome;
  readonly leagues: EntityWriteOutcome;
  readonly teams: EntityWriteOutcome;
  readonly matches: EntityWriteOutcome;
  readonly nearTermMatchExternalIds: readonly string[];
  readonly errors: readonly SyncError[];
  readonly durationMs: number;
}

/**
 * Result returned by MatchIngestionService.ingestEsportsGame().
 * Covers one PandaScore videogame: Sports, Leagues, Teams, Matches, TeamLeagues.
 * skippedMatches counts matches rejected by the mapper (TBD opponents, missing start time).
 */
export interface EsportsMatchIngestionResult {
  readonly sports: EntityWriteOutcome;
  readonly leagues: EntityWriteOutcome;
  readonly teams: EntityWriteOutcome;
  readonly matches: EntityWriteOutcome;
  readonly skippedMatches: number;
  readonly errors: readonly SyncError[];
  readonly durationMs: number;
}

/**
 * Result returned by OddsSnapshotIngestionService.ingestOddsForSport().
 * Covers one Odds API sport key filtered to specific match external IDs.
 * OddsSnapshot records are always appended; updated and skipped are always 0.
 */
export interface OddsSnapshotIngestionResult {
  readonly oddsSnapshots: EntityWriteOutcome;
  readonly errors: readonly SyncError[];
  readonly durationMs: number;
}
