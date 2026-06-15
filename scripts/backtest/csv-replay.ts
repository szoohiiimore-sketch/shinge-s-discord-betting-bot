/* eslint-disable no-console */
/**
 * Historical CSV replay — football-data.co.uk → the production detector cores.
 *
 * ISOLATION GUARANTEE: this script imports NO Prisma, NO Redis, NO settlement,
 * NO ValueOpportunity repository. It reads CSVs, runs the SAME pure detector
 * cores production uses, settles EXACTLY from the result column (no inference),
 * and writes ONLY one aggregate data module (src/discord/historical-csv-seed.data.ts).
 * Nothing is persisted to any database, queue, or production table.
 *
 * Reuse: the existing pure detector cores (detectFromBatch / legacyDetectFromBatch)
 * + idea aggregation. A football-data row is a single pre-match (or closing)
 * snapshot, so the time-series replay engine is unnecessary — only a CSV adapter
 * is needed (Phase-1 conclusion).
 *
 * Run: npx tsx scripts/backtest/csv-replay.ts
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectFromBatch, PRODUCTION_DETECTOR_CONFIG } from '../../src/value-detection/detector-core';
import type { DetectorInputRow } from '../../src/value-detection/detector-core';
import { legacyDetectFromBatch, LEGACY_DETECTOR_CONFIG } from '../../src/value-detection/legacy-detector-core';
import { sharpFinalDetectFromBatch, SHARP_FINAL_CONFIG, SHARP_FINAL_V2_CONFIG } from '../../src/value-detection/sharp-final-detector-core';
import { groupIdeas, selectHeadline } from '../../src/value-detection/idea-aggregation';
import { isLowOdds, pinnacleLedLowOddsThresholdPct, legacyLowOddsThresholdPct } from '../../src/value-detection/low-odds-config';

const CSV_DIR = join(process.cwd(), 'historicalcsv');
const OUT = join(process.cwd(), 'src', 'discord', 'historical-csv-seed.data.ts');
const MAX_ODDS = 3.0;
const pinCfg = { ...PRODUCTION_DETECTOR_CONFIG, maxCandidateOdds: MAX_ODDS };
const legCfg = { ...LEGACY_DETECTOR_CONFIG, minEdgeThresholdPct: 3.0, maxCandidateOdds: MAX_ODDS };
const LEGACY_MAIN_MIN = LEGACY_DETECTOR_CONFIG.minEdgeThresholdPct; // 5.0
// football-data carries only TWO sharp sources (Pinnacle + Betfair Exchange); the
// live panel has five. The CSV backtest therefore tests a 2-source SHARP_FINAL.
const sharpCfg = { ...SHARP_FINAL_CONFIG, sharpBookmakers: ['pinnacle', 'betfair_ex_uk'], maxCandidateOdds: MAX_ODDS };
const sharpCfgV2 = { ...SHARP_FINAL_V2_CONFIG, sharpBookmakers: ['pinnacle', 'betfair_ex_uk'], maxCandidateOdds: MAX_ODDS };
const OUTCOMES = ['Home', 'Draw', 'Away'] as const;
type Model = 'LEGACY' | 'PINNACLE_LED' | 'LOW_ODDS_LEGACY' | 'LOW_ODDS_PINNACLE_LED' | 'SHARP_FINAL' | 'SHARP_FINAL_LOW' | 'SHARP_FINAL_V2' | 'SHARP_FINAL_LOW_V2';

interface IdeaRow { matchId: string; outcome: string; bookmaker: string; bookmakerOdds: number; edgePercentage: number; createdAt: Date; }

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.toLowerCase().endsWith('.csv')) out.push(p);
  }
  return out;
}

/** Parse DD/MM/YYYY or DD/MM/YY → {iso, season-start-year}. */
function parseDate(s: string): { iso: string; season: number } | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2]; let y = +m[3];
  if (y < 100) y += 2000;
  const season = mo >= 7 ? y : y - 1; // football season Aug–May
  return { iso: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, season };
}

