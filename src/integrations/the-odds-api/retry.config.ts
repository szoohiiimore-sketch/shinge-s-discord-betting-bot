/**
 * Configuration for HTTP retry behaviour.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (excluding the initial request). */
  readonly maxRetries: number;

  /** Base delay in milliseconds for exponential backoff. */
  readonly baseDelayMs: number;

  /** Maximum delay in milliseconds between retries (cap). */
  readonly maxDelayMs: number;

  /** HTTP status codes that are eligible for retry. */
  readonly retryableStatusCodes: readonly number[];
}

/** Default retry configuration for The Odds API. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
} as const;