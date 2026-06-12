/**
 * Pure detector core — the Pinnacle-led detection math, extracted so that live
 * detection and the historical replay engine run the IDENTICAL code path.
 * See docs/audits/HISTORICAL_BACKTESTING_ENGINE_DESIGN.md §1 (the prerequisite).
 *
 * detectFromBatch() is a pure function: one match's snapshot batch in,
 * classified candidates + decision records out. It owns:
 *   - input validation (empty outcomes, non-positive prices)
 *   - reference-book assembly, duplicate-price conflict detection
 *   - de-vigging with overround sanity bounds
 *   - exchange exclusion (config-controlled)
 *   - market-structure guard (outcome-set match with the reference book)
 *   - odds cap, edge formula, edge cap, production/shadow tier classification
 *
 * It does NOT own anything stateful: permanent dedup (DB- or run-scoped),
 * movement annotation (needs prior batches), persistence, and alerting stay
 * with the caller. DETECTED / DETECTED_SHADOW / SUPPRESSED decisions are
 * therefore emitted by the caller after dedup, not by the core.
 */
import type { ValueDetectionDecision } from './value-detection.types';
import { isExchange } from './idea-aggregation';

/** One snapshot row of a single match's batch, prices already numeric. */
export interface DetectorInputRow {
  readonly bookmaker: string;
  readonly outcome: string;
  readonly price: number;
}

export interface DetectorConfig {
  /** The sharp reference book providing fair probabilities — never a candidate. */
  readonly referenceBookmaker: string;
  /** Absolute lower bound — below this a candidate is REJECTED. */
  readonly shadowEdgeThresholdPct: number;
  /** Edge >= this → production tier; shadow tier otherwise. */
  readonly productionEdgeThresholdPct: number;
  /** Edges above this are treated as data-quality anomalies. */
  readonly maxEdgeThresholdPct: number;
  /** Candidate prices above this are filtered (longshot volatility). */
  readonly maxCandidateOdds: number;
  /** Reference overround sanity bounds (incomplete vs corrupt market). */
  readonly minReferenceOverround: number;
  readonly maxReferenceOverround: number;
  /** When true, exchange bookmakers are excluded at candidacy. */
  readonly excludeExchanges: boolean;
}

/**
 * The live production configuration. The detection service uses this verbatim
 * (with maxCandidateOdds injected from app config); replay runs use it as the
 * baseline arm so backtests describe the model actually in production.
 */
export const PRODUCTION_DETECTOR_CONFIG: DetectorConfig = {
  referenceBookmaker: 'pinnacle',
  shadowEdgeThresholdPct: 2.0,
  productionEdgeThresholdPct: 3.0,
  maxEdgeThresholdPct: 100,
  maxCandidateOdds: 3.0,
  minReferenceOverround: 0.99,
  maxReferenceOverround: 1.15,
  excludeExchanges: true,
};

/** A classified candidate that passed every guard; dedup is the caller's job. */
export interface DetectorCandidate {
  readonly bookmaker: string;
  readonly outcome: string;
  readonly bookmakerOdds: number;
  readonly fairOdds: number;
  readonly fairProbability: number;
  readonly edgePercentage: number;
  readonly isShadow: boolean;
}

export interface DetectorDecision {
  readonly decision: ValueDetectionDecision;
  readonly context: Record<string, unknown>;
}

export interface DetectFromBatchResult {
  readonly candidates: readonly DetectorCandidate[];
  /** Non-candidate decisions (REJECTED / INVALID_DATA / guards) for audit-trail logging. */
  readonly decisions: readonly DetectorDecision[];
  /** Reference overround when a valid reference market existed, else null. */
  readonly referenceOverround: number | null;
  /** Raw reference prices per outcome (post-validation), else null. */
  readonly referencePrices: ReadonlyMap<string, number> | null;
}

/**
 * Runs the full detection math over one match's snapshot batch.
 * Deterministic: output depends only on (batch, config); iteration follows
 * input order (first occurrence of a bookmaker/outcome wins, as in live).
 */
