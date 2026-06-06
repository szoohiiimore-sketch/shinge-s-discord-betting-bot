import type { PrismaClient } from '@prisma/client';
import type { SportRepository as ISportRepository } from '@/ingestion/repositories/contracts';
import type { SportDeduplicationKey, EntityWriteAction, CanonicalSport } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';

const UPSERT_CONCURRENCY = 10;

export class SportRepository implements ISportRepository {
  private readonly _prisma: PrismaClient;
  private readonly _logger: Logger;

  constructor(prisma: PrismaClient, logger: Logger) {
    this._prisma = prisma;
    this._logger = logger.child({ repository: 'SportRepository' });
  }

  async findId(key: SportDeduplicationKey): Promise<string | null> {
    try {
      const record = await this._prisma.sport.findUnique({
        where: { slug: key.slug },
        select: { id: true },
      });
      return record?.id ?? null;
    } catch (err) {
      throw translatePrismaError(err, `Failed to find sport: ${key.slug}`);
    }
  }

  async upsert(input: CanonicalSport): Promise<{ id: string; action: EntityWriteAction }> {
    try {
      // Native upsert compiles to INSERT ... ON CONFLICT DO UPDATE, making concurrent
      // calls atomic. Prisma's @updatedAt is always bumped on the update path, so
      // action is 'created' when createdAt === updatedAt (same DB transaction instant),
      // and 'updated' otherwise.
      const record = await this._prisma.sport.upsert({
        where: { slug: input.slug },
        create: {
          slug: input.slug,
          name: input.name,
          category: input.category,
          externalApiSource: input.externalApiSource,
          externalSportKey: input.externalSportKey,
        },
        update: { name: input.name },
        select: { id: true, createdAt: true, updatedAt: true },
      });
      const action: EntityWriteAction =
        record.createdAt.getTime() === record.updatedAt.getTime() ? 'created' : 'updated';
      this._logger.debug({ slug: input.slug, action }, 'Sport upserted');
      return { id: record.id, action };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, `Failed to upsert sport: ${input.slug}`);
    }
  }

  async upsertMany(inputs: readonly CanonicalSport[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }> {
    // The Odds API returns one entry per competition, not per sport group, so multiple
    // inputs share the same slug (e.g. "soccer" from soccer_epl, soccer_bundesliga).
    // Dedup before dispatching to avoid redundant upserts.
    const seen = new Set<string>();
    const unique = inputs.filter(i => {
      if (seen.has(i.slug)) return false;
      seen.add(i.slug);
      return true;
    });

    const results: Array<{ id: string; action: EntityWriteAction }> = [];
    for (let i = 0; i < unique.length; i += UPSERT_CONCURRENCY) {
      const batch = unique.slice(i, i + UPSERT_CONCURRENCY);
      results.push(...(await Promise.all(batch.map(input => this.upsert(input)))));
    }
    return { results };
  }
}
