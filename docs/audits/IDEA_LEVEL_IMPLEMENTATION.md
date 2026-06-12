# Idea-Level Alerting & Accounting — Implementation Audit

**Date:** 2026-06-11
**Authority:** `docs/audits/IDEA_LEVEL_ARCHITECTURE_DESIGN.md` (implemented as audited; no redesign) and `docs/audits/ALERT_STRATEGY_REVIEW.md` (verdict B/D: one alert per betting idea, storage unchanged).
**Validation:** `npx tsc --noEmit` — **0 errors**; ESLint clean on all changed files (one pre-existing warning on an untouched line); live-data replay verification below.

---

## Files Modified / Created

| File | Change |
|---|---|
| `src/value-detection/idea-aggregation.ts` | **New** — the entire derived idea layer: bookmaker family map, exchange set, `ideaKey`, `groupIdeas`, `selectHeadline`, `corroborationCount`, `aggregateSettledIdeas` |
| `src/value-detection/index.ts` | Exports the new module |
| `src/discord/discord-notification.service.ts` | `notifyPendingOpportunities` rewritten to idea-level (group → one message per idea → stamp all member rows); old per-row `formatAlert` replaced by `formatIdeaAlert` + `formatUpgradeAlert`; daily summary converted to idea-level accounting |
| `src/discord/discord-bot.service.ts` | Rich Presence ROI converted to idea-level accounting |
| `src/discord/commands/roi.ts` | `/roi` converted to idea-level accounting ("Ideas: N … from M bookmaker rows") |
| `src/discord/commands/paper-bankroll.ts` | `/paper-bankroll` converted to idea-level accounting |
| `src/discord/commands/clv.ts` | CLV gate metrics converted to ideas (headline-row CLV); row-level per-book diagnostic line retained; movement analytics now idea-denominated |
| `scripts/idea-aggregation-verify.ts` | **New** — read-only replay of the aggregation over real production rows |

**Untouched (storage freeze honored):** `prisma/schema.prisma` — **no migration, no new columns, no new tables.** `ValueOpportunity` rows, per-bookmaker CLV at settlement, tier-aware permanent dedup, movement annotation, detection thresholds, scheduler, settlement — all byte-identical in behaviour. `/best-sports`, `/value-bets`, `/test-value-bets` remain row-denominated diagnostics as designed. No historical row was modified, recomputed, or migrated.

---

## Aggregation Logic (as implemented)

**Idea key:** `${matchId}|${outcome}` — `ideaKey()` in `idea-aggregation.ts`. Market joins the key when `ValueOpportunity` gains a market column (H2H-only today; documented in the module header per the design).

**Headline row** (`selectHeadline`): best-odds **non-exchange** row; tie-break earliest `createdAt`; falls back to the best exchange row **only** when an idea has no non-exchange member — this fallback applies to *accounting* (so the two already-alerted legacy Wings exchange rows still settle into a countable idea) but never to *alerting* (`formatIdeaAlert` returns null for exchange-only ideas → silent stamp, no message).

**Family collapse** (`bookmakerFamily`): exact-key map — betsson/nordicbet → `betsson-group`, ladbrokes_uk/coral → `entain`, betonlineag/lowvig → `betonline-group`; prefix map — `betfair*`, `unibet*`, `leovegas*`, `winamax*`, `williamhill*` each collapse to one family; everything else is its own family. **Exchange set:** betfair_ex_uk, betfair_ex_eu, smarkets, matchbook — never headline (in alerts), never counted in corroboration.

**Corroboration k** (`corroborationCount`): distinct families among an idea's members, exchanges excluded.

**Idea accounting** (`aggregateSettledIdeas`): group settled rows → one headline row per idea → all headline metrics (result, P&L, CLV, edge, movement) read from that single row. One flat unit per idea.

---

## Alert Lifecycle (as implemented)

