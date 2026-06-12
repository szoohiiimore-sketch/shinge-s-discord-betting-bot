/**
 * Replay engine — chronological cursor over historical snapshots, running the
 * SAME pure detector core as production (`detectFromBatch`).
 *
 * Bias prevention, by construction:
 *  - Look-ahead: at cursor t the detector sees only rows with snapshotAt === t,
 *    and movement annotation sees only reference rows from PREVIOUSLY PROCESSED
 *    cursors (< t, and only those visible under the cadence mode — mirroring
 *    what production would have had in memory).
 *  - In-play leakage: any (event, cursor) batch with cursor >= commenceTime is
 *    skipped (production polls pre-match only; commence-time shifts otherwise
 *    leak live prices into "pre-match" detections).
 *  - Survivorship: every decision is tallied; matches that never produce a
 *    candidate stay in the denominator via decisionCounts/batchesDetected.
 *  - Closing data: never read here — the scoring layer runs after replay.
 *
 * Determinism: rows are sorted with a total order before iteration; all logic
 * is pure functions of (rows, config). Same input → byte-identical output.
 */
import type { DetectorInputRow, PricePoint } from '@/value-detection/detector-core';
import { detectFromBatch, referenceMovementPct } from '@/value-detection/detector-core';
import { bookmakerFamily, isExchange } from '@/value-detection/idea-aggregation';
import type { BacktestRunConfig, MovementFilterConfig, ReplayDetection, ReplayResult, ReplaySnapshotRow } from './types';
import { legacyDetectFromBatch, LEGACY_DETECTOR_CONFIG } from '@/value-detection/legacy-detector-core';

function movementForWindow(
  filter: MovementFilterConfig,
  move1h: number | null,
  move6h: number | null,
  move24h: number | null,
): number | null {
  if (filter.window === '1h') return move1h;
  if (filter.window === '6h') return move6h;
  return move24h;
}

function passesMovementFilter(filter: MovementFilterConfig | undefined, movement: number | null): boolean {
  if (!filter) return true;
  if (movement === null) return !filter.dropNullMovement;
  if (filter.minMovePct !== undefined && movement < filter.minMovePct) return false;
  if (filter.maxMovePct !== undefined && movement > filter.maxMovePct) return false;
  return true;
}

/**
 * Replays a set of historical snapshot rows under a frozen run config.
 * Pure apart from Date arithmetic — no I/O; callers load rows and persist results.
 */
