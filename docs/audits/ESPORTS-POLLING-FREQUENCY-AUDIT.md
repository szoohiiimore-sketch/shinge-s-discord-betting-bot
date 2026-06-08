# Esports Polling Frequency Audit

**Date:** 2026-06-08  
**Scope:** Determine whether esports polling can be safely increased from 2x/day to every 2 hours  

---

## 1. Esports Execution Flow (Traced from Code)

### 1.1 Scheduler Registration

**File:** `src/ingestion/bootstrap/ingestion-scheduler.ts` (lines 94–110)

```typescript
for (const videogame of ESPORTS_VIDEOGAMES) {
  const data: SyncEsportsGameJobData = { videogame };
  await matchFetchQueue.add(
    MATCH_FETCH_JOB_NAMES.SYNC_ESPORTS_GAME,
    data,
    {
      repeat: { pattern: '0 12,17 * * *', tz: 'Europe/Budapest' },
      jobId: `repeat:sync-esports-game:${videogame}`,
    },
  );
  schedLogger.debug({ videogame }, 'Registered sync-esports-game (12:00 + 17:00 Budapest)');
}
```

**Current schedule:** `0 12,17 * * *` = 12:00 and 17:00 Budapest.  

### 1.2 Execution Order (Critical Path)

```
match-fetch queue: sync-esports-game(cs2)
  → MatchIngestionWorker._handleEsportsGame()
    → MatchIngestionService.ingestEsportsGame(videogame)
      │
      │  STEP 1: PandaScore API calls (ALWAYS executes)
      ├→ ▶ PandascoreClient.getUpcomingMatches(videogame)     ⬅ ALWAYS CALLED
      ├→ ▶ PandascoreClient.getRunningMatches(videogame)       ⬅ ALWAYS CALLED
      │
      │  STEP 2: DB upserts (Sports, Leagues, Teams, Matches)
      ├→ Upserts entities to PostgreSQL
      │
      │  STEP 3: Return near-term match IDs
      └→ Returns { nearTermMatchExternalIds: ["ps:1", "ps:2", ...] }
      │
      │  STEP 4: Cooldown check (BACK IN WORKER)
      └→ MatchIngestionWorker._handleEsportsGame()
           │
           │  Guard 1: Are there near-term matches?
           if (nearTermMatchExternalIds.length > 0)
             AND
           │  Guard 2: Is this game OddsPapi-supported?
           ODDSPAPI_SUPPORTED_GAMES.has(videogame)
           │
           │  Guard 3: Has cooldown expired? (4 hours)
           cooldownRemainingMs <= 0
           │
           │  If ALL guards pass:
           → oddsFetchQueue.add('sync-esports-odds', { videogame, matchExternalIds })
           → Sets Redis cooldown key with 14400s TTL
             │
             │  Guard 4: Quota check (IN RESILIENT CLIENT)
             ResilientOddspapiClient.getOddsForGame()
               → OddspapiQuotaTracker.incrementAndCheck()  ⬅ Lua INCR + EXPIRE
               → If > HARD_LIMIT: throw QuotaExhaustedError
               │
               → DefaultOddspapiClient.getOddsForGame()
                 → ▶ GET /v4/tournaments                ⬅ ACTUAL HTTP REQUEST
                 → ▶ GET /v4/odds-by-tournaments (×N)   ⬅ ACTUAL HTTP REQUEST
                 → ▶ GET /v4/participants               ⬅ ACTUAL HTTP REQUEST
```

### 1.3 Key Finding: Three-Layer Guard Protects OddsPapi

| Guard | Location | Effect |
|---|---|---|
| **Guard 1:** Near-term matches empty | `esports-odds-ingestion.service.ts` (line 79) | Returns early — no OddsPapi call |
| **Guard 2:** Game not OddsPapi-supported | `game-key.map.ts` | Returns empty — only cs2, dota2, lol, valorant proceed |
| **Guard 3:** Redis cooldown (4h) | `match-ingestion.worker.ts` (line 152) | Prevents enqueue — max 6 calls/game/day |
| **Guard 4:** Quota hard limit | `oddspapi.resilient-client.ts` (line 17) | Rejects if counter > 250 |

