# Live Baseline Reset — Implementation Audit

**Date:** 2026-06-12
**Constraints honored:** no data deleted, no historical records modified, no tables reset — baseline *filtering* only.
**Validation:** `npx tsc --noEmit` 0 errors · ESLint 0 errors · live verification below (env set + fallback both pass against the real database).

---

## 1. What changed

A configurable live-performance baseline. Settlements that occurred **before** `LIVE_BASELINE_DATE` are no longer counted in any LIVE metric; they remain in the database untouched.

**Configuration** (`.env`, documented in `.env.example`):

```
LIVE_BASELINE_DATE=2026-06-12T18:00:00Z
```

Semantics (`src/discord/reporting-config.ts` → `LIVE_BASELINE`):

- **Unset or unparseable** → falls back to `ROI_V2_BASELINE` (2026-06-10T20:00Z): behavior is exactly what it was before this change.
- **Set** → effective baseline = `max(LIVE_BASELINE_DATE, ROI_V2_BASELINE)`. The clamp means an operator can never accidentally re-admit the pre-V2 contaminated data by setting an early date.
- Parsed once at module load. Env is available before any module executes (`tsx --env-file` in dev; process env in prod; Prisma's dotenv also loads `.env` on import, which precedes this module in every entrypoint).

## 2. Surfaces switched to `LIVE_BASELINE`

Every place live performance is calculated now filters `settledAt >= LIVE_BASELINE`:

| Surface | File | What is gated |
|---|---|---|
| `/roi` | `src/discord/commands/roi.ts` | Live settled ideas, live W/L/P, live win rate, live P&L, live ROI, live confidence distribution |
| Rich Presence | `src/discord/discord-bot.service.ts` | Live ROI (and therefore the live component of Combined) |
| `/paper-bankroll` | `src/discord/commands/paper-bankroll.ts` | All bankroll math (live settlements only) |
| `/best-sports` | `src/discord/commands/best-sports.ts` | Per-sport live ROI/win rate |
| `/clv` | `src/discord/commands/clv.ts` | CLV over settled live rows |
| Daily summary | `src/discord/discord-notification.service.ts` | 24h window clamped to the baseline |

`ROI_V2_BASELINE` itself is unchanged and now referenced only inside `reporting-config.ts` (as the fallback/clamp).

## 3. What did NOT change

- **Historical reporting**: `src/discord/historical-seed.ts` is untouched — the seed reads only the immutable `backtest_*` tables and has no relationship to `settledAt` or the baseline.
- **Data**: zero writes. Pre-baseline `ValueOpportunity` rows keep their `betResult`, `profitLossUnits`, `settledAt`; they are simply not selected by live queries.
- **Combined** remains `Historical + Live(after baseline)` — it is derived at render time from the (unchanged) seed plus the (newly gated) live set, so it reset together with Live automatically, with both components still displayed separately.

## 4. Verification (`scripts/verify-live-baseline.ts`, read-only)

**With `LIVE_BASELINE_DATE=2026-06-12T18:00:00Z` (current `.env`):**

| Check | Result |
|---|---|
| Effective baseline = max(env, ROI_V2_BASELINE) | ✅ 2026-06-12T18:00:00Z |
| Pre-baseline settled rows excluded from live | ✅ 23 rows excluded, 0 counted (correct: nothing has settled since 18:00Z yet) |
| `/roi` Live sections | ✅ all four tracks show "no settled ideas yet" |
| `/roi` Historical sections unchanged | ✅ 14/53/5/27 seeded ideas, identical values to the seeding audit |
| Combined = Historical + Live(after baseline) | ✅ equals Historical exactly while live count is 0; will grow with new settlements |

**Fallback (env empty/unset):**

| Check | Result |
|---|---|
| Falls back to `ROI_V2_BASELINE` | ✅ effective 2026-06-10T20:00:00Z |
| Prior behavior preserved | ✅ 0 excluded, all 23 settled rows counted live again |

`tsc --noEmit` and ESLint: 0 errors.

## 5. Files

`src/discord/reporting-config.ts` (new `LIVE_BASELINE` export + parser) · `src/discord/commands/{roi,paper-bankroll,best-sports,clv}.ts` · `src/discord/discord-bot.service.ts` (presence) · `src/discord/discord-notification.service.ts` (daily summary) · `.env` / `.env.example` (new var) · `scripts/verify-live-baseline.ts` (new verification instrument). No schema changes; no migrations; no API calls.

## 6. Operational notes

- Restart required for a baseline change to take effect (parsed at boot, like all env config).
- Rich Presence will read `ROI Live: +0.0%` until the first post-baseline settlement; Combined continues to show the historical seed values immediately.
- To "reset" live tracking again in the future, set `LIVE_BASELINE_DATE` to a new instant — no data operations needed.
