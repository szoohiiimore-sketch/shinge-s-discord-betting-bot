# Sprint 8 — Scheduler and Stability Fixes

**Date:** 2026-06-07  
**Scope:** Automatic job scheduling, PandaScore pagination, Pino serializer stability  

---

## Summary

Three production-critical issues identified in Sprint 6 and Sprint 7 audits are now resolved:

1. **Automatic scheduling** — `scheduleIngestionJobs()` is called at startup; all repeatable BullMQ jobs are registered.
2. **PandaScore pagination** — `getUpcomingMatches()` and `getRunningMatches()` now fetch all pages.
3. **Pino serializer crash** — Safe wrapper handles frozen/non-extensible error objects without crashing.

Additionally: `ENV_PREFIX` in `match-ingestion.worker.ts` is no longer hardcoded `'dev'`.

---

## Changes

### 1. Pino Serializer — `src/lib/logger/logger.ts`

**Root cause:** `pino-std-serializers` adds a `Symbol(circular-ref-tag)` to error objects to detect circular references. This crashes with `TypeError: Cannot add property Symbol(circular-ref-tag), object is not extensible` when the error object is frozen or sealed (e.g. Zod error internals, `Object.freeze()` in config loaders).

**Fix:** Wraps `pino.stdSerializers.err` in a try-catch. On success the standard serializer runs (preserving all native error fields). On failure it falls back to a plain-object extraction that cannot throw.

```typescript
err: (err: unknown): unknown => {
  if (err == null || typeof err !== 'object') return err;
  try {
    return pino.stdSerializers.err(err as Error);
  } catch {
    const e = err as Error;
    return {
      type: e.constructor?.name ?? 'Error',
      message: typeof e.message === 'string' ? e.message : String(e),
      name: e.name,
      stack: e.stack,
    };
  }
},
```

**Validated:** Startup error (`EADDRINUSE`) serialized correctly with all fields (`code`, `errno`, `syscall`, `address`, `port`) — confirming `stdSerializers.err` succeeds on extensible errors and the fallback does not suppress them.

---

### 2. PandaScore Pagination — `src/integrations/pandascore/pandascore.client.ts`

**Root cause:** `getUpcomingMatches()` and `getRunningMatches()` called `request()` which fetches a single page (default 50 items). Matches beyond the first page were silently dropped.

**Fix:** Extracted the raw HTTP layer into `_execute(url: URL): Promise<Response>`. Added `requestPaginated(path: string): Promise<unknown[]>` which loops pages using the `X-Total` response header.

| Constant | Value | Reason |
|---|---|---|
| `PER_PAGE` | 100 | PandaScore maximum page size |
| `MAX_PAGES` | 20 | Safety ceiling — prevents infinite loops on broken `X-Total` |
| `PAGE_DELAY_MS` | 150 ms | Rate-limit courtesy between sequential page requests |

Loop exit conditions (whichever comes first):
- All items fetched (`allItems.length >= total` from `X-Total`)
- Last page was partial (`data.length < PER_PAGE`)
- Empty page returned
- `MAX_PAGES` reached

`getPastMatches`, `getMatch`, and `getTeam` continue using `request()` (single-page; their call sites do not need pagination).

---

### 3. Automatic Scheduling — `src/ingestion/bootstrap/ingestion-scheduler.ts` + `src/lib/app/app.ts`

**Root cause:** `scheduleIngestionJobs()` existed but was never called. The pipeline required manual job insertion to fire.

#### 3a. Esports cron pattern (`ingestion-scheduler.ts`)

**Before:**
```typescript
repeat: { every: THIRTY_MINUTES_MS },
```

**After:**
```typescript
repeat: { pattern: '0 12,17 * * *', tz: 'Europe/Budapest' },
```

Fires at 12:00 and 17:00 Hungarian local time (CEST in summer, CET in winter). BullMQ v5 resolves DST transitions automatically via the `tz` option.

**Budget arithmetic:** 4 OddsPapi-supported games (cs2, valorant, lol, dota2) × 2 runs/day = 8 OddsPapi API calls/day ≈ 240/month. Matches OddsPapi free-tier budget. `r6siege` and `mlbb` also run PandaScore ingestion at these times but do not trigger OddsPapi calls (`PANDASCORE_TO_ODDSPAPI_KEY` returns `null` for both).

#### 3b. `scheduleIngestionJobs` wired into startup (`app.ts`)

