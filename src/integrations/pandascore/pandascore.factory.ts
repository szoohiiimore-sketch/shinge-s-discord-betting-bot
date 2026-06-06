import type { Logger } from '@/lib/logger';
import type { PandascoreClientConfig } from './pandascore.config';
import { PANDASCORE_DEFAULTS } from './pandascore.config';
import { DefaultPandascoreClient } from './pandascore.client';
import type { PandascoreClient } from './pandascore.client';

/**
 * Creates a configured PandaScore API client.
 *
 * Uses constructor injection: all dependencies (config, logger)
 * are passed explicitly. No global state or service locator.
 *
 * Defaults:
 * - baseUrl: https://api.pandascore.co
 * - timeout: 15 seconds
 *
 * @param config - Client configuration (apiToken required, baseUrl and timeout optional)
 * @param logger - Logger instance for structured logging
 * @returns A fully configured PandascoreClient
 *
 * @example
 * const client = createPandascoreClient(
 *   { apiToken: config.api.pandascoreApiKey },
 *   logger,
 * );
 * const matches = await client.getUpcomingMatches('cs2');
 */
export function createPandascoreClient(
  config: Omit<PandascoreClientConfig, 'baseUrl' | 'timeoutMs'> & {
    baseUrl?: string;
    timeoutMs?: number;
  },
  logger: Logger,
): PandascoreClient {
  const fullConfig: PandascoreClientConfig = {
    apiToken: config.apiToken,
    baseUrl: config.baseUrl ?? PANDASCORE_DEFAULTS.BASE_URL,
    timeoutMs: config.timeoutMs ?? PANDASCORE_DEFAULTS.TIMEOUT_MS,
  };

  return new DefaultPandascoreClient(fullConfig, logger);
}