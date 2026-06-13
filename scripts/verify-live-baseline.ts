/* eslint-disable no-console */
/**
 * Verification: LIVE_BASELINE_DATE gates live metrics only.
 * Renders the real /roi output under the current env (set LIVE_BASELINE_DATE
 * via .env or leave unset to confirm fallback). Read-only.
 * Run: npx tsx --env-file=.env scripts/verify-live-baseline.ts
 */
import { PrismaClient } from '@prisma/client';
import { createLogger } from '../src/lib/logger';
import { ROI_V2_BASELINE, LIVE_BASELINE } from '../src/discord/reporting-config';
import { getRoiStats } from '../src/discord/commands/roi';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log(`LIVE_BASELINE_DATE env : ${process.env.LIVE_BASELINE_DATE ?? '(unset)'}`);
  console.log(`ROI_V2_BASELINE        : ${ROI_V2_BASELINE.toISOString()}`);
  console.log(`Effective LIVE_BASELINE: ${LIVE_BASELINE.toISOString()}`);

  let failures = 0;
  if (!process.env.LIVE_BASELINE_DATE) {
    if (LIVE_BASELINE.getTime() !== ROI_V2_BASELINE.getTime()) { console.log('FAIL: unset env must fall back to ROI_V2_BASELINE'); failures++; }
    else console.log('PASS  unset env falls back to ROI_V2_BASELINE');
  } else {
    const expected = Math.max(new Date(process.env.LIVE_BASELINE_DATE).getTime(), ROI_V2_BASELINE.getTime());
    if (LIVE_BASELINE.getTime() !== expected) { console.log('FAIL: effective baseline mismatch'); failures++; }
    else console.log('PASS  effective baseline = max(env, ROI_V2_BASELINE)');
  }

  const settledBefore = await prisma.valueOpportunity.count({
    where: { settledAt: { not: null, lt: LIVE_BASELINE, gte: ROI_V2_BASELINE }, isShadow: false },
  });
  const settledAfter = await prisma.valueOpportunity.count({
    where: { settledAt: { not: null, gte: LIVE_BASELINE }, isShadow: false },
  });
  console.log(`Settled rows pre-baseline (excluded from live): ${settledBefore}`);
  console.log(`Settled rows at/after baseline (counted live) : ${settledAfter}`);

  const logger = createLogger({ level: 'warn', pretty: false });
  const { content } = await getRoiStats(prisma, 'all', logger, 'combined');
  console.log('\n── /roi output under current baseline ──\n' + content + '\n');

  // Historical sections must be unaffected by the baseline.
  const histOk = content.includes('Historical:') && content.includes('Combined:');
  console.log(`${histOk ? 'PASS' : 'FAIL'}  Historical and Combined sections still render`);
  if (!histOk) failures++;

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