interface Triplet { prefix: string; h: number; d: number; a: number; }
interface Classified { role: 'ref' | 'soft' | 'exchange'; timing: 'prematch' | 'closing'; book: string; t: Triplet; }

function classifyHeader(cols: string[]): Classified[] {
  const idx = new Map<string, number>();
  cols.forEach((c, i) => idx.set(c, i));
  const triplets: Triplet[] = [];
  const prefixes = new Set<string>();
  for (const c of cols) {
    if (!c.endsWith('H')) continue;
    const prefix = c.slice(0, -1);
    if (idx.has(prefix + 'D') && idx.has(prefix + 'A')) {
      triplets.push({ prefix, h: idx.get(c)!, d: idx.get(prefix + 'D')!, a: idx.get(prefix + 'A')! });
      prefixes.add(prefix);
    }
  }
  const out: Classified[] = [];
  for (const t of triplets) {
    const up = t.prefix.toUpperCase();
    if (up === 'PS') out.push({ role: 'ref', timing: 'prematch', book: 'pinnacle', t });
    else if (up === 'PSC') out.push({ role: 'ref', timing: 'closing', book: 'pinnacle', t });
    else if (up === 'BFE') out.push({ role: 'exchange', timing: 'prematch', book: 'betfair_ex_uk', t });
    else if (up === 'BFEC') out.push({ role: 'exchange', timing: 'closing', book: 'betfair_ex_uk', t });
    else if (up.includes('MAX') || up.includes('AVG') || up.startsWith('BB')) continue; // aggregates
    else {
      // Closing column = bookCode + 'C' + (H/D/A); detect by base existing as a triplet.
      const closing = t.prefix.endsWith('C') && prefixes.has(t.prefix.slice(0, -1));
      out.push({ role: 'soft', timing: closing ? 'closing' : 'prematch', book: t.prefix.toLowerCase(), t });
    }
  }
  return out;
}

const num = (s: string | undefined): number => { const n = s ? parseFloat(s) : NaN; return Number.isFinite(n) ? n : NaN; };

// ── Accumulators ─────────────────────────────────────────────────────────
const ideas: Record<Model, IdeaRow[]> = { LEGACY: [], PINNACLE_LED: [], LOW_ODDS_LEGACY: [], LOW_ODDS_PINNACLE_LED: [], SHARP_FINAL: [], SHARP_FINAL_LOW: [], SHARP_FINAL_V2: [], SHARP_FINAL_LOW_V2: [] };
const resultByMatch = new Map<string, string>(); // matchId → 'Home'|'Draw'|'Away'
const matchTier = new Map<string, 'prematch' | 'closing'>();
const seenMatches = new Set<string>();
const leagues = new Set<string>();
const seasons = new Set<number>();
let matchesTotal = 0, matchesWithRef = 0, prematch = 0, closingOnly = 0, filesProcessed = 0;
let minDate = '9999', maxDate = '0000';

function pushPinnacleFamily(matchId: string, batch: DetectorInputRow[], now: Date): void {
  const r = detectFromBatch(batch, pinCfg);
  // PINNACLE_LED = production tier (edge ≥ 3%): all qualifying soft rows (idea-aggregated later).
  for (const c of r.candidates) {
    if (!c.isShadow) {
      ideas.PINNACLE_LED.push({ matchId, outcome: c.outcome, bookmaker: c.bookmaker, bookmakerOdds: c.bookmakerOdds, edgePercentage: c.edgePercentage, createdAt: now });
    }
  }
  // LOW_ODDS_PINNACLE_LED = shadow band (2–3%) meeting the per-bucket low-odds floor; strongest per match.
  let best: { c: (typeof r.candidates)[number]; thr: number } | null = null;
  for (const c of r.candidates) {
    if (!c.isShadow || !isLowOdds(c.bookmakerOdds)) continue;
    const thr = pinnacleLedLowOddsThresholdPct(c.bookmakerOdds);
    if (thr === null || c.edgePercentage < thr) continue;
    if (!best || c.edgePercentage > best.c.edgePercentage) best = { c, thr };
  }
  if (best) ideas.LOW_ODDS_PINNACLE_LED.push({ matchId, outcome: best.c.outcome, bookmaker: best.c.bookmaker, bookmakerOdds: best.c.bookmakerOdds, edgePercentage: best.c.edgePercentage, createdAt: now });
}

