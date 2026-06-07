# V1 Sport Coverage Audit

**Date:** 2026-06-07
**Scope:** Verify that the planned V1 sport portfolio is realistically supported by the current architecture and external data providers.
**Method:** Full inspection of integration types, ingestion contracts, service layer, scheduler, and worker implementations.

---

## 1. Coverage Matrix

### 1.1 Tier 1 — 30-Minute Polling

| Sport | Data Source | API Key / Slug | Type Support | Architecture | Scheduler | Risk | Verdict |
|-------|-------------|----------------|-------------|--------------|-----------|------|---------|
| ATP | The Odds API | `tennis_atp` | ⚠️ Missing from `SportKey` union; `getOdds` accepts `string` | ✅ Works | ✅ Tier 1 ready | LOW | **SUPPORTED** |
| WTA | The Odds API | `tennis_wta` | ⚠️ Missing from `SportKey` union; `getOdds` accepts `string` | ✅ Works | ✅ Tier 1 ready | LOW | **SUPPORTED** |
| CS2 | PandaScore | `cs2` | ✅ `EsportsVideogame`, `VideogameKey` | ✅ Works | ✅ Tier 1 ready | LOW | **SUPPORTED** |
| Dota 2 | PandaScore | `dota2` | ❌ Not in `EsportsVideogame`, not in `VideogameKey` | ❌ Compile error | ❌ Not registered | HIGH | **NOT SUPPORTED** |
| League of Legends | PandaScore | `lol` | ✅ `EsportsVideogame`, `VideogameKey` | ✅ Works | ✅ Tier 1 ready | LOW | **SUPPORTED** |
| Valorant | PandaScore | `valorant` | ✅ `EsportsVideogame`, `VideogameKey` | ✅ Works | ✅ Tier 1 ready | LOW | **SUPPORTED** |
| Table Tennis | The Odds API | `tabletennis_atp` / others | ⚠️ Missing from `SportKey` union; `getOdds` accepts `string` | ✅ Works | ⚠️ Key not configured | MEDIUM | **SUPPORTED WITH CONFIGURATION** |
| Volleyball | The Odds API | `volleyball_*` (multiple) | ⚠️ Missing from `SportKey` union; `getOdds` accepts `string` | ✅ Works | ⚠️ Key not configured | MEDIUM | **SUPPORTED WITH CONFIGURATION** |

### 1.2 Tier 2 — 60-Minute Polling

| Sport | Data Source | API Key / Slug | Type Support | Architecture | Scheduler | Risk | Verdict |
|-------|-------------|----------------|-------------|--------------|-----------|------|---------|
| NHL | The Odds API | `icehockey_nhl` | ✅ In `SportKey` union | ✅ Works | ❌ No 60-min tier | MEDIUM | **SUPPORTED — SCHEDULER CHANGE REQUIRED** |
| MLB | The Odds API | `baseball_mlb` | ⚠️ Missing from `SportKey` union; `getOdds` accepts `string` | ✅ Works | ❌ No 60-min tier | MEDIUM | **SUPPORTED — SCHEDULER CHANGE REQUIRED** |
| Rainbow Six Siege | PandaScore | `r6siege` | ❌ Not in `EsportsVideogame`, not in `VideogameKey` | ❌ Compile error | ❌ Not registered | HIGH | **NOT SUPPORTED** |
| Mobile Legends | PandaScore | `mlbb` | ❌ Not in `EsportsVideogame`, not in `VideogameKey` | ❌ Compile error | ❌ Not registered | HIGH | **NOT SUPPORTED** |

### 1.3 Tier 3 — Event-Driven (48-Hour Window)

| Sport | Data Source | API Key / Slug | Type Support | Architecture | Scheduler | Risk | Verdict |
|-------|-------------|----------------|-------------|--------------|-----------|------|---------|
| NBA | The Odds API | `basketball_nba` | ✅ In `SportKey` union | ✅ Works | ❌ No event-driven impl | MEDIUM | **SUPPORTED — SCHEDULER CHANGE REQUIRED** |
| Premier League | The Odds API | `soccer_epl` | ✅ In `SportKey` union | ✅ Works | ❌ No event-driven impl | MEDIUM | **SUPPORTED — SCHEDULER CHANGE REQUIRED** |
| Champions League | The Odds API | `soccer_uefa_champs_league` | ✅ In `SportKey` union | ✅ Works | ❌ No event-driven impl | MEDIUM | **SUPPORTED — SCHEDULER CHANGE REQUIRED** |

