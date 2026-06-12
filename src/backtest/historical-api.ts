/**
 * The Odds API v4 — HISTORICAL endpoints client (engine-only).
 *
 * Why this exists instead of extending the live OddsApiClient: the live
 * client once carried a dead `getHistoricalOdds()` targeting
 * `/sports/{sport}/odds-history` with dateFrom/dateTo — an endpoint shape
 * that does not exist in The Odds API v4 (since removed). The real contract is:
 *
 *   GET /v4/historical/sports/{sport}/odds?date=<ISO>&regions=...&markets=h2h
 *     → { timestamp, previous_timestamp, next_timestamp, data: Event[] }
 *   GET /v4/historical/sports/{sport}/events?date=<ISO>
 *     → { timestamp, previous_timestamp, next_timestamp, data: EventStub[] }
 *
 * `date` returns the closest stored snapshot AT OR BEFORE the requested time;
 * navigation is via previous/next_timestamp. Odds snapshots cost
 * 10 × markets × regions credits; the events endpoint costs 1.
 *
 * This client is deliberately standalone (native fetch, zero app imports) so
 * the live integration layer stays untouched by the research engine.
 */

export interface HistoricalApiConfig {
  readonly apiKey: string;
  readonly baseUrl?: string; // default https://api.the-odds-api.com/v4
  readonly timeoutMs?: number; // default 30s
}

export interface HistoricalApiOutcome {
  readonly name: string;
  readonly price: number;
}

export interface HistoricalApiMarket {
  readonly key: string;
  readonly outcomes: readonly HistoricalApiOutcome[];
}

export interface HistoricalApiBookmaker {
  readonly key: string;
  readonly markets: readonly HistoricalApiMarket[];
}

export interface HistoricalApiEvent {
  readonly id: string;
  readonly sport_key: string;
  readonly commence_time: string;
  readonly home_team: string;
  readonly away_team: string;
  readonly bookmakers: readonly HistoricalApiBookmaker[];
}

export interface HistoricalApiEventStub {
  readonly id: string;
  readonly sport_key: string;
  readonly commence_time: string;
  readonly home_team: string;
  readonly away_team: string;
}

export interface HistoricalEnvelope<T> {
  readonly timestamp: string;
  readonly previous_timestamp: string | null;
  readonly next_timestamp: string | null;
  readonly data: readonly T[];
}

export interface QuotaHeaders {
  /** Credits charged for this request (x-requests-last). */
  readonly lastCost: number | null;
  /** Monthly credits remaining (x-requests-remaining). */
  readonly remaining: number | null;
}

export type HistoricalOddsResponse = HistoricalEnvelope<HistoricalApiEvent> & { readonly quota: QuotaHeaders };
export type HistoricalEventsResponse = HistoricalEnvelope<HistoricalApiEventStub> & { readonly quota: QuotaHeaders };

const DEFAULT_BASE_URL = 'https://api.the-odds-api.com/v4';
const DEFAULT_TIMEOUT_MS = 30_000;

async function get(config: HistoricalApiConfig, path: string, params: Record<string, string>): Promise<{ body: unknown; quota: QuotaHeaders }> {
  const url = new URL(`${config.baseUrl ?? DEFAULT_BASE_URL}${path}`);
  url.searchParams.set('apiKey', config.apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
    const lastCostHeader = response.headers.get('x-requests-last');
    const remainingHeader = response.headers.get('x-requests-remaining');
    const quota: QuotaHeaders = {
      lastCost: lastCostHeader !== null ? parseInt(lastCostHeader, 10) : null,
      remaining: remainingHeader !== null ? parseInt(remainingHeader, 10) : null,
    };
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Historical API HTTP ${response.status} for ${path}: ${text.slice(0, 300)}`);
    }
    return { body: await response.json(), quota };
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetches the sport-level odds snapshot closest at-or-before `dateIso`. */
export async function fetchHistoricalOdds(
  config: HistoricalApiConfig,
  sportKey: string,
  dateIso: string,
  regions: string,
  markets: string = 'h2h',
): Promise<HistoricalOddsResponse> {
  const { body, quota } = await get(config, `/historical/sports/${sportKey}/odds`, {
    date: dateIso,
    regions,
    markets,
    oddsFormat: 'decimal',
    dateFormat: 'iso',
  });
  return { ...(body as HistoricalEnvelope<HistoricalApiEvent>), quota };
}

/** Fetches the event list snapshot closest at-or-before `dateIso` (1 credit). */
export async function fetchHistoricalEvents(
  config: HistoricalApiConfig,
  sportKey: string,
  dateIso: string,
): Promise<HistoricalEventsResponse> {
  const { body, quota } = await get(config, `/historical/sports/${sportKey}/events`, {
    date: dateIso,
    dateFormat: 'iso',
  });
  return { ...(body as HistoricalEnvelope<HistoricalApiEventStub>), quota };
}

/** Credit cost of one historical odds snapshot request. */
export function historicalOddsCreditCost(regions: string, markets: string = 'h2h'): number {
  const regionCount = regions.split(',').filter(r => r.trim() !== '').length;
  const marketCount = markets.split(',').filter(m => m.trim() !== '').length;
  return 10 * regionCount * marketCount;
}
