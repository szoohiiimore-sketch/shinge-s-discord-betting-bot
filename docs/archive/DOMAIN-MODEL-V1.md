# Betting Intelligence Discord Platform — V1 Domain Model Specification

> **Status:** Domain Model Document  
> **Version:** 1.0  
> **Last Updated:** 2026-06-05  
> **Source of Truth:** ARCHITECTURE-V1.md

---

## Table of Contents

1. [Domain Overview](#1-domain-overview)
2. [Entity Catalog](#2-entity-catalog)
   - 2.1 [User](#21-user)
   - 2.2 [UserPreferences](#22-userpreferences)
   - 2.3 [Bankroll](#23-bankroll)
   - 2.4 [BankrollTransaction](#24-bankrolltransaction)
   - 2.5 [Sport](#25-sport)
   - 2.6 [League](#26-league)
   - 2.7 [Team](#27-team)
   - 2.8 [Match](#28-match)
   - 2.9 [OddsSnapshot](#29-oddssnapshot)
   - 2.10 [Analysis](#210-analysis)
   - 2.11 [Prediction](#211-prediction)
   - 2.12 [PredictionOutcome](#212-predictionoutcome)
   - 2.13 [LearningInsight](#213-learninginsight)
   - 2.14 [Alert](#214-alert)
3. [Entity Relationship Diagram](#3-entity-relationship-diagram)
4. [Aggregate Boundaries](#4-aggregate-boundaries)
5. [Business Invariants](#5-business-invariants)
6. [Deletion Rules](#6-deletion-rules)
7. [Historical Data Retention](#7-historical-data-retention)

---

## 1. Domain Overview

The Betting Intelligence domain consists of 14 entities organized around a core workflow:

```
User → Bankroll → Prediction → PredictionOutcome
                                        ↑
Match → OddsSnapshot → Analysis ────────┘
  ↑         ↑
Team ─ League ─ Sport
```

**Core flow:** Matches are scheduled → odds are collected → AI analyzes them → predictions are generated → outcomes are tracked → bankrolls are updated → insights are learned.

**Supporting entities:** UserPreferences customize behavior, Alerts deliver notifications, LearningInsights feed back into analysis quality.

---

## 2. Entity Catalog

---

### 2.1 User

**Why it exists:** Represents a Discord user who interacts with the platform. Every user action — querying recommendations, managing bankroll, configuring settings — is scoped to a User. The User entity is the root identity for all personalization and tracking.

**Ownership:** Self-owned. Created when a Discord user first interacts with the platform (runs a slash command or receives an alert).

**Referenced by:**
- `UserPreferences` (1:1 — each user has exactly one preferences record)
- `Bankroll` (1:1 — each user has exactly one bankroll)
- `BankrollTransaction` (1:N — each user has many transactions)
- `Prediction` (1:N — each user has many predictions)
- `Alert` (1:N — each user receives many alerts)

**Lifecycle:**
```
CREATED → ACTIVE → INACTIVE → ARCHIVED
```

- **CREATED:** First interaction detected. Discord ID linked.
- **ACTIVE:** Normal operation. User can receive alerts, manage bankroll, query predictions.
- **INACTIVE:** User has not interacted for 90+ days. No alerts sent. Data preserved.
- **ARCHIVED:** User explicitly requests deletion or is inactive for 365+ days. Personal data anonymized.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `discordId` | String | Yes | Yes | Discord snowflake ID. Immutable after creation. |
| `discordUsername` | String | Yes | No | Current Discord username. May change. |
| `discordDiscriminator` | String | No | No | Discord discriminator or global name |
| `status` | Enum | Yes | No | CREATED, ACTIVE, INACTIVE, ARCHIVED |
| `firstSeenAt` | DateTime | Yes | No | Timestamp of first interaction |
| `lastActiveAt` | DateTime | Yes | No | Timestamp of most recent interaction |
| `archivedAt` | DateTime | No | No | Set when status becomes ARCHIVED |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `discordId` must be a valid Discord snowflake (19-digit integer).
- A User cannot be deleted while they have active (PENDING or PLACED) Predictions.
- `status` transitions are one-way: CREATED → ACTIVE → INACTIVE → ARCHIVED. No reverse transitions.
- `firstSeenAt` is immutable after creation.

**Deletion rule:** Soft-delete only. On ARCHIVED status, `discordUsername` is anonymized to `"deleted-user-{id}"`. Bankroll and prediction data are preserved for aggregate analytics but disassociated from the user identity.

---

### 2.2 UserPreferences

**Why it exists:** Encapsulates all user-configurable settings that control platform behavior. Separated from User to keep the User entity focused on identity and to allow preferences to evolve independently.

**Ownership:** Owned by User (1:1). Created automatically when User is created.

**References:** `userId` (foreign key to User).

**Lifecycle:**
```
CREATED → ACTIVE → ARCHIVED
```

- **CREATED:** Default preferences applied when User is created.
- **ACTIVE:** User has modified preferences at least once.
- **ARCHIVED:** Follows User status. Preferences are preserved but ignored.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `userId` | UUID | Yes | Yes | Foreign key to User. One-to-one. |
| `defaultStakePercent` | Decimal | Yes | No | Default: 1.0 (1%). Range: 0.5–5.0 |
| `stakingMethod` | Enum | Yes | No | FIXED_FRACTIONAL, KELLY |
| `kellyFraction` | Decimal | No | No | Only applicable when stakingMethod=KELLY. Default: 0.25 |
| `maxConcurrentBets` | Integer | Yes | No | Default: 10. Range: 1–50 |
| `minConfidenceThreshold` | Decimal | Yes | No | Default: 0.60. Range: 0.0–1.0 |
| `minOddsThreshold` | Decimal | Yes | No | Default: 1.50 |
| `alertOnNewPrediction` | Boolean | Yes | No | Default: true |
| `alertOnSettlement` | Boolean | Yes | No | Default: true |
| `alertOnBankrollAlert` | Boolean | Yes | No | Default: true |
| `alertOnDailySummary` | Boolean | Yes | No | Default: true |
| `alertMinConfidence` | Decimal | No | No | Only alert if confidence ≥ this value. Null = no filter. |
| `subscribedSports` | String[] | No | No | Array of sport slugs. Empty = all sports. |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `defaultStakePercent` must be between 0.5 and 5.0.
- `kellyFraction` must be between 0.1 and 0.5, and must be null if `stakingMethod` is not KELLY.
- `maxConcurrentBets` must be ≥ 1.
- `minConfidenceThreshold` must be between 0.0 and 1.0.
- `subscribedSports` entries must reference valid Sport slugs.

**Deletion rule:** Cascade-deleted when User is archived. Preferences are not meaningful without an active User.

---

### 2.3 Bankroll

**Why it exists:** Tracks a user's virtual betting capital. Every prediction affects the bankroll. The bankroll is the central financial entity — all staking decisions, risk management, and performance tracking revolve around it.

**Ownership:** Owned by User (1:1). Created automatically when User is created.

**References:** `userId` (foreign key to User).

**Lifecycle:**
```
ACTIVE → DRAWDOWN → FROZEN → RESET
```

- **ACTIVE:** Normal operation. Bets can be placed.
- **DRAWDOWN:** Balance dropped >20% from peak. Max stake reduced to 2%.
- **FROZEN:** Balance dropped >50% from starting balance. No new predictions allowed.
- **RESET:** User manually resets to starting balance. A new Bankroll record is created (old one is preserved for history).

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `userId` | UUID | Yes | Yes | Foreign key to User. One-to-one. |
| `startingBalance` | Decimal | Yes | No | Initial balance. Default: 10,000. Immutable after creation. |
| `currentBalance` | Decimal | Yes | No | Current balance. Updated by transactions. |
| `peakBalance` | Decimal | Yes | No | Highest balance ever achieved. Updated on each positive settlement. |
| `status` | Enum | Yes | No | ACTIVE, DRAWDOWN, FROZEN |
| `totalStaked` | Decimal | Yes | No | Sum of all stakes placed. Cumulative. |
| `totalPnl` | Decimal | Yes | No | Sum of all P&L. Cumulative. |
| `totalWins` | Integer | Yes | No | Count of winning predictions |
| `totalLosses` | Integer | Yes | No | Count of losing predictions |
| `totalPushes` | Integer | Yes | No | Count of pushed predictions |
| `drawdownNotifiedAt` | DateTime | No | No | Last time user was notified of drawdown state |
| `frozenNotifiedAt` | DateTime | No | No | Last time user was notified of frozen state |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `currentBalance` must never be negative.
- `currentBalance` must equal `startingBalance + totalPnl`.
- `totalPnl` must equal `totalWins - totalLosses` (pushes are neutral).
- `status` transitions: ACTIVE → DRAWDOWN → FROZEN. FROZEN can only transition to ACTIVE via RESET.
- A new Bankroll record is created on RESET. The old record is preserved with status=FROZEN.
- `startingBalance` is immutable after creation.

**Deletion rule:** Never deleted. Bankroll records are permanent financial history. When a User is archived, Bankroll is preserved for aggregate analytics.

---

### 2.4 BankrollTransaction

**Why it exists:** Provides a complete audit trail of every financial operation affecting a bankroll. Every unit of virtual currency movement is recorded. Enables reconciliation, dispute resolution, and detailed performance analysis.

**Ownership:** Owned by Bankroll (N:1). Created by every bankroll operation.

**References:**
- `bankrollId` (foreign key to Bankroll)
- `predictionId` (optional — foreign key to Prediction, set for bet-related transactions)

**Lifecycle:**
```
RECORDED (immutable — transactions are never modified)
```

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `bankrollId` | UUID | Yes | No | Foreign key to Bankroll |
| `type` | Enum | Yes | No | INITIALIZE, PLACE_BET, SETTLE_WIN, SETTLE_LOSS, SETTLE_PUSH, RESET |
| `amount` | Decimal | Yes | No | Positive for credits, negative for debits |
| `balanceBefore` | Decimal | Yes | No | Bankroll balance before this transaction |
| `balanceAfter` | Decimal | Yes | No | Bankroll balance after this transaction |
| `predictionId` | UUID | No | No | Set for PLACE_BET and SETTLE_* types |
| `description` | String | No | No | Human-readable reason (e.g., "Bet on Man City vs Liverpool") |
| `createdAt` | DateTime | Yes | No | Transaction timestamp. Immutable. |

**Business invariants:**
- `balanceAfter` must equal `balanceBefore + amount`.
- `amount` must be non-zero.
- For `PLACE_BET`: `amount` must be negative (stake deducted). `predictionId` is required.
- For `SETTLE_WIN`: `amount` must be positive (profit + stake returned). `predictionId` is required.
- For `SETTLE_LOSS`: `amount` must be negative (stake lost). `predictionId` is required.
- For `SETTLE_PUSH`: `amount` must be zero (stake returned, no profit). `predictionId` is required.
- For `INITIALIZE`: `amount` must equal `startingBalance`. `predictionId` must be null.
- For `RESET`: `amount` is the difference between current and starting balance. `predictionId` must be null.
- Transactions are immutable after creation. No updates, no deletes.

**Deletion rule:** Never deleted. Transactions are immutable financial records. They may be archived (moved to cold storage) after 365 days, but never deleted.

---

### 2.5 Sport

**Why it exists:** Categorizes matches into sport types. Sports define the top-level grouping for all match data, odds, analysis, and predictions. Users subscribe to sports, analytics are grouped by sport, and AI prompts are customized per sport.

**Ownership:** System-owned. Seeded at deployment and updated manually when new sports are added.

**Referenced by:**
- `League` (1:N — each sport has many leagues)
- `Match` (1:N — each sport has many matches)
- `UserPreferences.subscribedSports` (implicit reference via slug)

**Lifecycle:**
```
ACTIVE → DEPRECATED
```

- **ACTIVE:** Sport is actively tracked. Matches and odds are fetched.
- **DEPRECATED:** Sport is no longer tracked. Existing data is preserved but no new data is collected.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `slug` | String | Yes | Yes | URL-safe identifier. E.g., "soccer", "nba", "cs2" |
| `name` | String | Yes | No | Display name. E.g., "Soccer", "NBA", "CS2" |
| `category` | Enum | Yes | No | TRADITIONAL, ESPORTS |
| `status` | Enum | Yes | No | ACTIVE, DEPRECATED |
| `externalApiSource` | Enum | Yes | No | THE_ODDS_API, PANDASCORE |
| `externalSportKey` | String | Yes | No | The API's identifier for this sport |
| `iconUrl` | String | No | No | URL to sport icon for Discord embeds |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `slug` must be unique and immutable after creation.
- `externalApiSource` determines which API client fetches data for this sport.
- A Sport cannot be deleted if it has active Leagues or Matches.
- `category` determines analysis prompt template selection.

**Deletion rule:** Soft-delete via DEPRECATED status. Never hard-deleted. Historical data depends on Sport references.

---

### 2.6 League

**Why it exists:** Groups teams and matches within a sport into competitive divisions. Leagues provide context for analysis (e.g., Premier League vs Championship have different competitive levels). Odds and analysis quality may vary by league.

**Ownership:** Owned by Sport (N:1).

**References:**
- `sportId` (foreign key to Sport)
- Referenced by: `Team` (1:N), `Match` (1:N)

**Lifecycle:**
```
ACTIVE → INACTIVE → DEPRECATED
```

- **ACTIVE:** League is actively tracked.
- **INACTIVE:** Off-season or between tournaments. Data preserved but no active fetching.
- **DEPRECATED:** League no longer exists or is no longer tracked.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `sportId` | UUID | Yes | No | Foreign key to Sport |
| `externalId` | String | Yes | No | API provider's identifier for this league |
| `name` | String | Yes | No | Display name. E.g., "Premier League", "LCS" |
| `slug` | String | Yes | No | URL-safe identifier |
| `region` | String | No | No | Geographic region. E.g., "Europe", "North America" |
| `status` | Enum | Yes | No | ACTIVE, INACTIVE, DEPRECATED |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `externalId` is unique per sport (a league ID from one API provider is unique within that sport).
- A League cannot be deleted if it has active Teams or Matches.
- `status` transitions: ACTIVE ↔ INACTIVE (bidirectional), ACTIVE → DEPRECATED (one-way).

**Deletion rule:** Soft-delete via DEPRECATED status. Historical match data references leagues.

---

### 2.7 Team

**Why it exists:** Represents a competitive entity (club, national team, esports organization) that participates in matches. Teams are the primary subjects of analysis — AI evaluates team form, head-to-head records, and roster strength.

**Ownership:** Owned by League (N:1). A team belongs to exactly one league at a time (in V1). Teams may appear in multiple leagues over time (e.g., relegation/promotion).

**References:**
- `leagueId` (foreign key to League)
- Referenced by: `Match` (as homeTeamId and awayTeamId)

**Lifecycle:**
```
ACTIVE → INACTIVE → DISBANDED
```

- **ACTIVE:** Team is currently competing.
- **INACTIVE:** Team exists but is not in an active season.
- **DISBANDED:** Team no longer exists.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `leagueId` | UUID | Yes | No | Foreign key to current League |
| `externalId` | String | Yes | No | API provider's identifier |
| `name` | String | Yes | No | Display name. E.g., "Manchester City" |
| `slug` | String | Yes | No | URL-safe identifier |
| `abbreviation` | String | No | No | Short code. E.g., "MCI", "T1" |
| `logoUrl` | String | No | No | URL to team logo for Discord embeds |
| `country` | String | No | No | Country of origin |
| `status` | Enum | Yes | No | ACTIVE, INACTIVE, DISBANDED |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `externalId` is unique per API provider.
- A Team cannot be deleted if it has Matches (as home or away).
- Team name changes are tracked by updating `name` (no history in V1).

**Deletion rule:** Soft-delete via DISBANDED status. Match history references teams permanently.

---

### 2.8 Match

**Why it exists:** The central entity around which the entire platform revolves. A Match represents a single competitive event between two teams. All data collection (odds), analysis (AI), predictions, and settlements are scoped to a Match.

**Ownership:** Owned by League (N:1). A match belongs to exactly one league.

**References:**
- `leagueId` (foreign key to League)
- `sportId` (foreign key to Sport — denormalized for query performance)
- `homeTeamId` (foreign key to Team)
- `awayTeamId` (foreign key to Team)
- Referenced by: `OddsSnapshot` (1:N), `Analysis` (1:N), `Prediction` (1:N)

**Lifecycle:**
```
SCHEDULED → LIVE → FINISHED
                ↘ CANCELLED
                    ↘ POSTPONED
```

- **SCHEDULED:** Match is in the future. Odds are being collected. Analysis is pending.
- **LIVE:** Match is in progress. Odds may still update (live betting).
- **FINISHED:** Match has concluded. Results are available. Predictions can be settled.
- **CANCELLED:** Match was cancelled. All predictions are voided.
- **POSTPONED:** Match was rescheduled. Predictions remain pending. New start time is set.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `externalId` | String | Yes | Yes | API provider's match identifier |
| `sportId` | UUID | Yes | No | Foreign key to Sport (denormalized) |
| `leagueId` | UUID | Yes | No | Foreign key to League |
| `homeTeamId` | UUID | Yes | No | Foreign key to Team (home) |
| `awayTeamId` | UUID | Yes | No | Foreign key to Team (away) |
| `startTime` | DateTime | Yes | No | Scheduled start time in UTC |
| `status` | Enum | Yes | No | SCHEDULED, LIVE, FINISHED, CANCELLED, POSTPONED |
| `homeScore` | Integer | No | No | Final home score. Set when FINISHED. |
| `awayScore` | Integer | No | No | Final away score. Set when FINISHED. |
| `winnerTeamId` | UUID | No | No | Foreign key to winning Team. Null for draws. |
| `isDraw` | Boolean | No | No | True if match ended in a draw |
| `externalStatus` | String | No | No | Raw status from API provider |
| `externalData` | JSON | No | No | Raw API response for debugging |
| `lastFetchedAt` | DateTime | No | No | Last time match data was fetched from API |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `homeTeamId` must not equal `awayTeamId` (a team cannot play itself).
- `startTime` must be in UTC.
- `homeScore` and `awayScore` can only be set when `status` is FINISHED.
- `winnerTeamId` and `isDraw` are mutually exclusive: one must be set when FINISHED, but not both.
- A Match cannot be deleted if it has associated OddsSnapshots, Analyses, or Predictions.
- `externalId` must be unique across all matches (no duplicate match ingestion).

**Deletion rule:** Never deleted. Matches are permanent records. Old matches (FINISHED + >90 days) may be archived but never removed.

---

### 2.9 OddsSnapshot

**Why it exists:** Captures the state of bookmaker odds for a match at a specific point in time. Multiple snapshots over time enable odds movement tracking, closing line value analysis, and historical comparison. Essential for determining if a prediction had positive expected value at the time it was made.

**Ownership:** Owned by Match (N:1). Multiple snapshots per match over time.

**References:**
- `matchId` (foreign key to Match)

**Lifecycle:**
```
RECORDED (immutable — snapshots are never modified)
```

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `matchId` | UUID | Yes | No | Foreign key to Match |
| `bookmaker` | String | Yes | No | Bookmaker name. E.g., "Bet365", "Pinnacle" |
| `market` | Enum | Yes | No | h2h, spreads, totals |
| `outcome` | String | Yes | No | E.g., "home", "away", "draw", "over_2.5" |
| `price` | Decimal | Yes | No | Decimal odds. E.g., 2.10 |
| `isMain` | Boolean | Yes | No | True if this is the primary/opening line |
| `isLive` | Boolean | Yes | No | True if odds were captured during live play |
| `externalData` | JSON | No | No | Raw API response for this odds entry |
| `capturedAt` | DateTime | Yes | No | When this snapshot was captured. Immutable. |

**Business invariants:**
- `price` must be ≥ 1.01 (minimum decimal odds).
- A snapshot is immutable after creation. Odds movements are captured as new snapshots, not updates.
- `capturedAt` precision: seconds. Multiple snapshots per second are allowed.
- `bookmaker` + `matchId` + `market` + `outcome` + `capturedAt` should be unique (no duplicate snapshots).

**Deletion rule:** Old snapshots (>90 days) may be deleted by the weekly cleanup job to manage data growth. Aggregated statistics (opening/closing lines) are preserved in Prediction records.

---

### 2.10 Analysis

**Why it exists:** Stores the result of an AI-powered analysis of a match. The Analysis entity captures what DeepSeek predicted, how confident it was, and why. This is the bridge between raw data (match + odds) and actionable predictions.

**Ownership:** Owned by Match (N:1). A match may be analyzed multiple times (initial analysis, re-analysis on odds movement, on-demand analysis).

**References:**
- `matchId` (foreign key to Match)
- Referenced by: `Prediction` (1:N — a prediction is based on an analysis)

**Lifecycle:**
```
QUEUED → IN_PROGRESS → COMPLETED
                      → FAILED
```

- **QUEUED:** Analysis job is pending.
- **IN_PROGRESS:** API call is in flight.
- **COMPLETED:** Analysis succeeded. Results are stored.
- **FAILED:** Analysis failed after all retries. Fallback to odds-only.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `matchId` | UUID | Yes | No | Foreign key to Match |
| `status` | Enum | Yes | No | QUEUED, IN_PROGRESS, COMPLETED, FAILED |
| `trigger` | Enum | Yes | No | SCHEDULED, ON_DEMAND, RE_ANALYSIS |
| `predictedWinner` | String | No | No | "home", "away", or "draw". Null if FAILED. |
| `confidence` | Decimal | No | No | 0.0–1.0. Null if FAILED. |
| `reasoning` | Text | No | No | AI's explanation. Null if FAILED. |
| `keyFactors` | String[] | No | No | Array of factor strings. Null if FAILED. |
| `recommendedMarket` | Enum | No | No | h2h, spread, total. Null if FAILED. |
| `valueAssessment` | Enum | No | No | HIGH, MEDIUM, LOW, NONE. Null if FAILED. |
| `promptUsed` | Text | No | No | The exact prompt sent to the AI. Useful for debugging. |
| `rawResponse` | JSON | No | No | Raw AI response. Useful for debugging. |
| `tokensUsed` | Integer | No | No | Token count for cost tracking |
| `costUsd` | Decimal | No | No | Estimated cost in USD |
| `latencyMs` | Integer | No | No | API response time in milliseconds |
| `errorMessage` | Text | No | No | Error details if FAILED |
| `oddsSnapshotId` | UUID | No | No | Reference to the OddsSnapshot used for this analysis |
| `completedAt` | DateTime | No | No | When analysis completed or failed |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `confidence` must be between 0.0 and 1.0. Only set when status is COMPLETED.
- `predictedWinner`, `reasoning`, `keyFactors`, `recommendedMarket`, `valueAssessment` are all set together or all null.
- A match should not have more than one COMPLETED analysis within a 6-hour window (unless trigger is RE_ANALYSIS).
- `tokensUsed` and `costUsd` should be tracked for cost monitoring.

**Deletion rule:** Analyses are never deleted. They are permanent records for auditing prediction quality and AI performance over time.

---

### 2.11 Prediction

**Why it exists:** The core business entity. A Prediction represents a betting recommendation generated by the system. It captures what was predicted, at what odds, with what confidence, and what stake was recommended. Every Prediction eventually resolves to an outcome, which feeds back into analytics and learning.

**Ownership:** Owned by User (N:1). Each prediction belongs to exactly one user.

**References:**
- `userId` (foreign key to User)
- `matchId` (foreign key to Match)
- `analysisId` (foreign key to Analysis — the analysis that generated this prediction)
- Referenced by: `BankrollTransaction` (1:N), `PredictionOutcome` (1:1)

**Lifecycle:**
```
PENDING → PLACED → SETTLED → ARCHIVED
              ↘ VOIDED
              ↘ EXPIRED
```

- **PENDING:** Draft recommendation. Not yet active. May be reviewed.
- **PLACED:** Recommendation is active. Stake deducted from bankroll. Alert sent.
- **SETTLED:** Match finished. Outcome determined (WON/LOST/PUSH/VOID).
- **ARCHIVED:** Older than 90 days. Moved to archive.
- **VOIDED:** Invalidated before match (line change, injury, cancellation).
- **EXPIRED:** Match started but prediction was never settled (edge case).

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `userId` | UUID | Yes | No | Foreign key to User |
| `matchId` | UUID | Yes | No | Foreign key to Match |
| `analysisId` | UUID | No | No | Foreign key to Analysis. Null if odds-only fallback. |
| `status` | Enum | Yes | No | PENDING, PLACED, SETTLED, ARCHIVED, VOIDED, EXPIRED |
| `market` | Enum | Yes | No | h2h, spread, total |
| `predictedOutcome` | String | Yes | No | E.g., "home", "away", "over_2.5" |
| `oddsAtPlacement` | Decimal | Yes | No | Decimal odds when prediction was placed |
| `bookmaker` | String | Yes | No | Bookmaker whose odds were used |
| `stake` | Decimal | Yes | No | Stake amount in bankroll units |
| `confidence` | Decimal | Yes | No | AI confidence at time of prediction |
| `expectedValue` | Decimal | Yes | No | Calculated EV at placement. Positive = value bet. |
| `valueAssessment` | Enum | Yes | No | HIGH, MEDIUM, LOW, NONE |
| `settlementStatus` | Enum | No | No | WON, LOST, PUSH, VOID. Set when SETTLED. |
| `settledAt` | DateTime | No | No | When prediction was settled |
| `voidReason` | String | No | No | Reason if VOIDED |
| `archivedAt` | DateTime | No | No | When prediction was archived |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `confidence` must be ≥ 0.60 (minimum confidence threshold).
- `oddsAtPlacement` must be ≥ 1.50 (minimum odds threshold).
- `stake` must be ≤ 5% of the user's bankroll at time of placement.
- A user cannot have more than `maxConcurrentBets` predictions in PLACED status.
- `settlementStatus` can only be set when `status` is SETTLED.
- `matchId` + `userId` + `market` + `predictedOutcome` must be unique for PLACED predictions (no duplicate bets on same outcome).
- `expectedValue` must be positive for PLACED predictions (no negative EV bets).

**Deletion rule:** Never deleted. Predictions are permanent records for analytics, learning, and audit. Old predictions (SETTLED + >90 days) are soft-archived (status = ARCHIVED) but data is preserved.

---

### 2.12 PredictionOutcome

**Why it exists:** Separates the outcome of a prediction from the prediction itself. This allows the prediction to be created before the match finishes, and the outcome to be recorded later. It also enables tracking multiple outcome dimensions (financial result, accuracy, line movement).

**Ownership:** Owned by Prediction (1:1). Created when the prediction is settled.

**References:**
- `predictionId` (foreign key to Prediction)

**Lifecycle:**
```
PENDING → RECORDED
```

- **PENDING:** Match is still in progress. Outcome not yet determined.
- **RECORDED:** Outcome has been determined and recorded. Immutable.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `predictionId` | UUID | Yes | Yes | Foreign key to Prediction. One-to-one. |
| `status` | Enum | Yes | No | PENDING, RECORDED |
| `result` | Enum | No | No | WON, LOST, PUSH, VOID. Set when RECORDED. |
| `pnl` | Decimal | No | No | Profit and loss. Positive for wins, negative for losses. |
| `roi` | Decimal | No | No | Return on investment for this bet (pnl / stake) |
| `closingOdds` | Decimal | No | No | Closing line odds for closing line value analysis |
| `actualHomeScore` | Integer | No | No | Final home score from the match |
| `actualAwayScore` | Integer | No | No | Final away score from the match |
| `wasCorrect` | Boolean | No | No | True if prediction matched actual outcome |
| `recordedAt` | DateTime | No | No | When outcome was recorded |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `result` must be set when `status` is RECORDED.
- `pnl` must equal `stake * (oddsAtPlacement - 1)` for WON, `-stake` for LOST, `0` for PUSH and VOID.
- `roi` must equal `pnl / stake`.
- `wasCorrect` is true when: WON (prediction was correct), false when: LOST, null when: PUSH or VOID.
- `closingOdds` is optional — only set if a closing odds snapshot exists for the match.

**Deletion rule:** Never deleted. Outcomes are permanent records tied to predictions.

---

### 2.13 LearningInsight

**Why it exists:** Captures the output of the historical learning process. LearningInsights are structured observations about prediction performance patterns. They feed back into prompt engineering and decision rule adjustments. This is the "learning" part of the platform — converting raw prediction data into actionable knowledge.

**Ownership:** System-owned. Generated by the Historical Learning Service during the daily learning job.

**References:**
- `sportId` (optional — foreign key to Sport, if insight is sport-specific)
- `leagueId` (optional — foreign key to League, if insight is league-specific)

**Lifecycle:**
```
GENERATED → REVIEWED → APPLIED → SUPERSEDED
```

- **GENERATED:** New insight created by the learning job.
- **REVIEWED:** Developer has reviewed the insight.
- **APPLIED:** Insight has been incorporated into prompt templates or decision rules.
- **SUPERSEDED:** A newer insight has replaced this one.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `sportId` | UUID | No | No | Foreign key to Sport. Null if global insight. |
| `leagueId` | UUID | No | No | Foreign key to League. Null if sport-wide or global. |
| `status` | Enum | Yes | No | GENERATED, REVIEWED, APPLIED, SUPERSEDED |
| `insightType` | Enum | Yes | No | ACCURACY_TREND, CALIBRATION, MARKET_PERFORMANCE, BOOKMAKER_VALUE, SEASONAL_PATTERN |
| `title` | String | Yes | No | Short description. E.g., "Low accuracy in LCS" |
| `description` | Text | Yes | No | Detailed finding with data |
| `metric` | String | Yes | No | The metric being measured. E.g., "win_rate", "roi" |
| `metricValue` | Decimal | Yes | No | The measured value. E.g., 0.42 for 42% win rate |
| `sampleSize` | Integer | Yes | No | Number of predictions this insight is based on |
| `confidence` | Decimal | No | No | Statistical confidence in this insight (0.0–1.0) |
| `recommendedAction` | Text | No | No | Suggested action. E.g., "Reduce confidence threshold for LCS by 5%" |
| `appliedAt` | DateTime | No | No | When insight was applied |
| `supersededAt` | DateTime | No | No | When insight was superseded |
| `supersededById` | UUID | No | No | Reference to the superseding insight |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `sampleSize` must be ≥ 10 (minimum sample size for statistical relevance).
- `metricValue` must be between 0.0 and 1.0 for rate-based metrics.
- An insight can only be SUPERSEDED if it was previously APPLIED.
- `sportId` and `leagueId` cannot both be set (an insight is either global, sport-wide, or league-specific).

**Deletion rule:** Never deleted. Insights are permanent records of the learning process. Superseded insights are preserved for audit.

---

### 2.14 Alert

**Why it exists:** Records every notification sent to a Discord channel or user. Alerts are the delivery mechanism for predictions, settlements, summaries, and system notifications. Tracking alerts enables delivery monitoring, rate limiting, and debugging.

**Ownership:** System-owned. Generated by the Alert Service.

**References:**
- `userId` (optional — foreign key to User, if alert is user-targeted)
- `predictionId` (optional — foreign key to Prediction, if alert is prediction-related)

**Lifecycle:**
```
QUEUED → SENDING → DELIVERED
                → FAILED
```

- **QUEUED:** Alert is in the BullMQ queue, pending delivery.
- **SENDING:** Alert is being sent to Discord.
- **DELIVERED:** Alert was successfully sent.
- **FAILED:** Alert failed after all retries.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `userId` | UUID | No | No | Foreign key to User. Null for channel-wide alerts. |
| `predictionId` | UUID | No | No | Foreign key to Prediction. Null for non-prediction alerts. |
| `type` | Enum | Yes | No | NEW_PREDICTION, MATCH_STARTING, BET_SETTLED, DAILY_SUMMARY, BANKROLL_ALERT, ODDS_MOVEMENT, ERROR, WARNING |
| `channel` | String | Yes | No | Discord channel name. E.g., "predictions", "alerts" |
| `status` | Enum | Yes | No | QUEUED, SENDING, DELIVERED, FAILED |
| `priority` | Enum | Yes | No | HIGH, MEDIUM, LOW |
| `title` | String | Yes | No | Alert title for the Discord embed |
| `message` | Text | Yes | No | Alert body content |
| `embedJson` | JSON | No | No | Full Discord embed payload for debugging |
| `discordMessageId` | String | No | No | Discord's message ID after successful send |
| `errorMessage` | Text | No | No | Error details if FAILED |
| `retryCount` | Integer | Yes | No | Number of delivery attempts |
| `deliveredAt` | DateTime | No | No | When alert was successfully delivered |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Business invariants:**
- `retryCount` must be ≤ 5 (maximum retry attempts).
- `discordMessageId` can only be set when `status` is DELIVERED.
- `errorMessage` can only be set when `status` is FAILED.
- Alerts of type ERROR and WARNING should not have a `userId` (they are system-wide).

**Deletion rule:** Alerts older than 30 days may be deleted by the weekly cleanup job. They are ephemeral delivery records, not business-critical data.

---

## 3. Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         RELATIONSHIP MAP                            │
│                                                                     │
│  ┌──────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  User    │1──1│ UserPreferences  │     │  Sport           │    │
│  │          │1──1│ Bankroll         │     │   (system-owned) │    │
│  │          │1──N│ BankrollTransact.│     └────────┬─────────┘    │
│  │          │1──N│ Prediction       │              │1              │
│  │          │1──N│ Alert            │     ┌────────▼─────────┐    │
│  └──────────┘     └──────────────────┘     │  League          │    │
│                                            └────────┬─────────┘    │
│  ┌──────────────────┐     ┌──────────────────┐      │1             │
│  │  Prediction      │1──1│ PredictionOutcome│     ┌──┴────────┐   │
│  │                  │N──1│ Match            │     │  Team     │   │
│  │                  │N──1│ Analysis         │     └───────────┘   │
│  │                  │N──1│ Alert            │                     │
│  └──────────────────┘     └──────────────────┘                    │
│                                                                     │
│  ┌──────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  Match   │1──N│ OddsSnapshot     │     │  Analysis        │    │
│  │          │1──N│ Analysis         │     │  (match-owned)   │    │
│  │          │1──N│ Prediction       │     └──────────────────┘    │
│  │          │     └──────────────────┘                             │
│  │  (league-owned, references 2 teams)                            │
│  └──────────┘                                                     │
│                                                                     │
│  ┌──────────────────┐     ┌──────────────────┐                    │
│  │  LearningInsight │     │  Alert           │                    │
│  │  (system-owned)  │     │  (system-owned)  │                    │
│  └──────────────────┘     └──────────────────┘                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Relationship Summary

| From | To | Type | Description |
|---|---|---|---|
| User | UserPreferences | 1:1 | Each user has exactly one preferences record |
| User | Bankroll | 1:1 | Each user has exactly one active bankroll |
| User | BankrollTransaction | 1:N | Each user has many transactions (via Bankroll) |
| User | Prediction | 1:N | Each user has many predictions |
| User | Alert | 1:N | Each user receives many alerts |
| Sport | League | 1:N | Each sport has many leagues |
| League | Team | 1:N | Each league has many teams |
| League | Match | 1:N | Each league has many matches |
| Match | Team | N:1 | Each match has one home team and one away team |
| Match | OddsSnapshot | 1:N | Each match has many odds snapshots |
| Match | Analysis | 1:N | Each match has many analyses |
| Match | Prediction | 1:N | Each match has many predictions |
| Analysis | Prediction | 1:N | Each analysis may generate many predictions |
| Prediction | PredictionOutcome | 1:1 | Each prediction has exactly one outcome |
| Prediction | BankrollTransaction | 1:N | Each prediction generates transactions |
| Prediction | Alert | 1:N | Each prediction may trigger alerts |

---

## 4. Aggregate Boundaries

Aggregates define transactional consistency boundaries. Within an aggregate, all invariants must be satisfied before a transaction commits. Across aggregates, eventual consistency is acceptable.

### Aggregate 1: User (Root: User)
**Contains:** User, UserPreferences, Bankroll
**Rationale:** User identity, preferences, and bankroll are always accessed together. Creating a user atomically creates all three. Bankroll updates must be consistent with user state.

### Aggregate 2: Match (Root: Match)
**Contains:** Match, OddsSnapshot
**Rationale:** Match data and its odds snapshots are tightly coupled. Odds are meaningless without their match context.

### Aggregate 3: Analysis (Root: Analysis)
**Contains:** Analysis (standalone)
**Rationale:** Analysis is created independently and referenced by Predictions. It does not need transactional consistency with Predictions.

### Aggregate 4: Prediction (Root: Prediction)
**Contains:** Prediction, PredictionOutcome, BankrollTransaction
**Rationale:** Creating a prediction must atomically deduct from bankroll. Settling a prediction must atomically update bankroll and record the outcome.

### Aggregate 5: Sport Hierarchy (Root: Sport)
**Contains:** Sport, League, Team
**Rationale:** Sports, leagues, and teams are reference data that change infrequently. They are loaded together for match creation.

### Aggregate 6: Learning (Root: LearningInsight)
**Contains:** LearningInsight (standalone)
**Rationale:** Insights are generated independently and do not require transactional consistency with other aggregates.

### Aggregate 7: Alert (Root: Alert)
**Contains:** Alert (standalone)
**Rationale:** Alerts are fire-and-forget. Delivery failures should not affect business transactions.

---

## 5. Business Invariants

### Global Invariants

| # | Invariant | Enforcement |
|---|---|---|
| 1 | A User cannot have more than `maxConcurrentBets` predictions in PLACED status | Checked before creating a new PLACED prediction |
| 2 | A Prediction's `stake` cannot exceed 5% of the user's Bankroll `currentBalance` at time of placement | Checked before creating a new PLACED prediction |
| 3 | A Prediction's `confidence` must be ≥ the user's `minConfidenceThreshold` | Checked before creating a new PLACED prediction |
| 4 | A Prediction's `oddsAtPlacement` must be ≥ the user's `minOddsThreshold` | Checked before creating a new PLACED prediction |
| 5 | A Prediction's `expectedValue` must be positive | Checked before creating a new PLACED prediction |
| 6 | Bankroll `currentBalance` must never be negative | Checked on every bankroll operation |
| 7 | Bankroll `currentBalance` must equal `startingBalance + totalPnl` | Checked on every bankroll operation |
| 8 | A Match cannot have duplicate predictions for the same user, market, and outcome | Unique constraint enforced at application level |
| 9 | A Match's `homeTeamId` must not equal `awayTeamId` | Checked on match creation |
| 10 | A Match's `winnerTeamId` and `isDraw` are mutually exclusive | Checked when match is set to FINISHED |

### State Transition Invariants

| Entity | Valid Transitions |
|---|---|
| User | CREATED → ACTIVE → INACTIVE → ARCHIVED (one-way) |
| Bankroll | ACTIVE → DRAWDOWN → FROZEN; FROZEN → ACTIVE (via RESET only) |
| Match | SCHEDULED → LIVE → FINISHED; SCHEDULED → CANCELLED; SCHEDULED → POSTPONED |
| Prediction | PENDING → PLACED → SETTLED → ARCHIVED; PLACED → VOIDED; PLACED → EXPIRED |
| Analysis | QUEUED → IN_PROGRESS → COMPLETED; IN_PROGRESS → FAILED |
| PredictionOutcome | PENDING → RECORDED (one-way) |
| Sport | ACTIVE → DEPRECATED (one-way) |
| League | ACTIVE ↔ INACTIVE; ACTIVE → DEPRECATED |
| Team | ACTIVE → INACTIVE → DISBANDED (one-way) |
| LearningInsight | GENERATED → REVIEWED → APPLIED → SUPERSEDED (one-way) |
| Alert | QUEUED → SENDING → DELIVERED; SENDING → FAILED |

---

## 6. Deletion Rules

### Never Deleted (Permanent Records)

| Entity | Rationale |
|---|---|
| Match | Central to all analytics and historical tracking |
| Analysis | Audit trail for prediction quality and AI performance |
| Prediction | Core business record for analytics, learning, and audit |
| PredictionOutcome | Permanent record of prediction resolution |
| Bankroll | Financial history must be preserved |
| BankrollTransaction | Immutable audit trail |
| LearningInsight | Permanent record of the learning process |

### Soft-Deleted (Status Change)

| Entity | Method | Trigger |
|---|---|---|
| User | Status → ARCHIVED, username anonymized | User request or 365 days inactive |
| Sport | Status → DEPRECATED | Manual action |
| League | Status → DEPRECATED | Manual action |
| Team | Status → DISBANDED | Manual action |

### Hard-Deleted (Removed)

| Entity | When | Trigger |
|---|---|---|
| OddsSnapshot | >90 days old | Weekly cleanup job |
| Alert | >30 days old | Weekly cleanup job |

### Cascade-Deleted

| Entity | When |
|---|---|
| UserPreferences | When parent User is archived |

---

## 7. Historical Data Retention

### Retention Periods

| Data | Retention | Action After Period |
|---|---|---|
| OddsSnapshots | 90 days | Deleted by cleanup job |
| Alerts | 30 days | Deleted by cleanup job |
| Predictions (SETTLED) | 90 days active, then archived | Status → ARCHIVED, data preserved |
| BankrollTransactions | 365 days hot, then cold storage | Moved to archive table |
| Matches (FINISHED) | Indefinite | Never deleted |
| Analyses | Indefinite | Never deleted |
| LearningInsights | Indefinite | Never deleted |
| User data (inactive) | 365 days | Status → ARCHIVED, anonymized |

### Archival Strategy

- **Hot storage (primary tables):** Active data needed for queries and commands.
- **Warm storage (archive tables):** Predictions older than 90 days (status = ARCHIVED). Data is preserved but moved to separate archive schema or table.
- **Cold storage (export):** BankrollTransactions older than 365 days may be exported to JSON/CSV and removed from the primary database if storage becomes a concern.

### Aggregation Before Deletion

Before deleting OddsSnapshots (at 90 days), the following aggregated data is preserved in the Prediction record:
- `oddsAtPlacement` (already stored)
- Closing line odds (stored in PredictionOutcome.closingOdds)

This ensures closing line value analysis remains possible even after raw snapshots are deleted.

---

*End of V1 Domain Model Specification*


