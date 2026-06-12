# ROI and Presence Verification Audit

**Date:** 2026-06-10

**Symptom:** `/roi` shows ROI = -53.1%, Discord Rich Presence shows ROI = -53.1% and "54 Sports", both identical to the values observed before the traditional-only reporting filter was implemented.

---

## 1. Filter Status in Source Code

All five reporting queries were inspected. Every filter is present and correctly formed.

| Surface | File | Filter present? |
|---|---|---|
| `/roi` | `src/discord/commands/roi.ts:36–37` | ✅ `match: { sport: { category: 'TRADITIONAL' as const } }` |
| `/paper-bankroll` | `src/discord/commands/paper-bankroll.ts:20` | ✅ Same filter |
| `/best-sports` | `src/discord/commands/best-sports.ts:28` | ✅ Same filter |
| Daily summary | `src/discord/discord-notification.service.ts:235` | ✅ Same filter |
| Discord Presence | `src/discord/discord-bot.service.ts:256` | ✅ Same filter |

The source code is correct. The filter implementations cannot be the cause of the symptom.

---

## 2. Exact Query Paths

### `/roi` command — `src/discord/commands/roi.ts`

```typescript
const where = cutoff
  ? { settledAt: { not: null, gte: cutoff }, match: { sport: { category: 'TRADITIONAL' as const } } }
  : { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } };

const settled = await prisma.valueOpportunity.findMany({
  where,
  select: { betResult: true, profitLossUnits: true, edgePercentage: true },
});
```

ROI formula: `(totalPnl / settled.length) * 100` — denominator is **all settled bets including pushes**.

Runs a **fresh database query on every invocation.** No cache.

### Discord Presence — `src/discord/discord-bot.service.ts:_updatePresence()`

```typescript
const settled = await this._prisma.valueOpportunity.findMany({
  where: { betResult: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } },
  select: { betResult: true, profitLossUnits: true },
});
// ...
const decidedBets = wins + losses;
const roi = decidedBets > 0 ? (totalPL / decidedBets) * 100 : 0;
```

ROI formula: `totalPL / (wins + losses) * 100` — denominator is **decided bets only, pushes excluded**.

### Critical finding — the two formulas are different

| Surface | Denominator | Pushes included? |
|---|---|---|
| `/roi` command | `settled.length` (all settled) | Yes |
| Discord Presence | `wins + losses` (decided only) | No |

If both surfaces display the exact same value of -53.1%, one of the following must be true:

1. **There are zero push results in the dataset** — both formulas collapse to the same value when no pushes exist.
2. **The running process has not been restarted** — the live service is executing the pre-filter code and both queries are unfiltered; the same input produces the same output by coincidence of formula alignment.

### Presence update triggers — `src/discord/discord-bot.service.ts`

`_updatePresence()` is called in exactly two places:

```typescript
// 1. On bot login (startup only)
this._client.on(Events.ClientReady, async () => {
  await this._updatePresence();
});

// 2. When refreshPresence() is explicitly called
async refreshPresence(): Promise<void> {
  await this._updatePresence();
}
```

There is **no periodic timer** that refreshes the presence. After startup, the presence is fixed until `refreshPresence()` is called or the bot restarts. `refreshPresence()` has no callers other than the method definition — it is never invoked automatically.

---

## 3. The Hardcoded Sport Count — Confirmed Bug

At `src/discord/discord-bot.service.ts:280`:

```typescript
const sportCount = 54;
```

This literal is **never computed from `TRADITIONAL_SPORT_CONFIGS`, a database count, or any dynamic source.** It is a hardcoded estimate that was stale even before the expansion:

| Event | Actual configured sports | Hardcoded value |
|---|---|---|
| Before settlement coverage fix | 16 (settlement) / 50 (scheduler) | 54 |
| After expansion to 63 sports | 63 | 54 |
| After esports disabled | 63 (traditional) | 54 |

The presence will always display "54 Sports" regardless of any code change, database state, or service restart, until this literal is replaced.

---

## 4. Root Cause Analysis

Two independent problems exist. They are separable.

### Root Cause 1 — Service process not restarted after code changes (primary ROI issue)

TypeScript/Node.js applications execute the compiled code that was loaded when the process started. Code changes written to disk do not affect a running process. The TRADITIONAL filter added to all five reporting functions exists in the source files, but **if the service was not restarted after those files were written, the running process has no knowledge of those changes.**

