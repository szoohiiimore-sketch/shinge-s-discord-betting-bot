import type { PrismaClient } from '@prisma/client';
import type { TeamLeagueRepository as ITeamLeagueRepository } from '@/ingestion/repositories/contracts';
import type { EntityWriteAction, CanonicalTeamLeague } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';

const UPSERT_CONCURRENCY = 10;

export class TeamLeagueRepository implements ITeamLeagueRepository {
  private readonly _prisma: PrismaClient;
  private readonly _logger: Logger;

  constructor(prisma: PrismaClient, logger: Logger) {
    this._prisma = prisma;
    this._logger = logger.child({ repository: 'TeamLeagueRepository' });
  }

  async upsert(input: CanonicalTeamLeague): Promise<{ id: string; action: EntityWriteAction }> {
    try {
      const sportId = await this._resolveSportId(input.sportSlug);

      const [team, league] = await Promise.all([
        this._prisma.team.findUnique({
          where: { sportId_externalId: { sportId, externalId: input.teamExternalId } },
          select: { id: true },
        }),
        this._prisma.league.findUnique({
          where: { sportId_externalId: { sportId, externalId: input.leagueExternalId } },
          select: { id: true },
        }),
      ]);

      if (!team) {
        throw new DatabaseError(`Team not found: ${input.teamExternalId}`, {
          retryable: false,
          context: { teamExternalId: input.teamExternalId, sportSlug: input.sportSlug },
        });
      }
      if (!league) {
        throw new DatabaseError(`League not found: ${input.leagueExternalId}`, {
          retryable: false,
          context: { leagueExternalId: input.leagueExternalId, sportSlug: input.sportSlug },
        });
      }

      // Native upsert: atomic INSERT … ON CONFLICT DO UPDATE eliminates the
      // find-then-create race that caused P2002 under concurrent Promise.all.
      // TeamLeague has no updatedAt, so action detection is not possible;
      // 'created' is returned unconditionally — callers discard this value.
      const record = await this._prisma.teamLeague.upsert({
        where: { teamId_leagueId: { teamId: team.id, leagueId: league.id } },
        create: { teamId: team.id, leagueId: league.id },
        update: { status: 'ACTIVE' },
        select: { id: true },
      });
      this._logger.debug(
        { teamExternalId: input.teamExternalId, leagueExternalId: input.leagueExternalId },
        'TeamLeague upserted',
      );
      return { id: record.id, action: 'created' };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(
        err,
        `Failed to upsert team-league: ${input.teamExternalId} / ${input.leagueExternalId}`,
      );
    }
  }

  async upsertMany(inputs: readonly CanonicalTeamLeague[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }> {
    const results: Array<{ id: string; action: EntityWriteAction }> = [];
    for (let i = 0; i < inputs.length; i += UPSERT_CONCURRENCY) {
      const batch = inputs.slice(i, i + UPSERT_CONCURRENCY);
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
