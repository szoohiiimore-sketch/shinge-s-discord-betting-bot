/* eslint-disable no-console */
/**
 * Verification: loads the historical seed for all four tracks and renders the
 * real /roi output (historical/live/combined sections). Read-only.
 * Run: npx tsx --env-file=.env scripts/verify-roi-seeding.ts
 */
import { PrismaClient } from '@prisma/client';
import { createLogger } from '../src/lib/logger';
import { loadHistoricalSeed } from '../src/discord/historical-seed';
import { getRoiStats } from '../src/discord/commands/roi';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const seed = await loadHistoricalSeed(prisma);
  console.log('── Historical seed per track ──');
  let failures = 0;
  for (const [track, s] of Object.entries(seed)) {
    console.log(`${track.padEnd(24)} settled=${s.settledIdeas} W-L=${s.wins}-${s.losses} P&L=${s.profitUnits.toFixed(2)}u ROI=${s.roiPct?.toFixed(2) ?? '—'}% win=${s.winRatePct?.toFixed(1) ?? '—'}%`);
  }
  const tracks = Object.keys(seed);
  if (tracks.length !== 4) { console.log('FAIL: expected 4 tracks'); failures++; }
  if (!tracks.every(t => ['LEGACY', 'PINNACLE_LED', 'LOW_ODDS_LEGACY', 'LOW_ODDS_PINNACLE_LED'].includes(t))) { console.log('FAIL: track names'); failures++; }

  const logger = createLogger({ level: 'warn', pretty: false });
  const { content } = await getRoiStats(prisma, 'all', logger, 'combined');
  console.log('\n── /roi combined output ──\n' + content + '\n');

  for (const expected of ['Historical:', 'Live:', 'Combined:', 'LEGACY SYSTEM', 'EXPERIMENTAL PINNACLE-LED SYSTEM', 'LOW ODDS LEGACY SYSTEM', 'LOW ODDS EXPERIMENTAL PINNACLE-LED SYSTEM']) {
    const ok = content.includes(expected);
    console.log(`${ok ? 'PASS' : 'FAIL'}  /roi contains "${expected}"`);
    if (!ok) failures++;
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
