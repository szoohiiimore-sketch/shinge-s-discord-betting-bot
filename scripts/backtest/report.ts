/* eslint-disable no-console */
/**
 * Report CLI — idea-denominated per-run report, or a paired comparison when
 * two run ids are given (both arms replay the identical snapshot stream).
 *
 * Run: npx tsx --env-file=.env scripts/backtest/report.ts <runId> [runIdB]
 */
import { PrismaClient } from '@prisma/client';
import { renderRunComparison, renderRunReport } from '../../src/backtest';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const runId = process.argv[2];
  const runIdB = process.argv[3];
  if (!runId) {
    console.error('Usage: report.ts <runId> [runIdB]');
    process.exit(1);
  }
  const lines = runIdB
    ? await renderRunComparison(prisma, runId, runIdB)
    : await renderRunReport(prisma, runId);
  for (const line of lines) console.log(line);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
