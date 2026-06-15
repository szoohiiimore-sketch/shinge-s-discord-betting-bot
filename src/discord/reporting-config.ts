/**
 * ROI V2 baseline — the earliest settledAt timestamp included in all reporting queries.
 *
 * Opportunities settled before this point are excluded from /roi, /paper-bankroll,
 * /best-sports, the daily summary, and Discord Rich Presence. They remain in the
 * database and are unmodified; they are simply not counted toward V2 metrics.
 *
 * Rationale: pre-baseline data was affected by incomplete settlement coverage,
 * esports contamination, and esports consensus corruption. See ROI-V2-BASELINE-AND-PRESENCE-FIX.md.
 */
export const ROI_V2_BASELINE = new Date('2026-06-10T20:00:00.000Z');

/**
 * Live performance baseline — settlements before this instant are excluded
 * from every LIVE metric (/roi, /paper-bankroll, /best-sports, /clv, daily
 * summary, Rich Presence). Data is never deleted or modified; rows settled
 * earlier are simply not counted as "live".
 *
 * Configurable via LIVE_BASELINE_DATE (ISO 8601, e.g. 2026-06-12T18:00:00Z).
 * If unset or unparseable, behavior is unchanged (falls back to ROI_V2_BASELINE).
 * The effective baseline is never earlier than ROI_V2_BASELINE, which guards
 * against the pre-V2 contaminated data regardless of the env value.
 *
 * Historical (backtest seed) reporting is unaffected; Combined remains
 * Historical + Live(after this baseline). See LIVE_BASELINE_RESET_IMPLEMENTATION.md.
 */
function parseLiveBaseline(): Date {
  const raw = process.env.LIVE_BASELINE_DATE;
  if (!raw) return ROI_V2_BASELINE;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return ROI_V2_BASELINE;
  return parsed > ROI_V2_BASELINE ? parsed : ROI_V2_BASELINE;
}

export const LIVE_BASELINE = parseLiveBaseline();

/**
 * Track segmentation for reporting commands (4-track A/B).
 * 'combined' shows per-track sections; the others restrict to one track.
 */
export type ModelFilter = 'combined' | 'legacy' | 'pinnacle' | 'low-odds-legacy' | 'low-odds-pinnacle' | 'sharp' | 'sharp-low' | 'sharp-v2' | 'sharp-low-v2' | 'legacy-quality';

export type DetectionModelValue = 'LEGACY' | 'PINNACLE_LED' | 'LOW_ODDS_LEGACY' | 'LOW_ODDS_PINNACLE_LED' | 'SHARP_FINAL' | 'SHARP_FINAL_LOW' | 'SHARP_FINAL_V2' | 'SHARP_FINAL_LOW_V2' | 'LEGACY_QUALITY';

/**
 * Production alert routing — the single source of truth for which channel a model's
 * alerts go to, and which models are shadow-only (collect data + ROI, never alert).
 * Portfolio restructure (PORTFOLIO_RESTRUCTURE_AND_LEGACY_QUALITY_IMPLEMENTATION.md):
 *  - SHARP_FINAL_V2 → main #bet-alerts; SHARP_FINAL_LOW_V2 → #bet-alerts-lower-odds.
 *  - LEGACY_QUALITY (active) + LOW_ODDS_LEGACY (active).
 *  - SHADOW: PINNACLE_LED, LOW_ODDS_PINNACLE_LED, the redundant SHARP_FINAL/LOW v1
 *    (overlap V2 ~95%), and raw LEGACY (replaced by LEGACY_QUALITY).
 */
export type AlertRoute = 'main' | 'low-odds' | 'shadow';

export const MODEL_ROUTE: Record<DetectionModelValue, AlertRoute> = {
  SHARP_FINAL_V2: 'main',
  SHARP_FINAL_LOW_V2: 'low-odds',
  LEGACY_QUALITY: 'main',
  LOW_ODDS_LEGACY: 'low-odds',
  PINNACLE_LED: 'shadow',
  LOW_ODDS_PINNACLE_LED: 'shadow',
  SHARP_FINAL: 'shadow',
  SHARP_FINAL_LOW: 'shadow',
  LEGACY: 'shadow',
};

export function alertRouteForModel(model: string): AlertRoute {
  return MODEL_ROUTE[model as DetectionModelValue] ?? 'main';
}

export function isShadowModel(model: string): boolean {
  return alertRouteForModel(model) === 'shadow';
}

/** Tracks a filter selects, in display order. */
export function modelsFor(filter: ModelFilter): readonly DetectionModelValue[] {
  if (filter === 'legacy') return ['LEGACY'];
  if (filter === 'pinnacle') return ['PINNACLE_LED'];
  if (filter === 'low-odds-legacy') return ['LOW_ODDS_LEGACY'];
  if (filter === 'low-odds-pinnacle') return ['LOW_ODDS_PINNACLE_LED'];
  if (filter === 'sharp') return ['SHARP_FINAL'];
  if (filter === 'sharp-low') return ['SHARP_FINAL_LOW'];
  if (filter === 'sharp-v2') return ['SHARP_FINAL_V2'];
  if (filter === 'sharp-low-v2') return ['SHARP_FINAL_LOW_V2'];
  if (filter === 'legacy-quality') return ['LEGACY_QUALITY'];
  // Active models first, then shadow models — all kept visible in /roi.
  return ['SHARP_FINAL_V2', 'SHARP_FINAL_LOW_V2', 'LEGACY_QUALITY', 'LOW_ODDS_LEGACY', 'PINNACLE_LED', 'LOW_ODDS_PINNACLE_LED', 'SHARP_FINAL', 'SHARP_FINAL_LOW', 'LEGACY'];
}

const MODEL_DISPLAY: Record<DetectionModelValue, string> = {
  LEGACY: 'LEGACY SYSTEM',
  PINNACLE_LED: 'EXPERIMENTAL PINNACLE-LED SYSTEM',
  LOW_ODDS_LEGACY: 'LOW ODDS LEGACY SYSTEM',
  LOW_ODDS_PINNACLE_LED: 'LOW ODDS EXPERIMENTAL PINNACLE-LED SYSTEM',
  SHARP_FINAL: 'SHARP FINAL (MULTI-SOURCE CONSENSUS)',
  SHARP_FINAL_LOW: 'SHARP FINAL LOW ODDS',
  SHARP_FINAL_V2: 'SHARP FINAL V2 (REBELBETTING-STYLE)',
  SHARP_FINAL_LOW_V2: 'SHARP FINAL V2 LOW ODDS',
  LEGACY_QUALITY: 'LEGACY QUALITY (FLAT-MOVEMENT FILTERED)',
};

export function modelDisplay(model: DetectionModelValue): string {
  return MODEL_DISPLAY[model];
}

/** Shared Discord option choices for the model filter. */
export const MODEL_OPTION_CHOICES = [
  { name: 'Combined (all tracks)', value: 'combined' },
  { name: 'Legacy only', value: 'legacy' },
  { name: 'Pinnacle-led only', value: 'pinnacle' },
  { name: 'Low Odds Legacy only', value: 'low-odds-legacy' },
  { name: 'Low Odds Pinnacle-led only', value: 'low-odds-pinnacle' },
  { name: 'Sharp Final only', value: 'sharp' },
  { name: 'Sharp Final Low only', value: 'sharp-low' },
  { name: 'Sharp Final V2 only', value: 'sharp-v2' },
  { name: 'Sharp Final V2 Low only', value: 'sharp-low-v2' },
  { name: 'Legacy Quality only', value: 'legacy-quality' },
];
