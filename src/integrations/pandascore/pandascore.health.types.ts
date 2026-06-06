/**
 * Health status for the PandaScore API integration.
 */
export type PandascoreHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Result of a health check against the PandaScore API.
 */
export interface PandascoreHealthResult {
  /** Overall health status. */
  readonly status: PandascoreHealthStatus;

  /** Whether the API was reachable. */
  readonly reachable: boolean;

  /** Whether authentication credentials are valid. */
  readonly authenticated: boolean;

  /** Response latency in milliseconds. */
  readonly latencyMs: number;

  /** Human-readable message describing the health state. */
  readonly message: string;

  /** ISO 8601 timestamp of the check. */
  readonly timestamp: string;
}

/**
 * Thresholds that determine health status for PandaScore.
 */
export interface PandascoreHealthThresholds {
  /** Latency in ms above which status becomes degraded. */
  readonly degradedLatencyMs: number;
}