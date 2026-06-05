import { Redis } from 'ioredis';
import type { RedisConfig } from '@/config/config.types';
import type { Logger } from '@/lib/logger';

/**
 * Creates a configured Redis client instance.
 *
 * Uses REDIS_URL from config for the connection.
 * Configures:
 * - Connection timeout (10 seconds)
 * - Retry strategy (exponential backoff, max 30 seconds)
 * - Lazy connect (must call connect() explicitly)
 * - Event logging for connect/ready/close/error
 *
 * @param config - Redis configuration
 * @param logger - Logger instance
 * @returns A configured Redis instance
 *
 * @example
 * const redis = createRedisClient(config.redis, logger);
 */
export function createRedisClient(
  config: RedisConfig,
  logger: Logger,
): Redis {
  const redis = new Redis(config.url, {
    // Lazy connect — we control when to connect
    lazyConnect: true,

    // Connection timeout: 10 seconds
    connectTimeout: 10_000,

    // Retry strategy with exponential backoff
    retryStrategy(times: number): number | null {
      if (times > 10) {
        logger.error({ attempt: times }, 'Redis max retry attempts reached');
        return null; // Stop retrying
      }

      // Exponential backoff: 200ms, 400ms, 800ms, ... up to 30s
      const delay = Math.min(200 * Math.pow(2, times - 1), 30_000);
      logger.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting');
      return delay;
    },

    // Max retries per request
    maxRetriesPerRequest: 3,
  });

  // Log connection events
  redis.on('connect', () => {
    logger.info('Redis connecting');
  });

  redis.on('ready', () => {
    logger.info('Redis ready');
  });

  redis.on('close', () => {
    logger.warn('Redis connection closed');
  });

  redis.on('reconnecting', (delay: number) => {
    logger.warn({ delayMs: delay }, 'Redis reconnecting');
  });

  redis.on('error', (err: Error) => {
    logger.error({ err }, 'Redis error');
  });

  redis.on('end', () => {
    logger.info('Redis connection ended');
  });

  return redis;
}
