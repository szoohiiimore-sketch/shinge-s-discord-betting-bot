# Sprint 12 — Value Detection Engine

**Date:** 2026-06-07  
**Scope:** Deterministic value bet detection from OddsSnapshot records; consensus fair-odds calculation; ValueOpportunity persistence; pipeline integration; idempotency guarantee

---

## 1. Current Architecture

The ingestion pipeline has two paths that produce `OddsSnapshot` records:

**Traditional (The Odds API):**
```
MatchIngestionWorker → sync-odds-for-sport job →
OddsSnapshotWorker → OddsSnapshotIngestionService → OddsSnapshot (createMany)
```

**Esports (PandaScore + OddsPapi):**
```
MatchIngestionWorker → sync-esports-game job →
EsportsOddsSnapshotWorker → EsportsOddsSnapshotIngestionService →
  PandaScore (match data) + OddsPapi v4 (odds data) → OddsSnapshot (createMany)
```

Both paths persist `OddsSnapshot` records to PostgreSQL via Prisma and return structured result objects to their respective workers. After persistence, no downstream value calculation exists — this sprint adds it.

---

## 2. Existing Data Flow

### OddsSnapshot model (current schema)
```
OddsSnapshot
  id         UUID (auto)
  matchId    UUID → Match.id
  bookmaker  String         (e.g. "pinnacle", "bet365")
  market     OddsMarket     (H2H | SPREADS | TOTALS)
  outcome    String         (team name string, e.g. "Cloud9")
  price      Decimal        (European decimal odds, e.g. 1.714)
  isMain     Boolean        (true for Pinnacle in esports path)
  isLive     Boolean        (false for pre-match snapshots)
  capturedAt DateTime       (set to now() at ingestion start — shared across all snapshots in one batch)
```

**Key invariant:** All snapshots produced by a single `ingestOddsForGame()` call share the same `capturedAt` value (set to `new Date()` at function entry). This is the temporal batch identifier used for deduplication.

### OddsPapi bookmakers (pre-Sprint 12)
Only `pinnacle` is fetched:
```typescript
ODDSPAPI_DEFAULTS.BOOKMAKERS = ['pinnacle']
```

For value detection to work, non-Pinnacle bookmakers are required for consensus. Sprint 12 adds `bet365` and `unibet` to the bookmakers list. OddsPapi's 404 response (no data for a bookmaker) is already handled gracefully — missing bookmaker data is skipped without error.

---

## 3. Value Detection Design

### Candidate bookmaker
**Pinnacle** — industry benchmark for sharp market efficiency. Pinnacle's lines move to reflect true probabilities faster than soft books. When Pinnacle offers higher odds than the consensus of soft bookmakers implies, it represents a potential value opportunity.

### Consensus bookmakers
All bookmakers **except Pinnacle** form the consensus market. For Sprint 12: `bet365` and `unibet`. Minimum required: 2 consensus bookmakers per outcome (configurable constant, default 2).

### Rejection rules (applied in order)

| Condition | Log decision |
|---|---|
| No Pinnacle snapshot for outcome | `INVALID_DATA` |
| Fewer than 2 consensus bookmaker snapshots | `INSUFFICIENT_MARKET_DATA` |
| Any consensus odds ≤ 1 | `INVALID_DATA` |
| Pinnacle odds ≤ 1 | `INVALID_DATA` |
| `consensusProbability` ≤ 0 or ≥ 1 | `INVALID_DATA` |
| Outcome string empty | `INVALID_DATA` |
| Edge < MIN_EDGE_THRESHOLD_PCT (5.0) | `REJECTED` |
| Edge ≥ MIN_EDGE_THRESHOLD_PCT | `DETECTED` → persist |

---

## 4. Fair Odds Methodology

**Step 1: Implied probability per consensus bookmaker**
```
implied_prob(bm) = 1 / bm.price
```

**Step 2: Consensus probability (arithmetic mean of implied probs)**
```
consensus_prob = Σ implied_prob(bm) / count(consensus_bms)
```

The arithmetic mean of implied probabilities is the standard no-vig consensus model. It is computationally simple, deterministic, and requires no weighting heuristics.

