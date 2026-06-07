import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { MatchIngestionService } from '@/ingestion/services';
import type { Logger } from '@/lib/logger';
import type {
  SyncTraditionalSportJobData,
  SyncEsportsGameJobData,
  SyncOddsForSportJobData,
  SyncEsportsOddsJobData,
  MatchFetchJobPayload,
  TraditionalSportSyncResult,
  EsportsGameSyncResult,
  CanonicalSport,
} from '@/ingestion/contracts';
import { slugify } from '@/ingestion/mappers';
import { ODDS_FETCH_JOB_NAMES } from '@/ingestion/queues';
import { ODDSPAPI_DEFAULTS } from '@/integrations/oddspapi';

/**
 * BullMQ worker processor for match-fetch queue jobs.
 *
 * Handles two job types on the match-fetch queue:
 * - "sync-traditional-sport": ingests one Odds API sport key
 * - "sync-esports-game": ingests one PandaScore videogame
 *
 * After a traditional sport sync, enqueues a sync-odds-for-sport job for
 * near-term matches with a 5-second delay to allow DB writes to commit.
 *
 * Constructor injection: all dependencies passed explicitly.
 * No global mutable state.
 */
const ESPORTS_ODDS_COOLDOWN_MS = ODDSPAPI_DEFAULTS.COOLDOWN_MS;
const ENV_PREFIX = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';

export class MatchIngestionWorker {
  private readonly _service: MatchIngestionService;
  private readonly _oddsFetchQueue: Queue;
  private readonly _redis: Redis;
  private readonly _logger: Logger;

  constructor(
    service: MatchIngestionService,
    oddsFetchQueue: Queue,
    redis: Redis,
    logger: Logger,
  ) {
    this._service = service;
    this._oddsFetchQueue = oddsFetchQueue;
    this._redis = redis;
    this._logger = logger.child({ worker: 'MatchIngestionWorker' });
  }

  /**
   * Processes a job from the match-fetch queue.
   *
   * Dispatches to the correct handler based on the job's name field.
   * Returns the sync result as the BullMQ job return value.
   */
  async process(job: Job<MatchFetchJobPayload>): Promise<TraditionalSportSyncResult | EsportsGameSyncResult> {
    const jobId = job.id ?? 'unknown';
    const startedAt = Date.now();

    this._logger.info({ jobId, jobName: job.name }, 'Processing match ingestion job');

    if (job.name === 'sync-traditional-sport') {
      return this._handleTraditionalSport(jobId, job.data as unknown as SyncTraditionalSportJobData, startedAt);
    }

    if (job.name === 'sync-esports-game') {
      return this._handleEsportsGame(jobId, job.data as unknown as SyncEsportsGameJobData, startedAt);
    }

    throw new Error(`Unknown match-fetch job name: ${job.name}`);
  }

  /**
   * Handles a sync-traditional-sport job.
   *
   * After ingestion, enqueues sync-odds-for-sport for near-term matches with
   * a 5-second delay so match DB writes commit before the odds worker runs.
   */
  private async _handleTraditionalSport(
    jobId: string,
    data: SyncTraditionalSportJobData,
    startedAt: number,
  ): Promise<TraditionalSportSyncResult> {
    const { sportKey, sportGroup } = data;

    const sport: CanonicalSport = {
      slug: slugify(sportGroup),
      name: sportGroup,
      category: 'TRADITIONAL',
      externalApiSource: 'THE_ODDS_API',
      externalSportKey: slugify(sportGroup),
    };

    this._logger.info({ jobId, sportKey, sportGroup }, 'Processing traditional sport sync job');

    const result = await this._service.ingestTraditionalSport(sportKey, sport);

    if (result.nearTermMatchExternalIds.length > 0) {
      const oddsPayload: SyncOddsForSportJobData = {
        sportKey,
        sportGroup,
        matchExternalIds: result.nearTermMatchExternalIds,
      };
      await this._oddsFetchQueue.add(
        ODDS_FETCH_JOB_NAMES.SYNC_ODDS_FOR_SPORT,
        oddsPayload,
        { delay: 5000 },
      );
      this._logger.info(
        { jobId, sportKey, nearTermCount: result.nearTermMatchExternalIds.length },
        'Enqueued sync-odds-for-sport job',
      );
    }

    return {
      sportKey,
      matchesProcessed: result.matches.created + result.matches.updated + result.matches.skipped,
      sports: result.sports,
      leagues: result.leagues,
      teams: result.teams,
      matches: result.matches,
      oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
      errors: result.errors,
      completedAt: new Date(),
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Handles a sync-esports-game job.
   */
  private async _handleEsportsGame(
    jobId: string,
    data: SyncEsportsGameJobData,
    startedAt: number,
  ): Promise<EsportsGameSyncResult> {
    const { videogame } = data;

    this._logger.info({ jobId, videogame }, 'Processing esports sync job');

    const result = await this._service.ingestEsportsGame(videogame);

    if (result.nearTermMatchExternalIds.length > 0) {
      const cooldownKey = `${ENV_PREFIX}:esports-odds-cooldown:${videogame}`;
      const lastEnqueuedRaw = await this._redis.get(cooldownKey);
      const lastEnqueuedAt = lastEnqueuedRaw ? parseInt(lastEnqueuedRaw, 10) : 0;
      const cooldownRemainingMs = ESPORTS_ODDS_COOLDOWN_MS - (Date.now() - lastEnqueuedAt);

      if (cooldownRemainingMs <= 0) {
        const oddsPayload: SyncEsportsOddsJobData = {
          videogame,
          matchExternalIds: result.nearTermMatchExternalIds,
        };

        await this._oddsFetchQueue.add(
          ODDS_FETCH_JOB_NAMES.SYNC_ESPORTS_ODDS,
          oddsPayload,
          {
            // BullMQ jobId must not contain ':' — it is reserved as a Redis key delimiter.
            jobId: `sync-esports-odds-${videogame}`,
            delay: 5000,
            attempts: 2,
            backoff: { type: 'fixed', delay: 30_000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 },
          },
        );

        await this._redis.set(
          cooldownKey,
          Date.now().toString(),
          'EX',
          Math.ceil(ESPORTS_ODDS_COOLDOWN_MS / 1000),
        );

        this._logger.info(
          { jobId, videogame, nearTermCount: result.nearTermMatchExternalIds.length },
          'Enqueued sync-esports-odds job',
        );
      } else {
        this._logger.debug(
          { jobId, videogame, cooldownRemainingMs },
          'Esports odds cooldown active — skipping enqueue',
        );
      }
    }

    return {
      videogame,
      matchesProcessed: result.matches.created + result.matches.updated + result.matches.skipped,
      sports: result.sports,
      leagues: result.leagues,
      teams: result.teams,
      matches: result.matches,
      errors: result.errors,
      completedAt: new Date(),
      durationMs: Date.now() - startedAt,
    };
  }
}
