import type { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import type { OddspapiClientConfig } from './oddspapi.config';
import { ODDSPAPI_DEFAULTS } from './oddspapi.config';
import { DefaultOddspapiClient } from './oddspapi.client';
import { ResilientOddspapiClient } from './oddspapi.resilient-client';
import { OddspapiQuotaTracker } from './quota.tracker';
import type { OddspapiClient } from './oddspapi.client';

export function createOddspapiClient(
  config: { apiKey: string },
  redis: Redis,
  logger: Logger,
): OddspapiClient {
  const clientConfig: OddspapiClientConfig = {
    apiKey: config.apiKey,
    baseUrl: ODDSPAPI_DEFAULTS.BASE_URL,
    timeoutMs: ODDSPAPI_DEFAULTS.TIMEOUT_MS,
    bookmakers: ODDSPAPI_DEFAULTS.BOOKMAKERS,
  };
  const quotaTracker = new OddspapiQuotaTracker(
    redis,
    ODDSPAPI_DEFAULTS.QUOTA_SOFT_LIMIT,
    ODDSPAPI_DEFAULTS.QUOTA_HARD_LIMIT,
  );
  const base = new DefaultOddspapiClient(clientConfig, logger);
  return new ResilientOddspapiClient(base, quotaTracker, logger);
}