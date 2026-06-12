# ROI V2 Baseline and Presence Fix

**Date:** 2026-06-10

**Objective:** Introduce a clean ROI V2 reporting baseline and fix the hardcoded Discord Rich Presence sport count.

---

## Background

Pre-baseline data was affected by:
- Incomplete settlement coverage (34 expansion leagues not settled before `TRADITIONAL-SETTLEMENT-COVERAGE-FIX.md`)
- Esports contamination in reporting queries (resolved by `TRADITIONAL-ONLY-REPORTING-FILTER.md`)
- Esports consensus corruption — false positives with corrupted edge values (documented in `CONSENSUS-DUPLICATION-EVIDENCE-AUDIT.md`)

Additionally, the Discord Rich Presence displayed a hardcoded sport count of `54` regardless of the actual number of configured sports. After the expansion to 63 sports, this was permanently stale.

All historical data remains intact and unmodified.

---

## Files Modified

| File | Type | Change |
|---|---|---|
| `src/discord/reporting-config.ts` | **New** | `ROI_V2_BASELINE` constant — single source of truth for baseline timestamp |
| `src/discord/commands/roi.ts` | Modified | Import baseline; apply as minimum cutoff for all periods |
| `src/discord/commands/paper-bankroll.ts` | Modified | Import baseline; add to `settledAt` filter |
| `src/discord/commands/best-sports.ts` | Modified | Import baseline; add to `settledAt` filter |
| `src/discord/discord-notification.service.ts` | Modified | Import baseline; clamp `since` to `max(24h_ago, ROI_V2_BASELINE)` |
| `src/discord/discord-bot.service.ts` | Modified | Import baseline; add to presence query; replace hardcoded `54` with `this._config.configuredSportCount` |
| `src/ingestion/bootstrap/ingestion-dependencies.ts` | Modified | Pass `traditionalSportKeys.length` as `configuredSportCount` in `DiscordBotConfig` |

---

## Exact Baseline Implementation

### New file: `src/discord/reporting-config.ts`

```typescript
export const ROI_V2_BASELINE = new Date('2026-06-10T20:00:00.000Z');
```

Single definition. Imported by all five reporting surfaces. Changing the baseline in one place automatically applies to every surface.

---

## Reporting Surfaces — Changes

### 1. `/roi` — `src/discord/commands/roi.ts`

**Before:**
```typescript
const cutoff = periodCutoff(period);
const where = cutoff
  ? { settledAt: { not: null, gte: cutoff }, match: { sport: { category: 'TRADITIONAL' as const } } }
  : { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } };
```

**After:**
```typescript
import { ROI_V2_BASELINE } from '../reporting-config';

const periodCut = periodCutoff(period);
// ROI V2: never look before the clean baseline; take the later of period cutoff and baseline
const cutoff = periodCut && periodCut > ROI_V2_BASELINE ? periodCut : ROI_V2_BASELINE;
const where = { settledAt: { not: null, gte: cutoff }, match: { sport: { category: 'TRADITIONAL' as const } } };
```

Period logic:
- `all` → cutoff = `ROI_V2_BASELINE` (baseline replaces the former "no cutoff" path)
- `7d` → cutoff = `max(7_days_ago, ROI_V2_BASELINE)` — if 7 days ago is before the baseline, baseline wins
- `30d` → cutoff = `max(30_days_ago, ROI_V2_BASELINE)` — same

---

### 2. `/paper-bankroll` — `src/discord/commands/paper-bankroll.ts`

**Before:**
```typescript
where: { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } },
```

**After:**
```typescript
import { ROI_V2_BASELINE } from '../reporting-config';

where: { settledAt: { not: null, gte: ROI_V2_BASELINE }, match: { sport: { category: 'TRADITIONAL' as const } } },
```

---

### 3. `/best-sports` — `src/discord/commands/best-sports.ts`

**Before:**
```typescript
where: { settledAt: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } },
```

**After:**
```typescript
import { ROI_V2_BASELINE } from '../reporting-config';

where: { settledAt: { not: null, gte: ROI_V2_BASELINE }, match: { sport: { category: 'TRADITIONAL' as const } } },
```

---

### 4. Daily Summary — `src/discord/discord-notification.service.ts`

**Before:**
```typescript
const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
```

**After:**
```typescript
import { ROI_V2_BASELINE } from './reporting-config';

const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
// ROI V2: never look before the clean baseline
const since = since24h > ROI_V2_BASELINE ? since24h : ROI_V2_BASELINE;
```

Behaviour: on 2026-06-10 and 2026-06-11, `since` resolves to `ROI_V2_BASELINE` (baseline is later than 24h ago relative to those dates). From 2026-06-11 20:00 UTC onwards, `since` resolves to the normal 24h rolling window. No behaviour change is visible once the baseline is older than 24 hours.

