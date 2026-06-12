/* eslint-disable no-console */
/**
 * One-off: clears all settlement labels for the given runs (removing the
 * loss-skewed row-level settles from the first pass), then re-settles with the
 * unbiased winner-only rule.
 * Run: npx tsx --env-file=.env scripts/backtest/roi-resettle.ts <runId> [...runIds]
 */
import { PrismaClient } from '@prisma/client';
import { settleRun } from '../../src/backtest';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const runIds = process.argv.slice(2);
  if (runIds.length === 0) { console.error('Usage: roi-resettle.ts <runId>...'); process.exit(1); }
  const cleared = await prisma.backtestOpportunity.updateMany({
    where: { runId: { in: runIds } },
    data: { betResult: null, profitLossUnits: null },
  });
  console.log(`cleared labels on ${cleared.count} rows`);
  for (const runId of runIds) {
    const s = await settleRun(prisma, runId);
    console.log(`run ${runId}: rows=${s.rowsTotal} W=${s.rowsWon} L=${s.rowsLost} unresolved=${s.rowsUnresolved}`);
  }
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