1. Pending production rows (`alertedAt: null, isShadow: false`, TRADITIONAL) are grouped into ideas; **one Discord message per idea**; all member rows stamped `alertedAt` in a single `updateMany` after a successful send (or after a silent-stamp decision). Send failure → no stamp → retried next run, per idea.
2. **Already-alerted ideas** (detected via a sibling query on the same matches): new qualifying rows are stamped silently unless the **upgrade rule** fires — new best non-exchange odds ≥ **2%** above the alerted best, or edge ≥ **+1.5 pp** above the alerted best — then exactly one `⬆️ UPGRADE` message. The rule is measured against the *currently alerted best*, so successive upgrades each require a further 2% — naturally self-limiting (the design's "max one per idea" achieved without new state).
3. **Exchange-only ideas:** never alerted, stamped silently (soft exchange exclusion at the alert layer; storage still records the rows).
4. `alertedAt` semantics (documented in the method comment): "row consumed by the idea-level alert layer," not "message sent for this row."

**Alert format (live production rows rendered through the new formatter):**

```
🎯 **VALUE BET — Landskrona BoIS**
⚽ Soccer | Helsingborgs IF vs Landskrona BoIS | Superettan
🕐 2026-06-11 17:00 UTC (19:00 Budapest)

💰 **Best:** 2.95 @ Coolbet  (edge +4.6%, fair 2.82)
📋 **Also:** 2.88 @ Unibet (+3.6%) · 2.88 @ Leovegas (+3.6%)

📊 Books agreeing: 3 families | Pinnacle 6h: +5.6% (moving away from outcome)
```

Alternatives are family-deduped (best skin per family, headline's family excluded, max 6 listed); movement comes from the headline row's stored `pinnacleMove6h` (omitted when null).

---

## Before / After — Real Data Replay

`scripts/idea-aggregation-verify.ts` replayed the layer over the actual production rows that generated yesterday's 5 alerts:

| Idea | Member rows | Headline | k | Old alerts | New alerts |
|---|---|---|---|---|---|
| Landskrona BoIS (Helsingborgs IF vs Landskrona BoIS) | unibet_se@2.88, leovegas_se@2.88, coolbet@2.95 | **coolbet@2.95** | **3** | 3 messages | **1 message** |
| Phoenix Mercury (Dallas Wings vs Phoenix Mercury) | betfair_ex_uk@3.40 (EX), betfair_ex_eu@3.40 (EX) | betfair_ex_uk@3.40 (accounting fallback) | **0** | 2 messages | **0 messages** (exchange-only → silent) |
| **Total** | 5 rows | — | — | **5 alerts** | **1 alert** |

Accounting: `aggregateSettledIdeas` over the same rows → **2 ideas** (was: 5 row-bets). When these settle, `/roi` will report 2 bets, not 5 perfectly correlated ones.

---

## Impact Assessment

**Alert volume:** observed replay −80% on day-one data (5→1); steady-state expectation −50 to −70% (the design's −60% midpoint), with every surviving message strictly richer (best price + alternatives + k + movement). Coverage expansion (`au`/`us2`) now improves alerts instead of multiplying them.

**ROI:** headline metrics are now idea-denominated everywhere the requirement listed (`/roi`, `/paper-bankroll`, daily summary, Rich Presence). Per-bet paper ROI improves mechanically (headline = best price: Helsingborgs records 2.95, not the 2.88 a row-average would dilute toward). Because zero rows have settled post-baseline, **no displayed number changes at cutover** — the zero-cost migration window identified in the design was used.

**CLV:** the V1.5 gate now counts independent observations — "150–200 bets" means 150–200 *ideas*. At the observed 2.5:1 row inflation this is the difference between a real confidence interval and a fictional one. Row-level CLV remains visible (`/clv` per-book diagnostic line) and fully queryable for book-softness analysis. Movement analytics (1h/6h/24h × positive/neutral/negative) now read headline rows.

**Statistical integrity:** the correlated-pseudo-replication channel (audit finding: C3's ghost at bookmaker level) is closed for every headline surface before the first contaminated settlement could occur.

---

## Rollback Procedure

1. Revert the commit — all surfaces return to row-level; no data cleanup needed because **nothing was migrated and no schema changed** (aggregation is read-time only).
2. The only irreversible artifacts are cosmetic: any idea-level alerts already sent, and `alertedAt` stamps on rows that under the old system would each have produced their own message (they would simply not re-alert — old behaviour for already-stamped rows is identical).
3. `idea-aggregation.ts` can remain harmlessly if unreferenced.

---

## Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Duplicate alerts for one idea | None | High | One message per `groupIdeas` entry; member rows stamped atomically per idea; already-alerted ideas detected via sibling query before sending |
| Idea silently never alerted | Low | Medium | Only exchange-only ideas (by design) and upgrade-rule suppressions; both logged at debug with explicit reason |
| Alert send fails mid-run | Low | Low | Per-idea try/catch: failed idea is not stamped and retries next run; other ideas unaffected |
| Headline favors ghost prices | Medium | Medium | Known max-order-statistic tilt (design §4); mitigated by exchange exclusion in headline, k display, movement context; movement-class CLV will quantify it |
| Family map incomplete (e.g. grosvenor/casumo) | Medium | Low | Map covers all seven required groups + williamhill; unknown keys degrade gracefully to identity (k slightly overstated, never understated alerts) |
| Mixed settle-times split an idea across daily-summary windows | Low | Low | Members of one idea settle in the same settlement run in practice; worst case an idea is counted once per window with partial members — headline selection within window still yields one unit |
| Legacy old-model rows (bookmaker='pinnacle') | None | — | One candidate book → row ≈ idea; grouping is a no-op for them; any residual time-window duplicates collapse correctly (improvement, not regression) |
| Historical data integrity | None | — | No recompute, no migration, no modification of settled records — derived aggregation only, verified by diff scope |

---

## Requirement Verification

| Requirement | Status |
|---|---|
| Storage unchanged (rows, per-book CLV, tier dedup, movement) | ✅ No schema change, no migration, detection/settlement untouched |
| Derived idea layer keyed (matchId, outcome [, market]) | ✅ `idea-aggregation.ts` |
| One alert per idea; best non-exchange headline; alternatives; family-collapsed k; movement shown | ✅ `formatIdeaAlert` (replay: 5 alerts → 1) |
| ROI / Paper Bankroll / Daily Summary / Rich Presence idea-denominated, one unit per idea | ✅ All four converted |
| CLV gate on ideas; headline CLV = headline row; row-level diagnostics retained | ✅ `/clv` restructured |
| Family collapsing: betfair_ex_*, unibet_*, leovegas*, winamax_*, betsson/nordicbet, ladbrokes/coral, betonlineag/lowvig | ✅ All seven + williamhill prefix |
| No historical recompute / migration / destructive change | ✅ Read-time aggregation only |
| `npx tsc --noEmit` | ✅ 0 errors |
