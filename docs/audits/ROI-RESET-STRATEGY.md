# ROI Reset Strategy

**Date:** 2026-06-10

**Context:** CONSENSUS-DUPLICATION-EVIDENCE-AUDIT.md confirmed that 10 of 64 stored ValueOpportunity records are esports, 8 of those 10 have corrupted `consensusBookmakers` arrays, and 4 of the 8 are complete false positives (only one real bookmaker, would never have qualified). All 10 esports opportunities currently pollute ROI, Paper Bankroll, Best Sports, Daily Summary, and Discord presence calculations. The goal is clean traditional-sports-only reporting without deleting historical records.

---

## Affected Surfaces (five locations)

| Surface | File | Current query scope |
|---|---|---|
| `/roi` | `src/discord/commands/roi.ts` | All settled opportunities, optional date cutoff |
| `/paper-bankroll` | `src/discord/commands/paper-bankroll.ts` | All settled opportunities, no filter |
| `/best-sports` | `src/discord/commands/best-sports.ts` | All settled opportunities, grouped by sport slug |
| Daily summary (23:00) | `src/discord/discord-notification.service.ts` | Settled in last 24 h, no sport filter |
| Discord presence | `src/discord/discord-bot.service.ts` | All with `betResult != null`, no sport filter |

None of the five surfaces currently filter by sport category.

---

## Data Distribution in Production

From the evidence audit (Query 2):

| Consensus bookmaker count | Opportunities | Interpretation |
|---|---|---|
| 2–4 | 10 | Esports (OddsPapi, only bet365 and unibet) |
| 16–46 | 54 | Traditional (The Odds API, many bookmakers) |
| **Total** | **64** | **All settled** |

**54 traditional sport opportunities already exist and are clean.** Excluding esports immediately yields meaningful reporting.

---

## Option A — Reporting Start Date (ROI V2)

### Mechanism
Introduce a `REPORTING_BASELINE_DATE` environment variable. All reporting queries add `capturedAt >= baselineDate` (or `settledAt >= baselineDate`). The date would be set to the day after the last corrupted esports alert (2026-06-09), i.e. `2026-06-10`.

### Effect on each surface

| Surface | Effect |
|---|---|
| `/roi all` | Shows only opportunities settled on or after 2026-06-10 — today only, near-empty for now |
| `/roi 7d` | Shows last 7 days' traditional opportunities (if any settled recently) |
| `/paper-bankroll` | Resets to a clean 1,000-unit starting point from the baseline date; ignores all prior settled bets |
| `/best-sports` | Shows sport breakdown only for the V2 window |
| Daily summary | Unchanged — it already uses a 24-hour rolling window |

### Implementation complexity

Low-medium. Requires:
- New `REPORTING_BASELINE_DATE` env variable
- Five query changes — adding a date filter to each

### Risks

- **Throws away real traditional data.** 54 traditional opportunities settled before 2026-06-10 are discarded from the V2 view, even though they are clean. This defeats the stated goal of clean metrics.
- The `all` period shows essentially nothing until enough new bets accumulate.
- Brittle: the baseline date is a magic constant. Any future corruption episode requires updating the date and re-deploying.
- The dirty esports records remain visible via `/roi 30d` or `/roi all` until the rollback date passes the 30-day window.

**Assessment: Not recommended.** Option A discards 54 legitimate traditional opportunities and provides no protection against esports re-entering the window as time passes.

---

## Option B — Exclude Esports from All Reporting Queries

### Mechanism
Add a Prisma relation filter to every reporting query:

```typescript
match: { sport: { category: 'TRADITIONAL' } }
```

The `Sport.category` field (`TRADITIONAL` | `ESPORTS`) is the authoritative discriminator already maintained in the database. This is a three-hop join (`ValueOpportunity → Match → Sport → category`) that Prisma handles natively in `where` clauses without requiring it to be in `select`.

### Effect on each surface

| Surface | Effect |
|---|---|
| `/roi` | Reports on 54 clean traditional sport bets immediately |
| `/paper-bankroll` | P&L calculated from 54 traditional bets only; starting bankroll of 1,000 units unchanged |
| `/best-sports` | Shows only traditional sport slugs (soccer, basketball, tennis, etc.); esports rows disappear |
| Daily summary | Settlement notifications for esports silently excluded from the rolling 24-hour count |
| Discord presence | ROI in the presence string reflects traditional performance only |

Esports `ValueOpportunity` rows remain fully intact in the database. They are still queryable via `/value-bets sport:valorant`, accessible to direct DB queries, and auditable.

### Implementation complexity

**Low.** Five targeted `where` clause additions. No schema changes, no migration, no new environment variables, no data modifications. Each change is a single Prisma filter in an existing query.

Example for `roi.ts`:

```typescript
const baseWhere = cutoff
  ? { settledAt: { not: null, gte: cutoff } }
  : { settledAt: { not: null } };

const where = { ...baseWhere, match: { sport: { category: 'TRADITIONAL' as const } } };
```

### Risks

- **Low.** The Sport.category field is already used throughout the ingestion system and is reliable.
- Self-maintaining: any future esports games added to the scheduler are automatically excluded from reporting.
- When the esports consensus deduplication bug is fixed, a separate `/roi-esports` command or an `include-esports` flag can be added without touching the current logic.
- One minor concern: the daily summary and presence also stop reflecting esports settlement. This is intentional given the data quality state, but should be documented so users know the scope of each metric.

**Assessment: Recommended.**

---

## Option C — Archive Esports Opportunities

### Mechanism
Add a boolean column `excludedFromReporting` (or similar) to the `ValueOpportunity` table. Set it to `true` for all esports rows. All reporting queries add `excludedFromReporting: false`.

### Effect on each surface

Same functional outcome as Option B — esports rows excluded, traditional data clean.

### Implementation complexity

**High relative to benefit.** Requires:
- A Prisma schema migration adding a new column
- A one-time UPDATE to set the flag for existing esports rows
- Five `where` clause additions
- Ongoing maintenance: all future esports inserts must set the flag

This is strictly more work than Option B for the same result.

### Risks

- Migration must be applied without downtime
- Future ingestion code must remember to set the flag; there is no structural enforcement
- The column semantics are ambiguous — "excluded from reporting" is a reporting-layer concept in a data layer

**Assessment: Not recommended.** All the benefit of Option C is captured by Option B at a fraction of the implementation cost.

---

## Option D — Native Approach: Use `Sport.category` in All Queries (Recommended)

This is Option B with the full implementation spelled out. The codebase already has:

- `Sport.category: SportCategory` (`TRADITIONAL` | `ESPORTS`) — maintained by ingestion for every sport
- `Match.sport: Sport` relation — already present in Prisma schema
- `ValueOpportunity.match: Match` relation — already present

No new fields, no new tables, no migration. The existing `Sport.category` enum is the authoritative classification layer.

The five affected queries use `prisma.valueOpportunity.findMany(...)`. Each gains one nested `where` condition:

```typescript
match: { sport: { category: 'TRADITIONAL' } }
```

Prisma compiles this to a two-join SQL filter:

```sql
INNER JOIN matches ON matches.id = value_opportunities.match_id
INNER JOIN sports  ON sports.id  = matches.sport_id
WHERE sports.category = 'TRADITIONAL'
```

This is indexed (the `Sport.slug` has a unique index; the `Match.sportId` has an index), efficient, and correct.

---

## Side-by-Side Comparison

| Criterion | Option A (baseline date) | Option B/D (category filter) | Option C (archive flag) |
|---|---|---|---|
| Historical records preserved | Yes | Yes | Yes |
| 54 traditional bets immediately visible | No — discarded by date cutoff | **Yes** | Yes |
| Clean ROI immediately | Partially (only recent bets) | **Yes** | Yes |
| Schema migration required | No | **No** | Yes |
| Ongoing maintenance burden | High (date must be updated) | **None** (self-maintaining) | Medium (flag must be set on insert) |
| Esports re-contamination risk | Yes (after 7/30 days pass) | **None** | Low |
| Future esports reporting possible | No | **Yes (additive)** | Yes |
| Implementation size | 5 query changes + env var | **5 query changes** | Migration + 5 query changes + insert-path change |

---

## Recommendation

**Option B / Option D: Add `match: { sport: { category: 'TRADITIONAL' } }` to all five reporting queries.**

Rationale:

1. **Immediately correct.** The 54 traditional sport opportunities already in the database are clean and will be reported correctly from the moment the change is deployed.

2. **Zero data modification.** No records are altered, archived, or deleted. The full esports history remains intact and auditable.

3. **No migration.** The `Sport.category` field already exists and is already populated correctly.

4. **Self-maintaining.** Any esports game added in the future is automatically excluded from reporting without any code change. When the consensus deduplication fix is deployed and esports data quality is clean, a separate reporting toggle can be added additively.

5. **Narrowly scoped.** Five files, one line each. The change is trivial to review, trivial to revert if needed.

---

## Implementation Checklist

Five files require a `where` clause addition. No other changes are needed.

- [ ] `src/discord/commands/roi.ts` — `getRoiStats` query
- [ ] `src/discord/commands/paper-bankroll.ts` — `getPaperBankroll` query
- [ ] `src/discord/commands/best-sports.ts` — `getBestSports` query
- [ ] `src/discord/discord-notification.service.ts` — `notifyDailySummary` query
- [ ] `src/discord/discord-bot.service.ts` — `_updatePresence` query

After deployment, the `/roi all` command will reflect 54 clean traditional sport bets. Esports opportunities remain accessible via `/value-bets sport:valorant` or direct database query.
