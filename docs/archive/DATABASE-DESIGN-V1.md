# Betting Intelligence Discord Platform — V1 Database Design Specification

> **Status:** Database Design Document  
> **Version:** 1.0  
> **Last Updated:** 2026-06-05  
> **Source of Truth:** ARCHITECTURE-V1.md, DOMAIN-MODEL-V1-REVISED.md

---

## Table of Contents

1. [OddsSnapshot Decision](#1-oddssnapshot-decision)
2. [Database Design Principles](#2-database-design-principles)
3. [Table Definitions](#3-table-definitions)
4. [Primary Keys](#4-primary-keys)
5. [Foreign Keys](#5-foreign-keys)
6. [Unique Constraints](#6-unique-constraints)
7. [Index Strategy](#7-index-strategy)
8. [Query Optimization Strategy](#8-query-optimization-strategy)
9. [Data Retention Strategy](#9-data-retention-strategy)
10. [Estimated Data Growth](#10-estimated-data-growth)
11. [PostgreSQL-Specific Recommendations](#11-postgresql-specific-recommendations)

---

## 1. OddsSnapshot Decision

### The Question

Should `OddsSnapshot` exist as a separate table, or should odds be stored inline on `Match` (as `currentOdds` JSON) and `Prediction` (as `oddsAtPlacement`)?

### Requirements

1. **Future odds movement analysis** — The system must support analyzing how odds changed over time for a match.
2. **Future line movement analysis** — The system must support detecting significant odds shifts.
3. **Historical odds preservation** — The system should preserve historical odds when practical.
4. **Simplicity** — The design must be simple enough for a 5-user private Discord server.

### Analysis

**Option A: No OddsSnapshot table (current design in DOMAIN-MODEL-V1-REVISED)**

Store `currentOdds` as a JSON column on `Match` (overwritten each fetch). Store `oddsAtPlacement` on `Prediction`.

- ✅ Simple. One less table. No cleanup jobs.
- ✅ Prediction always has the odds at time of placement.
- ❌ Cannot analyze odds movement over time. The `currentOdds` field only holds the latest snapshot.
- ❌ Cannot detect line movement patterns (opening → mid → closing).
- ❌ Cannot calculate closing line value (CLV) unless closing odds are manually captured at match end.
- ❌ If the developer wants to add odds movement analysis in the future, all historical data is lost.

**Option B: OddsSnapshot table**

Store each odds fetch as a row in `odds_snapshots`. Each row captures one bookmaker's price for one market/outcome at one point in time.

- ✅ Full historical odds data preserved.
- ✅ Enables line movement analysis (opening → mid → closing).
- ✅ Enables closing line value calculation.
- ✅ Enables future features like "best time to bet" analysis.
- ❌ More data. More storage. More complexity.
- ❌ Requires a cleanup strategy for old data.

### The Critical Question

**Will the developer ever want to analyze odds movement?**

Consider the platform's purpose: generate betting recommendations by analyzing matches with AI. A core part of evaluating recommendation quality is:

1. **Did we get good odds?** — Comparing our placed odds to the closing line tells us if we have edge.
2. **Did odds movement confirm our analysis?** — If odds moved in our direction after we bet, that's confirmation.
3. **Which bookmakers offer the best odds?** — Requires comparing bookmaker odds over time.

Without historical odds data, these questions cannot be answered. The developer would need to start collecting odds from scratch, losing all historical context.

### The Data Volume Reality

For a 5-user private server:

- ~10 sports tracked
- ~50 active matches at any time
- Odds fetched every 15 minutes per active match
- Each fetch: ~10 bookmakers × ~3 markets × ~2 outcomes = ~60 rows
- Per day: 50 matches × 96 fetches × 60 rows = ~288,000 rows/day

**That's too high.** 288,000 rows/day for 5 users is wasteful. The free tier of The Odds API allows only 500 requests/month. Even the paid tier is limited.

**Realistic fetch frequency:**
- The Odds API free tier: 500 requests/month ≈ 16 requests/day
- Each request returns odds for ALL bookmakers for ONE sport
- So: 16 requests/day ÷ 10 sports ≈ 1.6 fetches per sport per day

**Revised estimate:**
- 10 sports × 2 fetches/day = 20 API calls/day
- Each response: ~10 bookmakers × ~3 markets × ~2 outcomes = ~60 rows per sport
- Per day: 20 API calls × 60 rows = ~1,200 rows/day
- Per month: ~36,000 rows
- Per year: ~438,000 rows

**438,000 rows per year is trivial for PostgreSQL.** Even without cleanup, this is manageable for years.

### Decision

**OddsSnapshot SHOULD exist as a separate table.**

Rationale:

1. **Data volume is manageable.** ~36,000 rows/month is negligible for PostgreSQL. No cleanup needed for years.
2. **Future-proofing without complexity.** Adding OddsSnapshot now costs one table. Adding it later means losing all historical odds data.
3. **Enables core analytics.** Closing line value, odds movement confirmation, and bookmaker comparison are fundamental to evaluating prediction quality.
4. **Simple design.** The table is append-only. No updates. No complex lifecycle. Just insert on fetch, select for analysis.
5. **The revised domain model was too aggressive in removing it.** The original concern was about complexity, but an append-only table with no cleanup is the simplest possible data structure.

### OddsSnapshot Design (Revised)

- **Append-only.** No updates. No deletes (in V1).
- **No cleanup needed.** Data volume is low enough to keep indefinitely.
- **Indexed by matchId + capturedAt** for efficient time-range queries.
- **Stores one row per bookmaker per market per outcome per fetch.** This is the natural granularity from the API.
- **Prediction.oddsAtPlacement** is still stored on Prediction (denormalized for fast querying). The OddsSnapshot provides the historical context.

---

## 2. Database Design Principles

| # | Principle | Rationale |
|---|---|---|
| 1 | **Single PostgreSQL instance** | No replicas, no read replicas, no sharding. One database for everything. |
| 2 | **UUID primary keys** | Application-generated UUIDs enable safe ID generation without DB sequences. Avoids sequential ID guessing. |
| 3 | **Timestamps in UTC** | All `createdAt`/`updatedAt` fields store UTC timestamps. Application converts to local time for display. |
| 4 | **JSONB for flexible data** | Use JSONB columns for odds data, analysis metadata, and API responses. Avoids schema changes when API formats evolve. |
| 5 | **Enums for constrained values** | PostgreSQL enums for status fields, categories, and types. Provides type safety at the database level. |
| 6 | **Decimal for monetary values** | Use `DECIMAL(12,2)` for bankroll balances and stakes. Avoids floating-point rounding errors. |
| 7 | **Append-only for immutable data** | OddsSnapshots are insert-only. No updates. No deletes. |
| 8 | **Denormalize for read performance** | Store `sportId` on Match (even though derivable from League) to avoid joins on frequent queries. |
| 9 | **No cascade deletes on business data** | Business entities (Match, Prediction, Analysis) are never deleted. Only reference/lookup data may cascade. |
| 10 | **Index for every query pattern** | Every WHERE, JOIN, ORDER BY, and GROUP BY clause must be supported by an index. |

---

## 3. Table Definitions

### 3.1 `users`

Stores Discord user identity.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `discord_id` | VARCHAR(32) | Yes | Discord snowflake. Immutable. |
| `discord_username` | VARCHAR(64) | Yes | Current Discord username |
| `status` | user_status | Yes | Enum: `created`, `active` |
| `first_seen_at` | TIMESTAMPTZ | Yes | First interaction |
| `last_active_at` | TIMESTAMPTZ | Yes | Most recent interaction |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |
| `updated_at` | TIMESTAMPTZ | Yes | Row update |

### 3.2 `user_preferences`

Per-user staking configuration.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `user_id` | UUID | Yes | FK to `users` |
| `default_stake_percent` | DECIMAL(4,2) | Yes | 0.50–5.00. Default: 1.00 |
| `min_confidence_threshold` | DECIMAL(3,2) | Yes | 0.00–1.00. Default: 0.60 |
| `min_odds_threshold` | DECIMAL(6,2) | Yes | Default: 1.50 |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |
| `updated_at` | TIMESTAMPTZ | Yes | Row update |

### 3.3 `bankrolls`

Per-user virtual bankroll.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `user_id` | UUID | Yes | FK to `users` |
| `currency` | currency_code | Yes | Enum: `huf`, `eur` |
| `starting_balance` | DECIMAL(12,2) | Yes | Initial balance. Immutable. |
| `current_balance` | DECIMAL(12,2) | Yes | Current balance |
| `status` | bankroll_status | Yes | Enum: `active` |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |
| `updated_at` | TIMESTAMPTZ | Yes | Row update |

### 3.4 `sports`

Reference data. Seeded at deployment.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `slug` | VARCHAR(32) | Yes | Unique. E.g., "soccer", "nba", "cs2" |
| `name` | VARCHAR(64) | Yes | Display name |
| `category` | sport_category | Yes | Enum: `traditional`, `esports` |
| `status` | sport_status | Yes | Enum: `active`, `deprecated` |
| `external_api_source` | api_source | Yes | Enum: `the_odds_api`, `pandascore` |
| `external_sport_key` | VARCHAR(64) | Yes | API provider's identifier |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |
| `updated_at` | TIMESTAMPTZ | Yes | Row update |

### 3.5 `leagues`

Competitive divisions within a sport.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `sport_id` | UUID | Yes | FK to `sports` |
| `external_id` | VARCHAR(64) | Yes | API provider's identifier |
| `name` | VARCHAR(128) | Yes | Display name |
| `slug` | VARCHAR(64) | Yes | URL-safe identifier |
| `status` | league_status | Yes | Enum: `active` |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |
| `updated_at` | TIMESTAMPTZ | Yes | Row update |

### 3.6 `teams`

Competitive entities. Owned by Sport (not League) to support multi-league participation.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `sport_id` | UUID | Yes | FK to `sports` |
| `external_id` | VARCHAR(64) | Yes | API provider's identifier |
| `name` | VARCHAR(128) | Yes | Display name |
| `slug` | VARCHAR(64) | Yes | URL-safe identifier |
| `status` | team_status | Yes | Enum: `active` |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |
| `updated_at` | TIMESTAMPTZ | Yes | Row update |

### 3.7 `team_leagues`

Join table linking teams to leagues. Enables many-to-many relationship.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `team_id` | UUID | Yes | FK to `teams` |
| `league_id` | UUID | Yes | FK to `leagues` |
| `status` | team_league_status | Yes | Enum: `active` |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |

### 3.8 `matches`

Central entity. A competitive event between two teams.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `external_id` | VARCHAR(64) | Yes | API provider's match ID |
| `sport_id` | UUID | Yes | FK to `sports` (denormalized) |
| `league_id` | UUID | Yes | FK to `leagues` |
| `home_team_id` | UUID | Yes | FK to `teams` |
| `away_team_id` | UUID | Yes | FK to `teams` |
| `start_time` | TIMESTAMPTZ | Yes | Scheduled start (UTC) |
| `status` | match_status | Yes | Enum: `scheduled`, `live`, `finished`, `cancelled`, `postponed` |
| `home_score` | SMALLINT | No | Set when finished |
| `away_score` | SMALLINT | No | Set when finished |
| `result` | match_result | No | Enum: `home_win`, `away_win`, `draw`. Set when finished. |
| `last_fetched_at` | TIMESTAMPTZ | No | Last API fetch |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |
| `updated_at` | TIMESTAMPTZ | Yes | Row update |

### 3.9 `odds_snapshots`

Historical bookmaker odds for matches. Append-only.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `match_id` | UUID | Yes | FK to `matches` |
| `bookmaker` | VARCHAR(64) | Yes | Bookmaker name |
| `market` | odds_market | Yes | Enum: `h2h`, `spreads`, `totals` |
| `outcome` | VARCHAR(32) | Yes | E.g., "home", "away", "draw", "over_2.5" |
| `price` | DECIMAL(8,2) | Yes | Decimal odds. ≥ 1.01 |
| `is_main` | BOOLEAN | Yes | True if primary/opening line |
| `is_live` | BOOLEAN | Yes | True if captured during live play |
| `captured_at` | TIMESTAMPTZ | Yes | When this snapshot was captured |

**Design notes:**
- Append-only. No updates. No deletes (in V1).
- One row per bookmaker per market per outcome per fetch.
- `captured_at` precision: seconds. Multiple snapshots per second are allowed.
- No `external_data` JSON column — store raw API responses in application logs if needed.
- No `updated_at` — rows are immutable.

### 3.10 `analyses`

AI analysis results for a match.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `match_id` | UUID | Yes | FK to `matches` |
| `status` | analysis_status | Yes | Enum: `queued`, `in_progress`, `completed`, `failed` |
| `trigger` | analysis_trigger | Yes | Enum: `scheduled`, `on_demand`, `re_analysis` |
| `predicted_winner` | VARCHAR(16) | No | "home", "away", "draw". Null if failed. |
| `confidence` | DECIMAL(3,2) | No | 0.00–1.00. Null if failed. |
| `reasoning` | TEXT | No | AI explanation. Null if failed. |
| `key_factors` | TEXT[] | No | Array of factors. Null if failed. |
| `recommended_market` | odds_market | No | Enum. Null if failed. |
| `value_assessment` | value_level | No | Enum: `high`, `medium`, `low`, `none`. Null if failed. |
| `odds_used` | JSONB | No | Odds values used for this analysis |
| `tokens_used` | INTEGER | No | Token count for cost tracking |
| `cost_usd` | DECIMAL(8,6) | No | Estimated cost in USD |
| `error_message` | TEXT | No | Error details if failed |
| `completed_at` | TIMESTAMPTZ | No | When analysis completed or failed |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |
| `updated_at` | TIMESTAMPTZ | Yes | Row update |

### 3.11 `predictions`

Betting recommendations. Core business entity.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | UUID | Yes | Primary key |
| `user_id` | UUID | Yes | FK to `users` |
| `match_id` | UUID | Yes | FK to `matches` |
| `analysis_id` | UUID | Yes | FK to `analyses`. Required. |
| `status` | prediction_status | Yes | Enum: `pending`, `placed`, `settled`, `voided` |
| `market` | odds_market | Yes | Enum |
| `predicted_outcome` | VARCHAR(32) | Yes | E.g., "home", "away", "over_2.5" |
| `odds_at_placement` | DECIMAL(8,2) | Yes | Decimal odds when placed |
| `bookmaker` | VARCHAR(64) | Yes | Bookmaker name |
| `stake` | DECIMAL(12,2) | Yes | Stake in bankroll units |
| `confidence` | DECIMAL(3,2) | Yes | AI confidence at placement |
| `expected_value` | DECIMAL(6,2) | Yes | Calculated EV. Must be positive. |
| `value_assessment` | value_level | Yes | Enum |
| `result` | prediction_result | No | Enum: `won`, `lost`, `push`, `void`. Set when settled. |
| `pnl` | DECIMAL(12,2) | No | Profit/loss. Set when settled. |
| `roi` | DECIMAL(6,2) | No | Return on investment. Set when settled. |
| `closing_odds` | DECIMAL(8,2) | No | Closing line odds. Optional. |
| `was_correct` | BOOLEAN | No | True if won, false if lost, null if push/void |
| `settled_at` | TIMESTAMPTZ | No | When prediction was settled |
| `void_reason` | VARCHAR(256) | No | Reason if voided |
| `created_at` | TIMESTAMPTZ | Yes | Row creation |
| `updated_at` | TIMESTAMPTZ | Yes | Row update |

---

## 4. Primary Keys

All tables use UUID primary keys.

| Table | PK Column | Strategy |
|---|---|---|
| `users` | `id` | UUID v4 (application-generated) |
| `user_preferences` | `id` | UUID v4 |
| `bankrolls` | `id` | UUID v4 |
| `sports` | `id` | UUID v4 |
| `leagues` | `id` | UUID v4 |
| `teams` | `id` | UUID v4 |
| `team_leagues` | `id` | UUID v4 |
| `matches` | `id` | UUID v4 |
| `odds_snapshots` | `id` | UUID v4 |
| `analyses` | `id` | UUID v4 |
| `predictions` | `id` | UUID v4 |

**Rationale for UUIDs over serial/identity:**
- Application generates IDs, enabling safe ID usage before DB insert.
- No sequential ID guessing (minor security consideration).
- Consistent across all tables.
- UUID v4 has no ordering, which means B-tree index fragmentation. Acceptable for the data volume (~500K rows/year).

---

## 5. Foreign Keys

| Child Table | Column | Parent Table | Parent Column | Deletion Rule |
|---|---|---|---|---|
| `user_preferences` | `user_id` | `users` | `id` | CASCADE |
| `bankrolls` | `user_id` | `users` | `id` | RESTRICT |
| `leagues` | `sport_id` | `sports` | `id` | RESTRICT |
| `teams` | `sport_id` | `sports` | `id` | RESTRICT |
| `team_leagues` | `team_id` | `teams` | `id` | CASCADE |
| `team_leagues` | `league_id` | `leagues` | `id` | CASCADE |
| `matches` | `sport_id` | `sports` | `id` | RESTRICT |
| `matches` | `league_id` | `leagues` | `id` | RESTRICT |
| `matches` | `home_team_id` | `teams` | `id` | RESTRICT |
| `matches` | `away_team_id` | `teams` | `id` | RESTRICT |
| `odds_snapshots` | `match_id` | `matches` | `id` | RESTRICT |
| `analyses` | `match_id` | `matches` | `id` | RESTRICT |
| `predictions` | `user_id` | `users` | `id` | RESTRICT |
| `predictions` | `match_id` | `matches` | `id` | RESTRICT |
| `predictions` | `analysis_id` | `analyses` | `id` | RESTRICT |

**Deletion rule rationale:**
- **CASCADE:** Safe for dependent/join tables (user_preferences, team_leagues). These have no business meaning without their parent.
- **RESTRICT:** Safe for business entities. Prevents accidental deletion of referenced data. Since business entities are never deleted in practice, RESTRICT is a safety net.

---

## 6. Unique Constraints

| Table | Constraint | Columns | Rationale |
|---|---|---|---|
| `users` | `uq_users_discord_id` | `discord_id` | One user per Discord account |
| `user_preferences` | `uq_user_preferences_user_id` | `user_id` | One preferences record per user |
| `bankrolls` | `uq_bankrolls_user_id` | `user_id` | One bankroll per user (per currency — see note) |
| `sports` | `uq_sports_slug` | `slug` | Unique sport identifier |
| `leagues` | `uq_leagues_sport_id_external_id` | `sport_id`, `external_id` | Unique league per API provider per sport |
| `teams` | `uq_teams_sport_id_external_id` | `sport_id`, `external_id` | Unique team per API provider per sport |
| `team_leagues` | `uq_team_leagues_team_id_league_id` | `team_id`, `league_id` | A team appears once per league |
| `matches` | `uq_matches_external_id` | `external_id` | No duplicate match ingestion |
| `predictions` | `uq_predictions_user_match_outcome` | `user_id`, `match_id`, `market`, `predicted_outcome` | No duplicate bets on same outcome (only for PLACED status — enforced at application level) |

**Note on bankrolls unique constraint:** If a user can have both HUF and EUR bankrolls, the unique constraint should be `(user_id, currency)`. If a user has one bankroll with a primary currency, `(user_id)` is sufficient. V1 should start with `(user_id)` and add currency if needed.

**Note on odds_snapshots:** No unique constraint on `(match_id, bookmaker, market, outcome, captured_at)`. Multiple snapshots at the same second are allowed (API may return updates within the same second). Application-level deduplication is sufficient.

---

## 7. Index Strategy

### 7.1 Index Design Principles

- **Every foreign key gets an index.** PostgreSQL does not auto-index FKs. Without indexes, FK joins become sequential scans.
- **Every query pattern gets a composite index.** Single-column indexes are rarely sufficient.
- **Index for ORDER BY and GROUP BY.** Sorting and aggregation on non-indexed columns causes sequential scans.
- **Partial indexes for status filters.** Most queries filter by status (e.g., `WHERE status = 'placed'`). A partial index is smaller and faster.
- **No over-indexing.** Each index adds write overhead. For the data volume (~500K rows/year), 2–3 indexes per table is sufficient.

### 7.2 Index Definitions

#### `users`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_users_discord_id` | `discord_id` | UNIQUE | Lookup by Discord ID |
| `idx_users_status` | `status` | BTREE | Filter active users |

#### `user_preferences`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_user_preferences_user_id` | `user_id` | UNIQUE | Lookup by user (already PK, but FK needs index) |

#### `bankrolls`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_bankrolls_user_id` | `user_id` | UNIQUE | Lookup by user |

#### `leagues`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_leagues_sport_id` | `sport_id` | BTREE | FK lookup |
| `idx_leagues_slug` | `slug` | UNIQUE | Lookup by slug |

#### `teams`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_teams_sport_id` | `sport_id` | BTREE | FK lookup |
| `idx_teams_slug` | `slug` | UNIQUE | Lookup by slug |

#### `team_leagues`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_team_leagues_team_id` | `team_id` | BTREE | FK lookup |
| `idx_team_leagues_league_id` | `league_id` | BTREE | FK lookup |

#### `matches`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_matches_external_id` | `external_id` | UNIQUE | Deduplication |
| `idx_matches_sport_id` | `sport_id` | BTREE | FK lookup |
| `idx_matches_league_id` | `league_id` | BTREE | FK lookup |
| `idx_matches_start_time_status` | `start_time`, `status` | BTREE | Find upcoming matches. Query: `WHERE start_time > NOW() AND status = 'scheduled' ORDER BY start_time` |
| `idx_matches_status_finished` | `status` WHERE `status` = 'finished' | PARTIAL | Find finished matches for settlement. Query: `WHERE status = 'finished'` |

#### `odds_snapshots`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_odds_snapshots_match_id` | `match_id` | BTREE | FK lookup |
| `idx_odds_snapshots_match_captured` | `match_id`, `captured_at` | BTREE | Time-range queries for a match. Query: `WHERE match_id = ? AND captured_at BETWEEN ? AND ? ORDER BY captured_at` |
| `idx_odds_snapshots_captured_at` | `captured_at` | BTREE | Cleanup queries. Query: `WHERE captured_at < NOW() - INTERVAL '90 days'` |

#### `analyses`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_analyses_match_id` | `match_id` | BTREE | FK lookup |
| `idx_analyses_match_status` | `match_id`, `status` | BTREE | Find completed analyses for a match. Query: `WHERE match_id = ? AND status = 'completed'` |
| `idx_analyses_status_queued` | `status` WHERE `status` = 'queued' | PARTIAL | Find queued analyses for processing |

#### `predictions`
| Index | Columns | Type | Purpose |
|---|---|---|---|
| `idx_predictions_user_id` | `user_id` | BTREE | FK lookup |
| `idx_predictions_match_id` | `match_id` | BTREE | FK lookup |
| `idx_predictions_user_status` | `user_id`, `status` | BTREE | User's active predictions. Query: `WHERE user_id = ? AND status = 'placed'` |
| `idx_predictions_status_placed` | `status` WHERE `status` = 'placed' | PARTIAL | Find placed predictions for settlement. Query: `WHERE status = 'placed'` |
| `idx_predictions_match_status` | `match_id`, `status` | BTREE | Find predictions for a specific match. Query: `WHERE match_id = ? AND status = 'placed'` |
| `idx_predictions_created_at` | `created_at` | BTREE | Time-range queries for analytics |

---

## 8. Query Optimization Strategy

### 8.1 Critical Query Patterns

#### Q1: Find upcoming matches for analysis
```sql
-- Frequency: Every 60 minutes
-- Target: < 10ms
SELECT m.*, l.name as league_name, s.slug as sport_slug
FROM matches m
JOIN leagues l ON l.id = m.league_id
JOIN sports s ON s.id = m.sport_id
WHERE m.start_time BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
  AND m.status = 'scheduled'
ORDER BY m.start_time;
```
**Index:** `idx_matches_start_time_status` covers this exactly.

#### Q2: Find finished matches with placed predictions (settlement)
```sql
-- Frequency: Every 15 minutes
-- Target: < 10ms
SELECT DISTINCT m.id, m.home_score, m.away_score, m.result
FROM matches m
JOIN predictions p ON p.match_id = m.id
WHERE m.status = 'finished'
  AND p.status = 'placed';
```
**Index:** `idx_matches_status_finished` (partial) + `idx_predictions_match_status`.

#### Q3: Get latest odds for a match
```sql
-- Frequency: On demand (user command)
-- Target: < 5ms
SELECT os.bookmaker, os.market, os.outcome, os.price
FROM odds_snapshots os
WHERE os.match_id = ?
  AND os.captured_at = (
    SELECT MAX(os2.captured_at)
    FROM odds_snapshots os2
    WHERE os2.match_id = ?
  );
```
**Index:** `idx_odds_snapshots_match_captured` covers this. The subquery uses the same index.

#### Q4: Get odds movement for a match over time
```sql
-- Frequency: On demand (analysis)
-- Target: < 20ms
SELECT os.bookmaker, os.market, os.outcome, os.price, os.captured_at
FROM odds_snapshots os
WHERE os.match_id = ?
ORDER BY os.captured_at, os.bookmaker, os.market, os.outcome;
```
**Index:** `idx_odds_snapshots_match_captured` covers this.

#### Q5: User's active predictions
```sql
-- Frequency: On demand (user command)
-- Target: < 5ms
SELECT p.*, m.home_team_id, m.away_team_id, m.start_time, m.status as match_status
FROM predictions p
JOIN matches m ON m.id = p.match_id
WHERE p.user_id = ?
  AND p.status = 'placed'
ORDER BY m.start_time;
```
**Index:** `idx_predictions_user_status` covers the filter. Join on `match_id` uses `matches` PK.

#### Q6: User's prediction history with analytics
```sql
-- Frequency: On demand (user command)
-- Target: < 20ms
SELECT p.*, m.home_team_id, m.away_team_id, m.start_time, m.result as match_result
FROM predictions p
JOIN matches m ON m.id = p.match_id
WHERE p.user_id = ?
  AND p.status IN ('settled', 'voided')
ORDER BY p.settled_at DESC
LIMIT 50;
```
**Index:** `idx_predictions_user_status` covers the filter. `ORDER BY p.settled_at` requires a sort (no index on `settled_at`). For 5 users with ~500 settled predictions each, an in-memory sort is acceptable.

#### Q7: Aggregate analytics by sport
```sql
-- Frequency: On demand (user command or daily summary)
-- Target: < 50ms
SELECT s.slug,
       COUNT(*) as total_bets,
       SUM(CASE WHEN p.result = 'won' THEN 1 ELSE 0 END) as wins,
       SUM(CASE WHEN p.result = 'lost' THEN 1 ELSE 0 END) as losses,
       SUM(p.pnl) as total_pnl,
       AVG(p.roi) as avg_roi
FROM predictions p
JOIN matches m ON m.id = p.match_id
JOIN sports s ON s.id = m.sport_id
WHERE p.user_id = ?
  AND p.status = 'settled'
GROUP BY s.slug;
```
**Index:** `idx_predictions_user_status` covers the filter. The GROUP BY and JOINs are on indexed columns. For 5 users, this query will be fast even without a covering index.

### 8.2 Optimization Notes

- **No covering indexes needed.** Data volume is low enough that index-only scans are not necessary.
- **No materialized views.** Analytics queries run on-demand. Response time < 100ms is acceptable for a Discord bot.
- **No query caching.** PostgreSQL's shared buffer cache handles repeated queries efficiently at this scale.
- **Connection pooling via Prisma.** Prisma manages a connection pool. Default pool size of 10 is sufficient for a single-process app.

---

## 9. Data Retention Strategy

### 9.1 Retention Rules

| Table | Retention | Action | Rationale |
|---|---|---|---|
| `odds_snapshots` | Indefinite (V1) | None | ~438K rows/year. No cleanup needed for years. |
| `predictions` | Indefinite | None | Core business data. Never deleted. |
| `analyses` | Indefinite | None | Audit trail. Never deleted. |
| `matches` | Indefinite | None | Central entity. Never deleted. |
| `users` | Indefinite | None | Minimal data. Never deleted. |
| `bankrolls` | Indefinite | None | Financial history. Never deleted. |
| `user_preferences` | Indefinite | None | Cascade-deleted with user. |
| `sports` | Indefinite | None | Reference data. Never deleted. |
| `leagues` | Indefinite | None | Reference data. Never deleted. |
| `teams` | Indefinite | None | Reference data. Never deleted. |
| `team_leagues` | Indefinite | None | Reference data. Never deleted. |

### 9.2 Why No Cleanup in V1

- **Data volume is negligible.** ~500K rows/year across all tables. PostgreSQL handles millions of rows per table without performance degradation.
- **No PII concerns.** No personal data beyond Discord usernames. No regulatory requirements.
- **Simplicity.** A cleanup job is code to write, test, and maintain. Not worth it for V1.

### 9.3 Future Cleanup (V2 Consideration)

If `odds_snapshots` grows beyond expectations, add a cleanup job that deletes snapshots older than 90 days. This is a simple `DELETE FROM odds_snapshots WHERE captured_at < NOW() - INTERVAL '90 days'` query. No archival strategy needed.

---

## 10. Estimated Data Growth

### 10.1 Row Count Estimates

| Table | Rows/Month | Rows/Year | 5-Year Total | Notes |
|---|---|---|---|---|
| `users` | 0 | 0 | 5 | Fixed at 5 users |
| `user_preferences` | 0 | 0 | 5 | One per user |
| `bankrolls` | 0 | 0 | ~25 | 5 users × ~5 resets/year |
| `sports` | 0 | 0 | ~15 | Seeded once |
| `leagues` | 0 | 0 | ~100 | Seeded once |
| `teams` | 0 | 0 | ~500 | Seeded once |
| `team_leagues` | 0 | 0 | ~600 | ~500 teams × 1.2 leagues avg |
| `matches` | ~1,500 | ~18,000 | ~90,000 | ~50 matches/day × 30 days |
| `odds_snapshots` | ~36,000 | ~438,000 | ~2,190,000 | 20 API calls/day × 60 rows |
| `analyses` | ~1,500 | ~18,000 | ~90,000 | ~1 per match |
| `predictions` | ~750 | ~9,000 | ~45,000 | ~50% of matches generate a prediction × 5 users |

### 10.2 Storage Estimates

| Component | Estimate | Notes |
|---|---|---|
| Total rows after 1 year | ~484,000 | Across all tables |
| Total rows after 5 years | ~2,420,000 | |
| Database size (1 year) | ~200–400 MB | Includes indexes |
| Database size (5 years) | ~1–2 GB | |
| WAL (Write-Ahead Log) | ~1–2 GB | Temporary, recycled |
| Total PostgreSQL footprint | ~3–5 GB | Comfortable for any modern machine |

### 10.3 Growth Implications

- **No partitioning needed.** PostgreSQL handles multi-GB databases without partitioning.
- **No archival needed.** 2.4M rows after 5 years is trivial.
- **No read replicas needed.** A single instance handles all reads and writes.
- **Backup size:** ~1–2 GB. Full backups take seconds. Daily backups are practical.

---

## 11. PostgreSQL-Specific Recommendations

### 11.1 Version

**Use PostgreSQL 16 or later.**

Rationale:
- Improved query parallelism for analytics queries.
- Better JSONB performance.
- `pg_stat_statements` included by default for query monitoring.
- Longer support window.

### 11.2 Configuration

| Setting | Recommended Value | Rationale |
|---|---|---|
| `shared_buffers` | 25% of RAM (e.g., 1 GB on 4 GB machine) | Caches frequently accessed data |
| `effective_cache_size` | 75% of RAM (e.g., 3 GB on 4 GB machine) | Helps query planner estimate cache |
| `work_mem` | 16–32 MB | Per-operation sort memory. 5 users = low concurrency. |
| `maintenance_work_mem` | 256 MB | For `VACUUM` and `CREATE INDEX` |
| `wal_level` | `replica` | Enables point-in-time recovery |
| `max_connections` | 20 | Prisma pool (10) + admin connections (2) + margin |
| `random_page_cost` | 1.1 (if SSD) | SSDs have near-zero seek time. Default 4.0 is for HDD. |
| `effective_io_concurrency` | 200 (if SSD) | SSDs handle concurrent I/O efficiently |
| `timezone` | `UTC` | All timestamps in UTC |

### 11.3 Extensions

| Extension | Purpose | Notes |
|---|---|---|
| `pgcrypto` | `gen_random_uuid()` for UUID generation | Included in PostgreSQL core |
| `pg_stat_statements` | Query performance monitoring | Track slow queries |

No other extensions needed in V1.

### 11.4 Enum Types

Define the following PostgreSQL enums:

```sql
CREATE TYPE user_status AS ENUM ('created', 'active');
CREATE TYPE currency_code AS ENUM ('huf', 'eur');
CREATE TYPE bankroll_status AS ENUM ('active');
CREATE TYPE sport_category AS ENUM ('traditional', 'esports');
CREATE TYPE sport_status AS ENUM ('active', 'deprecated');
CREATE TYPE api_source AS ENUM ('the_odds_api', 'pandascore');
CREATE TYPE league_status AS ENUM ('active');
CREATE TYPE team_status AS ENUM ('active');
CREATE TYPE team_league_status AS ENUM ('active');
CREATE TYPE match_status AS ENUM ('scheduled', 'live', 'finished', 'cancelled', 'postponed');
CREATE TYPE match_result AS ENUM ('home_win', 'away_win', 'draw');
CREATE TYPE odds_market AS ENUM ('h2h', 'spreads', 'totals');
CREATE TYPE analysis_status AS ENUM ('queued', 'in_progress', 'completed', 'failed');
CREATE TYPE analysis_trigger AS ENUM ('scheduled', 'on_demand', 're_analysis');
CREATE TYPE value_level AS ENUM ('high', 'medium', 'low', 'none');
CREATE TYPE prediction_status AS ENUM ('pending', 'placed', 'settled', 'voided');
CREATE TYPE prediction_result AS ENUM ('won', 'lost', 'push', 'void');
```

**Rationale for enums over check constraints:**
- Prisma maps PostgreSQL enums to TypeScript enums natively.
- Enums are reusable across tables (e.g., `odds_market` used in `odds_snapshots`, `analyses`, `predictions`).
- Enums are stored as 4 bytes internally (efficient).
- Adding values to an enum requires `ALTER TYPE ... ADD VALUE` (no table rewrite).

### 11.5 Naming Conventions

| Convention | Rule | Example |
|---|---|---|
| Table names | snake_case, plural | `odds_snapshots`, `user_preferences` |
| Column names | snake_case | `discord_id`, `start_time` |
| Primary keys | `id` | Always `id` |
| Foreign keys | `{referenced_table_singular}_id` | `match_id`, `user_id` |
| Unique constraints | `uq_{table}_{columns}` | `uq_users_discord_id` |
| Indexes | `idx_{table}_{columns}` | `idx_matches_start_time_status` |
| Enums | snake_case | `match_status`, `odds_market` |

### 11.6 Migration Strategy

- **Prisma Migrate** for schema migrations.
- Migrations are SQL files generated by Prisma, reviewed by the developer, then applied.
- Each migration is a single transaction. If it fails, the database rolls back.
- Naming: `YYYYMMDDHHMMSS_description.sql` (Prisma default).

**V1 migration order:**
1. Create enums
2. Create `users`
3. Create `user_preferences`
4. Create `bankrolls`
5. Create `sports`
6. Create `leagues`
7. Create `teams`
8. Create `team_leagues`
9. Create `matches`
10. Create `odds_snapshots`
11. Create `analyses`
12. Create `predictions`
13. Create indexes

### 11.7 Backup Strategy

| Backup Type | Frequency | Retention | Method |
|---|---|---|---|
| Full database | Daily | 7 days | `pg_dump` |
| WAL archiving | Continuous | 7 days | `archive_command` or `pg_receivewal` |

**Restore time:** ~1–2 minutes for a 2 GB database.

**Backup command:**
```bash
pg_dump -Fc -h localhost -U betting_user betting_db > /backups/betting_$(date +%Y%m%d).dump
```

### 11.8 Monitoring

- **`pg_stat_statements`** — Identify slow queries during development.
- **Application-level logging** — Log query errors and slow queries (>100ms) via Prisma middleware.
- **No external monitoring tools** in V1. The developer checks logs manually.

### 11.9 Security

| Practice | Implementation |
|---|---|
| **Dedicated database user** | `betting_user` with access only to `betting_db` |
| **Connection via local socket** | No network exposure. Bind to `127.0.0.1`. |
| **No superuser in application** | Application connects with limited privileges (CRUD on all tables, no schema changes) |
| **SSL not required** | Local connection only. No network encryption needed. |
| **Password in environment variable** | `DATABASE_URL` in `.env` file. Not committed to version control. |

---

*End of V1 Database Design Specification*


