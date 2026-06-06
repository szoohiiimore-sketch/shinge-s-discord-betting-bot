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
    const response = await this.request(`/${videogame}/matches/upcoming`);
    return response as GetUpcomingMatchesResponse;
  }

  async getRunningMatches(videogame: VideogameKey): Promise<GetRunningMatchesResponse> {
    const response = await this.request(`/${videogame}/matches/running`);
    return response as GetRunningMatchesResponse;
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
   * Makes an HTTP GET request to PandaScore API.
   */
  private async request(path: string): Promise<unknown> {
    const url = new URL(`${this.config.baseUrl}${path}`);

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
        await this.handleErrorResponse(response, path);
      }

      const data: unknown = await response.json();

      this.logger.debug(
        { path: url.pathname, status: response.status },
        'Received response from PandaScore API',
      );

      return data;
    } catch (error) {
      if (error instanceof ExternalApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new ExternalApiError(`Request to ${path} timed out after ${this.config.timeoutMs}ms`, {
          retryable: true,
          context: { api: 'pandascore', endpoint: path, timeoutMs: this.config.timeoutMs },
        });
      }

      throw new ExternalApiError(`Request to ${path} failed: ${(error as Error).message}`, {
        retryable: true,
        cause: error instanceof Error ? error : undefined,
        context: { api: 'pandascore', endpoint: path },
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