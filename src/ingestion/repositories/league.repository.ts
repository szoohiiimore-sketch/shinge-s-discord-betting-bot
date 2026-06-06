import type { PrismaClient } from '@prisma/client';
import type { LeagueRepository as ILeagueRepository } from '@/ingestion/repositories/contracts';
import type { LeagueDeduplicationKey, EntityWriteAction, CanonicalLeague } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';

export class LeagueRepository implements ILeagueRepository {
  private readonly _prisma: PrismaClient;
  private readonly _logger: Logger;

  constructor(prisma: PrismaClient, logger: Logger) {
    this._prisma = prisma;
    this._logger = logger.child({ repository: 'LeagueRepository' });
  }

  /**
   * Resolves a league ID by externalId alone.
   * Uses findFirst because the schema unique key is (sportId, externalId).
   * Safe in practice: The Odds API sport keys and PandaScore league IDs
   * are globally unique within their respective domains, and domains do not overlap.
   */
  async findId(key: LeagueDeduplicationKey): Promise<string | null> {
    try {
      const record = await this._prisma.league.findFirst({
        where: { externalId: key.externalId },
        select: { id: true },
      });
      return record?.id ?? null;
    } catch (err) {
      throw translatePrismaError(err, `Failed to find league: ${key.externalId}`);
    }
  }

  async upsert(input: CanonicalLeague): Promise<{ id: string; action: EntityWriteAction }> {
    try {
      const sportId = await this._resolveSportId(input.sportSlug);

      const existing = await this._prisma.league.findUnique({
        where: { sportId_externalId: { sportId, externalId: input.externalId } },
        select: { id: true, name: true, slug: true },
      });

      if (!existing) {
        const created = await this._prisma.league.create({
          data: {
            externalId: input.externalId,
            name: input.name,
            slug: input.slug,
            sportId,
          },
          select: { id: true },
        });
        this._logger.debug({ externalId: input.externalId, sportSlug: input.sportSlug }, 'League created');
        return { id: created.id, action: 'created' };
      }

      if (existing.name !== input.name || existing.slug !== input.slug) {
        await this._prisma.league.update({
          where: { sportId_externalId: { sportId, externalId: input.externalId } },
          data: { name: input.name, slug: input.slug },
        });
        this._logger.debug({ externalId: input.externalId }, 'League updated');
        return { id: existing.id, action: 'updated' };
      }

      return { id: existing.id, action: 'skipped' };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, `Failed to upsert league: ${input.externalId}`);
    }
  }

  async upsertMany(inputs: readonly CanonicalLeague[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }> {
    const results = await Promise.all(inputs.map(input => this.upsert(input)));
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
