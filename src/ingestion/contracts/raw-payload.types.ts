import type { Sport, MatchOdds } from '@/integrations/the-odds-api/types';
import type { Match } from '@/integrations/pandascore/types';

/** A sport/competition entry from GET /v4/sports. */
export type RawOddsApiSport = Sport;

/**
 * A match entry from GET /v4/sports/{key}/odds.
 * Teams are represented as display name strings — no IDs are provided by this API.
 */
export type RawOddsApiMatchOdds = MatchOdds;

/**
 * A match entry from GET /{videogame}/matches/*.
 * Opponent teams carry numeric IDs and full Team objects.
 */
export type RawPandascoreMatch = Match;