function pushSharpVariant(matchId: string, batch: DetectorInputRow[], now: Date, cfg: typeof sharpCfg, prod: Model, low: Model): void {
  const r = sharpFinalDetectFromBatch(batch, cfg);
  for (const c of r.candidates) {
    if (!c.isShadow) ideas[prod].push({ matchId, outcome: c.outcome, bookmaker: c.bookmaker, bookmakerOdds: c.bookmakerOdds, edgePercentage: c.edgePercentage, createdAt: now });
  }
  let best: (typeof r.candidates)[number] | null = null;
  for (const c of r.candidates) {
    if (!c.isShadow || !isLowOdds(c.bookmakerOdds)) continue;
    const thr = pinnacleLedLowOddsThresholdPct(c.bookmakerOdds);
    if (thr === null || c.edgePercentage < thr) continue;
    if (!best || c.edgePercentage > best.edgePercentage) best = c;
  }
  if (best) ideas[low].push({ matchId, outcome: best.outcome, bookmaker: best.bookmaker, bookmakerOdds: best.bookmakerOdds, edgePercentage: best.edgePercentage, createdAt: now });
}
function pushSharpFamily(matchId: string, batch: DetectorInputRow[], now: Date): void {
  pushSharpVariant(matchId, batch, now, sharpCfg, 'SHARP_FINAL', 'SHARP_FINAL_LOW');
  pushSharpVariant(matchId, batch, now, sharpCfgV2, 'SHARP_FINAL_V2', 'SHARP_FINAL_LOW_V2');
}

function pushLegacyFamily(matchId: string, batch: DetectorInputRow[], now: Date): void {
  const r = legacyDetectFromBatch(batch, legCfg);
  // Family conflict (mirrors production): ONE strongest-edge legacy-family outcome per match.
  let pick: { c: (typeof r.candidates)[number]; track: 'LEGACY' | 'LOW_ODDS_LEGACY' } | null = null;
  for (const c of r.candidates) {
    let track: 'LEGACY' | 'LOW_ODDS_LEGACY' | null = null;
    if (c.edgePercentage >= LEGACY_MAIN_MIN) track = 'LEGACY';
    else if (isLowOdds(c.bookmakerOdds)) {
      const thr = legacyLowOddsThresholdPct(c.bookmakerOdds);
      if (thr !== null && c.edgePercentage >= thr) track = 'LOW_ODDS_LEGACY';
    }
    if (track && (!pick || c.edgePercentage > pick.c.edgePercentage)) pick = { c, track };
  }
  if (pick) ideas[pick.track].push({ matchId, outcome: pick.c.outcome, bookmaker: pick.c.bookmaker, bookmakerOdds: pick.c.bookmakerOdds, edgePercentage: pick.c.edgePercentage, createdAt: now });
}

