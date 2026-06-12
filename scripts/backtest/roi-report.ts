/* eslint-disable no-console */
/**
 * Historical ROI report CLI — idea-level flat-stake ROI across settled runs,
 * with a threshold sweep and ROI segments. CLV is diagnostics-only here.
 *
 * Run: npx tsx --env-file=.env scripts/backtest/roi-report.ts <runId:days> [...runId:days]
 * Runs must cover DISJOINT event sets (no double counting).
 */
import { PrismaClient } from '@prisma/client';
import { ideasAtThreshold, loadRoiRows, movementClass6h, roiLine, roiStats, segmentRoi } from '../../src/backtest';

const prisma = new PrismaClient();

function edgeBand(edge: number): string {
  if (edge < 2.5) return '2.0-2.5%';
  if (edge < 3.0) return '2.5-3.0%';
  if (edge < 4.0) return '3.0-4.0%';
  if (edge < 5.0) return '4.0-5.0%';
  return '>=5.0%';
}

async function main(): Promise<void> {
  const specs = process.argv.slice(2).map(arg => {
    const [runId, days] = arg.split(':');
    return { runId, days: parseFloat(days) };
  });
  if (specs.length === 0 || specs.some(s => !s.runId || !(s.days > 0))) {
    console.error('Usage: roi-report.ts <runId:days> [...runId:days]');
    process.exit(1);
  }

  const rows = await loadRoiRows(prisma, specs);
  console.log(`rows loaded: ${rows.length} from ${specs.length} run(s)\n`);

  console.log('── ROI by threshold (ideas formed from rows >= threshold) ──');
  for (const threshold of [2.0, 2.5, 3.0, 4.0]) {
    console.log(roiLine(`threshold ${threshold.toFixed(1)}%`, roiStats(ideasAtThreshold(rows, threshold))));
  }

  const production = ideasAtThreshold(rows, 3.0);
  const shadowOnly = ideasAtThreshold(rows, 2.0).filter(r => r.edgePercentage < 3.0);

  console.log('\n── ROI by tier ──');
  console.log(roiLine('production (>=3%)', roiStats(production)));
  console.log(roiLine('shadow band (2-3% headline)', roiStats(shadowOnly)));

  console.log('\n── Production ROI by sport/league ──');
  for (const [key, stats] of segmentRoi(production, r => r.sportKey)) console.log(roiLine(key, stats));

  console.log('\n── Production ROI by bookmaker family (headline) ──');
  for (const [key, stats] of segmentRoi(production, r => r.bookmakerFamily)) console.log(roiLine(key, stats));

  console.log('\n── ROI by edge band (all ideas >= 2%) ──');
  for (const [key, stats] of segmentRoi(ideasAtThreshold(rows, 2.0), r => edgeBand(r.edgePercentage))) console.log(roiLine(key, stats));

  console.log('\n── Production ROI by movement class (6h) ──');
  for (const [key, stats] of segmentRoi(production, r => movementClass6h(r.pinnacleMove6h))) console.log(roiLine(key, stats));

  console.log('\n── Shadow-band ROI by sport (promotion evidence) ──');
  for (const [key, stats] of segmentRoi(shadowOnly, r => r.sportKey)) console.log(roiLine(key, stats));

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
