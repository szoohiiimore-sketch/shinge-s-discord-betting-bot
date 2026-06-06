# Sprint 4 — Phase 2A: Ingestion Services
# Service Layer Review

**Date:** 2026-06-06
**Scope:** `src/ingestion/services/` only
**Reviewed files:**
- `src/ingestion/services/types.ts`
- `src/ingestion/services/reference-data-ingestion.service.ts`
- `src/ingestion/services/match-ingestion.service.ts`
- `src/ingestion/services/odds-snapshot-ingestion.service.ts`
- `src/ingestion/services/index.ts`

**Out of scope:** Repository implementations, integration clients, mappers, workers, queue configuration.

---

## Executive Summary

| Dimension | Score | Verdict |
|-----------|-------|---------|
| Responsibility alignment | 97/100 | PASS |
| Dependency boundaries | 98/100 | PASS |
| Mapper ownership | 95/100 | PASS |
| Repository usage | 96/100 | PASS |
| Orchestration correctness | 94/100 | PASS |
| **Overall** | **96/100** | **PASS** |

The service layer is well-structured and architecturally sound. All three services are correctly scoped, correctly wired, and implement the orchestration logic specified by the architecture design. Five findings are raised — none are blocking. Three are minor code quality issues; two are architectural observations worth recording.

---

## Findings

### S1 — `aggregateOutcome` duplicated across two service files

**Severity:** Minor (code quality)
**Files:**
- `src/ingestion/services/reference-data-ingestion.service.ts:9–21`
- `src/ingestion/services/match-ingestion.service.ts:25–37`

**Observation:**
The `aggregateOutcome` function is defined identically in both service files. It is not exported, not parameterised, and the implementations are byte-for-byte identical. Any future change (e.g., adding a new `EntityWriteAction` value) must be applied in both places.

**Recommended fix:**
Extract to `src/ingestion/services/service.utils.ts` and import from both files. The function signature is already typed against the contracts layer, so extraction requires no architectural change.

**Impact if deferred:** Maintenance-only risk. No correctness issue in V1.

---

### S2 — TeamLeague write outcomes are silently discarded

**Severity:** Minor (observability gap)
**Files:**
- `src/ingestion/services/match-ingestion.service.ts:155` (`ingestTraditionalSport`)
- `src/ingestion/services/match-ingestion.service.ts:290` (`ingestEsportsGame`)

**Observation:**
Both `ingestTraditionalSport` and `ingestEsportsGame` call `this._teamLeagueRepository.upsertMany(canonicalTeamLeagues)` but discard the return value — the call is awaited for its side effects only:

```typescript
await this._teamLeagueRepository.upsertMany(canonicalTeamLeagues);
```

The `TraditionalMatchIngestionResult` and `EsportsMatchIngestionResult` types have no `teamLeagues: EntityWriteOutcome` field. A run that creates 50 TeamLeague junction records is indistinguishable from a run that creates 0.

**Context:**
This is a deliberate design choice at the type level (the result types do not include `teamLeagues`). TeamLeague is a junction table, not a primary entity, and its counts are derivable from the match counts (one match creates two TeamLeague records). The decision to exclude it from result reporting is defensible for V1.

**Recommended fix if desired:** Add `readonly teamLeagues: EntityWriteOutcome` to both result interfaces and assign the aggregated outcome in each method. This is an additive change with no breaking effects on consumers.

**Impact if deferred:** Worker-level telemetry will not surface TeamLeague write counts. Not a correctness issue.

---

### S3 — `capturedAt` in `OddsSnapshotIngestionService` is set before the API call

**Severity:** Minor (timestamp precision)
**File:** `src/ingestion/services/odds-snapshot-ingestion.service.ts:90–94`

**Observation:**
`capturedAt` is set to `new Date()` on line 90, before the `getOdds` call on line 92. The API call takes ~200–500ms. All `CanonicalOddsSnapshot` records produced from this call will carry a `capturedAt` that is 200–500ms earlier than when the odds data was actually received.

**Contrast with `MatchIngestionService`:**
In `ingestTraditionalSport`, `capturedAt` is also set before writes (line 112) but after the API call (line 111) — the timestamp is accurate to within processing time. In `OddsSnapshotIngestionService`, the ordering is reversed.

**Recommended fix:**
Move the `capturedAt = new Date()` assignment to after the `rawEvents` response is received:

```typescript
const rawEvents = await this._oddsApiClient.getOdds(sportKey, { eventIds: apiEventIds.join(',') });
const capturedAt = new Date();  // after the response is received
```

**Impact if deferred:** OddsSnapshot timestamps are systematically ~300ms early per batch. For V1 time-series analysis this is not material.

---

### S4 — Sport entity is written redundantly on every `ingestTraditionalSport` call

