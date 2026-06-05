import { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import { DatabaseError } from '@/lib/errors';

/**
 * Connects to the database and verifies the connection.
 *
 * @param prisma - PrismaClient instance
 * @param logger - Logger instance
 * @throws {DatabaseError} If connection or verification fails
 *
 * @example
 * await connectDatabase(prisma, logger);
 */
export async function connectDatabase(
  prisma: PrismaClient,
  logger: Logger,
): Promise<void> {
  logger.info('Connecting to database');

  try {
    await prisma.$connect();
    logger.info('Database connected');
  } catch (err) {
    throw new DatabaseError('Failed to connect to database', {
      retryable: true,
      cause: err as Error,
      context: {
        errorMessage: (err as Error).message,
      },
    });
  }
}

/**
 * Disconnects from the database gracefully.
 *
 * Safe to call even if the connection was never established.
 *
 * @param prisma - PrismaClient instance
 * @param logger - Logger instance
 *
 * @example
 * await disconnectDatabase(prisma, logger);
 */
export async function disconnectDatabase(
  prisma: PrismaClient,
  logger: Logger,
): Promise<void> {
  logger.info('Disconnecting from database');

  try {
    await prisma.$disconnect();
    logger.info('Database disconnected');
  } catch (err) {
    logger.error({ err }, 'Error during database disconnection');
  }
}
