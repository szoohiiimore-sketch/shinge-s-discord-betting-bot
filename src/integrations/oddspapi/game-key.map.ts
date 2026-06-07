import type { EsportsVideogame } from '@/ingestion/contracts';
import type { OddspapiVideogame } from './types';

export const PANDASCORE_TO_ODDSPAPI_KEY: Record<EsportsVideogame, OddspapiVideogame> = {
  cs2:      'cs2',
  dota2:    'dota2',
  lol:      'lol',
  valorant: 'valorant',
};

/** api.oddspapi.io sportId values for each game. */
export const ODDSPAPI_SPORT_IDS: Record<OddspapiVideogame, number> = {
  cs2:      17,
  dota2:    16,
  lol:      18,
  valorant: 61,
};

/**
 * api.oddspapi.io marketId for the match-winner (H2H) market per game.
 * These are the `period="result"` moneyline markets from /v4/markets.
 * Pattern: sportId * 10 + 1 (verified against live /v4/markets response).
 */
export const ODDSPAPI_H2H_MARKET_IDS: Record<OddspapiVideogame, number> = {
  cs2:      171,
  dota2:    161,
  lol:      181,
  valorant: 611,
};

