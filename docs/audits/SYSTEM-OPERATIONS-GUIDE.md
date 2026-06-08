# Betting Intelligence — System Operations Guide

**Document Version:** V1  
**Last Updated:** 2026-06-08  
**System Status:** Production-ready with known limitations  

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Infrastructure Requirements](#2-infrastructure-requirements)
3. [Application Startup](#3-application-startup)
4. [BullMQ Architecture](#4-bullmq-architecture)
5. [Scheduled Jobs & Polling](#5-scheduled-jobs--polling)
6. [Traditional Sports Ingestion](#6-traditional-sports-ingestion)
7. [Esports Ingestion](#7-esports-ingestion)
8. [OddsSnapshot Pipeline](#8-oddssnapshot-pipeline)
9. [Value Detection Pipeline](#9-value-detection-pipeline)
10. [Settlement Pipeline](#10-settlement-pipeline)
11. [Discord Notifications](#11-discord-notifications)
12. [Discord Slash Commands](#12-discord-slash-commands)
13. [External Providers](#13-external-providers)
14. [Monitoring & Health](#14-monitoring--health)
15. [Troubleshooting](#15-troubleshooting)
16. [Current Project Status](#16-current-project-status)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Application (Node.js)                     │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Prisma   │  │ Redis    │  │ BullMQ   │  │ Discord  │  │
│  │ ORM      │  │ Cache    │  │ Queues   │  │ Bot      │  │
│  │          │  │ + Queue  │  │ Workers  │  │ + Alerts │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │             │             │             │         │
│  ┌────▼─────────────▼─────────────▼─────────────▼──────┐ │
│  │              Core Services                           │ │
│  │  Ingestion │ Value Detection │ Settlement │ Summary │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Integration Layer                                 │ │
│  │  The Odds API │ PandaScore │ OddsPapi │ Discord   │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Version |
|---|---|---|
| Runtime | Node.js | LTS (20+) |
| Language | TypeScript | 5.x |
| Database | PostgreSQL (Neon) | Serverless |
| ORM | Prisma | 5.22 |
| Cache/Queue | Redis (Upstash) | 7.x |
| Queue Framework | BullMQ | 4.x |
| Package Manager | pnpm | 9.x |

---

## 2. Infrastructure Requirements

### Environment Variables (`.env`)

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | Yes | `development` or `production` |
| `LOG_LEVEL` | No | Default: `info` |
| `PORT` | No | Health check server port (default: 3000) |
| `DATABASE_URL` | Yes | PostgreSQL connection string (Neon) |
| `DIRECT_DATABASE_URL` | Yes | Direct connection for Prisma migrations |
| `REDIS_URL` | Yes | Redis connection string (Upstash) |
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DISCORD_CLIENT_ID` | Yes | Discord application ID |
| `DISCORD_GUILD_ID` | Yes | Discord server (guild) ID |
| `DISCORD_ALERT_CHANNEL_ID` | Yes | Channel for value bet alerts |
| `DISCORD_OUTCOMES_CHANNEL_ID` | No | Channel for settlement outcomes + daily summary |
| `THE_ODDS_API_KEY` | Yes | The Odds API key |
| `PANDASCORE_API_KEY` | Yes | PandaScore API key |
| `DEEPSEEK_API_KEY` | Yes | DeepSeek API key (future use) |
| `ODDSPAPI_API_KEY` | Yes | OddsPapi API key |

### External Services

| Service | Plan | Monthly Cost | Monthly Quota |
|---|---|---|---|
| Neon PostgreSQL | Free tier | $0 | 500 MB storage, shared compute |
| Upstash Redis | Free tier | $0 | 10 MB, 1000 commands/day |
| The Odds API | Basic (Paid Tier 1) | $0 (free tier) | 500 requests/month (free) | -> upgrade 30$ tierre
| PandaScore | Free tier | $0 | Limited to 50 results per call (no pagination) |
| OddsPapi | Varies | ~$0 (free tier) | Depends on plan |

---

## 3. Application Startup

### Starting the Application

```powershell
# From c:\Betting:
npm run dev
```

This runs:
```bash
tsx watch --env-file=.env src/main.ts
```

### Startup Sequence

```
1. Load configuration from environment variables via Zod validation
   ├── If any variable is missing → exit with fatal error
   
2. Create Logger (pino)

3. Create Application instance

4. Application.start():
   a. Initialize Prisma client
   b. Connect to PostgreSQL (prisma.$connect())
      ├── If database unreachable → startup fails
   c. Initialize Redis client (lazyConnect: true)
   d. Connect to Redis
      ├── Attempt verification: PING
      ├── If Redis unreachable → startup fails
   e. Create BullMQ queues (match-fetch, odds-fetch, ai-analysis)
   f. Bootstrap ingestion dependencies
      ├── Create all API clients (The Odds API, PandaScore, OddsPapi)
      ├── Create all repository instances
      ├── Create all service instances
      ├── Create all worker instances
      ├── Create DiscordBotService
   g. Create BullMQ workers with real processors
      ├── match-fetch → MatchIngestionWorker + ReferenceDataWorker + SettlementWorker + DailySummaryWorker
      ├── odds-fetch → OddsSnapshotWorker + EsportsOddsSnapshotWorker
      ├── ai-analysis → Placeholder (no processor registered yet)
   h. Resume workers (start processing jobs)
   i. Register repeatable scheduled jobs (see Section 5)
   j. Log in to Discord (WebSocket)
      ├── Register slash commands via REST API
      ├── If Discord token invalid → log warning, continue
   k. Start health check HTTP server on PORT
   l. Transition to RUNNING state
```

### Shutdown Sequence

```
SIGTERM / SIGINT received
→ Pause workers → Close workers → Close queues → Disconnect Redis → Disconnect Prisma → Exit
```

---

## 4. BullMQ Architecture

### Queues (3)

| Queue Name | Purpose | Processors |
|---|---|---|
| `match-fetch` | All ingestion, settlement, and summary jobs | ReferenceDataWorker, MatchIngestionWorker, SettlementWorker, DailySummaryWorker |
| `odds-fetch` | Odds snapshot creation from API responses | OddsSnapshotWorker, EsportsOddsSnapshotWorker |
| `ai-analysis` | AI-powered analysis (future use) | Placeholder |

### Job Flow

```
match-fetch queue
  │
  ├── sync-reference-data      → ReferenceDataWorker
  ├── sync-traditional-sport   → MatchIngestionWorker
  ├── sync-esports-game        → MatchIngestionWorker
  ├── settle-matches           → SettlementWorker
  └── daily-summary            → DailySummaryWorker
  │
  └── (triggers) ──→ odds-fetch queue
                        │
                        ├── sync-odds-for-sport   → OddsSnapshotWorker
                        └── sync-esports-odds     → EsportsOddsSnapshotWorker
```

### Retry Configuration

Traditional sport jobs: No custom retry (BullMQ defaults; 3 attempts by default).  
Odds-fetch jobs (esports): 2 attempts with 30s fixed backoff.  
All other jobs: Default BullMQ retry configuration.

---

## 5. Scheduled Jobs & Polling

### Reference Data Sync

| Job | Interval | What It Does |
|---|---|---|
| `sync-reference-data` | Every 24h | Fetches all active sports from The Odds API via `/v4/sports`; upserts Sport and League records |

### Traditional Sports Polling

Active window: **09:00–23:00 Europe/Budapest** (14 hours per day)

#### Tier 1 — 60 minutes (12 sports)

| Sport Key | Sport Group | Polls/Day |
|---|---|---|
| `icehockey_nhl` | Ice Hockey | 14 |
| `baseball_mlb` | Baseball | 14 |
| `basketball_wnba` | Basketball | 14 |
| `soccer_usa_mls` | Soccer | 14 |
| `tennis_atp_wimbledon` | Tennis | 14 |
| `tennis_atp_us_open` | Tennis | 14 |
| `tennis_atp_indian_wells` | Tennis | 14 |
| `tennis_atp_miami_open` | Tennis | 14 |
| `tennis_wta_wimbledon` | Tennis | 14 |
| `tennis_wta_us_open` | Tennis | 14 |
| `tennis_wta_indian_wells` | Tennis | 14 |
| `tennis_wta_miami_open` | Tennis | 14 |

#### Tier 2 — 4 hours (4 sports)

| Sport Key | Sport Group | Polls/Day |
|---|---|---|
| `basketball_nba` | Basketball | 4 |
| `soccer_epl` | Soccer | 4 |
| `soccer_uefa_champs_league` | Soccer | 4 |
| `americanfootball_ncaaf` | Football | 4 |

**Total match-fetch polls per day:** 184  
**Total match-fetch polls per month (30 days):** 5,520  

Each poll calls The Odds API `GET /v4/sports/{sportKey}/odds` once = 1 credit.  
If near-term matches exist, a `sync-odds-for-sport` job fires — another 1 credit call.  
**Estimated monthly consumption:** 7,740–11,040 credits (typical to worst case).

### Esports Polling

| Job | Schedule (Budapest) | Games |
|---|---|---|
| `sync-esports-game` | 12:00 and 17:00 | cs2, dota2, lol, valorant |

Each run fetches upcoming + running matches from PandaScore.  
If near-term matches exist for an OddsPapi-supported game, `sync-esports-odds` fires after
a 4-hour cooldown.

### Settlement

| Job | Schedule | What It Does |
|---|---|---|
| `settle-matches` | Every 4h | Checks finished matches against predicted outcomes; updates ValueOpportunity records with WIN/LOSS/VOID |

### Daily Summary

| Job | Schedule | What It Does |
|---|---|---|
| `daily-summary` | 23:00 Budapest | Calculates daily win rate, ROI, and P&L; sends to Discord outcomes channel |

---

## 6. Traditional Sports Ingestion Flow

```
Schedule fires (Tier 1: every 60 min, Tier 2: every 4h)
  → matchFetchQueue.add('sync-traditional-sport', { sportKey, sportGroup })
  
MatchIngestionWorker.process(job)
  → MatchIngestionService.ingestTraditionalSport(sportKey, sport)
      ├── GET /v4/sports/{sportKey}/odds?regions=eu,us,uk&markets=h2h,spreads,totals&oddsFormat=decimal
      │     └── Returns events: each with id, commence_time, home_team, away_team, bookmakers
      ├── Maps each event to OddsApiIngestionPlan (sport, league, team, match, oddsSnapshots)
      ├── Upserts Sport (by slug)
      ├── Upserts League (by sportId + externalId)
      ├── Upserts Team (by sportId + externalId)
      ├── Upserts Match (by externalId — globally unique)
      ├── Upserts TeamLeague (by (teamId, leagueId))
      └── Returns nearTermMatchExternalIds (matches starting within 48h)
  
  → If near-term matches exist:
      oddsFetchQueue.add('sync-odds-for-sport', { sportKey, matchExternalIds })
      └── 5-second delay before odds job fires
```

### Sport Key → Sport Group Mapping

| Sport key suffix | Group |
|---|---|
| `tennis_*` | Tennis |
| `icehockey_*` | Ice Hockey |
| `baseball_*` | Baseball |
| `basketball_*` | Basketball |
| `soccer_*` | Soccer |
| `americanfootball_*` | Football |

The group field determines the Sport.slug (via `slugify()`).

### 404 Handling

If The Odds API returns HTTP 404 (unknown sport key), `ingestTraditionalSport()` catches
the `ExternalApiError` with `statusCode === 404`, logs a warning, and returns an empty
result. The pipeline continues — no job failure.

---

## 7. Esports Ingestion Flow

```
Schedule fires (12:00 and 17:00 Budapest)
  → matchFetchQueue.add('sync-esports-game', { videogame })

MatchIngestionWorker._handleEsportsGame(job)
  → MatchIngestionService.ingestEsportsGame(videogame)
      ├── PandaScore: GET /{videogame}/matches/upcoming
      ├── PandaScore: GET /{videogame}/matches/running
      ├── Deduplicates by match ID (Set<number>)
      ├── Maps each match to PandascoreIngestionPlan (or null → skipped)
      ├── Upserts Sport / League / Team / Match / TeamLeague
      └── Returns nearTermMatchExternalIds ("ps:"-prefixed IDs)
  
  → If near-term matches exist AND game is OddsPapi-supported:
      Check Redis cooldown key: {env}:esports-odds-cooldown:{videogame}
      ├── If cooldown expired (4h):
      │     oddsFetchQueue.add('sync-esports-odds', { videogame, matchExternalIds })
      │     Set Redis cooldown key with 4h TTL
      └── If cooldown active:
            Skip — log debug message
```

### Video Game Key Mapping

| Domain Key | PandaScore Slug | OddsPapi Key |
|---|---|---|
| `cs2` | `csgo` | `cs2` |
| `dota2` | `dota2` | `dota2` |
| `lol` | `lol` | `lol` |
| `valorant` | `valorant` | `valorant` |

---

## 8. OddsSnapshot Pipeline

### Traditional Sports

```
sync-odds-for-sport worker
  → OddsSnapshotIngestionService.ingestOddsForSport(sportKey, sport, matchExternalIds)
      ├── Filters "oa:"-prefixed IDs only
      ├── GET /v4/sports/{sportKey}/odds?eventIds={ids}&regions=eu,us,uk&markets=h2h,spreads,totals
      ├── Maps each bookmaker/market/outcome triple → CanonicalOddsSnapshot
      ├── Skips FINISHED/CANCELLED/POSTPONED matches
      └── OddsSnapshotRepository.insertMany(snapshots)
```

### Esports

```
sync-esports-odds worker
  → EsportsOddsSnapshotIngestionService.ingestOddsForGame(videogame, matchExternalIds)
      ├── Filters "ps:"-prefixed IDs only
      ├── MatchRepository.findManyWithTeamsByExternalIds(psIds)
      ├── OddsPapi: GET /v4/tournaments → GET /v4/odds-by-tournaments → GET /v4/participants
      │     (quota-protected via ResilientOddspapiClient)
      ├── correlateMatch() per OddsPapi match:
      │     ├── Normalize team names (lowercase + remove non-alphanumeric)
      │     ├── Resolve aliases (NaVi → Natus Vincere, etc.)
      │     ├── Time tolerance: ±30 minutes
      │     ├── Pass 1: Exact match (normalized + aliased)
      │     └── Pass 2: Substring match (minimum 4 chars)
      └── OddsSnapshotRepository.insertMany(snapshots)
```

### OddsPapi Request Cost

Each `getOddsForGame()` call (counted as 1 quota unit) makes:
1. `GET /v4/tournaments?sportId=...` — 1 request
2. `GET /v4/odds-by-tournaments` — 1 request per bookmaker per chunk
3. `GET /v4/participants` — 1 request

With Pinnacle-only (Sprint 21 optimization), this is ~3 requests per game cycle.

---

## 9. Value Detection Pipeline

### Trigger

Value detection runs after every `sync-odds-for-sport` and `sync-esports-odds` job that
created at least 1 OddsSnapshot record.

### Algorithm

```
ValueDetectionService.detectForMatchExternalIds(matchExternalIds)
  → Reads OddsSnapshot records for those matches (H2H, non-live)
  → Groups by matchId
  → For each match:
      ├── Filters to latest capturedAt batch
      ├── Groups by outcome name
      ├── For each outcome:
      │     ├── Find Pinnacle snapshot (candidate)
      │     ├── Find non-Pinnacle snapshots (consensus, minimum 2 required)
      │     ├── Calculate consensus probability (mean of implied probs)
      │     ├── Calculate expected fair odds (1 / consensusProbability)
      │     ├── Calculate edgePct ((pinnacleOdds / fairOdds) - 1) × 100
      │     ├── If edge < 5.0%: REJECTED
      │     ├── If edge > 100%: INVALID_DATA (data quality anomaly)
      │     ├── If edge passes thresholds: DETECTED
      │     └── Insert ValueOpportunity record
      └── Returns: matchesAnalyzed, detected, rejected, skipped
```

### ValueOpportunity Record

| Field | Description |
|---|---|
| `matchId` | FK to Match |
| `sport` | Sport slug (e.g. "basketball") |
| `bookmaker` | Always "pinnacle" |
| `outcome` | Team name string |
| `bookmakerOdds` | Pinnacle decimal odds |
| `fairOdds` | Calculated fair odds |
| `edgePercentage` | Value edge (5–100%) |
| `consensusProbability` | Mean consensus probability |
| `consensusBookmakers` | Bookmakers used for consensus |
| `capturedAt` | When the odds snapshot was taken |
| `alertedAt` | Set when Discord notification sent |
| `settledAt` | Set when match settles |
| `betResult` | WIN/LOSS/VOID after settlement |
| `profitLossUnits` | Calculated profit/loss |

---

## 10. Settlement Pipeline

```
SettlementWorker.process(job)
  → SettlementService.settleOpportunities()
      ├── Finds ValueOpportunities where settledAt IS NULL
      ├── For each opportunity, checks match status:
      │     ├── Match still SCHEDULED or LIVE: skip
      │     ├── Match FINISHED:
      │     │     ├── If outcome matches result: WIN
      │     │     ├── If outcome does not match: LOSS
      │     │     └── If CANCELLED or result null: VOID
      │     └── Updates opportunity with settledAt, betResult, profitLossUnits
      └── Returns array of SettledOpportunityNotification
  → DiscordNotificationService.notifySettledOutcomes(settled)
      └── Sends win/loss/void messages to outcomes channel
```

---

## 11. Discord Notifications

### Three Notification Types

| Type | Trigger | Channel | Format |
|---|---|---|---|
| Value bet alert | OddsSnapshot created + value detected | `DISCORD_ALERT_CHANNEL_ID` | 🎯 VALUE BET DETECTED |
| Settlement outcome | Match settles | `DISCORD_OUTCOMES_CHANNEL_ID` | ✅/❌ WIN/LOSS |
| Daily summary | 23:00 Budapest | `DISCORD_OUTCOMES_CHANNEL_ID` | 📊 DAILY SUMMARY |

### Alert Format

```
🎯 VALUE BET DETECTED

Sport: Basketball
Match: Team A vs Team B

Outcome: Team A
Bookmaker: Pinnacle

Odds: 2.10
Fair Odds: 1.85
Edge: +13.5%

Captured: 2026-06-07 18:30 UTC
```

### Settlement Format

```
✅ WIN — Tennis | Nadal vs Djokovic
Outcome: Nadal | Odds: 1.72 | Edge: +7.2% | P/L: +0.72u
Settled: 2026-06-07 20:15 UTC
```

### Daily Summary Format

```
📊 DAILY SUMMARY — 7 June 2026

Settled Bets: 8
Wins: 5 | Losses: 3 | Void: 0
Win Rate: 62.5%
Profit: +2.35u | ROI: +29.4%
```

---

## 12. Discord Slash Commands

### `/test-value-bets`

**Purpose:** Display top 5 ValueOpportunity records by edge percentage.  
**Data source:** PostgreSQL (ValueOpportunity table) — no external API calls.  
**Admin-only:** Yes.  
**Example output:**

```
**Data Source:** PostgreSQL (ValueOpportunity table)
**Records:** 5 | **Duration:** 45ms

📊 TOP VALUE BETS

Basketball | Team A vs Team B
Outcome: Team A @ Pinnacle
Odds: 2.10 | Fair: 1.85 | Edge: +13.5%
Captured: 2026-06-07 18:30 UTC
```

### `/bot-status`

**Purpose:** Display infrastructure health and entity counts.  
**Data source:** PostgreSQL (live query) + Redis (PING) + BullMQ (live counts).  
**Admin-only:** Yes.  
**Example output:**

```
**Data Source:** Live Infrastructure
**Duration:** 120ms

🤖 BOT STATUS

Database: ✅ Connected (12ms)
Redis: ✅ Connected (8ms)

Queue Counts:
  match-fetch: waiting=0 active=0 failed=0
  odds-fetch: waiting=0 active=0 failed=0
  ai-analysis: waiting=0 active=0 failed=0

Total Matches: 145
Total OddsSnapshots: 2,340
Total ValueOpportunities: 12
```

### `/force-scan`

**Purpose:** Re-run value detection on existing OddsSnapshot records (does NOT fetch new API data).  
**Data source:** PostgreSQL (OddsSnapshot table — cached).  
**API calls:** 0.  
**Admin-only:** Yes.  
**Example output:**

```
**Data Source:** PostgreSQL (OddsSnapshot table — cached)
**API Calls:** 0 | **Duration:** 234ms

🔍 FORCE SCAN COMPLETE

Matches scanned: 12
Opportunities detected: 3
Rejected (below threshold): 5
Skipped (insufficient data): 4
```

### `/force-ingestion`

**Purpose:** Trigger real API ingestion cycle from Discord. Enqueues BullMQ jobs identical to scheduled ones.  
**Parameters:**
- `source` (required): `traditional` | `esports` | `all`
- `sport-key` (optional): Specific sport key (e.g. `basketball_nba`, `cs2`)

**Data source:** External APIs (The Odds API / PandaScore / OddsPapi).  
**Admin-only:** Yes.  
**Example output:**

```
**Data Source:** External API (BullMQ → Ingestion Worker)
**API Calls:** Pending (enqueued)

🚀 FORCE INGESTION

Source: traditional
Sport Key: basketball_nba
Jobs Enqueued: 1
  • match-fetch → sync-traditional-sport

Jobs will execute asynchronously.
```

---

## 13. External Providers

### The Odds API

| Property | Value |
|---|---|
| Base URL | `https://api.the-odds-api.com/v4/` |
| Auth | `apiKey` query parameter |
| Endpoints used | `/sports`, `/sports/{sport}/odds`, `/sports/{sport}/scores` |
| Monthly limit | 500 (free) / ~20,000 (Basic Paid) |
| Typical monthly usage | 7,740–11,040 (current config) |
| Used for | Traditional sports match data + odds |

### PandaScore

| Property | Value |
|---|---|
| Base URL | `https://api.pandascore.co/` |
| Auth | Bearer token in Authorization header |
| Endpoints used | `/{videogame}/matches/upcoming`, `/{videogame}/matches/running` |
| Rate limit | Varies (no built-in tracking) |
| Used for | Esports match data (upcoming + running) |
| Known issue | Does NOT handle pagination — only returns first 50 results |

### OddsPapi

| Property | Value |
|---|---|
| Base URL | `https://api.oddspapi.io/` |
| Auth | `apiKey` query parameter |
| Endpoints used | `/v4/tournaments`, `/v4/odds-by-tournaments`, `/v4/participants` |
| Used for | Esports odds (H2H markets only) |
| Bookmaker | Pinnacle only (bet365/unibet removed in Sprint 21) |
| Cooldown | 4 hours between calls per game |
| Monthly limit | ~10,000 (hard limit in config) |

### Discord

| Property | Value |
|---|---|
| Bot mode | REST API (no WebSocket needed for alerts) + WebSocket for commands |
| Intents | `Guilds` only |
| Commands | 4 slash commands, guild-specific registration |
| Alerts | Value bet alerts + settlement outcomes + daily summary |

### Neon PostgreSQL

| Property | Value |
|---|---|
| Connection | Serverless via `DATABASE_URL` |
| Migrations | `DATABASE_URL` for pooled; `DIRECT_DATABASE_URL` for schema changes |
| Pool size | 13 connections (Prisma default) |

### Upstash Redis

| Property | Value |
|---|---|
| Connection | `REDIS_URL` |
| `maxRetriesPerRequest` | `null` (BullMQ requirement) |
| Used for | BullMQ queue state, cooldown keys, OddsPapi quota counter |

---

## 14. Monitoring & Health

### Health Check Endpoint

```
GET http://localhost:3000/health
```

Returns JSON:
```json
{
  "status": "healthy",        // "healthy" | "degraded" | "unhealthy"
  "state": "RUNNING",         // Application state enum
  "uptime": 1234567,          // Milliseconds since start
  "database": "connected",    // "connected" | "unreachable"
  "redis": "connected",       // "connected" | "unreachable"
  "queues": {                  // Per-queue status
    "match-fetch": { "waiting": 0, "active": 0, "failed": 0 },
    "odds-fetch": { "waiting": 0, "active": 0, "failed": 0 },
    "ai-analysis": { "waiting": 0, "active": 0, "failed": 0 }
  },
  "timestamp": "2026-06-07T18:30:00.000Z"
}
```

### Viewing Logs

The application uses pino logging. Output format depends on `NODE_ENV`:
- `development`: Pretty-printed to console
- `production`: JSON lines (pipe to file or log aggregator)

Log modules:
- `prisma` — database operations
- `redis` — Redis connection events
- `bullmq` — Queue and worker events
- `ingestion-bootstrap` — Dependency wire-up
- `ingestion-scheduler` — Repeatable job registration
- `DiscordBotService` — Bot login and command handling
- `DiscordNotificationService` — Alert delivery
- `ValueDetectionService` — Value detection decisions
- `EsportsOddsSnapshotIngestionService` — Esports odds pipeline
- `health` — Health check server

---

## 15. Troubleshooting ---> ezek megvannak

### The Odds API Quota Exhausted

**Symptoms:** `ExternalApiError: The Odds API returned HTTP 429` in logs.  
**Impact:** Traditional sports polling stops returning data. Jobs still run but return empty results.  
**Resolution:**
1. Check current usage at [The Odds API dashboard](https://the-odds-api.com)
2. Upgrade plan if needed
3. Reduce polling frequency in `app.ts` `TRADITIONAL_SPORT_CONFIGS`

### PandaScore Failures

**Symptoms:** `ExternalApiError: PandaScore API returned HTTP 4xx/5xx` in logs.  
**Common causes:**
- API key expired or invalid
- Rate limit exceeded
- Server error (5xx — retryable)

**Resolution:**
1. Verify API key in `.env`
2. Check PandaScore status page
3. Errors are automatically retried by BullMQ

### OddsPapi Failures

**Symptoms:**
- `QuotaExhaustedError` — monthly quota exceeded
- `ExternalApiError` — network or API error

**Behavior:**
- `QuotaExhaustedError` → Worker returns empty result gracefully (not a failed job)
- Other errors → Bubble up as BullMQ job failures (retried)

**Resolution:**
1. Check OddsPapi dashboard for usage
2. Adjust `QUOTA_SOFT_LIMIT` / `QUOTA_HARD_LIMIT` in `src/integrations/oddspapi/oddspapi.config.ts`
3. The 4-hour cooldown prevents rapid-fire retries

### Discord Bot Offline

**Symptoms:** Slash commands don't appear or don't respond.  
**Startup logs:** `Discord bot login failed — continuing without slash commands`  
**Common causes:**
- `DISCORD_TOKEN` is invalid or expired
- `DISCORD_CLIENT_ID` / `DISCORD_GUILD_ID` mismatch
- Discord bot not added to guild
- Intents not configured in Discord Developer Portal

**Resolution:**
1. Verify token: `DISCORD_TOKEN` in `.env`
2. Re-invite bot to guild with `applications.commands` scope
3. Ensure `Guilds` intent is enabled in Discord Developer Portal
4. Slash command registration failure is non-fatal — alerts still work via REST API

### Redis Disconnected

**Symptoms:** `Redis connection closed` + BullMQ workers stop processing.  
**Impact:** All ingestion stops entirely.  
**Resolution:**
1. Check Upstash dashboard
2. Verify `REDIS_URL` in `.env`
3. Application will crash on startup — `$connect()` throws

### Prisma Connection Closed

**Symptoms:** `Error in PostgreSQL connection: Error { kind: Closed, cause: None }`  
**Impact:** All database operations fail.  
**Resolution:**
1. Check Neon dashboard for connection limits
2. Neon free tier has a connection pool limit — multiple `npm run dev` instances can
   exhaust it
3. Kill stale Node processes: `taskkill /F /IM node.exe`

### BullMQ Failed Jobs

**Symptoms:** `Worker job failed` log entries.  
**View failed jobs:**
```
GET http://localhost:3000/health
```
Check `failed` counts in queue status.

**Common causes:**
- API quota exhausted
- Network timeout
- Invalid sport key (HTTP 404 — now handled gracefully since Sprint 13)
- Missing `regions` parameter (HTTP 422 — fixed in Sprint 13)
- `jobId` containing `:` character (fixed in Sprint 20)

### Legacy Sport Key Issues

**Symptoms:** `Sport key not found — skipping (may be inactive tournament key)` warnings.  
**Cause:** `tennis_atp` and `tennis_wta` were used in early versions but return HTTP 404 from The Odds API.  
**Status:** Removed in Sprint 22. If still present in your config, remove them.

### No Value Bets Generated

**Checklist:**
1. Are OddsSnapshot records being created? (Check `/bot-status`)
2. Are matches being ingested? (Check `/bot-status` → Matches count)
3. Are there at least 3 bookmakers per outcome? (ValueDetectionService requires
   Pinnacle + 2 consensus bookmakers. With Pinnacle-only from OddsPapi, esports
   value bets cannot be generated for esports matches — `consensusSnaps.length < 2`
   will always be true)
4. Is the edge ≥ 5%?

**Known V1 limitation:** Esports value bets cannot be generated because OddsPapi
provides Pinnacle-only odds and the consensus model requires ≥2 non-Pinnacle bookmakers.
Only traditional sports (The Odds API, which provides multiple bookmakers) can produce
value opportunities.

### No Discord Alerts Generated

**Checklist:**
1. Is `DISCORD_ALERT_CHANNEL_ID` set correctly?
2. Are ValueOpportunity records being created? (Check `/test-value-bets`)
3. Do records have `alertedAt: null`? (Already-alerted records are skipped)
4. Check logs for `Discord alert failed` messages
5. Verify bot has `Send Messages` permission in the channel

---

## 16. Current Project Status

### ✅ Production Ready

- **PostgreSQL connection** — stable, validated with Neon
- **Redis connection** — stable, validated with Upstash
- **BullMQ queues & workers** — fully wired with real processors
- **Traditional sports ingestion** — works with The Odds API (regions/markets/oddsFormat fix applied)
- **OddsSnapshot creation** — both traditional and esports paths
- **Value detection** — working for traditional sports with multiple bookmakers
- **Discord notifications** — value bet alerts, settlement outcomes, daily summary
- **Discord slash commands** — 4 commands registered and functional
- **Health check endpoint** — GET /health with full status
- **Graceful shutdown** — SIGTERM/SIGINT handling
- **Error serialization** — prevents pino crash on frozen objects

### ⚠️ Partially Complete

| Component | Status | Issue |
|---|---|---|
| Esports value bets | **Broken** | OddsPapi provides Pinnacle-only odds (Sprint 21). ValueDetectionService requires ≥2 consensus bookmakers. Esports value bets can never pass the `consensusSnaps.length < 2` check. Only traditional sports (The Odds API) can produce value opportunities. |
| PandaScore pagination | **Missing** | Only first 50 results fetched per game per call. Matches beyond page 1 are silently lost. |
| OddsPapi quota counter | **Under-counting** | Counts 1 per `getOddsForGame()` call, but each call makes 3–8 HTTP requests. |
| AI analysis | **Placeholder** | ai-analysis worker uses placeholder processor. DeepSeek integration not wired yet. |
| Tennis tournament keys | **Assumed correct** | The 8 configured tournament keys are syntactically plausible but not verified against live API responses. |

### 🐛 Known Issues

| Issue | Severity | Details |
|---|---|---|
| BullMQ jobId collision | Low | Esports odds jobs use `sync-esports-odds-{game}` for dedup. If a job with that ID already exists (even COMPLETED), new ones are silently ignored until the old one is removed from Redis. |
| Prisma non-extensible error | Low | Pino serializer crash on frozen Prisma errors — fixed with error serialization (Sprint 13). |
| ESLint ts-ignore in injection | Low | `QueueCollection` uses `{} as any` in `ingestion-dependencies.ts` for the Discord bot. |
| `ENV_PREFIX` hardcoded | Low | `match-ingestion.worker.ts` reads `NODE_ENV` directly instead of config. |

### 💸 Technical Debt

| Item | Impact | Effort to Fix |
|---|---|---|
| No PandaScore pagination | Missed matches beyond page 1 | Medium (implement page traversal) |
| No PandaScore or The Odds API rate limit tracking | Cannot alert on approaching limits | Low (add counter pattern like OddsPapi) |
| No tests for value detection algorithm | Edge cases may produce false positives | High (write unit tests) |
| `force-ingestion.ts` duplicates sport key → group mapping | Must keep in sync with `app.ts` | Low (extract to shared config) |
| OddsPapi quota counts 1 per logical call | Misleading quota monitoring | Low (count actual HTTP requests) |

### 🔧 Highest Priority Future Improvements

1. **Fix esports value detection** — Add at least one more bookmaker to OddsPapi config, or change consensus model ---> ez hibás review, müködik tökéletesen, tesztelve
2. **Implement PandaScore pagination** — Fetch all pages, not just first 50
3. **Wire AI analysis worker** — Connect DeepSeek V4 Flash to ai-analysis queue
4. **Add API key rotation/health monitoring** — Alert when quotas are approaching limits
5. **Shared sport config** — Extract sport keys from `app.ts` and `force-ingestion.ts` into a single source of truth
6. **Unit tests** — Critical for value detection, settlement, and correlation algorithms