# Sprint 19 — Force Ingestion Command

**Date:** 2026-06-07  
**Scope:** Implement `/force-ingestion` Discord slash command for admin-triggered API ingestion  

---

## Files Created/Modified

| File | Status |
|---|---|
| `src/discord/commands/force-ingestion.ts` | **NEW** — command handler |
| `src/discord/discord-bot.service.ts` | **MODIFIED** — added handler + register command |
| `src/ingestion/bootstrap/ingestion-dependencies.ts` | **MODIFIED** — added `matchFetchQueue` to deps |

---

## Data Flow

```
/force-ingestion traditional basketball_nba
  │
  ├─ Validation: basketball_nba → sportGroup "Basketball"
  │
  ├─ matchFetchQueue.add('sync-traditional-sport', { sportKey: 'basketball_nba', sportGroup: 'Basketball' })
  │
  ├─ BullMQ Worker → MatchIngestionService.ingestTraditionalSport()
  │   ├─ **The Odds API**: GET /v4/sports/basketball_nba/odds?regions=eu&markets=h2h&oddsFormat=decimal
  │   ├─ Upserts Sport / League / Team / Match / TeamLeague to PostgreSQL
  │   └─ Returns nearTermMatchExternalIds
  │
  ├─ oddsFetchQueue.add('sync-odds-for-sport', { matchExternalIds })
  │   └─ OddsSnapshotWorker → OddsSnapshotIngestionService
  │       ├─ **The Odds API**: GET /v4/sports/basketball_nba/odds?eventIds=...
  │       └─ OddsSnapshotRepository.insertMany() → OddsSnapshot records
  │
  ├─ ValueDetectionService.detectForMatchExternalIds()
  │   └─ ValueOpportunityRepository.insertMany() → ValueOpportunity records
  │
  └─ DiscordNotificationService.notifyPendingOpportunities()
      └─ **Discord REST API**: sends value alert to configured channel
```

---

## Command Parameters

| Parameter | Type | Required | Choices |
|---|---|---|---|
| `source` | String | ✅ Yes | `traditional`, `esports`, `all` |
| `sport-key` | String | Optional | Any supported sport key (e.g. `basketball_nba`, `cs2`) |

### source = "traditional"

Enqueues `sync-traditional-sport` jobs for every configured sport (or a single sport-key).

### source = "esports"

Enqueues `sync-esports-game` jobs for every PandaScore-supported game (or a single game by key).

### source = "all"

Combined — enqueues all traditional + all esports jobs.

---

## Supported Sport Keys

### Traditional Sports (7)

| Key | Group |
|---|---|
| `tennis_atp` | Tennis |
| `tennis_wta` | Tennis |
| `icehockey_nhl` | Ice Hockey |
| `baseball_mlb` | Baseball |
| `basketball_nba` | Basketball |
| `soccer_epl` | Soccer |
| `soccer_uefa_champs_league` | Soccer |

### Esports (4)

| Key | Videogame |
|---|---|
| `cs2` | CS2 |
| `dota2` | Dota 2 |
| `lol` | League of Legends |
| `valorant` | Valorant |

---

## Sample Response

```
🚀 FORCE INGESTION

Source: all
Sport Key: (all)
Jobs Enqueued: 11
  • match-fetch → sync-traditional-sport
  • match-fetch → sync-traditional-sport
  ... (7 traditional + 4 esports jobs)

Jobs will execute asynchronously. Check /bot-status for OddsSnapshot count changes.
```

---

## Data Source Verification

| Command | Source | API Calls | DB Reads | DB Writes |
|---|---|---|---|---|
| `/force-ingestion traditional` | **The Odds API** (live fetch) | ✅ Yes (1 HTTP per sport key) | Existing sports/leagues read | New Match + OddsSnapshot records |
| `/force-ingestion esports` | **PandaScore API** (live fetch) | ✅ Yes (2 HTTP per game) | Existing data read | New Match records |
| `/force-ingestion all` | Both APIs | ✅ Full pipeline | Read + Write | Match + OddsSnapshot + ValueOpportunity |

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| Reuses existing BullMQ queues | ✅ `matchFetchQueue.add(...)` |
| Reuses existing job names | ✅ `MATCH_FETCH_JOB_NAMES.SYNC_TRADITIONAL_SPORT` |
| Reuses existing payload types | ✅ `SyncTraditionalSportJobData`, `SyncEsportsGameJobData` |
| Reuses existing worker processors | ✅ Workers already registered in Sprint 7 |
| Matching `sportKey` → `sportGroup` mapping | ✅ Hardcoded in `force-ingestion.ts` |
| Structured logging | ✅ All enqueue operations logged with jobId, queue, jobName |
| Error handling | ✅ `deferReply()` prevents Discord timeout on long operations |

---

## Verdict

**PASS** — `/force-ingestion` enqueues the same BullMQ jobs used by the scheduler. It triggers real external API calls (The Odds API, PandaScore), creates OddsSnapshot records, runs value detection, and triggers Discord alerts when value is found. API quota usage will increase proportionally to the number of jobs enqueued.