// ──────────────────────────────────────────────
// PandaScore API — Type Definitions
// ──────────────────────────────────────────────
//
// Reference: https://pandascore.co/docs/
//
// These types mirror the actual API response structures.
// All field names use the API's native snake_case format.

// ──────────────────────────────────────────────
// Union Types
// ──────────────────────────────────────────────

/**
 * PandaScore URL-path slugs for supported esports.
 *
 * These are the path segments used in PandaScore API endpoints, e.g.
 * GET /csgo/matches/upcoming — NOT the same as our EsportsVideogame domain keys.
 * Use ESPORTS_TO_PANDASCORE_SLUG in match-ingestion.service.ts to translate.
 */
export type VideogameKey = 'csgo' | 'valorant' | 'lol' | 'dota2';

/**
 * Videogame names as returned by the PandaScore API in the `videogame.name` field.
 * CS2 matches are served under the legacy "Counter-Strike" name on PandaScore.
 */
export type VideogameName = 'Counter-Strike' | 'Valorant' | 'LoL' | 'Dota 2';

/** The current status of a match. */
export type PandascoreMatchStatus =
  | 'not_started'
  | 'running'
  | 'finished'
  | 'canceled'
  | 'postponed';

/** The type of an opponent entry. */
export type OpponentType = 'Team' | 'Player';

/** The type of a match result. */
export type MatchResultType = 'draw' | 'win' | 'loss';

/** The side a team plays on in a match. */
export type Side = 'home' | 'away';

// ──────────────────────────────────────────────
// Videogame
// ──────────────────────────────────────────────

/** A videogame supported by PandaScore. */
export interface Videogame {
  readonly id: number;
  readonly name: VideogameName;
  readonly slug: VideogameKey;
}

// ──────────────────────────────────────────────
// League
// ──────────────────────────────────────────────

/** A league/organiser of esports tournaments. */
export interface League {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly image_url: string | null;
  readonly url: string | null;
  readonly modified_at: string;
}

// ──────────────────────────────────────────────
// Tournament
// ──────────────────────────────────────────────

/** A tournament within a league. */
export interface Tournament {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly begin_at: string | null;
  readonly end_at: string | null;
  readonly league_id: number;
  readonly league?: League;
  readonly serie_id: number | null;
  readonly prizepool: string | null;
  readonly modified_at: string;
}

// ──────────────────────────────────────────────
// Player
// ──────────────────────────────────────────────

/** A professional esports player. */
export interface Player {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly image_url: string | null;
  readonly nationality: string | null;
  readonly role: string | null;
  readonly birthday: string | null;
  readonly age: number | null;
  readonly modified_at: string;
}

// ──────────────────────────────────────────────
// Team
// ──────────────────────────────────────────────

/** An esports team. */
export interface Team {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly acronym: string | null;
  readonly image_url: string | null;
  readonly location: string | null;
  readonly players: readonly Player[];
  readonly modified_at: string;
}

// ──────────────────────────────────────────────
// Opponent
// ──────────────────────────────────────────────

/** An opponent entry within a match (team or player). */
export interface Opponent {
  readonly type: OpponentType;
  readonly opponent: Team | Player;
}

// ──────────────────────────────────────────────
// Game
// ──────────────────────────────────────────────

/** A single game (map/round) within a match. */
export interface Game {
  readonly id: number;
  readonly begin_at: string | null;
  readonly end_at: string | null;
  readonly status: PandascoreMatchStatus;
  readonly winner: GameWinner | null;
  readonly match_id: number;
  readonly position: number;
  readonly length: number | null;
}

/** The winner of a single game. */
export interface GameWinner {
  readonly id: number;
  readonly type: OpponentType;
}

/** Results for a team in a match. */
export interface TeamResult {
  readonly team_id: number;
  readonly score: number;
  readonly side: Side | null;
}

// ──────────────────────────────────────────────
// Match
// ──────────────────────────────────────────────

/** An esports match. */
export interface Match {
  readonly id: number;
  readonly begin_at: string | null;
  readonly end_at: string | null;
  readonly status: PandascoreMatchStatus;
  readonly scheduled_at: string | null;
  readonly match_type: string | null;
  readonly number_of_games: number | null;
  readonly tournament_id: number;
  readonly league_id: number;
  readonly tournament?: Tournament;
  readonly league?: League;
  readonly videogame: Videogame;
  readonly videogame_title: VideogameName | null;
  readonly videogame_version: string | null;
  readonly opponents: readonly Opponent[] | null;
  readonly results: readonly TeamResult[] | null;
  readonly games: readonly Game[] | null;
  readonly winner: MatchWinner | null;
  readonly draw: boolean;
  readonly forfeit: boolean;
  readonly modified_at: string;
  readonly slug: string;
  readonly live_url: string | null;
  readonly original_scheduled_at: string | null;
}

/** The winning team/player of a match. */
export interface MatchWinner {
  readonly id: number;
  readonly type: OpponentType;
}

/** Response from GET /{videogame}/matches or GET /matches. */
export type GetMatchesResponse = readonly Match[];

/** Response from GET /{videogame}/matches/upcoming. */
export type GetUpcomingMatchesResponse = readonly Match[];

/** Response from GET /{videogame}/matches/running. */
export type GetRunningMatchesResponse = readonly Match[];

/** Response from GET /{videogame}/matches/past. */
export type GetPastMatchesResponse = readonly Match[];

// ──────────────────────────────────────────────
// Series
// ──────────────────────────────────────────────

/** A series of tournaments (e.g., "Season 2024"). */
export interface Serie {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly begin_at: string | null;
  readonly end_at: string | null;
  readonly season: string | null;
  readonly year: number | null;
  readonly modified_at: string;
}

// ──────────────────────────────────────────────
// API Error Response
// ──────────────────────────────────────────────

/** Error response from PandaScore API. */
export interface PandascoreApiError {
  readonly error: string;
  readonly message: string | null;
  readonly status: number;
}

// ──────────────────────────────────────────────
// Pagination
// ──────────────────────────────────────────────

/** Pagination metadata from response headers. */
export interface PaginationMeta {
  /** Current page number. */
  readonly page: number;
  /** Number of items per page. */
  readonly perPage: number;
  /** Total number of items across all pages. */
  readonly total: number;
  /** Total number of pages. */
  readonly totalPages: number;
}

// ──────────────────────────────────────────────
// Request Parameters
// ──────────────────────────────────────────────

/** Common pagination parameters for PandaScore requests. */
export interface PaginationParams {
  /** Page number (1-based). */
  readonly page?: number;
  /** Number of items per page. */
  readonly perPage?: number;
}

/** Parameters for listing matches. */
export interface MatchListParams extends PaginationParams {
  /** Filter by league IDs (comma-separated). */
  readonly leagueId?: string;
  /** Filter by tournament IDs (comma-separated). */
  readonly tournamentId?: string;
  /** Filter by team IDs (comma-separated). */
  readonly teamId?: string;
  /** ISO 8601 date range start. */
  readonly rangeBeginAt?: string;
  /** ISO 8601 date range end. */
  readonly rangeEndAt?: string;
  /** Sort field (e.g., 'begin_at', '-begin_at' for descending). */
  readonly sort?: string;
}

/** Parameters for searching teams. */
export interface TeamSearchParams {
  /** Search query for team name. */
  readonly search?: string;
  /** Filter by videogame. */
  readonly videogame?: VideogameKey;
}