# Betting Intelligence Discord Platform — V1 Domain Model (Revised)

> **Status:** Final Domain Model Document  
> **Version:** 1.1 (Revised)  
> **Last Updated:** 2026-06-05  
> **Source of Truth:** ARCHITECTURE-V1.md, Critical Review of V1.0

---

## Architectural Review Findings

### Overengineering Identified

| Issue | Location | Problem | Resolution |
|---|---|---|---|
| **Prediction per-user ownership** | Domain Model §2.11 | Predictions owned by User. For a 5-user private server where all friends see the same recommendations, this creates N copies of every prediction with per-user staking. Unnecessary complexity. | Make Prediction global (system-owned). Bankroll impact is tracked via BankrollTransaction linking user + prediction. |
| **PredictionOutcome as separate entity** | Domain Model §2.12 | PredictionOutcome is a 1:1 with Prediction. This adds a join/table for no benefit. The outcome fields belong directly on Prediction. | Merge PredictionOutcome fields into Prediction. Remove PredictionOutcome entity. |
| **LearningInsight entity** | Domain Model §2.13 | A full entity with lifecycle, status transitions, supersession tracking. For a 5-user server, the developer will read analytics directly from the DB or a simple log. This is a V2 concern at best. | Remove LearningInsight entity entirely. Replace with a simple analytics query or log file. |
| **Alert entity with DB persistence** | Domain Model §2.14 | Storing every alert in PostgreSQL with full lifecycle tracking. For a private server with 5 users, this is overkill. Alerts are ephemeral. | Remove Alert entity. Alerts are sent directly to Discord channels. No DB persistence. |
| **BankrollTransaction entity** | Domain Model §2.4 | Full audit trail with balanceBefore/balanceAfter on every transaction. For virtual bankrolls among friends, this is unnecessary. The current balance + prediction history is sufficient. | Remove BankrollTransaction entity. Bankroll balance is updated directly. Prediction history provides the audit trail. |
| **User lifecycle (INACTIVE → ARCHIVED)** | Domain Model §2.1 | Four-state lifecycle with anonymization for a 5-user private server where everyone knows each other. | Simplify to CREATED → ACTIVE. No archiving. No anonymization. |
| **Kelly Criterion staking** | Architecture §10.2, Domain Model §2.2 | Kelly Criterion adds mathematical complexity (fractional Kelly, caps, edge cases). For friends with virtual bankrolls, fixed fractional staking is sufficient. | Remove Kelly Criterion entirely. Fixed fractional only. |
| **Historical Learning Service** | Architecture §3.11 | A dedicated module with daily jobs, insight generation, prompt improvement loop. For V1 with 5 users, the developer can manually review prediction outcomes. | Remove Historical Learning Service as a separate module. Analytics Service handles basic stats. |
| **7 BullMQ queues** | Architecture §6.1 | Separate queues for match-fetch, odds-fetch, ai-analysis, prediction, alert, settlement, learning, summary, cleanup. For a single developer with 5 users, this is excessive. | Consolidate to 3 queues: `api-fetch` (external API calls), `analysis` (AI + prediction generation), `settlement` (match settlement). |
| **Analytics Service as separate module** | Architecture §3.7 | A dedicated analytics module with pre-computed metrics. For 5 users, analytics can be computed on-demand from prediction data. | Remove Analytics Service as a separate module. Prediction queries provide all needed stats. |
| **Per-user notification preferences** | Domain Model §2.2 | 5 boolean fields + min confidence filter + sport subscriptions. For a private server, alerts go to shared channels. Role mentions handle targeting. | Simplify to a single shared configuration. No per-user alert preferences. |
| **Bankroll DRAWDOWN / FROZEN states** | Domain Model §2.3 | Three-state bankroll with automatic stake reduction. For virtual bankrolls among friends, this is over-engineered. | Simplify to ACTIVE only. Users can manually reset. |
| **OddsSnapshot immutability + 90-day deletion** | Domain Model §2.9 | Complex lifecycle for odds data. For V1, just store the latest odds and the odds used for each prediction. | Simplify: store current odds on Match. Store oddsAtPlacement on Prediction. No snapshot history in V1. |

