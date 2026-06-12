/**
 * Legacy-family confidence grading (A/B/C) — ranking and reporting ONLY.
 * Never suppresses or reorders alerts; it annotates them.
 *
 * Signals (all already computed — zero new API calls), weights from the legacy
 * backtest evidence (LEGACY_VS_PINNACLE_MODEL_AUDIT.md):
 *  - Bookmaker agreement: a consensus of >= 10 books is a broader information
 *    base than the 2-book minimum.
 *  - Movement: steam-out (Pinnacle price drifting OUT >= +1% over 6h) was
 *    legacy's best settled class (+33.5% ROI, n=21).
 *  - Edge strength: >= 8% edges are the deepest disagreements with consensus.
 *
 * Grade: 2–3 signals → A, 1 → B, 0 → C.
 */

export type LegacyConfidence = 'A' | 'B' | 'C';

export interface LegacyConfidenceInput {
  readonly consensusCount: number;
  readonly move6hPct: number | null;
  readonly edgePct: number;
}

export function legacyConfidence(input: LegacyConfidenceInput): LegacyConfidence {
  let score = 0;
  if (input.consensusCount >= 10) score++;
  if (input.move6hPct !== null && input.move6hPct >= 1.0) score++;
  if (input.edgePct >= 8.0) score++;
  if (score >= 2) return 'A';
  if (score === 1) return 'B';
  return 'C';
}
