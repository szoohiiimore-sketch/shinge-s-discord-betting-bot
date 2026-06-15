/**
 * SHARP_FINAL detector core — pure detection over a MULTI-SOURCE SHARP CONSENSUS
 * reference (not a single Pinnacle). Shared by live detection and the historical
 * replay, exactly like the other detector cores.
 *
 * Philosophy: reduce dependence on any single sharp source. The "fair" probability
 * is the de-vigged MEDIAN of a panel of sharp/exchange sources; a soft book that
 * beats that consensus by the edge threshold is the alert. This is the production
 * form of the C3 "Sharp-Consensus Panel" concept (NEXT_GENERATION_MODEL_RESEARCH_AUDIT.md),
 * addressing the single-Pinnacle-dependence flaw (HISTORICAL_REPLAY_VALIDATION_AUDIT M3).
 *
 *  - Sharp panel (live): pinnacle, betfair_ex_uk, betfair_ex_eu, matchbook, smarkets.
 *  - Consensus: per outcome, MEDIAN of the panel's implied probabilities (robust to
 *    one stale/odd source), requiring >= minSharpSources present.
 *  - De-vig: median raw probs normalised across outcomes (overround-bounded).
 *  - Candidate: any NON-sharp, NON-exchange book; bet the best soft price above fair.
 *  - Outlier handling: median (not mean) + overround sanity bounds.
 *  - Missing-book handling: require >= minSharpSources; with only one sharp present the
 *    match is skipped (it would merely re-derive a single-source reference).
 *
 * Exchange back prices are pre-commission (slightly low implied prob); this is left
 * un-adjusted, a deliberately CONSERVATIVE bias (raises fair odds → fewer/smaller edges).
 */
import type { DetectorInputRow, DetectFromBatchResult, DetectorCandidate, DetectorDecision } from './detector-core';
import { isExchange } from './idea-aggregation';

export interface SharpFinalConfig {
  /** The sharp/exchange panel forming the consensus reference (never candidates). */
  readonly sharpBookmakers: readonly string[];
  /** Minimum panel sources quoting an outcome to form a consensus. */
  readonly minSharpSources: number;
  readonly productionEdgeThresholdPct: number;
  readonly shadowEdgeThresholdPct: number;
  readonly maxEdgeThresholdPct: number;
  readonly maxCandidateOdds: number;
  readonly minConsensusOverround: number;
  readonly maxConsensusOverround: number;
}

/** Live sharp panel — the Tier-1 sources verified present in the subscription (Phase 0). */
export const SHARP_PANEL = ['pinnacle', 'betfair_ex_uk', 'betfair_ex_eu', 'matchbook', 'smarkets'] as const;

