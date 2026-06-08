# Betting Intelligence — System Architecture Diagram

**Date:** 2026-06-08  
**Purpose:** Complete visual architecture for the Betting Intelligence platform  

---

## 1. High-Level Architecture

```mermaid
graph TB
    subgraph Users
        DISCORD_USER[Discord User]
        ADMIN[Admin User]
    end

    subgraph Discord
        DC_BOT[Discord Bot<br/>slash commands]
        DC_ALERTS[Alert Channel<br/>value bets]
        DC_OUTCOMES[Outcomes Channel<br/>settlements + summary]
    end

    subgraph Application["Node.js Application (tsx watch)"]
        SCHEDULER[Scheduler<br/>BullMQ repeatable jobs]
        WORKER_MF[Worker: match-fetch]
        WORKER_OF[Worker: odds-fetch]
        WORKER_SETTLE[Worker: settlement]
        WORKER_SUMMARY[Worker: daily summary]
        VALUE_DETECTION[Value Detection Service]
        SETTLEMENT[Settlement Service]
        NOTIFICATION[Discord Notification Service]
    end

    subgraph Storage[" "]
        PG[(PostgreSQL<br/>Neon)]
        REDIS[(Redis<br/>BullMQ + cooldowns + quota)]
    end

    subgraph External["External APIs"]
        ODD_API[The Odds API<br/>traditional sports odds]
        PANDASCORE[PandaScore<br/>esports matches]
        ODDS_PAPI[OddsPapi<br/>esports odds]
    end

    DISCORD_USER -->|type slash command| DC_BOT
    ADMIN -->|type slash command| DC_BOT
    DC_BOT -->|read/write| PG

    SCHEDULER -->|enqueue jobs| WORKER_MF
    SCHEDULER -->|enqueue jobs| WORKER_SETTLE
    SCHEDULER -->|enqueue jobs| WORKER_SUMMARY
    
    WORKER_MF -->|fetch| ODD_API
    WORKER_MF -->|fetch| PANDASCORE
    WORKER_MF -->|enqueue odds jobs| WORKER_OF
    WORKER_MF -->|write| PG
    WORKER_MF -->|cooldown check| REDIS
    
    WORKER_OF -->|fetch| ODDS_PAPI
    WORKER_OF -->|write| PG
    WORKER_OF -->|VALUE_DETECTION| VALUE_DETECTION
    
    VALUE_DETECTION -->|write ValueOpportunity| PG
    
    WORKER_SETTLE -->|read matches| PG
    WORKER_SETTLE -->|write outcomes| PG
    
    NOTIFICATION -->|read pending| PG
    NOTIFICATION -->|POST message| DC_ALERTS
    NOTIFICATION -->|POST message| DC_OUTCOMES
    
    WORKER_SUMMARY -->|read settled| PG
    WORKER_SUMMARY -->|POST summary| DC_OUTCOMES

    WORKER_MF -->|job state| REDIS
    WORKER_OF -->|job state| REDIS
    WORKER_SETTLE -->|job state| REDIS
```

---

## 2. Component Table

| Component | Responsibility | Data Source | Output |
|---|---|---|---|
| **Scheduler** | Registers BullMQ repeatable jobs at startup | Hardcoded config in `app.ts` | BullMQ repeatable job definitions |
| **MatchIngestionWorker** | Fetches matches + odds from The Odds API / PandaScore | The Odds API, PandaScore | Match, Team, League, Sport, TeamLeague records |
| **OddsSnapshotWorker** | Fetches filtered odds by match IDs | The Odds API | OddsSnapshot records |
| **EsportsOddsSnapshotWorker** | Fetches esports odds from OddsPapi, correlates by team name | OddsPapi, PostgreSQL | OddsSnapshot records |
| **ReferenceDataWorker** | Syncs active sports list | The Odds API `/v4/sports` | Sport, League records |
| **ValueDetectionService** | Computes consensus probability, fair odds, edge, filters longshots | OddsSnapshot (PostgreSQL) | ValueOpportunity records |
| **SettlementWorker** | Checks finished matches, resolves bet outcomes | PostgreSQL (Match + The Odds API scores) | ValueOpportunity.settledAt, .betResult, .profitLossUnits |
| **DailySummaryWorker** | Aggregates 24h settled bets, calculates win rate + ROI | PostgreSQL (ValueOpportunity) | Discord message to outcomes channel |
| **DiscordNotificationService** | Sends value alerts, settlement outcomes, daily summaries | PostgreSQL (ValueOpportunity) | Discord HTTP REST POST |
| **DiscordBotService** | WebSocket bot for slash commands | PostgreSQL, Redis, BullMQ | Discord interaction replies |
| **OddspapiQuotaTracker** | Atomic Redis Lua counter for monthly OddsPapi calls | Redis | Throws `QuotaExhaustedError` at limit |
| **Health Server** | GET /health endpoint with DB + Redis + queue status | PostgreSQL, Redis, BullMQ | JSON health response |

