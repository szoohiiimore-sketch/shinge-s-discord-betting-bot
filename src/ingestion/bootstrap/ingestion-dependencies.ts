import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import type { Config } from '@/config';
import { Queue } from 'bullmq';
import { QueueName, DEFAULT_JOB_OPTIONS } from '@/lib/queue';
import { createOddsApiClient } from '@/integrations/the-odds-api';
import { createPandascoreClient } from '@/integrations/pandascore';
import { createOddspapiClient } from '@/integrations/oddspapi';
import { OddsApiSportMapper, PandascoreMatchMapper } from '@/ingestion/mappers';
import { SportRepository } from '@/ingestion/repositories';
import { LeagueRepository } from '@/ingestion/repositories';
import { TeamRepository } from '@/ingestion/repositories';
import { TeamLeagueRepository } from '@/ingestion/repositories';
import { MatchRepository } from '@/ingestion/repositories';
import { OddsSnapshotRepository } from '@/ingestion/repositories';
import { ReferenceDataIngestionService } from '@/ingestion/services';
import { MatchIngestionService } from '@/ingestion/services';
import { OddsSnapshotIngestionService } from '@/ingestion/services';
import { EsportsOddsSnapshotIngestionService } from '@/ingestion/services';
import { ReferenceDataWorker } from '@/ingestion/workers';
import { MatchIngestionWorker } from '@/ingestion/workers';
import { OddsSnapshotWorker } from '@/ingestion/workers';
import { EsportsOddsSnapshotWorker } from '@/ingestion/workers';
import { ValueDetectionService, ValueOpportunityRepository } from '@/value-detection';
import { DiscordNotificationService, DiscordBotService, DailySummaryWorker } from '@/discord';
import { SettlementService, SettlementWorker } from '@/settlement';

/**
 * Container for all ingestion dependencies.
 *
 * Instantiated once during application startup.
 * Constructor injection only — no service locator, no global state.
 */
export interface IngestionDependencies {
  readonly referenceDataWorker: ReferenceDataWorker;
  readonly matchIngestionWorker: MatchIngestionWorker;
  readonly oddsSnapshotWorker: OddsSnapshotWorker;
  readonly esportsOddsSnapshotWorker: EsportsOddsSnapshotWorker;
  readonly settlementWorker: SettlementWorker;
  readonly dailySummaryWorker: DailySummaryWorker;
  readonly discordBot: DiscordBotService;
  readonly valueDetectionService: ValueDetectionService;
  readonly matchFetchQueue: Queue;
}

/**
 * Creates all ingestion dependencies by wiring together:
 *
 *   Config → API Clients → Repositories → Services → Workers
 *
 * @param config - Application configuration
 * @param prisma - PrismaClient instance
 * @param redis - Redis instance (for BullMQ)
 * @param logger - Root logger instance
 * @returns All ingestion worker instances ready for queue registration
 */
