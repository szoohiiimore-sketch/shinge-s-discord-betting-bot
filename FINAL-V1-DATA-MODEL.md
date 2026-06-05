# Betting Intelligence Discord Platform — Final V1 Data Model Decision Document

> **Status:** FINAL — Source of Truth  
> **Version:** 1.0  
> **Last Updated:** 2026-06-05  
> **Supersedes:** DOMAIN-MODEL-V1.md, DOMAIN-MODEL-V1-REVISED.md, DATABASE-DESIGN-V1.md  
> **Next Step:** Prisma schema design

---

## Core Design Decision

**The platform generates betting recommendations only.**

Bankroll is a virtual recommendation-performance tracker. When a prediction settles, bankroll is updated *as if* the user followed the recommendation. There is no real betting activity, no real money, no bookmaker integration, no user wager tracking.

This decision eliminates:
- UserBet entities
- Bet transaction entities
- Deposit/withdrawal tracking
- Bookmaker account linking
- Real-money concerns entirely

---

## 1. Final Entity List

**11 entities. No more. No less.**

| # | Entity | Category | Persisted | Notes |
|---|---|---|---|---|
| 1 | `User` | Identity | Yes | Discord user |
| 2 | `UserPreferences` | Configuration | Yes | Per-user staking config |
| 3 | `Bankroll` | Performance | Yes | Virtual recommendation tracker |
| 4 | `Sport` | Reference | Yes | Seeded at deployment |
| 5 | `League` | Reference | Yes | Competitive division |
| 6 | `Team` | Reference | Yes | Competitive entity |
| 7 | `TeamLeague` | Reference | Yes | Team-to-League join |
| 8 | `Match` | Core | Yes | Competitive event |
| 9 | `OddsSnapshot` | Core | Yes | Historical odds (see §8) |
| 10 | `Analysis` | Core | Yes | AI analysis result |
| 11 | `Prediction` | Core | Yes | Betting recommendation |

---

## 2. Final Ownership Model

| Entity | Owned By | Cardinality | Rationale |
|---|---|---|---|
| `User` | Self | — | Created on first Discord interaction |
| `UserPreferences` | `User` | 1:1 | One config per user |
| `Bankroll` | `User` | 1:1 | One performance tracker per user |
| `Sport` | System | — | Seeded at deployment |
| `League` | `Sport` | N:1 | A sport has many leagues |
| `Team` | `Sport` | N:1 | A sport has many teams. NOT owned by League. |
| `TeamLeague` | `Team` + `League` | N:N join | Enables multi-league esports teams |
| `Match` | `League` | N:1 | A league has many matches |
| `OddsSnapshot` | `Match` | N:1 | A match has many odds snapshots |
| `Analysis` | `Match` | N:1 | A match has many analyses |
| `Prediction` | `User` | N:1 | Each user gets their own copy of each recommendation |

### Key Ownership Decisions

**Prediction is per-user (User-owned).**

Rationale: Each of the 5 friends has their own bankroll and their own performance tracking. A global Prediction with a join table (UserPrediction) adds complexity for zero benefit at this scale. Per-user Prediction means each user's stake, P&L, and ROI are stored directly on the Prediction record. Data volume: 5 users × ~10 predictions/day = ~50 rows/day = ~1,500/month. Trivial.

**Team is Sport-owned, not League-owned.**

Rationale: Esports organizations (T1, Cloud9, Fnatic) compete in multiple leagues simultaneously. A Team cannot belong to exactly one League. TeamLeague join table handles the many-to-many relationship.

**OddsSnapshot is Match-owned.**

Rationale: Append-only historical odds data. One table, no updates, no deletes. Essential for closing line value analysis and odds movement tracking.

---

## 3. Final Relationship Map