export const SHARP_FINAL_CONFIG: SharpFinalConfig = {
  sharpBookmakers: SHARP_PANEL,
  minSharpSources: 2,
  productionEdgeThresholdPct: 3.0, // same bar as Pinnacle-Led (no tuning advantage)
  shadowEdgeThresholdPct: 2.0,
  maxEdgeThresholdPct: 100,
  maxCandidateOdds: 3.0,
  minConsensusOverround: 0.99,
  maxConsensusOverround: 1.15,
};

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function sharpFinalDetectFromBatch(
  batch: readonly DetectorInputRow[],
  config: SharpFinalConfig,
): DetectFromBatchResult {
  const decisions: DetectorDecision[] = [];
  const candidates: DetectorCandidate[] = [];
  const sharpSet = new Set(config.sharpBookmakers);

  // Group bookmaker → outcome → price (first occurrence wins).
  const byBookmaker = new Map<string, Map<string, number>>();
  const pinnaclePrices = new Map<string, number>();
  for (const row of batch) {
    if (!row.outcome || row.outcome.trim() === '') { decisions.push({ decision: 'INVALID_DATA', context: { bookmaker: row.bookmaker, reason: 'empty outcome' } }); continue; }
    if (!(row.price > 1)) { decisions.push({ decision: 'INVALID_DATA', context: { bookmaker: row.bookmaker, outcome: row.outcome, reason: 'odds <= 1' } }); continue; }
    let m = byBookmaker.get(row.bookmaker);
    if (!m) { m = new Map(); byBookmaker.set(row.bookmaker, m); }
    if (!m.has(row.outcome)) m.set(row.outcome, row.price);
    if (row.bookmaker === 'pinnacle' && !pinnaclePrices.has(row.outcome)) pinnaclePrices.set(row.outcome, row.price);
  }

  // Per-outcome sharp consensus (median implied prob of the panel).
  const sharpProbsByOutcome = new Map<string, number[]>();
  for (const [book, outcomes] of byBookmaker) {
    if (!sharpSet.has(book)) continue;
    for (const [outcome, odds] of outcomes) {
      let arr = sharpProbsByOutcome.get(outcome);
      if (!arr) { arr = []; sharpProbsByOutcome.set(outcome, arr); }
      arr.push(1 / odds);
    }
  }
  const consensusRaw = new Map<string, number>();
  for (const [outcome, probs] of sharpProbsByOutcome) {
    if (probs.length < config.minSharpSources) {
      decisions.push({ decision: 'INSUFFICIENT_MARKET_DATA', context: { outcome, sources: probs.length, required: config.minSharpSources, reason: 'sharp panel too thin' } });
      continue;
    }
    consensusRaw.set(outcome, median(probs));
  }
  if (consensusRaw.size < 2) {
    decisions.push({ decision: 'INSUFFICIENT_MARKET_DATA', context: { reason: 'fewer than 2 outcomes with a sharp consensus', outcomes: consensusRaw.size } });
    return { candidates, decisions, referenceOverround: null, referencePrices: null };
  }

  let overround = 0;
  for (const p of consensusRaw.values()) overround += p;
  if (overround < config.minConsensusOverround || overround > config.maxConsensusOverround) {
    decisions.push({ decision: 'INVALID_DATA', context: { reason: 'sharp consensus overround out of bounds', overround: overround.toFixed(4) } });
    return { candidates, decisions, referenceOverround: null, referencePrices: null };
  }
  const fairProbByOutcome = new Map<string, number>();
  for (const [outcome, raw] of consensusRaw) fairProbByOutcome.set(outcome, raw / overround);

  const referencePrices = new Map<string, number>();
  for (const [outcome, raw] of consensusRaw) referencePrices.set(outcome, pinnaclePrices.get(outcome) ?? 1 / raw);

  // Candidates: soft books only (not in the sharp panel, not any exchange).
  for (const [bookmaker, outcomes] of byBookmaker) {
    if (sharpSet.has(bookmaker) || isExchange(bookmaker)) continue;
    if (outcomes.size !== consensusRaw.size) {
      decisions.push({ decision: 'INSUFFICIENT_MARKET_DATA', context: { bookmaker, reason: 'market structure mismatch with sharp consensus', candidateOutcomes: outcomes.size, consensusOutcomes: consensusRaw.size } });
      continue;
    }
    for (const [outcome, candidateOdds] of outcomes) {
      const fairProb = fairProbByOutcome.get(outcome);
      if (fairProb === undefined) continue;
      if (candidateOdds > config.maxCandidateOdds) { decisions.push({ decision: 'ODDS_FILTERED', context: { bookmaker, outcome, candidateOdds } }); continue; }
      const edgePercentage = (candidateOdds * fairProb - 1) * 100;
      if (edgePercentage < config.shadowEdgeThresholdPct) { decisions.push({ decision: 'REJECTED', context: { bookmaker, outcome, edgePct: edgePercentage.toFixed(2) } }); continue; }
      if (edgePercentage > config.maxEdgeThresholdPct) { decisions.push({ decision: 'INVALID_DATA', context: { bookmaker, outcome, reason: 'edge exceeds max', edgePct: edgePercentage.toFixed(2) } }); continue; }
      candidates.push({
        bookmaker, outcome, bookmakerOdds: candidateOdds,
        fairOdds: 1 / fairProb, fairProbability: fairProb, edgePercentage,
        isShadow: edgePercentage < config.productionEdgeThresholdPct,
      });
    }
  }
  return { candidates, decisions, referenceOverround: overround, referencePrices };
}
