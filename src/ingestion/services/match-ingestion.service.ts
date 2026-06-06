import type { OddsApiClient } from '@/integrations/the-odds-api';
import type { PandascoreClient } from '@/integrations/pandascore';
import { OddsApiEventMapper } from '@/ingestion/mappers';
import type { PandascoreMatchMapper } from '@/ingestion/contracts';
import type {
  CanonicalSport,
  EsportsVideogame,
  EntityWriteAction,
  EntityWriteOutcome,
  MatchUpsertInput,
  PandascoreIngestionPlan,
} from '@/ingestion/contracts';
import type { SportRepository } from '@/ingestion/repositories/contracts';
import type { LeagueRepository } from '@/ingestion/repositories/contracts';
import type { TeamRepository } from '@/ingestion/repositories/contracts';
import type { MatchRepository } from '@/ingestion/repositories/contracts';
import type { TeamLeagueRepository } from '@/ingestion/repositories/contracts';
import type { Logger } from '@/lib/logger';
import type { TraditionalMatchIngestionResult, EsportsMatchIngestionResult } from './types';

const NEAR_TERM_WINDOW_MS = 48 * 60 * 60 * 1000;

const EMPTY_OUTCOME: EntityWriteOutcome = { created: 0, updated: 0, skipped: 0 };

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
 * Orchestrates match-level entity ingestion from both The Odds API and PandaScore.
 *
 * Two independent ingestion paths share this service:
 * - ingestTraditionalSport: processes one Odds API sport key (one getOdds call)
 * - ingestEsportsGame: processes one PandaScore videogame (upcoming + running calls)
 *
 * Both paths follow the same dependency write order:
 *   Sport → League → Team → Match → TeamLeague
 *
 * All writes are idempotent. The caller (BullMQ worker) may safely retry the entire
 * operation without risk of duplicates or constraint violations.
 *
 * This service does not write OddsSnapshot records — that is the responsibility of
 * OddsSnapshotIngestionService. The traditional sport path returns nearTermMatchExternalIds
 * for the worker to enqueue the odds job.
 */
export class MatchIngestionService {
  private readonly _oddsApiClient: OddsApiClient;
  private readonly _pandascoreClient: PandascoreClient;
  private readonly _pandascoreMapper: PandascoreMatchMapper;
  private readonly _sportRepository: SportRepository;
  private readonly _leagueRepository: LeagueRepository;
  private readonly _teamRepository: TeamRepository;
  private readonly _matchRepository: MatchRepository;
  private readonly _teamLeagueRepository: TeamLeagueRepository;
  private readonly _logger: Logger;

  constructor(
    oddsApiClient: OddsApiClient,
    pandascoreClient: PandascoreClient,
    pandascoreMapper: PandascoreMatchMapper,
    sportRepository: SportRepository,
    leagueRepository: LeagueRepository,
    teamRepository: TeamRepository,
    matchRepository: MatchRepository,
    teamLeagueRepository: TeamLeagueRepository,
    logger: Logger,
  ) {
    this._oddsApiClient = oddsApiClient;
    this._pandascoreClient = pandascoreClient;
    this._pandascoreMapper = pandascoreMapper;
    this._sportRepository = sportRepository;
    this._leagueRepository = leagueRepository;
    this._teamRepository = teamRepository;
    this._matchRepository = matchRepository;
    this._teamLeagueRepository = teamLeagueRepository;
    this._logger = logger.child({ service: 'MatchIngestionService' });
  }