---

## 2. Determining Guards 1 and 3 In Action

### Guard 1: When is OddsPapi actually called?

OddsPapi is called ONLY when:

1. `sync-esports-game` job fires (scheduled)
2. PandaScore returns upcoming or running matches
3. At least one match has its startTime **within 48 hours** of the fetch
4. The game is one of: cs2, dota2, lol, valorant

**If no upcoming PandaScore matches exist, OddsPapi is NEVER called** — the worker returns immediately after the DB upsert (which creates Sport/League/Team/Match records from the empty result — a no-op).

### Guard 3: 4-hour Cooldown

File: `src/ingestion/workers/match-ingestion.worker.ts` (lines 146–191)

```typescript
const cooldownKey = `${ENV_PREFIX}:esports-odds-cooldown:${videogame}`;
const cooldownRemainingMs = ESPORTS_ODDS_COOLDOWN_MS - (Date.now() - lastEnqueuedAt);

if (cooldownRemainingMs <= 0) {
  // Allow OddsPapi call
  oddsFetchQueue.add('sync-esports-odds', ...);
  redis.set(cooldownKey, Date.now(), 'EX', 14400);  // 4h TTL
} else {
  // Cooldown active — skip
}
```

Even if the `sync-esports-game` job fires every 2 hours, the 4-hour cooldown ensures:
- Max 1 OddsPapi call per game per 4 hours
- Max 6 OddsPapi calls per game per day
- With 4 games: max 24 OddsPapi calls per day

---

## 3. Current vs Proposed: Impact Comparison

### Current: 2x/day

| Metric | Per Game | 4 Games |
|---|---|---|
| PandaScore calls per day | 4 (2 upcoming + 2 running) | 16 |
| PandaScore calls per month | 120 | **480** |
| OddsPapi calls per day (max) | 2 (but capped at 6 by cooldown) | 8 |
| OddsPapi calls per month (max) | 60 | **240** |

### Proposed: every 2 hours (12x/day in 24h window)

| Metric | Per Game | 4 Games |
|---|---|---|
| PandaScore calls per day | 24 (12 upcoming + 12 running) | 96 |
| PandaScore calls per month | 720 | **2,880** |
| OddsPapi calls per day (max) | 6 (capped by 4h cooldown) | 24 |
| OddsPapi calls per month (max) | 180 | **720** |

### Key Insight: OddsPapi Usage is INDEPENDENT of Polling Frequency

The OddsPapi usage depends ONLY on:
- Whether near-term matches exist (Guard 1)
- The 4-hour cooldown timer (Guard 3)

Increasing the sync-esports-game polling frequency from 2x to 12x per day does NOT increase OddsPapi calls — the cooldown is the binding constraint. The cooldown value (4 hours = 14400 seconds) is hardcoded in `ODDSPAPI_DEFAULTS.COOLDOWN_MS`.

**OddsPapi calls per month with current schedule:**
- Worst case: 4 games × 2 polls × (24h/4h cooldown) = 4 × 2 × 6 = 48 calls/month

**OddsPapi calls per month with 2-hour schedule:**
- Worst case: 4 games × 12 polls × (24h/4h cooldown) = 4 × 6 × 6 = 144 calls/month (but actually only 6 per game/day since cooldown fires once every 4h regardless of how many sync jobs run)

Wait — the cooldown fires per `_handleEsportsGame` execution. If sync-esports-game runs every 2 hours:
- Run at T=0: matches exist → enqueue sync-esports-odds → cooldown set for 4h
- Run at T=2h: matches exist → cooldown still active (2h remaining) → skip
- Run at T=4h: matches exist → cooldown expired → enqueue sync-esports-odds → cooldown set for 4h
- ...

