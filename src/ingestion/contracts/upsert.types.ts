import type {
  CanonicalSport,
  CanonicalLeague,
  CanonicalTeam,
  CanonicalTeamLeague,
  CanonicalMatch,
  CanonicalOddsSnapshot,
} from './canonical.types';
import type { IngestionMatchStatus, IngestionMatchResult } from './source.types';

/** Sport entity is fully described by its canonical form — no create/update split needed. */
export type SportUpsertInput = CanonicalSport;

/** League entity is fully described by its canonical form — no create/update split needed. */
export type LeagueUpsertInput = CanonicalLeague;

/** Team entity is fully described by its canonical form — no create/update split needed. */
export type TeamUpsertInput = CanonicalTeam;

/** TeamLeague membership is fully described by its canonical form — no create/update split needed. */
export type TeamLeagueUpsertInput = CanonicalTeamLeague;

/**
 * Mutable fields that may change across Match ingestion runs.
 * Immutable structural fields (externalId, teams, league, startTime) are excluded.
 * lastFetchedAt records when this match was last seen by the ingestion layer.
 */
export interface MatchUpdateFields {
  readonly status: IngestionMatchStatus;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  readonly result: IngestionMatchResult | null;
  readonly lastFetchedAt: Date;
}

/**
 * Match upsert input with an explicit create/update split.
 * create: all fields required to INSERT a new Match row.
 * update: only the mutable subset applied when the externalId already exists.
 */
export interface MatchUpsertInput {
  readonly create: CanonicalMatch;
  readonly update: MatchUpdateFields;
}

/**
 * OddsSnapshot is append-only (never upserted).
 * Uses the canonical form directly as the insert payload.
 */
export type OddsSnapshotInsertInput = CanonicalOddsSnapshot;