---

## 3. Match Ingestion Flow

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant Q as match-fetch Queue
    participant W as MatchIngestionWorker
    participant API as The Odds API / PandaScore
    participant DB as PostgreSQL
    participant R as Redis

    Note over S: Repeatable job fires

    S->>Q: add('sync-traditional-sport', {sportKey, sportGroup})
    S->>Q: add('sync-esports-game', {videogame})

    Q->>W: process(job)

    alt Traditional Sport
        W->>API: GET /v4/sports/{sportKey}/odds?regions=eu&markets=h2h&oddsFormat=decimal
        API-->>W: RawOddsApiMatchOdds[]
        W->>W: OddsApiEventMapper → IngestionPlan
        W->>DB: upsert Sport / League / Team / Match / TeamLeague
        W->>W: Compute nearTermMatchExternalIds (48h window)
        
        Note over W: If near-term matches exist
        W->>Q: add('sync-odds-for-sport', {matchExternalIds})
        
    else Esports Game
        W->>API: getUpcomingMatches() + getRunningMatches()
        API-->>W: RawPandascoreMatch[]
        W->>W: Deduplicate by match ID
        W->>W: PandascoreMatchMapper → PandascoreIngestionPlan
        W->>DB: upsert Sport / League / Team / Match / TeamLeague
        
        Note over W: If near-term matches + OddsPapi-supported + cooldown expired
        W->>R: GET cooldown key
        R-->>W: lastEnqueuedAt
        
        Note over W: If cooldown expired
        W->>Q: add('sync-esports-odds', {videogame, matchExternalIds})
        W->>R: SET cooldown key (14400s TTL)
    end
```

---

## 4. Odds Ingestion Flow

```mermaid
sequenceDiagram
    participant Q as odds-fetch Queue
    participant W as OddsSnapshotWorker
    participant EW as EsportsOddsSnapshotWorker
    participant API as The Odds API
    participant EPI as OddsPapi
    participant DB as PostgreSQL

    Note over Q: sync-odds-for-sport job

    Q->>W: process(job)
    W->>W: Filter "oa:"-prefixed IDs
    W->>API: GET /v4/sports/{sportKey}/odds?eventIds=...
    API-->>W: RawOddsApiMatchOdds[]
    W->>W: OddsApiEventMapper → CanonicalOddsSnapshot[]
    W->>W: Skip FINISHED/CANCELLED/POSTPONED
    W->>DB: insertMany(OddsSnapshot)

    Note over Q: sync-esports-odds job

    Q->>EW: process(job)
    EW->>EW: Filter "ps:"-prefixed IDs
    EW->>DB: findManyWithTeamsByExternalIds()
    DB-->>EW: DbMatchWithTeams[]

    EW->>EPI: getOddsForGame(oddspapiGameKey)
    
    Note over EPI: Protected by 3 layers:
    Note over EPI: 1. 4h Redis cooldown
    Note over EPI: 2. Lua quota counter
    Note over EPI: 3. QuotaExhaustedError
    
    EPI->>EPI: GET /v4/tournaments
    EPI->>EPI: GET /v4/odds-by-tournaments (per bookmaker chunk)
    EPI->>EPI: GET /v4/participants
    EPI-->>EW: OddspapiMatchOdds[]

    EW->>EW: correlateMatch() per match
    Note over EW: normalizeTeamName → resolveAlias → exact match → substring match
    
    EW->>DB: insertMany(OddsSnapshot)
