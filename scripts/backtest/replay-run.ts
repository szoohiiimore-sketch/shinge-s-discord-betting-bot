/* eslint-disable no-console */
/**
 * Replay CLI — creates a backtest run from a JSON config file, replays the
 * historical store through the shared detector core, and persists detections.
 *
 * Run: npx tsx --env-file=.env scripts/backtest/replay-run.ts <config.json>
 * Example config: scripts/backtest/configs/baseline-example.json
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import type { BacktestRunConfig } from '../../src/backtest';
import {
  createRun,
  getCodeVersion,
  insertDetections,
  loadReplayRows,
  markRunStatus,
  replaySnapshots,
} from '../../src/backtest';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('Usage: replay-run.ts <config.json>');
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as BacktestRunConfig;
  const codeVersion = getCodeVersion();

  console.log(`Run "${config.name}" | cadence=${config.cadenceMode} | code=${codeVersion}`);
  console.log(`Period ${config.periodStart} → ${config.periodEnd} | sports: ${config.sportKeys.join(', ')}`);

  const rows = await loadReplayRows(prisma, config);
  console.log(`Loaded ${rows.length} historical snapshot rows (incl. 24h movement warm-up)`);
  if (rows.length === 0) {
    console.log('No historical data for this period — run the backfill first.');
    return;
  }

  const runId = await createRun(prisma, config, codeVersion);
  const result = replaySnapshots(rows, config);
  const inserted = await insertDetections(prisma, runId, result.detections);
  await markRunStatus(prisma, runId, 'REPLAYED');

  console.log(`\nrun_id: ${runId}`);
  console.log(`cursors evaluated: ${result.cursorsEvaluated} | batches detected: ${result.batchesDetected} | in-play skipped: ${result.inPlaySkipped}`);
  console.log(`detections: ${result.detections.length} (inserted ${inserted}) | dedup-suppressed: ${result.dedupSuppressed} | movement-filtered: ${result.movementFiltered}`);
  console.log('decision counts:', result.decisionCounts);
  console.log(`\nNext: npx tsx --env-file=.env scripts/backtest/score.ts ${runId}`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
