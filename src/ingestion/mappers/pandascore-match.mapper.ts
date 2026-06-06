import type { PandascoreMatchMapper as IPandascoreMatchMapper } from '@/ingestion/contracts';
import type {
  RawPandascoreMatch,
  CanonicalSport,
  CanonicalLeague,
  CanonicalTeam,
  CanonicalTeamLeague,
  CanonicalMatch,
  PandascoreIngestionPlan,
} from '@/ingestion/contracts';
import type { Team } from '@/integrations/pandascore/types';
import {
  slugify,
  pandascoreMatchExternalId,
  mapPandascoreMatchStatus,
  mapPandascoreMatchResult,
  extractPandascoreScore,
} from './mapper.utils';

/**
 * Maps a raw PandaScore match to a complete ingestion plan.
 *
 * Returns null for matches that cannot be mapped:
 *   - opponents is null or does not contain exactly two entries
 *   - either opponent is not a Team (e.g. Player in 1v1 formats)
 *   - no schedulable start time is available (scheduled_at and begin_at both null)
 *
 * Home/away assignment follows opponents[0]/opponents[1] array order, which is a
 * convention imposed by this mapper — PandaScore has no home/away concept for esports.
 *
 * Scores represent series games won (e.g., 2–1 in a Bo3), not round scores.
 * No OddsSnapshot entities are produced — PandaScore has no bookmaker odds endpoint.
 */
export class PandascoreMatchMapper implements IPandascoreMatchMapper {
  toIngestionPlan(raw: RawPandascoreMatch): PandascoreIngestionPlan | null {
    if (!raw.opponents || raw.opponents.length !== 2) return null;
    if (raw.opponents[0].type !== 'Team' || raw.opponents[1].type !== 'Team') return null;

    const startTimeStr = raw.scheduled_at ?? raw.begin_at;
    if (!startTimeStr) return null;

    const homeOpponent = raw.opponents[0].opponent as Team;
    const awayOpponent = raw.opponents[1].opponent as Team;

    const sportSlug = raw.videogame.slug;
    const leagueExternalId = raw.league_id.toString();
    const homeTeamExternalId = homeOpponent.id.toString();
    const awayTeamExternalId = awayOpponent.id.toString();

    const sport: CanonicalSport = {
      slug: sportSlug,
      name: raw.videogame.name,
      category: 'ESPORTS',
      externalApiSource: 'PANDASCORE',
      externalSportKey: sportSlug,
    };

    const leagueName = raw.league?.name ?? leagueExternalId;
    const leagueSlug = raw.league?.slug ?? slugify(leagueName);

    const league: CanonicalLeague = {
      externalId: leagueExternalId,
      name: leagueName,
      slug: leagueSlug,
      sportSlug,
    };

    const homeTeam: CanonicalTeam = {
      externalId: homeTeamExternalId,
      name: homeOpponent.name,
      slug: homeOpponent.slug,
      sportSlug,
    };

    const awayTeam: CanonicalTeam = {
      externalId: awayTeamExternalId,
      name: awayOpponent.name,
      slug: awayOpponent.slug,
      sportSlug,
    };

    const match: CanonicalMatch = {
      externalId: pandascoreMatchExternalId(raw.id),
      sportSlug,
      leagueExternalId,
      homeTeamExternalId,
      awayTeamExternalId,
      startTime: new Date(startTimeStr),
      status: mapPandascoreMatchStatus(raw.status),
      homeScore: extractPandascoreScore(raw.results, homeOpponent.id),
      awayScore: extractPandascoreScore(raw.results, awayOpponent.id),
      result: mapPandascoreMatchResult(raw.draw, raw.winner, homeOpponent.id, awayOpponent.id),
    };

    const homeTeamLeague: CanonicalTeamLeague = {
      teamExternalId: homeTeamExternalId,
      leagueExternalId,
      sportSlug,
    };

    const awayTeamLeague: CanonicalTeamLeague = {
      teamExternalId: awayTeamExternalId,
      leagueExternalId,
      sportSlug,
    };

    return {
      sport,
      league,
      homeTeam,
      awayTeam,
      match,
      teamLeagues: [homeTeamLeague, awayTeamLeague],
    };
  }
}
