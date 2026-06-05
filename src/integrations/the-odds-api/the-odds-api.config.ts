/**
 * Configuration for the Odds API HTTP client.
 */
export interface OddsApiClientConfig {
  /** The Odds API key from environment variables. */
  readonly apiKey: string;

  /** Base URL for The Odds API (e.g., https://api.the-odds-api.com/v4). */
  readonly baseUrl: string;

  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
}

/** Default configuration values for The Odds API client. */
export const ODDS_API_DEFAULTS = {
  BASE_URL: 'https://api.the-odds-api.com/v4',
  TIMEOUT_MS: 15_000,
} as const;