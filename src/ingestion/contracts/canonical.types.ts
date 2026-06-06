import type {
  IngestionSource,
  IngestionSportCategory,
  IngestionMatchStatus,
  IngestionMatchResult,
  IngestionOddsMarket,
} from './source.types';

/**
 * Normalized sport entity produced by source mappers.
 * slug is the stable DB primary key for the Sport table.
 */
export interface CanonicalSport {
  readonly slug: string;
  readonly name: string;
  readonly category: IngestionSportCategory;
  readonly externalApiSource: IngestionSource;
  readonly externalSportKey: string;
}

/**
 * Normalized league entity produced by source mappers.
 * externalId is source-namespaced: "oa:{sport_key}" for The Odds API, "ps:{id}" for PandaScore.
 */
export interface CanonicalLeague {
  readonly externalId: string;
  readonly name: string;
  readonly slug: string;
  readonly sportSlug: string;
}

/**
 * Normalized team entity produced by source mappers.
 * externalId is source-namespaced: "oa:{slugified_name}" for The Odds API, "ps:{id}" for PandaScore.
 * The Odds API provides no team IDs — the externalId is synthesized by slugifying the team name.
 */
export interface CanonicalTeam {
  readonly externalId: string;
  readonly name: string;
  readonly slug: string;
  readonly sportSlug: string;
}

/**
 * Normalized team-league membership record produced alongside match data.
 * Both externalIds reference their respective canonical entities by source-namespaced key.
 */
export interface CanonicalTeamLeague {
  readonly teamExternalId: string;
  readonly leagueExternalId: string;
  readonly sportSlug: string;
}

/**
 * Normalized match entity produced by source mappers.
 * externalId is source-namespaced: "oa:{uuid}" for The Odds API, "ps:{id}" for PandaScore.
 * Immutable structural fields (teams, league, startTime) are set only on creation.
 */
export interface CanonicalMatch {
  readonly externalId: string;
  readonly sportSlug: string;
  readonly leagueExternalId: string;
  readonly homeTeamExternalId: string;
  readonly awayTeamExternalId: string;
  readonly startTime: Date;
  readonly status: IngestionMatchStatus;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  readonly result: IngestionMatchResult | null;
}

/**
 * Normalized odds snapshot produced by the The Odds API event mapper.
 * Always appended (never upserted) — represents a point-in-time price capture.
 * matchExternalId references the match's source-namespaced externalId.
 */
export interface CanonicalOddsSnapshot {
  readonly matchExternalId: string;
  readonly bookmaker: string;
  readonly market: IngestionOddsMarket;
  readonly outcome: string;
  readonly price: number;
  readonly isMain: boolean;
  readonly isLive: boolean;
  readonly capturedAt: Date;
}

/**
 * All canonical entities derived from a single The Odds API event record.
 * teamLeagues is a fixed-length tuple: index 0 = home, index 1 = away.
 */
export interface OddsApiIngestionPlan {
  readonly sport: CanonicalSport;
  readonly league: CanonicalLeague;
  readonly homeTeam: CanonicalTeam;
  readonly awayTeam: CanonicalTeam;
  readonly match: CanonicalMatch;
  readonly teamLeagues: readonly [CanonicalTeamLeague, CanonicalTeamLeague];
  readonly oddsSnapshots: readonly CanonicalOddsSnapshot[];
}

/**
 * All canonical entities derived from a single PandaScore match record.
 * No oddsSnapshots field: PandaScore provides no bookmaker odds endpoints (V1 structural constraint).
 * teamLeagues is a fixed-length tuple: index 0 = home, index 1 = away.
 */
export interface PandascoreIngestionPlan {
  readonly sport: CanonicalSport;
  readonly league: CanonicalLeague;
  readonly homeTeam: CanonicalTeam;
  readonly awayTeam: CanonicalTeam;
  readonly match: CanonicalMatch;
  readonly teamLeagues: readonly [CanonicalTeamLeague, CanonicalTeamLeague];
}
