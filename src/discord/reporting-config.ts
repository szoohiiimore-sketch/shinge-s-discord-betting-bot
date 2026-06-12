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
 * Track segmentation for reporting commands (4-track A/B).
 * 'combined' shows per-track sections; the others restrict to one track.
 */
export type ModelFilter = 'combined' | 'legacy' | 'pinnacle' | 'low-odds-legacy' | 'low-odds-pinnacle';

export type DetectionModelValue = 'LEGACY' | 'PINNACLE_LED' | 'LOW_ODDS_LEGACY' | 'LOW_ODDS_PINNACLE_LED';

/** Tracks a filter selects, in display order. */
export function modelsFor(filter: ModelFilter): readonly DetectionModelValue[] {
  if (filter === 'legacy') return ['LEGACY'];
  if (filter === 'pinnacle') return ['PINNACLE_LED'];
  if (filter === 'low-odds-legacy') return ['LOW_ODDS_LEGACY'];
  if (filter === 'low-odds-pinnacle') return ['LOW_ODDS_PINNACLE_LED'];
  return ['PINNACLE_LED', 'LEGACY', 'LOW_ODDS_PINNACLE_LED', 'LOW_ODDS_LEGACY'];
}

const MODEL_DISPLAY: Record<DetectionModelValue, string> = {
  LEGACY: 'LEGACY SYSTEM',
  PINNACLE_LED: 'EXPERIMENTAL PINNACLE-LED SYSTEM',
  LOW_ODDS_LEGACY: 'LOW ODDS LEGACY SYSTEM',
  LOW_ODDS_PINNACLE_LED: 'LOW ODDS EXPERIMENTAL PINNACLE-LED SYSTEM',
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
];
