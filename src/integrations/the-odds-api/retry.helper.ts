import type { Logger } from '@/lib/logger';
import { ExternalApiError } from '@/lib/errors';
import type { RetryConfig } from './retry.config';

/**
 * Determines whether an error is eligible for retry.
 *
 * Retryable errors:
 * - Network failures (fetch threw before getting a response)
 * - Timeout failures (AbortError)
 * - 5xx status codes (server errors)
 * - 429 rate limit (retryable by nature)
 *
 * Non-retryable:
 * - 4xx client errors (except 429)
 * - Authentication errors
 */
export function isRetryable(error: unknown, config: RetryConfig): boolean {
  if (!(error instanceof ExternalApiError)) {
    // Non-API errors (e.g., network failure) are always retryable
    return true;
  }

  if (!error.retryable) {
    return false;
  }

  const statusCode = (error.context?.statusCode as number) ?? 0;

  if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
    return false;
  }

  return config.retryableStatusCodes.includes(statusCode) || statusCode === 0;
}

/**
 * Calculates the delay before the next retry attempt using
 * exponential backoff with jitter and a maximum cap.
 *
 * Formula:
 *   delay = min(baseDelay * 2^attempt, maxDelay)
 *   jittered = random between delay/2 and delay
 *
 * @param attempt - The zero-based retry attempt number
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateBackoff(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
  const halfDelay = cappedDelay / 2;
  return Math.floor(halfDelay + Math.random() * halfDelay);
}

/**
 * Executes an async operation with exponential backoff retry.
 *
 * Only retries on retryable errors. Non-retryable errors
 * are re-thrown immediately.
 *
 * @param operation - The async operation to execute (zero-based attempt index)
 * @param config - Retry configuration
 * @param logger - Logger instance
 * @param operationName - Human-readable name for logging
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted or error is non-retryable
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  config: RetryConfig,
  logger: Logger,
  operationName: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt < config.maxRetries && isRetryable(error, config)) {
        const delay = calculateRetryDelay(error, attempt, config);
        logger.warn(
          {
            err: error,
            attempt: attempt + 1,
            maxRetries: config.maxRetries,
            nextRetryMs: delay,
            operation: operationName,
          },
          'Retryable error in %s, attempt %d/%d, retrying in %dms',
          operationName,
          attempt + 1,
          config.maxRetries + 1,
          delay,
        );

        await sleep(delay);
      } else {
        // Non-retryable or final attempt exhausted
        if (attempt >= config.maxRetries) {
          logger.error(
            {
              err: error,
              attempt: attempt + 1,
              maxRetries: config.maxRetries,
              operation: operationName,
            },
            'All %d retry attempts exhausted for %s',
            config.maxRetries + 1,
            operationName,
          );
        }
        throw error;
      }
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

/**
 * Calculates the delay before the next retry attempt.
 *
 * Prefers the Retry-After value from the error context when available
 * (e.g., from a 429 response). Falls back to exponential backoff with
 * jitter when no Retry-After is provided.
 *
 * @param error - The error that triggered the retry
 * @param attempt - The zero-based retry attempt number
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(
  error: unknown,
  attempt: number,
  config: RetryConfig,
): number {
  if (error instanceof ExternalApiError) {
    const retryAfterMs = error.context?.retryAfterMs as number | undefined;
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      // Use Retry-After value with jitter to avoid thundering herd
      const jitter = Math.floor(retryAfterMs * 0.1 * Math.random());
      return retryAfterMs + jitter;
    }
  }

  return calculateBackoff(attempt, config);
}

/**
 * Promise-based delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
