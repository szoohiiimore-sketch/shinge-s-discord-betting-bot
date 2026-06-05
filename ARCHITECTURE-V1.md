# Betting Intelligence Discord Platform — V1 Architecture Specification

> **Status:** Architecture Document — Source of Truth  
> **Version:** 2.0  
> **Last Updated:** 2026-06-05  
> **Scope:** V1 — Recommendation-only, virtual bankroll, single Discord server, friends only (max 5 users)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Major Modules](#2-major-modules)
3. [Module Responsibilities](#3-module-responsibilities)
4. [Data Flow Between Modules](#4-data-flow-between-modules)
5. [External Integrations](#5-external-integrations)
6. [Scheduled Jobs & Background Processing Strategy](#6-scheduled-jobs--background-processing-strategy)
7. [AI Analysis Lifecycle](#7-ai-analysis-lifecycle)
8. [Prediction Lifecycle](#8-prediction-lifecycle)
9. [Bankroll Management Strategy](#9-bankroll-management-strategy)
10. [Alerting Strategy](#10-alerting-strategy)
11. [Error Handling Strategy](#11-error-handling-strategy)
12. [Scalability Considerations for V2](#12-scalability-considerations-for-v2)
13. [Technical Risks & Mitigations](#13-technical-risks--mitigations)

---

## 1. System Overview

### 1.1 What It Is

The Betting Intelligence Discord Platform is a modular monolith that collects sports and esports matches and bookmaker odds, analyzes them using the DeepSeek V4 Flash API, generates betting recommendations, tracks virtual bankroll performance per user, and delivers results through Discord slash commands and channel alerts.

**Scope constraints:**
- Single Discord server
- Friends only — maximum 5 users
- Recommendation generation only — no real betting
- Virtual bankroll tracking only — no real money
- No bookmaker integrations beyond odds retrieval
- No analytics subsystem
- No learning subsystem
- No DM notifications
- No multi-server support

### 1.2 High-Level Architecture Diagram (Text)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DISCORD GATEWAY                              │
│  (Slash Commands / Channel Alerts / User Interaction)               │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                     DISCORD BOT LAYER                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Command      │  │ Alert        │  │ Interaction Handler      │  │
│  │ Handlers     │  │ Dispatcher   │  │ (modals, buttons, etc.)  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────────┘  │
└─────────┼──────────────────┼────────────────────────────────────────┘
          │                  │
┌─────────▼──────────────────▼────────────────────────────────────────┐
│                     APPLICATION CORE                                │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Match        │  │ Odds         │  │ Prediction Engine        │  │
│  │ Service      │  │ Service      │  │                          │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────┘  │
│         │                 │                      │                  │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────────▼───────────────┐  │
│  │ AI Analysis  │  │ Bankroll     │  │ User Service             │  │
│  │ Service      │  │ Manager      │  │                          │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────────┘  │
│         │                 │                                         │
└─────────────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                     DATA ACCESS LAYER                               │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Prisma ORM                                │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│  ┌──────────────────────────▼───────────────────────────────────┐   │
│  │                    PostgreSQL                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                     BACKGROUND PROCESSING                           │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Redis + BullMQ                            │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────────────────┐   │   │
│  │  │ Match      │ │ Odds       │ │ AI Analysis            │   │   │
│  │  │ Fetch Queue│ │ Fetch Queue│ │ Queue                  │   │   │
│  │  └────────────┘ └────────────┘ └────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                     EXTERNAL APIs                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ The Odds API │  │ PandaScore   │  │ DeepSeek V4 Flash API   │  │
│  │ (Bookmaker   │  │ API          │  │ (AI Analysis)           │  │
│  │  Odds)       │  │ (Esports)    │  │                         │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.3 Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Modular Monolith | Single developer; simpler deployment; no network overhead; easier debugging |
| Database | PostgreSQL (single instance) | Reliable; JSONB for flexible odds data; strong consistency |
| ORM | Prisma | Type-safe; auto-generated types; excellent migration tooling |
| Queue | BullMQ + Redis | Reliable job processing; retries; delayed jobs; scheduling |
| AI Provider | DeepSeek V4 Flash | Cost-effective; fast inference; good for structured analysis |
| Package Manager | pnpm | Fast; disk-efficient; strict dependency resolution |
| Language | TypeScript | Type safety; excellent Discord.js/Node.js ecosystem |

---

## 2. Major Modules

The system is organized into the following modules within a single Node.js application:

| # | Module | Purpose |
|---|---|---|
| 1 | **Discord Bot** | Slash commands, channel alert delivery, user interaction |
| 2 | **Match Service** | Fetch, normalize, store sports/esports matches |
| 3 | **Odds Service** | Fetch, normalize, store bookmaker odds |
| 4 | **AI Analysis Service** | Analyze matches via DeepSeek, produce structured analysis |
| 5 | **Prediction Engine** | Generate betting recommendations from analysis + odds |
| 6 | **Bankroll Manager** | Per-user virtual bankroll tracking, P&L |
| 7 | **User Service** | Discord user linking, preferences, settings |
| 8 | **Scheduler** | Cron-like job orchestration via BullMQ |

---

## 3. Module Responsibilities

### 3.1 Discord Bot Module

**Files:** `src/bot/`  
**Dependencies:** discord.js, Application Core modules

**Responsibilities:**
- Register and handle slash commands (recommendations, bankroll status, prediction history, sport settings)
- Handle Discord interactions (modals, buttons, autocomplete)
- Format and send rich embed messages for channel alerts and command responses
- Manage Discord client lifecycle (login, reconnection)
- Rate-limit command usage per user/channel
- Map Discord user IDs to internal user records

**Commands (V1):**
- `/recommendations` — List active betting recommendations
- `/bankroll` — View bankroll status and history
- `/predictions` — View prediction history
- `/settings` — Configure notification preferences per sport
- `/analyze <match-id>` — Trigger on-demand AI analysis

### 3.2 Match Service Module

**Files:** `src/matches/`  
**Dependencies:** Prisma, External API clients

**Responsibilities:**
- Fetch upcoming and live matches from The Odds API (traditional sports) and PandaScore API (esports)
- Normalize match data into a unified internal schema
- Deduplicate matches across API sources
- Store match metadata (teams, start time, sport, league, status)
- Track match lifecycle: `SCHEDULED → LIVE → FINISHED → CANCELLED`
- Expose match lookup methods for other modules
- Handle API pagination and rate limits

**Match Statuses:**
```
SCHEDULED → LIVE → FINISHED
                ↘ CANCELLED
                ↘ POSTPONED
```

### 3.3 Odds Service Module

**Files:** `src/odds/`  
**Dependencies:** Prisma, External API clients

**Responsibilities:**
- Fetch bookmaker odds for active matches from The Odds API
- Store odds snapshots with timestamps (historical odds tracking)
- Normalize odds formats (decimal)
- Track odds movements over time (opening → current → closing)
- Identify best available odds across bookmakers
- Expose current and historical odds for analysis
- Handle bookmaker name normalization

**Odds Data Model (Conceptual):**
- Each odds record: `{ matchId, bookmaker, market, outcome, price, timestamp, isMain }`
- Markets: `h2h` (head-to-head), `spreads`, `totals` (over/under)
- Esports-specific markets handled via PandaScore

### 3.4 AI Analysis Service Module

**Files:** `src/analysis/`  
**Dependencies:** DeepSeek API client, Match Service, Odds Service

**Responsibilities:**
- Build structured prompts for DeepSeek V4 Flash using match + odds data
- Call DeepSeek API with retry logic and rate limiting
- Parse and validate AI responses into structured analysis objects
- Extract: predicted winner, confidence score, key factors, value assessment
- Store analysis results linked to matches
- Handle AI response failures gracefully (fallback to odds-only analysis)
- Track token usage and API costs per analysis

**Prompt Engineering Strategy:**
- System prompt defines the AI's role as a sports betting analyst
- Context includes: teams, recent form, head-to-head, odds, market movements
- Output format enforced via JSON schema in the prompt
- Temperature set low (0.2–0.4) for consistency
- Max tokens per analysis: ~500

### 3.5 Prediction Engine Module

**Files:** `src/predictions/`  
**Dependencies:** AI Analysis Service, Odds Service, Bankroll Manager

**Responsibilities:**
- Combine AI analysis with current odds to generate betting recommendations
- Apply confidence thresholds (minimum confidence score to recommend)
- Calculate fixed-fraction stake sizes based on user's bankroll
- Filter out low-value bets (negative expected value)
- Generate prediction records with: match, market, outcome, stake, odds, confidence, expected value
- Create one Prediction record per user (up to 5) when a recommendation is generated
- Expose predictions for queries and channel alerts
- Track prediction status: `PENDING → PLACED → SETTLED → VOIDED`

**Prediction Statuses:**
```
PENDING → PLACED → SETTLED (WON / LOST / PUSH)
                ↘ VOIDED (match cancelled)
```

**Staking Strategy (V1):**
- Fixed fractional only (e.g., 1% of bankroll per bet)
- Maximum single-bet exposure: 5% of bankroll
- Minimum confidence threshold: 60%
- Minimum odds threshold: 1.50
- Maximum concurrent PLACED predictions per user: 10

### 3.6 Bankroll Manager Module

**Files:** `src/bankroll/`  
**Dependencies:** Prisma, Prediction Engine

**Responsibilities:**
- Maintain per-user virtual bankroll records (starting balance, current balance)
- Track P&L from settled predictions
- Calculate and enforce staking limits per user
- Provide bankroll snapshots and history
- Calculate ROI and win rate per user
- Prevent over-betting (insufficient funds check)

**Bankroll Operations:**
- `initialize(userId, startingBalance)` — Create bankroll
- `placeBet(userId, predictionId, stake)` — Deduct stake, record pending bet
- `settleBet(predictionId, outcome)` — Update balance with P&L
- `getStatus(userId)` — Current balance, exposure, history
- `reset(userId)` — Reset to starting balance (user-initiated)

### 3.7 User Service Module

**Files:** `src/users/`  
**Dependencies:** Prisma

**Responsibilities:**
- Link Discord user IDs to internal user records
- Manage user notification preferences (which sports, minimum confidence)
- Store user settings (default stake size, risk tolerance)
- Handle user opt-in/opt-out for different alert types
- Provide user lookup for all other modules

### 3.8 Scheduler Module

**Files:** `src/scheduler/`  
**Dependencies:** BullMQ, all service modules

**Responsibilities:**
- Define and register recurring jobs using BullMQ repeatable jobs
- Manage job lifecycle (schedule, execute, retry, complete)
- Provide centralized job configuration
- Handle job overlap prevention (skip if previous instance still running)
- Log job execution results and errors

---

## 4. Data Flow Between Modules

### 4.1 Primary Data Flow: Match → Odds → Analysis → Prediction

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Match   │───▶│  Odds    │───▶│    AI    │───▶│Predict. │
│ Service  │    │ Service  │    │ Analysis │    │ Engine   │
│          │    │          │    │ Service  │    │          │
│ Fetch    │    │ Fetch    │    │ Analyze  │    │ Generate │
│ matches  │    │ odds for │    │ match +  │    │ rec from │
│ from API │    │ each     │    │ odds     │    │ analysis │
│          │    │ match    │    │          │    │ + stake  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │               │               │               │
     ▼               ▼               ▼               ▼
  ┌──────────────────────────────────────────────────────────┐
  │                        PostgreSQL                         │
  │  matches | odds_snapshots | analyses | predictions        │
  └──────────────────────────────────────────────────────────┘
```

### 4.2 Detailed Data Flows

#### Flow 1: Match Ingestion
```
Scheduler (every 30 min)
  → BullMQ: match-fetch queue
  → Match Service
    → The Odds API (traditional sports)
    → PandaScore API (esports)
    → Normalize & deduplicate
    → Prisma: upsert matches
  → On completion: enqueue odds-fetch jobs for new/updated matches
```

#### Flow 2: Odds Ingestion
```
Scheduler (every 15 min for active matches)
  → BullMQ: odds-fetch queue
  → Odds Service
    → The Odds API (odds for active matches)
    → Normalize & store snapshot
    → Prisma: upsert odds_snapshots
```

#### Flow 3: AI Analysis
```
Scheduler (every 60 min for upcoming matches within 48h)
  → BullMQ: ai-analysis queue
  → AI Analysis Service
    → Load match + latest odds from DB
    → Build structured prompt
    → DeepSeek V4 Flash API
    → Parse response
    → Prisma: store analysis
  → On completion: trigger prediction generation inline
```

#### Flow 4: Prediction Generation
```
Triggered by: new AI analysis completion
  → Prediction Engine
    → Load analysis + current odds
    → Calculate confidence, expected value
    → Apply staking rules per user
    → If passes thresholds → create Prediction record per user
    → Prisma: store predictions
  → On completion: send channel alert via Discord Bot
```

#### Flow 5: Prediction Settlement
```
Triggered by: match status change to FINISHED
  → Prediction Engine
    → Check match result from API
    → Determine prediction outcome (WON/LOST/PUSH/VOID)
    → Update prediction status
    → Bankroll Manager: settle bet
  → On completion: send settlement alert to Discord channel
```

### 4.3 Inter-Module Communication Rules

- **Synchronous calls** allowed only within the same process (direct function calls)
- **Asynchronous processing** via BullMQ queues for:
  - External API calls (network I/O)
  - Long-running computations
  - Operations that can be deferred
  - Operations that need retry logic
- **No direct HTTP calls** between modules (monolith — all in-process)
- **Database is the source of truth** for all shared state
- **Redis is used only for** BullMQ job state

---

## 5. External Integrations

### 5.1 The Odds API

| Property | Detail |
|---|---|
| **Purpose** | Fetch traditional sports matches and bookmaker odds |
| **Base URL** | `https://api.the-odds-api.com/v4/` |
| **Auth** | API key (query parameter) |
| **Rate Limit** | 500 requests/month (free tier); 10,000+ (paid) |
| **Sports Covered** | Soccer, NBA, NHL, NFL, Tennis, MMA |
| **Endpoints Used** | `/sports`, `/sports/{sport}/odds`, `/sports/{sport}/scores` |
| **Polling Frequency** | Matches: every 30 min; Odds: every 15 min for active matches |
| **Data Stored** | Match metadata, bookmaker odds snapshots, scores/results |

**Integration Strategy:**
- Wrap in a dedicated API client class with rate limiting
- Cache sport/league mappings (rarely change)
- Use region parameter to get relevant bookmakers
- Store raw API response alongside normalized data for debugging

### 5.2 PandaScore API

| Property | Detail |
|---|---|
| **Purpose** | Fetch esports matches, results, and odds |
| **Base URL** | `https://api.pandascore.co/` |
| **Auth** | API token (header) |
| **Rate Limit** | Varies by plan; typically 10–30 req/min |
| **Games Covered** | CS2, Valorant, League of Legends, Dota 2 |
| **Endpoints Used** | `/matches`, `/matches/{id}`, `/tournaments`, `/leagues`, `/teams` |
| **Polling Frequency** | Matches: every 30 min; Results: every 15 min for live/recent |
| **Data Stored** | Match metadata, team rosters, tournament info, results |

**Integration Strategy:**
- Dedicated API client with rate limiting and pagination
- PandaScore uses a different data model than The Odds API — normalize to internal schema
- Esports odds may come from PandaScore or The Odds API depending on coverage
- Handle timezone differences (PandaScore uses UTC)

### 5.3 DeepSeek V4 Flash API

| Property | Detail |
|---|---|
| **Purpose** | AI-powered match analysis and prediction |
| **Base URL** | `https://api.deepseek.com/v1/` |
| **Auth** | API key (bearer token) |
| **Model** | `deepseek-chat` (V4 Flash) |
| **Rate Limit** | Check provider limits; implement client-side throttling |
| **Max Tokens** | ~500 per analysis response |
| **Temperature** | 0.2–0.4 (low for consistency) |

**Integration Strategy:**
- Structured prompts with JSON output schema enforced
- Retry with exponential backoff (max 3 retries)
- Track token usage per analysis for cost monitoring
- Fallback: if AI analysis fails, use odds-only analysis (no AI recommendation)
- Batch analyses where possible to reduce API calls
- Estimated cost: ~$0.01–0.05 per analysis (V4 Flash is cost-efficient)

**Prompt Structure:**
```
System: You are a sports betting analyst. Analyze the following match data
and provide a structured prediction. Respond ONLY with valid JSON.

User:
Match: {teamA} vs {teamB}
Sport: {sport}
League: {league}
Date: {datetime}
Current Odds: {odds data}
Recent Form: {form data}
Head-to-Head: {h2h data}

Output JSON:
{
  "predictedWinner": "teamA" | "teamB",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "keyFactors": ["factor1", "factor2"],
  "recommendedMarket": "h2h" | "spread" | "total",
  "valueAssessment": "high" | "medium" | "low" | "none"
}
```

---

## 6. Scheduled Jobs & Background Processing Strategy

### 6.1 BullMQ Queue Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Redis Instance                             │
│                                                                     │
│  Queues:                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ match-fetch   │  │ odds-fetch   │  │ ai-analysis              │  │
│  │ (1 worker)    │  │ (2 workers)  │  │ (2 workers)              │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**V1 uses exactly 3 queues.** Prediction generation, settlement, and alert dispatch happen inline (synchronously) after their triggering events. This eliminates queue complexity for a system with max 5 users and ~10 predictions/day.

### 6.2 Queue Definitions

#### Queue: `match-fetch`

| Property | Value |
|---|---|
| **Purpose** | Fetch matches from external APIs |
| **Concurrency** | 1 |
| **Job types** | `fetch-traditional`, `fetch-esports` |
| **Schedule** | Repeatable, every 30 minutes |
| **Max attempts** | 3 |
| **Backoff** | Exponential, 30s initial |
| **Timeout** | 120 seconds |
| **Owned by** | Match Service |

#### Queue: `odds-fetch`

| Property | Value |
|---|---|
| **Purpose** | Fetch odds for active matches |
| **Concurrency** | 2 |
| **Job types** | `fetch-odds-for-match` |
| **Schedule** | Repeatable, every 15 minutes |
| **Max attempts** | 3 |
| **Backoff** | Exponential, 30s initial |
| **Timeout** | 60 seconds |
| **Owned by** | Odds Service |

#### Queue: `ai-analysis`

| Property | Value |
|---|---|
| **Purpose** | Analyze matches using DeepSeek |
| **Concurrency** | 2 |
| **Job types** | `analyze-match` |
| **Schedule** | Repeatable, every 60 minutes |
| **Max attempts** | 3 |
| **Backoff** | Exponential, 60s initial |
| **Timeout** | 120 seconds |
| **Owned by** | AI Analysis Service |

### 6.3 Job Configuration Strategy

**Concurrency:**
- I/O-bound jobs (API fetches): 2 workers per queue
- CPU-bound jobs (analysis parsing): 2 workers

**Retry Policy:**
- API fetch jobs: 3 retries with exponential backoff (30s, 2min, 5min)
- AI analysis jobs: 3 retries with exponential backoff (1min, 5min, 15min)

**Job Overlap Prevention:**
- Use BullMQ's `removeOnComplete` and `removeOnFail` to keep queue lean
- Use job IDs for deduplication (e.g., `fetch-matches-{sport}`)
- Check if a job of the same type is already running before enqueuing

**Error Handling per Job:**
- Log all job failures with full context
- After max retries: move to failed queue, notify developer via Discord
- Non-critical job failures should not crash the application

### 6.4 Graceful Shutdown

- Listen for `SIGTERM`/`SIGINT`
- Close BullMQ workers gracefully (wait for current jobs to finish)
- Close Prisma connection
- Close Redis connection
- Disconnect Discord client
- Timeout: 30 seconds max

---

## 7. AI Analysis Lifecycle

### 7.1 Lifecycle Stages

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ QUEUED   │──▶│BUILDING  │──▶│IN_FLIGHT │──▶│COMPLETED │──▶│ UTILIZED │
│          │   │ PROMPT   │   │ (API)    │   │ (PARSED) │   │(Predict.)│
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
                                                   │
                                                   ▼
                                              ┌──────────┐
                                              │  FAILED  │
                                              │ (Retry)  │
                                              └──────────┘
```

### 7.2 Detailed Flow

1. **QUEUED** — Match is within analysis window (T-48h to T-1h) and no existing analysis
2. **BUILDING PROMPT** — Load match data, odds, form, H2H from DB; construct structured prompt
3. **IN_FLIGHT** — Send to DeepSeek API; track start time for latency monitoring
4. **COMPLETED** — Receive response; parse JSON; validate schema; store in DB
5. **FAILED** — API error, timeout, or invalid response → retry or fallback
6. **UTILIZED** — Prediction Engine reads analysis to generate recommendations

### 7.3 Analysis Triggers

- **Scheduled:** Every 60 min, analyze upcoming matches within 48h window
- **On-demand:** User runs `/analyze <match-id>` command
- **Re-analysis:** Significant odds movement (>20% change) triggers re-analysis

### 7.4 Analysis Caching

- Each match is analyzed at most once per 6 hours (unless odds change significantly)
- Analysis results are stored in PostgreSQL
- Cache key: `analysis:{matchId}:{oddsSnapshotId}`

### 7.5 Cost Optimization

- Skip analysis for matches with very low odds (e.g., <1.10) — no value
- Skip analysis for matches starting in <1 hour (too late for betting)
- Batch multiple analyses into a single API call where possible
- Track cost per analysis and per sport; alert if monthly budget exceeded

---

## 8. Prediction Lifecycle

### 8.1 Lifecycle Stages

```
┌──────────┐   ┌──────────┐   ┌──────────┐
│ PENDING  │──▶│ PLACED   │──▶│ SETTLED  │
│ (Draft)  │   │ (Active) │   │(W/L/P/V) │
└──────────┘   └──────────┘   └──────────┘
     │               │
     ▼               ▼
┌──────────┐   ┌──────────┐
│ VOIDED   │   │ EXPIRED  │
│ (Invalid)│   │(No match)│
└──────────┘   └──────────┘
```

### 8.2 Detailed Flow

1. **PENDING** — Prediction Engine creates a draft recommendation
   - Requires: match exists, odds available, AI analysis complete
   - Must pass confidence threshold (≥60%) and value assessment (≥medium)
   - Stake calculated based on user's bankroll (fixed fractional)
   - One Prediction record created per user (up to 5)

2. **PLACED** — Recommendation is active
   - Stake is deducted from virtual bankroll
   - Channel alert sent to Discord

3. **SETTLED** — Match finishes; outcome determined
   - **WON:** Bankroll increased by stake × (odds - 1)
   - **LOST:** Stake lost
   - **PUSH:** Stake returned
   - **VOID:** Match cancelled/postponed; stake returned

4. **VOIDED** — Prediction invalidated before match (e.g., line change)
   - No stake impact
   - Reason recorded

5. **EXPIRED** — Match started but prediction was never settled (edge case)
   - Auto-voided after match start time + 3 hours

### 8.3 Prediction Generation Rules

| Rule | Value | Rationale |
|---|---|---|
| Min confidence | 60% | Below this, predictions are noise |
| Min odds | 1.50 | Below this, risk/reward is poor |
| Max stake | 5% of bankroll | Risk management |
| Default stake | 1% of bankroll | Conservative starting point |
| Min value assessment | Medium | Ensures edge over market |
| Max concurrent PLACED predictions | 10 per user | Prevents over-exposure |

### 8.4 Settlement Logic

```
For each PLACED prediction where match.status == 'FINISHED':
  1. Fetch match result from API
  2. Compare predicted outcome to actual result
  3. Determine: WON / LOST / PUSH / VOID
  4. Update prediction status
  5. Call BankrollManager.settleBet(predictionId, outcome)
  6. Send settlement alert to Discord channel
```

---

## 9. Bankroll Management Strategy

### 9.1 Core Principles

| Principle | Implementation |
|---|---|
| **Virtual bankroll** | Each user gets a virtual bankroll (default: 10,000 units) |
| **Conservative staking** | Default 1% per bet; max 5% |
| **No real money** | V1 is purely analytical/virtual — no real betting integration |
| **Transparent tracking** | Every P&L logged on the Prediction record |
| **User control** | Users can reset bankroll, adjust stake size, set limits |

### 9.2 Staking Method

**Fixed Fractional (only method in V1):**
```
stake = bankroll * fraction
Example: 10,000 * 0.01 = 100 units per bet
```

No Kelly Criterion in V1. Fixed fractional is simpler and more conservative.

### 9.3 Bankroll States

```
┌──────────────┐
│   ACTIVE     │── Normal operation
└──────────────┘
```

V1 has a single bankroll state. No drawdown warnings, no stop-loss, no frozen states. Users can manually reset their bankroll at any time.

### 9.4 Per-User Configuration

| Setting | Default | Range |
|---|---|---|
| Starting balance | 10,000 | 1,000 – 1,000,000 |
| Stake fraction | 1% | 0.5% – 5% |
| Max concurrent PLACED predictions | 10 | 1 – 50 |

---

## 10. Alerting Strategy

### 10.1 Alert Architecture

Alerts are sent directly to Discord channels. No alert queue, no alert persistence, no DM notifications.

```
┌──────────────┐     ┌──────────────┐
│  Event       │────▶│  Discord     │
│  Source      │     │  Channel     │
│              │     │              │
│ Prediction   │     │ #predictions │
│ Engine       │     │ #settlements │
│ Settlement   │     │              │
└──────────────┘     └──────────────┘
```

### 10.2 Alert Channels

| Discord Channel | Purpose | Alert Types |
|---|---|---|
| `#predictions` | New betting recommendations | NEW_PREDICTION |
| `#settlements` | Bet outcome notifications | BET_SETTLED |

### 10.3 Alert Format (Discord Embed)

**New Prediction Alert:**
```
┌────────────────────────────────────────────┐
│ 🎯 NEW PREDICTION                          │
│                                            │
│ Manchester City vs Liverpool               │
│ Premier League · Tomorrow 20:00 UTC        │
│                                            │
│ Pick: Manchester City to Win               │
│ Odds: 2.10 (Bet365)                        │
│ Confidence: 78%                            │
│ Stake: 100 units (1% of bankroll)          │
│ Expected Value: +8.5%                      │
│                                            │
│ Key Factors:                               │
│ • City undefeated in last 10 home games    │
│ • Liverpool missing 2 key defenders        │
│ • City won last 3 H2H encounters           │
│                                            │
│ /recommendations for details               │
└────────────────────────────────────────────┘
```

**Settlement Alert:**
```
┌────────────────────────────────────────────┐
│ ✅ BET SETTLED · WON                       │
│                                            │
│ Manchester City 2-1 Liverpool              │
│                                            │
│ P&L: +110 units                            │
│ New Balance: 10,110 units                  │
└────────────────────────────────────────────┘
```

### 10.4 Rate Limiting

- Maximum 5 alerts per minute per Discord channel
- Maximum 1 alert per prediction (no duplicates)
- Error alerts: aggregated (max 1 per 5 minutes)

### 10.5 User Notification Preferences

Users configure via `/settings`:
- Which sports to receive alerts for
- Minimum confidence threshold for alerts (e.g., only ≥70%)
- Opt-out per alert type
- Opt-out entirely (query recommendations manually via commands)

---

## 11. Error Handling Strategy

### 11.1 Error Classification

| Category | Examples | Handling |
|---|---|---|
| **Configuration** | Missing env var, invalid value | Fail fast at startup. Clear error message. Exit with code 1. |
| **Database** | Connection failure, query timeout, constraint violation | Log error. Retry if transient. Fail health check if persistent. |
| **Redis** | Connection failure, command timeout | Log error. Workers stop. Fail health check. Container restart. |
| **External API** | HTTP error, rate limit, timeout, malformed response | Log error. Retry via BullMQ (3 attempts). Fallback if available. |
| **AI Analysis** | API error, invalid JSON response, empty response | Log error. Retry via BullMQ (3 attempts). Fallback to odds-only analysis. |
| **Discord** | Rate limit, invalid token, channel not found | Log error. Retry with backoff. Alert developer if persistent. |
| **Business Logic** | Invalid prediction, insufficient bankroll, duplicate prediction | Log warning. Return error to caller. Do not crash. |

### 11.2 Error Handling Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Layer 1: Process Boundary                       │
│  main.ts catches all unhandled rejections and uncaught exceptions   │
│  → Logs error with full context                                     │
│  → Attempts graceful shutdown                                       │
│  → Exits with code 1                                                │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                     Layer 2: Application Boundary                   │
│  Application class catches startup failures                        │
│  → Logs error                                                       │
│  → Cleans up initialized dependencies                               │
│  → Exits with code 1                                                │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                     Layer 3: Module Boundary                        │
│  Each service catches its own errors                                │
│  → Logs error with context                                          │
│  → Returns typed error result                                       │
│  → Does not crash the process                                       │
└─────────────────────────────────────────────────────────────────────┘
                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                     Layer 4: BullMQ Worker Boundary                 │
│  Each job handler catches errors                                    │
│  → Logs error with job context                                      │
│  → Throws to trigger BullMQ retry                                   │
│  → After max retries: job moves to failed queue                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 11.3 Error Response Format

All errors thrown by the application follow a consistent structure:

```typescript
class AppError extends Error {
  public readonly code: string;       // e.g., 'CONFIG_MISSING', 'DB_CONNECTION'
  public readonly statusCode: number; // HTTP-equivalent for logging
  public readonly context: Record<string, unknown>; // Debug info
  public readonly retryable: boolean; // Can this error be retried?
}
```

### 11.4 Unhandled Rejection / Uncaught Exception

```typescript
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection — shutting down');
  app.shutdown().finally(() => process.exit(1));
});

process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception — shutting down');
  app.shutdown().finally(() => process.exit(1));
});
```

### 11.5 BullMQ Error Events

BullMQ workers emit error events that must be handled:

```typescript
worker.on('failed', (job, err) => {
  logger.error({ jobId: job.id, err }, 'Job failed');
});

worker.on('error', (err) => {
  logger.error({ err }, 'Worker error — may indicate Redis issue');
});
```

### 11.6 Error Recovery Matrix

| Failure | Detection | Recovery | User Impact |
|---|---|---|---|
| Database down | Health check fails | Container restart | No predictions until restart |
| Redis down | Health check fails | Container restart | No odds/match updates until restart |
| The Odds API rate limited | HTTP 429 | Retry after backoff | Delayed odds updates |
| PandaScore API down | HTTP 5xx | Retry 3 times | Delayed esports data |
| DeepSeek API error | Invalid/missing response | Retry 3 times, then fallback | Odds-only analysis for affected match |
| Discord rate limited | HTTP 429 | Retry with backoff | Delayed alerts |
| Match settlement fails | Job failure | Retry 3 times | Manual settlement needed |

---

## 12. Scalability Considerations for V2

### 12.1 Current V1 Limits

| Dimension | V1 Limit | Rationale |
|---|---|---|
| Users | 5 | Friends-only Discord server |
| Predictions per day | ~50 | 5 users × ~10 predictions/day |
| Matches tracked | ~200 active | Limited by API coverage |
| Odds snapshots per day | ~5,000 | 15-min polling for active matches |
| AI analyses per day | ~100 | Budget-limited |
| Discord servers | 1 | Single guild |

### 12.2 What Scales Without Changes

- **PostgreSQL:** Handles millions of rows. No issue at V1 volumes.
- **BullMQ:** Handles thousands of jobs per second. No issue at V1 volumes.
- **Discord.js:** Handles thousands of commands per minute. No issue at V1 volumes.

### 12.3 What Would Need Changes for V2

| Component | V2 Change | Complexity |
|---|---|---|
| **Multi-server support** | Add guild ID to User model. Register commands globally. | Low |
| **More users** | No architectural change. Linear scaling. | None |
| **More sports** | Add rows to Sport table. Add API client config. | Low |
| **Real betting integration** | Add UserBet, BetTransaction, bookmaker account models. | Medium |
| **Analytics subsystem** | Add Analytics Service, aggregation jobs, reporting. | Medium |
| **Learning subsystem** | Add Historical Learning Service, LearningInsight model. | Medium |
| **Alert queue** | Add BullMQ alert queue for async delivery. | Low |
| **DM notifications** | Add DM channel support in Alert Dispatcher. | Low |
| **SaaS / subscriptions** | Add payment processing, subscription tiers, access control. | High |

### 12.4 V2 Architectural Principles (Not Implemented in V1)

- **No microservices.** The modular monolith pattern scales to hundreds of users without the operational complexity of microservices.
- **No Kubernetes.** A single Node.js process with PostgreSQL and Redis is sufficient for thousands of users.
- **No event sourcing.** Event sourcing adds complexity without benefit at this scale.
- **No CQRS.** Read/write separation is unnecessary for a recommendation-only system.

---

## 13. Technical Risks & Mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **The Odds API free tier rate limits (500 req/month) may prevent sufficient odds collection.** At ~16 fetches/day, odds snapshots may be sparse. | Medium | Accept for V1. If data is too sparse, upgrade to paid tier (~$100/month for 10,000 req/month). |
| 2 | **PandaScore API coverage for esports odds may be incomplete.** PandaScore provides match data but may not provide bookmaker odds for all esports markets. | Medium | If PandaScore odds are unavailable, fall back to The Odds API for esports where possible, or generate predictions based on AI analysis alone (no odds-based EV calculation). |
| 3 | **DeepSeek API costs may exceed expectations.** At ~$0.01–0.05 per analysis, analyzing 50 matches/day could cost $15–75/month. | Low | Implement a daily analysis budget. Skip low-value matches (very short odds, obscure leagues). Monitor costs via `analyses.cost_usd`. |
| 4 | **Per-user Prediction creation may cause write contention.** When a recommendation is generated, up to 5 Prediction records are created in sequence. | Low | 5 sequential inserts is negligible. No mitigation needed. |
| 5 | **Bankroll balance may drift due to missed settlements.** If a match result is not fetched (API failure), the prediction is never settled and bankroll is never updated. | Medium | Settlement runs every 15 minutes. If a match is FINISHED but settlement fails, it retries 3 times. After max retries, log the error and alert the developer. Manual settlement via admin command. |
| 6 | **No currency conversion between HUF and EUR.** If a user has a HUF bankroll but odds are in EUR-denominated markets, there is no conversion. | Low | V1 uses abstract "units" internally. Currency is a display label only. No conversion needed. |
| 7 | **Team identity across API providers is not unified.** The Odds API and PandaScore use different team IDs and names. A team appearing in both APIs would be stored as two separate Team records. | Low | Accept for V1. Team deduplication across providers is a V2 concern. Match data comes from a single provider per sport. |
| 8 | **Single developer bus factor.** If the developer is unavailable, no one can maintain the system. | High | Comprehensive documentation. Clear code structure. Automated tests. CI/CD pipeline. |
| 9 | **Discord API breaking changes.** Discord occasionally deprecates API versions or changes command registration. | Low | Pin discord.js version. Monitor Discord changelog. Test on Discord developer preview server. |
| 10 | **Prisma migration conflicts in shared database.** If multiple migration branches exist, they may conflict. | Low | Single developer. Linear migration history. No branching. |