**Step 3: Fair odds**
```
fair_odds = 1 / consensus_prob
```

---

## 5. Edge Calculation

```
edge_pct = ((pinnacle_odds / fair_odds) - 1) × 100
```

A positive edge means Pinnacle is offering higher odds than the consensus fair price implies — i.e., Pinnacle is pricing the outcome as less likely than the soft books collectively believe.

**Example:**
```
Pinnacle: 2.10   (implied prob: 0.476)
bet365:   1.90   (implied prob: 0.526)
unibet:   1.95   (implied prob: 0.513)

consensus_prob = (0.526 + 0.513) / 2 = 0.5195
fair_odds      = 1 / 0.5195         = 1.925
edge_pct       = (2.10 / 1.925 - 1) × 100 = 9.09%  ← DETECTED (>5%)
```

Only positive edges are stored. Negative edge (Pinnacle worse than consensus) is silently ignored.

---

## 6. Database Changes

### New table: `value_opportunities`

```prisma
model ValueOpportunity {
  id                   String   @id @default(uuid()) @map("id") @db.Uuid
  matchId              String   @map("match_id") @db.Uuid
  sport                String   @map("sport")
  bookmaker            String   @map("bookmaker")
  outcome              String   @map("outcome")
  bookmakerOdds        Decimal  @map("bookmaker_odds")
  fairOdds             Decimal  @map("fair_odds")
  edgePercentage       Decimal  @map("edge_percentage")
  consensusProbability Decimal  @map("consensus_probability")
  consensusBookmakers  String[] @map("consensus_bookmakers")
  capturedAt           DateTime @map("captured_at")
  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  match Match @relation("MatchValueOpportunities", fields: [matchId], references: [id], onDelete: Restrict)

  @@unique([matchId, bookmaker, outcome, capturedAt])
  @@index([matchId])
  @@index([edgePercentage])
  @@index([capturedAt])
  @@index([createdAt])
  @@map("value_opportunities")
}
```

### Idempotency guarantee
The `@@unique([matchId, bookmaker, outcome, capturedAt])` constraint ensures that re-running value detection on the same snapshot batch (same `capturedAt`) cannot produce duplicate rows. `createMany({ skipDuplicates: true })` is used for persistence — conflicting rows are silently skipped.

### `Match` model update
```prisma
valueOpportunities ValueOpportunity[] @relation("MatchValueOpportunities")
```

---

## 7. Service Implementation Plan

### `ValueDetectionService` (`src/value-detection/value-detection.service.ts`)

```
Constructor:
  PrismaClient          — read OddsSnapshot records (via match.externalId join)
  ValueOpportunityRepository — write ValueOpportunity records
  Logger

Method:
  detectForMatchExternalIds(matchExternalIds: readonly string[]): Promise<ValueDetectionResult>

Algorithm:
  1. Query OddsSnapshot WHERE match.externalId IN (matchExternalIds) AND market = H2H AND isLive = false
     Include: match.externalId, match.sport.slug
  2. Group by matchId
  3. Per match: find max(capturedAt) = latest ingestion batch
  4. Filter to only snapshots at latest capturedAt
  5. Group by outcome
  6. Per outcome:
     a. Separate pinnacle vs consensus snapshots
     b. Apply rejection rules (see §3)
     c. Calculate consensus_prob, fair_odds, edge_pct
     d. If edge_pct >= MIN_EDGE_THRESHOLD_PCT: queue for persistence
  7. Persist all detected opportunities (createMany skipDuplicates)
  8. Return ValueDetectionResult
```

### `ValueOpportunityRepository` (`src/value-detection/value-opportunity.repository.ts`)

```
Constructor: PrismaClient, Logger
Method: insertMany(inputs: readonly ValueOpportunityInsert[]): Promise<{ inserted: number }>
  Uses: prisma.valueOpportunity.createMany({ data, skipDuplicates: true })
```

### Constants (no ENV variables)
```typescript
const MIN_EDGE_THRESHOLD_PCT = 5.0;    // minimum edge % to record as value
const MIN_CONSENSUS_BOOKMAKERS = 2;    // minimum non-Pinnacle bookmakers required
const CANDIDATE_BOOKMAKER = 'pinnacle'; // bookmaker being tested for value
```

