# Betting Intelligence Discord Platform — V1 Prisma Schema Specification

> **Status:** Specification Document  
> **Version:** 1.0  
> **Last Updated:** 2026-06-05  
> **Source of Truth:** FINAL-V1-DATA-MODEL.md  
> **Next Step:** Generate `schema.prisma` from this specification

---

## Table of Contents

1. [Naming Conventions](#1-naming-conventions)
2. [UUID Strategy](#2-uuid-strategy)
3. [Timestamp Conventions](#3-timestamp-conventions)
4. [Soft Delete Strategy](#4-soft-delete-strategy)
5. [Relation Naming Conventions](#5-relation-naming-conventions)
6. [Prisma Enums](#6-prisma-enums)
7. [Model: User](#7-model-user)
8. [Model: UserPreferences](#8-model-userpreferences)
9. [Model: Bankroll](#9-model-bankroll)
10. [Model: Sport](#10-model-sport)
11. [Model: League](#11-model-league)
12. [Model: Team](#12-model-team)
13. [Model: TeamLeague](#13-model-teamleague)
14. [Model: Match](#14-model-match)
15. [Model: OddsSnapshot](#15-model-oddssnapshot)
16. [Model: Analysis](#16-model-analysis)
17. [Model: Prediction](#17-model-prediction)
18. [Index Summary](#18-index-summary)
19. [Relation Summary](#19-relation-summary)
20. [Schema Generation Order](#20-schema-generation-order)

---

## 1. Naming Conventions

| Convention | Rule | Example |
|---|---|---|
| **Model names** | PascalCase, singular | `User`, `OddsSnapshot`, `UserPreferences` |
| **Field names** | camelCase | `discordId`, `startTime`, `currentBalance` |
| **Enum names** | PascalCase | `MatchStatus`, `PredictionStatus` |
| **Enum values** | UPPER_SNAKE_CASE | `SCHEDULED`, `HOME_WIN`, `HIGH` |
| **Relation fields** | camelCase, singular or plural | `user`, `predictions`, `oddsSnapshots` |
| **Foreign key fields** | camelCase, `{relatedModel}Id` | `userId`, `matchId`, `analysisId` |
| **Composite index names** | Not specified (Prisma auto-generates) | — |
| **Unique constraint names** | Not specified (Prisma auto-generates) | — |

### Model Name to Table Name Mapping

Prisma by default pluralizes model names for table names. This is acceptable. The following explicit `@@map` values should be used to ensure consistency:

| Model Name | `@@map` Value |
|---|---|
| `User` | `users` |
| `UserPreferences` | `user_preferences` |
| `Bankroll` | `bankrolls` |
| `Sport` | `sports` |
| `League` | `leagues` |
| `Team` | `teams` |
| `TeamLeague` | `team_leagues` |
| `Match` | `matches` |
| `OddsSnapshot` | `odds_snapshots` |
| `Analysis` | `analyses` |
| `Prediction` | `predictions` |

### Field Name to Column Name Mapping

All field names use `@map` to map camelCase to snake_case column names. Every field must have an explicit `@map` value.

Example:
```prisma
discordId    String   @map("discord_id")
startTime    DateTime @map("start_time")
currentBalance Decimal @map("current_balance")
```

The `id`, `createdAt`, and `updatedAt` fields also use `@map`:
```prisma
id         String   @id @default(uuid()) @map("id")
createdAt  DateTime @default(now()) @map("created_at")
updatedAt  DateTime @updatedAt @map("updated_at")
```

---

## 2. UUID Strategy

| Property | Value |
|---|---|
| **Type** | `String` |
| **Default** | `@default(uuid())` |
| **Generation** | Prisma's `uuid()` function (UUID v4) |
| **Storage** | `CHAR(36)` in PostgreSQL (Prisma default for String UUID) |
| **@id annotation** | `@id @default(uuid())` on every model |

Every model uses the same pattern:
```prisma
id  String  @id @default(uuid()) @map("id")
```

No models use composite primary keys. All primary keys are single-field UUIDs.

---

## 3. Timestamp Conventions

| Convention | Rule |
|---|---|
| **Type** | `DateTime` |
| **Timezone** | Always UTC. Prisma's `DateTime` maps to `TIMESTAMPTZ` in PostgreSQL. |
| **createdAt** | `@default(now())` — set once on creation, never updated |
| **updatedAt** | `@updatedAt` — automatically updated by Prisma on every write |
| **Nullable timestamps** | Used for optional temporal data (e.g., `settledAt`, `completedAt`, `lastFetchedAt`) |

### Timestamp field definitions

**Required timestamps (every model):**
```prisma
createdAt  DateTime  @default(now()) @map("created_at")
updatedAt  DateTime  @updatedAt @map("updated_at")
```

**Exception:** `OddsSnapshot` has NO `updatedAt` (rows are immutable). It uses `capturedAt` instead of `createdAt`.

**Exception:** `TeamLeague` has NO `updatedAt` (join table, no updates).

**Nullable timestamps (specific models):**
- `Match.lastFetchedAt` — `DateTime?` @map("last_fetched_at")
- `Analysis.completedAt` — `DateTime?` @map("completed_at")
- `Prediction.settledAt` — `DateTime?` @map("settled_at")

**Non-standard timestamps:**
- `User.firstSeenAt` — `DateTime` @map("first_seen_at") — required, set on creation
- `User.lastActiveAt` — `DateTime` @map("last_active_at") — required, updated on interaction
- `OddsSnapshot.capturedAt` — `DateTime` @map("captured_at") — required, replaces createdAt

---

## 4. Soft Delete Strategy

**There is no soft delete in V1.**

Business entities (Match, Analysis, Prediction, Bankroll, User) are never deleted. Reference entities (Sport, League, Team) use status-based deprecation instead of deletion.

| Entity | Strategy |
|---|---|
| `User` | Never deleted. Status field: `CREATED` → `ACTIVE`. |
| `UserPreferences` | Cascade-deleted with User (hard delete). |
| `Bankroll` | Never deleted. Reset creates new record. |
| `Sport` | Status-based deprecation: `ACTIVE` → `DEPRECATED`. |
| `League` | Status-based deprecation: `ACTIVE` → `DEPRECATED`. |
| `Team` | Status-based deprecation: `ACTIVE` → `DEPRECATED`. |
| `TeamLeague` | Cascade-deleted with Team or League (hard delete). |
| `Match` | Never deleted. |
| `OddsSnapshot` | Never deleted (append-only). |
| `Analysis` | Never deleted. |
| `Prediction` | Never deleted. |

**No `deletedAt` or `isDeleted` fields exist on any model.**

---

## 5. Relation Naming Conventions

| Convention | Rule | Example |
|---|---|---|
| **Required relation** | Field name matches related model (singular) | `user User @relation(...)` |
| **Optional relation** | Field name matches related model (singular, nullable) | Not used in V1 (all FKs are required) |
| **One-to-many (child side)** | Field name matches parent model (singular) | `match Match @relation(...)` |
| **One-to-many (parent side)** | Field name matches child model (plural) | `predictions Prediction[]` |
| **One-to-one** | Field name matches related model (singular) | `userPreferences UserPreferences?` |
| **Join table** | Two relation fields, one for each parent | `team Team @relation(...)`, `league League @relation(...)` |
| **Self-referencing** | Not used in V1 | — |

### Relation field naming rules

1. The foreign key field is named `{relatedModel}Id` (e.g., `userId`, `matchId`).
2. The relation field is named the same as the related model in camelCase (e.g., `user`, `match`).
3. The reverse relation field (on the parent) is named the plural of the child model in camelCase (e.g., `predictions`, `analyses`).
4. Every relation must have an explicit `@relation` annotation with a named foreign key reference.
5. Every `@relation` must specify `fields` and `references`.

### Relation annotation pattern

```prisma
// Child side (FK holder)
userId      String    @map("user_id")
user        User      @relation(fields: [userId], references: [id])

// Parent side (reverse)
predictions Prediction[]
```

### `@relation` naming

Use the format `{ParentModel}{ChildModel}` for the relation name on the parent side. This is optional in Prisma but recommended for clarity.

```prisma
// On User model:
predictions  Prediction[]  @relation("UserPredictions")

// On Prediction model:
user  User  @relation("UserPredictions", fields: [userId], references: [id])
```

---

## 6. Prisma Enums

### 6.1 `UserStatus`

| Value | Description |
|---|---|
| `CREATED` | User record created, first interaction |
| `ACTIVE` | User has interacted with the bot |

**Used by:** `User.status`

### 6.2 `CurrencyCode`

| Value | Description |
|---|---|
| `HUF` | Hungarian Forint |
| `EUR` | Euro |

**Used by:** `Bankroll.currency`

### 6.3 `BankrollStatus`

| Value | Description |
|---|---|
| `ACTIVE` | Bankroll is active and accepting stake deductions |

**Used by:** `Bankroll.status`

### 6.4 `SportCategory`

| Value | Description |
|---|---|
| `TRADITIONAL` | Traditional sports (soccer, NBA, NHL, NFL, tennis, MMA) |
| `ESPORTS` | Esports (CS2, Valorant, LoL, Dota 2) |

**Used by:** `Sport.category`

### 6.5 `SportStatus`

| Value | Description |
|---|---|
| `ACTIVE` | Sport is actively tracked |
| `DEPRECATED` | Sport is no longer tracked |

**Used by:** `Sport.status`

### 6.6 `ApiSource`

| Value | Description |
|---|---|
| `THE_ODDS_API` | Data sourced from The Odds API |
| `PANDASCORE` | Data sourced from PandaScore API |

**Used by:** `Sport.externalApiSource`

### 6.7 `LeagueStatus`

| Value | Description |
|---|---|
| `ACTIVE` | League is active |

**Used by:** `League.status`

### 6.8 `TeamStatus`

| Value | Description |
|---|---|
| `ACTIVE` | Team is active |

**Used by:** `Team.status`

### 6.9 `TeamLeagueStatus`

| Value | Description |
|---|---|
| `ACTIVE` | Team-league association is active |

**Used by:** `TeamLeague.status`

### 6.10 `MatchStatus`

| Value | Description |
|---|---|
| `SCHEDULED` | Match is scheduled, not yet started |
| `LIVE` | Match is in progress |
| `FINISHED` | Match has concluded |
| `CANCELLED` | Match was cancelled |
| `POSTPONED` | Match was postponed |

**Used by:** `Match.status`

### 6.11 `MatchResult`

| Value | Description |
|---|---|
| `HOME_WIN` | Home team won |
| `AWAY_WIN` | Away team won |
| `DRAW` | Match ended in a draw |

**Used by:** `Match.result`

### 6.12 `OddsMarket`

| Value | Description |
|---|---|
| `H2H` | Head-to-head (moneyline) |
| `SPREADS` | Point spreads |
| `TOTALS` | Over/under |

**Used by:** `OddsSnapshot.market`, `Analysis.recommendedMarket`, `Prediction.market`

### 6.13 `AnalysisStatus`

| Value | Description |
|---|---|
| `QUEUED` | Analysis is queued for processing |
| `IN_PROGRESS` | Analysis is being processed by AI |
| `COMPLETED` | Analysis completed successfully |
| `FAILED` | Analysis failed |

**Used by:** `Analysis.status`

### 6.14 `AnalysisTrigger`

| Value | Description |
|---|---|
| `SCHEDULED` | Triggered by scheduled job |
| `ON_DEMAND` | Triggered by user command |
| `RE_ANALYSIS` | Triggered by significant odds movement |

**Used by:** `Analysis.trigger`

### 6.15 `ValueLevel`

| Value | Description |
|---|---|
| `HIGH` | High value opportunity |
| `MEDIUM` | Medium value opportunity |
| `LOW` | Low value opportunity |
| `NONE` | No value identified |

**Used by:** `Analysis.valueAssessment`, `Prediction.valueAssessment`

### 6.16 `PredictionStatus`

| Value | Description |
|---|---|
| `PENDING` | Draft recommendation, not yet placed |
| `PLACED` | Active recommendation, awaiting settlement |
| `SETTLED` | Outcome determined |
| `VOIDED` | Prediction invalidated |

**Used by:** `Prediction.status`

### 6.17 `PredictionResult`

| Value | Description |
|---|---|
| `WON` | Prediction was correct |
| `LOST` | Prediction was incorrect |
| `PUSH` | Tie/refund |
| `VOID` | Match cancelled or bet voided |

**Used by:** `Prediction.result`

---

## 7. Model: User

### 7.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `discordId` | `String` | Yes | — | `discord_id` | Discord snowflake. Max length: 32. |
| `discordUsername` | `String` | Yes | — | `discord_username` | Current Discord username. Max length: 64. |
| `status` | `UserStatus` | Yes | `CREATED` | `status` | |
| `firstSeenAt` | `DateTime` | Yes | — | `first_seen_at` | Set on first interaction |
| `lastActiveAt` | `DateTime` | Yes | — | `last_active_at` | Updated on every interaction |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |
| `updatedAt` | `DateTime` | Yes | `updatedAt` | `updated_at` | |

### 7.2 Unique Constraints

| Constraint | Fields |
|---|---|
| `@unique` | `discordId` |

### 7.3 Indexes

| Index | Fields | Type |
|---|---|---|
| — | `status` | BTREE (implicit via query pattern) |

### 7.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `userPreferences` | `UserPreferences` | One-to-one (optional) | `UserUserPreferences` |
| `bankroll` | `Bankroll` | One-to-one (optional) | `UserBankroll` |
| `predictions` | `Prediction[]` | One-to-many | `UserPredictions` |

### 7.5 Notes

- `discordId` is immutable after creation.
- `firstSeenAt` is set once and never updated.
- `lastActiveAt` is updated on every Discord interaction (command, button click, etc.).

---

## 8. Model: UserPreferences

### 8.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `userId` | `String` | Yes | — | `user_id` | Foreign key to User |
| `defaultStakePercent` | `Decimal` | Yes | `1.00` | `default_stake_percent` | Precision: 4, scale: 2. Range: 0.50–5.00 |
| `minConfidenceThreshold` | `Decimal` | Yes | `0.60` | `min_confidence_threshold` | Precision: 3, scale: 2. Range: 0.00–1.00 |
| `minOddsThreshold` | `Decimal` | Yes | `1.50` | `min_odds_threshold` | Precision: 6, scale: 2 |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |
| `updatedAt` | `DateTime` | Yes | `updatedAt` | `updated_at` | |

### 8.2 Unique Constraints

| Constraint | Fields |
|---|---|
| `@unique` | `userId` |

### 8.3 Indexes

None beyond the unique constraint on `userId`.

### 8.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `user` | `User` | One-to-one (required) | `UserUserPreferences` |

### 8.5 Notes

- One-to-one with User. Created atomically with User.
- Cascade-deleted when User is deleted.
- `defaultStakePercent` is a percentage (e.g., 1.00 = 1% of bankroll).

---

## 9. Model: Bankroll

### 9.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `userId` | `String` | Yes | — | `user_id` | Foreign key to User |
| `currency` | `CurrencyCode` | Yes | `HUF` | `currency` | |
| `startingBalance` | `Decimal` | Yes | — | `starting_balance` | Precision: 12, scale: 2. Immutable after creation. |
| `currentBalance` | `Decimal` | Yes | — | `current_balance` | Precision: 12, scale: 2. Updated on settlement. |
| `status` | `BankrollStatus` | Yes | `ACTIVE` | `status` | |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |
| `updatedAt` | `DateTime` | Yes | `updatedAt` | `updated_at` | |

### 9.2 Unique Constraints

| Constraint | Fields |
|---|---|
| `@unique` | `userId` |

### 9.3 Indexes

None beyond the unique constraint on `userId`.

### 9.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `user` | `User` | One-to-one (required) | `UserBankroll` |

### 9.5 Notes

- One-to-one with User. Created atomically with User.
- `startingBalance` is immutable. When a bankroll is reset, a new Bankroll record is created.
- `currentBalance` must never be negative (enforced at application layer).
- Default `startingBalance` is set at application level (recommended: 10,000).

---

## 10. Model: Sport

### 10.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `slug` | `String` | Yes | — | `slug` | Max length: 32. E.g., "soccer", "nba", "cs2" |
| `name` | `String` | Yes | — | `name` | Max length: 64. Display name. |
| `category` | `SportCategory` | Yes | — | `category` | |
| `status` | `SportStatus` | Yes | `ACTIVE` | `status` | |
| `externalApiSource` | `ApiSource` | Yes | — | `external_api_source` | |
| `externalSportKey` | `String` | Yes | — | `external_sport_key` | Max length: 64. API provider's identifier. |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |
| `updatedAt` | `DateTime` | Yes | `updatedAt` | `updated_at` | |

### 10.2 Unique Constraints

| Constraint | Fields |
|---|---|
| `@unique` | `slug` |

### 10.3 Indexes

None beyond the unique constraint on `slug`.

### 10.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `leagues` | `League[]` | One-to-many | `SportLeagues` |
| `teams` | `Team[]` | One-to-many | `SportTeams` |

### 10.5 Notes

- Seeded at deployment. Not created dynamically.
- `slug` is immutable.
- Soft-deprecated via `status = DEPRECATED`.

---

## 11. Model: League

### 11.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `sportId` | `String` | Yes | — | `sport_id` | Foreign key to Sport |
| `externalId` | `String` | Yes | — | `external_id` | Max length: 64. API provider's identifier. |
| `name` | `String` | Yes | — | `name` | Max length: 128. Display name. |
| `slug` | `String` | Yes | — | `slug` | Max length: 64. URL-safe identifier. |
| `status` | `LeagueStatus` | Yes | `ACTIVE` | `status` | |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |
| `updatedAt` | `DateTime` | Yes | `updatedAt` | `updated_at` | |

### 11.2 Unique Constraints

| Constraint | Fields |
|---|---|
| `@@unique` | `[sportId, externalId]` |

### 11.3 Indexes

| Index | Fields | Type |
|---|---|---|
| — | `sportId` | BTREE (FK lookup) |

### 11.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `sport` | `Sport` | Many-to-one (required) | `SportLeagues` |
| `teamLeagues` | `TeamLeague[]` | One-to-many | `LeagueTeamLeagues` |
| `matches` | `Match[]` | One-to-many | `LeagueMatches` |

### 11.5 Notes

- `externalId` is unique per sport (not globally).
- Soft-deprecated via `status = DEPRECATED`.

---

## 12. Model: Team

### 12.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `sportId` | `String` | Yes | — | `sport_id` | Foreign key to Sport |
| `externalId` | `String` | Yes | — | `external_id` | Max length: 64. API provider's identifier. |
| `name` | `String` | Yes | — | `name` | Max length: 128. Display name. |
| `slug` | `String` | Yes | — | `slug` | Max length: 64. URL-safe identifier. |
| `status` | `TeamStatus` | Yes | `ACTIVE` | `status` | |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |
| `updatedAt` | `DateTime` | Yes | `updatedAt` | `updated_at` | |

### 12.2 Unique Constraints

| Constraint | Fields |
|---|---|
| `@@unique` | `[sportId, externalId]` |

### 12.3 Indexes

| Index | Fields | Type |
|---|---|---|
| — | `sportId` | BTREE (FK lookup) |

### 12.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `sport` | `Sport` | Many-to-one (required) | `SportTeams` |
| `teamLeagues` | `TeamLeague[]` | One-to-many | `TeamTeamLeagues` |
| `homeMatches` | `Match[]` | One-to-many | `TeamHomeMatches` |
| `awayMatches` | `Match[]` | One-to-many | `TeamAwayMatches` |

### 12.5 Notes

- Owned by Sport (not League). Enables multi-league participation.
- `externalId` is unique per sport (not globally).
- Soft-deprecated via `status = DEPRECATED`.
- Has two one-to-many relations to Match (home and away). Both are optional (a team may have zero matches).

---

## 13. Model: TeamLeague

### 13.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `teamId` | `String` | Yes | — | `team_id` | Foreign key to Team |
| `leagueId` | `String` | Yes | — | `league_id` | Foreign key to League |
| `status` | `TeamLeagueStatus` | Yes | `ACTIVE` | `status` | |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |

### 13.2 Unique Constraints

| Constraint | Fields |
|---|---|
| `@@unique` | `[teamId, leagueId]` |

### 13.3 Indexes

| Index | Fields | Type |
|---|---|---|
| — | `teamId` | BTREE (FK lookup) |
| — | `leagueId` | BTREE (FK lookup) |

### 13.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `team` | `Team` | Many-to-one (required) | `TeamTeamLeagues` |
| `league` | `League` | Many-to-one (required) | `LeagueTeamLeagues` |

### 13.5 Notes

- Join table for Team-to-League many-to-many relationship.
- No `updatedAt` field (join table, no updates).
- Cascade-deleted when Team or League is deleted.

---

## 14. Model: Match

### 14.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `externalId` | `String` | Yes | — | `external_id` | Max length: 64. API provider's match ID. |
| `sportId` | `String` | Yes | — | `sport_id` | Foreign key to Sport (denormalized) |
| `leagueId` | `String` | Yes | — | `league_id` | Foreign key to League |
| `homeTeamId` | `String` | Yes | — | `home_team_id` | Foreign key to Team |
| `awayTeamId` | `String` | Yes | — | `away_team_id` | Foreign key to Team |
| `startTime` | `DateTime` | Yes | — | `start_time` | Scheduled start (UTC) |
| `status` | `MatchStatus` | Yes | `SCHEDULED` | `status` | |
| `homeScore` | `Int?` | No | — | `home_score` | Nullable. Set when FINISHED. |
| `awayScore` | `Int?` | No | — | `away_score` | Nullable. Set when FINISHED. |
| `result` | `MatchResult?` | No | — | `result` | Nullable. Set when FINISHED. |
| `lastFetchedAt` | `DateTime?` | No | — | `last_fetched_at` | Nullable. Last API fetch timestamp. |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |
| `updatedAt` | `DateTime` | Yes | `updatedAt` | `updated_at` | |

### 14.2 Unique Constraints

| Constraint | Fields |
|---|---|
| `@unique` | `externalId` |

### 14.3 Indexes

| Index | Fields | Type |
|---|---|---|
| — | `sportId` | BTREE (FK lookup) |
| — | `leagueId` | BTREE (FK lookup) |
| — | `homeTeamId` | BTREE (FK lookup) |
| — | `awayTeamId` | BTREE (FK lookup) |
| `@@index` | `[startTime, status]` | BTREE (find upcoming matches) |
| `@@index` | `[status]` | BTREE (find finished matches for settlement) |

### 14.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `sport` | `Sport` | Many-to-one (required) | `SportMatches` |
| `league` | `League` | Many-to-one (required) | `LeagueMatches` |
| `homeTeam` | `Team` | Many-to-one (required) | `TeamHomeMatches` |
| `awayTeam` | `Team` | Many-to-one (required) | `TeamAwayMatches` |
| `oddsSnapshots` | `OddsSnapshot[]` | One-to-many | `MatchOddsSnapshots` |
| `analyses` | `Analysis[]` | One-to-many | `MatchAnalyses` |
| `predictions` | `Prediction[]` | One-to-many | `MatchPredictions` |

### 14.5 Notes

- Central entity. Most referenced model.
- `sportId` is denormalized (derivable from League) to avoid joins on frequent queries.
- `homeTeamId` and `awayTeamId` reference the same model (Team) via two different relation fields.
- `homeScore` and `awayScore` use `Int` (not `SmallInt`). Prisma does not natively support `SmallInt` — use `Int` and let Prisma map to `INTEGER`. If `SMALLINT` is desired, use `@db.SmallInt` from `@prisma/client` extensions.

---

## 15. Model: OddsSnapshot

### 15.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `matchId` | `String` | Yes | — | `match_id` | Foreign key to Match |
| `bookmaker` | `String` | Yes | — | `bookmaker` | Max length: 64. Bookmaker name. |
| `market` | `OddsMarket` | Yes | — | `market` | |
| `outcome` | `String` | Yes | — | `outcome` | Max length: 32. E.g., "home", "away", "over_2.5" |
| `price` | `Decimal` | Yes | — | `price` | Precision: 8, scale: 2. Decimal odds. ≥ 1.01. |
| `isMain` | `Boolean` | Yes | `false` | `is_main` | True if primary/opening line |
| `isLive` | `Boolean` | Yes | `false` | `is_live` | True if captured during live play |
| `capturedAt` | `DateTime` | Yes | — | `captured_at` | When this snapshot was captured |

### 15.2 Unique Constraints

None. Multiple snapshots at the same second are allowed.

### 15.3 Indexes

| Index | Fields | Type |
|---|---|---|
| — | `matchId` | BTREE (FK lookup) |
| `@@index` | `[matchId, capturedAt]` | BTREE (time-range queries for a match) |
| `@@index` | `[capturedAt]` | BTREE (potential cleanup queries) |

### 15.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `match` | `Match` | Many-to-one (required) | `MatchOddsSnapshots` |

### 15.5 Notes

- **No `updatedAt` field.** Rows are immutable after creation.
- **No `createdAt` field.** Use `capturedAt` instead.
- Append-only. No UPDATE operations. No DELETE operations (in V1).
- One row per bookmaker per market per outcome per fetch.
- `price` is Decimal odds format (e.g., 2.50 means you win 2.50× your stake).

---

## 16. Model: Analysis

### 16.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `matchId` | `String` | Yes | — | `match_id` | Foreign key to Match |
| `status` | `AnalysisStatus` | Yes | `QUEUED` | `status` | |
| `trigger` | `AnalysisTrigger` | Yes | — | `trigger` | |
| `predictedWinner` | `String?` | No | — | `predicted_winner` | Nullable. "home", "away", "draw". Null if FAILED. |
| `confidence` | `Decimal?` | No | — | `confidence` | Precision: 3, scale: 2. 0.00–1.00. Null if FAILED. |
| `reasoning` | `String?` | No | — | `reasoning` | Nullable. AI explanation text. |
| `keyFactors` | `String[]` | No | — | `key_factors` | Nullable. Array of factor strings. |
| `recommendedMarket` | `OddsMarket?` | No | — | `recommended_market` | Nullable. Null if FAILED. |
| `valueAssessment` | `ValueLevel?` | No | — | `value_assessment` | Nullable. Null if FAILED. |
| `oddsUsed` | `Json?` | No | — | `odds_used` | Nullable. JSON of odds values used for analysis. |
| `tokensUsed` | `Int?` | No | — | `tokens_used` | Nullable. Token count for cost tracking. |
| `costUsd` | `Decimal?` | No | — | `cost_usd` | Precision: 8, scale: 6. Nullable. Estimated cost in USD. |
| `errorMessage` | `String?` | No | — | `error_message` | Nullable. Error details if FAILED. |
| `completedAt` | `DateTime?` | No | — | `completed_at` | Nullable. When analysis completed or failed. |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |
| `updatedAt` | `DateTime` | Yes | `updatedAt` | `updated_at` | |

### 16.2 Unique Constraints

None.

### 16.3 Indexes

| Index | Fields | Type |
|---|---|---|
| — | `matchId` | BTREE (FK lookup) |
| `@@index` | `[matchId, status]` | BTREE (find completed analyses for a match) |
| `@@index` | `[status]` | BTREE (find queued analyses for processing) |

### 16.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `match` | `Match` | Many-to-one (required) | `MatchAnalyses` |
| `predictions` | `Prediction[]` | One-to-many | `AnalysisPredictions` |

### 16.5 Notes

- `analysisId` on Prediction is required (NOT NULL). On AI failure, a minimal Analysis record with status=FAILED is created so Prediction.analysisId is never null.
- `oddsUsed` stores the odds values that were fed into the AI prompt. This is a JSON snapshot, not a foreign key.
- `keyFactors` uses Prisma's `String[]` which maps to PostgreSQL `TEXT[]`.

---

## 17. Model: Prediction

### 17.1 Fields

| Field Name | Prisma Type | Required | Default | @map | Notes |
|---|---|---|---|---|---|
| `id` | `String` | Yes | `uuid()` | `id` | Primary key |
| `userId` | `String` | Yes | — | `user_id` | Foreign key to User |
| `matchId` | `String` | Yes | — | `match_id` | Foreign key to Match |
| `analysisId` | `String` | Yes | — | `analysis_id` | Foreign key to Analysis. Required. |
| `status` | `PredictionStatus` | Yes | `PENDING` | `status` | |
| `market` | `OddsMarket` | Yes | — | `market` | |
| `predictedOutcome` | `String` | Yes | — | `predicted_outcome` | Max length: 32. E.g., "home", "away", "over_2.5" |
| `oddsAtPlacement` | `Decimal` | Yes | — | `odds_at_placement` | Precision: 8, scale: 2. Decimal odds when placed. |
| `bookmaker` | `String` | Yes | — | `bookmaker` | Max length: 64. Bookmaker name. |
| `stake` | `Decimal` | Yes | — | `stake` | Precision: 12, scale: 2. Stake in bankroll units. |
| `confidence` | `Decimal` | Yes | — | `confidence` | Precision: 3, scale: 2. AI confidence at placement. |
| `expectedValue` | `Decimal` | Yes | — | `expected_value` | Precision: 6, scale: 2. Must be positive. |
| `valueAssessment` | `ValueLevel` | Yes | — | `value_assessment` | |
| `result` | `PredictionResult?` | No | — | `result` | Nullable. Set when SETTLED. |
| `pnl` | `Decimal?` | No | — | `pnl` | Precision: 12, scale: 2. Profit/loss. Set when SETTLED. |
| `roi` | `Decimal?` | No | — | `roi` | Precision: 6, scale: 2. Return on investment. Set when SETTLED. |
| `closingOdds` | `Decimal?` | No | — | `closing_odds` | Precision: 8, scale: 2. Closing line odds. Optional. |
| `wasCorrect` | `Boolean?` | No | — | `was_correct` | Nullable. True if WON, false if LOST, null if PUSH/VOID. |
| `settledAt` | `DateTime?` | No | — | `settled_at` | Nullable. When prediction was settled. |
| `voidReason` | `String?` | No | — | `void_reason` | Max length: 256. Nullable. Reason if VOIDED. |
| `createdAt` | `DateTime` | Yes | `now()` | `created_at` | |
| `updatedAt` | `DateTime` | Yes | `updatedAt` | `updated_at` | |

### 17.2 Unique Constraints

| Constraint | Fields | Notes |
|---|---|---|
| `@@unique` | `[userId, matchId, market, predictedOutcome]` | Prevents duplicate predictions for same user on same outcome. Enforced at application level for PLACED status only. |

### 17.3 Indexes

| Index | Fields | Type |
|---|---|---|
| — | `userId` | BTREE (FK lookup) |
| — | `matchId` | BTREE (FK lookup) |
| — | `analysisId` | BTREE (FK lookup) |
| `@@index` | `[userId, status]` | BTREE (user's active predictions) |
| `@@index` | `[matchId, status]` | BTREE (predictions for a specific match) |
| `@@index` | `[status]` | BTREE (find placed predictions for settlement) |
| `@@index` | `[createdAt]` | BTREE (time-range queries for analytics) |

### 17.4 Relations

| Relation Field | Model | Type | Relation Name |
|---|---|---|---|
| `user` | `User` | Many-to-one (required) | `UserPredictions` |
| `match` | `Match` | Many-to-one (required) | `MatchPredictions` |
| `analysis` | `Analysis` | Many-to-one (required) | `AnalysisPredictions` |

### 17.5 Notes

- Core business entity. Most queried model.
- `analysisId` is required (NOT NULL). On AI failure, a minimal Analysis record is created.
- `stake` is calculated based on user's bankroll and confidence at placement time.
- `pnl` is calculated as: if WON → `stake * (oddsAtPlacement - 1)`; if LOST → `-stake`; if PUSH → `0`; if VOID → `0`.
- `roi` is calculated as: `(pnl / stake) * 100`.
- `wasCorrect` is a convenience boolean for analytics queries. True if WON, false if LOST, null otherwise.

---

## 18. Index Summary

### 18.1 All Indexes by Model

| Model | Index Fields | Type | Purpose |
|---|---|---|---|
| **User** | `discordId` | UNIQUE | Lookup by Discord ID |
| **User** | `status` | BTREE | Filter active users |
| **UserPreferences** | `userId` | UNIQUE | One-to-one lookup |
| **Bankroll** | `userId` | UNIQUE | One-to-one lookup |
| **League** | `sportId` | BTREE | FK lookup |
| **League** | `[sportId, externalId]` | UNIQUE | Unique per sport |
| **Team** | `sportId` | BTREE | FK lookup |
| **Team** | `[sportId, externalId]` | UNIQUE | Unique per sport |
| **TeamLeague** | `teamId` | BTREE | FK lookup |
| **TeamLeague** | `leagueId` | BTREE | FK lookup |
| **TeamLeague** | `[teamId, leagueId]` | UNIQUE | One association per pair |
| **Match** | `externalId` | UNIQUE | Deduplication |
| **Match** | `sportId` | BTREE | FK lookup |
| **Match** | `leagueId` | BTREE | FK lookup |
| **Match** | `homeTeamId` | BTREE | FK lookup |
| **Match** | `awayTeamId` | BTREE | FK lookup |
| **Match** | `[startTime, status]` | BTREE | Find upcoming matches |
| **Match** | `[status]` | BTREE | Find finished matches |
| **OddsSnapshot** | `matchId` | BTREE | FK lookup |
| **OddsSnapshot** | `[matchId, capturedAt]` | BTREE | Time-range queries |
| **OddsSnapshot** | `[capturedAt]` | BTREE | Cleanup queries |
| **Analysis** | `matchId` | BTREE | FK lookup |
| **Analysis** | `[matchId, status]` | BTREE | Find completed analyses |
| **Analysis** | `[status]` | BTREE | Find queued analyses |
| **Prediction** | `userId` | BTREE | FK lookup |
| **Prediction** | `matchId` | BTREE | FK lookup |
| **Prediction** | `analysisId` | BTREE | FK lookup |
| **Prediction** | `[userId, status]` | BTREE | User's active predictions |
| **Prediction** | `[matchId, status]` | BTREE | Predictions for a match |
| **Prediction** | `[status]` | BTREE | Find placed predictions |
| **Prediction** | `[createdAt]` | BTREE | Analytics time-range |
| **Prediction** | `[userId, matchId, market, predictedOutcome]` | UNIQUE | No duplicate bets |

### 18.2 Total Index Count

| Type | Count |
|---|---|
| UNIQUE constraints (implicit indexes) | 9 |
| BTREE indexes (FK lookups) | 16 |
| BTREE indexes (query patterns) | 7 |
| **Total** | **32** |

---

## 19. Relation Summary

### 19.1 All Relations

| # | Parent | Child | Type | FK on | Relation Name |
|---|---|---|---|---|---|
| 1 | `User` | `UserPreferences` | 1:1 | `UserPreferences.userId` | `UserUserPreferences` |
| 2 | `User` | `Bankroll` | 1:1 | `Bankroll.userId` | `UserBankroll` |
| 3 | `User` | `Prediction` | 1:N | `Prediction.userId` | `UserPredictions` |
| 4 | `Sport` | `League` | 1:N | `League.sportId` | `SportLeagues` |
| 5 | `Sport` | `Team` | 1:N | `Team.sportId` | `SportTeams` |
| 6 | `Team` | `TeamLeague` | 1:N | `TeamLeague.teamId` | `TeamTeamLeagues` |
| 7 | `League` | `TeamLeague` | 1:N | `TeamLeague.leagueId` | `LeagueTeamLeagues` |
| 8 | `League` | `Match` | 1:N | `Match.leagueId` | `LeagueMatches` |
| 9 | `Team` | `Match` (home) | 1:N | `Match.homeTeamId` | `TeamHomeMatches` |
| 10 | `Team` | `Match` (away) | 1:N | `Match.awayTeamId` | `TeamAwayMatches` |
| 11 | `Match` | `OddsSnapshot` | 1:N | `OddsSnapshot.matchId` | `MatchOddsSnapshots` |
| 12 | `Match` | `Analysis` | 1:N | `Analysis.matchId` | `MatchAnalyses` |
| 13 | `Match` | `Prediction` | 1:N | `Prediction.matchId` | `MatchPredictions` |
| 14 | `Analysis` | `Prediction` | 1:N | `Prediction.analysisId` | `AnalysisPredictions` |

### 19.2 Relation Count by Model

| Model | Relations (FK side) | Relations (reverse) | Total |
|---|---|---|---|
| `User` | 0 | 3 | 3 |
| `UserPreferences` | 1 | 0 | 1 |
| `Bankroll` | 1 | 0 | 1 |
| `Sport` | 0 | 2 | 2 |
| `League` | 1 | 2 | 3 |
| `Team` | 1 | 3 | 4 |
| `TeamLeague` | 2 | 0 | 2 |
| `Match` | 4 | 3 | 7 |
| `OddsSnapshot` | 1 | 0 | 1 |
| `Analysis` | 1 | 1 | 2 |
| `Prediction` | 3 | 0 | 3 |

---

## 20. Schema Generation Order

When generating the Prisma schema, define models in this order to satisfy forward references:

1. **Enums** (all 17 enums — no dependencies)
2. **User** (no FK dependencies)
3. **UserPreferences** (depends on User)
4. **Bankroll** (depends on User)
5. **Sport** (no FK dependencies)
6. **League** (depends on Sport)
7. **Team** (depends on Sport)
8. **TeamLeague** (depends on Team, League)
9. **Match** (depends on Sport, League, Team)
10. **OddsSnapshot** (depends on Match)
11. **Analysis** (depends on Match)
12. **Prediction** (depends on User, Match, Analysis)

### Prisma schema file structure

```
schema.prisma
├── generator
├── datasource
├── enums (17)
├── models (11)
│   ├── User
│   ├── UserPreferences
│   ├── Bankroll
│   ├── Sport
│   ├── League
│   ├── Team
│   ├── TeamLeague
│   ├── Match
│   ├── OddsSnapshot
│   ├── Analysis
│   └── Prediction
```

### Generator block

```prisma
generator client {
  provider = "prisma-client-js"
}
```

### Datasource block

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

---

*End of V1 Prisma Schema Specification*

**This document is the specification for generating `schema.prisma`. No architectural decisions remain. Every field, type, constraint, index, relation, and enum is defined.**


