/**
 * LOW ODDS SYSTEM configuration — evidence-based per-bucket thresholds.
 *
 * Source of every number: the odds-bucket validation over the historical
 * backtest dataset (docs/audits/LOW_ODDS_SYSTEM_IMPLEMENTATION.md §2):
 *  - Pinnacle-led 2.0–3.0% edges (junk overall) are CLV-positive in every
 *    low-odds bucket; 1.50–1.80 is the strongest (+58% ROI even at 2.0–2.5%).
 *  - Legacy 3.0–5.0% edges at 1.50–2.20 measured 9W–0L / 8W–2L (+58–64% ROI);
 *    at 1.30–1.50 they measured −43% ROI → that bucket is DISABLED (abort
 *    condition), not enabled "for volume".
 *
 * The low-odds tracks own only the edge ranges BELOW the main systems'
 * thresholds (< 3% pinnacle-led, < 5% legacy), so by construction they never
 * change main-system behavior or volume.
 */

export const LOW_ODDS_MIN = 1.10;
export const LOW_ODDS_MAX = 2.20; // exclusive

export function isLowOdds(odds: number): boolean {
  return odds >= LOW_ODDS_MIN && odds < LOW_ODDS_MAX;
}

/**
 * Minimum edge for the LOW_ODDS_PINNACLE_LED track (candidates below the main
 * 3% production threshold). Returns null when the bucket is disabled.
 */
export function pinnacleLedLowOddsThresholdPct(odds: number): number | null {
  if (!isLowOdds(odds)) return null;
  if (odds < 1.30) return 2.0; // sparse; positive evidence (n=1), CLV ~0
  if (odds < 1.50) return 2.5; // no settled evidence — conservative floor
  if (odds < 1.80) return 2.0; // strongest bucket: +58% ROI at 2.0–2.5%, CLV +8.0
  return 2.5;                  // 1.80–2.20: CLV positive; 2.0–2.5 unsettled → 2.5 floor
}

/**
 * Minimum edge for the LOW_ODDS_LEGACY track (below the main legacy 5%).
 * Returns null when the bucket is disabled by the abort condition.
 */
export function legacyLowOddsThresholdPct(odds: number): number | null {
  if (!isLowOdds(odds)) return null;
  if (odds < 1.30) return 3.0; // +27% ROI (n=1) — sparse, enabled conservatively
  if (odds < 1.50) return null; // ABORTED: measured −43% ROI (2W–3L) at 3–5%
  return 3.0;                  // 1.50–2.20: 17W–2L combined, +58–64% ROI
}
