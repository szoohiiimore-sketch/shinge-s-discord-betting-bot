import { RedisError } from '@/lib/errors';

/**
 * Common Redis error message patterns and their mapped application errors.
 *
 * ioredis errors are not as structured as Prisma errors, so we use
 * message pattern matching to categorize them.
 */
const REDIS_ERROR_PATTERNS: RedisErrorPattern[] = [
  {
    pattern: /ECONNREFUSED/i,
    message: 'Redis connection refused — is the server running?',
    retryable: true,
  },
  {
    pattern: /ETIMEDOUT|timeout/i,
    message: 'Redis connection timed out',
    retryable: true,
  },
  {
    pattern: /ENOTFOUND/i,
    message: 'Redis host not found',
    retryable: false,
  },
  {
    pattern: /READONLY/i,
    message: 'Redis is in read-only mode (replica)',
    retryable: true,
  },
  {
    pattern: /LOADING/i,
    message: 'Redis is loading the dataset',
    retryable: true,
  },
  {
    pattern: /MAXCLIENTS/i,
    message: 'Redis max clients reached',
    retryable: true,
  },
  {
    pattern: /NOSCRIPT/i,
    message: 'Redis script not found (likely flushed)',
    retryable: false,
  },
  {
    pattern: /BUSYGROUP/i,
    message: 'Redis consumer group already exists',
    retryable: false,
  },
  {
    pattern: /NOGROUP/i,
    message: 'Redis consumer group not found',
    retryable: false,
  },
  {
    pattern: /MOVED|ASK/i,
    message: 'Redis cluster redirection',
    retryable: true,
  },
  {
    pattern: /CLUSTERDOWN/i,
    message: 'Redis cluster is down',
    retryable: true,
  },
  {
    pattern: /CROSSSLOT/i,
    message: 'Redis cross-slot keys in cluster mode',
    retryable: false,
  },
];

interface RedisErrorPattern {
  pattern: RegExp;
  message: string;
  retryable: boolean;
}

/**
 * Translates a Redis/ioredis error into the appropriate application error.
 *
 * Uses message pattern matching to categorize errors.
 * Falls back to a generic RedisError for unrecognized errors.
 *
 * @param err - The caught error
 * @param defaultMessage - Fallback message if the error is unrecognized
 * @returns A RedisError instance
 *
 * @example
 * try {
 *   await redis.ping();
 * } catch (err) {
 *   throw translateRedisError(err, 'Failed to ping Redis');
 * }
 */
export function translateRedisError(
  err: unknown,
  defaultMessage: string,
): RedisError {
  // If it's already a RedisError, return as-is
  if (err instanceof RedisError) {
    return err;
  }

  const errorMessage = err instanceof Error ? err.message : String(err);

  // Try to match against known patterns
  for (const mapping of REDIS_ERROR_PATTERNS) {
    if (mapping.pattern.test(errorMessage)) {
      return new RedisError(mapping.message, {
        retryable: mapping.retryable,
        cause: err instanceof Error ? err : undefined,
        context: {
          originalMessage: errorMessage,
        },
      });
    }
  }

  // Unknown Redis error — wrap in generic RedisError
  return new RedisError(defaultMessage, {
    retryable: true,
    cause: err instanceof Error ? err : undefined,
    context: {
      originalMessage: errorMessage,
    },
  });
}
