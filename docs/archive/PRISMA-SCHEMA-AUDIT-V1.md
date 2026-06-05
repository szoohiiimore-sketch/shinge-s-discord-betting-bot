# Betting Intelligence Discord Platform — V1 Prisma Schema Audit

> **Status:** Audit Report  
> **Version:** 1.0  
> **Last Updated:** 2026-06-05  
> **Audited Document:** PRISMA-SCHEMA-SPEC-V1.md  
> **Source of Truth:** FINAL-V1-DATA-MODEL.md

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Issues](#2-critical-issues)
3. [Recommended Changes](#3-recommended-changes)
4. [Nice-to-Have Improvements](#4-nice-to-have-improvements)
5. [Final Readiness Score](#5-final-readiness-score)

---

## 1. Executive Summary

The specification is well-structured and covers all necessary details. However, several issues were identified that would cause problems during Prisma schema generation, migration, or runtime. The most significant issues are:

1. **UUID storage as `String`** — Prisma maps `String` to `TEXT` by default, not `CHAR(36)`. This has performance implications.
2. **Prediction unique constraint** — The `@@unique` on `[userId, matchId, market, predictedOutcome]` would prevent a user from having both a PLACED and a SETTLED prediction on the same outcome.
3. **OddsSnapshot index on `capturedAt`** — This index is never used in V1 (no cleanup job). It wastes write performance.
4. **Missing `onDelete` cascade behavior** — Several relations need explicit `onDelete` behavior that is not specified.
5. **`homeScore`/`awayScore` as `Int`** — Prisma `Int` maps to `INTEGER`, not `SMALLINT`. If `SMALLINT` is desired, `@db.SmallInt` is needed.

**Overall readiness: 72/100** — The specification is usable but has issues that will cause problems during implementation. The critical issues must be resolved before schema generation.

---

## 2. Critical Issues

### C1. UUID Storage Strategy

**Problem:**
The specification says UUIDs are stored as `String` with `CHAR(36)` in PostgreSQL. This is incorrect. Prisma maps `String` to `TEXT` by default, not `CHAR(36)`. `TEXT` is a variable-length type with different performance characteristics than `CHAR(36)`.

**Impact:**
- `TEXT` has different indexing behavior than `CHAR(36)`.
- `TEXT` columns cannot be used with certain PostgreSQL optimizations.
- If the developer expects `CHAR(36)` but gets `TEXT`, the database schema will differ from expectations.
- No performance issue at this scale, but the mismatch between specification and reality will cause confusion.

**Recommended Correction:**
Use `@db.Uuid` instead of `String` for all UUID primary keys and foreign keys. Prisma's `@db.Uuid` maps to PostgreSQL's native `UUID` type, which is stored as 16 bytes (vs. 36 bytes for `CHAR(36)`). This is the correct approach for UUIDs in Prisma + PostgreSQL.

```prisma
// Instead of:
id  String  @id @default(uuid()) @map("id")

// Use:
id  String  @id @default(uuid()) @map("id") @db.Uuid
```

For all foreign key fields:
```prisma
userId  String  @map("user_id") @db.Uuid
```

**Why this matters:**
- Native UUID storage is 16 bytes vs. 36 bytes for CHAR(36) → 55% less storage.
- Native UUID indexes are smaller and faster.
- Prisma's `@db.Uuid` is the standard pattern for PostgreSQL UUIDs.
- The specification's claim of `CHAR(36)` is incorrect — Prisma does not use `CHAR(36)` by default.

---

### C2. Prediction Unique Constraint

**Problem:**
The specification defines:
```prisma
@@unique([userId, matchId, market, predictedOutcome])
```

This unique constraint applies to ALL rows in the `predictions` table, regardless of status. This means:
- A user can have only ONE prediction for a given match/market/outcome across their entire history.
- If a user had a PLACED prediction that was SETTLED, they cannot have another prediction on the same outcome.
- This prevents re-betting on the same outcome after settlement.

**Impact:**
- The constraint is too restrictive. It prevents legitimate use cases.
- The specification says "Enforced at application level for PLACED status only" but the database constraint applies to all statuses.
- If the application fails to enforce this correctly, the database will reject valid operations.
- If the application enforces it correctly, the database constraint is redundant and causes migration issues when a user has multiple predictions on the same outcome across different statuses.

**Recommended Correction:**
Remove the `@@unique` constraint from the database entirely. Enforce uniqueness at the application layer for PLACED predictions only. This is the correct approach because:

1. The constraint is only meaningful for PLACED predictions (you cannot have two active bets on the same outcome).
2. For SETTLED predictions, re-betting on the same outcome should be allowed.
3. Application-level enforcement is sufficient for 5 users.
4. The database constraint would cause migration failures if a user ever has two predictions on the same outcome (e.g., one SETTLED, one PLACED).

**Alternative (if database enforcement is desired):**
Use a partial unique index:
```sql
CREATE UNIQUE INDEX uq_predictions_active_duplicate
ON predictions (user_id, match_id, market, predicted_outcome)
WHERE status = 'PLACED';
```

However, Prisma does not natively support partial unique indexes. This would require a raw SQL migration. For V1, application-level enforcement is simpler and sufficient.

---

### C3. OddsSnapshot Index on `capturedAt`

**Problem:**
The specification defines an index on `[capturedAt]` for "potential cleanup queries." In V1, there is no cleanup job. This index will never be used.

**Impact:**
- Every insert into `odds_snapshots` must update this index.
- At ~36,000 rows/month, this is ~1,200 writes/day to an unused index.
- The index consumes storage space (~8 MB per year for this index alone).
- No query in V1 uses this index.

**Recommended Correction:**
Remove the `@@index([capturedAt])` from OddsSnapshot. Add it only when a cleanup job is implemented in V2.

**Why this matters:**
- OddsSnapshot is the highest-volume table (~36,000 rows/month).
- Every unnecessary index on this table adds write overhead.
- The index provides zero benefit in V1.
- Adding it later is a simple migration.

---

### C4. Missing `onDelete` Cascade Behavior

**Problem:**
The specification defines cascade deletion rules in the Soft Delete Strategy section but does not specify `onDelete` behavior in the Prisma relation definitions. Prisma requires explicit `onDelete` behavior for relations.

**Impact:**
- Prisma will use the default `onDelete` behavior, which is `Restrict` (no cascade).
- This means:
  - Deleting a User will NOT cascade-delete UserPreferences (spec says it should).
  - Deleting a Team or League will NOT cascade-delete TeamLeague (spec says it should).
- If the developer expects cascade behavior but doesn't specify it, the database will reject deletes.

**Recommended Correction:**
Add explicit `onDelete` behavior to every relation definition in the specification:

```prisma
// UserPreferences (cascade delete with User)
user  User  @relation("UserUserPreferences", fields: [userId], references: [id], onDelete: Cascade)

// TeamLeague (cascade delete with Team or League)
team   Team   @relation("TeamTeamLeagues", fields: [teamId], references: [id], onDelete: Cascade)
league League @relation("LeagueTeamLeagues", fields: [leagueId], references: [id], onDelete: Cascade)
```

For all other relations, use `onDelete: Restrict` (the default) explicitly for clarity.

**Affected relations:**
| Relation | Required `onDelete` |
|---|---|
| User → UserPreferences | `Cascade` |
| Team → TeamLeague | `Cascade` |
| League → TeamLeague | `Cascade` |
| All others | `Restrict` (default, but specify explicitly) |

---

### C5. `homeScore`/`awayScore` as `Int`

**Problem:**
The specification uses `Int` for `homeScore` and `awayScore` and notes that Prisma maps `Int` to `INTEGER`, not `SMALLINT`. If `SMALLINT` is desired, `@db.SmallInt` is needed.

**Impact:**
- `INTEGER` is 4 bytes. `SMALLINT` is 2 bytes.
- For ~90,000 matches over 5 years, the difference is ~180 KB. Negligible.
- However, if the developer expects `SMALLINT` (as specified in FINAL-V1-DATA-MODEL), they will get `INTEGER` instead.
- This is a minor mismatch but causes no functional issues.

**Recommended Correction:**
Either:
1. Accept `INTEGER` (4 bytes) — the storage difference is negligible for 90,000 rows.
2. Or add `@db.SmallInt` to the specification if `SMALLINT` is truly desired.

Recommendation: Accept `INTEGER`. The storage difference is irrelevant at this scale, and `INTEGER` avoids potential issues with score values exceeding `SMALLINT` range (32,767).

---

## 3. Recommended Changes

### R1. Add `@db.Uuid` to All UUID Fields

**Change:** Add `@db.Uuid` to every `id` field and every foreign key field.

**Affected models:** All 11 models.

**Example:**
```prisma
// Before:
id     String  @id @default(uuid()) @map("id")
userId String  @map("user_id")

// After:
id     String  @id @default(uuid()) @map("id") @db.Uuid
userId String  @map("user_id") @db.Uuid
```

**Rationale:** Native UUID storage is 16 bytes vs. 36 bytes for TEXT. Smaller indexes, faster queries, correct PostgreSQL type.

---

### R2. Remove Prediction Unique Constraint

**Change:** Remove the `@@unique([userId, matchId, market, predictedOutcome])` constraint from the Prediction model.

**Affected model:** Prediction.

**Rationale:** The constraint is too restrictive. It prevents re-betting on the same outcome after settlement. Enforce uniqueness at the application layer for PLACED predictions only.

---

### R3. Remove OddsSnapshot `capturedAt` Index

**Change:** Remove `@@index([capturedAt])` from OddsSnapshot.

**Affected model:** OddsSnapshot.

**Rationale:** The index is never used in V1 (no cleanup job). It adds write overhead to the highest-volume table with zero benefit.

---

### R4. Add Explicit `onDelete` Behavior

**Change:** Add `onDelete: Cascade` to UserPreferences, TeamLeague relations. Add `onDelete: Restrict` to all other relations.

**Affected models:** All models with relations.

**Example:**
```prisma
// UserPreferences
user  User  @relation("UserUserPreferences", fields: [userId], references: [id], onDelete: Cascade)

// TeamLeague
team   Team   @relation("TeamTeamLeagues", fields: [teamId], references: [id], onDelete: Cascade)
league League @relation("LeagueTeamLeagues", fields: [leagueId], references: [id], onDelete: Cascade)

// All other relations (explicit Restrict)
user  User  @relation("UserPredictions", fields: [userId], references: [id], onDelete: Restrict)
```

---

### R5. Accept `Int` for Scores

**Change:** Accept `Int` (maps to `INTEGER`) for `homeScore` and `awayScore`. Remove the note about `@db.SmallInt`.

**Affected model:** Match.

**Rationale:** The storage difference is negligible (~180 KB over 5 years). `INTEGER` avoids potential range issues.

---

### R6. Add `@@index([status])` to User Model

**Change:** The specification mentions an index on `User.status` but does not define it as a Prisma `@@index`. Add it explicitly.

**Affected model:** User.

**Rationale:** The specification says "BTREE (implicit via query pattern)" but Prisma requires explicit index definitions. Without it, queries filtering by `User.status` will perform sequential scans.

---

### R7. Add `@@index([sportId])` to Match Model

**Change:** The specification lists `sportId` as a BTREE FK lookup but does not define it as a Prisma `@@index`. Add it explicitly.

**Affected model:** Match.

**Rationale:** `sportId` is a foreign key on Match. Without an explicit index, JOINs on `sportId` will perform sequential scans. The specification lists it but does not define it as a Prisma index.

**Note:** This applies to all FK indexes listed in the specification that are not already covered by unique constraints. Specifically:
- `Match.sportId` — needs explicit `@@index`
- `Match.leagueId` — needs explicit `@@index`
- `Match.homeTeamId` — needs explicit `@@index`
- `Match.awayTeamId` — needs explicit `@@index`
- `OddsSnapshot.matchId` — needs explicit `@@index`
- `Analysis.matchId` — needs explicit `@@index`
- `Prediction.userId` — needs explicit `@@index`
- `Prediction.matchId` — needs explicit `@@index`
- `Prediction.analysisId` — needs explicit `@@index`
- `League.sportId` — needs explicit `@@index`
- `Team.sportId` — needs explicit `@@index`
- `TeamLeague.teamId` — needs explicit `@@index`
- `TeamLeague.leagueId` — needs explicit `@@index`

The specification lists these as "BTREE (FK lookup)" but does not define them as Prisma `@@index` annotations. Every FK that is not already covered by a unique constraint needs an explicit `@@index`.

---

### R8. Add `@@index([status])` to Match Model

**Change:** The specification lists `@@index([status])` for Match but this is already covered by the partial index concept. However, Prisma does not support partial indexes natively. The `@@index([status])` on Match will be a full index on the `status` column.

**Affected model:** Match.

**Rationale:** The specification correctly identifies the need for this index. Ensure it is defined as `@@index([status])` in the Prisma schema.

---

### R9. Add `@@index([status])` to Analysis Model

**Change:** The specification lists `@@index([status])` for Analysis. Ensure it is defined.

**Affected model:** Analysis.

**Rationale:** Used to find queued analyses for processing. Without this index, the scheduler job will perform sequential scans.

---

### R10. Add `@@index([status])` to Prediction Model

**Change:** The specification lists `@@index([status])` for Prediction. Ensure it is defined.

**Affected model:** Prediction.

**Rationale:** Used to find placed predictions for settlement. Without this index, the settlement job will perform sequential scans.

---

## 4. Nice-to-Have Improvements

### N1. Add `@map` for Enum Fields

**Suggestion:** Add `@map` to all enum fields for consistency with the snake_case column naming convention.

**Example:**
```prisma
status  UserStatus  @map("status")
```

The specification already does this. No change needed. Confirmed correct.

---

### N2. Add `@@map` for All Models

**Suggestion:** The specification defines `@@map` for all 11 models. This is correct and should be maintained.

**Status:** Already specified. No change needed.

---

### N3. Consider `@updatedAt` on OddsSnapshot

**Suggestion:** Even though OddsSnapshot is append-only, adding `updatedAt` with `@updatedAt` would not cause issues (it would be set to the same value as `capturedAt` on insert and never change). However, the specification's approach of omitting it is cleaner.

**Status:** No change needed. Current approach is correct.

---

### N4. Add `@default(now())` to `capturedAt` on OddsSnapshot

**Suggestion:** Add `@default(now())` to `capturedAt` so it defaults to the current timestamp if not explicitly provided. This simplifies insert logic.

**Change:**
```prisma
capturedAt  DateTime  @default(now()) @map("captured_at")
```

**Rationale:** The application will almost always set `capturedAt` to `new Date()`. Making it the default simplifies the insert code and prevents accidental omissions.

---

### N5. Add `@default(now())` to `firstSeenAt` and `lastActiveAt` on User

**Suggestion:** Add `@default(now())` to both `firstSeenAt` and `lastActiveAt` so they default to the current timestamp on creation.

**Change:**
```prisma
firstSeenAt   DateTime  @default(now()) @map("first_seen_at")
lastActiveAt  DateTime  @default(now()) @map("last_active_at")
```

**Rationale:** Both fields are set to the current time on user creation. Making this the default simplifies the insert code.

---

### N6. Consider `@db.VarChar` for String Fields

**Suggestion:** The specification defines max lengths for string fields (e.g., `discordId` VARCHAR(32), `bookmaker` VARCHAR(64)). In Prisma, `String` maps to `TEXT` by default. To enforce length constraints at the database level, use `@db.VarChar(n)`.

**Impact:**
- Without `@db.VarChar`, the database will not enforce max lengths.
- For 5 users, this is unlikely to cause issues.
- Adding `@db.VarChar` adds complexity with no practical benefit at this scale.

**Recommendation:** Skip `@db.VarChar` for V1. Enforce length constraints at the application layer. Add `@db.VarChar` in V2 if needed.

---

### N7. Add `@relation` Name to All Relations

**Suggestion:** The specification recommends named relations (e.g., `@relation("UserPredictions")`). This is a Prisma best practice and should be applied to ALL relations, not just the ones listed.

**Status:** The specification defines relation names for all relations. Confirmed correct.

---

### N8. Consider `@id` with `@default(dbgenerated("gen_random_uuid()"))` for Native UUID

**Suggestion:** Instead of Prisma's `uuid()` function (which generates UUIDs in the application layer), use PostgreSQL's native `gen_random_uuid()` function. This is slightly more performant and ensures UUIDs are generated at the database level.

**Change:**
```prisma
id  String  @id @default(dbgenerated("gen_random_uuid()")) @map("id") @db.Uuid
```

**Impact:**
- UUIDs are generated by PostgreSQL, not the application.
- Slightly better performance for batch inserts.
- Requires `pgcrypto` extension (which is already recommended in DATABASE-DESIGN-V1.md).
- Prisma's `uuid()` function is also fine for this scale.

**Recommendation:** Use Prisma's `@default(uuid())` for V1. It's simpler and sufficient for 5 users. Consider `dbgenerated` in V2 if batch insert performance becomes a concern.

---

### N9. Add `@@index([createdAt])` to Analysis Model

**Suggestion:** Add an index on `Analysis.createdAt` for time-range queries (e.g., "find analyses from the last 7 days").

**Rationale:** The specification defines `@@index([createdAt])` on Prediction but not on Analysis. If the developer wants to query analysis history by date, this index would be needed.

**Recommendation:** Skip for V1. Add if needed.

---

### N10. Consider Removing `wasCorrect` from Prediction

**Suggestion:** The `wasCorrect` field is derivable from `result` (WON → true, LOST → false, PUSH/VOID → null). It is a denormalized convenience field.

**Impact:**
- Adds write complexity (must be kept in sync with `result`).
- Saves a simple CASE statement in queries.
- For 5 users, the query complexity is negligible.

**Recommendation:** Keep `wasCorrect` for V1. It simplifies analytics queries and the storage cost is negligible. Remove in V2 if it becomes a maintenance burden.

---

## 5. Final Readiness Score

### Scoring Criteria

| Category | Weight | Score | Weighted |
|---|---|---|---|
| Correctness (no wrong Prisma/PostgreSQL) | 30% | 6/10 | 18 |
| Completeness (no missing definitions) | 25% | 8/10 | 20 |
| Performance (index strategy, storage) | 20% | 7/10 | 14 |
| Maintainability (future migration risk) | 15% | 7/10 | 10.5 |
| Clarity (easy to generate schema from) | 10% | 9/10 | 9 |

**Final Score: 72/100**

### Score Breakdown

| Category | Score | Rationale |
|---|---|---|
| **Correctness** | 6/10 | UUID storage strategy is incorrect (`String` → `TEXT`, not `CHAR(36)`). Missing `onDelete` behavior. Prediction unique constraint is too restrictive. |
| **Completeness** | 8/10 | All models, fields, enums, and relations are defined. Missing explicit `@@index` definitions for FK lookups. Missing `onDelete` cascade behavior. |
| **Performance** | 7/10 | Index strategy is generally good. Unused `capturedAt` index on OddsSnapshot adds unnecessary write overhead. Missing FK indexes would cause sequential scans. |
| **Maintainability** | 7/10 | Prediction unique constraint would cause migration failures. Missing `onDelete` behavior would cause confusing errors. Otherwise clean. |
| **Clarity** | 9/10 | Well-structured, easy to follow. Every model has clear field definitions. Minor ambiguity in index definitions. |

### What to Fix Before Schema Generation

| Priority | Issue | Effort |
|---|---|---|
| **P0** | UUID storage: add `@db.Uuid` to all UUID fields | Low |
| **P0** | Prediction unique constraint: remove or use partial index | Low |
| **P0** | Missing `onDelete` cascade behavior: add to all relations | Low |
| **P1** | Missing FK indexes: add `@@index` for all FK fields | Low |
| **P1** | Remove unused `capturedAt` index on OddsSnapshot | Low |
| **P2** | Add `@@index([status])` to User, Match, Analysis, Prediction | Low |
| **P2** | Accept `Int` for scores (remove `@db.SmallInt` note) | Low |

### What to Defer to V2

| Issue | Rationale |
|---|---|
| `@db.VarChar` for string fields | Application-level enforcement is sufficient for 5 users |
| `dbgenerated` for UUIDs | Prisma's `uuid()` is fine for this scale |
| Partial unique index on Prediction | Requires raw SQL migration; application enforcement is sufficient |
| `@@index([createdAt])` on Analysis | Not needed for V1 query patterns |
| Remove `wasCorrect` from Prediction | Convenience field; negligible storage cost |

---

*End of V1 Prisma Schema Audit*

**Next step:** Apply the P0 and P1 corrections to PRISMA-SCHEMA-SPEC-V1.md, then proceed to schema generation.