```
┌──────────────────────────────────────────────────────────────────┐
│                    FINAL RELATIONSHIP MAP                        │
│                                                                  │
│  ┌──────────┐     ┌──────────────────┐     ┌──────────────┐     │
│  │  User    │1──1│ UserPreferences  │     │   Sport      │     │
│  │          │1──1│ Bankroll         │     │  (system)    │     │
│  │          │1──N│ Prediction       │     └──────┬───────┘     │
│  └──────────┘     └──────────────────┘          │1             │
│                                            ┌────┴──────┐       │
│  ┌──────────────┐     ┌──────────────┐     │  League   │       │
│  │  Prediction  │N──1│ Match         │     └────┬──────┘       │
│  │              │N──1│ Analysis      │          │1             │
│  └──────────────┘     └──────┬───────┘     ┌────┴──────┐       │
│                              │             │   Team    │       │
│                              │1            │(Sport-    │       │
│                         ┌────┴────┐        │  owned)   │       │
│                         │ Analysis│        └────┬──────┘       │
│                         │(match-  │             │N             │
│                         │ owned)  │        ┌────┴──────┐       │
│                         └─────────┘        │TeamLeague │       │
│                                             │(join)     │       │
│  ┌──────────────────┐                       └───────────┘       │
│  │  OddsSnapshot    │                                            │
│  │  (match-owned,   │                                            │
│  │   append-only)   │                                            │
│  └──────────────────┘                                            │
└──────────────────────────────────────────────────────────────────┘
```

### Relationship Summary

| From | To | Type | Description |
|---|---|---|---|
| User | UserPreferences | 1:1 | One config per user |
| User | Bankroll | 1:1 | One performance tracker per user |
| User | Prediction | 1:N | Each user has their own predictions |
| Sport | League | 1:N | A sport has many leagues |
| Sport | Team | 1:N | A sport has many teams |
| Team | TeamLeague | N:1 | A team can be in many leagues |
| League | TeamLeague | N:1 | A league has many teams |
| League | Match | 1:N | A league has many matches |
| Match | Team | N:1 | Each match has one home and one away team |
| Match | OddsSnapshot | 1:N | A match has many odds snapshots |
| Match | Analysis | 1:N | A match has many analyses |
| Match | Prediction | 1:N | A match has many predictions (across users) |
| Analysis | Prediction | 1:N | An analysis generates predictions for each user |

---

## 4. Final Aggregate Boundaries

| Aggregate | Root | Contains | Rationale |
|---|---|---|---|
| **User** | `User` | User, UserPreferences, Bankroll | Created atomically. Bankroll is a performance tracker tied to user identity. |
| **Match** | `Match` | Match, OddsSnapshot | Odds snapshots are append-only records of a match's odds history. |
| **Analysis** | `Analysis` | Analysis (standalone) | Created independently. Referenced by Predictions. |
| **Prediction** | `Prediction` | Prediction (standalone) | Self-contained. Contains all outcome fields. Bankroll is updated separately. |
| **Sport Hierarchy** | `Sport` | Sport, League, Team, TeamLeague | Reference data loaded together for match creation. |

**Note on Bankroll:** Bankroll is updated when a Prediction settles. This is a cross-aggregate operation (Prediction aggregate → User aggregate). This is acceptable. The update is: `Bankroll.currentBalance += Prediction.pnl`. If this fails, the Prediction is still settled (the bankroll update can be retried). Eventual consistency is acceptable here.

---

## 5. Final Business Invariants

| # | Invariant | Enforcement Point |
|---|---|---|
| 1 | A User cannot have more than 10 predictions in PLACED status | Application layer, before creating PLACED prediction |
| 2 | A Prediction's `stake` cannot exceed 5% of Bankroll `currentBalance` | Application layer, before creating PLACED prediction |
| 3 | A Prediction's `confidence` must be ≥ user's `minConfidenceThreshold` | Application layer, before creating PLACED prediction |
| 4 | A Prediction's `oddsAtPlacement` must be ≥ user's `minOddsThreshold` | Application layer, before creating PLACED prediction |
| 5 | A Prediction's `expectedValue` must be positive | Application layer, before creating PLACED prediction |
| 6 | Bankroll `currentBalance` must never be negative | Application layer, on every bankroll update |
| 7 | A Match's `homeTeamId` must not equal `awayTeamId` | Application layer, on match creation |
| 8 | A Match's `result` is set only when status is FINISHED | Application layer, on match status change |
| 9 | `matchId` + `userId` + `market` + `predictedOutcome` unique for PLACED predictions | Application layer + unique partial index |
| 10 | `analysisId` on Prediction must never be null | Database NOT NULL constraint |
| 11 | OddsSnapshot rows are immutable after creation | Application layer — no update/delete operations exposed |

### State Transitions

| Entity | Valid Transitions |
|---|---|
| User | CREATED → ACTIVE (one-way) |
| Bankroll | ACTIVE only (reset creates new record, old preserved) |
| Match | SCHEDULED → LIVE → FINISHED; SCHEDULED → CANCELLED; SCHEDULED → POSTPONED |
| Prediction | PENDING → PLACED → SETTLED; PLACED → VOIDED |
| Analysis | QUEUED → IN_PROGRESS → COMPLETED; IN_PROGRESS → FAILED |
| Sport | ACTIVE → DEPRECATED (one-way) |