### Domain Modeling Mistakes

| Issue | Location | Problem | Resolution |
|---|---|---|---|
| **Team owned by single League** | Domain Model §2.7 | Esports organizations compete in multiple leagues/tournaments simultaneously (e.g., T1 plays in LCK, MSI, Worlds). A team cannot belong to exactly one league. | Make Team independent (owned by Sport). Use a join concept (TeamLeague or Tournament) for league membership. |
| **No currency support** | Domain Model §2.3 | Bankroll uses abstract "units". User requires HUF and EUR support. | Add `currency` field to Bankroll. Support HUF and EUR. |
| **Match winnerTeamId + isDraw** | Domain Model §2.8 | Using two mutually exclusive fields is error-prone. | Replace with a single `result` enum: HOME_WIN, AWAY_WIN, DRAW. |
| **Analysis.oddsSnapshotId** | Domain Model §2.10 | References an OddsSnapshot that may be deleted after 90 days. | Remove. Store the odds values used directly on Analysis. |
| **Prediction.analysisId nullable** | Domain Model §2.11 | Null when odds-only fallback. This creates two code paths. | Make analysisId required. If AI fails, create a minimal Analysis record with status=FAILED. |
| **UserPreferences.subscribedSports as String[]** | Domain Model §2.2 | Array of strings referencing Sport slugs. No referential integrity. | Remove per-user sport subscriptions. Alerts go to shared channels. |

### Unnecessary Complexity for 5 Users

| Feature | Why It's Too Much |
|---|---|
| **BullMQ with 9 job types** | A simple `setInterval` or `node-cron` would suffice for a single-process app with 5 users |
| **Graceful shutdown with 30s timeout** | A single developer can restart the process manually |
| **Health check HTTP endpoint** | Not needed for a Discord bot with no HTTP API |
| **V2 scalability section** | Irrelevant for a private server that will never scale beyond 5 users |
| **Cold storage for BankrollTransactions** | Virtual bankroll data for 5 users will never exceed a few MB |
| **Sharding preparation in Discord Bot** | Discord.js sharding is for 1000+ guilds. Not needed for a single private server. |
| **Per-user maxConcurrentBets** | 5 friends can coordinate themselves. A single global limit is fine. |
| **Prompt improvement loop with versioning** | The developer will manually tweak prompts. No need for automated insight tracking. |

---

## Recommended Changes Summary

### Architecture Changes

1. **Remove Historical Learning Service module** — Developer reviews analytics manually.
2. **Remove Analytics Service module** — Prediction queries provide stats on-demand.
3. **Consolidate BullMQ queues to 3:** `api-fetch`, `analysis`, `settlement`.
4. **Remove Alert entity from DB** — Alerts are sent directly to Discord channels.
5. **Remove BankrollTransaction entity** — Prediction history is the audit trail.
6. **Remove PredictionOutcome entity** — Merge fields into Prediction.
7. **Remove LearningInsight entity** — Not needed in V1.
8. **Remove Alert entity** — Not persisted in V1.
9. **Simplify User lifecycle** — CREATED → ACTIVE only. No INACTIVE/ARCHIVED.
10. **Simplify Bankroll lifecycle** — ACTIVE only. No DRAWDOWN/FROZEN.
11. **Remove Kelly Criterion** — Fixed fractional staking only.
12. **Remove per-user notification preferences** — Shared channel configuration.
13. **Remove OddsSnapshot entity** — Store current odds on Match, oddsAtPlacement on Prediction.
14. **Remove V2 scalability section** from architecture document.

### Domain Model Changes

#### Entities to Remove (4)
- `PredictionOutcome` — merge into Prediction
- `BankrollTransaction` — remove; prediction history is sufficient
- `LearningInsight` — not needed in V1
- `Alert` — not persisted in V1