```

---

## 5. Value Detection Flow

```mermaid
sequenceDiagram
    participant W as Worker
    participant V as ValueDetectionService
    participant DB as PostgreSQL
    participant N as DiscordNotificationService

    Note over W: After OddsSnapshot.created > 0

    W->>V: detectForMatchExternalIds(matchExternalIds)
    
    V->>DB: findMany OddsSnapshot (H2H, non-live)
    DB-->>V: SnapshotRow[]

    V->>V: Group by matchId
    V->>V: Filter to latest capturedAt batch
    V->>V: Group by outcome name
    
    loop Each outcome
        V->>V: Find Pinnacle snapshot (candidate)
        V->>V: Find non-Pinnacle snapshots (consensus)
        
        Note over V: Minimum 2 consensus bookmakers required
        
        V->>V: impliedProbs = [1/odds1, 1/odds2, ...]
        V->>V: consensusProbability = mean(impliedProbs)
        V->>V: fairOdds = 1 / consensusProbability
        V->>V: edgePct = ((pinnacleOdds / fairOdds) - 1) × 100
        
        alt pinnacleOdds > MAX_ALERT_ODDS (3.0)
            Note over V: SKIPPED — ODDS_FILTERED
        else edgePct < 5.0%
            Note over V: SKIPPED — REJECTED
        else edgePct > 100%
            Note over V: SKIPPED — INVALID_DATA
        else
            V->>DB: insert ValueOpportunity
            Note over V: DETECTED
        end
    end

    W->>N: notifyPendingOpportunities()
    
    N->>DB: findMany ValueOpportunity (alertedAt IS NULL)
    DB-->>N: Pending opportunities[]
    
    loop Each pending opportunity
        N->>N: formatAlert() → Discord message
        N->>DC: POST channel message
        N->>DB: UPDATE alertedAt = now()
    end
```

---

## 6. Notification Flow

```mermaid
graph LR
    subgraph Triggers
        A[OddsSnapshot<br/>created > 0]
        B[Settlement<br/>complete]
        C[Daily Summary<br/>schedule fires]
    end

    subgraph Services
        V[ValueDetection<br/>Service]
        S[Settlement<br/>Service]
        D[DailySummary<br/>Worker]
    end

    subgraph Notification["DiscordNotificationService"]
        NP[notifyPending<br/>Opportunities]
        NS[notifySettled<br/>Outcomes]
        ND[notifyDaily<br/>Summary]
    end

    subgraph Database["PostgreSQL"]
        VO[(ValueOpportunity<br/>alertedAt=NULL)]
        VO2[(ValueOpportunity<br/>settledAt >= 24h)]
    end

    subgraph Discord
        AC[Alert Channel]
        OC[Outcomes Channel]
    end

    A --> V
    V -->|creates| VO
    V --> NP
    NP -->|reads| VO
    NP -->|POST 🎯| AC
    
    B --> S
    S --> NS
    NS -->|POST ✅/❌| OC
    
    C --> D
    D -->|reads| VO2
    D --> ND
    ND -->|POST 📊| OC
```

---

## 7. Settlement Flow

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant Q as match-fetch Queue
    participant W as SettlementWorker
    participant SV as SettlementService
    participant DB as PostgreSQL
    participant N as DiscordNotificationService

    Note over S: Every 4 hours

    S->>Q: add('settle-matches', {})
    Q->>W: process(job)
    
    W->>SV: settleOpportunities()
    
    SV->>DB: findMany ValueOpportunity (settledAt IS NULL)
    DB-->>SV: Unsettled opportunities[]
    
    loop Each unsettled opportunity
        SV->>DB: find match by matchId
        DB-->>SV: Match {status, result, homeScore, awayScore}
        
        alt Match status = FINISHED
            
            alt outcome matches result
                SV->>DB: UPDATE betResult=WIN, profitLossUnits=odds-1
            else outcome does not match
                SV->>DB: UPDATE betResult=LOSS, profitLossUnits=-1
            end
            
        else Match status = CANCELLED
            SV->>DB: UPDATE betResult=PUSH, profitLossUnits=0
        else Match still SCHEDULED/LIVE
            Note over SV: SKIP — will retry next cycle
        end
        
        SV->>DB: UPDATE settledAt = now()
    end

    SV-->>W: SettledOpportunityNotification[]
    
    W->>N: notifySettledOutcomes(settled)
    N->>N: formatOutcome() per notification
    N->>DC: POST outcome channel
```