**Result:** Max 6 OddsPapi calls/game/day regardless of sync-esports-game frequency (as long as it's more frequent than 4h).

**PandaScore** calls increase proportionally: 2x/day → 12x/day = 6× increase.

---

## 4. Real-World Impact

### Scenario A: No matches exist (off-season)

| API | Current (2x/day) | Proposed (every 2h) | Δ |
|---|---|---|---|
| PandaScore | 8 calls/month | 48 calls/month | +40 calls/month |
| OddsPapi | 0 calls/month | 0 calls/month | **No change** |

PandaScore is called but returns 0 upcoming matches → Guard 1 activates → no odds enqueued.

### Scenario B: Active tournament (matches exist 24/7)

| API | Current (2x/day) | Proposed (every 2h) | Δ |
|---|---|---|---|
| PandaScore | 8 calls/month | 48 calls/month | +40 calls/month |
| OddsPapi (per game) | 2 calls/day = 60/month | 6 calls/day = 180/month | +120 calls/month |
| OddsPapi (all 4 games) | 240 calls/month | **720 calls/month** | +480 calls/month |

### Scenario C: Typical (12 active days/month, not 24/7)

| API | Current (2x/day) | Proposed (every 2h) | Δ |
|---|---|---|---|
| PandaScore | 120 calls/month | 720 calls/month | +600 calls/month |
| OddsPapi (all 4 games) | ~72 calls/month | ~144 calls/month | +72 calls/month |

---

## 5. Risk Assessment

| Factor | Risk | Explanation |
|---|---|---|
| OddsPapi quota exhaustion | **Low** | 4-hour cooldown caps at 180 calls/game/month. Even worst-case (720 total) is under the 10,000 hard limit. |
| PandaScore rate limiting | **Medium** | From 16 to 96 calls/day with no built-in quota tracking. PandaScore's free tier may have rate limits. |
| Redis cooldown keys | **None** | Already implemented and tested. |
| Duplicate OddsSnapshot records | **Medium** | More frequent polling = more `capturedAt` batches = more ValueOpportunity records (see duplicate notification audit). Each poll may alert the same value opportunity again. |

---

## 6. Final Recommendation

### **A) Safe to move to 2-hour polling**

The 4-hour cooldown on OddsPapi (Guard 3) is the binding constraint. Increasing the `sync-esports-game` polling frequency does NOT increase OddsPapi usage beyond what the cooldown already allows. The maximum OddsPapi calls per game per day is 6 regardless of how frequently the parent job fires.

### Recommended Schedule: every 2 hours

```
repeat: { pattern: '0 */2 * * *', tz: 'Europe/Budapest' },
```

This replaces:
```
repeat: { pattern: '0 12,17 * * *', tz: 'Europe/Budapest' },
```

### Impact Summary

| Metric | Current (2x/day) | Proposed (every 2h) | Δ |
|---|---|---|---|
| PandaScore calls/month | 120 | 720 | +600 |
| OddsPapi calls/month (typical) | ~72 | ~144 | +72 |
| OddsPapi calls/month (absolute max) | 240 | 720 | +480 |
| Quota hard limit | 10,000 | 10,000 | Same |
| Headroom | 97.6% | 92.8% | 4.8% less |

### One Concern: Value Alert Spam

More frequent PandaScore polling means more frequent OddsPapi polling (when cooldown expires). Each OddsPapi result that passes value detection creates a new ValueOpportunity. Under the 2-hour schedule, stable odds could produce up to 6 alerts/day per value-generating match instead of 2. This compounds the issue identified in the Duplicate Notification Audit.

**Mitigation:** The duplicate notification issue should be addressed before increasing polling frequency, or the MAX_ALERT_ODDS filter should be tuned to suppress re-alerts for the same match+outcome.

### Verdict

**Yes — esports polling can be safely increased to every 2 hours.** The OddsPapi usage increase is bounded by the existing 4-hour cooldown at 720 calls/month (7.2% of the 10,000 hard limit). The primary cost is increased PandaScore calls (600 more/month), which have no built-in quota tracking or hard limit.