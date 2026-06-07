export interface OddspapiClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly bookmakers: readonly string[];
}

export const ODDSPAPI_DEFAULTS = {
  BASE_URL: 'https://api.oddspapi.io',
  TIMEOUT_MS: 15_000,
  QUOTA_SOFT_LIMIT: 9_000,
  QUOTA_HARD_LIMIT: 10_000,
  COOLDOWN_MS: 4 * 60 * 60 * 1000,
  // Pinnacle is the candidate bookmaker (value bet target).
  // bet365 and unibet are the consensus bookmakers (market average).
  // ValueDetectionService requires MIN_CONSENSUS_BOOKMAKERS=2 non-Pinnacle bookmakers.
  BOOKMAKERS: ['pinnacle', 'bet365', 'unibet'] as readonly string[],
} as const;