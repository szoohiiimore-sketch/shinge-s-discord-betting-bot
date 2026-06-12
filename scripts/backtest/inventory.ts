/* eslint-disable no-console */
/**
 * Historical store inventory: what data exists, per sport, plus cursor spend.
 * Run: npx tsx --env-file=.env scripts/backtest/inventory.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const groups = await prisma.historicalOddsSnapshot.groupBy({
    by: ['sportKey'],
    _count: { _all: true },
    _min: { snapshotAt: true },
    _max: { snapshotAt: true },
  });
  console.log('── historical_odds_snapshots by sport ──');
  for (const g of groups.sort((a, b) => a.sportKey.localeCompare(b.sportKey))) {
    const events = await prisma.historicalEvent.count({ where: { sportKey: g.sportKey } });
    console.log(`${g.sportKey.padEnd(36)} rows=${String(g._count._all).padStart(7)} events=${String(events).padStart(4)} ${g._min.snapshotAt?.toISOString().slice(0, 10)} → ${g._max.snapshotAt?.toISOString().slice(0, 10)}`);
  }
  console.log('\n── ingestion cursors ──');
  const cursors = await prisma.historicalIngestionCursor.findMany({ orderBy: { id: 'asc' } });
  for (const c of cursors) {
    console.log(`${c.id.padEnd(60)} last=${c.lastTimestamp?.toISOString() ?? '—'} credits=${c.creditsUsed}`);
  }
  const totalCredits = cursors.reduce((s, c) => s + c.creditsUsed, 0);
  console.log(`\ntotal credits recorded in cursors: ${totalCredits}`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