---

## 8. Database Table Overview

```mermaid
erDiagram
    Sport ||--o{ League : has
    Sport ||--o{ Team : has
    Sport ||--o{ Match : has
    League ||--o{ TeamLeague : contains
    League ||--o{ Match : contains
    Team ||--o{ TeamLeague : belongs_to
    Team ||--o{ Match : home_team
    Team ||--o{ Match : away_team
    Match ||--o{ OddsSnapshot : has
    Match ||--o{ ValueOpportunity : has
    Match ||--o{ Analysis : has
    Analysis ||--o{ Prediction : has
    User ||--o{ Prediction : makes
    User ||--o{ Bankroll : has
    User ||--o{ UserPreferences : has

    Sport {
        string slug PK
        string name
        enum category "TRADITIONAL | ESPORTS"
        string externalSportKey
    }

    League {
        string externalId
        string name
        string slug
    }

    Team {
        string externalId
        string name
        string slug
    }

    Match {
        string externalId UK "oa:uuid | ps:number"
        datetime startTime
        enum status "SCHEDULED | LIVE | FINISHED | CANCELLED"
        enum result "HOME_WIN | AWAY_WIN | DRAW"
        int homeScore
        int awayScore
    }

    OddsSnapshot {
        string bookmaker "pinnacle | bet365 | ..."
        enum market "H2H | SPREADS | TOTALS"
        string outcome "Team name string"
        decimal price
        boolean isMain
        boolean isLive
        datetime capturedAt
    }

    ValueOpportunity {
        string bookmaker "always pinnacle"
        string outcome
        decimal bookmakerOdds
        decimal fairOdds
        decimal edgePercentage
        decimal consensusProbability
        string[] consensusBookmakers
        datetime capturedAt
        datetime alertedAt
        datetime settledAt
        enum betResult "WIN | LOSS | PUSH"
        decimal profitLossUnits
    }
```

### Key Relationships

| Parent | Child | Cardinality | FK Field |
|---|---|---|---|
| Sport | League | 1:N | `sportId` |
| Sport | Team | 1:N | `sportId` |
| League | TeamLeague | 1:N | `leagueId` |
| Team | TeamLeague | 1:N | `teamId` |
| Sport | Match | 1:N | `sportId` |
| League | Match | 1:N | `leagueId` |
| Team (home) | Match | 1:N | `homeTeamId` |
| Team (away) | Match | 1:N | `awayTeamId` |
| Match | OddsSnapshot | 1:N | `matchId` |
| Match | ValueOpportunity | 1:N | `matchId` |

---

## 9. API Dependency Table

| API | Endpoints Used | Purpose | Criticality | Monthly Quota |
|---|---|---|---|---|
| **The Odds API** | `GET /v4/sports`, `GET /v4/sports/{key}/odds`, `GET /v4/sports/{key}/scores` | Traditional sports match data + odds + results | **Critical** — no traditional sports without it | 500 (free) / ~20,000 (paid) |
| **PandaScore** | `GET /{videogame}/matches/upcoming`, `GET /{videogame}/matches/running` | Esports match discovery | **Critical** — no esports matches without it | Varies (no built-in tracking) |
| **OddsPapi (api.oddspapi.io)** | `GET /v4/tournaments`, `GET /v4/odds-by-tournaments`, `GET /v4/participants` | Esports odds (Pinnacle only) | **Important** — without it, no esports value bets | 10,000 (hard limit) |
| **Discord REST API** | `POST /channels/{id}/messages` | Send alerts, outcomes, summaries | **Important** — no user-facing alerts without it | 50 messages/second (guild) |
| **Discord WebSocket Gateway** | Login + interaction events | Slash command handling | **Nice to have** — login failure is non-fatal | N/A |

