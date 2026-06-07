import type {
  MatchDeduplicationKey,
  EntityWriteAction,
} from '@/ingestion/contracts';
import type { MatchUpsertInput } from '@/ingestion/contracts';

/**
 * Repository contract for idempotent Match persistence.
 *
 * Lookup by externalId (globally unique, source-namespaced).
 * Uses the explicit create/update split from MatchUpsertInput:
 * - create: all fields required for initial INSERT
 * - update: only mutable fields (status, scores, result, lastFetchedAt)
 *
 * The following fields must never change after creation:
 * externalId, sportId, leagueId, homeTeamId, awayTeamId, startTime.
 *
 * Requires Sport, League, homeTeam, and awayTeam to already exist.
 */
export interface MatchRepository {
  /**
   * Resolves a Match's canonical ID by its externalId.
   * Returns the internal UUID if the record exists, null otherwise.
   */
  findId(key: MatchDeduplicationKey): Promise<string | null>;

  /**
   * Loads multiple matches with their team names by external IDs.
   * Used by the esports odds correlation step to match OddsPapi matches
   * against DB matches using team name + time proximity.
   */
  findManyWithTeamsByExternalIds(
    externalIds: readonly string[],
  ): Promise<Array<{
    id: string;
    externalId: string;
    startTime: Date;
    homeTeam: { id: string; name: string };
    awayTeam: { id: string; name: string };
  }>>;

  /**
   * Idempotent upsert with explicit create/update split.
   *
   * If the externalId does not exist: INSERT using the create payload.
   * If the externalId exists: UPDATE only the mutable fields from the update payload.
   *
   * Returns the internal UUID and the action taken.
   */
  upsert(input: MatchUpsertInput): Promise<{ id: string; action: EntityWriteAction }>;

  /**
   * Batch upsert for multiple matches in a single transaction.
   * Each upsert is independent — failure of one does not roll back others.
   */
  upsertMany(inputs: readonly MatchUpsertInput[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }>;
}