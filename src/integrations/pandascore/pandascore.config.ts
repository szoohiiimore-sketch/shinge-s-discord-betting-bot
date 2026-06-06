/**
 * Configuration for the PandaScore API HTTP client.
 */
export interface PandascoreClientConfig {
  /** PandaScore API token. */
  readonly apiToken: string;

  /** Base URL for PandaScore API (e.g., https://api.pandascore.co). */
  readonly baseUrl: string;

  /** Request timeout in milliseconds. */
  readonly timeoutMs: number;
}

/** Default configuration values for PandaScore API client. */
export const PANDASCORE_DEFAULTS = {
  BASE_URL: 'https://api.pandascore.co',
  TIMEOUT_MS: 15_000,
} as const;