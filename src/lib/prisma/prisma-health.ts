import { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';

/**
 * Result of a database health check.
 */
export interface DatabaseHealth {
  /** Whether the database is reachable and responsive */
  ok: boolean;
  /** Error message if the check failed */
  error?: string;
  /** Database latency in milliseconds */
  latencyMs?: number;
}

/**
 * Performs a database health check by executing a simple query.
 *
 * Uses `SELECT 1` to verify the database connection is alive.
 * Returns a structured result rather than throwing, making it
 * suitable for use in health check endpoints.
 *
 * @param prisma - PrismaClient instance
 * @param logger - Logger instance
 * @returns Database health status
 *
 * @example
 * const health = await checkDatabaseHealth(prisma, logger);
 * // { ok: true, latencyMs: 2 }
 */
export async function checkDatabaseHealth(
  prisma: PrismaClient,
  logger: Logger,
): Promise<DatabaseHealth> {
  const start = performance.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    const latencyMs = Math.round(performance.now() - start);

    logger.debug({ latencyMs }, 'Database health check passed');

    return {
      ok: true,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);

    logger.error({ err, latencyMs }, 'Database health check failed');

    return {
      ok: false,
      error: (err as Error).message,
      latencyMs,
    };
  }
}
