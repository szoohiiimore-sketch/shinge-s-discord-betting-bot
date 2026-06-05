import { AppError } from './app-error';

/**
 * Redis operation failure.
 *
 * Thrown when a Redis command fails due to connection issues,
 * timeouts, or unexpected Redis errors.
 *
 * @example
 * throw new RedisError('Failed to ping Redis', {
 *   retryable: true,
 *   cause: err
 * });
 */
export class RedisError extends AppError {
  constructor(message: string, options: RedisErrorOptions = {}) {
    super({
      message,
      code: 'REDIS_ERROR',
      statusCode: 500,
      retryable: options.retryable ?? false,
      cause: options.cause,
      context: options.context,
    });
  }
}

export interface RedisErrorOptions {
  retryable?: boolean;
  cause?: Error;
  context?: Record<string, unknown>;
}
