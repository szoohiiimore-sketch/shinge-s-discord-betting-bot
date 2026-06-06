import type { EntityWriteAction } from '@/ingestion/contracts';
import type { CanonicalTeamLeague } from '@/ingestion/contracts';

/**
 * Repository contract for idempotent TeamLeague junction persistence.
 *
 * Lookup by (teamId, leagueId) composite unique key.
 * Upsert behaviour:
 * - Match: no-op (record exists, status remains ACTIVE)
 * - Miss: insert new record
 *
 * Requires the parent Team and League to already exist.
 * TeamLeague records are never updated or deleted in V1.
 */
export interface TeamLeagueRepository {
  /**
   * Idempotent upsert: creates a TeamLeague record if it does not already exist.
   * Resolves team and league internal UUIDs from their canonical external IDs.
   * Returns the internal UUID and the action taken (created or skipped).
   */
  upsert(input: CanonicalTeamLeague): Promise<{ id: string; action: EntityWriteAction }>;

  /**
   * Batch upsert for multiple TeamLeague records.
   * Each upsert is independent — failure of one does not roll back others.
   */
  upsertMany(inputs: readonly CanonicalTeamLeague[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }>;
}
