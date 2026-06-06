import type { PrismaClient } from '@prisma/client';
import type { MatchRepository as IMatchRepository } from '@/ingestion/repositories/contracts';
import type { MatchDeduplicationKey, EntityWriteAction, MatchUpsertInput } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';

const UPSERT_CONCURRENCY = 10;

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
      // Read current state to detect content changes and get the existing ID.
      // An update on an already-existing record cannot race to P2002, so findUnique
      // + update is safe here. Only the create path needs to be atomic (see below).
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

      // Native upsert for the create path: if two workers both see "not exists" and
      // both reach this point, one creates and the other's upsert becomes an update
      // with the same payload — no P2002. Prisma's @updatedAt distinguishes the two
      // outcomes: createdAt === updatedAt means this worker won the create race.
      const record = await this._prisma.match.upsert({
        where: { externalId: create.externalId },
        create: {
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
        update: {
          status: update.status,
          homeScore: update.homeScore,
          awayScore: update.awayScore,
          result: update.result,
          lastFetchedAt: update.lastFetchedAt,
        },
        select: { id: true, createdAt: true, updatedAt: true },
      });

      const action: EntityWriteAction =
        record.createdAt.getTime() === record.updatedAt.getTime() ? 'created' : 'updated';
      if (action === 'created') {
        this._logger.debug({ externalId: create.externalId }, 'Match created');
      }
      return { id: record.id, action };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, `Failed to upsert match: ${create.externalId}`);
    }
  }

  async upsertMany(inputs: readonly MatchUpsertInput[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }> {
    // Match externalIds are globally unique (source-namespaced "oa:" / "ps:"), so
    // no in-batch deduplication is required. Concurrency is capped to avoid exhausting
    // the Neon PgBouncer connection pool on large sync batches.
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