---

### 5. Discord Rich Presence — `src/discord/discord-bot.service.ts`

**Before (two separate issues):**
```typescript
// query: no baseline filter
where: { betResult: { not: null }, match: { sport: { category: 'TRADITIONAL' as const } } },

// hardcoded literal
const sportCount = 54;
```

**After:**
```typescript
import { ROI_V2_BASELINE } from './reporting-config';

// query: baseline applied
where: {
  betResult: { not: null },
  settledAt: { gte: ROI_V2_BASELINE },
  match: { sport: { category: 'TRADITIONAL' as const } },
},

// dynamic count from injected config
const sportCount = this._config.configuredSportCount;
```

---

## Dynamic Sport Count Implementation

### `src/discord/discord-bot.service.ts` — `DiscordBotConfig`

**Before:**
```typescript
export interface DiscordBotConfig {
  readonly token: string;
  readonly clientId: string;
  readonly guildId: string;
}
```

**After:**
```typescript
export interface DiscordBotConfig {
  readonly token: string;
  readonly clientId: string;
  readonly guildId: string;
  /** Number of configured traditional sport keys — used in Rich Presence sport count. */
  readonly configuredSportCount: number;
}
```

### `src/ingestion/bootstrap/ingestion-dependencies.ts` — `DiscordBotService` construction

**Before:**
```typescript
const discordBot = new DiscordBotService(
  { token: config.discord.token, clientId: config.discord.clientId, guildId: config.discord.guildId },
  ...
);
```

**After:**
```typescript
const discordBot = new DiscordBotService(
  {
    token: config.discord.token,
    clientId: config.discord.clientId,
    guildId: config.discord.guildId,
    configuredSportCount: traditionalSportKeys.length,
  },
  ...
);
```

`traditionalSportKeys` is already the 5th parameter of `createIngestionDependencies`, derived from `TRADITIONAL_SPORT_CONFIGS.map(c => c.sportKey)` in `app.ts`. Its `.length` (63) flows through without any additional change to `app.ts`. Future additions to `TRADITIONAL_SPORT_CONFIGS` automatically update the presence sport count on the next service restart.

---

## Presence Refresh Behaviour

`_updatePresence()` is called only on `Events.ClientReady` (bot startup) and via `refreshPresence()` (no automatic timer). After a service restart with this code:

1. Bot logs in, `ClientReady` fires.
2. `_updatePresence()` runs with the new baseline filter and dynamic sport count.
3. Presence shows: `ROI: 0.0% | 63 Sports` (assuming no post-baseline settlements yet).
4. As settlements occur after 2026-06-10T20:00Z, ROI updates on the next restart or explicit `refreshPresence()` call.

---

## Expected Behaviour After Deployment

| State | `/roi all` | `/paper-bankroll` | `/best-sports` | Presence |
|---|---|---|---|---|
| Before first post-baseline settlement | `No settled bets yet.` | 1000.00 units, 0 bets | `No settled bets yet.` | `ROI: 0.0% \| 63 Sports` |
| After first post-baseline settlement | Reflects only post-baseline bets | Reflects only post-baseline P&L | Shows only post-baseline sports | Updated on next restart |
| Historical pre-baseline data | Not shown | Not shown | Not shown | Not shown |
| Historical data in DB | **Intact — unmodified** | **Intact** | **Intact** | **Intact** |

---

## Validation Results

### TypeScript build — `npx tsc --noEmit`

**Result: 0 errors**

---

## Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Baseline date is wrong | Low | Low | Change `ROI_V2_BASELINE` in one file (`reporting-config.ts`) to correct it — propagates to all surfaces automatically |
| Historical data accidentally deleted | None | — | No data operations performed; all changes are query filters only |
| `/roi 7d` showing no data for weeks | Certain | Low | If the baseline is less than 7 days old, `7d` resolves to the baseline — same result as `all`. This normalises automatically once the baseline is older than 7 days |
| Daily summary skipping for ~24h post-baseline | Certain | Low | On 2026-06-10 and 2026-06-11, `since` resolves to the baseline (no bets exist after it yet), so the summary returns early with "no settled bets — skipping". Normal rolling-window behaviour resumes after the baseline is older than 24h |
| `configuredSportCount` stale between restarts | Certain | None | The count is set at startup from `TRADITIONAL_SPORT_CONFIGS.length`. Adding sports requires a restart to update the presence count — same as all other config changes |
| Presence sport count wrong after expansion | None | — | Derived from `traditionalSportKeys.length` at construction time; always reflects the current `TRADITIONAL_SPORT_CONFIGS` |
