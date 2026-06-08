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
  'basketball_nba':           'Basketball',
  'soccer_epl':               'Soccer',
  'soccer_uefa_champs_league': 'Soccer',
  'americanfootball_ncaaf':   'Football',
  // Tier 3 (3h — mass league expansion)
  'soccer_brazil_serie_b':        'Soccer',
  'soccer_argentina_primera_division': 'Soccer',
  'soccer_australia_aleague':     'Soccer',
  'soccer_austria_bundesliga':    'Soccer',
  'soccer_brazil_campeonato':     'Soccer',
  'soccer_belgium_first_div':     'Soccer',
  'soccer_chile_campeonato':      'Soccer',
  'soccer_china_superleague':     'Soccer',
  'soccer_denmark_superliga':     'Soccer',
  'soccer_england_league2':       'Soccer',
  'soccer_finland_veikkausliiga': 'Soccer',
  'soccer_france_ligue_two':      'Soccer',
  'soccer_germany_bundesliga2':   'Soccer',
  'soccer_germany_bundesliga_women': 'Soccer',
  'soccer_germany_dfb_pokal':     'Soccer',
  'soccer_germany_liga3':         'Soccer',
  'soccer_greece_super_league':   'Soccer',
  'soccer_italy_serie_b':         'Soccer',
  'soccer_japan_j_league':        'Soccer',
  'soccer_korea_kleague1':        'Soccer',
  'soccer_league_of_ireland':     'Soccer',
  'soccer_mexico_ligamx':         'Soccer',
  'soccer_netherlands_eredivisie':'Soccer',
  'soccer_norway_eliteserien':    'Soccer',
  'soccer_poland_ekstraklasa':    'Soccer',
  'soccer_portugal_primeira_liga':'Soccer',
  'soccer_russia_premier_league': 'Soccer',
  'soccer_spain_segunda_division':'Soccer',
  'soccer_saudi_arabia_pro_league': 'Soccer',
  'soccer_spl':                   'Soccer',
  'soccer_sweden_allsvenskan':    'Soccer',
  'soccer_sweden_superettan':     'Soccer',
  'soccer_switzerland_superleague': 'Soccer',
  'soccer_turkey_super_league':   'Soccer',
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

  let content = lines.join('\n');

  // Discord message limit is 2000 characters. If the job list is long (e.g. "all"
  // sources with 50+ sports), truncate to stay within limit.
  if (content.length > 1990) {
    content = content.slice(0, 1990) + '\n\n*(truncated — showing first jobs only)*';
  }

  logger.info({
    command: 'force-ingestion',
    source: options.source,
    sportKey: options.sportKey ?? '(all)',
    jobsEnqueued: jobs.length,
    durationMs,
  }, 'Command execution complete');

  return { content };
}