---

## 6. Final PostgreSQL Entities

### 6.1 `users`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `discord_id` | VARCHAR(32) | NOT NULL, UNIQUE |
| `discord_username` | VARCHAR(64) | NOT NULL |
| `status` | user_status | NOT NULL, DEFAULT 'created' |
| `first_seen_at` | TIMESTAMPTZ | NOT NULL |
| `last_active_at` | TIMESTAMPTZ | NOT NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

### 6.2 `user_preferences`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `user_id` | UUID | NOT NULL, UNIQUE, FK → users.id |
| `default_stake_percent` | DECIMAL(4,2) | NOT NULL, DEFAULT 1.00 |
| `min_confidence_threshold` | DECIMAL(3,2) | NOT NULL, DEFAULT 0.60 |
| `min_odds_threshold` | DECIMAL(6,2) | NOT NULL, DEFAULT 1.50 |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

### 6.3 `bankrolls`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `user_id` | UUID | NOT NULL, UNIQUE, FK → users.id |
| `currency` | currency_code | NOT NULL, DEFAULT 'huf' |
| `starting_balance` | DECIMAL(12,2) | NOT NULL |
| `current_balance` | DECIMAL(12,2) | NOT NULL |
| `status` | bankroll_status | NOT NULL, DEFAULT 'active' |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

### 6.4 `sports`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `slug` | VARCHAR(32) | NOT NULL, UNIQUE |
| `name` | VARCHAR(64) | NOT NULL |
| `category` | sport_category | NOT NULL |
| `status` | sport_status | NOT NULL, DEFAULT 'active' |
| `external_api_source` | api_source | NOT NULL |
| `external_sport_key` | VARCHAR(64) | NOT NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

### 6.5 `leagues`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `sport_id` | UUID | NOT NULL, FK → sports.id |
| `external_id` | VARCHAR(64) | NOT NULL |
| `name` | VARCHAR(128) | NOT NULL |
| `slug` | VARCHAR(64) | NOT NULL |
| `status` | league_status | NOT NULL, DEFAULT 'active' |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

UNIQUE: `(sport_id, external_id)`

### 6.6 `teams`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `sport_id` | UUID | NOT NULL, FK → sports.id |
| `external_id` | VARCHAR(64) | NOT NULL |
| `name` | VARCHAR(128) | NOT NULL |
| `slug` | VARCHAR(64) | NOT NULL |
| `status` | team_status | NOT NULL, DEFAULT 'active' |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

UNIQUE: `(sport_id, external_id)`

### 6.7 `team_leagues`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `team_id` | UUID | NOT NULL, FK → teams.id |
| `league_id` | UUID | NOT NULL, FK → leagues.id |
| `status` | team_league_status | NOT NULL, DEFAULT 'active' |
| `created_at` | TIMESTAMPTZ | NOT NULL |

UNIQUE: `(team_id, league_id)`

### 6.8 `matches`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `external_id` | VARCHAR(64) | NOT NULL, UNIQUE |
| `sport_id` | UUID | NOT NULL, FK → sports.id |
| `league_id` | UUID | NOT NULL, FK → leagues.id |
| `home_team_id` | UUID | NOT NULL, FK → teams.id |
| `away_team_id` | UUID | NOT NULL, FK → teams.id |
| `start_time` | TIMESTAMPTZ | NOT NULL |
| `status` | match_status | NOT NULL, DEFAULT 'scheduled' |
| `home_score` | SMALLINT | NULLABLE |
| `away_score` | SMALLINT | NULLABLE |
| `result` | match_result | NULLABLE |
| `last_fetched_at` | TIMESTAMPTZ | NULLABLE |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

### 6.9 `odds_snapshots`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `match_id` | UUID | NOT NULL, FK → matches.id |
| `bookmaker` | VARCHAR(64) | NOT NULL |
| `market` | odds_market | NOT NULL |
| `outcome` | VARCHAR(32) | NOT NULL |
| `price` | DECIMAL(8,2) | NOT NULL |
| `is_main` | BOOLEAN | NOT NULL, DEFAULT false |
| `is_live` | BOOLEAN | NOT NULL, DEFAULT false |
| `captured_at` | TIMESTAMPTZ | NOT NULL |

