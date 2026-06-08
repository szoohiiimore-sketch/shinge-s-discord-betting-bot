import http from 'node:http';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Config } from '@/config/config.types';
import type { Logger } from '@/lib/logger';
import { createPrismaClient } from '@/lib/prisma/prisma-factory';
import {
  connectDatabase as connectDatabaseImpl,
  disconnectDatabase,
} from '@/lib/prisma/prisma-lifecycle';
import { createRedisClient } from '@/lib/redis/redis-factory';
import {
  connectRedis as connectRedisImpl,
  verifyRedisConnection,
  disconnectRedis,
} from '@/lib/redis/redis-lifecycle';
import { createQueues, closeQueues } from '@/lib/queue/queue-factory';
import { createWorkers, pauseWorkers, closeWorkers } from '@/lib/queue/worker-factory';
import { startWorkers } from '@/lib/queue/queue-lifecycle';
import {
  startHealthServer as startHealthServerImpl,
  stopHealthServer,
} from '@/lib/health/health-lifecycle';
import type { QueueCollection, WorkerCollection } from '@/lib/queue/queue-types';
import type { Processor } from 'bullmq';
import { QueueName } from '@/lib/queue/queue-types';
import { ApplicationState, assertValidTransition } from './app-state';
import {
  createIngestionDependencies,
  bootstrapIngestion,
  scheduleIngestionJobs,
  SIXTY_MINUTES_MS,
  THREE_HOURS_MS,
  FOUR_HOURS_MS,
  type TraditionalSportScheduleConfig,
} from '@/ingestion/bootstrap';

/**
 * Dependency container holding references to all initialized infrastructure.
 *
 * Lifecycle of each field:
 *   undefined → not yet initialized
 *   T         → initialized and running
 *   null      → was initialized, now shut down
 */
export interface Dependencies {
  prisma: PrismaClient | undefined | null;
  redis: Redis | undefined | null;
  queues: QueueCollection | undefined | null;
  workers: WorkerCollection | undefined | null;
  healthServer: http.Server | undefined | null;
}

/**
 * Worker processors registered by the ingestion bootstrap.
 * These replace the placeholder processors in real BullMQ Workers.
 */
export interface WorkerProcessors {
  readonly matchFetch: Processor;
  readonly oddsFetch: Processor;
}

