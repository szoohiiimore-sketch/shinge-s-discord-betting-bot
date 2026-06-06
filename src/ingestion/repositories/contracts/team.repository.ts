import type {
  TeamDeduplicationKey,
  EntityWriteAction,
} from '@/ingestion/contracts';
import type { CanonicalTeam } from '@/ingestion/contracts';

/**
 * Repository contract for idempotent Team persistence.
 *
 * Lookup by (sportId, externalId) via the TeamDeduplicationKey.
 * For The Odds API, the externalId is synthesized by slugifying the team name.
 * For PandaScore, the externalId is source-namespaced: "ps:{id}".
 * Upsert behaviour:
 * - Match: update name, slug if changed
 * - Miss: insert new record
 *
 * Requires the parent Sport to already exist (referenced via sportSlug).
 */
export interface TeamRepository {
  /**
   * Resolves a Team's canonical ID by its deduplication key.
   * Returns the internal UUID if the record exists, null otherwise.
   */
  findId(key: TeamDeduplicationKey): Promise<string | null>;

  /**
   * Idempotent upsert: inserts if not exists, updates mutable fields if changed.
   * Lookup is by (sportSlug, externalId) via slug-to-id resolution internally.
   * Returns the internal UUID and the action taken.
   */
  upsert(input: CanonicalTeam): Promise<{ id: string; action: EntityWriteAction }>;

  /**
   * Batch upsert for multiple teams in a single transaction.
   * Each upsert is independent — failure of one does not roll back others.
   */
  upsertMany(inputs: readonly CanonicalTeam[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }>;
}