---

## 10. How a Value Bet Is Created (Step-by-Step)

```

Step 1: Scheduler Fires
        sync-traditional-sport(soccer_epl) fires every 4h
        or sync-esports-game(cs2) fires at 12:00/17:00 Budapest

Step 2: Match Ingestion
        Worker calls The Odds API or PandaScore
        Maps raw API data → canonical entities
        Upserts: Sport → League → Team → Match → TeamLeague

Step 3: Odds Enqueue
        If near-term matches exist (startTime within 48h):
        → enqueue sync-odds-for-sport (5s delay)
        or sync-esports-odds (subject to 4h cooldown)

Step 4: Odds Fetched
        Worker calls The Odds API with eventIds filter
        or OddsPapi with tournament IDs
        Maps bookmaker/market/outcome triples → CanonicalOddsSnapshot

Step 5: OddsSnapshot Stored
        insertMany(OddsSnapshot) → PostgreSQL
        Each snapshot: {matchId, bookmaker, market, outcome, price, capturedAt}

Step 6: Value Detection Triggered
        If oddsSnapshots.created > 0:
        → ValueDetectionService.detectForMatchExternalIds()

Step 7: Consensus Calculated
        Reads ALL OddsSnapshots for these matches (H2H, non-live)
        Groups by matchId → filters latest batch → groups by outcome
        For each outcome:
          pinnacleSnaps = [Pinnacle price]
          consensusSnaps = [all other bookmaker prices]

Step 8: Fair Odds Generated
        impliedProbs = [1/odds for each consensus bookmaker]
        consensusProbability = mean(impliedProbs)
        fairOdds = 1 / consensusProbability

Step 9: Edge Calculated
        edgePct = ((pinnacleOdds / fairOdds) - 1) × 100

Step 10: Filters Applied
        ① MAX_ALERT_ODDS check (3.0): pinnacleOdds > 3.0 → SKIP
        ② MIN_EDGE check (5%): edgePct < 5% → REJECTED
        ③ MAX_EDGE check (100%): edgePct > 100% → SKIP (data quality)

Step 11: ValueOpportunity Created
        insert ValueOpportunity {matchId, sport, bookmaker, outcome,
        bookmakerOdds, fairOdds, edgePercentage, consensusProbability}

Step 12: Discord Notification Sent
        notifyPendingOpportunities() reads all alertedAt=NULL records
        For each: formatAlert() → POST to Discord Alert Channel
        UPDATE alertedAt = now()
```

---

## 11. How a Settlement Is Created (Step-by-Step)

```

Step 1: Scheduler Fires
        settle-matches fires every 4h

Step 2: Unsettled Opportunities Queried
        SELECT * FROM ValueOpportunity WHERE settledAt IS NULL

Step 3: Match Status Checked
        For each unsettled opportunity:
          SELECT status, result FROM Match WHERE id = matchId

Step 4: Outcome Determined

        Match FINISHED:
          outcome == match.result   → betResult = WIN
                                     profitLossUnits = bookmakerOdds - 1
          outcome ≠ match.result   → betResult = LOSS
                                     profitLossUnits = -1

        Match CANCELLED:
                                     betResult = PUSH
                                     profitLossUnits = 0

        Match SCHEDULED/LIVE:
                                     SKIP (retry next cycle)

Step 5: ValueOpportunity Updated
        UPDATE settledAt = now()
        UPDATE betResult = WIN|LOSS|PUSH
        UPDATE profitLossUnits = calculated value

Step 6: Outcome Notifications Sent
        notifySettledOutcomes() formats each as:
        ✅ WIN / ❌ LOSS / ⚪ VOID
        POST to Discord Outcomes Channel
```

---

## 12. Current Infrastructure

