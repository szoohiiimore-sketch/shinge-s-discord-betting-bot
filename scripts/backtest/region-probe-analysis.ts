/* eslint-disable no-console */
/**
 * AU/US2 region probe analysis: of the ideas detected when au+us2 books are
 * merged into the eu data, how many exist ONLY because of the new regions,
 * and what is their CLV? Also reports which new books produce candidates.
 *
 * Run: npx tsx --env-file=.env scripts/backtest/region-probe-analysis.ts <combinedRunId> <periodDays>
 */
import { PrismaClient } from '@prisma/client';
import { groupIdeas, selectHeadline } from '../../src/value-detection';
import { clvStats, loadReportRows } from '../../src/backtest';

const prisma = new PrismaClient();

/** Books present in the eu backfill of the same leagues/window. */
async function euBookSet(): Promise<Set<string>> {
  const rows = await prisma.historicalOddsSnapshot.groupBy({
    by: ['bookmaker'],
    where: {
      sportKey: { in: ['soccer_sweden_superettan', 'soccer_spain_segunda_division'] },
      snapshotAt: { gte: new Date('2026-04-20T00:00:00Z'), lt: new Date('2026-05-18T00:00:00Z') },
    },
  });
  return new Set(rows.map(r => r.bookmaker));
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  const days = parseFloat(process.argv[3] ?? '20');
  if (!runId) { console.error('Usage: region-probe-analysis.ts <combinedRunId> [days]'); process.exit(1); }

  const euBooks = await euBookSet();
  const rows = await loadReportRows(prisma, runId);
  const production = rows.filter(r => !r.isShadow);

  const newBookRows = production.filter(r => !euBooks.has(r.bookmaker));
  console.log(`production rows: ${production.length} | rows from non-eu books: ${newBookRows.length}`);
  const byBook = new Map<string, number>();
  for (const r of newBookRows) byBook.set(r.bookmaker, (byBook.get(r.bookmaker) ?? 0) + 1);
  console.log('non-eu candidate books:', [...byBook.entries()].sort((a, b) => b[1] - a[1]).map(([b, n]) => `${b}(${n})`).join(' ') || 'none');

  const ideas = groupIdeas(production);
  let total = 0;
  let newOnly = 0;
  let headlineNew = 0;
  const newOnlyClv: number[] = [];
  const allClv: number[] = [];
  for (const members of ideas.values()) {
    total++;
    const headline = selectHeadline(members);
    if (!headline) continue;
    const h = headline as (typeof members)[number];
    if (h.clvPercentage !== null) allClv.push(h.clvPercentage);
    if (!euBooks.has(h.bookmaker)) headlineNew++;
    if (members.every(m => !euBooks.has(m.bookmaker))) {
      newOnly++;
      if (h.clvPercentage !== null) newOnlyClv.push(h.clvPercentage);
    }
  }
  const s = clvStats(newOnlyClv);
  const all = clvStats(allClv);
  console.log(`\nideas total: ${total} (${(total / days).toFixed(2)}/d) | all-ideas CLV avg=${all.mean?.toFixed(2)}% trim=${all.trimmedMean?.toFixed(2)}%`);
  console.log(`ideas existing ONLY via au/us2 books: ${newOnly} (+${(newOnly / days).toFixed(2)}/d)`);
  console.log(`ideas whose HEADLINE is an au/us2 book: ${headlineNew}`);
  console.log(`au/us2-only idea CLV: n=${s.n} avg=${s.mean?.toFixed(2) ?? '—'}% med=${s.median?.toFixed(2) ?? '—'}% pos=${s.positiveRate !== null ? (s.positiveRate * 100).toFixed(0) : '—'}% trim=${s.trimmedMean?.toFixed(2) ?? '—'}%`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
