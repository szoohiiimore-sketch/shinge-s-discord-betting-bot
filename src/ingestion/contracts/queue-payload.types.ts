import type { EsportsVideogame } from './source.types';

/** Job data for the sync-traditional-sport queue job. */
export interface SyncTraditionalSportJobData {
  readonly sportKey: string;
}

/** Job data for the sync-esports-game queue job. */
export interface SyncEsportsGameJobData {
  readonly videogame: EsportsVideogame;
}

/**
 * Job data for the sync-reference-data queue job.
 * No payload is required — the job fetches the complete sports list from The Odds API.
 */
export type SyncReferenceDataJobData = Record<string, never>;

/** All valid job names for the match-fetch queue. */
export type MatchFetchJobName =
  | 'sync-traditional-sport'
  | 'sync-esports-game'
  | 'sync-reference-data';

/**
 * Discriminated union of all match-fetch job payloads.
 * The name field is the BullMQ job name and acts as the discriminant.
 */
export type MatchFetchJobPayload =
  | { readonly name: 'sync-traditional-sport'; readonly data: SyncTraditionalSportJobData }
  | { readonly name: 'sync-esports-game'; readonly data: SyncEsportsGameJobData }
  | { readonly name: 'sync-reference-data'; readonly data: SyncReferenceDataJobData };