#### Entities to Keep (10)
- `User` — simplified lifecycle
- `UserPreferences` — simplified (no Kelly, no per-user alerts)
- `Bankroll` — simplified lifecycle, added currency
- `Sport` — unchanged
- `League` — unchanged
- `Team` — ownership changed to Sport, many-to-many with League
- `Match` — simplified result field
- `OddsSnapshot` — removed (replaced by Match.currentOdds)
- `Analysis` — simplified (no oddsSnapshotId)
- `Prediction` — expanded (absorbed PredictionOutcome fields)

#### Entities to Add (1)
- `TeamLeague` — join entity linking Team to League (for esports teams in multiple leagues)

#### Fields to Add
| Entity | Field | Reason |
|---|---|---|
| Bankroll | `currency` (Enum: HUF, EUR) | Multi-currency support |
| Match | `currentOdds` (JSON) | Replace OddsSnapshot; store latest odds inline |
| Prediction | `result` (Enum: WON, LOST, PUSH, VOID) | Absorbed from PredictionOutcome |
| Prediction | `pnl` (Decimal) | Absorbed from PredictionOutcome |
| Prediction | `roi` (Decimal) | Absorbed from PredictionOutcome |
| Prediction | `closingOdds` (Decimal) | Absorbed from PredictionOutcome |
| Prediction | `wasCorrect` (Boolean) | Absorbed from PredictionOutcome |
| Prediction | `settledAt` (DateTime) | Absorbed from PredictionOutcome |
| Team | `sportId` (UUID, FK to Sport) | Team now owned by Sport, not League |

#### Fields to Remove
| Entity | Field | Reason |
|---|---|---|
| User | `discordDiscriminator` | Discord migrated away from discriminators |
| User | `status` (INACTIVE, ARCHIVED) | Simplified to CREATED/ACTIVE |
| User | `archivedAt` | No archiving |
| UserPreferences | `stakingMethod` | Fixed fractional only |
| UserPreferences | `kellyFraction` | No Kelly Criterion |
| UserPreferences | `alertOnNewPrediction` | No per-user alerts |
| UserPreferences | `alertOnSettlement` | No per-user alerts |
| UserPreferences | `alertOnBankrollAlert` | No per-user alerts |
| UserPreferences | `alertOnDailySummary` | No per-user alerts |
| UserPreferences | `alertMinConfidence` | No per-user alerts |
| UserPreferences | `subscribedSports` | No per-user sport subscriptions |
| UserPreferences | `maxConcurrentBets` | Single global limit |
| Bankroll | `peakBalance` | Simplified lifecycle |
| Bankroll | `totalStaked` | Can be computed from predictions |
| Bankroll | `totalPnl` | Can be computed from predictions |
| Bankroll | `totalWins` | Can be computed from predictions |
| Bankroll | `totalLosses` | Can be computed from predictions |
| Bankroll | `totalPushes` | Can be computed from predictions |
| Bankroll | `drawdownNotifiedAt` | No drawdown state |
| Bankroll | `frozenNotifiedAt` | No frozen state |
| Bankroll | `status` (DRAWDOWN, FROZEN) | Simplified to ACTIVE only |
| Match | `winnerTeamId` | Replaced by `result` enum |
| Match | `isDraw` | Replaced by `result` enum |
| Match | `externalStatus` | Redundant with `status` |
| Match | `externalData` | Store in logs, not DB |
| Analysis | `oddsSnapshotId` | No OddsSnapshot entity |
| Analysis | `promptUsed` | Store in logs, not DB |
| Analysis | `rawResponse` | Store in logs, not DB |
| Analysis | `latencyMs` | Not needed in V1 |
| Prediction | `analysisId` (nullable) | Now required (create minimal Analysis on failure) |
| Prediction | `settlementStatus` | Replaced by `result` |
| Prediction | `voidReason` | Optional text field, keep as note |
| Team | `leagueId` | Team now owned by Sport, linked to League via TeamLeague |
| Team | `abbreviation` | Not needed in V1 |
| Team | `logoUrl` | Not needed in V1 |
| Team | `country` | Not needed in V1 |
| Team | `status` (INACTIVE, DISBANDED) | Simplified to ACTIVE only |
| League | `region` | Not needed in V1 |
| League | `status` (INACTIVE, DEPRECATED) | Simplified to ACTIVE only |
| Sport | `iconUrl` | Not needed in V1 |

