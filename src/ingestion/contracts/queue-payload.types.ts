import type { EsportsVideogame } from './source.types';

/** Job data for the sync-traditional-sport queue job. */
export interface SyncTraditionalSportJobData {
  readonly sportKey: string;
  /** The Odds API group field (e.g. "Soccer") — used to derive the canonical sport slug. */
  readonly sportGroup: string;
}

/** Job data for the sync-odds-for-sport queue job. */
export interface SyncOddsForSportJobData {
  readonly sportKey: string;
  /** The Odds API group field — used to derive the canonical sport slug. */
  readonly sportGroup: string;
  /** "oa:"-prefixed match external IDs to fetch odds for. */
  readonly matchExternalIds: readonly string[];
}

/** Job data for the sync-esports-game queue job. */
export interface SyncEsportsGameJobData {
  readonly videogame: EsportsVideogame;
}

/** Job data for the sync-esports-odds queue job. */
export interface SyncEsportsOddsJobData {
  readonly videogame: EsportsVideogame;
  /**
   * "ps:"-prefixed match external IDs from the preceding sync-esports-game job.
   * Only the 4 OddsPapi-supported games appear here.
   */
  readonly matchExternalIds: readonly string[];
}

/**
 * Job data for the sync-reference-data queue job.
 * No payload is required — the job fetches the complete sports list from The Odds API.
 */
export type SyncReferenceDataJobData = Record<string, never>;

/** Job data for the settle-matches queue job. No payload required. */
export type SettleMatchesJobData = Record<string, never>;

/** Job data for the daily-summary queue job. No payload required. */
export type DailySummaryJobData = Record<string, never>;

/** All valid job names for the match-fetch queue. */
export type MatchFetchJobName =
  | 'sync-traditional-sport'
  | 'sync-esports-game'
  | 'sync-reference-data'
  | 'settle-matches'
  | 'daily-summary';

/**
 * Discriminated union of all match-fetch job payloads.
 * The name field is the BullMQ job name and acts as the discriminant.
 */
export type MatchFetchJobPayload =
  | { readonly name: 'sync-traditional-sport'; readonly data: SyncTraditionalSportJobData }
  | { readonly name: 'sync-esports-game'; readonly data: SyncEsportsGameJobData }
  | { readonly name: 'sync-reference-data'; readonly data: SyncReferenceDataJobData }
  | { readonly name: 'settle-matches'; readonly data: SettleMatchesJobData }
  | { readonly name: 'daily-summary'; readonly data: DailySummaryJobData };

/**
 * Discriminated union of all odds-fetch job payloads.
 * The name field is the BullMQ job name and acts as the discriminant.
 */
export type OddsFetchJobPayload =
  | { readonly name: 'sync-odds-for-sport'; readonly data: SyncOddsForSportJobData }
  | { readonly name: 'sync-esports-odds'; readonly data: SyncEsportsOddsJobData };