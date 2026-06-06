import type { OddsApiClient } from '@/integrations/the-odds-api';
import { OddsApiEventMapper } from '@/ingestion/mappers';
import type { CanonicalSport, CanonicalOddsSnapshot, EntityWriteOutcome } from '@/ingestion/contracts';
import type { OddsSnapshotRepository } from '@/ingestion/repositories/contracts';
import type { Logger } from '@/lib/logger';
import type { OddsSnapshotIngestionResult } from './types';

// "oa:" prefix used for The Odds API match external IDs (Match.externalId = "oa:{event_uuid}")
const OA_EXTERNAL_ID_PREFIX = 'oa:';

/**
 * Orchestrates OddsSnapshot ingestion from The Odds API.
 *
 * Called by the sync-odds-for-sport worker after the match-level ingestion job has
 * written the Match records. Fetches a filtered odds response using the provided
 * match external IDs, maps each bookmaker/market/outcome triple to a CanonicalOddsSnapshot,
 * and bulk-inserts the results.
 *
 * OddsSnapshot records are always appended — never updated or deleted.
 * Every call produces a new time-series entry per (matchId, bookmaker, market, outcome).
 *
 * Architecture constraints enforced here:
 * - Only "oa:"-prefixed match IDs are processed (The Odds API source domain only)
 * - Snapshots for FINISHED, CANCELLED, or POSTPONED matches are discarded (§7.9)
 */
export class OddsSnapshotIngestionService {
  private readonly _oddsApiClient: OddsApiClient;
  private readonly _oddsSnapshotRepository: OddsSnapshotRepository;
  private readonly _logger: Logger;

  constructor(
    oddsApiClient: OddsApiClient,
    oddsSnapshotRepository: OddsSnapshotRepository,
    logger: Logger,
  ) {
    this._oddsApiClient = oddsApiClient;
    this._oddsSnapshotRepository = oddsSnapshotRepository;
    this._logger = logger.child({ service: 'OddsSnapshotIngestionService' });
  }

  /**
   * Fetches and inserts OddsSnapshot records for the provided match external IDs.
   *
   * Requires the CanonicalSport so an OddsApiEventMapper can be constructed —
   * the /odds response does not carry the sport group field needed to derive Sport.slug.
   *
   * Only "oa:"-prefixed matchExternalIds are processed. Any other prefixes are
   * ignored (esports matches have no odds source in V1).
   *
   * The API is called with an eventIds filter, limiting the response to the
   * requested matches and reducing quota consumption.
   */
  async ingestOddsForSport(
    sportKey: string,
    sport: CanonicalSport,
    matchExternalIds: readonly string[],
  ): Promise<OddsSnapshotIngestionResult> {
    const startedAt = Date.now();

    if (matchExternalIds.length === 0) {
      return {
        oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
        errors: [],
        durationMs: 0,
      };
    }

    // Strip the "oa:" prefix to recover the original event UUIDs the API expects
    const apiEventIds = matchExternalIds
      .filter(id => id.startsWith(OA_EXTERNAL_ID_PREFIX))
      .map(id => id.slice(OA_EXTERNAL_ID_PREFIX.length));

    if (apiEventIds.length === 0) {
      this._logger.warn(
        { matchExternalIds },
        'No Odds API match IDs in batch (expected "oa:"-prefixed IDs) — skipping',
      );
      return {
        oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
        errors: [],
        durationMs: 0,
      };
    }

    this._logger.info(
      { sportKey, matchCount: apiEventIds.length },
      'Starting odds snapshot ingestion',
    );

    const capturedAt = new Date();

    const rawEvents = await this._oddsApiClient.getOdds(sportKey, {
      eventIds: apiEventIds.join(','),
    });

    this._logger.debug(
      { sportKey, requestedCount: apiEventIds.length, returnedCount: rawEvents.length },
      'Fetched odds from The Odds API',
    );

    if (rawEvents.length === 0) {
      return {
        oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    // OddsApiEventMapper is constructed per-sport (sport slug is needed for the match plan)
    const mapper = new OddsApiEventMapper(sport);

    // The set of requested external IDs for guard-against API returning unexpected events
    const allowedExternalIds = new Set(matchExternalIds);

    const snapshots: CanonicalOddsSnapshot[] = [];

    for (const raw of rawEvents) {
      const plan = mapper.toIngestionPlan(raw, capturedAt);

      // Guard: API should only return requested events, but be defensive
      if (!allowedExternalIds.has(plan.match.externalId)) {
        this._logger.debug(
          { externalId: plan.match.externalId },
          'Skipping event not in requested set',
        );
        continue;
      }

      // Architecture §7.9: do not insert snapshots for terminal matches.
      // The Odds API /odds endpoint does not return FINISHED/CANCELLED/POSTPONED
      // directly, but inferred status (from commence_time) may produce LIVE, and
      // this guard future-proofs against any source that might.
      if (
        plan.match.status === 'FINISHED' ||
        plan.match.status === 'CANCELLED' ||
        plan.match.status === 'POSTPONED'
      ) {
        this._logger.debug(
          { externalId: plan.match.externalId, status: plan.match.status },
          'Skipping odds snapshots for terminal match',
        );
        continue;
      }

      snapshots.push(...plan.oddsSnapshots);
    }

    if (snapshots.length === 0) {
      this._logger.info({ sportKey }, 'No odds snapshots to insert after filtering');
      return {
        oddsSnapshots: { created: 0, updated: 0, skipped: 0 },
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    const insertResult = await this._oddsSnapshotRepository.insertMany(snapshots);

    const oddsSnapshots: EntityWriteOutcome = {
      created: insertResult.inserted,
      updated: 0,
      skipped: 0,
    };

    const durationMs = Date.now() - startedAt;

    this._logger.info(
      { sportKey, oddsSnapshots, durationMs },
      'Odds snapshot ingestion complete',
    );

    return {
      oddsSnapshots,
      errors: [],
      durationMs,
    };
  }
}
