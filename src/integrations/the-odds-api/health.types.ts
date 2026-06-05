/**
 * Health status for The Odds API integration.
 */
export type OddsApiHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Result of a health check against The Odds API.
 */
export interface OddsApiHealthResult {
  /** Overall health status. */
  readonly status: OddsApiHealthStatus;

  /** Whether the API was reachable. */
  readonly reachable: boolean;

  /** Whether authentication credentials are valid. */
  readonly authenticated: boolean;

  /** Response latency in milliseconds. */
  readonly latencyMs: number;

  /** Current monthly quota utilization (0.0 to 1.0). */
  readonly quotaUtilization: number;

  /** Requests remaining in the current quota period. */
  readonly requestsRemaining: number;

  /** Human-readable message describing the health state. */
  readonly message: string;

  /** ISO 8601 timestamp of the check. */
  readonly timestamp: string;
}

/**
 * Thresholds that determine health status.
 */
export interface OddsApiHealthThresholds {
  /** Quota utilization above this triggers degraded status. */
  readonly degradedQuotaPercent: number;
}