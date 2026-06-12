/* eslint-disable no-console */
/**
 * Read-only dry run: replicate the movement-annotation computation over live data.
 * Shows per-window null rates at current polling cadence + concrete examples.
 * Run: npx tsx --env-file=.env scripts/movement-annotation-dryrun.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  return (v as { toNumber(): number }).toNumber();
}

function movementPct(
  history: ReadonlyArray<{ capturedAt: Date; price: number }>,
  latestPrice: number,
  latestCapturedAt: Date,
  windowHours: number,
): number | null {
  const latestMs = latestCapturedAt.getTime();
  const windowStartMs = latestMs - windowHours * 60 * 60 * 1000;
  let oldest: { capturedAt: Date; price: number } | undefined;
  for (const p of history) {
    const t = p.capturedAt.getTime();
    if (t < windowStartMs || t >= latestMs) continue;
    if (!oldest || t < oldest.capturedAt.getTime()) oldest = p;
  }
  return oldest ? (latestPrice / oldest.price - 1) * 100 : null;
}

async function main(): Promise<void> {
  const matches = await prisma.match.findMany({
    where: { sport: { category: 'TRADITIONAL' }, oddsSnapshots: { some: { bookmaker: 'pinnacle' } } },
    select: { id: true, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } },
    take: 100,
  });

  let evaluated = 0;
  const nonNull = { h1: 0, h6: 0, h24: 0 };
  const examples: string[] = [];

  for (const m of matches) {
    const snaps = await prisma.oddsSnapshot.findMany({
      where: { matchId: m.id, bookmaker: 'pinnacle', market: 'H2H', isLive: false },
      select: { outcome: true, price: true, capturedAt: true },
      orderBy: { capturedAt: 'asc' },
    });
    if (snaps.length === 0) continue;

    const latestCapturedAt = snaps[snaps.length - 1].capturedAt;
    const byOutcome = new Map<string, Array<{ capturedAt: Date; price: number }>>();
    const latestPrice = new Map<string, number>();
    for (const s of snaps) {
      const price = toNum(s.price);
      if (!(price > 1)) continue;
      let arr = byOutcome.get(s.outcome);
      if (!arr) { arr = []; byOutcome.set(s.outcome, arr); }
      arr.push({ capturedAt: s.capturedAt, price });
      if (s.capturedAt.getTime() === latestCapturedAt.getTime() && !latestPrice.has(s.outcome)) {
        latestPrice.set(s.outcome, price);
      }
    }

    for (const [outcome, history] of byOutcome) {
      const latest = latestPrice.get(outcome);
      if (latest === undefined) continue;
      evaluated++;
      const m1 = movementPct(history, latest, latestCapturedAt, 1);
      const m6 = movementPct(history, latest, latestCapturedAt, 6);
      const m24 = movementPct(history, latest, latestCapturedAt, 24);
      if (m1 !== null) nonNull.h1++;
      if (m6 !== null) nonNull.h6++;
      if (m24 !== null) nonNull.h24++;
      if (m24 !== null && Math.abs(m24) >= 3 && examples.length < 5) {
        examples.push(
          `${m.homeTeam.name} vs ${m.awayTeam.name} | ${outcome} | latest=${latest.toFixed(2)} ` +
          `move1h=${m1 === null ? 'null' : m1.toFixed(2) + '%'} move6h=${m6 === null ? 'null' : m6.toFixed(2) + '%'} move24h=${m24.toFixed(2)}%`,
        );
      }
    }
  }

  console.log(`evaluated outcomes: ${evaluated}`);
  console.log(`move1h  non-null: ${nonNull.h1} (${((nonNull.h1 / evaluated) * 100).toFixed(0)}%)`);
  console.log(`move6h  non-null: ${nonNull.h6} (${((nonNull.h6 / evaluated) * 100).toFixed(0)}%)`);
  console.log(`move24h non-null: ${nonNull.h24} (${((nonNull.h24 / evaluated) * 100).toFixed(0)}%)`);
  console.log('\nexamples (|move24h| >= 3%):');
  for (const e of examples) console.log('  ' + e);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
