import type { Logger } from '@/lib/logger';
import { AuthenticationError } from '@/lib/errors';
import type { PandascoreClient } from './pandascore.client';
import { ResilientPandascoreClient } from './pandascore.resilient-client';
import type { PandascoreHealthResult, PandascoreHealthStatus, PandascoreHealthThresholds } from './pandascore.health.types';

/**
 * Default thresholds for PandaScore health evaluation.
 */
export const DEFAULT_PANDASCORE_HEALTH_THRESHOLDS: PandascoreHealthThresholds = {
  degradedLatencyMs: 2_000,
};

/**
 * Checks the health of the PandaScore API integration.
 *
 * Uses getUpcomingMatches('cs2') as a lightweight probe.
 * Does NOT throw — errors are captured in the health result.
 *
 * Constructor injection: all dependencies passed explicitly.
 * No global mutable state.
 */
export class PandascoreHealthChecker {
  private readonly client: ResilientPandascoreClient;
  private readonly logger: Logger;
  private readonly thresholds: PandascoreHealthThresholds;

  constructor(
    client: PandascoreClient,
    logger: Logger,
    thresholds: PandascoreHealthThresholds = DEFAULT_PANDASCORE_HEALTH_THRESHOLDS,
  ) {
    this.client = client instanceof ResilientPandascoreClient
      ? client
      : new ResilientPandascoreClient(client, logger);
    this.logger = logger.child({ module: 'pandascore-health' });
    this.thresholds = thresholds;
  }

  /**
   * Runs a health check against PandaScore API.
   *
   * Uses CS2 upcoming matches as a lightweight probe endpoint
   * that exercises authentication and connectivity.
   */
  async check(): Promise<PandascoreHealthResult> {
    const startTime = performance.now();
    const timestamp = new Date().toISOString();

    try {
      this.logger.debug('Starting PandaScore API health check');
      await this.client.getUpcomingMatches('csgo');
      const latencyMs = Math.round(performance.now() - startTime);

      const status = this.evaluateStatus(true, true, latencyMs);

      return {
        status,
        reachable: true,
        authenticated: true,
        latencyMs,
        message: this.buildMessage(status, latencyMs),
        timestamp,
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      this.logger.warn({ err: error, latencyMs }, 'PandaScore API health check failed');

      if (error instanceof AuthenticationError) {
        return {
          status: 'unhealthy',
          reachable: true,
          authenticated: false,
          latencyMs,
          message: 'PandaScore API authentication failed — check API token',
          timestamp,
        };
      }

      return {
        status: 'unhealthy',
        reachable: false,
        authenticated: false,
        latencyMs,
        message: `PandaScore API is unreachable: ${(error as Error).message}`,
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
    latencyMs: number,
  ): PandascoreHealthStatus {
    if (!reachable || !authenticated) {
      return 'unhealthy';
    }

    if (latencyMs >= this.thresholds.degradedLatencyMs) {
      return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Builds a human-readable health message.
   */
  private buildMessage(status: PandascoreHealthStatus, latencyMs: number): string {
    if (status === 'healthy') {
      return `PandaScore API is healthy (${latencyMs}ms)`;
    }

    if (status === 'degraded') {
      return `PandaScore API is degraded — high latency (${latencyMs}ms)`;
    }

    return 'PandaScore API is unhealthy';
  }
}