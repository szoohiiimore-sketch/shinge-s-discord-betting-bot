/* eslint-disable no-console */
/**
 * Offline verification: renders one alert per model through the real formatter
 * and asserts the model tags are visible near the title. No Discord calls.
 * Run: npx tsx scripts/verify-dual-model-alerts.ts
 */
import { formatIdeaAlert } from '../src/discord/discord-notification.service';
import type { PendingAlertRow } from '../src/discord/discord-notification.service';

function row(model: string, bookmaker: string, odds: number, edge: number): PendingAlertRow {
  return {
    id: 'test',
    model,
    matchId: 'match-1',
    sport: 'soccer',
    bookmaker,
    outcome: 'Landskrona BoIS',
    bookmakerOdds: odds,
    fairOdds: odds / (1 + edge / 100),
    edgePercentage: edge,
    pinnacleMove6h: -2.4,
    createdAt: new Date('2026-06-12T10:00:00Z'),
    match: {
      startTime: new Date('2026-06-12T17:00:00Z'),
      league: { name: 'Superettan' },
      homeTeam: { name: 'Helsingborgs IF' },
      awayTeam: { name: 'Landskrona BoIS' },
    },
  };
}

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

const pinnacleLed = formatIdeaAlert([row('PINNACLE_LED', 'coolbet', 2.95, 4.6), row('PINNACLE_LED', 'unibet', 2.88, 3.6)]);
const legacy = formatIdeaAlert([row('LEGACY', 'pinnacle', 2.6, 6.2)]);

console.log('── PINNACLE-LED ALERT ──\n' + pinnacleLed + '\n');
console.log('── LEGACY ALERT ──\n' + legacy + '\n');

check('pinnacle-led alert carries (EXPERIMENTAL PINNACLE-LED SYSTEM) on line 2',
  pinnacleLed !== null && pinnacleLed.split('\n')[1].includes('(EXPERIMENTAL PINNACLE-LED SYSTEM)'));
check('legacy alert carries (LEGACY SYSTEM) on line 2',
  legacy !== null && legacy.split('\n')[1].includes('(LEGACY SYSTEM)'));
check('both models render simultaneously and independently', pinnacleLed !== null && legacy !== null);

process.exit(failures === 0 ? 0 : 1);
