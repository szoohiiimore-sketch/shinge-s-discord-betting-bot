import { PrismaClient } from '@prisma/client';
import type { DatabaseConfig } from '@/config/config.types';
import type { Logger } from '@/lib/logger';

/**
 * Creates a configured Prisma Client instance.
 *
 * The client uses DATABASE_URL from the config for the main connection.
 * DIRECT_DATABASE_URL is set as an environment variable override for
 * direct connections (bypassing PgBouncer if used in production).
 *
 * @param config - Database configuration
 * @param logger - Logger instance
 * @returns A configured PrismaClient instance
 *
 * @example
 * const prisma = createPrismaClient(config.database, logger);
 */
export function createPrismaClient(
  config: DatabaseConfig,
  logger: Logger,
): PrismaClient {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: config.url,
      },
    },
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'info' },
    ],
  });

  // Log query errors
  prisma.$on('error', (event) => {
    logger.error(
      { target: event.target, message: event.message },
      'Prisma query error',
    );
  });

  // Log query warnings
  prisma.$on('warn', (event) => {
    logger.warn(
      { target: event.target, message: event.message },
      'Prisma warning',
    );
  });

  // Log info events
  prisma.$on('info', (event) => {
    logger.info(
      { target: event.target, message: event.message },
      'Prisma info',
    );
  });

  return prisma;
}
