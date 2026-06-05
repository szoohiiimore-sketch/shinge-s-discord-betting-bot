import { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';

/**
 * Result of a Redis health check.
 */
export interface RedisHealth {
  /** Whether Redis is reachable and responsive */
  ok: boolean;
  /** Error message if the check failed */
  error?: string;
  /** Redis latency in milliseconds */
  latencyMs?: number;
}

/**
 * Performs a Redis health check by sending a PING command.
 *
 * Returns a structured result rather than throwing, making it
 * suitable for use in health check endpoints.
 *
 * @param redis - Redis instance
 * @param logger - Logger instance
 * @returns Redis health status
 *
 * @example
 * const health = await checkRedisHealth(redis, logger);
 * // { ok: true, latencyMs: 1 }
 */
export async function checkRedisHealth(
  redis: Redis,
  logger: Logger,
): Promise<RedisHealth> {
  const start = performance.now();

  try {
    const result = await redis.ping();
    const latencyMs = Math.round(performance.now() - start);

    if (result !== 'PONG') {
      logger.warn({ response: result, latencyMs }, 'Redis health check returned unexpected response');
      return {
        ok: false,
        error: `Unexpected response: ${result}`,
        latencyMs,
      };
    }

    logger.debug({ latencyMs }, 'Redis health check passed');

    return {
      ok: true,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);

    logger.error({ err, latencyMs }, 'Redis health check failed');

    return {
      ok: false,
      error: (err as Error).message,
      latencyMs,
    };
  }
}
