/**
 * Esports game identifiers as used by OddsPapi.
 */
export type OddspapiVideogame = 'cs2' | 'dota2' | 'lol' | 'valorant';

export interface OddspapiOutcome {
  readonly name: string;      // team name string
  readonly price: number;     // decimal odds
}

export interface OddspapiBookmaker {
  readonly key: string;       // e.g. 'pinnacle', 'bet365'
  readonly title: string;
  readonly outcomes: readonly OddspapiOutcome[];
}

export interface OddspapiMatchOdds {
  readonly id: string;
  readonly game: OddspapiVideogame;
  readonly home_team: string;
  readonly away_team: string;
  readonly commence_time: string;  // ISO 8601
  readonly bookmakers: readonly OddspapiBookmaker[];
}

export type GetOddsForGameResponse = readonly OddspapiMatchOdds[];