```mermaid
graph TB
    subgraph Development
        LOCAL_DEV["npm run dev<br/>tsx watch"]
        PG_DEV[("PostgreSQL<br/>Neon (hosted)")]
        R_DEV[("Redis<br/>Local Docker<br/>redis:7-alpine")]
    end

    subgraph Scheduler["50 Traditional + 4 Esports"]
        T1["Tier 1: 60min<br/>4 leagues + 8 tennis"]
        T2["Tier 2: 4h<br/>NBA, EPL, UCL, NCAAF"]
        T3["Tier 3: 3h<br/>34 soccer leagues"]
        ESP["Esports: 12:00 + 17:00<br/>CS2, Dota2, LoL, Valorant"]
    end

    subgraph ExternalProviders
        OA[The Odds API<br/>api.the-odds-api.com/v4]
        PS[PandaScore<br/>api.pandascore.co]
        OP[OddsPapi<br/>api.oddspapi.io/v4]
        DC[Discord<br/>discord.com/api/v10]
    end

    LOCAL_DEV -->|reads .env| PG_DEV
    LOCAL_DEV -->|REDIS_URL| R_DEV
    LOCAL_DEV -->|THE_ODDS_API_KEY| OA
    LOCAL_DEV -->|PANDASCORE_API_KEY| PS
    LOCAL_DEV -->|ODDSPAPI_API_KEY| OP
    LOCAL_DEV -->|DISCORD_TOKEN| DC

    Scheduler -->|BullMQ repeatable jobs| LOCAL_DEV
```

### Infrastructure Details

| Component | Technology | Connection | Persistence |
|---|---|---|---|
| **Application** | Node.js + TypeScript + pnpm | Local | N/A |
| **Database** | PostgreSQL via Neon (serverless) | `DATABASE_URL` | **Persistent** — all business data |
| **Cache/Queue** | Redis 7 (local Docker) | `REDIS_URL=redis://localhost:6379` | Ephemeral — job state, cooldowns, quota counter |
| **Queue Framework** | BullMQ 4.x on Redis | Shared Redis connection | Ephemeral — recreated on restart |
| **Discord Bot** | discord.js (WebSocket + REST) | `DISCORD_TOKEN` | N/A |

---

## 13. Complete System Diagram

```mermaid
graph TB
    subgraph External
        OA[The Odds API]
        PS[PandaScore]
        OP[OddsPapi]
        DC[Discord API]
    end

    subgraph BullMQ["BullMQ Queues (Redis)"]
        Q_MF["match-fetch queue"]
        Q_OF["odds-fetch queue"]
        Q_AA["ai-analysis<br/>unused"]
    end

    subgraph Workers
        W_REF[ReferenceDataWorker]
        W_MI[MatchIngestionWorker]
        W_OS[OddsSnapshotWorker]
        W_EO[EsportsOddsSnapshotWorker]
        W_SETTLE[SettlementWorker]
        W_DS[DailySummaryWorker]
    end

    subgraph Services
        S_ODDS[OddsSnapshotIngestionService]
        S_ESP[EsportsOddsSnapshotIngestionService]
        S_VAL[ValueDetectionService]
        S_SETTLE[SettlementService]
        S_NOTIFY[DiscordNotificationService]
    end

    subgraph DB[("PostgreSQL (Neon)")]
        SP[Sport]
        LG[League]
        TM[Team]
        TL[TeamLeague]
        MC[Match]
        OS[OddsSnapshot]
        VO[ValueOpportunity]
    end

    subgraph Discord
        BOT[DiscordBotService<br/>slash commands]
        ALERTS[Alert Channel]
        OUTCOMES[Outcomes Channel]
    end

    subgraph Redis
        RQ[BullMQ state]
        CD[Cooldown keys<br/>4h per esport]
        QT[Quota counter<br/>OddsPapi monthly]
    end

    %% Scheduler → Queues
    SCHED --> Q_MF
    SCHED --> Q_AA

    %% Queue → Workers
    Q_MF --> W_REF
    Q_MF --> W_MI
    Q_MF --> W_SETTLE
    Q_MF --> W_DS
    Q_OF --> W_OS
    Q_OF --> W_EO

    %% Workers → APIs
    W_REF --> OA
    W_MI --> OA
    W_MI --> PS
    W_EO --> OP

    %% Workers → Services
    W_OS --> S_ODDS
    W_EO --> S_ESP
    W_OS --> S_VAL
    W_EO --> S_VAL
    W_OS --> S_NOTIFY
    W_EO --> S_NOTIFY
    W_SETTLE --> S_SETTLE
    W_SETTLE --> S_NOTIFY
    W_DS --> S_NOTIFY

    %% Services → DB
    S_ODDS --> OS
    S_ESP --> OS
    S_VAL --> VO
    S_SETTLE --> VO
    S_NOTIFY --> VO
    W_MI --> SP
    W_MI --> LG
    W_MI --> TM
    W_MI --> TL
    W_MI --> MC
    W_REF --> SP
    W_REF --> LG

    %% Redis for workers
    W_MI --> CD
    W_EO --> QT
    W_MI -.-> RQ
    W_OS -.-> RQ
    W_EO -.-> RQ
    W_SETTLE -.-> RQ

    %% Discord
    S_NOTIFY -->|POST 🎯| ALERTS
    S_NOTIFY -->|POST ✅/❌| OUTCOMES
    S_NOTIFY -->|POST 📊| OUTCOMES
    BOT -->|read| DB
    BOT -->|read| Redis

    subgraph Scheduler["Scheduler (app.ts start)"]
        SCHED[scheduleIngestionJobs]
    end
```

