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
export type ModelFilter = 'combined' | 'legacy' | 'pinnacle' | 'low-odds-legacy' | 'low-odds-pinnacle' | 'sharp' | 'sharp-low';

export type DetectionModelValue = 'LEGACY' | 'PINNACLE_LED' | 'LOW_ODDS_LEGACY' | 'LOW_ODDS_PINNACLE_LED' | 'SHARP_FINAL' | 'SHARP_FINAL_LOW';

/** Tracks a filter selects, in display order. */
export function modelsFor(filter: ModelFilter): readonly DetectionModelValue[] {
  if (filter === 'legacy') return ['LEGACY'];
  if (filter === 'pinnacle') return ['PINNACLE_LED'];
  if (filter === 'low-odds-legacy') return ['LOW_ODDS_LEGACY'];
  if (filter === 'low-odds-pinnacle') return ['LOW_ODDS_PINNACLE_LED'];
  if (filter === 'sharp') return ['SHARP_FINAL'];
  if (filter === 'sharp-low') return ['SHARP_FINAL_LOW'];
  return ['PINNACLE_LED', 'LEGACY', 'LOW_ODDS_PINNACLE_LED', 'LOW_ODDS_LEGACY', 'SHARP_FINAL', 'SHARP_FINAL_LOW'];
}

const MODEL_DISPLAY: Record<DetectionModelValue, string> = {
  LEGACY: 'LEGACY SYSTEM',
  PINNACLE_LED: 'EXPERIMENTAL PINNACLE-LED SYSTEM',
  LOW_ODDS_LEGACY: 'LOW ODDS LEGACY SYSTEM',
  LOW_ODDS_PINNACLE_LED: 'LOW ODDS EXPERIMENTAL PINNACLE-LED SYSTEM',
  SHARP_FINAL: 'SHARP FINAL (MULTI-SOURCE CONSENSUS)',
  SHARP_FINAL_LOW: 'SHARP FINAL LOW ODDS',
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
];
