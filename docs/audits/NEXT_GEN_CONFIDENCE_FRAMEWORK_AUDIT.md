# Next-Gen Confidence Framework — Audit, Replacement & Rollout

**Date:** 2026-06-14
**Type:** Audit → redesign → **implementation → validation → production rollout.** Not audit-only.
**Allowed changes (and the only ones made):** confidence grading logic, confidence presentation, alert presentation. **Untouched:** detection models, edge thresholds, sports, seasonality, settlement, model selection, value-detection logic.
**Credits spent: 0** — built and validated entirely on realized live settlement data.
**Validation:** `tsc` clean · ESLint clean · shipped function reproduces the validated numbers exactly.

---

## Executive Summary

The legacy A/B/C confidence grade was **defective by construction** and is now **deleted and replaced**. Re-validated on current data (n=106 settled traditional ideas):

- **Old Grade A realized −20.3%, *worse* than B (−11.3%); Grade C was structurally impossible (0 ever).** Confirmed, not assumed.
- Root cause: its three signals were `consensus≥10` (fires on **100%** of alerts → a constant; makes C impossible), `steam-out` (rewards a realized-**losing** class), and `edge≥8%` (rests on 5 bets). All were fit to **backtest CLV**, not realized ROI.

The replacement (`alert-confidence.ts`) grades on **only the two signals validated against realized W/L**, framed as the **absence of the two empirically-worst alert traits**:

- **Red flag 1 — FLAT LINE** (`|6h Pinnacle move| < 1%`): realized **−46.6%, CI [−83.8, −9.3]** — the only segment whose CI excludes zero.
- **Red flag 2 — EXTREME ODDS** (`odds < 1.80 or ≥ 3.00`): the 1.80–3.00 mid-range realized better than both extremes.

`0 flags → A · 1 → B · 2 → C`, applied **authoritatively to all four models** (old grade was legacy-only).

**Validation result (Part 6):** the new grade is **correctly ordered** — A +9.5% > B −10.4% > **C −57% (CI [−101, −13], excludes zero)** — versus the old grade's inversion. **Honest caveat:** flags were derived from the same sample they were validated on (in-sample), and only **C separates robustly**; the A-vs-B distinction is weak (−6.5% vs −5.5% on legacy-family alone). **The new grade reliably flags BAD alerts; it does not certify GOOD ones.** It is strictly better-founded than the old (no constant, no inverse, no impossible state, no CLV) — which is sufficient to justify replacement even with modest predictive power.

---

## Part 1 — Current System Re-validation (don't assume; re-check)

Re-ran on current data (n=106). Prior conclusions **all confirmed**:

| Old grade | n | W–L | Win% | ROI | 95% CI |
|---|---|---|---|---|---|
| **A** | 24 | 9–15 | 37.5% | **−20.3%** | [−64.1, +23.5] |
| **B** | 23 | 11–12 | 47.8% | −11.3% | [−50.7, +28.1] |
| **C** | 0 | — | — | — | impossible |

A is the worst; C never occurs. Confirmed valid.

---

## Part 2 / Root Cause — why the old grade failed

| Old signal | Fires on | Realized when ON | Defect |
|---|---|---|---|
| `consensus ≥ 10` | **94/94 (100%)** | — | **Constant** — adds +1 to everyone → **C impossible**, zero discrimination |
| `steam-out (move6h ≥ +1%)` | 28/94 | **−10.4%** | **Wrong-signed** — rewards a losing class; ignores "no-history" (+1.9%) and steam-in (+29%) |
| `edge ≥ 8%` | 5/94 | +63% (n=5) | **5-bet basis**; the 89 it grades down realized −15.7% |

Because consensus is always-on, **Grade A ≈ "steam-out OR edge≥8" = the losing profile.** All three signals were chosen from a 47-day **backtest CLV** sample and never validated on realized ROI — the original sin.

---

## Part 3 — New Confidence Framework