export function createIngestionDependencies(
  config: Config,
  prisma: PrismaClient,
  redis: Redis,
  logger: Logger,
): IngestionDependencies {
  const depLogger = logger.child({ module: 'ingestion-bootstrap' });

  depLogger.info('Creating ingestion dependencies');

  // ── Integrations (API clients) ─────────────────────────────────────
  const oddsApiClient = createOddsApiClient(
    { apiKey: config.api.theOddsApiKey },
    logger,
  );

  const pandascoreClient = createPandascoreClient(
    { apiToken: config.api.pandascoreApiKey },
    logger,
  );

  // ── Mappers ────────────────────────────────────────────────────────
  const oddsApiSportMapper = new OddsApiSportMapper();
  const pandascoreMatchMapper = new PandascoreMatchMapper();

  // ── Repositories ───────────────────────────────────────────────────
  const sportRepository = new SportRepository(prisma, logger);
  const leagueRepository = new LeagueRepository(prisma, logger);
  const teamRepository = new TeamRepository(prisma, logger);
  const teamLeagueRepository = new TeamLeagueRepository(prisma, logger);
  const matchRepository = new MatchRepository(prisma, logger);
  const oddsSnapshotRepository = new OddsSnapshotRepository(prisma, logger);

  // ── Services ───────────────────────────────────────────────────────
  const referenceDataService = new ReferenceDataIngestionService(
    oddsApiClient,
    oddsApiSportMapper,
    sportRepository,
    leagueRepository,
    logger,
  );

  const matchIngestionService = new MatchIngestionService(
    oddsApiClient,
    pandascoreClient,
    pandascoreMatchMapper,
    sportRepository,
    leagueRepository,
    teamRepository,
    matchRepository,
    teamLeagueRepository,
    logger,
  );

  const oddsSnapshotService = new OddsSnapshotIngestionService(
    oddsApiClient,
    oddsSnapshotRepository,
    logger,
  );

  // ── Queues (for inter-queue communication and bot-status health display) ──
  const matchFetchQueue = new Queue(QueueName.MATCH_FETCH, {
    connection: redis as unknown as import('bullmq').ConnectionOptions,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  const oddsFetchQueue = new Queue(QueueName.ODDS_FETCH, {
    connection: redis as unknown as import('bullmq').ConnectionOptions,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  const aiAnalysisQueue = new Queue(QueueName.AI_ANALYSIS, {
    connection: redis as unknown as import('bullmq').ConnectionOptions,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  // ── OddsPapi client ────────────────────────────────────────────────
  const oddspapiClient = createOddspapiClient(
    { apiKey: config.api.oddsPapiApiKey },
    redis,
    logger,
  );

  // ── Esports odds service ───────────────────────────────────────────
  const esportsOddsSnapshotService = new EsportsOddsSnapshotIngestionService(
    oddspapiClient,
    matchRepository,
    oddsSnapshotRepository,
    logger,
  );

  // ── Value detection ────────────────────────────────────────────────
  const valueOpportunityRepository = new ValueOpportunityRepository(prisma, logger);
  const valueDetectionService = new ValueDetectionService(prisma, valueOpportunityRepository, config.betting.maxAlertOdds, logger);

  // ── Discord notifications ──────────────────────────────────────────
  const discordNotificationService = new DiscordNotificationService(
    prisma,
    {
      token: config.discord.token,
      alertChannelId: config.discord.alertChannelId,
      outcomesChannelId: config.discord.outcomesChannelId,
    },
    logger,
  );

  // ── Settlement ─────────────────────────────────────────────────────
  const settlementService = new SettlementService(prisma, oddsApiClient, pandascoreClient, logger);
  const settlementWorker = new SettlementWorker(settlementService, discordNotificationService, logger);

  // ── Daily summary ──────────────────────────────────────────────────
  const dailySummaryWorker = new DailySummaryWorker(discordNotificationService, logger);

  // ── Workers ────────────────────────────────────────────────────────
  const referenceDataWorker = new ReferenceDataWorker(
    referenceDataService,
    logger,
  );

  const matchIngestionWorker = new MatchIngestionWorker(
    matchIngestionService,
    oddsFetchQueue,
    redis,
    logger,
  );

  const oddsSnapshotWorker = new OddsSnapshotWorker(
    oddsSnapshotService,
    valueDetectionService,
    discordNotificationService,
    logger,
  );

  const esportsOddsSnapshotWorker = new EsportsOddsSnapshotWorker(
    esportsOddsSnapshotService,
    valueDetectionService,
    discordNotificationService,
    logger,
  );

  // ── Discord bot (slash commands + operational visibility) ──────────
  const discordBot = new DiscordBotService(
    { token: config.discord.token, clientId: config.discord.clientId, guildId: config.discord.guildId },
    prisma,
    redis,
    { [QueueName.MATCH_FETCH]: matchFetchQueue, [QueueName.ODDS_FETCH]: oddsFetchQueue, [QueueName.AI_ANALYSIS]: aiAnalysisQueue },
    valueDetectionService,
    matchFetchQueue,
    logger,
  );

  depLogger.info('Ingestion dependencies created');

  return {
    referenceDataWorker,
    matchIngestionWorker,
    oddsSnapshotWorker,
    esportsOddsSnapshotWorker,
    settlementWorker,
    dailySummaryWorker,
    discordBot,
    valueDetectionService,
    matchFetchQueue,
  };
}