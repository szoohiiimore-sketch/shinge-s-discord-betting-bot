# Pinnacle Movement Annotation — Implementation Audit

**Date:** 2026-06-10
**Authority:** `docs/audits/HISTORICAL_ODDS_ROI_AUDIT.md` (Part 5 — Minimal ROI Improvement; Part 8 P1 "Movement annotation from existing snapshots")
**Objective:** Annotate every newly created `ValueOpportunity` with Pinnacle's trailing price movement (1 h / 6 h / 24 h) computed from existing `OddsSnapshot` data — **analytics only**. No detection, alerting, threshold, scheduler, or bookmaker-filter behaviour changes.

---

## Files Modified

| File | Change |
|---|---|
| `prisma/schema.prisma` | Three nullable columns on `ValueOpportunity`: `pinnacleMove1h Decimal?`, `pinnacleMove6h Decimal?`, `pinnacleMove24h Decimal?` |
| `prisma/migrations/20260610213411_add_pinnacle_movement/` | **Applied to database.** Additive nullable columns — zero risk to existing rows. |
| `src/value-detection/value-detection.types.ts` | `ValueOpportunityInsert` gains the three nullable movement fields (documented sign convention) |
| `src/value-detection/value-detection.service.ts` | New pure helper `referenceMovementPct()`; per-match `referenceHistory` map built from already-loaded snapshots; the three fields computed at insert time. **No change to any detection decision path.** |
| `src/value-detection/value-opportunity.repository.ts` | Pass-through of the three fields in `createMany` |
| `src/discord/commands/clv.ts` | `/clv` gains a "CLV by Pinnacle movement (production)" section: average CLV per movement group (positive / neutral / negative) per window (1 h / 6 h / 24 h) |

**Untouched:** alert messages, `notifyPendingOpportunities`, daily summary, ROI commands, Rich Presence, settlement, scheduler, ingestion, thresholds (3% / 2% shadow), bookmaker handling, dedup logic.

---

## Schema Changes

```prisma
/// Pinnacle price movement % for the alerted outcome over the trailing window at capture:
/// (latest price / oldest price in window − 1) × 100. Negative = price shortened (market
/// moved TOWARD the outcome). Null when no earlier Pinnacle snapshot exists in the window.
/// Analytics only — never used by detection, alerting, or settlement.
pinnacleMove1h       Decimal?  @map("pinnacle_move_1h")
pinnacleMove6h       Decimal?  @map("pinnacle_move_6h")
pinnacleMove24h      Decimal?  @map("pinnacle_move_24h")
```

No new indexes — the fields are written once at insert and read only by analytics queries that already filter on indexed columns.

---

## Exact Calculation

For each detected opportunity (production *and* shadow), at insert time:

```
window  = [latestCapturedAt − N hours, latestCapturedAt)        N ∈ {1, 6, 24}
oldest  = earliest Pinnacle snapshot for the alerted outcome inside the window
          (the latest batch itself is EXCLUDED — movement needs an earlier observation)
latest  = Pinnacle's price for the outcome in the latest batch
          (the same price the detector de-vigged for fair probability)

pinnacleMoveNh = (latest / oldest − 1) × 100
               = null  when no earlier snapshot exists in the window
```

**Sign convention (documented in schema, types, and service):**
- **Negative** — Pinnacle's price shortened → the market moved **toward** the outcome (the "LAG/steam-in" profile: sharp information arriving, soft book potentially stale → the textbook value case).
- **Positive** — Pinnacle's price drifted out → the market moved **away** from the outcome.
- **Null** — insufficient history in the window (not zero movement; genuinely unknown).

**Data source — zero new I/O:** the detection service already loads *every* snapshot batch for the matches being analyzed (its query has no time filter; the latest-batch restriction is applied in memory). The movement computation reuses those already-loaded rows: **no new database query, no new API call, no quota impact whatsoever.** Invalid prices (≤ 1) are excluded exactly as in detection.

---

## Validation

### `npx tsc --noEmit`
**0 errors.** ESLint on all four changed source files: clean. Migration applied to the Neon database; Prisma client types regenerated (the only generate warning was the usual benign Windows file-lock on the unchanged query-engine DLL — 41 references to the new fields confirmed in generated types).

### Behavioural invariants verified
- **No new API calls** — computation uses the in-memory snapshot rows the detector already fetched.
- **No scheduler changes** — `ingestion-scheduler.ts`, sport configs, and polling intervals untouched.
- **No detection changes** — thresholds, guards, dedup, and the DETECTED/SHADOW decision tree are byte-identical in logic; the only addition is three extra fields on the insert payload.
- **No alert volume changes** — `notifyPendingOpportunities` and its query are untouched; movement fields are not read anywhere in the alert path.

### Read-only dry run over live data (`scripts/movement-annotation-dryrun.ts`)

Replicating the exact computation across all 166 traditional match-outcomes with Pinnacle quotes:

| Window | Non-null coverage | Why |
|---|---|---|
| 1 h | **66%** | At hourly polling cadence the previous batch sometimes falls just outside the 1 h window (p50 inter-batch gap = 60 min) — expected; improves automatically if near-kickoff polling lands |
| 6 h | **100%** | Always ≥1 earlier batch within 6 h |
| 24 h | **100%** | — |

Real examples found by the dry run:

```
San Diego Padres vs Cincinnati Reds | Cincinnati Reds  | latest=1.79 | 1h: +1.13% | 6h: −2.19% | 24h: −7.25%
  → Pinnacle shortened the Reds 7.25% over 24h — strong steam toward the outcome.
    An alert on the Reds at a soft book here would be the classic LAG profile.

Varbergs BoIS vs Norrby IF | Norrby IF | latest=5.47 | 1h: null | 6h: +5.60% | 24h: +14.20%
  → Pinnacle drifted Norrby OUT 14% in 24h. An alert on Norrby here would mean the soft
    book is generous on an outcome the sharp market is abandoning — the suspect profile.
```

These two examples are precisely the distinction the annotation exists to quantify.

---

## `/clv` Movement Analytics

Production CLV rows are now grouped per window by movement class (band: **neutral = |move| ≤ 1%**, positive = > +1% drift-out, negative = < −1% steam-in). Rendered section (appears only once movement-annotated production bets have settled with CLV):

```
**CLV by Pinnacle movement (production)**
1h: ↑out +0.40% (n=3) | →flat +1.10% (n=8) | ↓in +2.30% (n=4)
6h: ↑out −0.20% (n=5) | →flat +0.90% (n=6) | ↓in +2.80% (n=4)
24h: ...
*Movement = Pinnacle price change before capture: ↓in = market moved toward outcome, ↑out = away, →flat = within ±1%.*
```

Groups with n = 0 are omitted; windows with no movement data are omitted; the whole section is omitted when nothing is annotated yet. Shadow rows are not mixed into this section (production only, as specified) but carry the same fields for separate SQL analysis.

---

## Storage & Query Impact

- **Storage:** 3 nullable decimals per opportunity row. At projected volume (~5 production + ~15 shadow rows/day) this is a few hundred bytes/day — nil.
- **Insert-path cost:** zero extra queries; O(batches × outcomes) in-memory scan per match, on data already loaded; detection-run duration impact is microseconds.
- **`/clv` query:** the production `findMany` selects three more columns on the same indexed filter — no plan change.
- **Settlement:** untouched; movement fields are written once at detection and never updated.

---

## Future ROI Use Cases (the reason this exists)

1. **LAG vs OUTLIER verdict (primary).** After ~4–6 weeks, `/clv` (or one SQL query) answers: do alerts with confirming steam-in movement (`pinnacleMove6h < −1%`) carry higher CLV than flat/drift-out alerts? If yes → promote annotation to a filter (one-line change, data-justified, projected +0.5–2%/bet per `HISTORICAL_ODDS_ROI_AUDIT.md` Part 3.5). If no → the filter idea is killed cheaply, with evidence.
2. **Threshold interaction.** Cross-tab movement class × edge bucket (production vs shadow) to learn whether small edges with confirming movement outperform large edges without it — direct input to the next threshold revision.
3. **ROI / win-rate correlation.** Movement fields joined against `betResult` / `profitLossUnits` measure whether steam-confirmed bets win more — slower-converging than CLV but free to track from the same columns.
4. **Stale-quote forensics.** Extreme-CLV outliers can be checked for the drift-out signature (`pinnacleMove24h ≫ 0`) — quantifying the ghost-price problem before deciding on a corroboration guard.

---

## Rollback Procedure

1. **Code:** revert the commit — detection stops computing the fields, `/clv` loses the movement section. Already-written movement values remain (harmless, still analytically useful).
2. **Schema:** columns are nullable and additive; leave in place, or drop with
   `ALTER TABLE value_opportunities DROP COLUMN pinnacle_move_1h, DROP COLUMN pinnacle_move_6h, DROP COLUMN pinnacle_move_24h;`
3. No Redis, scheduler, queue, or API state involved.

---

## Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Detection behaviour changes | None | High | Movement computation occurs after every decision gate; it only enriches the insert payload. Thresholds/guards/dedup untouched (verified by diff scope). |
| Alert volume / Discord output changes | None | Medium | Alert path does not read the new fields; `/clv` is the only surface change, and its new section is additive and self-hiding when empty. |
| API quota increase | None | Medium | Zero new external calls; computation is in-memory on already-fetched rows. |
| 1 h window frequently null at current cadence | Certain (~34%) | Low | Expected and documented; null ≠ 0 (unknown, excluded from grouping). 6 h/24 h are 100% covered and are the analytically primary windows. Near-kickoff polling (P1) will lift 1 h coverage as a side effect. |
| Sign-convention confusion in later analysis | Low | Medium | Convention (negative = steam toward outcome) documented identically in schema comment, insert type, service helper, and `/clv` legend. |
| `/clv` message exceeds Discord 2000-char limit | Low | Low | Section adds ≤ ~5 lines; current total stays well under limit. |

---

*Read-only verification instrument retained at `scripts/movement-annotation-dryrun.ts`.*