**Principle:** grade only on signals validated against **realized W/L**; express the grade as *absence of empirically-worst traits* (honest — it flags bad, doesn't promise good). Variables **kept** (with data) and **removed** (with data):

| Variable | Decision | Realized evidence |
|---|---|---|
| **6h line flatness** | **KEEP** (red flag) | flat −46.6%, CI [−83.8,−9.3] (only CI excluding 0); \|move6h\| is the #2 predictive feature |
| **Odds range** | **KEEP** (red flag) | mid-range 1.80–3.00 > extremes (1.40–1.80 ≈ −30%, 3.00+ ≈ −10%); odds is the #1 separator (z=−1.96) |
| `consensus ≥ 10` | **REMOVE** | constant (100% fire) → no signal, makes C impossible |
| `steam-out` direction | **REMOVE** | realized −10.4%; wrong-signed (magnitude matters, not direction) |
| `edge ≥ 8%` | **REMOVE** | inverse/5-bet; edge is non-predictive-to-inverse for ROI |
| books-agreeing (k) | **REMOVE from grade** | degenerate (99/106 are k=1); no signal |
| sport / league | **EXCLUDE from grade** | every CI ∋ 0; insufficient evidence; would overfit |

**Structure chosen: A/B/C** (= 0/1/2 red flags). Rationale over numerical/percentile: it is **familiar to Discord users**, maps cleanly to an explainable rule ("A = no red flags; C = both"), and avoids the **false precision** a percentage/percentile would imply at n=106. Null 6h movement (no history) is **not** flagged (realized neutral-positive).

```
flags = (flat line ? 1 : 0) + (extreme odds ? 1 : 0)
A = 0 flags · B = 1 · C = 2
```

---

## Part 4 / 5 — Alert & Edge Presentation Changes

**Alert payload review (Part 4):**

| Field | Verdict | Action |
|---|---|---|
| Edge % / fair odds | **Value, but not quality** | Keep (it's the bet's definition); no longer implied as quality |
| **Confidence grade** | **Was misleading** | **Replaced** — now `🏅 Quality: A — no red flags` / `🏅 Quality: C — red flags: flat line, extreme odds`, shown for **all** models |
| Books-agreeing (k) | **Non-predictive** | Retained as raw corroboration info only (not a quality claim) |
| Pinnacle 6h movement | **Now meaningful** | Retained — it drives the grade; the flat case is the strongest red flag |

The Discord line changed from a bare `🔠 Confidence: A` (legacy-family only, misleading) to **`🏅 Quality: <grade> — <red-flag explanation>`** on every model, so the grade's *meaning* is visible.

**Edge presentation (Part 5):** **No change to the displayed edge**, deliberately. A calibrated/percentile/risk-adjusted edge would require a reliable edge→realized-ROI map, which **cannot be built at n=106** without false precision (and the realized edge→ROI relationship is flat-to-inverse). The honest improvement is structural: **quality is now carried by the evidence-based grade, not implied by edge magnitude.** Revisit a calibrated edge only when n supports a stable calibration.

---

## Part 6 — Validation (OLD vs NEW, realized, n=106)

Using the **shipped** `alertConfidence` function:

**OLD grade (legacy-family, as stored):**
| Grade | n | ROI | 95% CI |
|---|---|---|---|
| A | 24 | −20.3% | [−64.1, +23.5] |
| B | 23 | −11.3% | [−50.7, +28.1] |
| C | 0 | — | impossible |
→ **Inverted; C dead.**

**NEW grade (all models — authoritative scope):**
| Grade | n | W–L | Win% | ROI | 95% CI | Avg odds | Avg edge |
|---|---|---|---|---|---|---|---|
| **A** | 46 | 22–24 | 47.8% | **+9.5%** | [−24.7, +43.6] | 2.30 | 5.1% |
| **B** | 48 | 17–31 | 35.4% | −10.4% | [−47.7, +26.9] | 2.73 | 4.7% |
| **C** | 12 | 3–9 | 25.0% | **−57.0%** | **[−101.0, −13.0]** | 2.70 | 5.6% |
→ **Monotone A > B > C; C reachable; C's CI excludes zero.**

**NEW grade (legacy-family subset, like-for-like vs old):** A −6.5% (n41) ≈ B −5.5% (n42) > **C −53.1% (n11, CI [−100.6, −5.6])**.

**Honest reading:**
- **Improvement demonstrated** on the dimensions that matter: the inversion is gone, C exists and is reliably the worst (CI excludes zero in **both** scopes), and the grade now orders by realized ROI.
- **But not oversold:** the **A-vs-B gap is weak** (tied on legacy-family); the all-models A positivity (+9.5%) is partly because Pinnacle-Led's better ideas land in A (model mix), not purely the flags. And the validation is **in-sample** (flags derived from this data) — true out-of-sample proof needs future settlements. **The robust, transferable claim is: grade C flags alerts that realized badly.**

---

## Implementation Details

| File | Change |
|---|---|
| `src/value-detection/alert-confidence.ts` | **New.** `alertConfidence` + `alertConfidenceFlags` + `isFlatLine`/`isExtremeOdds`. Pure, explainable, realized-derived. |
| `src/value-detection/legacy-confidence.ts` | **Deleted entirely** (no dual systems). |
| `src/value-detection/index.ts` | Swap exports: remove `legacyConfidence`, add `alertConfidence` family. |
| `src/value-detection/value-detection.service.ts` | Remove the old grade computation; apply the **authoritative grade to every row at the single insert point** (one map over `toInsert`) → all four models graded uniformly. |
| `src/discord/discord-notification.service.ts` | New `🏅 Quality: <grade> — <flags>` presentation for all models. |

**Scope/architecture:** the grade is computed once, at persistence, from each row's stored `bookmakerOdds` + `pinnacleMove6h` — guaranteeing every model is graded consistently with no per-branch duplication. **Annotation only:** no detection, threshold, model-selection, or settlement code is touched.

---

## Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| **In-sample overfitting** (flags fit to the validation sample) | Medium | Only 2 simple signals; the flat-line flag is *independently corroborated* by a prior audit; **annotation-only → zero ROI risk if wrong**; out-of-sample to be monitored. |
| A-vs-B weak / model-mix confound | Low | Documented; the load-bearing claim is C, not A>B. |
| Movement coverage ~55% (null not flagged) | Low | By design null = neutral; such alerts grade on odds alone (A/B). Documented. |
| Mixed history in `confidence` column (old rows keep old grades) | Low | Grade is presentational; no backfill (would be a data migration, unjustified). New detections use the new grade. |
| Scope expansion (Pinnacle-Led now graded) | Low | Annotation only; improves consistency. |

**Worst case:** the grade is merely uninformative — it cannot harm detection, thresholds, or ROI, because it never gates anything.

---

## Production Rollout Summary

- Old confidence system **removed entirely** (file deleted, exports swapped) — **no dual systems.**
- New grade is **authoritative for all new detections, all four models.**
- Presentation deployed (`🏅 Quality` line with red-flag explanation).
- `tsc` clean · ESLint clean · shipped function reproduces validated numbers.
- Committed (Part 7).

---

## Most Important Question — what should a Discord user see so quality reflects *realized* outcomes?

**Show three things, in this order of honesty:**

1. **A red-flag-based quality grade (A/B/C) derived only from realized-validated traits**, with the flags named: e.g. `🏅 Quality: C — red flags: flat line, extreme odds`. This tells the user *why* the alert is graded down, using the two characteristics that actually realized worst (flat 6h line −46.6%; extreme odds). It honestly represents quality as **"absence of known-bad traits,"** not a fabricated win probability.
2. **The model's edge as a value estimate, explicitly NOT as quality** — because realized data shows higher edge does not mean higher ROI. Keep it visible (it defines the bet) but stop implying it grades quality.
3. **The 6h line movement** (already shown) — because *flat* is the single strongest negative signal; a moving line is materially better than a stale one.

**What NOT to show as quality:** edge magnitude, books-agreeing count, confidence-grade-from-CLV, or any per-league/sport ROI — all are non-predictive, inverse, or too small-sample to be honest. The most accurate single quality field available today is **"how many of the two realized-worst traits does this alert have"** — which is exactly what the new grade is.

---

## Final Recommendation

**Replace (done).** The old grade was demonstrably inverse, structurally broken (constant signal, impossible C), and built on the wrong target (CLV). The new grade is built only on realized-validated signals, fixes every structural defect, and **validates with a correct ordering and a reliably-bad C grade** — while being honest that it flags bad alerts more confidently than it certifies good ones. Because it is annotation-only, replacement carries no ROI risk and removes a genuinely misleading signal. The remaining work is not code: **let realized settlements accumulate and re-validate the flags out-of-sample** — and never let a confidence score imply more certainty than n≈106 can support.

---

*Implementation task. Allowed presentation/confidence changes only; detection, thresholds, models, sports, seasonality, and settlement untouched. 0 API credits. Validation scripts were read-only and removed after capture; the new grade is exercised by the shipped `alertConfidence`.*