No new environment variables are introduced. All bookmaker keys originate from `ODDSPAPI_DEFAULTS.BOOKMAKERS` (existing config). No new `ENV_CONFIG.md` entries are required.

---

## 8. Pipeline Integration

### Integration point: worker level

Value detection is called **after** odds snapshot persistence in each worker. Workers already receive the `matchExternalIds` from the job payload, which is passed directly to `ValueDetectionService`.

**`EsportsOddsSnapshotWorker.process()` change:**
```typescript
const result = await this._service.ingestOddsForGame(videogame, matchExternalIds);

// After persistence — detect value on freshly stored snapshots
if (result.oddsSnapshots.created > 0) {
  const detection = await this._valueDetectionService.detectForMatchExternalIds(matchExternalIds);
  this._logger.info({ videogame, detection }, 'Value detection complete');
}
```

**`OddsSnapshotWorker.process()` change:**
```typescript
const result = await this._service.ingestOddsForSport(sportKey, sport, matchExternalIds);

if (result.oddsSnapshots.created > 0) {
  const detection = await this._valueDetectionService.detectForMatchExternalIds(matchExternalIds);
  this._logger.info({ sportKey, detection }, 'Value detection complete');
}
```

**`ingestion-dependencies.ts` additions:**
```typescript
import { ValueDetectionService, ValueOpportunityRepository } from '@/value-detection';
const valueOpportunityRepository = new ValueOpportunityRepository(prisma, logger);
const valueDetectionService = new ValueDetectionService(prisma, valueOpportunityRepository, logger);
// Pass to both oddsSnapshotWorker and esportsOddsSnapshotWorker constructors
```

### No new scheduler
Value detection runs synchronously within the existing worker process chain. No new BullMQ queue, no new cron job.

---

## 9. OddsPapi Bookmakers Update

Updated `ODDSPAPI_DEFAULTS.BOOKMAKERS`:
```typescript
BOOKMAKERS: ['pinnacle', 'bet365', 'unibet'] as readonly string[]
```

OddsPapi v4 returns HTTP 404 when a bookmaker has no fixtures for the requested tournaments. This is already handled gracefully by `DefaultOddspapiClient` (logged as debug, not treated as error). If neither `bet365` nor `unibet` has esports data, the `ValueDetectionService` will correctly classify all opportunities as `INSUFFICIENT_MARKET_DATA` (fewer than 2 consensus bookmakers).

---

## 10. Structured Log Decisions

| Decision constant | Meaning | Log level |
|---|---|---|
| `DETECTED` | Edge ≥ 5%, opportunity persisted | `info` |
| `REJECTED` | Valid market but edge < 5% | `debug` |
| `INSUFFICIENT_MARKET_DATA` | < 2 consensus bookmakers | `debug` |
| `INVALID_DATA` | Bad odds values or zero probability | `warn` |

---

## 11. Validation Strategy

**TypeScript:** `npx tsc --noEmit` must produce 0 errors.

**Unit correctness:** Manual trace through the example in §5 — all arithmetic must match.

**Idempotency test:** Run `detectForMatchExternalIds` twice on the same data; `ValueOpportunity` count must not increase on the second run.

**End-to-end validation script (`validate:pipeline`):** Extended to include a Phase 6 that verifies:
- `ValueOpportunity` table is queryable
- Mock data with known edge values produces expected detected/rejected counts
- Second run with identical data produces zero new rows (idempotency)

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| OddsPapi may not return bet365/unibet data for all games | Graceful 404 handling already in client; `INSUFFICIENT_MARKET_DATA` classification prevents false positives |
| Pinnacle-only market → all opportunities rejected | Expected behavior; the engine requires multi-bookmaker data by design |
| `capturedAt` clock skew across workers | `capturedAt` is set per-call inside `ingestOddsForGame`, not per-job — no skew within a single call |
| Decimal precision in edge calculation | Prisma `Decimal` type used throughout; stored with full precision, not rounded |
| Migration fails on production | Migration is additive-only (new table + new relation); no existing data is modified |

