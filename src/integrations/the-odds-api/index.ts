export type { OddsApiClient } from './the-odds-api.client';
export { DefaultOddsApiClient } from './the-odds-api.client';
export type { OddsApiClientConfig } from './the-odds-api.config';
export { ODDS_API_DEFAULTS } from './the-odds-api.config';
export { createOddsApiClient } from './the-odds-api.factory';
export type {
  SportKey,
  OddsMarketKey,
  BookmakerRegion,
  OddsFormat,
  MatchStatus,
  Sport,
  GetSportsResponse,
  Outcome,
  Market,
  Bookmaker,
  MatchOdds,
  GetOddsResponse,
  OddsSnapshot,
  HistoricalMatchOdds,
  GetHistoricalOddsResponse,
  ApiErrorResponse,
  RateLimitInfo,
  OddsRequestParams,
  HistoricalOddsRequestParams,
} from './types';

// Resilience layer
export type { RetryConfig } from './retry.config';
export { DEFAULT_RETRY_CONFIG } from './retry.config';
export { isRetryable, calculateBackoff, withRetry } from './retry.helper';
export type { QuotaState, RateLimitState } from './quota.types';
export { createInitialQuotaState } from './quota.types';
export { ResilientOddsApiClient } from './resilient-client';

// Health check
export type { OddsApiHealthResult, OddsApiHealthStatus, OddsApiHealthThresholds } from './health.types';
export { OddsApiHealthChecker, DEFAULT_ODDS_API_HEALTH_THRESHOLDS } from './health.checker';
