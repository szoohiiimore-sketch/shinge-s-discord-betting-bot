/**
 * Alert confidence grading (A/B/C) — REALIZED-OUTCOME based, authoritative for
 * ALL models. Ranking/presentation only; never suppresses, reorders, or alters
 * detection. Replaces the retired legacy A/B/C grade (which was inverse, had a
 * constant signal, and an impossible C state).
 *
 * Design (see docs/audits/NEXT_GEN_CONFIDENCE_FRAMEWORK_AUDIT.md):
 * the grade = ABSENCE of the two alert traits that realized worst across the
 * live settled sample (n≈106). It is built ONLY from signals validated on
 * realized W/L — no CLV, no backtest weights, no edge/consensus signals (which
 * were proven non-predictive or inverse).
 *
 *  RED FLAG 1 — FLAT LINE: a measurable 6h Pinnacle move with |move| < 1.0%.
 *    Realized −46.6% ROI (CI [−83.8, −9.3], the only segment whose CI excludes
 *    zero). A flat sharp line is the strongest negative trait in the data; a
 *    NULL move (no 6h history) is NOT flagged (realized neutral-positive).
 *  RED FLAG 2 — EXTREME ODDS: odds < 1.80 or ≥ 3.00. The 1.80–3.00 mid-range
 *    realized better than both extremes (1.40–1.80 ≈ −30%, 3.00+ ≈ −10%).
 *
 * Grade: 0 flags → A · 1 flag → B · 2 flags → C. All three reachable.
 *
 * Honesty caveat baked into the docs, not the code: the flags were derived from
 * the same sample they were validated on (in-sample), and only the C grade
 * (both flags) separates robustly (−57% all-models, CI excludes 0). A vs B is
 * weak. This grade reliably flags BAD alerts; it does not certify GOOD ones.
 */

export type AlertConfidence = 'A' | 'B' | 'C';

export interface AlertConfidenceInput {
  /** The price the bet is placed at (Pinnacle for legacy, soft book for pinnacle-led). */
  readonly bookmakerOdds: number;
  /** 6h Pinnacle reference movement %, or null when no 6h history exists. */
  readonly move6hPct: number | null;
}

/** True when the 6h sharp line was measurably flat (|move| < 1%) — the worst realized trait. */
export function isFlatLine(move6hPct: number | null): boolean {
  return move6hPct !== null && Math.abs(move6hPct) < 1.0;
}

/** True when odds sit outside the realized-favourable 1.80–3.00 mid-range. */
export function isExtremeOdds(bookmakerOdds: number): boolean {
  return bookmakerOdds < 1.8 || bookmakerOdds >= 3.0;
}

/** Human-readable red flags, for alert presentation. Empty array = grade A. */
export function alertConfidenceFlags(input: AlertConfidenceInput): string[] {
  const flags: string[] = [];
  if (isFlatLine(input.move6hPct)) flags.push('flat line');
  if (isExtremeOdds(input.bookmakerOdds)) flags.push('extreme odds');
  return flags;
}

/** Authoritative confidence grade from realized-validated signals. */
export function alertConfidence(input: AlertConfidenceInput): AlertConfidence {
  const flags = alertConfidenceFlags(input).length;
  return flags === 0 ? 'A' : flags === 1 ? 'B' : 'C';
}
