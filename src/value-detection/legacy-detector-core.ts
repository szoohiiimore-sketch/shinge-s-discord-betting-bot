/**
 * LEGACY detector core — faithful pure reconstruction of the pre-Pinnacle-led
 * value model, for side-by-side backtesting ONLY. Never used by live code.
 *
 * Provenance (verified, not guessed): the legacy implementation is the
 * committed `src/value-detection/value-detection.service.ts` at HEAD
 * (f1563fa "Expand traditional sports and disable esports"; detection logic
 * last modified in bb625ca). The Pinnacle-led rewrite exists only in the
 * working tree. This file transcribes that committed logic into the engine's
 * pure-detector shape.
 *
 * Legacy semantics (transcribed 1:1):
 *  - Candidate book: PINNACLE ONLY — the model bets Pinnacle's own price.
 *  - "Fair" probability: arithmetic mean of the VIG-INFLATED implied
 *    probabilities of all non-Pinnacle books (no de-vigging; exchanges and
 *    structurally different markets included; minimum 2 consensus books).
 *  - edge% = (pinnacleOdds × consensusProb − 1) × 100; alert at >= 5%,
 *    reject > 100% as data anomaly; Pinnacle odds cap (maxAlertOdds).
 *  - No market-structure guard, no overround bounds, no reference-conflict
 *    check, no shadow tier, no exchange exclusion.
 *  - Dedup: 12-hour suppression per (match, outcome) keyed on alert time —
 *    the same idea re-alerts every 12 h while the edge persists. (Implemented
 *    by the replay engine, which owns dedup state.)
 *
 * Documented assumptions / uncertainties:
 *  - `pinnacleSnaps[0]` (first occurrence) is preserved; the replay engine
 *    feeds rows in a deterministic sorted order, whereas live order was DB
 *    return order — immaterial unless duplicate conflicting Pinnacle rows
 *    exist in a batch (the legacy code took the first, so do we).
 *  - Live suppression keyed on `alertedAt`; in legacy every detection was
 *    alerted, so replay approximates alert time with detection time.
 */
import type { DetectorInputRow, DetectFromBatchResult, DetectorCandidate, DetectorDecision } from '@/value-detection/detector-core';

export interface LegacyDetectorConfig {
  readonly candidateBookmaker: string;      // 'pinnacle'
  readonly minEdgeThresholdPct: number;     // 5.0
  readonly maxEdgeThresholdPct: number;     // 100
  readonly minConsensusBookmakers: number;  // 2
  readonly maxCandidateOdds: number;        // maxAlertOdds (3.0)
  /** 12 h in the original. Consumed by the replay engine's dedup policy. */
  readonly suppressionWindowMs: number;
}

export const LEGACY_DETECTOR_CONFIG: LegacyDetectorConfig = {
  candidateBookmaker: 'pinnacle',
  minEdgeThresholdPct: 5.0,
  maxEdgeThresholdPct: 100,
  minConsensusBookmakers: 2,
  maxCandidateOdds: 3.0,
  suppressionWindowMs: 12 * 60 * 60 * 1000,
};

/** Runs the legacy detection math over one match's snapshot batch. */
export function legacyDetectFromBatch(
  batch: readonly DetectorInputRow[],
  config: LegacyDetectorConfig,
): DetectFromBatchResult {
  const decisions: DetectorDecision[] = [];
  const candidates: DetectorCandidate[] = [];

  // Group by outcome (legacy grouped outcome-first, not bookmaker-first).
  const byOutcome = new Map<string, DetectorInputRow[]>();
  for (const row of batch) {
    if (!row.outcome || row.outcome.trim() === '') {
      decisions.push({ decision: 'INVALID_DATA', context: { bookmaker: row.bookmaker, reason: 'empty outcome' } });
      continue;
    }
    let arr = byOutcome.get(row.outcome);
    if (!arr) { arr = []; byOutcome.set(row.outcome, arr); }
    arr.push(row);
  }

  const referencePrices = new Map<string, number>();

  for (const [outcome, rows] of byOutcome) {
    const pinnacleSnaps = rows.filter(r => r.bookmaker === config.candidateBookmaker);
    const consensusSnaps = rows.filter(r => r.bookmaker !== config.candidateBookmaker);

    if (pinnacleSnaps.length === 0) {
      decisions.push({ decision: 'INVALID_DATA', context: { outcome, reason: 'no Pinnacle snapshot' } });
      continue;
    }
    if (consensusSnaps.length < config.minConsensusBookmakers) {
      decisions.push({
        decision: 'INSUFFICIENT_MARKET_DATA',
        context: { outcome, consensusCount: consensusSnaps.length, required: config.minConsensusBookmakers },
      });
      continue;
    }

    const pinnacleOdds = pinnacleSnaps[0].price;
    const consensusOdds = consensusSnaps.map(r => r.price);

    if (pinnacleOdds <= 1) {
      decisions.push({ decision: 'INVALID_DATA', context: { outcome, reason: 'pinnacle odds <= 1', pinnacleOdds } });
      continue;
    }
    if (consensusOdds.some(o => o <= 1)) {
      decisions.push({ decision: 'INVALID_DATA', context: { outcome, reason: 'consensus odds <= 1' } });
      continue;
    }

    const impliedProbs = consensusOdds.map(o => 1 / o);
    const consensusProbability = impliedProbs.reduce((a, b) => a + b, 0) / impliedProbs.length;
    if (consensusProbability <= 0 || consensusProbability >= 1) {
      decisions.push({ decision: 'INVALID_DATA', context: { outcome, reason: 'invalid consensus probability' } });
      continue;
    }

    const fairOdds = 1 / consensusProbability;
    referencePrices.set(outcome, pinnacleOdds);

    if (pinnacleOdds > config.maxCandidateOdds) {
      decisions.push({ decision: 'ODDS_FILTERED', context: { outcome, pinnacleOdds, maxAllowedOdds: config.maxCandidateOdds } });
      continue;
    }

    const edgePercentage = (pinnacleOdds / fairOdds - 1) * 100;

    if (edgePercentage < config.minEdgeThresholdPct) {
      decisions.push({ decision: 'REJECTED', context: { outcome, edgePct: edgePercentage.toFixed(2) } });
      continue;
    }
    if (edgePercentage > config.maxEdgeThresholdPct) {
      decisions.push({
        decision: 'INVALID_DATA',
        context: { outcome, reason: 'edge exceeds maximum threshold — likely consensus data anomaly', edgePct: edgePercentage.toFixed(2) },
      });
      continue;
    }

    candidates.push({
      bookmaker: config.candidateBookmaker,
      outcome,
      bookmakerOdds: pinnacleOdds,
      fairOdds,
      fairProbability: consensusProbability,
      edgePercentage,
      isShadow: false, // legacy had no shadow tier
    });
  }

  // Legacy had no de-vig/overround concept; expose the consensus-free shape.
  return { candidates, decisions, referenceOverround: null, referencePrices };
}
