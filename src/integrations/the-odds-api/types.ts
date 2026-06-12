// ──────────────────────────────────────────────
// The Odds API — Type Definitions
// ──────────────────────────────────────────────
//
// Reference: https://the-odds-api.com/liveapi/guides/v4/

// ──────────────────────────────────────────────
// Union Types
// ──────────────────────────────────────────────

/** Supported sport key values. */
export type SportKey = 'soccer' | 'soccer_epl' | 'soccer_uefa_champs_league'
  | 'basketball_nba' | 'icehockey_nhl' | 'americanfootball_nfl'
  | 'tennis_atp' | 'tennis_wta' | 'mma_mixed_martial_arts';

/** The type of odds market offered by a bookmaker. */
export type OddsMarketKey = 'h2h' | 'spreads' | 'totals';

/** The region the bookmaker is available in. */
export type BookmakerRegion = 'us' | 'uk' | 'eu' | 'au' | 'nz';

/** The format of the odds price. */
export type OddsFormat = 'decimal' | 'american' | 'fractional';

/** The status of a match as reported by the API. */
export type MatchStatus = 'upcoming' | 'live' | 'ended' | 'postponed' | 'cancelled';

// ──────────────────────────────────────────────
// Sports Response
// ──────────────────────────────────────────────

/** A single sport returned by GET /v4/sports. */
export interface Sport {
  readonly key: string;
  readonly active: boolean;
  readonly group: string;
  readonly description: string;
  readonly title: string;
  readonly has_outrights: boolean;
}

/** Response from GET /v4/sports. */
export type GetSportsResponse = readonly Sport[];

// ──────────────────────────────────────────────
// Outcome
// ──────────────────────────────────────────────

/** An individual betting outcome within a market. */
export interface Outcome {
  readonly name: string;
  readonly price: number;
  readonly point: number | null;
  readonly description: string | null;
}

// ──────────────────────────────────────────────
// Market
// ──────────────────────────────────────────────

/** A betting market within a bookmaker. */
export interface Market {
  readonly key: OddsMarketKey;
  readonly last_update: string;
  readonly outcomes: readonly Outcome[];
  readonly is_main: boolean | null;
}

// ──────────────────────────────────────────────
// Bookmaker
// ──────────────────────────────────────────────

/** A bookmaker offering odds for a specific match. */
export interface Bookmaker {
  readonly key: string;
  readonly last_update: string;
  readonly title: string;
  readonly region: BookmakerRegion | null;
  readonly markets: readonly Market[];
}

// ──────────────────────────────────────────────
// Match / Game — Odds Response
// ──────────────────────────────────────────────

/** A match/game entry in the odds response. */
export interface MatchOdds {
  readonly id: string;
  readonly sport_key: string;
  readonly sport_title: string;
  readonly commence_time: string;
  readonly home_team: string;
  readonly away_team: string;
  readonly bookmakers: readonly Bookmaker[];
}

/** Response from GET /v4/sports/{sport}/odds. */
export type GetOddsResponse = readonly MatchOdds[];

// ──────────────────────────────────────────────
// API Error Response
// ──────────────────────────────────────────────

/** Error response from The Odds API. */
export interface ApiErrorResponse {
  readonly message: string | null;
  readonly status_code: number | null;
  readonly error: string | null;
}

// ──────────────────────────────────────────────
// Rate Limit Information
// ──────────────────────────────────────────────

/** Rate limit information parsed from response headers. */
export interface RateLimitInfo {
  readonly totalMonthlyRequests: number;
  readonly requestsRemaining: number;
  readonly resetTimestamp: number;
  readonly isExceeded: boolean;
}

// ──────────────────────────────────────────────
// Request Parameters
// ──────────────────────────────────────────────

/** Parameters for GET /v4/sports/{sport}/odds. */
export interface OddsRequestParams {
  readonly regions?: string;
  readonly markets?: string;
  readonly oddsFormat?: OddsFormat;
  readonly dateFormat?: 'iso' | 'unix';
  readonly commenceTimeFrom?: string;
  readonly commenceTimeTo?: string;
  readonly eventIds?: string;
  readonly bookmakerDetails?: string;
}

// ──────────────────────────────────────────────
// Scores Response
// ──────────────────────────────────────────────

/** A single team score entry within an event scores record. */
export interface ScoreEntry {
  readonly name: string;
  readonly score: string;
}

/** A completed event entry returned by GET /v4/sports/{sport}/scores. */
export interface EventScore {
  readonly id: string;
  readonly sport_key: string;
  readonly sport_title: string;
  readonly commence_time: string;
  readonly completed: boolean;
  readonly home_team: string;
  readonly away_team: string;
  readonly scores: readonly ScoreEntry[] | null;
}

/** Response from GET /v4/sports/{sport}/scores. */
export type GetScoresResponse = readonly EventScore[];
