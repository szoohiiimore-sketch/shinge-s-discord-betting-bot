import type { Logger } from '@/lib/logger';
import { ExternalApiError } from '@/lib/errors';
import type { PandascoreRetryConfig } from './pandascore.retry.config';

/**
 * Determines whether an error is eligible for retry.
 *
 * Retryable: network failures, timeouts, 5xx server errors.
 * Non-retryable: 4xx client errors (including 401/403 auth).
 */
export function isPandascoreRetryable(error: unknown, config: PandascoreRetryConfig): boolean {
  if (!(error instanceof ExternalApiError)) {
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
 * Formula: delay = min(baseDelay * 2^attempt, maxDelay)
 *          jittered = random between delay/2 and delay
 */
export function calculatePandascoreBackoff(attempt: number, config: PandascoreRetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
  const halfDelay = cappedDelay / 2;
  return Math.floor(halfDelay + Math.random() * halfDelay);
}

/**
 * Calculates retry delay, preferring Retry-After from error context.
 */
export function calculatePandascoreRetryDelay(
  error: unknown,
  attempt: number,
  config: PandascoreRetryConfig,
): number {
  if (error instanceof ExternalApiError) {
    const retryAfterMs = error.context?.retryAfterMs as number | undefined;
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      const jitter = Math.floor(retryAfterMs * 0.1 * Math.random());
      return retryAfterMs + jitter;
    }
  }

  return calculatePandascoreBackoff(attempt, config);
}

/**
 * Executes an async operation with exponential backoff retry.
 */
export async function withPandascoreRetry<T>(
  operation: () => Promise<T>,
  config: PandascoreRetryConfig,
  logger: Logger,
  operationName: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt < config.maxRetries && isPandascoreRetryable(error, config)) {
        const delay = calculatePandascoreRetryDelay(error, attempt, config);
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

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}