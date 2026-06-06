import type { PrismaClient } from '@prisma/client';
import type { SportRepository as ISportRepository } from '@/ingestion/repositories/contracts';
import type { SportDeduplicationKey, EntityWriteAction, CanonicalSport } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';

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
      const existing = await this._prisma.sport.findUnique({
        where: { slug: input.slug },
        select: { id: true, name: true },
      });

      if (!existing) {
        const created = await this._prisma.sport.create({
          data: {
            slug: input.slug,
            name: input.name,
            category: input.category,
            externalApiSource: input.externalApiSource,
            externalSportKey: input.externalSportKey,
          },
          select: { id: true },
        });
        this._logger.debug({ slug: input.slug }, 'Sport created');
        return { id: created.id, action: 'created' };
      }

      if (existing.name !== input.name) {
        await this._prisma.sport.update({
          where: { slug: input.slug },
          data: { name: input.name },
        });
        this._logger.debug({ slug: input.slug }, 'Sport updated');
        return { id: existing.id, action: 'updated' };
      }

      return { id: existing.id, action: 'skipped' };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, `Failed to upsert sport: ${input.slug}`);
    }
  }

  async upsertMany(inputs: readonly CanonicalSport[]): Promise<{
    results: Array<{ id: string; action: EntityWriteAction }>;
  }> {
    const results = await Promise.all(inputs.map(input => this.upsert(input)));
    return { results };
  }
}