**Design notes:**
- Append-only. No UPDATE. No DELETE (in V1).
- No `updated_at` column — rows are immutable.
- No unique constraint on `(match_id, bookmaker, market, outcome, captured_at)`. Multiple snapshots at the same second are allowed.

### 6.10 `analyses`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `match_id` | UUID | NOT NULL, FK → matches.id |
| `status` | analysis_status | NOT NULL, DEFAULT 'queued' |
| `trigger` | analysis_trigger | NOT NULL |
| `predicted_winner` | VARCHAR(16) | NULLABLE |
| `confidence` | DECIMAL(3,2) | NULLABLE |
| `reasoning` | TEXT | NULLABLE |
| `key_factors` | TEXT[] | NULLABLE |
| `recommended_market` | odds_market | NULLABLE |
| `value_assessment` | value_level | NULLABLE |
| `odds_used` | JSONB | NULLABLE |
| `tokens_used` | INTEGER | NULLABLE |
| `cost_usd` | DECIMAL(8,6) | NULLABLE |
| `error_message` | TEXT | NULLABLE |
| `completed_at` | TIMESTAMPTZ | NULLABLE |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

### 6.11 `predictions`

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK |
| `user_id` | UUID | NOT NULL, FK → users.id |
| `match_id` | UUID | NOT NULL, FK → matches.id |
| `analysis_id` | UUID | NOT NULL, FK → analyses.id |
| `status` | prediction_status | NOT NULL, DEFAULT 'pending' |
| `market` | odds_market | NOT NULL |
| `predicted_outcome` | VARCHAR(32) | NOT NULL |
| `odds_at_placement` | DECIMAL(8,2) | NOT NULL |
| `bookmaker` | VARCHAR(64) | NOT NULL |
| `stake` | DECIMAL(12,2) | NOT NULL |
| `confidence` | DECIMAL(3,2) | NOT NULL |
| `expected_value` | DECIMAL(6,2) | NOT NULL |
| `value_assessment` | value_level | NOT NULL |
| `result` | prediction_result | NULLABLE |
| `pnl` | DECIMAL(12,2) | NULLABLE |
| `roi` | DECIMAL(6,2) | NULLABLE |
| `closing_odds` | DECIMAL(8,2) | NULLABLE |
| `was_correct` | BOOLEAN | NULLABLE |
| `settled_at` | TIMESTAMPTZ | NULLABLE |
| `void_reason` | VARCHAR(256) | NULLABLE |
| `created_at` | TIMESTAMPTZ | NOT NULL |
| `updated_at` | TIMESTAMPTZ | NOT NULL |

---

## 7. Entities Removed from V1

| Entity | Reason for Removal |
|---|---|
| `PredictionOutcome` | Merged into Prediction. All outcome fields (result, pnl, roi, closingOdds, wasCorrect, settledAt) now live directly on Prediction. |
| `BankrollTransaction` | Not needed. Bankroll is a recommendation-performance tracker, not a betting ledger. Prediction history provides the audit trail. |
| `LearningInsight` | Not needed in V1. Developer reviews analytics manually via prediction queries. |
| `Alert` | Not persisted. Alerts are sent directly to Discord channels. No DB storage needed. |

**Total entities removed: 4**

---

## 8. Final Recommendation Regarding OddsSnapshot

**OddsSnapshot EXISTS as a separate table.**

This reverses the decision in DOMAIN-MODEL-V1-REVISED.md (which removed it) and confirms the decision in DATABASE-DESIGN-V1.md (which restored it).

### Why It Exists

1. **Closing line value analysis requires historical odds.** Without knowing the closing odds for a match, you cannot determine if your placed odds had positive expected value. This is the single most important metric for evaluating recommendation quality.

2. **Odds movement analysis requires historical odds.** To detect line movement patterns, you need multiple data points over time. A single `currentOdds` JSON field on Match only holds the latest snapshot.

3. **Data volume is negligible.** ~36,000 rows/month at realistic API fetch rates. ~438,000 rows/year. PostgreSQL handles this without any cleanup.

4. **The table is maximally simple.** Append-only. No updates. No deletes. No lifecycle. No cleanup jobs. It is the simplest table in the entire schema.

5. **Prediction.oddsAtPlacement is still denormalized.** The Prediction record stores the odds at time of placement for fast querying. OddsSnapshot provides the historical context around that point in time.

### What It Is Not

- Not a betting ledger.
- Not a transaction log.
- Not a real-time data feed.
- Not a source of truth for current odds (the API is the source of truth for current odds).

