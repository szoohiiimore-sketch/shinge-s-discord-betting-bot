import type { PrismaClient } from '@prisma/client';
import type { OddsSnapshotRepository as IOddsSnapshotRepository } from '@/ingestion/repositories/contracts';
import type { CanonicalOddsSnapshot } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';

export class OddsSnapshotRepository implements IOddsSnapshotRepository {
  private readonly _prisma: PrismaClient;
  private readonly _logger: Logger;

  constructor(prisma: PrismaClient, logger: Logger) {
    this._prisma = prisma;
    this._logger = logger.child({ repository: 'OddsSnapshotRepository' });
  }

  async insert(input: CanonicalOddsSnapshot): Promise<{ id: string }> {
    try {
      const matchId = await this._resolveMatchId(input.matchExternalId);
      const created = await this._prisma.oddsSnapshot.create({
        data: {
          matchId,
          bookmaker: input.bookmaker,
          market: input.market,
          outcome: input.outcome,
          price: input.price,
          isMain: input.isMain,
          isLive: input.isLive,
          capturedAt: input.capturedAt,
        },
        select: { id: true },
      });
      return { id: created.id };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(
        err,
        `Failed to insert odds snapshot for match: ${input.matchExternalId}`,
      );
    }
  }

  /**
   * Batch insert using a single createMany call for efficiency.
   * All inputs must reference match externalIds that already exist in the database.
   * Returns the count of inserted records; ids is empty since createMany does not
   * return individual generated IDs.
   */
  async insertMany(inputs: readonly CanonicalOddsSnapshot[]): Promise<{
    inserted: number;
    ids: string[];
  }> {
    if (inputs.length === 0) {
      return { inserted: 0, ids: [] };
    }

    try {
      const matchIdMap = await this._buildMatchIdMap(inputs);

      const data = inputs.map(snapshot => ({
        matchId: matchIdMap.get(snapshot.matchExternalId)!,
        bookmaker: snapshot.bookmaker,
        market: snapshot.market,
        outcome: snapshot.outcome,
        price: snapshot.price,
        isMain: snapshot.isMain,
        isLive: snapshot.isLive,
        capturedAt: snapshot.capturedAt,
      }));

      const result = await this._prisma.oddsSnapshot.createMany({ data });
      this._logger.debug({ count: result.count }, 'OddsSnapshots batch inserted');
      return { inserted: result.count, ids: [] };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, 'Failed to batch insert odds snapshots');
    }
  }

  /**
   * Resolves a single match externalId to its internal UUID.
   * Throws DatabaseError if the match does not exist.
   */
  private async _resolveMatchId(matchExternalId: string): Promise<string> {
    const match = await this._prisma.match.findUnique({
      where: { externalId: matchExternalId },
      select: { id: true },
    });
    if (!match) {
      throw new DatabaseError(`Match not found: ${matchExternalId}`, {
        retryable: false,
        context: { matchExternalId },
      });
    }
    return match.id;
  }

  /**
   * Resolves all unique matchExternalIds in the batch to internal UUIDs.
   * Uses a single findMany query for efficiency.
   * Throws DatabaseError if any referenced match is not found.
   */
  private async _buildMatchIdMap(
    inputs: readonly CanonicalOddsSnapshot[],
  ): Promise<Map<string, string>> {
    const externalIds = [...new Set(inputs.map(s => s.matchExternalId))];

    const matches = await this._prisma.match.findMany({
      where: { externalId: { in: externalIds } },
      select: { id: true, externalId: true },
    });

    const map = new Map<string, string>(matches.map(m => [m.externalId, m.id]));

    const missing = externalIds.filter(id => !map.has(id));
    if (missing.length > 0) {
      throw new DatabaseError(`Matches not found: ${missing.join(', ')}`, {
        retryable: false,
        context: { missingExternalIds: missing },
      });
    }

    return map;
  }
}