**Severity:** Observation (performance / design awareness)
**File:** `src/ingestion/services/match-ingestion.service.ts:135, 151`

**Observation:**
Every event in a single `ingestTraditionalSport` call belongs to the same sport (the call is scoped to one `sportKey`). The service extracts one `CanonicalSport` per plan:

```typescript
const canonicalSports = plans.map(p => p.sport);
```

For 40 EPL events, this produces an array of 40 identical `CanonicalSport` objects (same slug, same name, same source). These are passed to `SportRepository.upsertMany`, which deduplicates them at the repository layer to a single upsert.

The comment in `ingestTraditionalSport` at line 97–99 correctly justifies this design: the sport upsert makes the service self-contained, reducing coupling to the reference data job's execution order. Deduplication is handled at the right layer. This is not a bug.

**Recorded as an observation, not a finding.** The deduplication boundary is correct. If the single-sport-per-call assumption ever changes (e.g., a batch endpoint), the current pattern handles it without modification.

---

### S5 — `errors: []` field is always empty; its presence creates a false contract expectation

**Severity:** Observation (contract clarity)
**Files:** All three service implementations; `src/ingestion/services/types.ts`

**Observation:**
All four result types include `readonly errors: readonly SyncError[]`. In all three services, this field is always returned as `[]`. Errors propagate exclusively by exception — a throwing `upsertMany` or `getOdds` call will propagate uncaught to the worker. The `errors` field is never populated.

This creates a contractual ambiguity: a consumer reading the type definition would assume partial errors could be returned, but the actual implementation is all-or-nothing (throw or succeed).

**Context:**
This is a known, intentional design choice for V1. The architecture design notes that workers should handle thrown errors at the job level. The `errors` field is reserved for a future pass where partial batch failures could be accumulated rather than aborting the job entirely.

**Recommended fix (when the time comes):**
When partial failure accumulation is implemented, the `errors` array will become load-bearing. Until then, consider documenting the "always empty in V1" constraint with a comment on the field in `types.ts`, so future implementers don't assume partial error handling already exists.

**Impact if deferred:** Null observability gap for partial failures. Not a V1 concern.

---

## Detailed Review by Dimension

### Service Responsibilities

**ReferenceDataIngestionService:** Single method (`sync`), single concern — fetches sports list from The Odds API, derives `CanonicalSport` and `CanonicalLeague` records, writes them in dependency order. No match data, no odds data, no team data. Scope is exactly correct per §4 of the architecture design.

**MatchIngestionService:** Two independent entry points (`ingestTraditionalSport`, `ingestEsportsGame`) sharing one service because both write the same five entity types (Sport → League → Team → Match → TeamLeague) in the same dependency order. The choice to colocate rather than split is defensible — the shared write pattern outweighs the argument for separation by source. No odds data, no Discord, no analysis logic.

**OddsSnapshotIngestionService:** Single method (`ingestOddsForSport`), single concern — fetches odds for a filtered set of match IDs, maps to `CanonicalOddsSnapshot`, bulk-inserts. No entity upserts, no match writes, no queue enqueue. Scope is exactly correct.

**Verdict:** All three services have correctly bounded responsibilities. No cross-concern leakage observed.

---

### Dependency Boundaries

All constructor dependencies are interface types (`import type { ... }`), with one deliberate exception: `OddsApiEventMapper` is imported as a value (not a type) in both `match-ingestion.service.ts:3` and `odds-snapshot-ingestion.service.ts:2`. This is the only direct dependency on a concrete class in the services layer.

The exception is correctly justified: `OddsApiEventMapper` requires a `CanonicalSport` argument at construction time, making singleton injection impossible. The services instantiate it per-call (`new OddsApiEventMapper(sport)`) with the sport provided by the caller. This is documented in comments at the instantiation site in both services.

No direct `PrismaClient` usage. No BullMQ imports. No Discord imports. No HTTP clients instantiated within services.

**Verdict:** Dependency boundaries are correct. The single concrete-class dependency is justified and documented.

---

### Mapper Ownership

| Mapper | Usage Pattern | Correct? |
|--------|--------------|----------|
| `OddsApiSportMapper` | Injected singleton, called per active sport entry | Yes |
| `OddsApiEventMapper` | Instantiated per service method call with `CanonicalSport` | Yes |
| `PandascoreMatchMapper` | Injected singleton (`_pandascoreMapper`), called per match | Yes |

`OddsApiSportMapper` does not need per-call state — all sport entries map with the same stateless rules — so singleton injection is appropriate.

`OddsApiEventMapper` needs `CanonicalSport` at construction, which is only known at call time (derived from the sport key being processed). Per-call instantiation (`new OddsApiEventMapper(sport)`) is the correct pattern. The alternative — injecting a factory — would add indirection without benefit.

