/**
 * Configuration for HTTP retry behaviour specific to PandaScore API.
 */
export interface PandascoreRetryConfig {
  /** Maximum number of retry attempts (excluding the initial request). */
  readonly maxRetries: number;

  /** Base delay in milliseconds for exponential backoff. */
  readonly baseDelayMs: number;

  /** Maximum delay in milliseconds between retries (cap). */
  readonly maxDelayMs: number;

  /** HTTP status codes that are eligible for retry. */
  readonly retryableStatusCodes: readonly number[];
}

/** Default retry configuration for PandaScore API. */
export const DEFAULT_PANDASCORE_RETRY_CONFIG: PandascoreRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
} as const;
