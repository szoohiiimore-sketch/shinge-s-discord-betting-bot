import { AppError } from './app-error';

/**
 * External API call failure.
 *
 * Thrown when an external API (The Odds API, PandaScore, DeepSeek)
 * returns an error, times out, or is unreachable.
 *
 * @example
 * throw new ExternalApiError('The Odds API returned 429', {
 *   retryable: true,
 *   context: { api: 'the-odds-api', statusCode: 429, endpoint: '/v4/sports' }
 * });
 */
export class ExternalApiError extends AppError {
  constructor(message: string, options: ExternalApiErrorOptions = {}) {
    super({
      message,
      code: 'EXTERNAL_API_ERROR',
      statusCode: options.statusCode ?? 502,
      retryable: options.retryable ?? true,
      cause: options.cause,
      context: options.context,
    });
  }
}

export interface ExternalApiErrorOptions {
  statusCode?: number;
  retryable?: boolean;
  cause?: Error;
  context?: Record<string, unknown>;
}

/**
 * API rate limit exceeded.
 *
 * Thrown when an external API returns HTTP 429.
 * Always retryable after a backoff delay.
 *
 * @example
 * throw new RateLimitError('The Odds API rate limit exceeded', {
 *   context: { api: 'the-odds-api', retryAfter: 60 }
 * });
 */
export class RateLimitError extends ExternalApiError {
  constructor(message: string, options: RateLimitErrorOptions = {}) {
    super(message, {
      statusCode: 429,
      retryable: true,
      cause: options.cause,
      context: { ...options.context, errorCode: 'RATE_LIMIT_EXCEEDED' },
    });
  }
}

export interface RateLimitErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
}

/**
 * API authentication failure.
 *
 * Thrown when an external API returns HTTP 401 or 403.
 * Not retryable — the API key is invalid or expired.
 *
 * @example
 * throw new AuthenticationError('DeepSeek API key is invalid', {
 *   context: { api: 'deepseek' }
 * });
 */
export class AuthenticationError extends ExternalApiError {
  constructor(message: string, options: AuthenticationErrorOptions = {}) {
    super(message, {
      statusCode: 401,
      retryable: false,
      cause: options.cause,
      context: { ...options.context, errorCode: 'API_AUTHENTICATION_ERROR' },
    });
  }
}

export interface AuthenticationErrorOptions {
  cause?: Error;
  context?: Record<string, unknown>;
}
