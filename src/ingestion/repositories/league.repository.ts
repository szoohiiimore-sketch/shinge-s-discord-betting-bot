import type { PrismaClient } from '@prisma/client';
import type { LeagueRepository as ILeagueRepository } from '@/ingestion/repositories/contracts';
import type { LeagueDeduplicationKey, EntityWriteAction, CanonicalLeague } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';

const UPSERT_CONCURRENCY = 10;

export class LeagueRepository implements ILeagueRepository {
  private readonly _prisma: PrismaClient;
  private readonly _logger: Logger;

  constructor(prisma: PrismaClient, logger: Logger) {
    this._prisma = prisma;
    this._logger = logger.child({ repository: 'LeagueRepository' });
  }

  async findId(key: LeagueDeduplicationKey): Promise<string | null> {
    try {
      const sportId = await this._resolveSportId(key.sportSlug);
      const record = await this._prisma.league.findUnique({
        where: { sportId_externalId: { sportId, externalId: key.externalId } },
        select: { id: true },
      });
      return record?.id ?? null;
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, `Failed to find league: ${key.externalId}`);
    }
  }

  async upsert(input: CanonicalLeague): Promise<{ id: string; action: EntityWriteAction }> {
    try {
      const sportId = await this._resolveSportId(input.sportSlug);
      // Native upsert is atomic — concurrent calls with the same (sportId, externalId)
      // will not race to a P2002. Prisma's @updatedAt is bumped on every update path,
      // so action is 'created' when createdAt === updatedAt, 'updated' otherwise.
      const record = await this._prisma.league.upsert({
        where: { sportId_externalId: { sportId, externalId: input.externalId } },
        create: {
          externalId: input.externalId,
          name: input.name,
          slug: input.slug,
          sportId,
        },
        update: { name: input.name, slug: input.slug },
        select: { id: true, createdAt: true, updatedAt: true },
      });
      const action: EntityWriteAction =
        record.createdAt.getTime() === record.updatedAt.getTime() ? 'created' : 'updated';
      this._logger.debug(
        { externalId: input.externalId, sportSlug: input.sportSlug, action },
        'League upserted',
      );
      return { id: record.id, action };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, `Failed to upsert league: ${input.externalId}`);
    }
  }

  async upsertMany(inputs: readonly CanonicalLeague[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }> {
    // Deduplicate by (sportSlug, externalId) — same league may appear across multiple
    // matches in the batch (e.g. every EPL match references the same EPL league record).
    const seen = new Set<string>();
    const unique = inputs.filter(i => {
      const key = `${i.sportSlug}:${i.externalId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const results: Array<{ id: string; action: EntityWriteAction }> = [];
    for (let i = 0; i < unique.length; i += UPSERT_CONCURRENCY) {
      const batch = unique.slice(i, i + UPSERT_CONCURRENCY);
      results.push(...(await Promise.all(batch.map(input => this.upsert(input)))));
    }
    return { results };
  }

  private async _resolveSportId(sportSlug: string): Promise<string> {
    const sport = await this._prisma.sport.findUnique({
      where: { slug: sportSlug },
      select: { id: true },
    });
    if (!sport) {
      throw new DatabaseError(`Sport not found for slug: ${sportSlug}`, {
        retryable: false,
        context: { sportSlug },
      });
    }
    return sport.id;
  }
}
