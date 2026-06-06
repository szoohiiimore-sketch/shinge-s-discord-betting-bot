import type {
  SportDeduplicationKey,
  EntityWriteAction,
} from '@/ingestion/contracts';
import type { CanonicalSport } from '@/ingestion/contracts';

/**
 * Repository contract for idempotent Sport persistence.
 *
 * Lookup by slug (unique key). Upsert behaviour:
 * - Match: update name, status if changed
 * - Miss: insert new record
 *
 * Requires the Sport's parent Sport to already exist (Sport has no parent).
 */
export interface SportRepository {
  /**
   * Resolves a Sport's canonical ID by its deduplication key.
   * Returns the internal UUID if the record exists, null otherwise.
   */
  findId(key: SportDeduplicationKey): Promise<string | null>;

  /**
   * Idempotent upsert: inserts if not exists, updates mutable fields if changed.
   * The slug is the stable lookup key.
   * Returns the internal UUID and the action taken.
   */
  upsert(input: CanonicalSport): Promise<{ id: string; action: EntityWriteAction }>;

  /**
   * Batch upsert for multiple sports in a single transaction.
   * Each upsert is independent — failure of one does not roll back others.
   * Returns the action breakdown for the batch.
   */
  upsertMany(inputs: readonly CanonicalSport[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }>;
}