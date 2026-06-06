import type { CanonicalOddsSnapshot } from '@/ingestion/contracts';

/**
 * Repository contract for append-only OddsSnapshot persistence.
 *
 * OddsSnapshot records are never updated or deleted — only inserted.
 * No deduplication is applied; each ingestion run adds new records
 * with the current capturedAt timestamp.
 *
 * The consumer (analysis service) retrieves the most recent snapshot
 * per (matchId, bookmaker, market, outcome) ordered by capturedAt.
 */
export interface OddsSnapshotRepository {
  /**
   * Inserts a single OddsSnapshot record.
   * matchExternalId is resolved to the internal Match UUID internally.
   * Returns the internal UUID of the inserted record.
   */
  insert(input: CanonicalOddsSnapshot): Promise<{ id: string }>;

  /**
   * Batch insert for multiple OddsSnapshot records in a single transaction.
   * All inserts in the batch share the same capturedAt timestamp.
   * Failure of one insert does not roll back others.
   */
  insertMany(inputs: readonly CanonicalOddsSnapshot[]): Promise<{
    inserted: number;
    ids: string[];
  }>;
}