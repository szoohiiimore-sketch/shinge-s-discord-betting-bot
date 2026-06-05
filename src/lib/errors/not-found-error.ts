import { AppError } from './app-error';

/**
 * Entity not found.
 *
 * Thrown when a requested entity (match, user, prediction, etc.)
 * does not exist in the database.
 *
 * @example
 * throw new NotFoundError('Match not found', {
 *   context: { matchId: 'abc-123' }
 * });
 */
export class NotFoundError extends AppError {
  constructor(message: string, options: NotFoundErrorOptions = {}) {
    super({
      message,
      code: 'NOT_FOUND',
      statusCode: 404,
      retryable: false,
      cause: options.cause,
      context: options.context,
    });
  }
}

export interface NotFoundErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
}
