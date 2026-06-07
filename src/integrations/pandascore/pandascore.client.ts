import type { Logger } from '@/lib/logger';
import { ExternalApiError, RateLimitError, AuthenticationError } from '@/lib/errors';
import type {
  GetUpcomingMatchesResponse,
  GetRunningMatchesResponse,
  GetPastMatchesResponse,
  Match,
  VideogameKey,
  Team,
} from './types';
import type { PandascoreClientConfig } from './pandascore.config';

/**
 * Public interface for PandaScore API client.
 *
 * All methods throw on non-2xx responses using the existing error hierarchy.
 * Timeouts are enforced via AbortController.
 */
export interface PandascoreClient {
  /** Fetches upcoming matches for a specific game. */
  getUpcomingMatches(videogame: VideogameKey): Promise<GetUpcomingMatchesResponse>;

  /** Fetches currently running matches for a specific game. */
  getRunningMatches(videogame: VideogameKey): Promise<GetRunningMatchesResponse>;

  /** Fetches past (finished) matches for a specific game. */
  getPastMatches(videogame: VideogameKey): Promise<GetPastMatchesResponse>;

  /** Fetches a single match by its ID. */
  getMatch(matchId: number): Promise<Match>;

  /** Fetches a single team by its ID. */
  getTeam(teamId: number): Promise<Team>;
}

/**
 * HTTP client for PandaScore API.
 *
 * Uses native fetch with AbortController timeout.
 * All errors are translated to the existing error hierarchy.
 */
export class DefaultPandascoreClient implements PandascoreClient {
  private readonly config: PandascoreClientConfig;
  private readonly logger: Logger;

  constructor(config: PandascoreClientConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ module: 'pandascore' });
  }

  async getUpcomingMatches(videogame: VideogameKey): Promise<GetUpcomingMatchesResponse> {
    const items = await this.requestPaginated(`/${videogame}/matches/upcoming`);
    return items as GetUpcomingMatchesResponse;
  }

  async getRunningMatches(videogame: VideogameKey): Promise<GetRunningMatchesResponse> {
    const items = await this.requestPaginated(`/${videogame}/matches/running`);
    return items as GetRunningMatchesResponse;
  }

  async getPastMatches(videogame: VideogameKey): Promise<GetPastMatchesResponse> {
    const response = await this.request(`/${videogame}/matches/past`);
    return response as GetPastMatchesResponse;
  }

  async getMatch(matchId: number): Promise<Match> {
    const response = await this.request(`/matches/${matchId}`);
    return response as Match;
  }

  async getTeam(teamId: number): Promise<Team> {
    const response = await this.request(`/teams/${teamId}`);
    return response as Team;
  }

  /**
   * Fetches all pages for a paginated endpoint and returns the merged item array.
   *
   * Uses X-Total response header to determine total item count. Stops at MAX_PAGES
   * regardless of X-Total to prevent unbounded fetches.
   * A 150 ms inter-page delay avoids bursting PandaScore's rate limit.
   */
  private async requestPaginated(path: string): Promise<unknown[]> {
    const PER_PAGE = 100;
    const MAX_PAGES = 20;
    const PAGE_DELAY_MS = 150;

    const allItems: unknown[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL(`${this.config.baseUrl}${path}`);
      url.searchParams.set('per_page', String(PER_PAGE));
      url.searchParams.set('page', String(page));

      const response = await this._execute(url);

      const data = await response.json() as unknown[];
      if (!Array.isArray(data) || data.length === 0) break;

      allItems.push(...data);

      const total = parseInt(response.headers.get('X-Total') ?? '0', 10);
      if (allItems.length >= total || data.length < PER_PAGE) break;

      if (page < MAX_PAGES) {
        await new Promise<void>((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
      }
    }

    this.logger.debug({ path, totalFetched: allItems.length }, 'Paginated fetch complete');
    return allItems;
  }

  /**
   * Makes an HTTP GET request to PandaScore API, returning the parsed JSON body.
   *
   * Used for single-object endpoints (getMatch, getTeam, getPastMatches).
   */
  private async request(path: string): Promise<unknown> {
    const url = new URL(`${this.config.baseUrl}${path}`);
    const response = await this._execute(url);
    return response.json();
  }

  /**
   * Executes a single authenticated HTTP GET to PandaScore and returns the raw Response.
   *
   * Applies timeout via AbortController and translates non-2xx / network errors
   * into the typed error hierarchy. Callers are responsible for reading the body.
   */
  private async _execute(url: URL): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      this.logger.debug({ path: url.pathname }, 'Sending request to PandaScore API');

      const response = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.apiToken}`,
        },
      });

      if (!response.ok) {
        await this.handleErrorResponse(response, url.pathname);
      }

      this.logger.debug(
        { path: url.pathname, status: response.status },
        'Received response from PandaScore API',
      );

      return response;
    } catch (error) {
      if (error instanceof ExternalApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new ExternalApiError(`Request to ${url.pathname} timed out after ${this.config.timeoutMs}ms`, {
          retryable: true,
          context: { api: 'pandascore', endpoint: url.pathname, timeoutMs: this.config.timeoutMs },
        });
      }

      throw new ExternalApiError(`Request to ${url.pathname} failed: ${(error as Error).message}`, {
        retryable: true,
        cause: error instanceof Error ? error : undefined,
        context: { api: 'pandascore', endpoint: url.pathname },
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

    let errorBody: string | undefined;
    try {
      errorBody = await response.text();
    } catch {
      // Ignore parse errors on error responses
    }

    const context: Record<string, unknown> = {
      api: 'pandascore',
      endpoint: path,
      statusCode,
      errorBody,
    };

    if (statusCode === 401 || statusCode === 403) {
      throw new AuthenticationError(
        `PandaScore API authentication failed (HTTP ${statusCode})`,
        { context },
      );
    }

    if (statusCode === 429) {
      throw new RateLimitError(
        `PandaScore API rate limit exceeded (HTTP 429)`,
        { context },
      );
    }

    throw new ExternalApiError(
      `PandaScore API returned HTTP ${statusCode} for ${path}`,
      {
        statusCode,
        retryable: statusCode >= 500,
        context,
      },
    );
  }
}