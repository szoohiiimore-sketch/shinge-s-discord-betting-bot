import type { Logger } from '@/lib/logger';
import { ExternalApiError } from '@/lib/errors';
import type { OddsApiClient } from './the-odds-api.client';
import type { RetryConfig } from './retry.config';
import { DEFAULT_RETRY_CONFIG } from './retry.config';
import { withRetry } from './retry.helper';
import type { QuotaState, RateLimitState } from './quota.types';
import { createInitialQuotaState } from './quota.types';
import type {
  GetSportsResponse,
  GetOddsResponse,
  GetScoresResponse,
  OddsRequestParams,
} from './types';

/**
 * A decorator that adds retry logic and quota tracking
 * around a base OddsApiClient.
 *
 * This wraps the base client rather than modifying it, preserving
 * the single-responsibility of each layer.
 *
 * Constructor injection: all dependencies are passed explicitly.
 * No global mutable state: quota/rate-limit state is instance-scoped.
 */
export class ResilientOddsApiClient implements OddsApiClient {
  private readonly inner: OddsApiClient;
  private readonly config: RetryConfig;
  private readonly logger: Logger;

  private quota: QuotaState;

  constructor(
    inner: OddsApiClient,
    logger: Logger,
    config: RetryConfig = DEFAULT_RETRY_CONFIG,
  ) {
    this.inner = inner;
    this.config = config;
    this.logger = logger.child({ module: 'resilient-client' });
    this.quota = createInitialQuotaState();
  }

  /** Returns the current quota state (snapshot). */
  getQuotaState(): QuotaState {
    return this.quota;
  }

  /** Returns the current rate-limit state. Always derived from quota. */
  getRateLimitState(): RateLimitState {
    return {
      isLimited: this.quota.isExhausted,
      retryAfterMs: this.quota.resetAt > 0 ? this.quota.resetAt * 1000 : 0,
      message: this.quota.isExhausted
        ? 'Monthly API quota is exhausted'
        : 'No active rate limit',
    };
  }

  async getSports(): Promise<GetSportsResponse> {
    return this.executeWithResilience(
      () => this.inner.getSports(),
      'getSports',
    );
  }

  async getOdds(sportKey: string, params?: OddsRequestParams): Promise<GetOddsResponse> {
    return this.executeWithResilience(
      () => this.inner.getOdds(sportKey, params),
      'getOdds',
    );
  }

  async getScores(sportKey: string, daysFrom?: number): Promise<GetScoresResponse> {
    return this.executeWithResilience(
      () => this.inner.getScores(sportKey, daysFrom),
      'getScores',
    );
  }

  /**
   * Executes an API call with retry logic.
   *
   * After completion (success or failure), syncs quota state from the
   * inner client. The base client now owns quota tracking via response
   * header parsing, so this class delegates to it.
   */
  private async executeWithResilience<T>(
    operation: (attempt: number) => Promise<T>,
    operationName: string,
  ): Promise<T> {
    try {
      const result = await withRetry(
        operation,
        this.config,
        this.logger,
        operationName,
      );
      // Sync quota state from inner client after successful request
      this.syncQuota();
      return result;
    } catch (error) {
      // Sync quota state from inner client even on error
      // (the base client parses quota headers from error responses too)
      this.syncQuota();
      this.updateQuotaFromError(error);
      throw error;
    }
  }

  /**
   * Syncs quota state from the inner client.
   *
   * The base client (DefaultOddsApiClient) now has getQuotaState()
   * and parses quota headers from every response. This decorator
   * reads that state rather than tracking it independently.
   */
  private syncQuota(): void {
    if ('getQuotaState' in this.inner && typeof (this.inner as any).getQuotaState === 'function') {
      this.quota = (this.inner as any).getQuotaState();
    }
  }

  /**
   * Updates the quota state based on error context.
   *
   * The Odds API may include x-requests-remaining or similar
   * headers in error responses. If not available, we estimate
   * based on the error type.
   */
  private updateQuotaFromError(error: unknown): void {
    if (!(error instanceof ExternalApiError)) {
      return;
    }

    const context = error.context ?? {};

    // Try to extract quota info from error context
    const remaining = context.requestsRemaining as number | undefined;
    const total = context.totalRequests as number | undefined;
    const resetAt = context.resetTimestamp as number | undefined;

    if (remaining !== undefined && total !== undefined && total > 0) {
      const now = Date.now();
      this.quota = {
        totalRequests: total,
        requestsRemaining: remaining,
        resetAt: resetAt ?? 0,
        lastCheckedAt: now,
        isExhausted: remaining <= 0,
        utilizationPercent: total > 0 ? 1 - remaining / total : 0,
      };
    } else if (context.statusCode === 429) {
      // Rate-limited: mark quota as potentially exhausted
      const retryAfter = context.retryAfterMs as number | undefined;
      this.quota = {
        totalRequests: this.quota.totalRequests,
        requestsRemaining: 0,
        resetAt: retryAfter ? Math.floor((Date.now() + retryAfter) / 1000) : 0,
        lastCheckedAt: Date.now(),
        isExhausted: true,
        utilizationPercent: this.quota.totalRequests > 0 ? 1 : 0,
      };
    }
  }
}