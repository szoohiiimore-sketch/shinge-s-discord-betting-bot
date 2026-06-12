# Pinnacle-Led Model Implementation

**Date:** 2026-06-10
**Authority:** `docs/audits/FINAL_V1_AUDIT.md` (Sections 6, 12 item #6/#8, 13 V1.5)
**Objective:** Replace the inverted value-detection model (soft-consensus fair price, Pinnacle candidate) with the standard sharp-reference / soft-target model (de-vigged Pinnacle fair price, every soft bookmaker evaluated as candidate).

---

## Migration Summary

| | Old model (removed) | New model (implemented) |
|---|---|---|
| Fair price source | Unweighted mean of all **non-Pinnacle** implied probabilities, **vig included** | **Pinnacle only, de-vigged** (implied probabilities normalised to sum to 1) |
| Candidate (the "bet") | Pinnacle, always | **Every non-Pinnacle bookmaker, independently** |
| Opportunities per outcome | 0 or 1 (Pinnacle) | 0 to N (one per qualifying soft book) |
| Duplicate prevention | 12-hour re-alert window on (match, outcome) — same logical bet re-recorded every 12h (audit finding C3) | **Permanent**: at most one opportunity per (match, bookmaker, outcome), ever |
| Market-structure safety | None | Candidate's outcome set must exactly match the reference book's; reference overround sanity-checked |
| Suppression query | N+1 `findFirst` per candidate | One batched `findMany` per detection run |

Audit findings addressed: the sharp/soft inversion (Section 6 weakness #1), missing de-vigging (#2), N+1 suppression (Section 3), and — for all newly created data — duplicate logical-bet ROI counting (Critical C3).

---

## Files Modified

| File | Change |
|---|---|
| `src/value-detection/value-detection.service.ts` | Detection core rewritten (see formulas below). `CANDIDATE_BOOKMAKER` → `REFERENCE_BOOKMAKER = 'pinnacle'`; `MIN_CONSENSUS_BOOKMAKERS` and `SUPPRESSION_WINDOW_MS` removed; overround bounds and market-structure guard added. Public API (`detectForMatchExternalIds`) unchanged — callers (`odds-snapshot.worker.ts`, `force-scan`) untouched. |
| `src/value-detection/value-detection.types.ts` | Doc comments only — field semantics under the new model. No structural change. |
| `src/discord/discord-notification.service.ts` | One alert label: "Consensus Probability" → "Fair Probability (Pinnacle)". No logic change. |
| `src/integrations/oddspapi/oddspapi.config.ts` | Stale comment fixed (referenced the removed `MIN_CONSENSUS_BOOKMAKERS`; described Pinnacle as candidate). No logic change. |

**Not modified (verified compatible):** settlement (`settlement.service.ts`, `settlement.worker.ts`), all reporting commands (`roi`, `paper-bankroll`, `best-sports`, `value-bets`, `test-value-bets`), `reporting-config.ts` (ROI V2 baseline), TRADITIONAL-only filters, sports configuration (`app.ts`), scheduler (esports remains disabled in code — see Risks for the Redis-state caveat from the audit).

**No database migration required.** The `ValueOpportunity` schema is reused with re-mapped semantics:

| Column | Old meaning | New meaning |
|---|---|---|
| `bookmaker` | Always `'pinnacle'` | The soft candidate bookmaker |
| `bookmakerOdds` | Pinnacle's price | The candidate's price |
| `fairOdds` | 1 / soft-consensus probability (vig-included) | De-vigged Pinnacle fair odds |
| `consensusProbability` | Mean soft implied probability (vig-included) | De-vigged Pinnacle fair probability |
| `consensusBookmakers` | List of soft books averaged | `['pinnacle']` (the reference source) |

Historical rows are untouched. New-model rows are unambiguously identifiable: `consensusBookmakers = ['pinnacle']` and `bookmaker ≠ 'pinnacle'`.

---

## Exact Formulas

### Old formula (removed)

For each outcome `o` of a match, with Pinnacle price `P(o)` and soft-book prices `S₁(o)…Sₙ(o)` (n ≥ 2):

```
consensusProb(o) = (1/n) × Σᵢ (1 / Sᵢ(o))        ← raw implied probs, vig INCLUDED
fairOdds(o)      = 1 / consensusProb(o)
edge%(o)         = (P(o) / fairOdds(o) − 1) × 100
```

Opportunity when `5 ≤ edge ≤ 100` and `P(o) ≤ MAX_ALERT_ODDS`; candidate = Pinnacle.

Two structural defects (per FINAL_V1_AUDIT §5/§6): the fair price embeds the soft books' margin (inflating every edge by ~5–7%), and the strategy bets at the sharp book whenever it disagrees with stale/shaded soft books — the −EV direction.

### New formula (implemented)

Step 1 — de-vig Pinnacle across **all outcomes k of the match's H2H market**:

```
overround = Σₖ (1 / P(k))                          ← sanity-checked: 0.99 ≤ overround ≤ 1.15
fairProb(o) = (1 / P(o)) / overround               ← probabilities now sum to exactly 1
fairOdds(o) = 1 / fairProb(o)
```

Step 2 — evaluate **each non-Pinnacle bookmaker B independently**, per outcome:

```
edge%(B, o) = (S_B(o) × fairProb(o) − 1) × 100     ≡ (S_B(o) / fairOdds(o) − 1) × 100
```

Opportunity recorded for `(match, B, o)` when **all** of:
- `S_B(o) ≤ MAX_ALERT_ODDS` (3.0, unchanged, now applied to the candidate's price)
- `5.0 ≤ edge ≤ 100` (thresholds unchanged)
- B's outcome set **exactly matches** Pinnacle's outcome set (market-structure guard, see below)
- no `ValueOpportunity` row already exists for `(match, B, o)` — checked via one batched query per run

### Guards added beyond the formula

1. **Reference completeness / overround bounds.** Pinnacle must quote ≥ 2 outcomes and `Σ(1/P(k))` must lie in `[0.99, 1.15]`. A sum near 0.7 means an incomplete market (e.g. missing Draw in a 3-way) — de-vigging it would silently inflate every fair probability.
2. **Conflicting duplicate reference prices** within one batch invalidate the match (the historic duplicate-snapshot corruption cannot poison fair prices).
3. **Market-structure guard.** The candidate must quote exactly the same outcomes as Pinnacle. This was added after the live dry run exposed a real failure mode — see Validation.

---

## Before/After Example (real data, Carolina Hurricanes vs Vegas Golden Knights, batch 2026-06-10T17:00Z)

Pinnacle quoted the 2-way (incl. OT) market: `CAR 1.67 | VGK 2.32`.

```
overround     = 1/1.67 + 1/2.32              = 0.5988 + 0.4310 = 1.0299
fairProb(CAR) = 0.5988 / 1.0299              = 0.5814   → fairOdds 1.720
fairProb(VGK) = 0.4310 / 1.0299              = 0.4185   → fairOdds 2.390
```

| Candidate | Price (VGK) | Edge vs fair 2.390 | Decision |
|---|---|---|---|
| betonlineag | 2.36 | (2.36 × 0.4185 − 1) = **−1.2%** | REJECTED (below threshold) |
| smarkets | 2.36 | −1.2% | REJECTED |
| bovada | 2.30 | −3.7% | REJECTED |
| unibet_uk | 3.00 | *not compared* | **SKIPPED — market-structure mismatch** (quotes 3-way `CAR 2.07 | VGK 3.00 | Draw 4.10`; regulation-time prices are not comparable to a 2-way fair) |

Under the pre-guard implementation, unibet_uk's 3.00 would have shown a phantom **+25.6%** edge. Under the old (removed) model, the same data produced Pinnacle-candidate alerts against a vig-inflated consensus. Both failure modes are now closed.

A genuine detection from the dry run (Swedish Superettan):

```
coolbet: Sandvikens IF @ 2.70   vs   de-vigged Pinnacle fair 2.504
edge = 2.70 / 2.504 − 1 = +7.84%   → DETECTED (candidate = coolbet, reference = pinnacle)
```

---

## Validation Results

### `npx tsc --noEmit`
**0 errors.** ESLint on all four modified files: clean.

### Read-only dry run against the live database
The new service was executed over all 112 matches with snapshots in the last 72 h, with the repository stubbed to capture inserts (nothing written):

| Metric | Result |
|---|---|
| Matches analyzed | 112 |
| Opportunities detected | **1** (coolbet, +7.84% — example above) |
| Detections with `bookmaker = 'pinnacle'` | **0** ✓ |
| Rejected (edge < 5%) | 4,928 |
| Skipped (structure mismatch / no reference / odds filter / dup) | 1,081 |
| Old model replicated on identical data | **10** Pinnacle-candidate detections |

Intermediate result that motivated the market-structure guard: without it, the dry run produced 65 detections with a **22% median edge**, all from 16 European books — inspection of the raw batch proved every one was a 3-way-vs-2-way market comparison, not value. With the guard: 1 detection at a realistic 7.8%.

### Compatibility verification (by inspection of unchanged code paths)
- **Settlement** consumes `outcome`, `bookmakerOdds`, `betResult` — identical shape; `determineBetOutcome` matches outcome strings against team names exactly as before (outcome names come from the same The Odds API event for every bookmaker, so candidate-book outcomes are byte-identical to the old Pinnacle outcomes).
- **Discord alerts** — `notifyPendingOpportunities` query unchanged (still `alertedAt: null` + TRADITIONAL filter); the formatter renders any bookmaker key (known names mapped, unknown keys capitalised, e.g. "Coolbet").
- **Reporting** — `/roi`, `/paper-bankroll`, `/best-sports` aggregate `betResult`/`profitLossUnits`/`edgePercentage` only; none depend on bookmaker identity. ROI V2 baseline (`reporting-config.ts`) and TRADITIONAL filters untouched.
- **Sports configuration** untouched; **esports** remains disabled in code and was not re-enabled.

---

## Expected Behavior Changes

### Alert volume
**Sharply lower.** On identical 72-hour live data: old model 10, new model 1. Expect roughly **80–95% fewer alerts**, concentrated in thin markets (lower-division soccer, smaller leagues) where soft books are slow. Quiet days with zero alerts are normal and correct under this model. The per-bookmaker evaluation can occasionally produce bursts (one stale line at several skins of the same operator → several simultaneous opportunities on one outcome).

### Alert content
- `Bookmaker` field now names the soft book to (paper-)bet at, not Pinnacle.
- "Fair Probability (Pinnacle)" label replaces "Consensus Probability".
- Edges will look smaller and saner: 5–15% typical instead of vig-inflated values; >20% should be rare and treated with suspicion.

### Re-alert behavior
The 12-hour re-alert window is gone. Each (match, bookmaker, outcome) is recorded and alerted **at most once**, the first time it crosses the threshold. If the same outcome later becomes value at a *different* bookmaker, that is a separate opportunity and will alert.

### Expected ROI impact
- Detected bets now carry a theoretically **positive** expected value at recording time (≥ +5% vs de-vigged Pinnacle), versus the old model's structurally negative expectation (FINAL_V1_AUDIT §7 estimated −3% to −10%).
- Realistic paper-ROI expectation if Pinnacle's de-vigged price is an unbiased estimator: **0% to +5%** long-run, *not* the nominal average edge — stale-quote false positives (the candidate's snapshot price no longer actually available) and any residual reference bias eat into the nominal edge, and paper settlement at the captured price cannot detect them.
- ROI metrics for new data are no longer inflated by duplicate logical bets (each bet counted exactly once).
- **Sample-size caveat stands:** per the audit, ~100–200 alerts of CLV measurement — not ROI — is the meaningful validation instrument. At the observed detection rate (~1 per 112 matches/72h at current sport coverage), accumulating a meaningful sample will take time; that is a property of honest detection, not a defect.

---

## Risk Assessment

| Risk | Likelihood | Severity | Mitigation / Notes |
|---|---|---|---|
| Alert volume drops to near zero and the bot "feels dead" | High | Low | Expected and correct. If volume must rise, lower `MIN_EDGE_THRESHOLD_PCT` (e.g. 3%) or raise `MAX_ALERT_ODDS` consciously — do not revert the model. |
| Stale candidate quotes (book already moved/suspended the line) recorded as value | Medium | Medium | Inherent to hourly polling + paper trading; the snapshot price is used for settlement, so paper ROI is internally consistent. CLV tracking (audit P1 #7) is the real detector — still recommended as follow-up. |
| Market-structure guard too strict (drops candidates quoting same structure under different outcome names) | Low | Low | Outcome names come from the same The Odds API event payload and are identical across bookmakers; only genuinely different market structures differ. |
| Mixed-model contamination of ROI V2 window | **Certain, short-lived** | Medium | The V2 baseline filters on `settledAt ≥ 2026-06-10T20:00Z`. **18 legacy pending Pinnacle-candidate opportunities exist** and will settle after the baseline, mixing old-model results into the "clean" window. Optional one-line follow-up if a pure new-model window is wanted: add `bookmaker: { not: 'pinnacle' }` to the reporting filters, or move the baseline to a `capturedAt`-based cutoff. Not applied here (requirements: keep reporting/baseline functionality unchanged). |
| Legacy esports cron jobs still in Redis (FINAL_V1_AUDIT C1) | Pre-existing | Medium | Unrelated to and unchanged by this migration; if those jobs fire they now run through the *new* detection (Pinnacle-referenced, candidate-deduped), which is strictly safer than before — but the audit's P0 #1 (remove the repeatables) still applies. |
| Permanent dedup suppresses a "better" later price at the same book | Certain | Low | By design — one logical paper bet per (match, book, outcome). The first qualifying price is the recorded bet. |
| `consensusProbability`/`consensusBookmakers` column names no longer match their semantics | Certain | Low | Documented above; columns are display-only in all consumers. A rename migration is cosmetic and deferred. |

---

## Rollback Procedure

1. **Code:** `git revert` the migration commit (or restore the four modified files from the parent commit). The old service is fully self-contained; no other component changed behaviorally.
2. **Data:** no migration to undo. New-model rows are exactly those with `consensusBookmakers = ARRAY['pinnacle']` and `bookmaker <> 'pinnacle'`. To purge them (optional):
   ```sql
   DELETE FROM value_opportunities
   WHERE consensus_bookmakers = ARRAY['pinnacle']::text[]
     AND bookmaker <> 'pinnacle';
   ```
   Leaving them in place is also safe — settlement and reporting handle them like any other row.
3. **Discord:** the alert-label change reverts with the code; no command re-registration needed (labels are message content, not command schema).
4. **No Redis or schema state** was created by this migration; nothing else to clean.