---

## 2. Detailed Findings

### 2.1 Esports Type Gap (BLOCKING — 4 sports affected)

**Affected sports:** Dota 2, Rainbow Six Siege, Mobile Legends, and indirectly all esports scheduler registrations.

**Root file:** `src/ingestion/contracts/source.types.ts`
```typescript
// Current — 3 games only:
export type EsportsVideogame = 'cs2' | 'valorant' | 'lol';
```

**Root file:** `src/integrations/pandascore/types.ts`
```typescript
// Current — same 3 games:
export type VideogameKey = 'cs2' | 'valorant' | 'lol';
export type VideogameName = 'CS:GO' | 'Valorant' | 'LoL';
```

The `PandascoreClient.getUpcomingMatches(videogame: VideogameKey)` call chain requires `EsportsVideogame ⊆ VideogameKey`. Since `ingestEsportsGame(videogame: EsportsVideogame)` passes `videogame` directly to the client, both types must be expanded together. The underlying HTTP call is generic (`/${videogame}/matches/upcoming`) — no code-level game-specific branching exists in the client or mapper. The `PandascoreMatchMapper` reads `raw.videogame.slug` and `raw.videogame.name` directly from the API response, making it game-agnostic.

**PandaScore API path verification:**
| Game | PandaScore slug | API endpoint |
|------|----------------|-------------|
| Dota 2 | `dota2` | `GET /dota2/matches/upcoming` |
| Rainbow Six Siege | `r6siege` | `GET /r6siege/matches/upcoming` |
| Mobile Legends | `mlbb` | `GET /mlbb/matches/upcoming` |

All three are supported by the PandaScore API. The blocker is purely the TypeScript union types.

**Required changes:**
```typescript
// source.types.ts
export type EsportsVideogame = 'cs2' | 'valorant' | 'lol' | 'dota2' | 'r6siege' | 'mlbb';

// pandascore/types.ts
export type VideogameKey = 'cs2' | 'valorant' | 'lol' | 'dota2' | 'r6siege' | 'mlbb';
export type VideogameName = 'CS:GO' | 'Valorant' | 'LoL' | 'Dota 2' | 'Rainbow Six Siege' | 'Mobile Legends: Bang Bang';

// ingestion-scheduler.ts — ESPORTS_VIDEOGAMES constant:
const ESPORTS_VIDEOGAMES: readonly EsportsVideogame[] = ['cs2', 'valorant', 'lol', 'dota2', 'r6siege', 'mlbb'];
```

**Cascade check:** No switch statements or exhaustive checks on `EsportsVideogame` or `VideogameKey` exist in the current codebase. The mapper, service, and worker are all generic. Expansion is safe.

---

### 2.2 Scheduler Tier Support (BLOCKING — 6 sports affected)

**Affected sports:** NHL, MLB (Tier 2), NBA, Premier League, Champions League (Tier 3).

**Root file:** `src/ingestion/bootstrap/ingestion-scheduler.ts`

The current scheduler has a single hardcoded constant for all traditional sports:
```typescript
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

// Every sport uses the same interval:
await matchFetchQueue.add(name, data, { repeat: { every: THIRTY_MINUTES_MS }, ... });
```

`TraditionalSportScheduleConfig` has no `intervalMs` field:
```typescript
export interface TraditionalSportScheduleConfig {
  readonly sportKey: string;
  readonly sportGroup: string;
  // ← No intervalMs or tier field
}
```

**Impact:**
- **Tier 2 sports (NHL, MLB)** will run at 30 minutes instead of 60 minutes, consuming 2× the intended Odds API credits.
- **Tier 3 sports (NBA, EPL, UCL)** have no event-driven mechanism and no slow-poll fallback. If added to `sportConfigs` today, they would run at 30-minute fixed intervals — not event-driven.

**Required change — `TraditionalSportScheduleConfig`:**
```typescript
export interface TraditionalSportScheduleConfig {
  readonly sportKey: string;
  readonly sportGroup: string;
  readonly intervalMs: number; // e.g. THIRTY_MINUTES_MS or SIXTY_MINUTES_MS
}
```

