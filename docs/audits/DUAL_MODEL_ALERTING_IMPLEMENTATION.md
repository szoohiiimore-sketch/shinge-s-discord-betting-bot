# Dual-Model Alerting — Implementation Audit

**Date:** 2026-06-12
**Authority:** `LEGACY_VS_PINNACLE_MODEL_AUDIT.md` final verdict (option C — run both simultaneously, decide on real live settlement data).
**Validation:** `npx tsc --noEmit` 0 errors · ESLint 0 errors · offline render verification below.

---

## 1. What Runs Now

Both detection models execute **on every detection pass, over the same in-memory snapshot batch** (zero extra API calls, zero extra DB snapshot reads):

1. **PINNACLE_LED** — the shared pure core (`detector-core.ts`), unchanged: de-vigged Pinnacle reference, 3% production / 2% shadow tiers, all guards, permanent tier-aware dedup.
2. **LEGACY** — `src/value-detection/legacy-detector-core.ts` (moved from the backtest package so live code never imports `src/backtest`): bets Pinnacle's own price at ≥5% above the vig-inflated soft-book mean, no shadow tier, **12-hour suppression window per (match, outcome)** keyed on row capture time (documented deviation: the original keyed on `alertedAt`, whose semantics the idea-level alert layer changed).

Opportunities are stored in the same `value_opportunities` table, **separated by the `model` column**; dedup state is fully independent per model (Pinnacle-led keys are built only from `PINNACLE_LED` rows; legacy windows only from `LEGACY` rows). Neither model can suppress, merge with, or starve the other.

## 2. Schema Changes

- New enum **`DetectionModel { LEGACY, PINNACLE_LED }`**; column `value_opportunities.model` (default `PINNACLE_LED`) + index. Migration `20260612081103_add_detection_model`.
- **Backfill included in the migration:** historical rows with `bookmaker = 'pinnacle'` were set to `LEGACY` — the Pinnacle-led model never inserts Pinnacle as a candidate, so this is an exact discriminator for the pre-rewrite era. Attribution is therefore correct across the entire table's history.
- `ValueOpportunityInsert` carries `model`; the repository persists it; `ValueDetectionResult` gains `legacyOpportunitiesDetected`.

## 3. Attribution Through the Pipeline

| Stage | How attribution survives |
|---|---|
| Detection | Each model's pass tags its inserts; legacy decisions logged with `model: 'LEGACY'` context (excluded from the Pinnacle-led counters, which keep their meaning) |
| Persistence | `model` column, indexed |
| Notifications | Pending rows are **partitioned by model before idea grouping** — the same (match, outcome) alerts once per model, each tagged (§4). Alerted-sibling/upgrade baselines are matched within the model only |
| Settlement | Unchanged — row-level by match result, model-agnostic by design; legacy rows settle identically |
| CLV | Unchanged — per-row vs the de-vigged Pinnacle close; both models share the same measuring stick (the legacy-vs-Pinnacle audit documents the interpretive caveat) |
| ROI / reporting | All idea aggregation is computed **strictly within a model** everywhere (`/roi`, `/paper-bankroll`, `/clv`, daily summary, Rich Presence) — ideas never merge across models |
| Movement annotation | Unchanged; legacy rows get the same Pinnacle trailing-movement columns |

## 4. Discord Notifications

`MODEL_TAG` is rendered in bold directly under every alert and upgrade title. Verified output from the real formatter (`scripts/verify-dual-model-alerts.ts`):

```
🎯 **VALUE BET — Landskrona BoIS**
**(EXPERIMENTAL PINNACLE-LED SYSTEM)**
⚽ Soccer | Helsingborgs IF vs Landskrona BoIS | Superettan
🕐 2026-06-12 17:00 UTC (12/06/2026 19:00 Budapest)

💰 **Best:** 2.95 @ Coolbet  (edge +4.6%, fair 2.82)
📋 **Also:** 2.88 @ Unibet (+3.6%)

📊 Books agreeing: 2 families | Pinnacle 6h: -2.4% (moving toward outcome)
```