---

## Final Recommended Domain Model for V1

### Entity List (10 entities)

1. User
2. UserPreferences
3. Bankroll
4. Sport
5. League
6. Team
7. TeamLeague (join entity)
8. Match
9. Analysis
10. Prediction

---

### 1. User

**Why it exists:** Links a Discord user to the platform. Tracks identity and activity.

**Ownership:** Self-owned. Created on first interaction.

**Referenced by:** UserPreferences (1:1), Bankroll (1:1), Prediction (1:N)

**Lifecycle:** CREATED → ACTIVE (simple, no archiving)

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `discordId` | String | Yes | Yes | Discord snowflake. Immutable. |
| `discordUsername` | String | Yes | No | Current Discord username |
| `status` | Enum | Yes | No | CREATED, ACTIVE |
| `firstSeenAt` | DateTime | Yes | No | First interaction timestamp |
| `lastActiveAt` | DateTime | Yes | No | Most recent interaction |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Invariants:**
- `discordId` is immutable after creation.
- A User cannot be deleted while they have PLACED Predictions.

**Deletion:** Never deleted. Data is minimal and harmless.

---

### 2. UserPreferences

**Why it exists:** Stores per-user staking configuration. Simplified to only what matters for 5 friends: stake size.

**Ownership:** Owned by User (1:1). Created with User.

**References:** `userId` (FK to User)

**Lifecycle:** Created with User, updated on user request.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `userId` | UUID | Yes | Yes | FK to User. One-to-one. |
| `defaultStakePercent` | Decimal | Yes | No | Default: 1.0. Range: 0.5–5.0 |
| `minConfidenceThreshold` | Decimal | Yes | No | Default: 0.60. Range: 0.0–1.0 |
| `minOddsThreshold` | Decimal | Yes | No | Default: 1.50 |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Removed fields:** stakingMethod, kellyFraction, maxConcurrentBets, all alert booleans, alertMinConfidence, subscribedSports.

**Invariants:**
- `defaultStakePercent` between 0.5 and 5.0.
- `minConfidenceThreshold` between 0.0 and 1.0.

**Deletion:** Cascade-deleted with User.

---

### 3. Bankroll

**Why it exists:** Tracks a user's virtual betting capital. Simplified to single state, no drawdown tracking.

**Ownership:** Owned by User (1:1). Created with User.

**References:** `userId` (FK to User)

**Lifecycle:** ACTIVE only. Reset creates a new record (old preserved).

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `userId` | UUID | Yes | Yes | FK to User. One-to-one. |
| `currency` | Enum | Yes | No | HUF, EUR |
| `startingBalance` | Decimal | Yes | No | Initial balance. Default: 10,000. Immutable. |
| `currentBalance` | Decimal | Yes | No | Current balance. Updated on settlement. |
| `status` | Enum | Yes | No | ACTIVE only in V1 |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Removed fields:** peakBalance, totalStaked, totalPnl, totalWins, totalLosses, totalPushes, drawdownNotifiedAt, frozenNotifiedAt.

**Invariants:**
- `currentBalance` must never be negative.
- `startingBalance` is immutable.

**Deletion:** Never deleted.

---

### 4. Sport

**Why it exists:** Categorizes matches. Seeded at deployment.

**Ownership:** System-owned.

**Referenced by:** League (1:N), Team (1:N), Match (1:N)

**Lifecycle:** ACTIVE → DEPRECATED

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `slug` | String | Yes | Yes | E.g., "soccer", "nba", "cs2" |
| `name` | String | Yes | No | Display name |
| `category` | Enum | Yes | No | TRADITIONAL, ESPORTS |
| `status` | Enum | Yes | No | ACTIVE, DEPRECATED |
| `externalApiSource` | Enum | Yes | No | THE_ODDS_API, PANDASCORE |
| `externalSportKey` | String | Yes | No | API's identifier for this sport |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Removed fields:** iconUrl.

