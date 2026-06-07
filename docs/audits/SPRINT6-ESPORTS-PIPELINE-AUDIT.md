# Sprint 6 — Esports Odds Pipeline Audit

**Audit Date:** 2026-06-07  
**Auditor:** AI-assisted code review  
**Scope:** End-to-end esports odds ingestion pipeline  

---

## Executive Summary

The esports odds ingestion pipeline has been implemented across 12 new files and 17 modified files. The architecture is sound and the code compiles cleanly. However, the pipeline **cannot function in production** due to missing runtime registration. Specifically:

1. **No repeatable BullMQ jobs are registered** — the `sync-esports-game` and `sync-esports-odds` jobs will never fire automatically
2. **Worker processors are never connected** to BullMQ Workers — `bootstrapIngestion()` returns Processor functions, but `app.ts` never assigns them
3. **OddsPapi API details are unverified** — the endpoint path, auth header, and response shape may not match the actual API

Additionally, the PandaScore match data flow cannot fully succeed because `DefaultPandascoreClient` does **not handle pagination** in `getUpcomingMatches()` and `getRunningMatches()`. PandaScore returns paginated responses (50 items/page by default); only the first page is collected.

---

## Architecture Overview

```
PandaScore API
    │
    ▼
DefaultPandascoreClient          (no pagination — only first page)
    │
    ▼
MatchIngestionService.ingestEsportsGame(videogame)
    │
    ├─ PandaScore: getUpcomingMatches + getRunningMatches
    ├─ Upserts: Sport / League / Team / Match / TeamLeague
    └─ Returns: EsportsMatchIngestionResult
                 + nearTermMatchExternalIds  ← "ps:"-prefixed IDs
    │
    ▼
MatchIngestionWorker._handleEsportsGame
    │
    ├─ ODDSPAPI_SUPPORTED_GAMES check
    ├─ Redis cooldown check (4h)
    ├─ Enqueue: oddsFetchQueue.add('sync-esports-odds', ...)
    └─ Set Redis cooldown key
    │
    ▼
odds-fetch queue (BullMQ — processor: createOddsFetchProcessor)
    │
    ▼
EsportsOddsSnapshotWorker.process(job)
    │
    ├─ QuotaExhaustedError → graceful empty result
    ├─ Other errors → throw (BullMQ retry)
    └─ Normal path:
         │
         ▼
    EsportsOddsSnapshotIngestionService.ingestOddsForGame()
         │
         ├─ Filter "ps:" IDs
         ├─ MatchRepository.findManyWithTeamsByExternalIds()
         ├─ ResilientOddspapiClient.getOddsForGame()
         │    ├─ OddspapiQuotaTracker.incrementAndCheck()  (Lua atomic INCR)
         │    ├─ Hard limit check → QuotaExhaustedError
         │    ├─ Soft limit check → log warning
         │    └─ DefaultOddspapiClient.getOddsForGame()    (1 HTTP call)
         │
         ├─ correlateMatch() per OddsPapi match:
         │    ├─ Time tolerance ±30min
         │    ├─ Exact match: normalized + aliased team names
         │    └─ Substring match: MIN_LEN=4 guard
         │
         ├─ Build CanonicalOddsSnapshot[] per (bookmaker, outcome)
         └─ OddsSnapshotRepository.insertMany(snapshots)
              │
              └─ Prisma oddsSnapshot.createMany()
```

---

## End-to-End Flow Verification

### Step 1: PandaScore Match → DB Match

| Check | Status | Details |
|---|---|---|
| `getUpcomingMatches(videogame)` fetches data | ✅ | Calls `/{videogame}/matches/upcoming` |
| `getRunningMatches(videogame)` fetches data | ✅ | Calls `/{videogame}/matches/running` |
| PandaScore pagination handled | ❌ **BLOCKER** | `getUpcomingMatches` does not paginate — only returns first 50 results |
| Dead code `getPastMatches` not called | ✅ | Only upcoming + running are used |
| Match deduplication between both lists | ✅ | `Set<number>` dedup by match ID |
| TBD opponents handled gracefully | ✅ | `PandascoreMatchMapper.toIngestionPlan()` returns null → `skippedMatches++` |
| Sport upsert | ✅ | By `slug` (unique) |
| League upsert | ✅ | By `(sportId, externalId)` |
| Team upsert | ✅ | By `(sportId, externalId)` — "ps:"-prefixed from PandaScore |
| Match upsert | ✅ | By `externalId` (globally unique) |
| TeamLeague upsert | ✅ | By `(teamId, leagueId)` |
| `nearTermMatchExternalIds` calculated | ✅ | From `plans` array, 48h window, no lower bound |

### Step 2: Match → Odds Job Enqueue