**Tier 3 recommendation:** True event-driven scheduling (fire only when events exist within 48h) is a non-trivial implementation requiring a separate "check upcoming" job type. For V1, use a **slow fixed-poll fallback of 4 hours**. The ingestion service already implements the 48-hour window filter (`NEAR_TERM_WINDOW_MS`) — during off-weeks the job fires, finds no near-term matches, and exits cheaply. The cost is ~180 API calls/month per Tier 3 sport, which is acceptable.

---

### 2.3 The Odds API `SportKey` Type Incompleteness (NON-BLOCKING)

**Root file:** `src/integrations/the-odds-api/types.ts`

```typescript
// Current union — incomplete:
export type SportKey = 'soccer' | 'soccer_epl' | 'soccer_uefa_champs_league'
  | 'basketball_nba' | 'icehockey_nhl' | 'americanfootball_nfl'
  | 'tennis_atp' | 'tennis_wta' | 'mma_mixed_martial_arts';
```

Missing keys for V1: `baseball_mlb`, table tennis keys (e.g. `tabletennis_atp`, `tabletennis_wta`), volleyball keys (e.g. `volleyball_brazil_superliga`, etc.).

**Why this is non-blocking:** `OddsApiClient.getOdds(sportKey: string, ...)` accepts `string`, not `SportKey`. The union type is documentation-only — it is never used as a parameter type constraint in client methods or anywhere else in the ingestion path. ATP and WTA work correctly today despite being absent from the union.

**Recommended fix:** Expand the union or replace it with documentation comments listing known keys. Does not require runtime changes.

---

### 2.4 Table Tennis and Volleyball — Key Ambiguity (MEDIUM RISK)

**Affected tier:** Tier 1.

The Odds API offers multiple sport keys per sport group. For Table Tennis and Volleyball, there is no single canonical key — the group contains many competitions:

**The Odds API Table Tennis keys (examples):**
- `tabletennis_atp` — ATP Table Tennis
- `tabletennis_wta` — WTA Table Tennis
- `tabletennis_ittf_world_championships` — ITTF World Championships

**The Odds API Volleyball keys (examples):**
- `volleyball_brazil_superliga`
- `volleyball_ncaa_women`
- `volleyball_world_championships`

For the scheduler, each key requires a separate `TraditionalSportScheduleConfig` entry, a separate `sync-traditional-sport` job, and separate API calls. A "Table Tennis" entry in the proposed V1 portfolio likely refers to a specific tour (ATP table tennis) — the exact keys must be confirmed against the live `/v4/sports` response.

**Additional risk:** The Odds API's bookmaker coverage for Table Tennis and Volleyball is significantly thinner than for tennis/hockey/football. Fewer bookmakers list these sports, which means odds data may be sparse or absent in the snapshot records.

**Recommendation:** Before activating Table Tennis and Volleyball:
1. Run `GET /v4/sports` and confirm which keys are `active: true`.
2. Verify bookmaker odds are available by checking a sample `GET /v4/sports/{key}/odds` response.
3. Register only the specific keys with confirmed coverage.

---

### 2.5 Odds Availability for Esports (KNOWN LIMITATION)

The current architecture deliberately produces no `OddsSnapshot` records for esports. The `OddsSnapshotIngestionService` filters out any match IDs not prefixed with `oa:` (The Odds API source). PandaScore has no bookmaker odds endpoint. The match worker never enqueues `sync-odds-for-sport` for esports jobs.

This is a **by-design constraint** for V1, not a bug. All six esports in the proposed portfolio will have match, league, team, and standing data but zero odds snapshots. Any downstream prediction or odds analysis features must account for this.

---

### 2.6 NHL Seasonal Availability

NHL runs from October to June. If polling is active year-round, the `getOdds('icehockey_nhl')` call will return zero events during the offseason (July–September). This is handled gracefully by the service (returns `EMPTY_OUTCOME` and no odds job is enqueued), but 720 API calls/month will be wasted during the three-month offseason.

**Recommendation:** Either accept the waste (low cost, minor) or build a season-aware scheduler. For V1, accepting it is the pragmatic choice.

---

## 3. Monthly Odds API Credit Estimate

### 3.1 Assumptions

