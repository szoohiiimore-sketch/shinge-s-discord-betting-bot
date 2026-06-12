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
  // Pinnacle is the sharp reference book (de-vigged fair price source).
  // bet365 and unibet are soft candidate bookmakers (value bet targets).
  // (Esports ingestion is disabled in V1 — see ESPORTS-DISABLE-IMPACT-AUDIT.md.)
  BOOKMAKERS: ['pinnacle', 'bet365', 'unibet'] as readonly string[],
} as const;