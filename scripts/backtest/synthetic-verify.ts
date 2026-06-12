/* eslint-disable no-console */
/**
 * Synthetic verification of the replay engine — fully in-memory, no DB, no API.
 * Asserts the properties the design demands:
 *   1. determinism (same input → byte-identical output)
 *   2. run-scoped tier-aware dedup incl. shadow→production progression
 *   3. movement computed only from prior cursors (look-ahead guard)
 *   4. in-play guard (no detection at/after commence time)
 *   5. exchange exclusion respected inside the shared detector core
 *   6. live-cadence sampling reduces cursors as a production poller would
 *   7. movement filter semantics
 *   8. warm-up rows feed movement history but never produce detections
 *
 * Run: npx tsx scripts/backtest/synthetic-verify.ts
 */
import { PRODUCTION_DETECTOR_CONFIG } from '../../src/value-detection';
import type { BacktestRunConfig, ReplaySnapshotRow } from '../../src/backtest';
import { replaySnapshots } from '../../src/backtest';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const COMMENCE = new Date('2025-01-01T12:00:00Z');
function row(timeIso: string, bookmaker: string, outcome: string, price: number): ReplaySnapshotRow {
  return {
    eventId: 'E1',
    sportKey: 'soccer_test',
    bookmaker,
    outcome,
    price,
    snapshotAt: new Date(timeIso),
    commenceTime: COMMENCE,
  };
}

// Pinnacle 2.00/2.00 until 07:00; steams to 1.90/2.10 (toward Home) at 08:00.
// bookX Home 2.10 (5% → 10.25% edge), bookY Home 2.05 (2.5% shadow → 7.6% production),
// betfair_ex_uk Home 2.50 (excluded), bookX Away 3.40 (odds-filtered), bookY Away 1.70 (rejected).
const T = ['2025-01-01T06:00:00Z', '2025-01-01T07:00:00Z', '2025-01-01T08:00:00Z', '2025-01-01T11:30:00Z', '2025-01-01T12:30:00Z'];
const rows: ReplaySnapshotRow[] = [];
for (const [i, t] of T.entries()) {
  const pinnacleHome = i < 2 ? 2.0 : 1.9;
  const pinnacleAway = i < 2 ? 2.0 : 2.1;
  rows.push(
    row(t, 'pinnacle', 'Home', pinnacleHome),
    row(t, 'pinnacle', 'Away', pinnacleAway),
    row(t, 'bookX', 'Home', 2.10),
    row(t, 'bookX', 'Away', 3.40),
    row(t, 'bookY', 'Home', 2.05),
    row(t, 'bookY', 'Away', 1.70),
    row(t, 'betfair_ex_uk', 'Home', 2.50),
    row(t, 'betfair_ex_uk', 'Away', 2.50),
  );
}

const baseConfig: BacktestRunConfig = {
  name: 'synthetic',
  sportKeys: ['soccer_test'],
  periodStart: '2025-01-01T00:00:00Z',
  periodEnd: '2025-01-01T23:59:00Z',
  cadenceMode: 'full-resolution',
  liveCadenceDefaultMinutes: 60,
  detector: PRODUCTION_DETECTOR_CONFIG,
};

// ── 1. Determinism ──
const runA = replaySnapshots(rows, baseConfig);
const shuffled = [...rows].reverse();
const runB = replaySnapshots(shuffled, baseConfig);
check('determinism: identical output across runs (incl. shuffled input)', JSON.stringify(runA) === JSON.stringify(runB));

// ── 2. Dedup + shadow→production progression ──
const detections = runA.detections;
const bookX = detections.filter(d => d.bookmaker === 'bookX');
const bookY = detections.filter(d => d.bookmaker === 'bookY');
check('dedup: bookX detected exactly once (production)', bookX.length === 1 && !bookX[0].isShadow);
check('progression: bookY shadow at 06:00 then production at 08:00',
  bookY.length === 2 && bookY[0].isShadow && !bookY[1].isShadow
  && bookY[0].detectedAt.toISOString() === '2025-01-01T06:00:00.000Z'
  && bookY[1].detectedAt.toISOString() === '2025-01-01T08:00:00.000Z');
check('dedup suppression counted', runA.dedupSuppressed === 5, `got ${runA.dedupSuppressed}`);

// ── 3. Look-ahead guard: movement strictly from prior cursors ──
check('movement: null at the first cursor (no history can exist)',
  bookX[0].pinnacleMove1h === null && bookY[0].pinnacleMove1h === null);
const move = bookY[1].pinnacleMove1h;
check('movement: −5% at 08:00 from the 07:00 reference price only',
  move !== null && Math.abs(move - (-5)) < 1e-9, `got ${move}`);

// ── 4. In-play guard ──
check('in-play: post-kickoff cursor skipped, no detections at/after commence',
  runA.inPlaySkipped === 1 && detections.every(d => d.detectedAt < COMMENCE));

// ── 5. Exchange exclusion inside the shared core ──
check('exchange: no betfair_ex_uk detections; EXCHANGE_EXCLUDED decisions logged',
  detections.every(d => d.bookmaker !== 'betfair_ex_uk') && (runA.decisionCounts['EXCHANGE_EXCLUDED'] ?? 0) > 0);
check('odds filter + rejection decisions tallied (survivorship denominators)',
  (runA.decisionCounts['ODDS_FILTERED'] ?? 0) > 0 && (runA.decisionCounts['REJECTED'] ?? 0) > 0);

// ── 6. Cadence sampler ──
const liveCadence = replaySnapshots(rows, { ...baseConfig, cadenceMode: 'live-cadence', liveCadenceDefaultMinutes: 120 });
check('live-cadence: 120-min poller sees 3 of 5 cursors', liveCadence.cursorsEvaluated === 3, `got ${liveCadence.cursorsEvaluated}`);
check('full-resolution sees every cursor', runA.cursorsEvaluated === 5, `got ${runA.cursorsEvaluated}`);

// ── 7. Movement filter ──
const filtered = replaySnapshots(rows, {
  ...baseConfig,
  movementFilter: { window: '1h', maxMovePct: -1, dropNullMovement: true },
});
check('movement filter: only steam-in detections survive (2 at 08:00)',
  filtered.detections.length === 2
  && filtered.detections.every(d => d.detectedAt.toISOString() === '2025-01-01T08:00:00.000Z'),
  `got ${filtered.detections.length}`);
check('movement filter: drops counted', filtered.movementFiltered === 4, `got ${filtered.movementFiltered}`);

// ── 8. Warm-up window ──
const warm = replaySnapshots(rows, { ...baseConfig, periodStart: '2025-01-01T07:30:00Z' });
check('warm-up: no detections before period start',
  warm.detections.every(d => d.detectedAt.getTime() >= Date.parse('2025-01-01T07:30:00Z')));
check('warm-up: pre-period cursors still feed movement history',
  warm.detections.length === 2 && warm.detections.every(d => d.pinnacleMove1h !== null && Math.abs(d.pinnacleMove1h - (-5)) < 1e-9));

// ── Feature columns ──
check('features: corroboration k=2 and price gap computed on the first detection',
  bookX[0].corroborationK === 2 && bookX[0].priceGapPct !== null && Math.abs(bookX[0].priceGapPct - (2.10 / 2.05 - 1) * 100) < 1e-9);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
