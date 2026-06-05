import { AppError } from './app-error';

/**
 * Database operation failure.
 *
 * Thrown when a Prisma query fails due to connection issues,
 * constraint violations, or unexpected database errors.
 *
 * @example
 * throw new DatabaseError('Failed to create match', {
 *   retryable: true,
 *   cause: err,
 *   context: { matchId }
 * });
 */
export class DatabaseError extends AppError {
  constructor(message: string, options: DatabaseErrorOptions = {}) {
    super({
      message,
      code: 'DATABASE_ERROR',
      statusCode: 500,
      retryable: options.retryable ?? false,
      cause: options.cause,
      context: options.context,
    });
  }
}

export interface DatabaseErrorOptions {
  retryable?: boolean;
  cause?: Error;
  context?: Record<string, unknown>;
}