function processRow(cols: string[], cl: Classified[], leagueLabel: string, dateStr: string, home: string, away: string, resLetter: string, seasonOverride: number | null): void {
  const date = parseDate(dateStr);
  if (!date) return;
  const result = resLetter === 'H' ? 'Home' : resLetter === 'D' ? 'Draw' : resLetter === 'A' ? 'Away' : null;
  if (!result || !home || !away) return;
  const matchId = `${leagueLabel}|${date.iso}|${home}|${away}`;
  if (seenMatches.has(matchId)) return;
  seenMatches.add(matchId);
  matchesTotal++;
  leagues.add(leagueLabel);
  seasons.add(seasonOverride ?? date.season);
  if (date.iso < minDate) minDate = date.iso;
  if (date.iso > maxDate) maxDate = date.iso;

  // Choose tier: pre-match Pinnacle preferred, else closing Pinnacle.
  const refPre = cl.find(c => c.role === 'ref' && c.timing === 'prematch');
  const refClose = cl.find(c => c.role === 'ref' && c.timing === 'closing');
  let timing: 'prematch' | 'closing' | null = null;
  if (refPre && num(cols[refPre.t.h]) > 1 && num(cols[refPre.t.d]) > 1 && num(cols[refPre.t.a]) > 1) timing = 'prematch';
  else if (refClose && num(cols[refClose.t.h]) > 1 && num(cols[refClose.t.d]) > 1 && num(cols[refClose.t.a]) > 1) timing = 'closing';
  if (!timing) return; // no usable Pinnacle reference

  matchesWithRef++;
  if (timing === 'prematch') prematch++; else closingOnly++;
  resultByMatch.set(matchId, result);
  matchTier.set(matchId, timing);

  const batch: DetectorInputRow[] = [];
  for (const c of cl) {
    if (c.timing !== timing) continue;
    if (c.role === 'soft' || c.role === 'ref' || c.role === 'exchange') {
      const prices = [num(cols[c.t.h]), num(cols[c.t.d]), num(cols[c.t.a])];
      OUTCOMES.forEach((o, i) => { if (prices[i] > 1) batch.push({ bookmaker: c.book, outcome: o, price: prices[i] }); });
    }
  }
  const now = new Date(date.iso + 'T00:00:00Z');
  pushPinnacleFamily(matchId, batch, now);
  pushLegacyFamily(matchId, batch, now);
  pushSharpFamily(matchId, batch, now);
}

// ── Parse every file ──────────────────────────────────────────────────────
const files = walk(CSV_DIR);
console.log(`Found ${files.length} CSV files under historicalcsv/`);
for (const file of files) {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) continue;
  const raw0 = lines[0];
  const header = (raw0.charCodeAt(0) === 0xFEFF ? raw0.slice(1) : raw0).split(',');
  const cl = classifyHeader(header);
  if (!cl.some(c => c.role === 'ref')) { filesProcessed++; continue; } // no Pinnacle at all
  const idx = (name: string) => header.indexOf(name);
  const isExtra = idx('Country') >= 0 || idx('League') >= 0;
  const cLeague = isExtra ? idx('League') : idx('Div');
  const cDate = idx('Date');
  const cHome = isExtra ? idx('Home') : idx('HomeTeam');
  const cAway = isExtra ? idx('Away') : idx('AwayTeam');
  const cRes = isExtra ? idx('Res') : idx('FTR');
  const cSeason = idx('Season');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const league = (cLeague >= 0 ? cols[cLeague] : 'UNK')?.trim() || 'UNK';
    const seasonOverride = cSeason >= 0 && cols[cSeason] ? (parseInt(cols[cSeason], 10) || null) : null;
    processRow(cols, cl, league, cols[cDate] ?? '', (cols[cHome] ?? '').trim(), (cols[cAway] ?? '').trim(), (cols[cRes] ?? '').trim(), seasonOverride);
  }
  filesProcessed++;
}