| Check | Status | Details |
|---|---|---|
| Supported game check | ✅ | `ODDSPAPI_SUPPORTED_GAMES.has(videogame)` |
| Redis cooldown check | ✅ | `GET {env}:esports-odds-cooldown:{game}` |
| Cooldown expiry logic | ✅ | `cooldownRemainingMs <= 0` |
| BullMQ `add()` with jobId dedup | ✅ | `jobId: 'sync-esports-odds:{videogame}'` |
| 5-second delay before odds job | ✅ | `delay: 5000` |
| Redis cooldown key SET after enqueue | ✅ | With 14400s TTL |
| Environment prefix for Redis key | ⚠️ | Hardcoded `'dev'` — should come from config |
| `attempts: 2` on odds job | ✅ | 1 retry maximum |
| Fixed backoff 30s | ✅ | |

### Step 3: Esports Odds Processing

| Check | Status | Details |
|---|---|---|
| Worker receives correct payload type | ✅ | `Job<SyncEsportsOddsJobData>` |
| "ps:" ID filtering | ✅ | `id.startsWith('ps:')` |
| DB match lookup | ✅ | `findManyWithTeamsByExternalIds(psIds)` |
| Game key translation | ✅ | `PANDASCORE_TO_ODDSPAPI_KEY[videogame]` |
| OddsPapi API call | ❌ **RISK** | Endpoint `/v2/odds?game={key}` — UNVERIFIED against real API |
| OddsPapi auth header | ❌ **RISK** | `X-Api-Key` header — UNVERIFIED against real API |
| Quota atomic INCR | ✅ | Lua script: `INCR` + conditional `EXPIRE` |
| Quota hard limit enforcement | ✅ | `> HARD_LIMIT` → `decrement()` + `QuotaExhaustedError` |
| Quota soft limit warning | ✅ | `>= SOFT_LIMIT` → `logger.warn()` |
| 429 → `forceExhaust()` | ✅ | Sets Redis counter to HARD_LIMIT |
| Team name normalization | ✅ | Lowercase + non-alphanumeric removal |
| Alias resolution | ✅ | 8 aliases → `resolveAlias()` |
| Time tolerance ±30min | ✅ | |
| Exact match correlation | ✅ | Normalized + aliased comparison |
| Substring match with MIN_LEN=4 | ✅ | Prevents "t1" false positive |
| Unmatched match logging | ✅ | `logger.debug` with team name pairs |
| `isMain` selection | ⚠️ | Hardcoded `bookmaker.key === 'pinnacle'` — may not always be present |
| OddsSnapshot `outcome` field | ❌ **RISK** | Uses `outcome.name` from OddsPapi — which may be `"home"`/`"away"` labels, not team names. The `outcome` field in `OddsSnapshot` schema matches data from The Odds API (team name strings). If OddsPapi returns `"home"`/`"away"`, this is inconsistent with existing data. |
| Batch insert via `createMany` | ✅ | |

### Step 4: Runtime Registration

| Check | Status | Details |
|---|---|---|
| Repeatable jobs scheduled | ❌ **PRODUCTION BLOCKER** | No `Queue.add()` with `repeat` option anywhere in codebase |
| Worker processors connected to Workers | ❌ **PRODUCTION BLOCKER** | `createMatchFetchProcessor` and `createOddsFetchProcessor` are returned to caller but never assigned to BullMQ Worker instances |
| Queue names match registrations | ✅ | All constants match across files |
| Queue name in odds-fetch processor | ✅ | `SYNC_ESPORTS_ODDS` case present |
| Match-fetch processor dispatches correctly | ✅ | 3 job names → 2 workers |
| Odds-fetch processor dispatches correctly | ✅ | 2 job names → 2 workers |
| DI wiring in bootstrap | ✅ | All instances created with correct constructor params |

---

## Production Blockers

| # | Blocker | Severity | File | Details |
|---|---|---|---|---|
| 1 | **No repeatable jobs registered** | **CRITICAL** | Not implemented anywhere | `sync-esports-game` will never fire automatically. No BullMQ repeatable job configuration exists in `app.ts`, `main.ts`, or any ingestion file. |
| 2 | **Processors never connected to Workers** | **CRITICAL** | `src/lib/app/app.ts` | `bootstrapIngestion()` returns processors, but they are never assigned to the BullMQ Workers. The Workers still use `placeholderProcessor` from `worker-factory.ts`. |
| 3 | **PandaScore pagination not implemented** | **HIGH** | `src/integrations/pandascore/pandascore.client.ts` | `getUpcomingMatches()` and `getRunningMatches()` do not handle pagination. Only first 50 results are fetched. Missing matches will never be ingested. |

---

## High Risks

