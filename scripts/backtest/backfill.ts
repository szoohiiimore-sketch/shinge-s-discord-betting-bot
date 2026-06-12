/* eslint-disable no-console */
/**
 * Backfill CLI — pulls historical snapshots into the segregated
 * historical_* tables under a hard credit budget. Resumable and idempotent.
 *
 * Run: npx tsx --env-file=.env scripts/backtest/backfill.ts <plan.json>
 * Example plan: scripts/backtest/configs/backfill-example.json
 *
 * COST WARNING: each sport-snapshot request costs 10 × regions credits
 * (e.g. 'eu,uk' = 20 credits/snapshot). Set maxCredits deliberately.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import type { BackfillPlan } from '../../src/backtest';
import { runBackfill } from '../../src/backtest';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const planPath = process.argv[2];
  if (!planPath) {
    console.error('Usage: backfill.ts <plan.json>');
    process.exit(1);
  }
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.error('THE_ODDS_API_KEY is not set');
    process.exit(1);
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as BackfillPlan;

  console.log(`Backfill plan "${plan.planKey}" | mode=${plan.mode} | regions=${plan.regions}`);
  console.log(`Period ${plan.periodStart} → ${plan.periodEnd} | sports: ${plan.sportKeys.join(', ')}`);
  console.log(`Budget: ${plan.maxCredits} credits (quota floor: ${plan.minRemainingCredits ?? 10000})\n`);

  const summary = await runBackfill(prisma, { apiKey }, plan, console.log);

  console.log('\n── Backfill summary ──');
  console.log(`requests: ${summary.requests} | credits used: ${summary.creditsUsed}`);
  console.log(`snapshot rows inserted: ${summary.snapshotRowsInserted} | events upserted: ${summary.eventsUpserted}`);
  console.log(`stopped: ${summary.stoppedReason}`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
