/**
 * Run persistence — creating backtest runs, loading replay input, and storing
 * detections. Touches ONLY historical_* / backtest_* tables.
 */
import { execSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import type { BacktestRunConfig, ReplayDetection, ReplaySnapshotRow } from './types';

/** Hours of pre-period snapshots loaded so movement windows have history. */
export const MOVEMENT_WARMUP_HOURS = 24;

export function getCodeVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export async function createRun(
  prisma: PrismaClient,
  config: BacktestRunConfig,
  codeVersion: string,
): Promise<string> {
  const run = await prisma.backtestRun.create({
    data: {
      name: config.name,
      config: JSON.parse(JSON.stringify(config)),
      codeVersion,
      cadenceMode: config.cadenceMode,
      periodStart: new Date(config.periodStart),
      periodEnd: new Date(config.periodEnd),
      status: 'CREATED',
    },
    select: { id: true },
  });
  return run.id;
}

/** Loads the replay input rows: run period plus the movement warm-up window. */
export async function loadReplayRows(
  prisma: PrismaClient,
  config: BacktestRunConfig,
): Promise<ReplaySnapshotRow[]> {
  const warmupStart = new Date(Date.parse(config.periodStart) - MOVEMENT_WARMUP_HOURS * 3_600_000);
  const rows = await prisma.historicalOddsSnapshot.findMany({
    where: {
      sportKey: { in: config.sportKeys as string[] },
      market: 'h2h',
      snapshotAt: { gte: warmupStart, lte: new Date(config.periodEnd) },
    },
    select: {
      eventId: true,
      sportKey: true,
      bookmaker: true,
      outcome: true,
      price: true,
      snapshotAt: true,
      event: { select: { commenceTime: true } },
    },
  });
  return rows.map(r => ({
    eventId: r.eventId,
    sportKey: r.sportKey,
    bookmaker: r.bookmaker,
    outcome: r.outcome,
    price: r.price.toNumber(),
    snapshotAt: r.snapshotAt,
    commenceTime: r.event.commenceTime,
  }));
}

export async function insertDetections(
  prisma: PrismaClient,
  runId: string,
  detections: readonly ReplayDetection[],
): Promise<number> {
  let inserted = 0;
  const CHUNK = 1_000;
  for (let i = 0; i < detections.length; i += CHUNK) {
    const chunk = detections.slice(i, i + CHUNK);
    const result = await prisma.backtestOpportunity.createMany({
      data: chunk.map(d => ({
        runId,
        eventId: d.eventId,
        sportKey: d.sportKey,
        bookmaker: d.bookmaker,
        outcome: d.outcome,
        bookmakerOdds: d.bookmakerOdds,
        fairOdds: d.fairOdds,
        edgePercentage: d.edgePercentage,
        consensusProbability: d.consensusProbability,
        isShadow: d.isShadow,
        detectedAt: d.detectedAt,
        commenceTime: d.commenceTime,
        referenceOverround: d.referenceOverround,
        bookmakerFamily: d.bookmakerFamily,
        minutesToKickoff: d.minutesToKickoff,
        pinnacleMove1h: d.pinnacleMove1h,
        pinnacleMove6h: d.pinnacleMove6h,
        pinnacleMove24h: d.pinnacleMove24h,
        priceGapPct: d.priceGapPct,
        corroborationK: d.corroborationK,
      })),
    });
    inserted += result.count;
  }
  return inserted;
}

export async function markRunStatus(prisma: PrismaClient, runId: string, status: 'REPLAYED' | 'SCORED'): Promise<void> {
  await prisma.backtestRun.update({ where: { id: runId }, data: { status } });
}
