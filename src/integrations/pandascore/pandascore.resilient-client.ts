import type { Logger } from '@/lib/logger';
import type { PandascoreClient } from './pandascore.client';
import type { PandascoreRetryConfig } from './pandascore.retry.config';
import { DEFAULT_PANDASCORE_RETRY_CONFIG } from './pandascore.retry.config';
import { withPandascoreRetry } from './pandascore.retry.helper';
import type {
  GetUpcomingMatchesResponse,
  GetRunningMatchesResponse,
  GetPastMatchesResponse,
  Match,
  VideogameKey,
  Team,
} from './types';

/**
 * A decorator that adds retry logic around a base PandascoreClient.
 *
 * Wraps the base client to preserve single-responsibility.
 * Constructor injection: all dependencies passed explicitly.
 * No global mutable state.
 */
export class ResilientPandascoreClient implements PandascoreClient {
  private readonly inner: PandascoreClient;
  private readonly config: PandascoreRetryConfig;
  private readonly logger: Logger;

  constructor(
    inner: PandascoreClient,
    logger: Logger,
    config: PandascoreRetryConfig = DEFAULT_PANDASCORE_RETRY_CONFIG,
  ) {
    this.inner = inner;
    this.config = config;
    this.logger = logger.child({ module: 'pandascore-resilient' });
  }

  async getUpcomingMatches(videogame: VideogameKey): Promise<GetUpcomingMatchesResponse> {
    return this.executeWithRetry(
      () => this.inner.getUpcomingMatches(videogame),
      'getUpcomingMatches',
    );
  }

  async getRunningMatches(videogame: VideogameKey): Promise<GetRunningMatchesResponse> {
    return this.executeWithRetry(
      () => this.inner.getRunningMatches(videogame),
      'getRunningMatches',
    );
  }

  async getPastMatches(videogame: VideogameKey): Promise<GetPastMatchesResponse> {
    return this.executeWithRetry(
      () => this.inner.getPastMatches(videogame),
      'getPastMatches',
    );
  }

  async getMatch(matchId: number): Promise<Match> {
    return this.executeWithRetry(
      () => this.inner.getMatch(matchId),
      'getMatch',
    );
  }

  async getTeam(teamId: number): Promise<Team> {
    return this.executeWithRetry(
      () => this.inner.getTeam(teamId),
      'getTeam',
    );
  }

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    return withPandascoreRetry(
      operation,
      this.config,
      this.logger,
      operationName,
    );
  }
}