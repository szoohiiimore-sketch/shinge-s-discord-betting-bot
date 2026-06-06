import type { PrismaClient } from '@prisma/client';
import type { TeamRepository as ITeamRepository } from '@/ingestion/repositories/contracts';
import type { TeamDeduplicationKey, EntityWriteAction, CanonicalTeam } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';

const UPSERT_CONCURRENCY = 10;

export class TeamRepository implements ITeamRepository {
  private readonly _prisma: PrismaClient;
  private readonly _logger: Logger;

  constructor(prisma: PrismaClient, logger: Logger) {
    this._prisma = prisma;
    this._logger = logger.child({ repository: 'TeamRepository' });
  }

  async findId(key: TeamDeduplicationKey): Promise<string | null> {
    try {
      const sportId = await this._resolveSportId(key.sportSlug);
      const record = await this._prisma.team.findUnique({
        where: { sportId_externalId: { sportId, externalId: key.externalId } },
        select: { id: true },
      });
      return record?.id ?? null;
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, `Failed to find team: ${key.externalId}`);
    }
  }

  async upsert(input: CanonicalTeam): Promise<{ id: string; action: EntityWriteAction }> {
    try {
      const sportId = await this._resolveSportId(input.sportSlug);
      // Native upsert is atomic — concurrent calls with the same (sportId, externalId)
      // will not race to a P2002. Prisma's @updatedAt is bumped on every update path,
      // so action is 'created' when createdAt === updatedAt, 'updated' otherwise.
      const record = await this._prisma.team.upsert({
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
        'Team upserted',
      );
      return { id: record.id, action };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, `Failed to upsert team: ${input.externalId}`);
    }
  }

  async upsertMany(inputs: readonly CanonicalTeam[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }> {
    // Deduplicate by (sportSlug, externalId) — the same team appears in multiple
    // match fixtures within a single sync batch (both home and away across games).
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
