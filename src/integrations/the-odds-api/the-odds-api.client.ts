import type { Logger } from '@/lib/logger';
import { ExternalApiError, RateLimitError, AuthenticationError } from '@/lib/errors';
import type {
  GetSportsResponse,
  GetOddsResponse,
  GetHistoricalOddsResponse,
  OddsRequestParams,
  HistoricalOddsRequestParams,
} from './types';
import type { OddsApiClientConfig } from './the-odds-api.config';
import type { QuotaState } from './quota.types';
import { createInitialQuotaState } from './quota.types';

/**
 * Public interface for The Odds API client.
 *
 * All methods throw on non-2xx responses using the existing error hierarchy.
 * Timeouts are enforced via AbortController.
 */
export interface OddsApiClient {
  /** Fetches the list of available sports. */
  getSports(): Promise<GetSportsResponse>;

  /** Fetches odds for a specific sport with optional query parameters. */
  getOdds(sportKey: string, params?: OddsRequestParams): Promise<GetOddsResponse>;

  /** Fetches historical odds snapshots for a sport. */
  getHistoricalOdds(
    sportKey: string,
    params?: HistoricalOddsRequestParams,
  ): Promise<GetHistoricalOddsResponse>;
}

/**
 * HTTP client for The Odds API v4.
 *
 * Uses native fetch with AbortController timeout.
 * All errors are translated to the existing error hierarchy.
 * No retry or rate-limiting logic — these are added at the caller level.
 */
export class DefaultOddsApiClient implements OddsApiClient {
  private readonly config: OddsApiClientConfig;
  private readonly logger: Logger;
  private quota: QuotaState;

  constructor(config: OddsApiClientConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ module: 'the-odds-api' });
    this.quota = createInitialQuotaState();
  }

  /** Returns a snapshot of the current quota state. */
  getQuotaState(): QuotaState {
    return this.quota;
  }

  async getSports(): Promise<GetSportsResponse> {
    const response = await this.request('/sports');
    return response as GetSportsResponse;
  }

  async getOdds(sportKey: string, params?: OddsRequestParams): Promise<GetOddsResponse> {
    const searchParams = this.buildSearchParams(params);
    const response = await this.request(`/sports/${sportKey}/odds`, searchParams);
    return response as GetOddsResponse;
  }

  async getHistoricalOdds(
    sportKey: string,
    params?: HistoricalOddsRequestParams,
  ): Promise<GetHistoricalOddsResponse> {
    const searchParams = this.buildSearchParams(params);
    const response = await this.request(`/sports/${sportKey}/odds-history`, searchParams);
    return response as GetHistoricalOddsResponse;
  }

  /**
   * Makes an HTTP GET request to The Odds API.
   */
  private async request(path: string, searchParams?: URLSearchParams): Promise<unknown> {
    const url = new URL(`${this.config.baseUrl}${path}`);
    url.searchParams.set('apiKey', this.config.apiKey);

    if (searchParams) {
      for (const [key, value] of searchParams.entries()) {
        url.searchParams.set(key, value);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      this.logger.debug({ path: url.pathname, query: url.search }, 'Sending request to The Odds API');

      const response = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        await this.handleErrorResponse(response, path);
      }

      const data: unknown = await response.json();

      // Parse quota headers from every successful response
      this.updateQuotaFromHeaders(response.headers);

      this.logger.debug(
        { path: url.pathname, status: response.status },
        'Received response from The Odds API',
      );

      return data;
    } catch (error) {
      if (error instanceof ExternalApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new ExternalApiError(`Request to ${path} timed out after ${this.config.timeoutMs}ms`, {
          retryable: true,
          context: { api: 'the-odds-api', endpoint: path, timeoutMs: this.config.timeoutMs },
        });
      }

      throw new ExternalApiError(`Request to ${path} failed: ${(error as Error).message}`, {
        retryable: true,
        cause: error instanceof Error ? error : undefined,
        context: { api: 'the-odds-api', endpoint: path },
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Translates non-2xx HTTP responses into typed errors.
   */
  private async handleErrorResponse(response: Response, path: string): Promise<never> {
    const statusCode = response.status;

    // Try to extract API error body
    let errorBody: string | undefined;
    try {
      errorBody = await response.text();
    } catch {
      // Ignore parse errors on error responses
    }

    // Parse quota headers even on error responses so quota state stays current
    this.updateQuotaFromHeaders(response.headers);

    const context: Record<string, unknown> = {
      api: 'the-odds-api',
      endpoint: path,
      statusCode,
      errorBody,
    };

    if (statusCode === 401 || statusCode === 403) {
      throw new AuthenticationError(
        `The Odds API authentication failed (HTTP ${statusCode})`,
        { context },
      );
    }

    if (statusCode === 429) {
      // Parse Retry-After header so the resilience layer can use it
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter !== null) {
        context.retryAfterMs = parseInt(retryAfter, 10) * 1000;
      }

      throw new RateLimitError(
        `The Odds API rate limit exceeded (HTTP 429)`,
        { context },
      );
    }

    throw new ExternalApiError(
      `The Odds API returned HTTP ${statusCode} for ${path}`,
      {
        statusCode,
        retryable: statusCode >= 500,
        context,
      },
    );
  }

  /**
   * Updates quota state from API response headers.
   *
   * The Odds API returns quota information in response headers:
   * - x-requests-remaining: number of requests remaining in the current month
   * - x-requests-used: number of requests used in the current month
   */
  private updateQuotaFromHeaders(headers: Headers): void {
    const remainingHeader = headers.get('x-requests-remaining');
    const usedHeader = headers.get('x-requests-used');

    if (remainingHeader !== null && usedHeader !== null) {
      const remaining = parseInt(remainingHeader, 10);
      const used = parseInt(usedHeader, 10);
      const total = remaining + used;

      if (total > 0) {
        this.quota = {
          totalRequests: total,
          requestsRemaining: remaining,
          resetAt: 0,
          lastCheckedAt: Date.now(),
          isExhausted: remaining <= 0,
          utilizationPercent: total > 0 ? used / total : 0,
        };

        this.logger.debug(
          { requestsRemaining: remaining, requestsUsed: used, totalRequests: total },
          'Updated quota state from response headers',
        );
      }
    }
  }

  /**
   * Converts typed request parameters to URLSearchParams.
   * Accepts any object with optional properties.
   */
  private buildSearchParams(params?: object): URLSearchParams | undefined {
    if (!params) {
      return undefined;
    }

    const entries = Object.entries(params as Record<string, unknown>).filter(
      ([, value]) => value !== undefined,
    );

    if (entries.length === 0) {
      return undefined;
    }

    const searchParams = new URLSearchParams();
    for (const [key, value] of entries) {
      searchParams.set(key, String(value));
    }

    return searchParams;
  }
}