```
🎯 **VALUE BET — Landskrona BoIS**
**(LEGACY SYSTEM)**
⚽ Soccer | Helsingborgs IF vs Landskrona BoIS | Superettan
🕐 2026-06-12 17:00 UTC (12/06/2026 19:00 Budapest)

💰 **Best:** 2.60 @ Pinnacle  (edge +6.2%, fair 2.45)

📊 Books agreeing: 1 family | Pinnacle 6h: -2.4% (moving toward outcome)
```

Legacy alerts flow through the same idea-level layer (one alert per idea + the upgrade rule) — a deliberate, documented deviation from the original 12-hour *re-alerting*: detection-level re-detects every 12 h still create the rows (preserving legacy's data-generation behavior for ROI), but Discord sends one message per idea, keeping the channel usable. Upgrades carry the model tag too.

## 5. Reporting Changes

- `/roi`, `/clv`, `/paper-bankroll` gained a **`model` option: Combined (default) / Legacy only / Pinnacle-led only**. Combined shows a clearly-labelled section per model; single-model views restrict to that model. Win rate, P&L, ROI, idea counts, row counts, and CLV (avg/median/positive%) are all per-model.
- **Daily summary**: one section per model with idea-level W/L/void, win rate, P&L, ROI, and idea CLV.
- **Rich Presence**: per-model idea aggregation summed (cross-model merging prevented).
- `/best-sports`, `/value-bets`, `/test-value-bets`: behavior preserved (combined); candidates for per-model options later.

## 6. Verification Results

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| ESLint (`--quiet`) | ✅ 0 errors |
| 1. Legacy alerts show **(LEGACY SYSTEM)** | ✅ rendered via the real formatter, asserted on line 2 |
| 2. Pinnacle alerts show **(EXPERIMENTAL PINNACLE-LED SYSTEM)** | ✅ same |
| 3. Both models generate alerts simultaneously | ✅ independent partitions render side by side; detection passes share one batch read |
| 4. Reporting separates by model | ✅ all five surfaces partition before idea aggregation; `/roi`/`/clv`/`/paper-bankroll` expose model views |
| Backwards compatibility | ✅ settlement/CLV/movement untouched; existing rows backfilled with correct attribution; pre-existing audits' numbers unaffected (they read Pinnacle-led-only data which retains its default attribution) |

## 7. Expected Live Behavior & The Decision Rule

From the backtests: LEGACY ≈ 11 ideas/day, PINNACLE_LED ≈ 1–3 ideas/day. The legacy arm will dominate channel volume — that is the point: it generates the real-settlement ROI sample (~200 ideas in ~3 weeks) that the model comparison needs. Decision criterion (carried from `LEGACY_VS_PINNACLE_MODEL_AUDIT.md`): after ~150–200 settled legacy ideas with real results, compare per-model ROI with CLV as the diagnostic; the winner becomes primary, the loser is demoted to shadow or retired. If legacy channel volume is unacceptable before then, mute it to a separate channel — do not turn it off; the data is the product.

## 8. Files Changed

`prisma/schema.prisma` + migration (enum, column, index, backfill) · `src/value-detection/legacy-detector-core.ts` (moved in from backtest) · `value-detection.types.ts` · `value-detection.service.ts` (parallel legacy pass + per-model dedup) · `value-opportunity.repository.ts` · `index.ts` · `src/backtest/{replay,types,index}.ts` (import path updates) · `src/discord/discord-notification.service.ts` (tags, per-model partitioning, per-model daily summary) · `src/discord/reporting-config.ts` (ModelFilter helpers) · `src/discord/commands/{roi,clv,paper-bankroll}.ts` · `src/discord/discord-bot.service.ts` (command options, presence) · `scripts/verify-dual-model-alerts.ts` (new verification instrument).
