import type { Logger } from '@/lib/logger';
import { AuthenticationError } from '@/lib/errors';
import type { OddsApiClient } from './the-odds-api.client';
import { ResilientOddsApiClient } from './resilient-client';
import type { OddsApiHealthResult, OddsApiHealthStatus, OddsApiHealthThresholds } from './health.types';

/**
 * Default thresholds for health evaluation.
 */
export const DEFAULT_ODDS_API_HEALTH_THRESHOLDS: OddsApiHealthThresholds = {
  degradedQuotaPercent: 0.8,
};

/**
 * Checks the health of The Odds API integration.
 *
 * Performs a lightweight call to GET /v4/sports to verify:
 * - API reachability (no network error)
 * - Authentication validity (no 401/403)
 * - Response latency
 * - Monthly quota utilization
 *
 * Constructor injection: all dependencies passed explicitly.
 * No global mutable state.
 *
 * @example
 * const health = new OddsApiHealthChecker(client, logger);
 * const result = await health.check();
 * // { status: 'healthy', reachable: true, authenticated: true, ... }
 */
export class OddsApiHealthChecker {
  private readonly client: ResilientOddsApiClient;
  private readonly logger: Logger;
  private readonly thresholds: OddsApiHealthThresholds;

  constructor(
    client: OddsApiClient,
    logger: Logger,
    thresholds: OddsApiHealthThresholds = DEFAULT_ODDS_API_HEALTH_THRESHOLDS,
  ) {
    // Always wrap in resilient client to benefit from quota tracking
    this.client = client instanceof ResilientOddsApiClient
      ? client
      : new ResilientOddsApiClient(client, logger);
    this.logger = logger.child({ module: 'odds-api-health' });
    this.thresholds = thresholds;
  }

  /**
   * Runs a health check against The Odds API.
   *
   * Uses getSports() as a lightweight probe endpoint.
   * Does NOT throw — errors are captured in the health result.
   */
  async check(): Promise<OddsApiHealthResult> {
    const startTime = performance.now();
    const timestamp = new Date().toISOString();

    try {
      this.logger.debug('Starting The Odds API health check');
      await this.client.getSports();
      const latencyMs = Math.round(performance.now() - startTime);

      const quota = this.client.getQuotaState();
      const reachable = true;
      const authenticated = true;
      const status = this.evaluateStatus(reachable, authenticated, quota.utilizationPercent);

      return {
        status,
        reachable,
        authenticated,
        latencyMs,
        quotaUtilization: quota.utilizationPercent,
        requestsRemaining: quota.requestsRemaining,
        message: this.buildMessage(status, latencyMs, quota.utilizationPercent, quota.requestsRemaining),
        timestamp,
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      this.logger.warn({ err: error, latencyMs }, 'The Odds API health check failed');

      if (error instanceof AuthenticationError) {
        return {
          status: 'unhealthy',
          reachable: true,
          authenticated: false,
          latencyMs,
          quotaUtilization: 0,
          requestsRemaining: 0,
          message: 'The Odds API authentication failed — check API key',
          timestamp,
        };
      }

      // Network error, timeout, or unexpected failure
      return {
        status: 'unhealthy',
        reachable: false,
        authenticated: false,
        latencyMs,
        quotaUtilization: 0,
        requestsRemaining: 0,
        message: `The Odds API is unreachable: ${(error as Error).message}`,
        timestamp,
      };
    }
  }

  /**
   * Evaluates overall health status based on check results.
   */
  private evaluateStatus(
    reachable: boolean,
    authenticated: boolean,
    quotaUtilization: number,
  ): OddsApiHealthStatus {
    if (!reachable || !authenticated) {
      return 'unhealthy';
    }

    if (quotaUtilization >= this.thresholds.degradedQuotaPercent) {
      return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Builds a human-readable health message.
   */
  private buildMessage(
    status: OddsApiHealthStatus,
    latencyMs: number,
    quotaUtilization: number,
    requestsRemaining: number,
  ): string {
    if (status === 'healthy') {
      return `The Odds API is healthy (${latencyMs}ms, ${requestsRemaining} requests remaining)`;
    }

    if (status === 'degraded') {
      return `The Odds API is degraded — quota at ${Math.round(quotaUtilization * 100)}% (${requestsRemaining} requests remaining)`;
    }

    return 'The Odds API is unhealthy';
  }
}