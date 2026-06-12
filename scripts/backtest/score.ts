/* eslint-disable no-console */
/**
 * Scoring CLI — computes historical CLV for a replayed run against the
 * de-vigged reference close. Writes only the label columns.
 *
 * Run: npx tsx --env-file=.env scripts/backtest/score.ts <runId>
 */
import { PrismaClient } from '@prisma/client';
import { scoreRunClv } from '../../src/backtest';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error('Usage: score.ts <runId>');
    process.exit(1);
  }
  const summary = await scoreRunClv(prisma, runId);
  console.log(`events scored: ${summary.eventsScored} | events without valid close: ${summary.eventsWithoutClose}`);
  console.log(`rows scored: ${summary.rowsScored} | rows null CLV: ${summary.rowsNullClv}`);
  console.log(`\nNext: npx tsx --env-file=.env scripts/backtest/report.ts ${runId}`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
