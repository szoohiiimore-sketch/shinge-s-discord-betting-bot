import type { RawOddsApiSport, RawOddsApiMatchOdds, RawPandascoreMatch } from './raw-payload.types';
import type { CanonicalSport, CanonicalLeague, OddsApiIngestionPlan, PandascoreIngestionPlan } from './canonical.types';

/**
 * Maps a raw The Odds API sport entry to canonical reference entities.
 * One RawOddsApiSport record maps to exactly one CanonicalSport and one CanonicalLeague.
 */
export interface OddsApiSportMapper {
  toCanonicalSport(raw: RawOddsApiSport): CanonicalSport;
  toCanonicalLeague(raw: RawOddsApiSport): CanonicalLeague;
}

/**
 * Maps a raw The Odds API event (with bookmaker odds) to a complete ingestion plan.
 * capturedAt must be the timestamp of the API call — used for OddsSnapshot.capturedAt.
 */
export interface OddsApiEventMapper {
  toIngestionPlan(raw: RawOddsApiMatchOdds, capturedAt: Date): OddsApiIngestionPlan;
}

/**
 * Maps a raw PandaScore match to a complete ingestion plan.
 * Returns null when the match cannot be mapped (e.g. TBD opponents, missing team metadata).
 */
export interface PandascoreMatchMapper {
  toIngestionPlan(raw: RawPandascoreMatch): PandascoreIngestionPlan | null;
}
