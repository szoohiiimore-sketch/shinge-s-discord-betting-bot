import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import type { ValueDetectionResult, ValueDetectionDecision, ValueOpportunityInsert } from './value-detection.types';
import type { ValueOpportunityRepository } from './value-opportunity.repository';
import type { DetectorInputRow, PricePoint, DetectorCandidate } from './detector-core';
import { detectFromBatch, referenceMovementPct, PRODUCTION_DETECTOR_CONFIG } from './detector-core';
import { legacyDetectFromBatch, LEGACY_DETECTOR_CONFIG } from './legacy-detector-core';
import { isLowOdds, pinnacleLedLowOddsThresholdPct, legacyLowOddsThresholdPct } from './low-odds-config';
import { legacyConfidence } from './legacy-confidence';

interface SnapshotRow {
  matchId: string;
  bookmaker: string;
  outcome: string;
  price: string | number | { toNumber(): number };
  capturedAt: Date;
  match: {
    externalId: string;
    sport: { slug: string };
  };
}

function toNumber(price: string | number | { toNumber(): number }): number {
  if (typeof price === 'number') return price;
  if (typeof price === 'string') return parseFloat(price);
  return price.toNumber();
}

/**
 * Four-track value detection over one shared snapshot read (zero extra API or
 * DB snapshot cost):
 *
 *   PINNACLE_LED          — shared pure core; 3% production + 2–3% shadow (unchanged)
 *   LEGACY                — reconstructed pre-rewrite model at >= 5% (unchanged)
 *   LOW_ODDS_PINNACLE_LED — odds [1.10, 2.20), edge below 3% with per-bucket
 *                           floors (low-odds-config.ts); claims rows that would
 *                           otherwise be silent shadow rows
 *   LOW_ODDS_LEGACY       — odds [1.10, 2.20), edge 3–5% with per-bucket floors
 *                           (1.30–1.50 disabled by measured −43% ROI)
 *
 * Ownership (one system per opportunity, first claim wins):
 *   Pinnacle family — per (match, bookmaker, outcome): production/shadow/low-odds
 *   keys mutually block re-claims across tiers and tracks.
 *   Legacy family — per (match, outcome): the owning track is the model of the
 *   most recent row; the other track is blocked permanently; the owner re-claims
 *   only after the 12h suppression window (legacy semantics).
 *
 * Conflict resolution (legacy family + low-odds pinnacle): at most ONE outcome
 * per match per batch (strongest edge wins); a candidate contradicting an
 * existing row's outcome on the same match is suppressed.
 */
export class ValueDetectionService {
  private readonly _prisma: PrismaClient;
  private readonly _repository: ValueOpportunityRepository;
  private readonly _logger: Logger;

  constructor(
    prisma: PrismaClient,
    repository: ValueOpportunityRepository,
    private readonly _maxAlertOdds: number,
    logger: Logger,
  ) {
    this._prisma = prisma;
    this._repository = repository;
    this._logger = logger.child({ service: 'ValueDetectionService' });
  }