`PandascoreMatchMapper` is stateless and injected as a singleton, consistent with the mapper contract.

**Verdict:** Mapper ownership is correctly distributed. No mapper is used outside its intended scope.

---

### Repository Usage

**Write dependency order:** Both `ingestTraditionalSport` and `ingestEsportsGame` enforce the required write order: Sport → League → Team → Match → TeamLeague. Each step is `await`ed sequentially before the next begins, preserving FK integrity.

**Repository interfaces only:** All repository fields are declared as interface types from `@/ingestion/repositories/contracts`. No concrete repository class is referenced. Constructor parameter types are all interfaces.

**Correct repositories per service:**
- `ReferenceDataIngestionService`: `SportRepository`, `LeagueRepository` — no others needed
- `MatchIngestionService`: All five match-tier repositories — all needed
- `OddsSnapshotIngestionService`: `OddsSnapshotRepository` only — correct; the service never writes entity records

**Return value handling:** Repository results are assigned and aggregated via `aggregateOutcome` for all entity types except TeamLeague (see S2). `TeamLeagueRepository.upsertMany` is called for its side effects only.

**Verdict:** Repository usage is correct. Write ordering is enforced. Interface types maintained throughout.

---

### Orchestration Correctness

**Near-term match window (`ingestTraditionalSport`):**
`NEAR_TERM_WINDOW_MS = 48 * 60 * 60 * 1000` at module level (line 21). The cutoff is computed as `capturedAt + 48h`. Matches are filtered by `p.match.startTime <= cutoff`. This correctly identifies matches starting within the next 48 hours. The result `nearTermMatchExternalIds` contains `"oa:"`-prefixed IDs, which is what the odds worker expects.

**PandaScore concurrent fetch and deduplication (`ingestEsportsGame`):**
Upcoming and running matches are fetched concurrently via `Promise.all`. Deduplication by `m.id` (numeric PandaScore match ID) is applied before mapping. The deduplication correctly handles the race where a match transitions from upcoming to running between the two API calls.

**Null plan handling (`ingestEsportsGame`):**
The null-return from `PandascoreMatchMapper.toIngestionPlan` is checked for each match and counted in `skippedMatches`. A guard at line 254–265 returns an empty result if all plans are skipped (no writes attempted). Correct.

**Terminal match guard (`ingestOddsForSport`):**
The guard at lines 133–143 discards `CanonicalOddsSnapshot` records for matches with status `FINISHED`, `CANCELLED`, or `POSTPONED` before calling `insertMany`. This correctly implements the architecture §7.9 requirement at the service layer.

**Prefix stripping (`ingestOddsForSport`):**
The `"oa:"` prefix is stripped from match external IDs before joining into the `eventIds` query parameter (lines 69–71). Non-`"oa:"`-prefixed IDs are filtered out (esports matches have no odds source). The guard on `allowedExternalIds` (line 121) cross-checks the mapper's output `externalId` against the original (prefixed) IDs, since the mapper produces `"oa:"-prefixed` externalIds and `matchExternalIds` is also prefixed. The set membership check is correct.

**Early returns:** All three services have explicit early-return branches for empty inputs (no active sports, no events, no matches, no match IDs). These return zero-count outcomes without making any API or DB calls. Correct.

**Verdict:** Orchestration logic is correct for all three services. All architecture constraints are enforced.

---

## Readiness Assessment

| Dimension | Status |
|-----------|--------|
| Service responsibilities | Ready |
| Dependency boundaries | Ready |
| Mapper ownership | Ready |
| Repository usage | Ready |
| Orchestration correctness | Ready |
| **Overall** | **READY** |

The service layer is ready for the worker layer (Phase 2B) to be built on top of it. The deferred findings (S1–S5) are non-blocking. S1 (utility duplication) and S3 (timestamp ordering) are the only items worth fixing before Phase 2B; S2, S4, and S5 can remain deferred.

---

## Appendix: Finding Summary

| ID | Severity | Description | File | Blocking? |
|----|----------|-------------|------|-----------|
| S1 | Minor | `aggregateOutcome` duplicated in two service files | `reference-data-ingestion.service.ts:9`, `match-ingestion.service.ts:25` | No |
| S2 | Minor | TeamLeague write outcomes not captured in result types | `match-ingestion.service.ts:155, 290` | No |
| S3 | Minor | `capturedAt` set before API call in odds snapshot service | `odds-snapshot-ingestion.service.ts:90` | No |
| S4 | Observation | Sport written N times per batch (deduplicated at repository layer) | `match-ingestion.service.ts:135` | No |
| S5 | Observation | `errors: []` always empty; field reserves space for future partial failure accumulation | `types.ts`, all three services | No |
