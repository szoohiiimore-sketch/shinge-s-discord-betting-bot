import type { OddsApiEventMapper as IOddsApiEventMapper } from '@/ingestion/contracts';
import type {
  RawOddsApiMatchOdds,
  CanonicalSport,
  CanonicalLeague,
  CanonicalTeam,
  CanonicalTeamLeague,
  CanonicalMatch,
  CanonicalOddsSnapshot,
  OddsApiIngestionPlan,
} from '@/ingestion/contracts';
import type { Bookmaker } from '@/integrations/the-odds-api/types';
import { slugify, oddsApiMatchExternalId, inferOddsApiMatchStatus, mapOddsMarket } from './mapper.utils';

/**
 * Maps a raw The Odds API event (with bookmaker odds) to a complete ingestion plan.
 *
 * Requires the CanonicalSport for the sport being ingested, injected via constructor.
 * This is necessary because MatchOdds only carries sport_key and sport_title — the
 * sport.group value (which determines the Sport.slug) is only available from the
 * /v4/sports endpoint, not from /v4/sports/{key}/odds.
 *
 * One mapper instance per sport key; create a new instance for each sport being synced.
 */
export class OddsApiEventMapper implements IOddsApiEventMapper {
  private readonly _sport: CanonicalSport;

  constructor(sport: CanonicalSport) {
    this._sport = sport;
  }

  toIngestionPlan(raw: RawOddsApiMatchOdds, capturedAt: Date): OddsApiIngestionPlan {
    const sportSlug = this._sport.slug;
    const leagueExternalId = raw.sport_key;
    const homeTeamExternalId = slugify(raw.home_team);
    const awayTeamExternalId = slugify(raw.away_team);
    const matchExternalId = oddsApiMatchExternalId(raw.id);

    const commenceTime = new Date(raw.commence_time);
    const status = inferOddsApiMatchStatus(commenceTime, capturedAt);
    const isLive = status === 'LIVE';

    const league: CanonicalLeague = {
      externalId: leagueExternalId,
      name: raw.sport_title,
      slug: raw.sport_key,
      sportSlug,
    };

    const homeTeam: CanonicalTeam = {
      externalId: homeTeamExternalId,
      name: raw.home_team,
      slug: homeTeamExternalId,
      sportSlug,
    };

    const awayTeam: CanonicalTeam = {
      externalId: awayTeamExternalId,
      name: raw.away_team,
      slug: awayTeamExternalId,
      sportSlug,
    };

    const match: CanonicalMatch = {
      externalId: matchExternalId,
      sportSlug,
      leagueExternalId,
      homeTeamExternalId,
      awayTeamExternalId,
      startTime: commenceTime,
      status,
      homeScore: null,
      awayScore: null,
      result: null,
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
      sport: this._sport,
      league,
      homeTeam,
      awayTeam,
      match,
      teamLeagues: [homeTeamLeague, awayTeamLeague],
      oddsSnapshots: this._mapOddsSnapshots(raw.bookmakers, matchExternalId, isLive, capturedAt),
    };
  }

  private _mapOddsSnapshots(
    bookmakers: readonly Bookmaker[],
    matchExternalId: string,
    isLive: boolean,
    capturedAt: Date,
  ): readonly CanonicalOddsSnapshot[] {
    const snapshots: CanonicalOddsSnapshot[] = [];

    for (const bookmaker of bookmakers) {
      for (const market of bookmaker.markets) {
        const mappedMarket = mapOddsMarket(market.key);

        for (const outcome of market.outcomes) {
          snapshots.push({
            matchExternalId,
            bookmaker: bookmaker.key,
            market: mappedMarket,
            outcome: outcome.name,
            price: outcome.price,
            isMain: market.is_main ?? false,
            isLive,
            capturedAt,
          });
        }
      }
    }

    return snapshots;
  }
}