Evidence:
- The reported ROI of -53.1% matches what would be produced by the pre-filter all-sports query (all 64 settled bets including the 10 corrupted esports rows).
- The word "still" in the symptom description ("still shows ROI = -53.1%") indicates the value has not changed after the filter was implemented — consistent with a stale process.
- `/roi` and presence show the same value despite using different ROI formulas; this is consistent with both running the same unfiltered pre-change code against the same 64-row result set and producing the same number by coincidence of the data containing zero pushes.

**If this is the cause:** a service restart will cause both `/roi` and `_updatePresence()` (called on `ClientReady`) to execute the filter-bearing code. The ROI will change to reflect only the 54 traditional bets.

### Root Cause 2 — Hardcoded `sportCount = 54` (sport count display issue)

The sport count in the presence string is a literal `54` that has never been computed dynamically. This is **independent of whether the service is running old or new code** — it will display `54` in both cases. Even after a full service restart with all filters in place, the presence will still say "54 Sports" until the literal is replaced.

---

## 5. Expected Post-Restart Behavior

If the service is restarted with the current source code:

| Observation | Before restart | After restart |
|---|---|---|
| `/roi all` denominator | 64 bets (unfiltered) | 54 bets (traditional only) |
| Presence ROI denominator | 64 bets (unfiltered) | 54 bets (traditional only) |
| ROI value | -53.1% (or same value, if traditional performance is also -53.1%) | Changes unless traditional ROI coincidentally equals -53.1% |
| Presence sport count | "54 Sports" | **Still "54 Sports"** — hardcoded literal unchanged |

The sport count will remain wrong after restart. It requires a separate code fix.

---

## 6. Recommended Fixes

### Fix 1 — Service restart (no code change required)

Restart the running Node.js process. On startup:
- All five filtered queries load into memory correctly.
- `_updatePresence()` fires on `ClientReady` and runs the filtered query.
- `/roi` will immediately use the filtered query on next invocation.

This is sufficient to correct the ROI value. No code modification is needed for the filter itself.

### Fix 2 — Replace hardcoded sport count with dynamic value (code change required)

In `src/discord/discord-bot.service.ts`, `_updatePresence()`:

**Before:**
```typescript
const sportCount = 54;
```

**Option A — derive from configured sport count (no DB call):**

Pass `TRADITIONAL_SPORT_CONFIGS.length` into `_updatePresence()` or `DiscordBotService` at construction time, and use it instead of the literal. This is accurate immediately without a database round-trip.

**Option B — derive from the settled query (no new dependency):**

Count distinct sport slugs from the same `settled` array already fetched by `_updatePresence()`. This reflects how many sports have ever produced a settled bet, not how many are configured — a different semantic, and starts at 0 with a fresh database.

**Recommended: Option A** — derive from `TRADITIONAL_SPORT_CONFIGS.length` (currently 63). It reflects the configured scope of the system rather than historical data volume.

Implementation: inject the sport count as a constructor parameter to `DiscordBotService`, populated from `TRADITIONAL_SPORT_CONFIGS.map(c => c.sportKey).length` in `createIngestionDependencies` (same pattern as `traditionalSportKeys`).

---

## 7. Implementation Complexity

| Fix | Files | Complexity |
|---|---|---|
| Service restart | None | Trivial — operational step |
| Replace hardcoded sport count | `src/discord/discord-bot.service.ts`, `src/ingestion/bootstrap/ingestion-dependencies.ts` | Low — constructor parameter injection, same pattern already used for `traditionalSportKeys` |

---

## 8. Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Post-restart ROI is still -53.1% | Possible | Low | If traditional sports genuinely perform at -53.1% on 54 bets, the filter is working correctly and the number is accurate. The number changing is not the goal — correct scoping is. |
| Presence not updating after restart | Low | Low | `_updatePresence()` fires on `ClientReady` automatically; the only failure mode is Discord API unavailability at startup |
| Sport count inaccuracy after dynamic fix | None | None | `TRADITIONAL_SPORT_CONFIGS.length` is always correct at startup |
| Filter inadvertently excluding traditional matches | None | — | `Sport.category = TRADITIONAL` is set by `OddsApiSportMapper` for all Odds API sports; no traditional match has ever been stored as `ESPORTS` |
