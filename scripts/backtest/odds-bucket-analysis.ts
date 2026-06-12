/* eslint-disable no-console */
/**
 * Odds-bucket validation for the Low Odds System: idea-level ROI + CLV per
 * odds bucket (1.10–1.30 / 1.30–1.50 / 1.50–1.80 / 1.80–2.20 / 2.20+ ref),
 * and per (bucket × edge band) for threshold selection. Existing data only.
 *
 * Run: npx tsx --env-file=.env scripts/backtest/odds-bucket-analysis.ts <runId:days> [...]
 */
import { PrismaClient } from '@prisma/client';
import type { RoiRow } from '../../src/backtest';
import { ideasAtThreshold, loadRoiRows, roiLine, roiStats } from '../../src/backtest';

const prisma = new PrismaClient();

function bucket(odds: number): string {
  if (odds < 1.10) return '<1.10';
  if (odds < 1.30) return '1.10-1.30';
  if (odds < 1.50) return '1.30-1.50';
  if (odds < 1.80) return '1.50-1.80';
  if (odds < 2.20) return '1.80-2.20';
  return '2.20+ (main)';
}

function edgeBand(edge: number): string {
  if (edge < 2.5) return 'edge 2.0-2.5%';
  if (edge < 3.0) return 'edge 2.5-3.0%';
  if (edge < 5.0) return 'edge 3.0-5.0%';
  return 'edge >=5.0%';
}

function segment(headlines: readonly RoiRow[], classify: (r: RoiRow) => string): void {
  const groups = new Map<string, RoiRow[]>();
  for (const r of headlines) {
    const key = classify(r);
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(r);
  }
  for (const [key, rows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(roiLine(key, roiStats(rows)));
  }
}

async function main(): Promise<void> {
  const specs = process.argv.slice(2).map(arg => {
    const [runId, days] = arg.split(':');
    return { runId, days: parseFloat(days) };
  });
  if (specs.length === 0) { console.error('Usage: odds-bucket-analysis.ts <runId:days> [...]'); process.exit(1); }

  const rows = await loadRoiRows(prisma, specs);
  const ideas = ideasAtThreshold(rows, 0); // every stored idea, lowest stored edge upward
  console.log(`rows=${rows.length} ideas=${ideas.length}\n`);

  console.log('── Ideas by odds bucket (all stored edges) ──');
  segment(ideas, r => bucket(r.bookmakerOdds));

  console.log('\n── Low-odds buckets × edge band (threshold selection evidence) ──');
  segment(ideas.filter(r => r.bookmakerOdds < 2.2), r => `${bucket(r.bookmakerOdds)} | ${edgeBand(r.edgePercentage)}`);

  console.log('\n── Low-odds (<2.2) by sport ──');
  segment(ideas.filter(r => r.bookmakerOdds < 2.2), r => r.sportKey);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