### Table Design

- One row per bookmaker per market per outcome per fetch.
- Indexed by `(match_id, captured_at)` for time-range queries.
- No unique constraint on the natural key (multiple snapshots at the same second are allowed).
- No cleanup in V1. If cleanup is ever needed, it's a single DELETE query.

---

## 9. Final Recommendation Regarding Prediction Ownership

**Prediction is per-user (User-owned).**

### Why Per-User

1. **Each of the 5 friends has their own bankroll.** A global Prediction would require a join table (UserPrediction) to track per-user stake, P&L, and ROI. This adds complexity for zero benefit.

2. **Data volume is trivial.** 5 users × ~10 predictions/day = ~50 rows/day = ~1,500/month. Even at 50 predictions/day per user (unrealistically high), that's 7,500/month. Still trivial.

3. **Simplest query pattern.** `SELECT * FROM predictions WHERE user_id = ?` is the simplest possible query. No joins needed for the most common access pattern.

4. **No duplication concern.** The prediction content (match, market, outcome, odds, analysis) is the same across users. Only the stake, P&L, and ROI differ. Storing these on the Prediction record itself is simpler than a separate join table.

### What This Means

- When a recommendation is generated, the system creates one Prediction record per user (up to 5).
- Each user's Prediction has their own `stake` (based on their bankroll), their own `pnl`, and their own `roi`.
- The `matchId`, `analysisId`, `market`, `predictedOutcome`, `oddsAtPlacement`, `confidence`, and `expectedValue` are identical across users for the same recommendation.
- The unique constraint `(user_id, match_id, market, predicted_outcome)` prevents duplicate predictions for the same user on the same outcome.

---

## 10. Remaining Unresolved Design Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **API rate limits may prevent sufficient odds collection.** The Odds API free tier (500 req/month) allows only ~16 fetches/day across all sports. This may result in sparse odds_snapshots data. | Medium | Accept for V1. If data is too sparse, upgrade to paid tier (~$100/month for 10,000 req/month). |
| 2 | **PandaScore API coverage for esports odds may be incomplete.** PandaScore provides match data but may not provide bookmaker odds for all esports markets. | Medium | If PandaScore odds are unavailable, fall back to The Odds API for esports where possible, or generate predictions based on AI analysis alone (no odds-based EV calculation). |
| 3 | **DeepSeek API costs may exceed expectations.** At ~$0.01–0.05 per analysis, analyzing 50 matches/day could cost $15–75/month. | Low | Implement a daily analysis budget. Skip low-value matches (very short odds, obscure leagues). Monitor costs via `analyses.cost_usd`. |
| 4 | **Per-user Prediction creation may cause write contention.** When a recommendation is generated, 5 Prediction records are created in sequence. | Low | 5 sequential inserts is negligible. No mitigation needed. |
| 5 | **Bankroll balance may drift due to missed settlements.** If a match result is not fetched (API failure), the prediction is never settled and bankroll is never updated. | Medium | Settlement job runs every 15 minutes. If a match is FINISHED but settlement fails, it retries 3 times. After max retries, log the error and alert the developer. Manual settlement via admin command. |
| 6 | **No currency conversion between HUF and EUR.** If a user has a HUF bankroll but odds are in EUR-denominated markets, there is no conversion. | Low | V1 uses abstract "units" internally. Currency is a display label only. No conversion needed. |
| 7 | **Team identity across API providers is not unified.** The Odds API and PandaScore use different team IDs and names. A team appearing in both APIs would be stored as two separate Team records. | Low | Accept for V1. Team deduplication across providers is a V2 concern. Match data comes from a single provider per sport. |

---

## Appendix: Enum Definitions

```sql
user_status        : created, active
currency_code      : huf, eur
bankroll_status    : active
sport_category     : traditional, esports
sport_status       : active, deprecated
api_source         : the_odds_api, pandascore
league_status      : active
team_status        : active
team_league_status : active
match_status       : scheduled, live, finished, cancelled, postponed
match_result       : home_win, away_win, draw
odds_market        : h2h, spreads, totals
analysis_status    : queued, in_progress, completed, failed
analysis_trigger   : scheduled, on_demand, re_analysis
value_level        : high, medium, low, none
prediction_status  : pending, placed, settled, voided
prediction_result  : won, lost, push, void
```

---

*End of Final V1 Data Model Decision Document*

**This document is the final source of truth. Proceed to Prisma schema design.**
