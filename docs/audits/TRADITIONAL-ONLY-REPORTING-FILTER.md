# Traditional-Only Reporting Filter

**Date:** 2026-06-10

**Implements:** ROI-RESET-STRATEGY.md — Option B / Option D

**Objective:** Exclude esports `ValueOpportunity` records from all reporting surfaces without modifying historical data, database schema, settlement logic, value detection, or ingestion.

---

## Files Modified

| File | Change |
|---|---|
| `src/discord/commands/roi.ts` | Added `match: { sport: { category: 'TRADITIONAL' } }` to both branches of the `where` condition |
| `src/discord/commands/paper-bankroll.ts` | Added `match: { sport: { category: 'TRADITIONAL' } }` to the `findMany` `where` clause |
| `src/discord/commands/best-sports.ts` | Added `match: { sport: { category: 'TRADITIONAL' } }` to the `findMany` `where` clause |
| `src/discord/discord-notification.service.ts` | Added `match: { sport: { category: 'TRADITIONAL' } }` to `notifyDailySummary` `findMany` `where` clause |
| `src/discord/discord-bot.service.ts` | Added `match: { sport: { category: 'TRADITIONAL' } }` to `_updatePresence` `findMany` `where` clause |

No other files were modified.

---

## Exact Query Changes

### `src/discord/commands/roi.ts`

**Before:**
```typescript
const where = cutoff
  ? { settledAt: { not: null, gte: cutoff } }
  : { settledAt: { not: null } };
```

**After:**
```typescript
const where = cutoff
  ? { settledAt: { not: null, gte: cutoff }, match: { sport: { category: 'TRADITIONAL' as const } } }
  : { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } };
```

---

### `src/discord/commands/paper-bankroll.ts`

**Before:**
```typescript
where: { settledAt: { not: null } },
```

**After:**
```typescript
where: { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } },
```

---

### `src/discord/commands/best-sports.ts`

**Before:**
```typescript
where: { settledAt: { not: null } },
select: { sport: true, betResult: true, profitLossUnits: true },
```

**After:**
```typescript
where: { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } },
select: { sport: true, betResult: true, profitLossUnits: true },
```

---

### `src/discord/discord-notification.service.ts` — `notifyDailySummary`

**Before:**
```typescript
where: {
  settledAt: { gte: since },
  betResult: { not: null },
},
```

**After:**
```typescript
where: {
  settledAt: { gte: since },
  betResult: { not: null },
  match: { sport: { category: 'TRADITIONAL' as const } },
},
```

---

### `src/discord/discord-bot.service.ts` — `_updatePresence`

**Before:**
```typescript
where: { betResult: { not: null } },
```

**After:**
```typescript
where: { betResult: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } },
```

---

## How the Filter Works

The Prisma nested `where` condition traverses:

```
ValueOpportunity.matchId → Match.sportId → Sport.category
```

Prisma compiles this to:

```sql
INNER JOIN matches ON matches.id = value_opportunities.match_id
INNER JOIN sports  ON sports.id  = matches.sport_id
WHERE sports.category = 'TRADITIONAL'
```

The `SportCategory` enum is defined in `prisma/schema.prisma` with values `TRADITIONAL` and `ESPORTS`. The `as const` assertion ensures TypeScript's type narrowing resolves correctly without requiring an explicit import of the enum.

---

## Validation Results

### TypeScript build — `npx tsc --noEmit`

**Result: 0 errors**

---

## Before / After Behavior

| Surface | Before | After |
|---|---|---|
| `/roi` | All 64 settled opportunities (54 traditional + 10 esports) | 54 traditional only |
| `/paper-bankroll` | P&L from all 64 settled opportunities | P&L from 54 traditional only; starting bankroll (1,000 units) unchanged |
| `/best-sports` | Breakdown including valorant, cs-go, league-of-legends rows | Traditional sport slugs only |
| Daily summary (23:00) | 24-hour window, all sports | 24-hour window, traditional only |
| Discord presence | ROI from all settled bets | ROI from traditional settled bets only |

**Historical esports records:** Unchanged. All 10 esports `ValueOpportunity` rows remain in the database with full fidelity. They are still queryable via `/value-bets sport:valorant` (and equivalent sport slugs) or any direct database query.

---

## Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Query performance regression | Negligible | Low | Two additional joins on small, indexed tables. `Match.sport_id` and `Sport.id` are both indexed. No measurable impact at current data volumes. |
| Future esports opportunities contaminating reporting | None | None | The filter is self-maintaining. Any new esports matches are classified `ESPORTS` by ingestion at the `Sport.category` level. They will be excluded automatically without any code change. |
| Accidental exclusion of traditional sports | None | None | The `TRADITIONAL` category is set by the ingestion service for all The Odds API sports and is not applied to esports. No traditional sport has ever been stored with `category = 'ESPORTS'`. |
| Esports data inaccessible for audit | None | None | The filter is applied only at the reporting layer. The underlying rows are untouched and fully queryable through any path that does not go through these five functions. |

---

## What Is Not Changed

- Database schema: no migration, no new columns
- `ValueOpportunity` data: no rows modified, deleted, or archived
- Settlement logic (`SettlementService`, `SettlementWorker`): unchanged — esports still settle normally
- Value detection (`ValueDetectionService`): unchanged — esports alerts still fire normally
- Ingestion pipeline: unchanged
- `/value-bets` command: unchanged — still shows all opportunities including esports when queried directly
- `Sport.category` field and `SportCategory` enum: unchanged
