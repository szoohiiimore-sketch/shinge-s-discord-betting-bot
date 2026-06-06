import type { EsportsVideogame, IngestionEntityType } from './source.types';
import type { EntityWriteOutcome } from './deduplication.types';

/** A single non-fatal error captured during a sync run. */
export interface SyncError {
  readonly entityType: IngestionEntityType;
  readonly entityKey: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Result of a traditional sport sync run (sync-traditional-sport job).
 * Covers one sportKey from The Odds API: all matches, teams, leagues, and bookmaker odds.
 */
export interface TraditionalSportSyncResult {
  readonly sportKey: string;
  readonly matchesProcessed: number;
  readonly sports: EntityWriteOutcome;
  readonly leagues: EntityWriteOutcome;
  readonly teams: EntityWriteOutcome;
  readonly matches: EntityWriteOutcome;
  readonly oddsSnapshots: EntityWriteOutcome;
  readonly errors: readonly SyncError[];
  readonly completedAt: Date;
  readonly durationMs: number;
}

/**
 * Result of an esports game sync run (sync-esports-game job).
 * Covers one videogame from PandaScore: all matches, teams, and leagues.
 * No oddsSnapshots: PandaScore has no bookmaker odds endpoints (V1 structural constraint).
 */
export interface EsportsGameSyncResult {
  readonly videogame: EsportsVideogame;
  readonly matchesProcessed: number;
  readonly sports: EntityWriteOutcome;
  readonly leagues: EntityWriteOutcome;
  readonly teams: EntityWriteOutcome;
  readonly matches: EntityWriteOutcome;
  readonly errors: readonly SyncError[];
  readonly completedAt: Date;
  readonly durationMs: number;
}

/**
 * Result of a reference data sync run (sync-reference-data job).
 * Hydrates the Sport and League reference tables from The Odds API sports list.
 */
export interface ReferenceSyncResult {
  readonly sports: EntityWriteOutcome;
  readonly leagues: EntityWriteOutcome;
  readonly errors: readonly SyncError[];
  readonly completedAt: Date;
  readonly durationMs: number;
}