**Invariants:**
- `slug` is unique and immutable.

**Deletion:** Soft-delete via DEPRECATED.

---

### 5. League

**Why it exists:** Groups teams and matches within a sport.

**Ownership:** Owned by Sport (N:1).

**References:** `sportId` (FK to Sport). Referenced by: TeamLeague (1:N), Match (1:N)

**Lifecycle:** ACTIVE only in V1.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `sportId` | UUID | Yes | No | FK to Sport |
| `externalId` | String | Yes | No | API provider's identifier |
| `name` | String | Yes | No | Display name |
| `slug` | String | Yes | No | URL-safe identifier |
| `status` | Enum | Yes | No | ACTIVE only in V1 |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Removed fields:** region.

**Invariants:**
- `externalId` is unique per sport.

**Deletion:** Soft-delete via DEPRECATED status.

---

### 6. Team

**Why it exists:** Represents a competitive entity. Now owned by Sport, not League, because esports teams compete in multiple leagues.

**Ownership:** Owned by Sport (N:1).

**References:** `sportId` (FK to Sport). Referenced by: TeamLeague (1:N), Match (as homeTeamId and awayTeamId)

**Lifecycle:** ACTIVE only in V1.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `sportId` | UUID | Yes | No | FK to Sport (NEW — team owned by sport) |
| `externalId` | String | Yes | No | API provider's identifier |
| `name` | String | Yes | No | Display name |
| `slug` | String | Yes | No | URL-safe identifier |
| `status` | Enum | Yes | No | ACTIVE only in V1 |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Removed fields:** leagueId, abbreviation, logoUrl, country.

**Key change:** Team is no longer owned by a single League. League membership is tracked via TeamLeague.

**Invariants:**
- `externalId` is unique per API provider.

**Deletion:** Soft-delete.

---

### 7. TeamLeague (NEW)

**Why it exists:** Join entity linking Team to League. Enables esports teams to participate in multiple leagues/tournaments simultaneously (e.g., T1 in LCK, MSI, Worlds).

**Ownership:** Owned by Team and League (N:N join).

**References:** `teamId` (FK to Team), `leagueId` (FK to League)

**Lifecycle:** ACTIVE only in V1.

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `teamId` | UUID | Yes | No | FK to Team |
| `leagueId` | UUID | Yes | No | FK to League |
| `status` | Enum | Yes | No | ACTIVE only in V1 |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |

**Invariants:**
- `teamId` + `leagueId` must be unique (a team appears once per league).

**Deletion:** Cascade-deleted with Team or League.

---

### 8. Match

**Why it exists:** Central entity. A competitive event between two teams.

**Ownership:** Owned by League (N:1).

**References:** `leagueId` (FK to League), `sportId` (FK to Sport, denormalized), `homeTeamId` (FK to Team), `awayTeamId` (FK to Team). Referenced by: Analysis (1:N), Prediction (1:N)

**Lifecycle:** SCHEDULED → LIVE → FINISHED / CANCELLED / POSTPONED

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `externalId` | String | Yes | Yes | API provider's match ID |
| `sportId` | UUID | Yes | No | FK to Sport (denormalized) |
| `leagueId` | UUID | Yes | No | FK to League |
| `homeTeamId` | UUID | Yes | No | FK to Team |
| `awayTeamId` | UUID | Yes | No | FK to Team |
| `startTime` | DateTime | Yes | No | Scheduled start (UTC) |
| `status` | Enum | Yes | No | SCHEDULED, LIVE, FINISHED, CANCELLED, POSTPONED |
| `homeScore` | Integer | No | No | Set when FINISHED |
| `awayScore` | Integer | No | No | Set when FINISHED |
| `result` | Enum | No | No | HOME_WIN, AWAY_WIN, DRAW. Set when FINISHED. |
| `currentOdds` | JSON | No | No | Latest odds snapshot. Replaces OddsSnapshot entity. |
| `lastFetchedAt` | DateTime | No | No | Last API fetch timestamp |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Removed fields:** winnerTeamId, isDraw, externalStatus, externalData.