- The Odds API v4 charges **1 request per API call**, independent of the number of events returned (based on `x-requests-used` / `x-requests-remaining` quota header behaviour observed in the client).
- Each `sync-traditional-sport` job calls `getOdds(sportKey)` once (match sync).
- Each `sync-odds-for-sport` job calls `getOdds(sportKey, { eventIds })` once (odds sync). Fired only when near-term matches exist — conservatively estimated at 70% of match sync calls.
- `sync-reference-data` calls `getSports()` once.
- Table Tennis and Volleyball require multiple keys (estimated 2 keys each for the estimate).
- NHL seasonal availability: ~9 months/year active → multiply by 0.75 factor.
- UCL: intermittent fixture schedule → multiply by 0.4 factor (group stage + knockout rounds only).

### 3.2 Call Count by Component

| Component | Interval | Match Calls/Month | Odds Calls/Month (×0.7) | Total |
|-----------|----------|-------------------|--------------------------|-------|
| `sync-reference-data` | 24 h | 30 | 0 | **30** |
| **Tier 1 Traditional** | | | | |
| ATP (`tennis_atp`) | 30 min | 1,440 | 1,008 | **2,448** |
| WTA (`tennis_wta`) | 30 min | 1,440 | 1,008 | **2,448** |
| Table Tennis (2 keys est.) | 30 min | 2,880 | 2,016 | **4,896** |
| Volleyball (2 keys est.) | 30 min | 2,880 | 2,016 | **4,896** |
| **Tier 2 Traditional** *(with correct 60-min interval)* | | | | |
| NHL (`icehockey_nhl`) ×0.75 seasonal | 60 min | 540 | 378 | **918** |
| MLB (`baseball_mlb`) | 60 min | 720 | 504 | **1,224** |
| **Tier 3 Traditional** *(4h slow-poll fallback)* | | | | |
| NBA (`basketball_nba`) | 4 h | 180 | 126 | **306** |
| Premier League (`soccer_epl`) | 4 h | 180 | 126 | **306** |
| Champions League (`soccer_uefa_champs_league`) ×0.4 | 4 h | 72 | 50 | **122** |

### 3.3 Monthly Total Scenarios

| Scenario | Monthly Credits |
|----------|----------------|
| **Minimal** — ATP + WTA + CS2/LoL/Valorant + NHL + NBA only | ~6,200 |
| **V1 without TT/VB** — all sports except Table Tennis & Volleyball | ~7,800 |
| **Full V1** — all proposed sports including TT/VB | ~17,600 |
| **Full V1 with Tier 2 bug** *(all sports at 30 min instead of 60 min)* | ~21,500 |

### 3.4 Plan Recommendations

| Monthly Usage | Required Plan |
|--------------|---------------|
| < 500 | Free |
| 500 – 10,000 | Starter (~$79/month) |
| 10,000 – 50,000 | Standard (~$179/month) |
| 50,000 – 500,000 | Premium |

**V1 recommendation:** Full V1 portfolio (~17,600 credits/month) fits within the **Standard plan**. Without Table Tennis and Volleyball the minimal build (~7,800) fits within **Starter**.

---

## 4. Architecture Readiness Assessment

### 4.1 What Works Today

| Component | Status | Notes |
|-----------|--------|-------|
| `OddsApiClient.getOdds(sportKey: string)` | ✅ Ready | Accepts any sport key string |
| `PandascoreClient` for CS2, LoL, Valorant | ✅ Ready | Types aligned |
| `PandascoreMatchMapper` | ✅ Ready | Game-agnostic — reads `videogame.slug` directly |
| `OddsApiEventMapper` | ✅ Ready | Sport-agnostic |
| `OddsApiSportMapper` | ✅ Ready | Group-agnostic via `slugify(raw.group)` |
| `MatchIngestionService.ingestTraditionalSport` | ✅ Ready | Works with any sport key |
| `MatchIngestionService.ingestEsportsGame` | ✅ Ready for 3 games | Blocked on type expansion for Dota2/R6/MLBB |
| `OddsSnapshotIngestionService` | ✅ Ready | Works with any sport key |
| `TeamLeagueRepository` (post Phase 2E) | ✅ Ready | Atomic upsert, in-batch dedup |
| `MatchIngestionWorker` odds enqueue | ✅ Ready | 5s delay, `nearTermMatchExternalIds` |
| `scheduleIngestionJobs` — 30-min interval | ✅ Ready | All jobs registered at startup |
| `scheduleIngestionJobs` — per-sport intervals | ❌ Missing | Single 30-min constant only |
| Tier 3 event-driven or slow-poll | ❌ Missing | No mechanism exists |