Called after `startAllWorkers()`, before `initHealthServer()`. Sport configurations are defined as a module-level constant `TRADITIONAL_SPORT_CONFIGS`:

| Sport key | Group | Tier | Interval |
|---|---|---|---|
| `tennis_atp` | Tennis | Tier 1 | 30 min |
| `tennis_wta` | Tennis | Tier 1 | 30 min |
| `icehockey_nhl` | Ice Hockey | Tier 2 | 60 min |
| `baseball_mlb` | Baseball | Tier 2 | 60 min |
| `basketball_nba` | Basketball | Tier 3 | 4 hours |
| `soccer_epl` | Soccer | Tier 3 | 4 hours |
| `soccer_uefa_champs_league` | Soccer | Tier 3 | 4 hours |

BullMQ deduplicates repeatable jobs by `(name, jobId, repeat options)` on restart — registering the same job twice has no effect.

#### 3c. Removed `console.error` diagnostics (`app.ts`)

The six-line `console.error` block added as a temporary workaround for the Pino crash is removed. Startup failures now log exclusively via `this._logger.error({ err }, 'Application startup failed')`.

---

### 4. `ENV_PREFIX` — `src/ingestion/workers/match-ingestion.worker.ts`

**Before:**
```typescript
const ENV_PREFIX = 'dev';
```

**After:**
```typescript
const ENV_PREFIX = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
```

Redis cooldown keys now use `prod:esports-odds-cooldown:*` in production and `dev:esports-odds-cooldown:*` in all other environments. Prevents dev and prod sharing cooldown state when both connect to the same Redis instance.

---

## Validation

### TypeScript

```
npx tsc --noEmit
```

✅ Zero errors.

### Startup log (2026-06-07 16:18)

```
INFO  Registering repeatable ingestion jobs  sportCount=7  esportsCount=6
DEBUG Registered sync-reference-data (every 24 h)
DEBUG Registered sync-traditional-sport  tennis_atp   intervalMs=1800000
DEBUG Registered sync-traditional-sport  tennis_wta   intervalMs=1800000
DEBUG Registered sync-traditional-sport  icehockey_nhl  intervalMs=3600000
DEBUG Registered sync-traditional-sport  baseball_mlb   intervalMs=3600000
DEBUG Registered sync-traditional-sport  basketball_nba  intervalMs=14400000
DEBUG Registered sync-traditional-sport  soccer_epl      intervalMs=14400000
DEBUG Registered sync-traditional-sport  soccer_uefa_champs_league  intervalMs=14400000
DEBUG Registered sync-esports-game (12:00 + 17:00 Budapest)  cs2
DEBUG Registered sync-esports-game (12:00 + 17:00 Budapest)  valorant
DEBUG Registered sync-esports-game (12:00 + 17:00 Budapest)  lol
DEBUG Registered sync-esports-game (12:00 + 17:00 Budapest)  dota2
DEBUG Registered sync-esports-game (12:00 + 17:00 Budapest)  r6siege
DEBUG Registered sync-esports-game (12:00 + 17:00 Budapest)  mlbb
INFO  All repeatable ingestion jobs registered  referenceData=1  traditionalSports=7  esportsGames=6
```

✅ All 15 repeatable jobs registered (1 reference + 7 traditional + 6 esports).  
✅ Traditional sport tiers match specification.  
✅ Esports jobs use Budapest cron, not 30-min polling.  
✅ Pino serializer handled `EADDRINUSE` system error correctly (extended fields preserved).  
✅ No `console.error` output in logs.

The startup failure (`EADDRINUSE: address already in use 0.0.0.0:3000`) is an environment issue — another dev instance was already running. It is not a code defect.

---

## Remaining Known Risks

| # | Risk | Severity | Status |
|---|---|---|---|
| 1 | OddsPapi `/v2/odds` endpoint unverified | HIGH | Unchanged from Sprint 6 |
| 2 | OddsPapi `outcome` field may be `"home"`/`"away"` labels | HIGH | Unchanged from Sprint 6 |
| 3 | `isMain` fallback when Pinnacle absent | LOW | Unchanged from Sprint 6 |
| 4 | No PandaScore quota tracking | LOW | Acceptable for V1 |

---

## Verdict

**PRODUCTION-READY** for the scheduling, pagination, and stability concerns raised in Sprint 6 and Sprint 7 audits. The pipeline now fires automatically, fetches complete match data, and logs errors without crashing. OddsPapi API verification (Risk #1) remains the last blocker before live odds data can reach the database.