**New fields:** `result` (replaces winnerTeamId + isDraw), `currentOdds` (replaces OddsSnapshot).

**Invariants:**
- `homeTeamId` != `awayTeamId`.
- `result` is set only when status is FINISHED.
- `externalId` is unique.

**Deletion:** Never deleted.

---

### 9. Analysis

**Why it exists:** Stores AI analysis results for a match.

**Ownership:** Owned by Match (N:1).

**References:** `matchId` (FK to Match). Referenced by: Prediction (1:N)

**Lifecycle:** QUEUED → IN_PROGRESS → COMPLETED / FAILED

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `matchId` | UUID | Yes | No | FK to Match |
| `status` | Enum | Yes | No | QUEUED, IN_PROGRESS, COMPLETED, FAILED |
| `trigger` | Enum | Yes | No | SCHEDULED, ON_DEMAND, RE_ANALYSIS |
| `predictedWinner` | String | No | No | "home", "away", "draw". Null if FAILED. |
| `confidence` | Decimal | No | No | 0.0–1.0. Null if FAILED. |
| `reasoning` | Text | No | No | AI explanation. Null if FAILED. |
| `keyFactors` | String[] | No | No | Array of factors. Null if FAILED. |
| `recommendedMarket` | Enum | No | No | h2h, spread, total. Null if FAILED. |
| `valueAssessment` | Enum | No | No | HIGH, MEDIUM, LOW, NONE. Null if FAILED. |
| `oddsUsed` | JSON | No | No | The odds values used for this analysis (replaces oddsSnapshotId) |
| `tokensUsed` | Integer | No | No | Token count for cost tracking |
| `costUsd` | Decimal | No | No | Estimated cost in USD |
| `errorMessage` | Text | No | No | Error details if FAILED |
| `completedAt` | DateTime | No | No | When analysis completed or failed |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Removed fields:** promptUsed, rawResponse, latencyMs, oddsSnapshotId.

**New fields:** `oddsUsed` (JSON — stores the odds values used, no FK to deleted OddsSnapshot).

**Invariants:**
- `confidence` between 0.0 and 1.0. Set only when COMPLETED.
- On AI failure, a minimal Analysis record is created with status=FAILED (so Prediction.analysisId is never null).

**Deletion:** Never deleted.

---

### 10. Prediction

**Why it exists:** The core business entity. A betting recommendation. Now global (not per-user) — one prediction per match/market/outcome. User bankroll impact is tracked via the `userId` field on the prediction itself.

**Ownership:** Global (system-owned). A prediction is generated once and visible to all users. Each user's bankroll is affected independently when they "take" a prediction.

**References:** `matchId` (FK to Match), `analysisId` (FK to Analysis, required). Referenced by: nothing (BankrollTransaction removed).

**Lifecycle:** PENDING → PLACED → SETTLED → VOIDED

**Key design decision:** Prediction is NOT per-user. It is a global recommendation. When a prediction is generated, it exists once. All 5 users see the same recommendation. Each user's bankroll is updated independently when the prediction settles. The `userId` on Prediction is removed — bankroll impact is computed by the system applying the prediction's stake/odds to each user's bankroll.

**Wait — reconsideration:** For a 5-user private server, do we even need per-user bankroll? The friends want to track their own performance. Yes, we do. But the prediction itself is shared. The bankroll impact is computed per user.

**Revised approach:** Prediction is global. A separate `UserPrediction` join record tracks per-user stake and outcome. But that adds complexity again.

**Simplest approach for 5 friends:** Prediction IS per-user. Each user gets their own copy. This is simpler to implement (no join table) and the data volume is negligible (5 users × ~50 predictions/day = 250 records/day = ~7,500/month = trivial).

**Final decision:** Keep Prediction per-user. The data volume is irrelevant for 5 users, and it's the simplest implementation.

**Ownership:** Owned by User (N:1).