### 4.2 What Must Change Before Full V1 Deployment

| Change | Files | Effort |
|--------|-------|--------|
| Expand `EsportsVideogame` union | `src/ingestion/contracts/source.types.ts` | Trivial |
| Expand `VideogameKey` + `VideogameName` | `src/integrations/pandascore/types.ts` | Trivial |
| Update `ESPORTS_VIDEOGAMES` constant | `src/ingestion/bootstrap/ingestion-scheduler.ts` | Trivial |
| Add `intervalMs` to `TraditionalSportScheduleConfig` | `src/ingestion/bootstrap/ingestion-scheduler.ts` | Small |
| Update `scheduleIngestionJobs` to use per-sport intervals | `src/ingestion/bootstrap/ingestion-scheduler.ts` | Small |
| Verify and document Table Tennis / Volleyball API keys | Config/docs | Research |

---

## 5. Risks

### R-01 — CRITICAL: 4 Esports Fully Blocked by Type
**Sports:** Dota 2, Rainbow Six Siege, Mobile Legends (Tier 1 + Tier 2).
**Cause:** `EsportsVideogame` and `VideogameKey` type unions are hardcoded to 3 games. The PandaScore client interface enforces these types at compile time — passing `'dota2'` today produces a TypeScript error.
**Impact:** Dota 2 (Tier 1) and Rainbow Six Siege + Mobile Legends (Tier 2) cannot be ingested at all until types are expanded.
**Resolution:** Trivial — union expansion + scheduler constant update. No architectural change needed.

### R-02 — HIGH: Tier 2 Sports Running at Wrong Interval
**Sports:** NHL, MLB.
**Cause:** Scheduler supports only one interval (30 min). No `intervalMs` parameter exists on `TraditionalSportScheduleConfig`.
**Impact:** If NHL and MLB are added to the scheduler with the current implementation, they run at 30 min (2× intended rate), consuming 2× the expected API credits. With `baseball_mlb` returning 10-15 games/day, this is material.
**Resolution:** Small — add `intervalMs` field to `TraditionalSportScheduleConfig` and update `scheduleIngestionJobs` to use it.

### R-03 — HIGH: Tier 3 Has No Implementation
**Sports:** NBA, Premier League, Champions League.
**Cause:** No event-driven scheduling mechanism exists. The scheduler only supports fixed-repeat BullMQ jobs.
**Impact:** Tier 3 sports cannot be activated at their intended polling behaviour.
**Resolution:** Recommended pragmatic fix — register as fixed 4-hour slow-poll interval. The service-level 48h window filter means idle polls are cheap (no near-term matches = no odds job enqueued).

### R-04 — MEDIUM: Table Tennis and Volleyball Keys Unconfirmed
**Sports:** Table Tennis, Volleyball (Tier 1).
**Cause:** No specific sport keys are documented or configured. Multiple keys exist per sport.
**Impact:** Cannot activate these sports without first identifying and verifying the correct Odds API sport keys for the competitions to be monitored. Bookmaker coverage may be insufficient for useful odds data.
**Resolution:** Research task — call `/v4/sports` and verify coverage before activating.

### R-05 — MEDIUM: NHL Offseason Waste
**Sport:** NHL.
**Cause:** Year-round 60-min polling on a sport that is inactive July–September.
**Impact:** ~1,620 wasted API calls during the 3-month offseason (~$0 additional cost on Standard plan, but quota consumed).
**Resolution:** Accept for V1. Address in a future season-aware scheduler if quota pressure increases.

### R-06 — LOW: `SportKey` Type Union Incomplete
**Files:** `src/integrations/the-odds-api/types.ts`.
**Cause:** `SportKey` union documents only 9 keys. ATP and WTA are used today but absent from the union.
**Impact:** None at runtime — `getOdds(sportKey: string)` does not reference `SportKey`. Documentation gap only.
**Resolution:** Expand union to include all V1 keys for completeness. No functional change.

---

## 6. Recommendations

