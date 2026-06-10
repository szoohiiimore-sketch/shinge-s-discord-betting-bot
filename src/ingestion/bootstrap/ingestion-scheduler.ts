import type { Queue } from 'bullmq';
import type { Logger } from '@/lib/logger';
import type { EsportsVideogame } from '@/ingestion/contracts';
import type { SyncTraditionalSportJobData, SettleMatchesJobData, DailySummaryJobData } from '@/ingestion/contracts';
import { MATCH_FETCH_JOB_NAMES } from '@/ingestion/queues';

/** All V1 esports videogames — exhaustive by the EsportsVideogame type definition. */
const ESPORTS_VIDEOGAMES: readonly EsportsVideogame[] = [
  'cs2',
  'valorant',
  'lol',
  'dota2',
];

/** Configuration for a single traditional sport repeatable job. */
export interface TraditionalSportScheduleConfig {
  /** The Odds API sport key, e.g. "soccer_epl". */
  readonly sportKey: string;
  /** The Odds API group field, e.g. "Soccer". Used to derive the canonical sport slug. */
  readonly sportGroup: string;
  /**
   * Polling interval in milliseconds.
   *
   * Recommended values:
   *   THIRTY_MINUTES_MS  (Tier 1 — high-frequency sports: ATP, WTA)
   *   SIXTY_MINUTES_MS   (Tier 2 — moderate frequency: NHL, MLB)
   *   FOUR_HOURS_MS      (Tier 3 — event-driven approximation: NBA, EPL, UCL)
   */
  readonly intervalMs: number;
}

/** Polling interval constants for use in caller-supplied sport configurations. */
export const THIRTY_MINUTES_MS = 30 * 60 * 1000;
export const SIXTY_MINUTES_MS = 60 * 60 * 1000;
export const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
export const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/**
 * Registers all repeatable ingestion jobs with BullMQ.
 *
 * Must be called once at application startup, after the match-fetch Queue is ready.
 * BullMQ deduplicates repeatable jobs by name + repeat options on restart.
 *
 * Esports videogames are all scheduled at THIRTY_MINUTES_MS. Traditional sport
 * intervals are caller-supplied via TraditionalSportScheduleConfig.intervalMs,
 * enabling per-tier polling rates without coupling the scheduler to business decisions.
 *
 * Tier guidance (for callers):
 *   Tier 1 — THIRTY_MINUTES_MS  : ATP, WTA, CS2, Dota2, LoL, Valorant
 *   Tier 2 — SIXTY_MINUTES_MS   : NHL, MLB, Rainbow Six Siege, Mobile Legends
 *   Tier 3 — FOUR_HOURS_MS      : NBA, Premier League, Champions League
 *
 * Tier 3 is implemented as a slow fixed-poll approximation of event-driven scheduling.
 * The ingestion service's 48-hour near-term window filter ensures odds jobs are only
 * enqueued when upcoming matches actually exist, making idle polls cheap.
 *
 * @param matchFetchQueue  - The match-fetch BullMQ Queue instance.
 * @param sportConfigs     - Traditional sport configurations including per-sport intervals.
 * @param logger           - Logger instance.
 */
export async function scheduleIngestionJobs(
  matchFetchQueue: Queue,
  sportConfigs: readonly TraditionalSportScheduleConfig[],
  logger: Logger,
): Promise<void> {
  const schedLogger = logger.child({ module: 'ingestion-scheduler' });

  schedLogger.info(
    { sportCount: sportConfigs.length, esportsCount: ESPORTS_VIDEOGAMES.length },
    'Registering repeatable ingestion jobs',
  );

  // ── Reference data (daily) ─────────────────────────────────────────
  await matchFetchQueue.add(
    MATCH_FETCH_JOB_NAMES.SYNC_REFERENCE_DATA,
    {} as Record<string, never>,
    { repeat: { every: 24 * 60 * 60 * 1000 } },
  );
  schedLogger.debug('Registered sync-reference-data (every 24 h)');

  // ── Traditional sports (per-sport interval) ────────────────────────
  for (const { sportKey, sportGroup, intervalMs } of sportConfigs) {
    const data: SyncTraditionalSportJobData = { sportKey, sportGroup };
    await matchFetchQueue.add(
      MATCH_FETCH_JOB_NAMES.SYNC_TRADITIONAL_SPORT,
      data,
      {
        repeat: { every: intervalMs },
        jobId: `repeat:sync-traditional-sport:${sportKey}`,
      },
    );
    schedLogger.debug({ sportKey, intervalMs }, 'Registered sync-traditional-sport');
  }

  // ── Esports videogames — DISABLED (V1) ────────────────────────────
  // Esports ingestion is disabled pending resolution of the OddsPapi fixture
  // correlation collision bug (see ESPORTS-DISABLE-IMPACT-AUDIT.md).
  // ESPORTS_VIDEOGAMES loop intentionally omitted. To re-enable, restore:
  //   for (const videogame of ESPORTS_VIDEOGAMES) {
  //     await matchFetchQueue.add(MATCH_FETCH_JOB_NAMES.SYNC_ESPORTS_GAME, { videogame },
  //       { repeat: { pattern: '0 12,17 * * *', tz: 'Europe/Budapest' },
  //         jobId: `repeat:sync-esports-game:${videogame}` });
  //   }
  schedLogger.info('Esports ingestion disabled — no sync-esports-game jobs registered');

  // ── Settlement (every 4 hours) ─────────────────────────────────────
  await matchFetchQueue.add(
    MATCH_FETCH_JOB_NAMES.SETTLE_MATCHES,
    {} as SettleMatchesJobData,
    {
      repeat: { every: FOUR_HOURS_MS },
      jobId: 'repeat:settle-matches',
    },
  );
  schedLogger.debug('Registered settle-matches (every 4 h)');

  // ── Daily summary (23:00 Europe/Budapest) ─────────────────────────
  await matchFetchQueue.add(
    MATCH_FETCH_JOB_NAMES.DAILY_SUMMARY,
    {} as DailySummaryJobData,
    {
      repeat: { pattern: '0 23 * * *', tz: 'Europe/Budapest' },
      jobId: 'repeat:daily-summary',
    },
  );
  schedLogger.debug('Registered daily-summary (23:00 Budapest)');

  schedLogger.info(
    {
      referenceData: 1,
      traditionalSports: sportConfigs.length,
      esportsGames: ESPORTS_VIDEOGAMES.length,
      settlement: 1,
      dailySummary: 1,
    },
    'All repeatable ingestion jobs registered',
  );
}