  async detectForMatchExternalIds(
    matchExternalIds: readonly string[],
  ): Promise<ValueDetectionResult> {
    const startedAt = Date.now();

    if (matchExternalIds.length === 0) {
      return { matchesAnalyzed: 0, opportunitiesDetected: 0, legacyOpportunitiesDetected: 0, lowOddsOpportunitiesDetected: 0, shadowOpportunitiesDetected: 0, opportunitiesRejected: 0, opportunitiesSkipped: 0, durationMs: 0 };
    }

    const snapshots = await this._prisma.oddsSnapshot.findMany({
      where: {
        match: { externalId: { in: matchExternalIds as string[] } },
        market: 'H2H',
        isLive: false,
      },
      select: {
        matchId: true,
        bookmaker: true,
        outcome: true,
        price: true,
        capturedAt: true,
        match: {
          select: {
            externalId: true,
            sport: { select: { slug: true } },
          },
        },
      },
    }) as SnapshotRow[];

    if (snapshots.length === 0) {
      return { matchesAnalyzed: 0, opportunitiesDetected: 0, legacyOpportunitiesDetected: 0, lowOddsOpportunitiesDetected: 0, shadowOpportunitiesDetected: 0, opportunitiesRejected: 0, opportunitiesSkipped: 0, durationMs: Date.now() - startedAt };
    }

    // Group by matchId
    const byMatch = new Map<string, SnapshotRow[]>();
    for (const s of snapshots) {
      let arr = byMatch.get(s.matchId);
      if (!arr) { arr = []; byMatch.set(s.matchId, arr); }
      arr.push(s);
    }

    const existing = await this._prisma.valueOpportunity.findMany({
      where: { matchId: { in: [...byMatch.keys()] } },
      select: { matchId: true, bookmaker: true, outcome: true, isShadow: true, model: true, capturedAt: true },
    });

    // ── Pinnacle family state: per (match, bookmaker, outcome) ──
    // Tier-aware permanent dedup (production/shadow as before) plus the
    // LOW_ODDS_PINNACLE_LED track. Low-odds claims block both main tiers and
    // vice versa: one family member owns a triple forever (first claim wins).
    const existingProductionKeys = new Set<string>();
    const existingShadowKeys = new Set<string>();
    const existingLowOddsPinnacleKeys = new Set<string>();
    // Low-odds pinnacle contradiction guard: matchId → outcomes already owned.
    const lowOddsPinnacleOutcomes = new Map<string, Set<string>>();

    // ── Legacy family state: per (match, outcome) ──
    // Shared 12h suppression window + permanent cross-track ownership +
    // match-level outcome registry for contradiction suppression.
    const legacyLastCapturedAt = new Map<string, number>();
    const legacyOwner = new Map<string, string>(); // match|outcome → owning model
    const legacyMatchOutcomes = new Map<string, Set<string>>(); // matchId → outcomes

    for (const e of existing) {
      const tripleKey = `${e.matchId}|${e.bookmaker}|${e.outcome}`;
      if (e.model === 'PINNACLE_LED') {
        if (e.isShadow) existingShadowKeys.add(tripleKey);
        else existingProductionKeys.add(tripleKey);
      } else if (e.model === 'LOW_ODDS_PINNACLE_LED') {
        existingLowOddsPinnacleKeys.add(tripleKey);
        let outcomes = lowOddsPinnacleOutcomes.get(e.matchId);
        if (!outcomes) { outcomes = new Set(); lowOddsPinnacleOutcomes.set(e.matchId, outcomes); }
        outcomes.add(e.outcome);
      } else {
        // LEGACY or LOW_ODDS_LEGACY
        const pairKey = `${e.matchId}|${e.outcome}`;
        const t = e.capturedAt.getTime();
        const prior = legacyLastCapturedAt.get(pairKey);
        if (prior === undefined || t > prior) {
          legacyLastCapturedAt.set(pairKey, t);
          legacyOwner.set(pairKey, e.model);
        }
        let outcomes = legacyMatchOutcomes.get(e.matchId);
        if (!outcomes) { outcomes = new Set(); legacyMatchOutcomes.set(e.matchId, outcomes); }
        outcomes.add(e.outcome);
      }
    }

    const config = { ...PRODUCTION_DETECTOR_CONFIG, maxCandidateOdds: this._maxAlertOdds };
    // Legacy core runs with a 3% floor so it surfaces BOTH the main band (>=5%)
    // and the low-odds band (3–5%); the split happens below. Main legacy
    // semantics are unchanged: only >=5% candidates enter the LEGACY track.
    const legacyConfig = { ...LEGACY_DETECTOR_CONFIG, minEdgeThresholdPct: 3.0, maxCandidateOdds: this._maxAlertOdds };
    const LEGACY_MAIN_MIN_EDGE = LEGACY_DETECTOR_CONFIG.minEdgeThresholdPct; // 5.0

    let detected = 0;
    let legacyDetected = 0;
    let lowOddsDetected = 0;
    let detectedShadow = 0;
    let rejected = 0;
    let skipped = 0;
    const toInsert: ValueOpportunityInsert[] = [];

    for (const [matchId, matchSnapshots] of byMatch) {
      const latestCapturedAt = matchSnapshots.reduce(
        (max, s) => (s.capturedAt > max ? s.capturedAt : max),
        matchSnapshots[0].capturedAt,
      );
      const latestSnapshots = matchSnapshots.filter(
        s => s.capturedAt.getTime() === latestCapturedAt.getTime(),
      );
      const sport = latestSnapshots[0].match.sport.slug;

      // Reference-book price history (movement annotation input only).
      const referenceHistory = new Map<string, PricePoint[]>();
      for (const s of matchSnapshots) {
        if (s.bookmaker !== config.referenceBookmaker) continue;
        const price = toNumber(s.price);
        if (!(price > 1)) continue;
        let points = referenceHistory.get(s.outcome);
        if (!points) { points = []; referenceHistory.set(s.outcome, points); }
        points.push({ capturedAt: s.capturedAt, price });
      }
      const movement = (outcome: string, price: number, hours: number): number | null =>
        referenceMovementPct(referenceHistory.get(outcome), price, latestCapturedAt, hours);

      const batch: DetectorInputRow[] = latestSnapshots.map(s => ({
        bookmaker: s.bookmaker,
        outcome: s.outcome,
        price: toNumber(s.price),
      }));

      // ════ PINNACLE FAMILY ════
      const result = detectFromBatch(batch, config);

      for (const d of result.decisions) {
        this._decision(d.decision, { matchId, ...d.context });
        if (d.decision === 'REJECTED') rejected++;
        else skipped++;
      }

      const lowOddsPinnacleCandidates: DetectorCandidate[] = [];

      for (const candidate of result.candidates) {
        const { bookmaker, outcome, bookmakerOdds, fairOdds, fairProbability, edgePercentage, isShadow } = candidate;
        const key = `${matchId}|${bookmaker}|${outcome}`;

        // Low-odds ownership: a triple claimed by the low-odds track is never
        // re-claimed by the main tiers (one family member per opportunity).
        if (existingLowOddsPinnacleKeys.has(key)) {
          this._decision('SUPPRESSED', { matchId, bookmaker, outcome, reason: 'owned by LOW_ODDS_PINNACLE_LED' });
          skipped++;
          continue;
        }

        if (!isShadow) {
          // Production row: suppress only if a production row already exists.
          if (existingProductionKeys.has(key)) {
            this._decision('SUPPRESSED', { matchId, bookmaker, outcome, reason: 'production opportunity already recorded for this match/bookmaker/outcome' });
            skipped++;
            continue;
          }
          existingProductionKeys.add(key);
        } else {
          // Shadow-tier candidate: the LOW ODDS track may claim it instead.
          const lowOddsThreshold = pinnacleLedLowOddsThresholdPct(bookmakerOdds);
          if (lowOddsThreshold !== null && edgePercentage >= lowOddsThreshold) {
            if (!existingShadowKeys.has(key) && !existingProductionKeys.has(key)) {
              lowOddsPinnacleCandidates.push(candidate);
            } else {
              this._decision('SUPPRESSED', { matchId, bookmaker, outcome, model: 'LOW_ODDS_PINNACLE_LED', reason: 'triple already owned by main pinnacle tier' });
              skipped++;
            }
            continue; // never also stored as shadow
          }
          // Plain shadow row (unchanged behavior).
          if (existingShadowKeys.has(key) || existingProductionKeys.has(key)) {
            this._decision('SUPPRESSED', { matchId, bookmaker, outcome, reason: 'shadow or production opportunity already recorded for this match/bookmaker/outcome' });
            skipped++;
            continue;
          }
          existingShadowKeys.add(key);
        }

        this._decision(isShadow ? 'DETECTED_SHADOW' : 'DETECTED', {
          matchId, bookmaker, outcome,
          edgePct: edgePercentage.toFixed(2),
          candidateOdds: bookmakerOdds, fairOdds: fairOdds.toFixed(4), fairProb: fairProbability.toFixed(4),
          isShadow,
        });
        if (isShadow) detectedShadow++;
        else detected++;

        const latestReferencePrice = result.referencePrices!.get(outcome)!;
        toInsert.push({
          matchId, sport, bookmaker, outcome,
          bookmakerOdds, fairOdds, edgePercentage,
          consensusProbability: fairProbability,
          consensusBookmakers: [config.referenceBookmaker],
          capturedAt: latestCapturedAt,
          isShadow,
          pinnacleMove1h: movement(outcome, latestReferencePrice, 1),
          pinnacleMove6h: movement(outcome, latestReferencePrice, 6),
          pinnacleMove24h: movement(outcome, latestReferencePrice, 24),
          model: 'PINNACLE_LED',
        });
      }

      // LOW_ODDS_PINNACLE_LED — conflict resolution: strongest outcome only.
      if (lowOddsPinnacleCandidates.length > 0) {
        const strongest = lowOddsPinnacleCandidates.reduce((a, b) => (b.edgePercentage > a.edgePercentage ? b : a));
        for (const c of lowOddsPinnacleCandidates) {
          if (c !== strongest && c.outcome !== strongest.outcome) {
            this._decision('SUPPRESSED', { matchId, bookmaker: c.bookmaker, outcome: c.outcome, model: 'LOW_ODDS_PINNACLE_LED', reason: `conflicting outcome — kept strongest (${strongest.outcome} @ ${strongest.edgePercentage.toFixed(2)}%)` });
            skipped++;
          }
        }
        const ownedOutcomes = lowOddsPinnacleOutcomes.get(matchId);
        const accepted = lowOddsPinnacleCandidates.filter(c => c.outcome === strongest.outcome);
        if (ownedOutcomes && [...ownedOutcomes].some(o => o !== strongest.outcome)) {
          this._decision('SUPPRESSED', { matchId, outcome: strongest.outcome, model: 'LOW_ODDS_PINNACLE_LED', reason: 'contradicts an existing low-odds opportunity on this match' });
          skipped += accepted.length;
        } else {
          for (const c of accepted) {
            const key = `${matchId}|${c.bookmaker}|${c.outcome}`;
            if (existingLowOddsPinnacleKeys.has(key)) { skipped++; continue; }
            existingLowOddsPinnacleKeys.add(key);
            let outcomes = lowOddsPinnacleOutcomes.get(matchId);
            if (!outcomes) { outcomes = new Set(); lowOddsPinnacleOutcomes.set(matchId, outcomes); }
            outcomes.add(c.outcome);

            this._decision('DETECTED', {
              matchId, bookmaker: c.bookmaker, outcome: c.outcome, model: 'LOW_ODDS_PINNACLE_LED',
              edgePct: c.edgePercentage.toFixed(2), candidateOdds: c.bookmakerOdds,
            });
            lowOddsDetected++;

            const refPrice = result.referencePrices!.get(c.outcome)!;
            toInsert.push({
              matchId, sport, bookmaker: c.bookmaker, outcome: c.outcome,
              bookmakerOdds: c.bookmakerOdds, fairOdds: c.fairOdds, edgePercentage: c.edgePercentage,
              consensusProbability: c.fairProbability,
              consensusBookmakers: [config.referenceBookmaker],
              capturedAt: latestCapturedAt,
              isShadow: false,
              pinnacleMove1h: movement(c.outcome, refPrice, 1),
              pinnacleMove6h: movement(c.outcome, refPrice, 6),
              pinnacleMove24h: movement(c.outcome, refPrice, 24),
              model: 'LOW_ODDS_PINNACLE_LED',
            });
          }
        }
      }

      // ════ LEGACY FAMILY ════
      const legacyResult = legacyDetectFromBatch(batch, legacyConfig);
      for (const d of legacyResult.decisions) {
        this._logger.debug({ decision: d.decision, model: 'LEGACY', matchId, ...d.context }, `Legacy detection: ${d.decision}`);
      }

      // Split into tracks, then resolve conflicts family-wide: ONE outcome per
      // match per batch — the strongest edge wins (Legacy V2 cleanup).
      const familyCandidates = legacyResult.candidates
        .map(c => {
          if (c.edgePercentage >= LEGACY_MAIN_MIN_EDGE) return { candidate: c, track: 'LEGACY' as const };
          const threshold = legacyLowOddsThresholdPct(c.bookmakerOdds);
          if (isLowOdds(c.bookmakerOdds) && threshold !== null && c.edgePercentage >= threshold) {
            return { candidate: c, track: 'LOW_ODDS_LEGACY' as const };
          }
          return null;
        })
        .filter((x): x is { candidate: DetectorCandidate; track: 'LEGACY' | 'LOW_ODDS_LEGACY' } => x !== null);

      if (familyCandidates.length > 0) {
        const strongest = familyCandidates.reduce((a, b) => (b.candidate.edgePercentage > a.candidate.edgePercentage ? b : a));
        for (const fc of familyCandidates) {
          if (fc !== strongest) {
            this._decision('SUPPRESSED', { matchId, outcome: fc.candidate.outcome, model: fc.track, reason: `legacy-family conflict — kept strongest (${strongest.candidate.outcome} @ ${strongest.candidate.edgePercentage.toFixed(2)}%)` });
          }
        }

        const { candidate, track } = strongest;
        const pairKey = `${matchId}|${candidate.outcome}`;
        const matchOutcomes = legacyMatchOutcomes.get(matchId);
        const owner = legacyOwner.get(pairKey);
        const last = legacyLastCapturedAt.get(pairKey);

        if (matchOutcomes && [...matchOutcomes].some(o => o !== candidate.outcome)) {
          // Contradiction with an already-recorded legacy-family opportunity.
          this._decision('SUPPRESSED', { matchId, outcome: candidate.outcome, model: track, reason: 'contradicts an existing legacy-family opportunity on this match' });
        } else if (owner !== undefined && owner !== track) {
          // Cross-track ownership: the other legacy track owns this (match, outcome).
          this._decision('SUPPRESSED', { matchId, outcome: candidate.outcome, model: track, reason: `owned by ${owner}` });
        } else if (last !== undefined && latestCapturedAt.getTime() - last < legacyConfig.suppressionWindowMs) {
          this._decision('SUPPRESSED', { model: track, matchId, outcome: candidate.outcome, reason: 'legacy opportunity within 12h suppression window' });
        } else {
          legacyLastCapturedAt.set(pairKey, latestCapturedAt.getTime());
          legacyOwner.set(pairKey, track);
          let outcomes = legacyMatchOutcomes.get(matchId);
          if (!outcomes) { outcomes = new Set(); legacyMatchOutcomes.set(matchId, outcomes); }
          outcomes.add(candidate.outcome);

          const consensusBooks = [...new Set(
            latestSnapshots
              .filter(s => s.outcome === candidate.outcome && s.bookmaker !== legacyConfig.candidateBookmaker)
              .map(s => s.bookmaker),
          )];
          const move6h = movement(candidate.outcome, candidate.bookmakerOdds, 6);
          const confidence = legacyConfidence({
            consensusCount: consensusBooks.length,
            move6hPct: move6h,
            edgePct: candidate.edgePercentage,
          });

          this._decision('DETECTED', {
            model: track, matchId, outcome: candidate.outcome,
            edgePct: candidate.edgePercentage.toFixed(2),
            pinnacleOdds: candidate.bookmakerOdds, fairOdds: candidate.fairOdds.toFixed(4),
            confidence,
          });
          if (track === 'LEGACY') legacyDetected++;
          else lowOddsDetected++;

          toInsert.push({
            matchId, sport,
            bookmaker: legacyConfig.candidateBookmaker,
            outcome: candidate.outcome,
            bookmakerOdds: candidate.bookmakerOdds,
            fairOdds: candidate.fairOdds,
            edgePercentage: candidate.edgePercentage,
            consensusProbability: candidate.fairProbability,
            consensusBookmakers: consensusBooks,
            capturedAt: latestCapturedAt,
            isShadow: false,
            pinnacleMove1h: movement(candidate.outcome, candidate.bookmakerOdds, 1),
            pinnacleMove6h: move6h,
            pinnacleMove24h: movement(candidate.outcome, candidate.bookmakerOdds, 24),
            model: track,
            confidence,
          });
        }
      }
    }

    if (toInsert.length > 0) {
      await this._repository.insertMany(toInsert);
    }

    const durationMs = Date.now() - startedAt;

    this._logger.info({
      matchesAnalyzed: byMatch.size,
      opportunitiesDetected: detected,
      legacyOpportunitiesDetected: legacyDetected,
      lowOddsOpportunitiesDetected: lowOddsDetected,
      shadowOpportunitiesDetected: detectedShadow,
      opportunitiesRejected: rejected,
      opportunitiesSkipped: skipped,
      durationMs,
    }, 'Value detection complete');

    return {
      matchesAnalyzed: byMatch.size,
      opportunitiesDetected: detected,
      legacyOpportunitiesDetected: legacyDetected,
      lowOddsOpportunitiesDetected: lowOddsDetected,
      shadowOpportunitiesDetected: detectedShadow,
      opportunitiesRejected: rejected,
      opportunitiesSkipped: skipped,
      durationMs,
    };
  }

  private _decision(decision: ValueDetectionDecision, context: Record<string, unknown>): void {
    const level = decision === 'INVALID_DATA' ? 'warn' : 'debug';
    this._logger[level]({ decision, ...context }, `Value detection: ${decision}`);
  }
}