### P0 — Required Before Any Esports Beyond CS2/LoL/Valorant

1. Expand `EsportsVideogame` in `src/ingestion/contracts/source.types.ts`:
   ```typescript
   export type EsportsVideogame = 'cs2' | 'valorant' | 'lol' | 'dota2' | 'r6siege' | 'mlbb';
   ```

2. Expand `VideogameKey` and `VideogameName` in `src/integrations/pandascore/types.ts`:
   ```typescript
   export type VideogameKey = 'cs2' | 'valorant' | 'lol' | 'dota2' | 'r6siege' | 'mlbb';
   export type VideogameName = 'CS:GO' | 'Valorant' | 'LoL' | 'Dota 2' | 'Rainbow Six Siege' | 'Mobile Legends: Bang Bang';
   ```

3. Update `ESPORTS_VIDEOGAMES` in `ingestion-scheduler.ts`:
   ```typescript
   const ESPORTS_VIDEOGAMES: readonly EsportsVideogame[] = [
     'cs2', 'valorant', 'lol', 'dota2', 'r6siege', 'mlbb',
   ];
   ```

### P0 — Required Before Tier 2 or Tier 3 Sports Are Activated

4. Add `intervalMs` to `TraditionalSportScheduleConfig` and update `scheduleIngestionJobs` to pass per-sport intervals to BullMQ. Example target interface:
   ```typescript
   export interface TraditionalSportScheduleConfig {
     readonly sportKey: string;
     readonly sportGroup: string;
     readonly intervalMs: number;
   }
   // Callers define:
   const SIXTY_MINUTES_MS = 60 * 60 * 1000;
   const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
   ```

5. Register Tier 3 sports with `intervalMs: FOUR_HOURS_MS` as a pragmatic V1 event-driven approximation. The 48h near-term window filter in `MatchIngestionService` ensures odds jobs are only enqueued when upcoming matches actually exist.

### P1 — Recommended Before Activating Table Tennis / Volleyball

6. Call `GET /v4/sports?all=true` with the production API key. Filter results to `active: true` and `group` values matching "Table Tennis" and "Volleyball". Select specific competition keys with confirmed bookmaker coverage. Document the selected keys in a configuration file.

### P2 — Cosmetic / Low Priority

7. Expand the `SportKey` union in `src/integrations/the-odds-api/types.ts` to include all confirmed V1 keys. This is documentation only — no runtime effect.

---

## 7. Final Verdict

### Overall Status: **READY WITH CHANGES**

The core ingestion pipeline is architecturally sound for the V1 portfolio. The data flow, mapper, repository, service, and worker layers are generic enough to support any sport with no changes beyond type definitions and scheduler configuration. Three gaps require resolution before the full portfolio can be deployed:

| Gap | Blocking | Effort |
|-----|----------|--------|
| Dota 2, R6 Siege, MLBB type expansion | ✅ Yes — type error | Trivial (3 lines) |
| Per-sport scheduler intervals (Tier 2 + Tier 3) | ✅ Yes — wrong behaviour | Small (interface + scheduler update) |
| Table Tennis / Volleyball key confirmation | ⚠️ Operational — no runtime error but no data | Research |

### Readiness by Tier

| Tier | Sports | Readiness |
|------|--------|-----------|
| Tier 1 | ATP, WTA, CS2, LoL, Valorant | ✅ READY (5 of 8 sports) |
| Tier 1 | Dota 2 | ❌ TYPE CHANGE REQUIRED |
| Tier 1 | Table Tennis, Volleyball | ⚠️ KEY RESEARCH REQUIRED |
| Tier 2 | NHL, MLB | ⚠️ SCHEDULER CHANGE REQUIRED |
| Tier 2 | R6 Siege, Mobile Legends | ❌ TYPE CHANGE REQUIRED |
| Tier 3 | NBA, EPL, UCL | ⚠️ SCHEDULER CHANGE REQUIRED |

### Recommended Activation Sequence

1. **Immediate:** ATP, WTA, CS2, LoL, Valorant — activate today with current architecture.
2. **One sprint:** Dota 2, R6 Siege, Mobile Legends + Tier 2/Tier 3 scheduler interval support — 3-4 small file changes, all type-safe after expansion.
3. **Research first:** Table Tennis, Volleyball — confirm sport keys and bookmaker coverage before activating.
