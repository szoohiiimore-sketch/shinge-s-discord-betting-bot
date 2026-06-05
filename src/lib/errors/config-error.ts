import { AppError } from './app-error';

/**
 * Configuration validation failure.
 *
 * Thrown when environment variables are missing, invalid, or
 * fail zod schema validation during startup.
 *
 * @example
 * throw new ConfigError('DATABASE_URL is required', {
 *   context: { variable: 'DATABASE_URL' }
 * });
 */
export class ConfigError extends AppError {
  constructor(message: string, options: ConfigErrorOptions = {}) {
    super({
      message,
      code: 'CONFIG_ERROR',
      statusCode: 500,
      retryable: false,
      cause: options.cause,
      context: options.context,
    });
  }
}

export interface ConfigErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
}
