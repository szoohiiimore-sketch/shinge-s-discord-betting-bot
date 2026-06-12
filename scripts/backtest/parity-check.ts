/* eslint-disable no-console */
/**
 * Replay-parity guard (read-only): replays the LIVE snapshot store through the
 * backtest engine and diffs the result against the actual ValueOpportunity
 * rows. If the engine and production disagree on the same data under the same
 * config, every backtest conclusion is suspect.
 *
 * The live store's batches ARE production's polls, so full-resolution mode over
 * them reproduces production cadence exactly. Differences are classified:
 *  - exchange rows created before exchange exclusion shipped (explained)
 *  - rows from detector configs that predate the current one (explained)
 *  - in-play batches (the engine refuses them; live had no explicit guard)
 *  - anything else → UNEXPLAINED: the engine is lying about production.
 *
 * Run: npx tsx --env-file=.env scripts/backtest/parity-check.ts [sinceISO]
 */
import { PrismaClient } from '@prisma/client';
import { PRODUCTION_DETECTOR_CONFIG, isExchange } from '../../src/value-detection';
import type { BacktestRunConfig, ReplaySnapshotRow } from '../../src/backtest';
import { replaySnapshots } from '../../src/backtest';

const prisma = new PrismaClient();

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  return (v as { toNumber(): number }).toNumber();
}

async function main(): Promise<void> {
  // Default since: the V2 baseline (current model era).
  const since = new Date(process.argv[2] ?? '2026-06-10T20:00:00Z');
  console.log(`Parity window: snapshots and opportunities since ${since.toISOString()}\n`);

  const snapshots = await prisma.oddsSnapshot.findMany({
    where: { market: 'H2H', isLive: false, capturedAt: { gte: since } },
    select: {
      matchId: true,
      bookmaker: true,
      outcome: true,
      price: true,
      capturedAt: true,
      match: { select: { startTime: true, sport: { select: { slug: true } } } },
    },
  });
  if (snapshots.length === 0) { console.log('No live snapshots in window.'); return; }

  const rows: ReplaySnapshotRow[] = snapshots.map(s => ({
    eventId: s.matchId,
    sportKey: s.match.sport.slug,
    bookmaker: s.bookmaker,
    outcome: s.outcome,
    price: toNum(s.price),
    snapshotAt: s.capturedAt,
    commenceTime: s.match.startTime,
  }));

  const minT = rows.reduce((m, r) => Math.min(m, r.snapshotAt.getTime()), Infinity);
  const maxT = rows.reduce((m, r) => Math.max(m, r.snapshotAt.getTime()), -Infinity);
  const config: BacktestRunConfig = {
    name: 'parity-check',
    sportKeys: [...new Set(rows.map(r => r.sportKey))],
    periodStart: new Date(minT).toISOString(),
    periodEnd: new Date(maxT).toISOString(),
    cadenceMode: 'full-resolution', // live batches ARE the polls
    liveCadenceDefaultMinutes: 60,
    detector: { ...PRODUCTION_DETECTOR_CONFIG, maxCandidateOdds: parseFloat(process.env.MAX_ALERT_ODDS ?? '3.0') },
  };

  const result = replaySnapshots(rows, config);
  const replayKeys = new Map(
    result.detections.map(d => [`${d.eventId}|${d.bookmaker}|${d.outcome}|${d.isShadow ? 'S' : 'P'}`, d]),
  );

  const liveRows = await prisma.valueOpportunity.findMany({
    where: { createdAt: { gte: since } },
    select: { matchId: true, bookmaker: true, outcome: true, isShadow: true, edgePercentage: true, createdAt: true },
  });
  const liveKeys = new Map(
    liveRows.map(r => [`${r.matchId}|${r.bookmaker}|${r.outcome}|${r.isShadow ? 'S' : 'P'}`, r]),
  );

  let matched = 0;
  const missingInReplay: string[] = [];
  const extraInReplay: string[] = [];
  for (const key of liveKeys.keys()) {
    if (replayKeys.has(key)) matched++;
    else missingInReplay.push(key);
  }
  for (const key of replayKeys.keys()) {
    if (!liveKeys.has(key)) extraInReplay.push(key);
  }

  console.log(`replay: ${result.detections.length} detections | live: ${liveRows.length} rows | matched: ${matched}`);
  console.log(`cursors: ${result.cursorsEvaluated} | in-play skipped: ${result.inPlaySkipped}\n`);

  let unexplained = 0;
  if (missingInReplay.length > 0) {
    console.log('LIVE rows not reproduced by replay:');
    for (const key of missingInReplay) {
      const bookmaker = key.split('|')[1];
      const reason = isExchange(bookmaker)
        ? 'explained: exchange row created before candidacy exclusion shipped'
        : 'check: possibly pre-current-config era or in-play batch (engine refuses post-kickoff)';
      if (!isExchange(bookmaker)) unexplained++;
      console.log(`  ${key}  [${reason}]`);
    }
  }
  if (extraInReplay.length > 0) {
    console.log('REPLAY detections without a live row:');
    for (const key of extraInReplay) {
      console.log(`  ${key}  [check: live dedup state predating window, or live downtime at that batch]`);
      unexplained++;
    }
  }

  console.log(`\nverdict: ${unexplained === 0 ? 'PARITY OK (all differences explained)' : `${unexplained} difference(s) need investigation`}`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
