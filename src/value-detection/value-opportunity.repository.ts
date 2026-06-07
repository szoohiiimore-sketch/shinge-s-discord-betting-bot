import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';
import { translatePrismaError } from '@/lib/prisma';
import type { ValueOpportunityInsert } from './value-detection.types';

export class ValueOpportunityRepository {
  private readonly _prisma: PrismaClient;
  private readonly _logger: Logger;

  constructor(prisma: PrismaClient, logger: Logger) {
    this._prisma = prisma;
    this._logger = logger.child({ repository: 'ValueOpportunityRepository' });
  }

  async insertMany(inputs: readonly ValueOpportunityInsert[]): Promise<{ inserted: number }> {
    if (inputs.length === 0) return { inserted: 0 };

    try {
      const result = await this._prisma.valueOpportunity.createMany({
        data: inputs.map(i => ({
          matchId: i.matchId,
          sport: i.sport,
          bookmaker: i.bookmaker,
          outcome: i.outcome,
          bookmakerOdds: i.bookmakerOdds,
          fairOdds: i.fairOdds,
          edgePercentage: i.edgePercentage,
          consensusProbability: i.consensusProbability,
          consensusBookmakers: i.consensusBookmakers,
          capturedAt: i.capturedAt,
        })),
        skipDuplicates: true,
      });
      this._logger.debug({ count: result.count }, 'ValueOpportunity batch inserted');
      return { inserted: result.count };
    } catch (err) {
      if (err instanceof DatabaseError) throw err;
      throw translatePrismaError(err, 'Failed to insert value opportunities');
    }
  }
}
