import type {
  LeagueDeduplicationKey,
  EntityWriteAction,
} from '@/ingestion/contracts';
import type { CanonicalLeague } from '@/ingestion/contracts';

/**
 * Repository contract for idempotent League persistence.
 *
 * Lookup by (sportId, externalId) via the LeagueDeduplicationKey.
 * The externalId is source-namespaced: "oa:{key}" for The Odds API, "ps:{id}" for PandaScore.
 * Upsert behaviour:
 * - Match: update name, slug, status if changed
 * - Miss: insert new record
 *
 * Requires the parent Sport to already exist (referenced via sportSlug).
 */
export interface LeagueRepository {
  /**
   * Resolves a League's canonical ID by its deduplication key.
   * Returns the internal UUID if the record exists, null otherwise.
   */
  findId(key: LeagueDeduplicationKey): Promise<string | null>;

  /**
   * Idempotent upsert: inserts if not exists, updates mutable fields if changed.
   * Lookup is by (sportSlug, externalId) via slug-to-id resolution internally.
   * Returns the internal UUID and the action taken.
   */
  upsert(input: CanonicalLeague): Promise<{ id: string; action: EntityWriteAction }>;

  /**
   * Batch upsert for multiple leagues in a single transaction.
   * Each upsert is independent — failure of one does not roll back others.
   */
  upsertMany(inputs: readonly CanonicalLeague[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }>;
}