/** Identifies the external data source authority for an entity. Mirrors Prisma's ApiSource enum. */
export type IngestionSource = 'THE_ODDS_API' | 'PANDASCORE';

/** Classifies a sport as traditional or esports. Mirrors Prisma's SportCategory enum. */
export type IngestionSportCategory = 'TRADITIONAL' | 'ESPORTS';

/** Normalized match status produced by source mappers. Mirrors Prisma's MatchStatus enum. */
export type IngestionMatchStatus =
  | 'SCHEDULED'
  | 'LIVE'
  | 'FINISHED'
  | 'CANCELLED'
  | 'POSTPONED';

/** Normalized match result; set only when status is FINISHED. Mirrors Prisma's MatchResult enum. */
export type IngestionMatchResult = 'HOME_WIN' | 'AWAY_WIN' | 'DRAW';

/** Normalized odds market type. Mirrors Prisma's OddsMarket enum. */
export type IngestionOddsMarket = 'H2H' | 'SPREADS' | 'TOTALS';

/** Esports videogame identifiers supported by PandaScore in V1. */
export type EsportsVideogame = 'cs2' | 'valorant' | 'lol' | 'dota2';

/**
 * A sport competition key as used by The Odds API.
 * Examples: "soccer_epl", "basketball_nba", "americanfootball_nfl".
 */
export type TraditionalSportKey = string;

/** The entity type being ingested; used in error and result reporting. */
export type IngestionEntityType = 'Sport' | 'League' | 'Team' | 'Match' | 'OddsSnapshot';
