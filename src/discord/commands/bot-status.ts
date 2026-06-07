import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import type { QueueCollection } from '@/lib/queue/queue-types';

export async function getBotStatus(
  prisma: PrismaClient,
  redis: Redis,
  queues: QueueCollection,
  logger: Logger,
): Promise<string> {
  const startedAt = Date.now();
  logger.info({ command: 'bot-status' }, 'Command execution started');

  // Database (PostgreSQL)
  let dbOk = false;
  let dbDurationMs = 0;
  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbDurationMs = Date.now() - dbStart;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  // Redis (upstash)
  let redisOk = false;
  let redisDurationMs = 0;
  try {
    const redisStart = Date.now();
    const pong = await redis.ping();
    redisDurationMs = Date.now() - redisStart;
    redisOk = pong === 'PONG';
  } catch {
    redisOk = false;
  }

  // BullMQ queues
  const queueStats: string[] = [];
  for (const [name, queue] of Object.entries(queues)) {
    try {
      const counts = await queue.getJobCounts();
      queueStats.push(`  ${name}: waiting=${counts.waiting} active=${counts.active} failed=${counts.failed}`);
    } catch {
      queueStats.push(`  ${name}: error retrieving counts`);
    }
  }

  // Entity counts (PostgreSQL)
  let valueOppCount = 0;
  let snapshotCount = 0;
  let matchCount = 0;
  try {
    valueOppCount = await prisma.valueOpportunity.count();
    snapshotCount = await prisma.oddsSnapshot.count();
    matchCount = await prisma.match.count();
  } catch {
    // Prisma client may not have regenerated
  }

  const durationMs = Date.now() - startedAt;
  logger.info({
    command: 'bot-status',
    dataSources: ['PostgreSQL (live query)', 'Redis (live PING)', 'BullMQ (live counts)'],
    dbConnected: dbOk,
    redisConnected: redisOk,
    dbLatencyMs: dbDurationMs,
    redisLatencyMs: redisDurationMs,
    matches: matchCount,
    oddsSnapshots: snapshotCount,
    valueOpportunities: valueOppCount,
    durationMs,
  }, 'Command execution complete');

  const lines = [
    `**Data Source:** Live Infrastructure`,
    `**Duration:** ${durationMs}ms`,
    '',
    '🤖 **BOT STATUS**',
    '',
    `**Database:** ${dbOk ? '✅ Connected' : '❌ Unreachable'} (${dbDurationMs}ms)`,
    `**Redis:** ${redisOk ? '✅ Connected' : '❌ Unreachable'} (${redisDurationMs}ms)`,
    '',
    '**Queue Counts:**',
    ...queueStats,
    '',
    `**Total Matches:** ${matchCount}`,
    `**Total OddsSnapshots:** ${snapshotCount}`,
    `**Total ValueOpportunities:** ${valueOppCount}`,
  ];

  return lines.join('\n');
}
