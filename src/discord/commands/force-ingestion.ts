import type { Logger } from '@/lib/logger';
import { MATCH_FETCH_JOB_NAMES } from '@/ingestion/queues';
import type { SyncTraditionalSportJobData, SyncEsportsGameJobData, EsportsVideogame } from '@/ingestion/contracts';
import type { Queue as BullmqQueue } from 'bullmq';

const SPORT_KEY_TO_GROUP: Record<string, string> = {
  // Tennis tournaments
  'tennis_atp_wimbledon':     'Tennis',
  'tennis_atp_us_open':       'Tennis',
  'tennis_atp_indian_wells':  'Tennis',
  'tennis_atp_miami_open':    'Tennis',
  'tennis_wta_wimbledon':     'Tennis',
  'tennis_wta_us_open':       'Tennis',
  'tennis_wta_indian_wells':  'Tennis',
  'tennis_wta_miami_open':    'Tennis',
  // Tier 1 (60 min)
  'icehockey_nhl':           'Ice Hockey',
  'baseball_mlb':            'Baseball',
  'basketball_wnba':         'Basketball',
  'soccer_usa_mls':          'Soccer',
  // Tier 2 (4h)
  'basketball_nba':          'Basketball',
  'soccer_epl':              'Soccer',
  'soccer_uefa_champs_league': 'Soccer',
  'americanfootball_ncaaf':  'Football',
};

const ESPORTS_GAMES: Record<string, EsportsVideogame> = {
  cs2: 'cs2',
  dota2: 'dota2',
  lol: 'lol',
  valorant: 'valorant',
};

export interface ForceIngestionOptions {
  readonly source: 'traditional' | 'esports' | 'all';
  readonly sportKey?: string;
}

interface EnqueuedJob {
  readonly queue: string;
  readonly jobName: string;
  readonly payload: Record<string, unknown>;
}

export async function executeForceIngestion(
  matchFetchQueue: BullmqQueue,
  options: ForceIngestionOptions,
  logger: Logger,
): Promise<{ content: string }> {
  const startedAt = Date.now();
  logger.info({
    command: 'force-ingestion',
    source: options.source,
    sportKey: options.sportKey ?? '(none)',
  }, 'Command execution started');

  const jobs: EnqueuedJob[] = [];

  if (options.source === 'traditional' || options.source === 'all') {
    if (options.sportKey) {
      const group = SPORT_KEY_TO_GROUP[options.sportKey];
      if (!group) {
        return { content: `Unknown sport key: \`${options.sportKey}\`. Supported keys: ${Object.keys(SPORT_KEY_TO_GROUP).join(', ')}` };
      }
      const payload: SyncTraditionalSportJobData = { sportKey: options.sportKey, sportGroup: group };
      const job = await matchFetchQueue.add(MATCH_FETCH_JOB_NAMES.SYNC_TRADITIONAL_SPORT, payload, { delay: 1000 });
      jobs.push({ queue: 'match-fetch', jobName: 'sync-traditional-sport', payload: payload as unknown as Record<string, unknown> });
      logger.info({ command: 'force-ingestion', jobId: job.id, jobName: 'sync-traditional-sport', sportKey: options.sportKey, queue: 'match-fetch' }, 'Job enqueued');
    } else {
      // Enqueue all traditional sports
      for (const [sportKey, group] of Object.entries(SPORT_KEY_TO_GROUP)) {
        const payload: SyncTraditionalSportJobData = { sportKey, sportGroup: group };
        const job = await matchFetchQueue.add(MATCH_FETCH_JOB_NAMES.SYNC_TRADITIONAL_SPORT, payload, { delay: 1000 });
        jobs.push({ queue: 'match-fetch', jobName: 'sync-traditional-sport', payload: payload as unknown as Record<string, unknown> });
        logger.info({ command: 'force-ingestion', jobId: job.id, jobName: 'sync-traditional-sport', sportKey, queue: 'match-fetch' }, 'Job enqueued');
      }
    }
  }

  if (options.source === 'esports' || options.source === 'all') {
    const gameKeys = options.sportKey
      ? (ESPORTS_GAMES[options.sportKey] ? [options.sportKey as EsportsVideogame] : [])
      : Object.keys(ESPORTS_GAMES) as EsportsVideogame[];

    if (options.sportKey && gameKeys.length === 0 && options.source === 'esports') {
      return { content: `Unknown esports game: \`${options.sportKey}\`. Supported: ${Object.keys(ESPORTS_GAMES).join(', ')}` };
    }

    if (gameKeys.length === 0 && options.sportKey && options.source === 'all') {
      // sportKey was specified but didn't match esports → already handled as traditional
    }

    for (const videogame of gameKeys) {
      const payload: SyncEsportsGameJobData = { videogame };
      const job = await matchFetchQueue.add(MATCH_FETCH_JOB_NAMES.SYNC_ESPORTS_GAME, payload, { delay: 1000 });
      jobs.push({ queue: 'match-fetch', jobName: 'sync-esports-game', payload: payload as unknown as Record<string, unknown> });
      logger.info({ command: 'force-ingestion', jobId: job.id, jobName: 'sync-esports-game', videogame, queue: 'match-fetch' }, 'Job enqueued');
    }
  }

  const durationMs = Date.now() - startedAt;

  const lines = [
    `**Data Source:** External API (BullMQ → Ingestion Worker)`,
    `**API Calls:** Pending (enqueued) | **Duration:** ${durationMs}ms`,
    '',
    '🚀 **FORCE INGESTION**',
    '',
    `**Source:** ${options.source}`,
    `**Sport Key:** ${options.sportKey ?? '(all)'}`,
    `**Jobs Enqueued:** ${jobs.length}`,
  ];

  for (const job of jobs) {
    lines.push(`  • \`${job.queue}\` → \`${job.jobName}\``);
  }

  lines.push(
    '',
    'Jobs will execute asynchronously. Check `/bot-status` for OddsSnapshot count changes.',
  );

  logger.info({
    command: 'force-ingestion',
    source: options.source,
    sportKey: options.sportKey ?? '(all)',
    jobsEnqueued: jobs.length,
    durationMs,
  }, 'Command execution complete');

  return { content: lines.join('\n') };
}