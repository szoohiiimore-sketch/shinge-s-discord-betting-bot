/* eslint-disable no-console */
/**
 * Offline verification of the LOW ODDS SYSTEM: bucket thresholds, abort
 * condition, confidence grading, and alert tags for all four tracks.
 * Run: npx tsx scripts/verify-low-odds-system.ts
 */
import {
  pinnacleLedLowOddsThresholdPct,
  legacyLowOddsThresholdPct,
  isLowOdds,
  legacyConfidence,
} from '../src/value-detection';
import { formatIdeaAlert } from '../src/discord/discord-notification.service';
import type { PendingAlertRow } from '../src/discord/discord-notification.service';

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

// ── Bucket thresholds & abort condition ──
check('odds range boundaries', !isLowOdds(1.09) && isLowOdds(1.10) && isLowOdds(2.19) && !isLowOdds(2.20));
check('pinnacle bucket thresholds (2.0 / 2.5 / 2.0 / 2.5)',
  pinnacleLedLowOddsThresholdPct(1.2) === 2.0
  && pinnacleLedLowOddsThresholdPct(1.4) === 2.5
  && pinnacleLedLowOddsThresholdPct(1.65) === 2.0
  && pinnacleLedLowOddsThresholdPct(2.0) === 2.5
  && pinnacleLedLowOddsThresholdPct(2.5) === null);
check('legacy 1.30–1.50 bucket ABORTED (measured −43% ROI)', legacyLowOddsThresholdPct(1.4) === null);
check('legacy enabled buckets at 3.0%',
  legacyLowOddsThresholdPct(1.2) === 3.0 && legacyLowOddsThresholdPct(1.65) === 3.0 && legacyLowOddsThresholdPct(2.0) === 3.0);

// ── Confidence grading ──
check('confidence A (2+ signals)', legacyConfidence({ consensusCount: 12, move6hPct: 2.0, edgePct: 4.0 }) === 'A');
check('confidence B (1 signal)', legacyConfidence({ consensusCount: 12, move6hPct: null, edgePct: 4.0 }) === 'B');
check('confidence C (0 signals)', legacyConfidence({ consensusCount: 5, move6hPct: -2.0, edgePct: 4.0 }) === 'C');

// ── Alert tags for the low-odds tracks ──
function row(model: string, bookmaker: string, odds: number, confidence?: string): PendingAlertRow {
  return {
    id: 't', model, matchId: 'm1', sport: 'soccer', bookmaker,
    outcome: 'Home', bookmakerOdds: odds, fairOdds: odds / 1.03, edgePercentage: 3.0,
    pinnacleMove6h: 1.5, confidence: confidence ?? null, createdAt: new Date(),
    match: {
      startTime: new Date('2026-06-13T17:00:00Z'),
      league: { name: 'Superettan' },
      homeTeam: { name: 'Home FC' }, awayTeam: { name: 'Away FC' },
    },
  };
}
const lowLegacy = formatIdeaAlert([row('LOW_ODDS_LEGACY', 'pinnacle', 1.65, 'A')]);
const lowPinnacle = formatIdeaAlert([row('LOW_ODDS_PINNACLE_LED', 'coolbet', 1.72)]);
console.log('\n── LOW ODDS LEGACY ALERT ──\n' + lowLegacy + '\n');
console.log('── LOW ODDS PINNACLE ALERT ──\n' + lowPinnacle + '\n');
check('low-odds legacy tag on line 2', lowLegacy !== null && lowLegacy.split('\n')[1].includes('(LOW ODDS LEGACY SYSTEM)'));
check('low-odds pinnacle tag on line 2', lowPinnacle !== null && lowPinnacle.split('\n')[1].includes('(LOW ODDS EXPERIMENTAL PINNACLE-LED SYSTEM)'));
check('confidence grade rendered for legacy-family alert', lowLegacy !== null && lowLegacy.includes('Confidence: **A**'));
check('no confidence line for pinnacle-family alert', lowPinnacle !== null && !lowPinnacle.includes('Confidence'));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
