export type { PandascoreClient } from './pandascore.client';
export { DefaultPandascoreClient } from './pandascore.client';
export type { PandascoreClientConfig } from './pandascore.config';
export { PANDASCORE_DEFAULTS } from './pandascore.config';
export { createPandascoreClient } from './pandascore.factory';

// Resilience layer
export type { PandascoreRetryConfig } from './pandascore.retry.config';
export { DEFAULT_PANDASCORE_RETRY_CONFIG } from './pandascore.retry.config';
export {
  isPandascoreRetryable,
  calculatePandascoreBackoff,
  calculatePandascoreRetryDelay,
  withPandascoreRetry,
} from './pandascore.retry.helper';
export { ResilientPandascoreClient } from './pandascore.resilient-client';

// Health check
export type { PandascoreHealthResult, PandascoreHealthStatus, PandascoreHealthThresholds } from './pandascore.health.types';
export { PandascoreHealthChecker, DEFAULT_PANDASCORE_HEALTH_THRESHOLDS } from './pandascore.health.checker';

export type {
  VideogameKey,
  VideogameName,
  PandascoreMatchStatus,
  OpponentType,
  MatchResultType,
  Side,
  Videogame,
  League,
  Tournament,
  Player,
  Team,
  Opponent,
  Game,
  GameWinner,
  TeamResult,
  Match,
  MatchWinner,
  GetMatchesResponse,
  GetUpcomingMatchesResponse,
  GetRunningMatchesResponse,
  GetPastMatchesResponse,
  Serie,
  PandascoreApiError,
  PaginationMeta,
  PaginationParams,
  MatchListParams,
  TeamSearchParams,
} from './types';