  /**
   * Ingests all match-level entities for one Odds API sport key.
   *
   * Requires a CanonicalSport for the mapper — the /odds endpoint does not include
   * the sport group field that determines Sport.slug. The caller must provide the
   * CanonicalSport built from the reference data sync run (or the same derivation).
   *
   * Returns nearTermMatchExternalIds — "oa:"-prefixed IDs for matches whose startTime
   * falls within the next 48 hours. The worker passes these to the odds job.
   *
   * Write order: Sport → League → Team → Match → TeamLeague.
   * The Sport upsert is included here so the service is self-contained — the reference
   * data sync may not have run for this sport key yet in a given deployment sequence.
   */
  async ingestTraditionalSport(
    sportKey: string,
    sport: CanonicalSport,
  ): Promise<TraditionalMatchIngestionResult> {
    const startedAt = Date.now();

    this._logger.info({ sportKey, sportSlug: sport.slug }, 'Starting traditional sport match ingestion');

    const rawEvents = await this._oddsApiClient.getOdds(sportKey);
    const capturedAt = new Date();

    this._logger.debug({ sportKey, eventCount: rawEvents.length }, 'Fetched events from The Odds API');

    if (rawEvents.length === 0) {
      this._logger.info({ sportKey }, 'No events returned — nothing to ingest');
      return {
        sports: EMPTY_OUTCOME,
        leagues: EMPTY_OUTCOME,
        teams: EMPTY_OUTCOME,
        matches: EMPTY_OUTCOME,
        nearTermMatchExternalIds: [],
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    // OddsApiEventMapper is constructed per-sport: the sport's slug is used for every
    // entity in the plan and cannot be derived from the /odds response alone.
    const mapper = new OddsApiEventMapper(sport);
    const plans = rawEvents.map(e => mapper.toIngestionPlan(e, capturedAt));

    // Extract entity batches from all plans
    const canonicalSports = plans.map(p => p.sport);
    const canonicalLeagues = plans.map(p => p.league);
    const canonicalTeams = plans.flatMap(p => [p.homeTeam, p.awayTeam]);
    const canonicalTeamLeagues = plans.flatMap(p => [...p.teamLeagues]);
    const matchInputs: MatchUpsertInput[] = plans.map(p => ({
      create: p.match,
      update: {
        status: p.match.status,
        homeScore: p.match.homeScore,
        awayScore: p.match.awayScore,
        result: p.match.result,
        lastFetchedAt: capturedAt,
      },
    }));

    // Write in dependency order — each step requires the previous to exist in DB
    const sportsResult = await this._sportRepository.upsertMany(canonicalSports);
    const leaguesResult = await this._leagueRepository.upsertMany(canonicalLeagues);
    const teamsResult = await this._teamRepository.upsertMany(canonicalTeams);
    const matchesResult = await this._matchRepository.upsertMany(matchInputs);
    await this._teamLeagueRepository.upsertMany(canonicalTeamLeagues);

    // Matches with startTime within the next 48 hours are near-term and need odds
    const cutoff = new Date(capturedAt.getTime() + NEAR_TERM_WINDOW_MS);
    const nearTermMatchExternalIds = plans
      .filter(p => p.match.startTime <= cutoff)
      .map(p => p.match.externalId);

    const sports = aggregateOutcome(sportsResult.results);
    const leagues = aggregateOutcome(leaguesResult.results);
    const teams = aggregateOutcome(teamsResult.results);
    const matches = aggregateOutcome(matchesResult.results);
    const durationMs = Date.now() - startedAt;

    this._logger.info(
      { sportKey, sports, leagues, teams, matches, nearTermCount: nearTermMatchExternalIds.length, durationMs },
      'Traditional sport match ingestion complete',
    );

    return {
      sports,
      leagues,
      teams,
      matches,
      nearTermMatchExternalIds,
      errors: [],
      durationMs,
    };
  }

  /**
   * Ingests all match-level entities for one PandaScore videogame.
   *
   * Fetches upcoming and running matches concurrently, deduplicates by match ID
   * (a match transitioning to "running" may appear in both responses), then maps
   * each match to a complete ingestion plan.
   *
   * Matches with null opponents, fewer than two opponents, non-Team opponent types,
   * or missing start times are skipped and counted in skippedMatches. These are
   * expected for bracket-stage matches with TBD participants.
   *
   * No OddsSnapshot records are produced — PandaScore has no bookmaker odds endpoint.
   *
   * Write order: Sport → League → Team → Match → TeamLeague.
   */
  async ingestEsportsGame(videogame: EsportsVideogame): Promise<EsportsMatchIngestionResult> {
    const startedAt = Date.now();

    this._logger.info({ videogame }, 'Starting esports match ingestion');

    const [upcoming, running] = await Promise.all([
      this._pandascoreClient.getUpcomingMatches(videogame),
      this._pandascoreClient.getRunningMatches(videogame),
    ]);

    // Deduplicate by match ID — a match may appear in both lists if it started
    // between the two API calls
    const seenIds = new Set<number>();
    const allRawMatches = [...upcoming, ...running].filter(m => {
      if (seenIds.has(m.id)) return false;
      seenIds.add(m.id);
      return true;
    });

    this._logger.debug(
      { videogame, upcoming: upcoming.length, running: running.length, combined: allRawMatches.length },
      'Fetched matches from PandaScore',
    );

    if (allRawMatches.length === 0) {
      this._logger.info({ videogame }, 'No matches returned — nothing to ingest');
      return {
        sports: EMPTY_OUTCOME,
        leagues: EMPTY_OUTCOME,
        teams: EMPTY_OUTCOME,
        matches: EMPTY_OUTCOME,
        skippedMatches: 0,
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    // Map matches — null means the match is not yet mappable (TBD opponents, missing start time)
    const plans: PandascoreIngestionPlan[] = [];
    let skippedMatches = 0;

    for (const raw of allRawMatches) {
      const plan = this._pandascoreMapper.toIngestionPlan(raw);
      if (!plan) {
        this._logger.debug(
          { matchId: raw.id, slug: raw.slug, status: raw.status },
          'Skipping match: TBD opponents or missing start time',
        );
        skippedMatches++;
        continue;
      }
      plans.push(plan);
    }

    if (plans.length === 0) {
      this._logger.info({ videogame, skippedMatches }, 'All matches skipped — nothing to write');
      return {
        sports: EMPTY_OUTCOME,
        leagues: EMPTY_OUTCOME,
        teams: EMPTY_OUTCOME,
        matches: EMPTY_OUTCOME,
        skippedMatches,
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    const capturedAt = new Date();

    // Extract entity batches from all valid plans
    const canonicalSports = plans.map(p => p.sport);
    const canonicalLeagues = plans.map(p => p.league);
    const canonicalTeams = plans.flatMap(p => [p.homeTeam, p.awayTeam]);
    const canonicalTeamLeagues = plans.flatMap(p => [...p.teamLeagues]);
    const matchInputs: MatchUpsertInput[] = plans.map(p => ({
      create: p.match,
      update: {
        status: p.match.status,
        homeScore: p.match.homeScore,
        awayScore: p.match.awayScore,
        result: p.match.result,
        lastFetchedAt: capturedAt,
      },
    }));

    // Write in dependency order — each step requires the previous to exist in DB
    const sportsResult = await this._sportRepository.upsertMany(canonicalSports);
    const leaguesResult = await this._leagueRepository.upsertMany(canonicalLeagues);
    const teamsResult = await this._teamRepository.upsertMany(canonicalTeams);
    const matchesResult = await this._matchRepository.upsertMany(matchInputs);
    await this._teamLeagueRepository.upsertMany(canonicalTeamLeagues);

    const sports = aggregateOutcome(sportsResult.results);
    const leagues = aggregateOutcome(leaguesResult.results);
    const teams = aggregateOutcome(teamsResult.results);
    const matches = aggregateOutcome(matchesResult.results);
    const durationMs = Date.now() - startedAt;

    this._logger.info(
      { videogame, sports, leagues, teams, matches, skippedMatches, durationMs },
      'Esports match ingestion complete',
    );

    return {
      sports,
      leagues,
      teams,
      matches,
      skippedMatches,
      errors: [],
      durationMs,
    };
  }
}
