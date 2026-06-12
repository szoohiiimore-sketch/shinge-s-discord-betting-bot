/* eslint-disable no-console */
/**
 * Shadow-band expansion analysis: which slices of the 2–3% shadow tier carry
 * real CLV and could be promoted to alerts without diluting quality?
 * Reads an already-scored run; no new replays or credits.
 *
 * Run: npx tsx --env-file=.env scripts/backtest/shadow-band-analysis.ts <runId> <periodDays>
 */
import { PrismaClient } from '@prisma/client';
import type { ReportRow } from '../../src/backtest';
import { clvStats, ideasForTier, loadReportRows } from '../../src/backtest';

const prisma = new PrismaClient();

function line(label: string, rows: ReportRow[], days: number): string {
  const clv = rows.map(r => r.clvPercentage).filter((v): v is number => v !== null);
  const s = clvStats(clv);
  const perDay = (rows.length / days).toFixed(2);
  return `${label.padEnd(44)} ideas=${String(rows.length).padStart(3)} (${perDay}/d)  avg=${s.mean?.toFixed(2) ?? '—'}%  med=${s.median?.toFixed(2) ?? '—'}%  pos=${s.positiveRate !== null ? (s.positiveRate * 100).toFixed(0) : '—'}%  trim=${s.trimmedMean?.toFixed(2) ?? '—'}%`;
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  const days = parseFloat(process.argv[3] ?? '47');
  if (!runId) { console.error('Usage: shadow-band-analysis.ts <runId> [periodDays]'); process.exit(1); }

  const rows = await loadReportRows(prisma, runId);
  const production = ideasForTier(rows, false);
  const shadow = ideasForTier(rows, true);

  console.log(`run ${runId} | ${days} days | production ideas=${production.length} | shadow ideas=${shadow.length}\n`);

  console.log('── Shadow ideas by edge band (headline row) ──');
  console.log(line('2.0–2.5%', shadow.filter(r => r.edgePercentage < 2.5), days));
  console.log(line('2.5–3.0%', shadow.filter(r => r.edgePercentage >= 2.5), days));

  console.log('\n── Shadow ideas by corroboration k ──');
  console.log(line('k=1', shadow.filter(r => r.corroborationK <= 1), days));
  console.log(line('k>=2', shadow.filter(r => r.corroborationK >= 2), days));

  console.log('\n── Candidate promotion slices ──');
  console.log(line('2.5–3.0% AND k>=2', shadow.filter(r => r.edgePercentage >= 2.5 && r.corroborationK >= 2), days));
  console.log(line('2.5–3.0% AND k=1', shadow.filter(r => r.edgePercentage >= 2.5 && r.corroborationK <= 1), days));
  console.log(line('2.0–2.5% AND k>=2', shadow.filter(r => r.edgePercentage < 2.5 && r.corroborationK >= 2), days));

  console.log('\n── Shadow ideas by sport ──');
  for (const sport of [...new Set(shadow.map(r => r.sportKey))].sort()) {
    console.log(line(sport, shadow.filter(r => r.sportKey === sport), days));
  }

  console.log('\n── Shadow 2.5–3.0% by sport (league-specific threshold evidence) ──');
  for (const sport of [...new Set(shadow.map(r => r.sportKey))].sort()) {
    console.log(line(sport, shadow.filter(r => r.sportKey === sport && r.edgePercentage >= 2.5), days));
  }

  console.log('\n── Shadow ideas by headline bookmaker family (bookmaker-specific threshold evidence) ──');
  for (const family of [...new Set(shadow.map(r => r.bookmakerFamily))].sort()) {
    console.log(line(family, shadow.filter(r => r.bookmakerFamily === family), days));
  }

  console.log('\n── Production reference (same denominator) ──');
  console.log(line('production (>=3%)', production, days));
  console.log(line('production + (2.5–3.0% & k>=2)', [...production, ...shadow.filter(r => r.edgePercentage >= 2.5 && r.corroborationK >= 2)], days));

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
