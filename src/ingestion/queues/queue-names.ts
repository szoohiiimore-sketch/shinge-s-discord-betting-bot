/**
 * Job names used within the match-fetch queue for ingestion operations.
 */
export const MATCH_FETCH_JOB_NAMES = {
  SYNC_REFERENCE_DATA: 'sync-reference-data',
  SYNC_TRADITIONAL_SPORT: 'sync-traditional-sport',
  SYNC_ESPORTS_GAME: 'sync-esports-game',
  SETTLE_MATCHES: 'settle-matches',
  DAILY_SUMMARY: 'daily-summary',
} as const;

/**
 * Job names used within the odds-fetch queue for ingestion operations.
 */
export const ODDS_FETCH_JOB_NAMES = {
  SYNC_ODDS_FOR_SPORT: 'sync-odds-for-sport',
  SYNC_ESPORTS_ODDS: 'sync-esports-odds',
} as const;
