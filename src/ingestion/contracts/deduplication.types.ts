/** Lookup key used to check for an existing Sport before upserting. */
export interface SportDeduplicationKey {
  readonly slug: string;
}

/** Lookup key used to check for an existing League before upserting. */
export interface LeagueDeduplicationKey {
  readonly externalId: string;
  readonly sportSlug: string;
}

/** Lookup key used to check for an existing Team before upserting. */
export interface TeamDeduplicationKey {
  readonly externalId: string;
  readonly sportSlug: string;
}

/** Lookup key used to check for an existing Match before upserting. */
export interface MatchDeduplicationKey {
  readonly externalId: string;
}

/**
 * The outcome of a single entity write attempt.
 * created: entity did not exist and was inserted.
 * updated: entity existed and mutable fields were changed.
 * skipped: entity existed and no fields changed.
 */
export type EntityWriteAction = 'created' | 'updated' | 'skipped';

/** Aggregate write counts for one entity type across a sync batch. */
export interface EntityWriteOutcome {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
}