**References:** `userId` (FK to User), `matchId` (FK to Match), `analysisId` (FK to Analysis, required).

**Lifecycle:** PENDING → PLACED → SETTLED → VOIDED

**Fields:**

| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| `id` | UUID | Yes | Yes | Primary identifier |
| `userId` | UUID | Yes | No | FK to User |
| `matchId` | UUID | Yes | No | FK to Match |
| `analysisId` | UUID | Yes | No | FK to Analysis. Required (create minimal Analysis on AI failure). |
| `status` | Enum | Yes | No | PENDING, PLACED, SETTLED, VOIDED |
| `market` | Enum | Yes | No | h2h, spread, total |
| `predictedOutcome` | String | Yes | No | E.g., "home", "away", "over_2.5" |
| `oddsAtPlacement` | Decimal | Yes | No | Decimal odds when placed |
| `bookmaker` | String | Yes | No | Bookmaker name |
| `stake` | Decimal | Yes | No | Stake in bankroll units |
| `confidence` | Decimal | Yes | No | AI confidence at placement |
| `expectedValue` | Decimal | Yes | No | Calculated EV. Must be positive. |
| `valueAssessment` | Enum | Yes | No | HIGH, MEDIUM, LOW, NONE |
| `result` | Enum | No | No | WON, LOST, PUSH, VOID. Set when SETTLED. |
| `pnl` | Decimal | No | No | Profit/loss. Set when SETTLED. |
| `roi` | Decimal | No | No | Return on investment. Set when SETTLED. |
| `closingOdds` | Decimal | No | No | Closing line odds. Optional. |
| `wasCorrect` | Boolean | No | No | True if WON, false if LOST, null if PUSH/VOID |
| `settledAt` | DateTime | No | No | When prediction was settled |
| `voidReason` | String | No | No | Reason if VOIDED |
| `createdAt` | DateTime | Yes | No | Row creation timestamp |
| `updatedAt` | DateTime | Yes | No | Row update timestamp |

**Fields absorbed from PredictionOutcome:** result, pnl, roi, closingOdds, wasCorrect, settledAt.

**Removed fields:** settlementStatus, archivedAt.

**Invariants:**
- `confidence` ≥ 0.60.
- `oddsAtPlacement` ≥ 1.50.
- `stake` ≤ 5% of user's bankroll at placement.
- `expectedValue` must be positive.
- `analysisId` is required (never null — create minimal Analysis on AI failure).
- `matchId` + `userId` + `market` + `predictedOutcome` must be unique for PLACED predictions.

**Deletion:** Never deleted.

---

## Revised Relationship Map