const TRADITIONAL_SPORT_CONFIGS: readonly TraditionalSportScheduleConfig[] = [
  // ── Tier 1: 60-minute polling ───────────────────────────────────────────────────
  // League sports with frequent event windows
  { sportKey: 'icehockey_nhl',           sportGroup: 'Ice Hockey', intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'baseball_mlb',            sportGroup: 'Baseball',   intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'basketball_wnba',         sportGroup: 'Basketball', intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'soccer_usa_mls',          sportGroup: 'Soccer',     intervalMs: SIXTY_MINUTES_MS },

  // ── Tier 1: Tennis tournaments (60-minute polling) ──────────────────────────────
  { sportKey: 'tennis_atp_wimbledon',     sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'tennis_atp_us_open',       sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'tennis_atp_indian_wells',  sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'tennis_atp_miami_open',    sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'tennis_wta_wimbledon',     sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'tennis_wta_us_open',       sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'tennis_wta_indian_wells',  sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },
  { sportKey: 'tennis_wta_miami_open',    sportGroup: 'Tennis', intervalMs: SIXTY_MINUTES_MS },

  // ── Tier 2: 4-hour polling ─────────────────────────────────────────────────────
  // Slow-moving sports with long event windows
  { sportKey: 'basketball_nba',            sportGroup: 'Basketball', intervalMs: FOUR_HOURS_MS },
  { sportKey: 'soccer_epl',                sportGroup: 'Soccer',     intervalMs: FOUR_HOURS_MS },
  { sportKey: 'soccer_uefa_champs_league',  sportGroup: 'Soccer',    intervalMs: FOUR_HOURS_MS },
  { sportKey: 'americanfootball_ncaaf',    sportGroup: 'Football',   intervalMs: FOUR_HOURS_MS },

  // ── Tier 3: 3-hour polling (mass league expansion from ahhhh.txt) ──────────────
  { sportKey: 'soccer_brazil_serie_b',         sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_argentina_primera_division', sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_australia_aleague',      sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_austria_bundesliga',     sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_brazil_campeonato',      sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_belgium_first_div',      sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_chile_campeonato',       sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_china_superleague',      sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_denmark_superliga',      sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_england_league2',        sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_finland_veikkausliiga',  sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_france_ligue_two',       sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_germany_bundesliga2',    sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_germany_bundesliga_women', sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_germany_dfb_pokal',      sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_germany_liga3',          sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_greece_super_league',    sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_italy_serie_b',          sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_japan_j_league',         sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_korea_kleague1',         sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_league_of_ireland',      sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_mexico_ligamx',          sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_netherlands_eredivisie', sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_norway_eliteserien',     sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_poland_ekstraklasa',     sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_portugal_primeira_liga', sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_russia_premier_league',  sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_spain_segunda_division', sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_saudi_arabia_pro_league', sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_spl',                    sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_sweden_allsvenskan',     sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_sweden_superettan',      sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_switzerland_superleague', sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
  { sportKey: 'soccer_turkey_super_league',    sportGroup: 'Soccer', intervalMs: THREE_HOURS_MS },
];

function createDependencies(): Dependencies {
  return {
    prisma: undefined,
    redis: undefined,
    queues: undefined,
    workers: undefined,
    healthServer: undefined,
  };
}

/**
 * Application lifecycle manager.
 *
 * Orchestrates startup and shutdown of all infrastructure dependencies.
 * Uses a state machine to enforce valid lifecycle transitions.
 *
 * Startup sequence:
 *   Prisma → Database connect → Redis → Redis verify → Queues → Workers → Health server
 *
 * Shutdown sequence (reverse):
 *   Health server → Workers → Queues → Redis → Prisma
 */
export class Application {
  private _state: ApplicationState = ApplicationState.NOT_STARTED;
  private readonly _deps: Dependencies = createDependencies();
  private readonly _config: Config;
  private readonly _logger: Logger;
  private readonly _startTime: number = performance.now();
  private _workerProcessors: WorkerProcessors | null = null;

  constructor(config: Config, logger: Logger) {
    this._config = config;
    this._logger = logger;
  }

  /** Registers real worker processors (called after ingestion bootstrap). */
  setWorkerProcessors(processors: WorkerProcessors): void {
    this._workerProcessors = processors;
  }

  // ─── Public Accessors ───────────────────────────────────────────

  get state(): ApplicationState {
    return this._state;
  }

  get config(): Config {
    return this._config;
  }

  get logger(): Logger {
    return this._logger;
  }

  get deps(): Readonly<Dependencies> {
    return this._deps;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Starts the application.
   *
   * Transitions: NOT_STARTED → STARTING → RUNNING
   * On failure:  STARTING → FAILED, then cleans up initialized dependencies.
   *
   * @throws If startup fails at any step
   */
  async start(): Promise<void> {
    this.transitionTo(ApplicationState.STARTING);
    this._logger.info('Application starting');

    try {
      this._logger.info('Initializing Prisma');
      this._deps.prisma = this.initPrisma();

      this._logger.info('Connecting to database');
      await this.connectDatabase();

      this._logger.info('Initializing Redis');
      this._deps.redis = this.initRedis();

      this._logger.info('Connecting to Redis');
      await this.connectRedis();

      this._logger.info('Creating BullMQ queues');
      this._deps.queues = this.initQueues();

      // Bootstrap ingestion dependencies now that Prisma, Redis, and queues exist
      this._logger.info('Bootstrapping ingestion system');
      const ingestionDeps = createIngestionDependencies(
        this._config,
        this._deps.prisma!,
        this._deps.redis!,
        this._logger,
      );
      const { matchFetchProcessor, oddsFetchProcessor } = bootstrapIngestion(ingestionDeps, this._logger);
      this.setWorkerProcessors({ matchFetch: matchFetchProcessor, oddsFetch: oddsFetchProcessor });

      this._logger.info('Creating BullMQ workers');
      this._deps.workers = this.initWorkers();

      this._logger.info('Starting BullMQ workers');
      await this.startAllWorkers();

      this._logger.info('Registering repeatable ingestion jobs');
      await scheduleIngestionJobs(
        this._deps.queues![QueueName.MATCH_FETCH],
        TRADITIONAL_SPORT_CONFIGS,
        this._logger,
      );

      this._logger.info('Logging in to Discord');
      try {
        await ingestionDeps.discordBot.login();
        this._logger.info('Discord bot logged in successfully');
      } catch (discordErr) {
        this._logger.warn({ err: (discordErr as Error).message }, 'Discord bot login failed — continuing without slash commands');
      }

      this._logger.info('Starting health check server');
      this._deps.healthServer = await this.initHealthServer();

      this.transitionTo(ApplicationState.RUNNING);
      this._logger.info('Application started successfully');
    } catch (err) {
      this.transitionTo(ApplicationState.FAILED);
      // Serialize error to plain object before pino sees it to avoid
      // pino-std-serializers Symbol collision with non-extensible error objects
      // from Prisma or other libraries that freeze their errors.
      const serializedErr = err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack, code: (err as any).code }
        : String(err);
      this._logger.error({ err: serializedErr }, 'Application startup failed');
      await this.teardown();
      throw err;
    }
  }

  /**
   * Stops the application gracefully.
   *
   * Transitions: RUNNING → STOPPING → STOPPED
   * Shuts down dependencies in reverse initialization order.
   */
  async stop(): Promise<void> {
    if (this._state !== ApplicationState.RUNNING) {
      this._logger.warn({ state: this._state }, 'Application is not running, skipping shutdown');
      return;
    }

    this.transitionTo(ApplicationState.STOPPING);
    this._logger.info('Application stopping');

    try {
      await this.teardown();
      this.transitionTo(ApplicationState.STOPPED);
      this._logger.info('Application stopped successfully');
    } catch (err) {
      this.transitionTo(ApplicationState.FAILED);
      const serializedErr = err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack }
        : String(err);
      this._logger.error({ err: serializedErr }, 'Application shutdown failed');
      throw err;
    }
  }

  // ─── Private State Management ───────────────────────────────────

  private transitionTo(next: ApplicationState): void {
    assertValidTransition(this._state, next);
    this._state = next;
  }

  // ─── Dependency Initialization ───────────────────────────────────

  private initPrisma(): PrismaClient {
    return createPrismaClient(
      this._config.database,
      this._logger.child({ module: 'prisma' }),
    );
  }

  private async connectDatabase(): Promise<void> {
    await connectDatabaseImpl(
      this._deps.prisma!,
      this._logger.child({ module: 'prisma' }),
    );
  }

  private initRedis(): Redis {
    return createRedisClient(
      this._config.redis,
      this._logger.child({ module: 'redis' }),
    );
  }

  private async connectRedis(): Promise<void> {
    const redisLogger = this._logger.child({ module: 'redis' });
    await connectRedisImpl(this._deps.redis!, redisLogger);
    await verifyRedisConnection(this._deps.redis!, redisLogger);
  }

  private initQueues(): QueueCollection {
    return createQueues(
      this._deps.redis!,
      this._logger.child({ module: 'bullmq' }),
    );
  }

  private initWorkers(): WorkerCollection {
    const processorMap: Partial<Record<QueueName, (job: any) => Promise<unknown>>> = {};
    if (this._workerProcessors) {
      processorMap[QueueName.MATCH_FETCH] = this._workerProcessors.matchFetch;
      processorMap[QueueName.ODDS_FETCH] = this._workerProcessors.oddsFetch;
    }
    return createWorkers(
      this._deps.redis!,
      this._logger.child({ module: 'bullmq' }),
      processorMap,
    );
  }

  private async startAllWorkers(): Promise<void> {
    await startWorkers(
      this._deps.workers!,
      this._logger.child({ module: 'bullmq' }),
    );
  }

  private async initHealthServer(): Promise<http.Server> {
    return startHealthServerImpl(
      { port: this._config.app.port, host: '0.0.0.0' },
      this._deps.prisma!,
      this._deps.redis!,
      this._deps.queues!,
      () => this._state,
      this._startTime,
      this._logger.child({ module: 'health' }),
    );
  }

  // ─── Teardown ────────────────────────────────────────────────────

  /**
   * Shuts down all initialized dependencies in reverse initialization order.
   *
   * Called on both startup failure (cleanup) and normal shutdown.
   * Collects all errors rather than stopping at the first failure,
   * to ensure every initialized dependency is given a chance to shut down.
   *
   * Skips dependencies that were never initialized (undefined) or were
   * already shut down (null).
   */
  private async teardown(): Promise<void> {
    this._logger.info('Tearing down dependencies');
    const errors: Error[] = [];

    // Reverse order: health server → workers → queues → redis → prisma

    if (this._deps.healthServer != null) {
      try {
        await stopHealthServer(
          this._deps.healthServer,
          this._logger.child({ module: 'health' }),
        );
      } catch (err) {
        errors.push(err as Error);
      }
      this._deps.healthServer = null;
    }

    if (this._deps.workers != null) {
      try {
        await pauseWorkers(this._deps.workers, this._logger.child({ module: 'bullmq' }));
        await closeWorkers(this._deps.workers, this._logger.child({ module: 'bullmq' }));
      } catch (err) {
        errors.push(err as Error);
      }
      this._deps.workers = null;
    }

    if (this._deps.queues != null) {
      try {
        await closeQueues(this._deps.queues, this._logger.child({ module: 'bullmq' }));
      } catch (err) {
        errors.push(err as Error);
      }
      this._deps.queues = null;
    }

    if (this._deps.redis != null) {
      try {
        await disconnectRedis(this._deps.redis, this._logger.child({ module: 'redis' }));
      } catch (err) {
        errors.push(err as Error);
      }
      this._deps.redis = null;
    }

    if (this._deps.prisma != null) {
      try {
        await disconnectDatabase(this._deps.prisma, this._logger.child({ module: 'prisma' }));
      } catch (err) {
        errors.push(err as Error);
      }
      this._deps.prisma = null;
    }

    if (errors.length > 0) {
      this._logger.error(
        { errors: errors.map((e) => e.message) },
        'Teardown encountered errors',
      );
    }
  }
}
