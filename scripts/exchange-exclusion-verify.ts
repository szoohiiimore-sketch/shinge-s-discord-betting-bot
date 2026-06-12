/* eslint-disable no-console */
/**
 * Read-only verification: replay the detection candidate logic (with exchange
 * exclusion) over the latest snapshot batch of the match that produced the
 * exchange alerts — Dallas Wings vs Phoenix Mercury.
 * Run: npx tsx --env-file=.env scripts/exchange-exclusion-verify.ts
 */
import { PrismaClient } from '@prisma/client';
import { isExchange } from '../src/value-detection/idea-aggregation';

const prisma = new PrismaClient();

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  return (v as { toNumber(): number }).toNumber();
}

async function main(): Promise<void> {
  const match = await prisma.match.findFirst({
    where: {
      homeTeam: { name: { contains: 'Dallas Wings' } },
      awayTeam: { name: { contains: 'Phoenix Mercury' } },
    },
    select: { id: true, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } },
    orderBy: { startTime: 'desc' },
  });
  if (!match) { console.log('Match not found'); return; }
  console.log(`Match: ${match.homeTeam.name} vs ${match.awayTeam.name}`);

  const snaps = await prisma.oddsSnapshot.findMany({
    where: { matchId: match.id, market: 'H2H', isLive: false },
    select: { bookmaker: true, outcome: true, price: true, capturedAt: true },
  });
  const latest = snaps.reduce((m, s) => (s.capturedAt > m ? s.capturedAt : m), snaps[0].capturedAt);
  const batch = snaps.filter(s => s.capturedAt.getTime() === latest.getTime());

  // Build per-bookmaker outcome maps (first occurrence wins), de-vig Pinnacle.
  const byBook = new Map<string, Map<string, number>>();
  for (const s of batch) {
    const price = toNum(s.price);
    if (!(price > 1)) continue;
    let m = byBook.get(s.bookmaker);
    if (!m) { m = new Map(); byBook.set(s.bookmaker, m); }
    if (!m.has(s.outcome)) m.set(s.outcome, price);
  }
  const ref = byBook.get('pinnacle');
  if (!ref || ref.size < 2) { console.log('No Pinnacle reference in latest batch'); return; }
  let overround = 0;
  for (const o of ref.values()) overround += 1 / o;
  console.log(`Latest batch: ${latest.toISOString()} | books=${byBook.size} | Pinnacle overround=${overround.toFixed(4)}\n`);

  const fair = new Map<string, number>();
  for (const [outcome, odds] of ref) fair.set(outcome, (1 / odds) / overround);

  let excluded = 0;
  let evaluated = 0;
  const wouldDetect: string[] = [];
  for (const [bookmaker, outcomes] of byBook) {
    if (bookmaker === 'pinnacle') continue;
    if (isExchange(bookmaker)) {
      excluded++;
      console.log(`EXCHANGE_EXCLUDED  ${bookmaker}`);
      continue;
    }
    evaluated++;
    if (outcomes.size !== ref.size) continue;
    for (const [outcome, odds] of outcomes) {
      const fp = fair.get(outcome);
      if (fp === undefined || odds > 3.0) continue;
      const edge = (odds * fp - 1) * 100;
      if (edge >= 2.0) wouldDetect.push(`${bookmaker} | ${outcome} | edge=${edge.toFixed(2)}% odds=${odds}`);
    }
  }

  console.log(`\nexchange candidates excluded: ${excluded}`);
  console.log(`non-exchange candidates evaluated: ${evaluated}`);
  console.log(`detections (>=2%) under new logic: ${wouldDetect.length}`);
  for (const d of wouldDetect) console.log('  ' + d);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
