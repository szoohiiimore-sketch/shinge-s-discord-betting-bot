/**
 * Tracks monthly API quota usage for The Odds API.
 *
 * The Odds API enforces a monthly request limit based on the subscription plan.
 * This type captures the quota state parsed from response headers.
 */
export interface QuotaState {
  /** Total requests permitted in the current monthly billing period. */
  readonly totalRequests: number;

  /** Requests remaining in the current monthly billing period. */
  readonly requestsRemaining: number;

  /** Unix timestamp (seconds) when the quota resets. */
  readonly resetAt: number;

  /** Timestamp of the last time the quota was checked. */
  readonly lastCheckedAt: number;

  /** Whether the quota is exhausted (no remaining requests). */
  readonly isExhausted: boolean;

  /** The fraction of quota used (0.0 to 1.0). */
  readonly utilizationPercent: number;
}

/**
 * Tracks rate limit state between requests.
 *
 * Rate limits are enforced per-second/minute by the API.
 * This type represents the state after parsing a 429 response.
 */
export interface RateLimitState {
  /** Whether the client is currently rate-limited. */
  readonly isLimited: boolean;

  /** Unix timestamp (ms) when the rate limit window resets. */
  readonly retryAfterMs: number;

  /** Human-readable message from the rate limit response. */
  readonly message: string;
}

/**
 * Creates an initial QuotaState representing an unchecked state.
 */
export function createInitialQuotaState(): QuotaState {
  return {
    totalRequests: 0,
    requestsRemaining: 0,
    resetAt: 0,
    lastCheckedAt: 0,
    isExhausted: false,
    utilizationPercent: 0,
  };
}