```
┌─────────────────────────────────────────────────────────────┐
│                     REVISED RELATIONSHIP MAP (V1.1)         │
│                                                             │
│  ┌──────────┐     ┌──────────────────┐     ┌──────────┐    │
│  │  User    │1──1│ UserPreferences  │     │  Sport   │    │
│  │          │1──1│ Bankroll         │     │          │    │
│  │          │1──N│ Prediction       │     └────┬─────┘    │
│  └──────────┘     └──────────────────┘          │1         │
│                                            ┌────┴─────┐   │
│  ┌──────────────┐     ┌──────────────┐     │  League  │   │
│  │  Prediction  │N──1│ Match         │     └────┬─────┘   │
│  │              │N──1│ Analysis      │          │1         │
│  └──────────────┘     └──────┬───────┘     ┌────┴─────┐   │
│                              │             │  Team    │   │
│                              │1            │(owned by │   │
│                         ┌────┴────┐        │  Sport)  │   │
│                         │ Analysis│        └────┬─────┘   │
│                         │(match-  │             │N        │
│                         │ owned)  │        ┌────┴─────┐   │
│                         └─────────┘        │TeamLeague│   │
│                                            │(join)    │   │
│                                            └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Relationship Summary (Revised)

| From | To | Type | Description |
|---|---|---|---|
| User | UserPreferences | 1:1 | Each user has one preferences record |
| User | Bankroll | 1:1 | Each user has one bankroll (per currency) |
| User | Prediction | 1:N | Each user has many predictions |
| Sport | League | 1:N | Each sport has many leagues |
| Sport | Team | 1:N | Each sport has many teams |
| Team | TeamLeague | N:1 | Each team can be in many leagues |
| League | TeamLeague | N:1 | Each league has many teams |
| League | Match | 1:N | Each league has many matches |
| Match | Team | N:1 | Each match has one home and one away team |
| Match | Analysis | 1:N | Each match has many analyses |
| Match | Prediction | 1:N | Each match has many predictions |
| Analysis | Prediction | 1:N | Each analysis generates many predictions |

---

## Aggregate Boundaries (Revised)

### Aggregate 1: User (Root: User)
**Contains:** User, UserPreferences, Bankroll
**Rationale:** Created together. Bankroll updates must be consistent with user state.

### Aggregate 2: Match (Root: Match)
**Contains:** Match (standalone)
**Rationale:** Match data is self-contained. Odds are stored as JSON on Match.

### Aggregate 3: Analysis (Root: Analysis)
**Contains:** Analysis (standalone)
**Rationale:** Created independently. Referenced by Predictions.

### Aggregate 4: Prediction (Root: Prediction)
**Contains:** Prediction (standalone)
**Rationale:** Prediction now contains all outcome fields. Bankroll is updated separately.

### Aggregate 5: Sport Hierarchy (Root: Sport)
**Contains:** Sport, League, Team, TeamLeague
**Rationale:** Reference data loaded together for match creation.

---

## Business Invariants (Revised)

| # | Invariant | Enforcement |
|---|---|---|
| 1 | A User cannot have more than 10 predictions in PLACED status | Checked before creating PLACED prediction |
| 2 | A Prediction's `stake` cannot exceed 5% of Bankroll `currentBalance` | Checked before creating PLACED prediction |
| 3 | A Prediction's `confidence` must be ≥ user's `minConfidenceThreshold` | Checked before creating PLACED prediction |
| 4 | A Prediction's `oddsAtPlacement` must be ≥ user's `minOddsThreshold` | Checked before creating PLACED prediction |
| 5 | A Prediction's `expectedValue` must be positive | Checked before creating PLACED prediction |
| 6 | Bankroll `currentBalance` must never be negative | Checked on every bankroll operation |
| 7 | A Match's `homeTeamId` must not equal `awayTeamId` | Checked on match creation |
| 8 | A Match's `result` is set only when status is FINISHED | Checked on match status change |
| 9 | `matchId` + `userId` + `market` + `predictedOutcome` unique for PLACED predictions | Application-level check |

### State Transition Invariants (Revised)

| Entity | Valid Transitions |
|---|---|
| User | CREATED → ACTIVE (one-way) |
| Bankroll | ACTIVE only (reset creates new record) |
| Match | SCHEDULED → LIVE → FINISHED; SCHEDULED → CANCELLED; SCHEDULED → POSTPONED |
| Prediction | PENDING → PLACED → SETTLED; PLACED → VOIDED |
| Analysis | QUEUED → IN_PROGRESS → COMPLETED; IN_PROGRESS → FAILED |
| Sport | ACTIVE → DEPRECATED (one-way) |

---

## Deletion Rules (Revised)

### Never Deleted
- Match
- Analysis
- Prediction
- Bankroll
- User

### Soft-Deleted (Status Change)
- Sport → DEPRECATED
- League → DEPRECATED
- Team → DEPRECATED

### Cascade-Deleted
- UserPreferences → when User is deleted
- TeamLeague → when Team or League is deleted

---

## Historical Data Retention (Revised)

| Data | Retention | Action |
|---|---|---|
| Matches | Indefinite | Never deleted |
| Analyses | Indefinite | Never deleted |
| Predictions | Indefinite | Never deleted |
| Bankrolls | Indefinite | Never deleted |
| Users | Indefinite | Never deleted |

**Note:** With 5 users and ~50 predictions/day, total data volume is ~7,500 records/month. No archival strategy is needed for years.

---

*End of V1 Domain Model (Revised)*