---

## Implementation Results

### Files created
| File | Purpose |
|---|---|
| `src/value-detection/value-detection.types.ts` | Types: `ValueDetectionResult`, `ValueOpportunityInsert`, `ValueDetectionDecision` |
| `src/value-detection/value-detection.service.ts` | Core engine: consensus calculation, edge detection, persistence |
| `src/value-detection/value-opportunity.repository.ts` | `createMany(skipDuplicates)` persistence |
| `src/value-detection/index.ts` | Barrel export |
| `prisma/migrations/20260607154713_add_value_opportunities/migration.sql` | DB migration |

### Files modified
| File | Change |
|---|---|
| `prisma/schema.prisma` | Added `ValueOpportunity` model; added `valueOpportunities` relation on `Match` |
| `src/integrations/oddspapi/oddspapi.config.ts` | `BOOKMAKERS: ['pinnacle', 'bet365', 'unibet']` |
| `src/ingestion/workers/esports-odds-snapshot.worker.ts` | Injected `ValueDetectionService`; called after snapshot persistence |
| `src/ingestion/workers/odds-snapshot.worker.ts` | Injected `ValueDetectionService`; called after snapshot persistence |
| `src/ingestion/bootstrap/ingestion-dependencies.ts` | Instantiated `ValueOpportunityRepository` + `ValueDetectionService`; wired to both workers |
| `src/scripts/validate-esports-pipeline.ts` | Added Phase 6 (value detection) + Phase 7 (idempotency) |

### TypeScript
```
npx tsc --noEmit
→ 0 errors
```

### Database migration
```
prisma migrate dev --name add_value_opportunities
→ Migration 20260607154713_add_value_opportunities applied
→ Prisma Client regenerated
```

### Validation script
```
npm run validate:pipeline

  Phase 1 — PandaScore Ingestion     ✓ PASS
  Phase 2 — Database Match Query     ✓ PASS  (10 esports matches)
  Phase 3 — Match Correlation        ✓ PASS  (3/3 correlated)
  Phase 4 — OddsSnapshot Persistence ✓ PASS  (12 rows inserted)
  Phase 5 — DB Read-Back             ✓ PASS  (6 rows verified)
  Phase 6 — Value Detection          ✓ PASS  (1 opportunity detected, 1 rejected)
  Phase 7 — Idempotency              ✓ PASS  (row count unchanged on second run)

  OVERALL: PASS — full pipeline verified end-to-end
```

### Phase 6 math verification
```
Test data (home team outcome):
  Pinnacle: 3.50   fair_odds = 1 / mean(1/2.50, 1/2.60)
                            = 1 / mean(0.400, 0.385)
                            = 1 / 0.3925
                            = 2.548
  edge = (3.50 / 2.548 - 1) × 100 = 37.4%  → DETECTED ✓

Test data (away team outcome):
  Pinnacle: 1.35   fair_odds = 1 / mean(1/1.55, 1/1.58)
                            = 1 / mean(0.645, 0.633)
                            = 1 / 0.639
                            = 1.564
  edge = (1.35 / 1.564 - 1) × 100 = -13.7%  → negative, not stored ✓
  (Pinnacle is worse than consensus here — correctly classified as REJECTED)
```

---

## Final Verdict

**PASS**

The Value Detection Engine is fully implemented, tested, and operational:

- `ValueOpportunity` table created and migrated to Neon PostgreSQL
- `ValueDetectionService` correctly applies consensus methodology and edge formula
- `MIN_EDGE_THRESHOLD_PCT = 5.0` enforced — low-edge opportunities rejected
- `MIN_CONSENSUS_BOOKMAKERS = 2` enforced — single-book markets rejected
- Idempotency confirmed via `createMany({ skipDuplicates: true })` + `@@unique` constraint
- Integrated into both `EsportsOddsSnapshotWorker` and `OddsSnapshotWorker`
- Value detection failure is isolated (catches error, logs, does not fail the parent job)
- TypeScript: 0 errors
- Validation: 7/7 phases PASS
