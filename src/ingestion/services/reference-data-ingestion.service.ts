import type { OddsApiClient } from '@/integrations/the-odds-api';
import type { OddsApiSportMapper } from '@/ingestion/contracts';
import type { SportRepository } from '@/ingestion/repositories/contracts';
import type { LeagueRepository } from '@/ingestion/repositories/contracts';
import type { EntityWriteAction, EntityWriteOutcome } from '@/ingestion/contracts';
import type { Logger } from '@/lib/logger';
import type { ReferenceIngestionResult } from './types';

function aggregateOutcome(
  results: ReadonlyArray<{ action: EntityWriteAction }>,
): EntityWriteOutcome {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.action === 'created') created++;
    else if (r.action === 'updated') updated++;
    else skipped++;
  }
  return { created, updated, skipped };
}

/**
 * Orchestrates reference data ingestion from The Odds API.
 *
 * Fetches the sports list, maps each entry to a CanonicalSport + CanonicalLeague,
 * and upserts both entity types into the database. Repository-level deduplication
 * handles the Odds API's pattern of returning multiple entries per sport group
 * (e.g., "soccer_epl" and "soccer_bundesliga" both produce Sport{slug:"soccer"}).
 *
 * This service is the data prerequisite for MatchIngestionService.ingestTraditionalSport().
 * Sport and League records must exist before match data can be written.
 */
export class ReferenceDataIngestionService {
  private readonly _oddsApiClient: OddsApiClient;
  private readonly _sportMapper: OddsApiSportMapper;
  private readonly _sportRepository: SportRepository;
  private readonly _leagueRepository: LeagueRepository;
  private readonly _logger: Logger;

  constructor(
    oddsApiClient: OddsApiClient,
    sportMapper: OddsApiSportMapper,
    sportRepository: SportRepository,
    leagueRepository: LeagueRepository,
    logger: Logger,
  ) {
    this._oddsApiClient = oddsApiClient;
    this._sportMapper = sportMapper;
    this._sportRepository = sportRepository;
    this._leagueRepository = leagueRepository;
    this._logger = logger.child({ service: 'ReferenceDataIngestionService' });
  }

  /**
   * Fetches all active sports from The Odds API and upserts Sports and Leagues.
   *
   * Inactive sports (active: false) are skipped entirely — the API returns them
   * but they represent deprecated or unavailable competitions.
   *
   * Write order: Sports first, then Leagues (Leagues require Sport FK to exist).
   */
  async sync(): Promise<ReferenceIngestionResult> {
    const startedAt = Date.now();

    this._logger.info('Starting reference data sync');

    const rawSports = await this._oddsApiClient.getSports();
    const activeSports = rawSports.filter(s => s.active);

    this._logger.debug(
      { total: rawSports.length, active: activeSports.length },
      'Fetched sports from The Odds API',
    );

    if (activeSports.length === 0) {
      this._logger.warn('No active sports returned from The Odds API — skipping upserts');
      return {
        sports: { created: 0, updated: 0, skipped: 0 },
        leagues: { created: 0, updated: 0, skipped: 0 },
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    const canonicalSports = activeSports.map(s => this._sportMapper.toCanonicalSport(s));
    const canonicalLeagues = activeSports.map(s => this._sportMapper.toCanonicalLeague(s));

    // Sports must be written before Leagues — Leagues carry a sportId FK.
    const sportsResult = await this._sportRepository.upsertMany(canonicalSports);
    const leaguesResult = await this._leagueRepository.upsertMany(canonicalLeagues);

    const sports = aggregateOutcome(sportsResult.results);
    const leagues = aggregateOutcome(leaguesResult.results);
    const durationMs = Date.now() - startedAt;

    this._logger.info({ sports, leagues, durationMs }, 'Reference data sync complete');

    return {
      sports,
      leagues,
      errors: [],
      durationMs,
    };
  }
}