export function detectFromBatch(
  batch: readonly DetectorInputRow[],
  config: DetectorConfig,
): DetectFromBatchResult {
  const decisions: DetectorDecision[] = [];
  const candidates: DetectorCandidate[] = [];

  // Group by bookmaker → outcome → price. First occurrence wins; a conflicting
  // duplicate price for the reference book invalidates the whole match batch
  // (duplicated reference rows were the root cause of historic edge corruption).
  const byBookmaker = new Map<string, Map<string, number>>();
  let referenceConflict = false;

  for (const row of batch) {
    if (!row.outcome || row.outcome.trim() === '') {
      decisions.push({ decision: 'INVALID_DATA', context: { bookmaker: row.bookmaker, reason: 'empty outcome' } });
      continue;
    }
    if (!(row.price > 1)) {
      decisions.push({
        decision: 'INVALID_DATA',
        context: { bookmaker: row.bookmaker, outcome: row.outcome, reason: 'odds <= 1', price: row.price },
      });
      continue;
    }
    let outcomes = byBookmaker.get(row.bookmaker);
    if (!outcomes) { outcomes = new Map(); byBookmaker.set(row.bookmaker, outcomes); }
    const prior = outcomes.get(row.outcome);
    if (prior !== undefined) {
      if (row.bookmaker === config.referenceBookmaker && Math.abs(prior - row.price) > 1e-9) {
        referenceConflict = true;
      }
      continue;
    }
    outcomes.set(row.outcome, row.price);
  }

  const reference = byBookmaker.get(config.referenceBookmaker);
  if (!reference || reference.size < 2) {
    decisions.push({
      decision: 'INSUFFICIENT_MARKET_DATA',
      context: { reason: 'no complete reference market', referenceOutcomes: reference?.size ?? 0 },
    });
    return { candidates, decisions, referenceOverround: null, referencePrices: null };
  }
  if (referenceConflict) {
    decisions.push({
      decision: 'INVALID_DATA',
      context: { reason: 'conflicting duplicate reference prices in batch' },
    });
    return { candidates, decisions, referenceOverround: null, referencePrices: null };
  }

  // De-vig the reference market: normalise implied probabilities to sum to 1.
  let overround = 0;
  for (const odds of reference.values()) overround += 1 / odds;

  if (overround < config.minReferenceOverround || overround > config.maxReferenceOverround) {
    decisions.push({
      decision: 'INVALID_DATA',
      context: {
        reason: 'reference overround out of bounds — incomplete or anomalous reference market',
        overround: overround.toFixed(4),
      },
    });
    return { candidates, decisions, referenceOverround: null, referencePrices: null };
  }

  const fairProbByOutcome = new Map<string, number>();
  for (const [outcome, odds] of reference) {
    fairProbByOutcome.set(outcome, (1 / odds) / overround);
  }

  // Evaluate every non-reference bookmaker independently, per outcome.
  for (const [bookmaker, outcomes] of byBookmaker) {
    if (bookmaker === config.referenceBookmaker) continue;

    // Exchange exclusion: exchanges quote pre-commission back prices whose
    // nominal edge vs the de-vigged reference is overstated by the 2–5% commission.
    if (config.excludeExchanges && isExchange(bookmaker)) {
      decisions.push({ decision: 'EXCHANGE_EXCLUDED', context: { bookmaker } });
      continue;
    }

    // Market-structure guard: the candidate must quote the same outcome set as
    // the reference book. Some books quote a structurally different H2H market
    // (e.g. 3-way regulation time vs Pinnacle's 2-way incl. overtime in NHL);
    // their prices are not comparable and produce large phantom edges.
    if (outcomes.size !== reference.size) {
      decisions.push({
        decision: 'INSUFFICIENT_MARKET_DATA',
        context: {
          bookmaker,
          reason: 'market structure mismatch with reference book',
          candidateOutcomes: outcomes.size,
          referenceOutcomes: reference.size,
        },
      });
      continue;
    }

    for (const [outcome, candidateOdds] of outcomes) {
      const fairProb = fairProbByOutcome.get(outcome);
      if (fairProb === undefined) {
        decisions.push({
          decision: 'INSUFFICIENT_MARKET_DATA',
          context: { bookmaker, outcome, reason: 'outcome not quoted by reference book' },
        });
        continue;
      }

      // Odds filter: longshots produce volatile, less reliable edges in thin markets.
      if (candidateOdds > config.maxCandidateOdds) {
        decisions.push({
          decision: 'ODDS_FILTERED',
          context: { bookmaker, outcome, candidateOdds, maxAllowedOdds: config.maxCandidateOdds },
        });
        continue;
      }

      const fairOdds = 1 / fairProb;
      const edgePercentage = (candidateOdds * fairProb - 1) * 100;

      if (edgePercentage < config.shadowEdgeThresholdPct) {
        decisions.push({
          decision: 'REJECTED',
          context: { bookmaker, outcome, edgePct: edgePercentage.toFixed(2) },
        });
        continue;
      }

      if (edgePercentage > config.maxEdgeThresholdPct) {
        decisions.push({
          decision: 'INVALID_DATA',
          context: {
            bookmaker, outcome,
            reason: 'edge exceeds maximum threshold — likely a data quality anomaly',
            edgePct: edgePercentage.toFixed(2),
            maxAllowed: config.maxEdgeThresholdPct,
            candidateOdds,
            fairOdds: fairOdds.toFixed(4),
          },
        });
        continue;
      }

      candidates.push({
        bookmaker,
        outcome,
        bookmakerOdds: candidateOdds,
        fairOdds,
        fairProbability: fairProb,
        edgePercentage,
        isShadow: edgePercentage < config.productionEdgeThresholdPct,
      });
    }
  }

  return { candidates, decisions, referenceOverround: overround, referencePrices: reference };
}

/** A single historical reference-book price point, used for movement annotation. */
export interface PricePoint {
  readonly capturedAt: Date;
  readonly price: number;
}

/**
 * Reference-book price movement % over a trailing window, for movement annotation.
 *
 * movement = (latestPrice / oldest price in window − 1) × 100, where the window is
 * [latestCapturedAt − windowHours, latestCapturedAt). The latest batch itself is
 * excluded — movement needs an earlier observation. Returns null when no earlier
 * snapshot exists in the window (insufficient history).
 *
 * Sign convention: negative = price shortened (market moved TOWARD the outcome);
 * positive = price drifted out (market moved away). Analytics only.
 */
export function referenceMovementPct(
  history: readonly PricePoint[] | undefined,
  latestPrice: number,
  latestCapturedAt: Date,
  windowHours: number,
): number | null {
  if (!history || history.length === 0) return null;
  const latestMs = latestCapturedAt.getTime();
  const windowStartMs = latestMs - windowHours * 60 * 60 * 1000;

  let oldest: PricePoint | undefined;
  for (const point of history) {
    const t = point.capturedAt.getTime();
    if (t < windowStartMs || t >= latestMs) continue;
    if (!oldest || t < oldest.capturedAt.getTime()) oldest = point;
  }
  if (!oldest) return null;
  return (latestPrice / oldest.price - 1) * 100;
}
