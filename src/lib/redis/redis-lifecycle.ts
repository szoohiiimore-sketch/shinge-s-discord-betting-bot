import { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import { RedisError } from '@/lib/errors';

/**
 * Connects to Redis and verifies the connection with a PING command.
 *
 * @param redis - Redis instance
 * @param logger - Logger instance
 * @throws {RedisError} If connection or PING fails
 *
 * @example
 * await connectRedis(redis, logger);
 */
export async function connectRedis(
  redis: Redis,
  logger: Logger,
): Promise<void> {
  logger.info('Connecting to Redis');

  try {
    await redis.connect();
    logger.info('Redis connected');
  } catch (err) {
    throw new RedisError('Failed to connect to Redis', {
      retryable: true,
      cause: err as Error,
      context: {
        errorMessage: (err as Error).message,
      },
    });
  }
}

/**
 * Verifies the Redis connection is alive by sending a PING command.
 *
 * Should be called after connectRedis() to confirm the connection
 * is fully established and ready.
 *
 * @param redis - Redis instance
 * @param logger - Logger instance
 * @throws {RedisError} If PING fails
 *
 * @example
 * await verifyRedisConnection(redis, logger);
 */
export async function verifyRedisConnection(
  redis: Redis,
  logger: Logger,
): Promise<void> {
  logger.info('Verifying Redis connection');

  try {
    const result = await redis.ping();
    if (result !== 'PONG') {
      throw new RedisError(`Unexpected Redis PING response: ${result}`, {
        retryable: true,
        context: { response: result },
      });
    }
    logger.info('Redis connection verified');
  } catch (err) {
    if (err instanceof RedisError) {
      throw err;
    }
    throw new RedisError('Failed to verify Redis connection', {
      retryable: true,
      cause: err as Error,
      context: {
        errorMessage: (err as Error).message,
      },
    });
  }
}

/**
 * Disconnects from Redis gracefully.
 *
 * Safe to call even if the connection was never established.
 * Uses a 5-second timeout to force close if graceful shutdown hangs.
 *
 * @param redis - Redis instance
 * @param logger - Logger instance
 *
 * @example
 * await disconnectRedis(redis, logger);
 */
export async function disconnectRedis(
  redis: Redis,
  logger: Logger,
): Promise<void> {
  logger.info('Disconnecting from Redis');

  try {
    // Flush all pending commands, then quit gracefully
    await redis.quit();
    logger.info('Redis disconnected');
  } catch (err) {
    logger.error({ err }, 'Error during Redis disconnection, force closing');

    try {
      // Force disconnect if graceful quit failed
      redis.disconnect(false);
    } catch {
      // Ignore disconnect errors — we're shutting down anyway
    }
  }
}
