/* eslint-disable no-console */
/**
 * Historical settlement CLI — infers event results from stored in-play prices
 * (zero API usage), then settles the given runs' opportunities.
 *
 * Run: npx tsx --env-file=.env scripts/backtest/roi-settle.ts <runId> [...runIds]
 */
import { PrismaClient } from '@prisma/client';
import { inferResults, settleRun } from '../../src/backtest';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const runIds = process.argv.slice(2);
  if (runIds.length === 0) {
    console.error('Usage: roi-settle.ts <runId> [...runIds]');
    process.exit(1);
  }

  // Infer results once for every sport touched by the given runs.
  const sportKeys = new Set<string>();
  for (const runId of runIds) {
    const run = await prisma.backtestRun.findUniqueOrThrow({ where: { id: runId }, select: { config: true } });
    for (const key of (run.config as { sportKeys: string[] }).sportKeys) sportKeys.add(key);
  }
  console.log(`Inferring results for: ${[...sportKeys].join(', ')}`);
  const inference = await inferResults(prisma, [...sportKeys]);
  console.log(`events checked=${inference.eventsChecked} | winners inferred=${inference.winnersInferred} | already resolved=${inference.alreadyResolved} | unresolved=${inference.unresolved}\n`);

  for (const runId of runIds) {
    const s = await settleRun(prisma, runId);
    console.log(`run ${runId}: rows=${s.rowsTotal} W=${s.rowsWon} L=${s.rowsLost} unresolved=${s.rowsUnresolved}`);
  }
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