| # | Risk | Severity | Details |
|---|---|---|---|
| 1 | **OddsPapi `/v2/odds` endpoint may be wrong** | HIGH | The endpoint path and auth header (`X-Api-Key`) were marked with ⚠️ VERIFY in the design plan. If incorrect, all OddsPapi calls return errors. |
| 2 | **OddsPapi `outcome` field may contain labels, not team names** | HIGH | If OddsPapi returns `"home"`/`"away"` instead of team names, the `outcome` field in `OddsSnapshot` will contain labels. This is inconsistent with traditional odds snapshots (which contain actual team name strings). |

---

## Missing Implementations

| # | Feature | Impact | File |
|---|---|---|---|
| 1 | Repeatable BullMQ job registration | Pipeline never fires | Not implemented |
| 2 | Worker processor assignment to Workers | All jobs fail with placeholder | `src/lib/app/app.ts` |
| 3 | PandaScore pagination | Only first 50 matches per game per fetch | `pandascore.client.ts` |
| 4 | Environment prefix for Redis cooldown key | Hardcoded `'dev'` in all environments | `match-ingestion.worker.ts` line 33 |
| 5 | `console.error` diagnostics cleanup | Logs sensitive error info to stdout | `app.ts` lines 140-146 |

---

## Minor Issues

| # | Issue | Details |
|---|---|---|
| 1 | `ENV_PREFIX` hardcoded `'dev'` | Should read from `config.app.nodeEnv` or similar |
| 2 | `isMain` always `pinnacle` | If Pinnacle is not among OddsPapi bookmakers, no snapshot is marked `isMain`. Should fall back to first bookmaker. |
| 3 | No quota tracking for PandaScore | PandaScore has its own rate limits, but no tracking is implemented. This is acceptable for V1. |
| 4 | `OddsPapi.DEFAULTS.COOLDOWN_MS` imported in `match-ingestion.worker.ts` | This couples the worker to OddsPapi config constants. An acceptable dependency for V1. |
| 5 | No `getPastMatches` pagination | `getPastMatches` is defined in the interface but only `getUpcomingMatches` and `getRunningMatches` are used. No pagination issue since it's never called. |
| 6 | `r6siege` and `mlbb` in `EsportsVideogame` but no OddsPapi support | `PANDASCORE_TO_ODDSPAPI_KEY` returns `null` for both, correctly preventing OddsPapi calls. |

---

## When Pipeline Actually Fires

The pipeline will fire when:
1. Repeatable BullMQ jobs are registered in `app.ts` / `main.ts`
2. Worker processors from `bootstrapIngestion()` are connected to BullMQ Workers
3. A `sync-esports-game` job reaches the match-fetch queue
4. The `_handleEsportsGame` finds near-term matches for a supported game
5. The Redis cooldown is expired
6. The `sync-esports-odds` job reaches the odds-fetch queue
7. The `ResilientOddspapiClient` quota check passes

**Without #1 and #2: The pipeline will never fire.**

---

## Recommended Fixes

### Critical (Blocking Production)

1. **Register repeatable BullMQ jobs** in `app.ts` after `bootstrapIngestion()` returns processors:
   - `sync-reference-data`: daily
   - `sync-traditional-sport`: every 30 min per configured sport key
   - `sync-esports-game`: every 30 min per configured videogame

2. **Connect processors to Workers** — replace `placeholderProcessor` in `worker-factory.ts` with the real processors from `bootstrapIngestion()`. This requires threading the processors through `Application` or accepting them as constructor parameters.

3. **Implement PandaScore pagination** in `DefaultPandascoreClient` — follow `Link` headers or use `page` parameter to collect all pages before returning.

### High

4. **Verify OddsPapi API details** — confirm base URL, endpoint path, auth method, and response field names against OddsPapi documentation before production.

5. **Normalize OddsPapi outcome names** — if `outcome.name` returns `"home"`/`"away"` labels instead of team names, map them `"home"` → `oddsMatch.home_team` and `"away"` → `oddsMatch.away_team` in `EsportsOddsSnapshotIngestionService`.

### Medium

6. **Read `ENV_PREFIX` from config** — use `config.app.nodeEnv` instead of hardcoded `'dev'`.
7. **`isMain` fallback** — if Pinnacle is not present, set `isMain: true` on the first bookmaker in the response.
8. **Remove diagnostic `console.error`** from `app.ts` before production.

---

## Classification Summary

| Category | Count | Details |
|---|---|---|
| Production Blockers | 3 | No repeatable jobs, processors not connected, no pagination |
| High Risks | 2 | OddsPapi API details unverified, outcome field ambiguity |
| Missing Features | 5 | Listed above |
| Minor Issues | 6 | Listed above |
| Verified Working | 25+ | All code paths traced and confirmed correct |

---

## Final Verdict

**NOT READY FOR PRODUCTION**

The esports odds pipeline compiles and the architecture is correct, but it cannot function without runtime registration. The three production blockers (repeatable jobs, processor wiring, pagination) must be resolved before any esports odds data can reach the database.