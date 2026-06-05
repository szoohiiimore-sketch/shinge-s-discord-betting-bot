import { AppError } from './app-error';

/**
 * Data validation failure.
 *
 * Thrown when input data fails validation (e.g., invalid match ID format,
 * missing required fields, schema validation failure).
 *
 * @example
 * throw new ValidationError('Match ID must be a valid UUID', {
 *   context: { matchId: 'invalid-id' }
 * });
 */
export class ValidationError extends AppError {
  constructor(message: string, options: ValidationErrorOptions = {}) {
    super({
      message,
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      retryable: false,
      cause: options.cause,
      context: options.context,
    });
  }
}

export interface ValidationErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
}