---

## 14. Scheduled Jobs Reference

| Job | Queue | Schedule | Worker |
|---|---|---|---|
| `sync-reference-data` | match-fetch | Every 24h | ReferenceDataWorker |
| `sync-traditional-sport` | match-fetch | Per-key (60 min / 3h / 4h) | MatchIngestionWorker |
| `sync-esports-game` | match-fetch | 12:00, 17:00 Budapest | MatchIngestionWorker |
| `sync-odds-for-sport` | odds-fetch | Triggered (5s delay) | OddsSnapshotWorker |
| `sync-esports-odds` | odds-fetch | Triggered (4h cooldown) | EsportsOddsSnapshotWorker |
| `settle-matches` | match-fetch | Every 4h | SettlementWorker |
| `daily-summary` | match-fetch | 23:00 Budapest | DailySummaryWorker |

### Traditional Sports (50 total)

| Tier | Interval | Count | Example Keys |
|---|---|---|---|
| Tier 1 (60 min) | 60 min | 12 | NHL, MLB, WNBA, MLS + 8 tennis tournaments |
| Tier 2 (4h) | 4h | 4 | NBA, EPL, UCL, NCAAF |
| Tier 3 (3h) | 3h | 34 | 34 soccer leagues (Brazil, Germany, Italy, Spain, etc.) |

### Esports (4)

| Game | Schedule | PandaScore Slug | OddsPapi Key |
|---|---|---|---|
| CS2 | 12:00 + 17:00 | csgo | cs2 |
| Dota 2 | 12:00 + 17:00 | dota2 | dota2 |
| League of Legends | 12:00 + 17:00 | lol | lol |
| Valorant | 12:00 + 17:00 | valorant | valorant |

---

## 15. External Configuration Reference

### Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | Yes | `development` or `production` |
| `LOG_LEVEL` | No | Default: `info` |
| `PORT` | No | Health server port (default 3000) |
| `DATABASE_URL` | Yes | Neon PostgreSQL pooled connection |
| `DIRECT_DATABASE_URL` | Yes | Direct connection for migrations |
| `REDIS_URL` | Yes | Local Docker Redis |
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DISCORD_CLIENT_ID` | Yes | Discord app ID |
| `DISCORD_GUILD_ID` | Yes | Discord guild ID |
| `DISCORD_ALERT_CHANNEL_ID` | Yes | Alert channel ID |
| `DISCORD_OUTCOMES_CHANNEL_ID` | No | Outcomes channel ID |
| `THE_ODDS_API_KEY` | Yes | The Odds API key |
| `PANDASCORE_API_KEY` | Yes | PandaScore API key |
| `DEEPSEEK_API_KEY` | Yes | Future use |
| `ODDSPAPI_API_KEY` | Yes | OddsPapi API key |
| `BETTING_DEFAULT_BANKROLL` | No | Default 10000 |
| `BETTING_MAX_CONCURRENT_BETS` | No | Default 10 |
| `BETTING_ANALYSIS_BUDGET_DAILY` | No | Default 50 |
| `MAX_ALERT_ODDS` | No | Default 3.0 |