// ── Aggregate (idea-level, identical methodology to live/seed) ─────────────
function statsFor(model: Model, tier: 'all' | 'prematch') {
  const headlines: IdeaRow[] = [];
  for (const members of groupIdeas(ideas[model]).values()) {
    const h = selectHeadline(members);
    if (h && (tier === 'all' || matchTier.get(h.matchId) === 'prematch')) headlines.push(h);
  }
  let wins = 0, losses = 0, pl = 0, oddsSum = 0, edgeSum = 0;
  for (const h of headlines) {
    const win = resultByMatch.get(h.matchId) === h.outcome;
    if (win) { wins++; pl += h.bookmakerOdds - 1; } else { losses++; pl -= 1; }
    oddsSum += h.bookmakerOdds; edgeSum += h.edgePercentage;
  }
  const n = headlines.length;
  return {
    matchesProcessed: tier === 'all' ? matchesWithRef : prematch,
    alerts: n, wins, losses, pushes: 0,
    winRatePct: n ? +(100 * wins / n).toFixed(2) : null,
    avgOdds: n ? +(oddsSum / n).toFixed(3) : null,
    avgEdgePct: n ? +(edgeSum / n).toFixed(2) : null,
    roiPct: n ? +(100 * pl / n).toFixed(2) : null,
    profitUnits: +pl.toFixed(2),
  };
}

const seed = {
  generatedAt: new Date().toISOString(),
  dataset: {
    files: filesProcessed,
    matchesTotal,
    matchesWithReference: matchesWithRef,
    leagues: leagues.size,
    seasons: seasons.size,
    dateRange: `${minDate} → ${maxDate}`,
    prematchMatches: prematch,
    closingOnlyMatches: closingOnly,
  },
  models: {
    LEGACY: statsFor('LEGACY', 'all'),
    PINNACLE_LED: statsFor('PINNACLE_LED', 'all'),
    LOW_ODDS_LEGACY: statsFor('LOW_ODDS_LEGACY', 'all'),
    LOW_ODDS_PINNACLE_LED: statsFor('LOW_ODDS_PINNACLE_LED', 'all'),
    SHARP_FINAL: statsFor('SHARP_FINAL', 'all'),
    SHARP_FINAL_LOW: statsFor('SHARP_FINAL_LOW', 'all'),
    SHARP_FINAL_V2: statsFor('SHARP_FINAL_V2', 'all'),
    SHARP_FINAL_LOW_V2: statsFor('SHARP_FINAL_LOW_V2', 'all'),
  },
  modelsPrematch: {
    LEGACY: statsFor('LEGACY', 'prematch'),
    PINNACLE_LED: statsFor('PINNACLE_LED', 'prematch'),
    LOW_ODDS_LEGACY: statsFor('LOW_ODDS_LEGACY', 'prematch'),
    LOW_ODDS_PINNACLE_LED: statsFor('LOW_ODDS_PINNACLE_LED', 'prematch'),
    SHARP_FINAL: statsFor('SHARP_FINAL', 'prematch'),
    SHARP_FINAL_LOW: statsFor('SHARP_FINAL_LOW', 'prematch'),
    SHARP_FINAL_V2: statsFor('SHARP_FINAL_V2', 'prematch'),
    SHARP_FINAL_LOW_V2: statsFor('SHARP_FINAL_LOW_V2', 'prematch'),
  },
};

const banner = `/**
 * GENERATED by scripts/backtest/csv-replay.ts — do not edit by hand.
 * Aggregate-only football-data.co.uk replay summary. No production data touched.
 */`;
writeFileSync(OUT, `${banner}\nimport type { HistoricalCsvSeed } from './historical-csv-seed';\n\nexport const HISTORICAL_CSV_SEED: HistoricalCsvSeed = ${JSON.stringify(seed, null, 2)};\n`);

console.log('\n=== DATASET ===');
console.table([seed.dataset]);
console.log('=== MODELS — ALL matches (idea-level, exact settlement) ===');
console.table(Object.entries(seed.models).map(([m, s]) => ({ model: m, ...s })));
console.log('=== MODELS — PRE-MATCH subset only (high fidelity) ===');
console.table(Object.entries(seed.modelsPrematch).map(([m, s]) => ({ model: m, ...s })));
console.log(`\nWrote ${OUT}`);
console.log('Leagues:', [...leagues].sort().join(', '));
console.log('Seasons:', [...seasons].sort((a, b) => a - b).join(', '));
