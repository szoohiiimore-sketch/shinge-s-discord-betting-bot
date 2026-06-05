import type { Logger } from '@/lib/logger';
import type { OddsApiClientConfig } from './the-odds-api.config';
import { ODDS_API_DEFAULTS } from './the-odds-api.config';
import { DefaultOddsApiClient } from './the-odds-api.client';
import type { OddsApiClient } from './the-odds-api.client';

/**
 * Creates a configured The Odds API client.
 *
 * Uses constructor injection: all dependencies (config, logger)
 * are passed explicitly. No global state or service locator.
 *
 * Defaults:
 * - baseUrl: https://api.the-odds-api.com/v4
 * - timeout: 15 seconds
 *
 * @param config - Client configuration (apiKey required, baseUrl and timeout optional)
 * @param logger - Logger instance for structured logging
 * @returns A fully configured OddsApiClient
 *
 * @example
 * const client = createOddsApiClient(
 *   { apiKey: config.api.theOddsApiKey },
 *   logger,
 * );
 * const sports = await client.getSports();
 */
export function createOddsApiClient(
  config: Omit<OddsApiClientConfig, 'baseUrl' | 'timeoutMs'> & {
    baseUrl?: string;
    timeoutMs?: number;
  },
  logger: Logger,
): OddsApiClient {
  const fullConfig: OddsApiClientConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? ODDS_API_DEFAULTS.BASE_URL,
    timeoutMs: config.timeoutMs ?? ODDS_API_DEFAULTS.TIMEOUT_MS,
  };

  return new DefaultOddsApiClient(fullConfig, logger);
}