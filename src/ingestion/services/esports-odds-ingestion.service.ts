import type { Logger } from '@/lib/logger';
import type { OddspapiClient } from '@/integrations/oddspapi';
import type { MatchRepository } from '@/ingestion/repositories/contracts';
import type { OddsSnapshotRepository } from '@/ingestion/repositories/contracts';
import type { EsportsVideogame, CanonicalOddsSnapshot } from '@/ingestion/contracts';
import type { EsportsOddsIngestionResult } from './types';
import { PANDASCORE_TO_ODDSPAPI_KEY } from '@/integrations/oddspapi';
import { normalizeTeamName, resolveAlias } from '@/integrations/oddspapi';
import type { OddspapiMatchOdds } from '@/integrations/oddspapi';

const CORRELATION_TIME_TOLERANCE_MS = 30 * 60 * 1000;
const MIN_SUBSTRING_LEN = 4;

interface DbMatchWithTeams {
  id: string;
  externalId: string;
  startTime: Date;
  homeTeam: { id: string; name: string };
  awayTeam: { id: string; name: string };
}

function correlateMatch(
  oddsMatch: OddspapiMatchOdds,
  dbMatches: DbMatchWithTeams[],
): DbMatchWithTeams | null {
  const oddsHome = resolveAlias(normalizeTeamName(oddsMatch.home_team));
  const oddsAway = resolveAlias(normalizeTeamName(oddsMatch.away_team));
  const oddsTime = new Date(oddsMatch.commence_time).getTime();

  for (const dbMatch of dbMatches) {
    const dbHome = resolveAlias(normalizeTeamName(dbMatch.homeTeam.name));
    const dbAway = resolveAlias(normalizeTeamName(dbMatch.awayTeam.name));
    const timeDiff = Math.abs(oddsTime - dbMatch.startTime.getTime());

    if (timeDiff > CORRELATION_TIME_TOLERANCE_MS) continue;

    if (dbHome === oddsHome && dbAway === oddsAway) {
      return dbMatch;
    }

    const homeLen = Math.min(dbHome.length, oddsHome.length);
    const awayLen = Math.min(dbAway.length, oddsAway.length);
    if (homeLen >= MIN_SUBSTRING_LEN && awayLen >= MIN_SUBSTRING_LEN) {
      const homeMatch = dbHome.includes(oddsHome) || oddsHome.includes(dbHome);
      const awayMatch = dbAway.includes(oddsAway) || oddsAway.includes(dbAway);
      if (homeMatch && awayMatch) return dbMatch;
    }
  }

  return null;
}

/**
 * Orchestrates OddsSnapshot ingestion from OddsPapi for esports matches.
 *
 * Called by the sync-esports-odds worker after the match-level job has written
 * Match records. Loads DB matches by ps: IDs, fetches odds from OddsPapi,
 * correlates by team name + time proximity, and inserts CanonicalOddsSnapshots.
 */
export class EsportsOddsSnapshotIngestionService {
  constructor(
    private readonly _oddspapiClient: OddspapiClient,
    private readonly _matchRepository: MatchRepository,
    private readonly _oddsSnapshotRepository: OddsSnapshotRepository,
    private readonly _logger: Logger,
  ) {
    this._logger = _logger.child({ service: 'EsportsOddsSnapshotIngestionService' });
  }

  async ingestOddsForGame(
    videogame: EsportsVideogame,
    matchExternalIds: readonly string[],
  ): Promise<EsportsOddsIngestionResult> {
    const startedAt = Date.now();
    const capturedAt = new Date();

    // Step 1: Filter to "ps:"-prefixed IDs only
    const psIds = matchExternalIds.filter(id => id.startsWith('ps:'));
    if (psIds.length === 0) {
      return {
        videogame,
        oddsMatchesReceived: 0,
        oddsMatchesCorrelated: 0,
        oddsMatchesSkipped: 0,
        oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
        quotaUsedThisCall: 0,
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    // Step 2: Load DB matches with team names
    const dbMatches = await this._matchRepository.findManyWithTeamsByExternalIds(psIds);
    if (dbMatches.length === 0) {
      this._logger.warn(
        { videogame, requestedIds: psIds.length },
        'No DB matches found for requested external IDs',
      );
      return {
        videogame,
        oddsMatchesReceived: 0,
        oddsMatchesCorrelated: 0,
        oddsMatchesSkipped: 0,
        oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
        quotaUsedThisCall: 0,
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    // Step 3: Fetch OddsPapi odds (quota-consuming)
    const oddspapiGameKey = PANDASCORE_TO_ODDSPAPI_KEY[videogame];
    const apiResult = await this._oddspapiClient.getOddsForGame(oddspapiGameKey);

    // Step 4: Correlate and build snapshots
    let oddsMatchesCorrelated = 0;
    let oddsMatchesSkipped = 0;
    const snapshots: CanonicalOddsSnapshot[] = [];

    for (const oddsMatch of apiResult) {
      const dbMatch = correlateMatch(oddsMatch, dbMatches);

      if (!dbMatch) {
        this._logger.debug(
          {
            oddsHome: oddsMatch.home_team,
            oddsAway: oddsMatch.away_team,
            oddsTime: oddsMatch.commence_time,
          },
          'No DB match correlated for OddsPapi match',
        );
        oddsMatchesSkipped++;
        continue;
      }

      oddsMatchesCorrelated++;

      const mainBookmakerKey =
        oddsMatch.bookmakers.find(b => b.key === 'pinnacle')?.key ??
        oddsMatch.bookmakers[0]?.key ??
        '';

      for (const bookmaker of oddsMatch.bookmakers) {
        for (const outcome of bookmaker.outcomes) {
          snapshots.push({
            matchExternalId: dbMatch.externalId,
            bookmaker: bookmaker.key,
            market: 'H2H',
            outcome: outcome.name,
            price: outcome.price,
            isMain: bookmaker.key === mainBookmakerKey,
            isLive: false,
            capturedAt,
          });
        }
      }
    }

    // Step 5: Persist
    let oddsSnapshotsResult = { created: 0, updated: 0, skipped: 0 };
    if (snapshots.length > 0) {
      const insertResult = await this._oddsSnapshotRepository.insertMany(snapshots);
      oddsSnapshotsResult = { created: insertResult.inserted, updated: 0, skipped: 0 };
    }

    const durationMs = Date.now() - startedAt;

    this._logger.info(
      {
        videogame,
        oddsMatchesReceived: apiResult.length,
        oddsMatchesCorrelated,
        oddsMatchesSkipped,
        oddsSnapshots: oddsSnapshotsResult,
        durationMs,
      },
      'Esports odds ingestion complete',
    );

    return {
      videogame,
      oddsMatchesReceived: apiResult.length,
      oddsMatchesCorrelated,
      oddsMatchesSkipped,
      oddsSnapshots: oddsSnapshotsResult,
      quotaUsedThisCall: 1,
      errors: [],
      durationMs,
    };
  }
}