export function replaySnapshots(rows: readonly ReplaySnapshotRow[], config: BacktestRunConfig): ReplayResult {
  // Total order for determinism: time, sport, event, bookmaker, outcome.
  const sorted = [...rows].sort((a, b) =>
    a.snapshotAt.getTime() - b.snapshotAt.getTime()
    || a.sportKey.localeCompare(b.sportKey)
    || a.eventId.localeCompare(b.eventId)
    || a.bookmaker.localeCompare(b.bookmaker)
    || a.outcome.localeCompare(b.outcome));

  // Distinct cursor timestamps per sport (historical snapshots are sport-level).
  const timestampsBySport = new Map<string, number[]>();
  const rowsBySportTime = new Map<string, ReplaySnapshotRow[]>();
  for (const row of sorted) {
    const t = row.snapshotAt.getTime();
    let times = timestampsBySport.get(row.sportKey);
    if (!times) { times = []; timestampsBySport.set(row.sportKey, times); }
    if (times.length === 0 || times[times.length - 1] !== t) times.push(t);
    const key = `${row.sportKey}|${t}`;
    let bucket = rowsBySportTime.get(key);
    if (!bucket) { bucket = []; rowsBySportTime.set(key, bucket); }
    bucket.push(row);
  }

  // Cadence sampler: live-cadence emits a cursor only when the per-sport poll
  // interval has elapsed since the previously emitted cursor — simulating the
  // production poller's behaviour over the 5-minute historical grid.
  const sampledCursors: Array<{ sportKey: string; t: number }> = [];
  for (const [sportKey, times] of [...timestampsBySport.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (config.cadenceMode === 'full-resolution') {
      for (const t of times) sampledCursors.push({ sportKey, t });
      continue;
    }
    const intervalMs =
      (config.liveCadenceMinutesBySport?.[sportKey] ?? config.liveCadenceDefaultMinutes) * 60_000;
    let lastEmitted = -Infinity;
    for (const t of times) {
      if (t - lastEmitted >= intervalMs) {
        sampledCursors.push({ sportKey, t });
        lastEmitted = t;
      }
    }
  }
  sampledCursors.sort((a, b) => a.t - b.t || a.sportKey.localeCompare(b.sportKey));

  // Reference price history per (event, outcome), appended as cursors are
  // PROCESSED — so movement reflects exactly what the cadence mode has seen.
  const referenceHistory = new Map<string, PricePoint[]>();
  // Run-scoped tier-aware permanent dedup (mirrors live semantics: a shadow row
  // does not block a later production row for the same triple).
  const productionKeys = new Set<string>();
  const shadowKeys = new Set<string>();
  // Legacy model dedup: 12h suppression window per (event, outcome), keyed on
  // detection time (legacy alerted every detection — alert time ≈ detection time).
  const isLegacy = config.model === 'legacy';
  const legacyConfig = config.legacy ?? LEGACY_DETECTOR_CONFIG;
  const legacyLastDetectedAt = new Map<string, number>();

  const detections: ReplayDetection[] = [];
  const decisionCounts: Record<string, number> = {};
  let batchesDetected = 0;
  let movementFiltered = 0;
  let dedupSuppressed = 0;
  let inPlaySkipped = 0;

  const periodStartMs = Date.parse(config.periodStart);

  for (const { sportKey, t } of sampledCursors) {
    const cursorRows = rowsBySportTime.get(`${sportKey}|${t}`)!;
    const cursorDate = new Date(t);

    // Warm-up cursors (loaded so early-period movement windows have history):
    // feed the reference history only — never detect before the run period.
    if (t < periodStartMs) {
      for (const r of cursorRows) {
        if (r.bookmaker !== config.detector.referenceBookmaker) continue;
        if (!(r.price > 1)) continue;
        const histKey = `${r.eventId}|${r.outcome}`;
        let points = referenceHistory.get(histKey);
        if (!points) { points = []; referenceHistory.set(histKey, points); }
        points.push({ capturedAt: cursorDate, price: r.price });
      }
      continue;
    }

    // Group cursor rows by event.
    const byEvent = new Map<string, ReplaySnapshotRow[]>();
    for (const row of cursorRows) {
      let arr = byEvent.get(row.eventId);
      if (!arr) { arr = []; byEvent.set(row.eventId, arr); }
      arr.push(row);
    }

    for (const [eventId, eventRows] of [...byEvent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const commenceTime = eventRows[0].commenceTime;

      // In-play guard: production only ever detects on pre-match snapshots.
      if (t >= commenceTime.getTime()) {
        inPlaySkipped++;
        continue;
      }

      const batch: DetectorInputRow[] = eventRows.map(r => ({
        bookmaker: r.bookmaker,
        outcome: r.outcome,
        price: r.price,
      }));
      const result = isLegacy
        ? legacyDetectFromBatch(batch, legacyConfig)
        : detectFromBatch(batch, config.detector);
      batchesDetected++;

      for (const d of result.decisions) {
        decisionCounts[d.decision] = (decisionCounts[d.decision] ?? 0) + 1;
      }

      // Corroboration k per outcome (distinct non-exchange families among this
      // batch's candidates) and second-best non-exchange price per outcome.
      const familiesByOutcome = new Map<string, Set<string>>();
      for (const c of result.candidates) {
        if (isExchange(c.bookmaker)) continue;
        let fams = familiesByOutcome.get(c.outcome);
        if (!fams) { fams = new Set(); familiesByOutcome.set(c.outcome, fams); }
        fams.add(bookmakerFamily(c.bookmaker));
      }
      const pricesByOutcome = new Map<string, number[]>();
      for (const r of eventRows) {
        if (r.bookmaker === config.detector.referenceBookmaker || isExchange(r.bookmaker)) continue;
        if (!(r.price > 1)) continue;
        let prices = pricesByOutcome.get(r.outcome);
        if (!prices) { prices = []; pricesByOutcome.set(r.outcome, prices); }
        prices.push(r.price);
      }

      for (const candidate of result.candidates) {
        const key = `${eventId}|${candidate.bookmaker}|${candidate.outcome}`;
        if (isLegacy) {
          // 12h suppression per (event, outcome) — the idea re-alerts after the window.
          const legacyKey = `${eventId}|${candidate.outcome}`;
          const last = legacyLastDetectedAt.get(legacyKey);
          if (last !== undefined && t - last < legacyConfig.suppressionWindowMs) {
            dedupSuppressed++;
            continue;
          }
        } else if (!candidate.isShadow) {
          if (productionKeys.has(key)) { dedupSuppressed++; continue; }
        } else {
          if (shadowKeys.has(key) || productionKeys.has(key)) { dedupSuppressed++; continue; }
        }

        const latestReferencePrice = result.referencePrices!.get(candidate.outcome)!;
        const history = referenceHistory.get(`${eventId}|${candidate.outcome}`);
        const move1h = referenceMovementPct(history, latestReferencePrice, cursorDate, 1);
        const move6h = referenceMovementPct(history, latestReferencePrice, cursorDate, 6);
        const move24h = referenceMovementPct(history, latestReferencePrice, cursorDate, 24);

        if (config.movementFilter
          && !passesMovementFilter(config.movementFilter, movementForWindow(config.movementFilter, move1h, move6h, move24h))) {
          movementFiltered++;
          continue;
        }

        // Dedup keys are claimed only by candidates that survive every filter.
        if (isLegacy) legacyLastDetectedAt.set(`${eventId}|${candidate.outcome}`, t);
        else if (!candidate.isShadow) productionKeys.add(key);
        else shadowKeys.add(key);

        const outcomePrices = pricesByOutcome.get(candidate.outcome) ?? [];
        const others = outcomePrices.filter(p => p !== candidate.bookmakerOdds);
        // If the candidate price appears multiple times, one duplicate is "another book".
        const duplicates = outcomePrices.length - others.length;
        const secondBest = duplicates > 1
          ? candidate.bookmakerOdds
          : others.length > 0 ? Math.max(...others) : null;

        detections.push({
          eventId,
          sportKey,
          bookmaker: candidate.bookmaker,
          outcome: candidate.outcome,
          bookmakerOdds: candidate.bookmakerOdds,
          fairOdds: candidate.fairOdds,
          edgePercentage: candidate.edgePercentage,
          consensusProbability: candidate.fairProbability,
          isShadow: candidate.isShadow,
          detectedAt: cursorDate,
          commenceTime,
          // Legacy model has no de-vig/overround concept — recorded as 0.
          referenceOverround: result.referenceOverround ?? 0,
          bookmakerFamily: bookmakerFamily(candidate.bookmaker),
          minutesToKickoff: Math.round((commenceTime.getTime() - t) / 60_000),
          pinnacleMove1h: move1h,
          pinnacleMove6h: move6h,
          pinnacleMove24h: move24h,
          priceGapPct: secondBest !== null ? (candidate.bookmakerOdds / secondBest - 1) * 100 : null,
          corroborationK: familiesByOutcome.get(candidate.outcome)?.size ?? 0,
        });
      }

      // Append this cursor's RAW reference rows to the visible history AFTER
      // detection (the current batch never feeds its own movement window).
      // Raw rows — not the validated reference map — to mirror live exactly:
      // production's movement history includes reference prices even from
      // batches the detector rejected (conflict / overround out of bounds).
      for (const r of eventRows) {
        if (r.bookmaker !== config.detector.referenceBookmaker) continue;
        if (!(r.price > 1)) continue;
        const histKey = `${eventId}|${r.outcome}`;
        let points = referenceHistory.get(histKey);
        if (!points) { points = []; referenceHistory.set(histKey, points); }
        points.push({ capturedAt: cursorDate, price: r.price });
      }
    }
  }

  return {
    detections,
    cursorsEvaluated: sampledCursors.length,
    batchesDetected,
    decisionCounts,
    movementFiltered,
    dedupSuppressed,
    inPlaySkipped,
  };
}
