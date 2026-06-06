import type { PrismaClient } from '@prisma/client';
import type { MatchRepository as IMatchRepository } from '@/ingestion/repositories/contracts';
import type { MatchDeduplicationKey, EntityWriteAction, MatchUpsertInput } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';

export class MatchRepository implements IMatchRepository {
  private readonly _prisma: PrismaClient;
  private readonly _logger: Logger;

  constructor(prisma: PrismaClient, logger: Logger) {
    this._prisma = prisma;
    this._logger = logger.child({ repository: 'MatchRepository' });
  }

  async findId(key: MatchDeduplicationKey): Promise<string | null> {
    try {
      const record = await this._prisma.match.findUnique({
        where: { externalId: key.externalId },
        select: { id: true },
      });
      return record?.id ?? null;
    } catch (err) {
      throw translatePrismaError(err, `Failed to find match: ${key.externalId}`);
    }
  }

  async upsert(input: MatchUpsertInput): Promise<{ id: string; action: EntityWriteAction }> {
    const { create, update } = input;

    try {
      const existing = await this._prisma.match.findUnique({
        where: { externalId: create.externalId },
        select: { id: true, status: true, homeScore: true, awayScore: true, result: true },
      });

      if (existing) {
        const hasContentChange =
          existing.status !== update.status ||
          existing.homeScore !== update.homeScore ||
          existing.awayScore !== update.awayScore ||
          existing.result !== update.result;

        await this._prisma.match.update({
          where: { externalId: create.externalId },
          data: hasContentChange
            ? {
                status: update.status,
                homeScore: update.homeScore,
                awayScore: update.awayScore,
                result: update.result,
                lastFetchedAt: update.lastFetchedAt,
              }
            : { lastFetchedAt: update.lastFetchedAt },
        });

        return { id: existing.id, action: hasContentChange ? 'updated' : 'skipped' };
      }

      // New match: resolve all foreign keys before writing.
      // Sport is resolved first since league and teams are scoped by sportId.
      const sportId = await this._resolveSportId(create.sportSlug);

      const [league, homeTeam, awayTeam] = await Promise.all([
        this._prisma.league.findUnique({
          where: { sportId_externalId: { sportId, externalId: create.leagueExternalId } },
          select: { id: true },
        }),
        this._prisma.team.findUnique({
          where: { sportId_externalId: { sportId, externalId: create.homeTeamExternalId } },
          select: { id: true },
        }),
        this._prisma.team.findUnique({
          where: { sportId_externalId: { sportId, externalId: create.awayTeamExternalId } },
          select: { id: true },
        }),
      ]);

      if (!league) {
        throw new DatabaseError(`League not found: ${create.leagueExternalId}`, {
          retryable: false,
          context: { leagueExternalId: create.leagueExternalId, sportSlug: create.sportSlug },
        });
      }
      if (!homeTeam) {
        throw new DatabaseError(`Home team not found: ${create.homeTeamExternalId}`, {
          retryable: false,
          context: { homeTeamExternalId: create.homeTeamExternalId, sportSlug: create.sportSlug },
        });
      }
      if (!awayTeam) {
        throw new DatabaseError(`Away team not found: ${create.awayTeamExternalId}`, {
          retryable: false,
          context: { awayTeamExternalId: create.awayTeamExternalId, sportSlug: create.sportSlug },
        });
      }

      const created = await this._prisma.match.create({
        data: {
          externalId: create.externalId,
          sportId,
          leagueId: league.id,
          homeTeamId: homeTeam.id,
          awayTeamId: awayTeam.id,
          startTime: create.startTime,
          status: create.status,
          homeScore: create.homeScore,
          awayScore: create.awayScore,
          result: create.result,
          lastFetchedAt: update.lastFetchedAt,
        },
        select: { id: true },
      });

      this._logger.debug({ externalId: create.externalId }, 'Match created');
      return { id: created.id, action: 'created' };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, `Failed to upsert match: ${create.externalId}`);
    }
  }

  async upsertMany(inputs: readonly MatchUpsertInput[]): Promise<{
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
