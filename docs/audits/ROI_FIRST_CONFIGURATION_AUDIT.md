# ROI-First Configuration Audit — Volume and Profit Over CLV Purity

**Date:** 2026-06-12
**Objective (owner-set):** optimize for ROI, profitability, alert volume, and sample growth; CLV demoted to a diagnostic. Find the highest-volume configuration that remains historically profitable; target ≥5 alerts/day.
**Instruments:** the Historical ROI Engine (`HISTORICAL_ROI_ENGINE_IMPLEMENTATION.md`) over all five disjoint stored runs — 377 detection rows, 151 ideas at ≥2% edge, 74 settled rows / 25–14 settled ideas depending on threshold. **Zero API credits consumed.**

---

## 1. Read This First — What This Dataset Can and Cannot Say About ROI

The honest statistical frame, before any table: **at 14–25 settled ideas, ROI point estimates carry a ±25–35 pp standard error.** The engine's calibration check (realized wins vs fair-probability-expected wins: 11 vs 11.3 at the 2% threshold) shows the settlement method is sound and the bets win exactly as often as the de-vigged reference predicts — but the sample is roughly **20× too small** to certify any configuration's ROI sign at conventional confidence. Every "ROI" below is a point estimate inside a wide band, and any configuration assembled by picking the green cells would be curve-fitting noise. This audit therefore reports the full tables, then builds its recommendation on the *joint* evidence (volume measured precisely + calibration + CLV as the faster-converging diagnostic) rather than on any single ROI cell.

## 2. Required Outputs — The Historical ROI Tables

(Idea-level, flat 1u on headline row; `expW` = calibration benchmark; in-season rates.)

### 2.1 ROI by threshold (the volume dial)
| Threshold | Ideas/day | Settled | W–L (expW) | Win% | P&L | **ROI** | CLV trim |
|---|---|---|---|---|---|---|---|
| **2.0%** | **4.88** | 25 | 11–14 (11.3) | 44% | −2.11u | **−8.4%** | +1.51% |
| **2.5%** | **3.89** | 19 | 8–11 (8.2) | 42% | −0.48u | **−2.5%** | +1.88% |
| 3.0% (current) | 3.13 | 14 | 5–9 (6.1) | 36% | −2.24u | −16.0% | +1.29% |
| 4.0% | 1.86 | 10 | 3–7 (4.2) | 30% | −2.42u | −24.2% | −0.24% |

### 2.2 ROI by tier
Production (≥3%): −16.0% (n=14) · Shadow band (2–3%): −0.6% (n=16). At these n, the difference is noise (and CLV says the opposite — production +1.3%, shadow +1.5% on settled subsets).

### 2.3 ROI by sport/league (production tier)
Positive cells: Segunda **+9.0%** (n=5), Superettan +40% (n=2), NBA +73% (n=1). Negative: tennis −40.7% (n=3), WNBA/Veikkausliiga/Brazil-B −100% (n=1 each). Unresolved: Allsvenskan, MLS, Eliteserien (0 settles). **No league has enough settles to certify a sign.**

### 2.4 ROI by bookmaker family (headline)
unibet +36% (n=4) · coolbet +40% (n=2) · leovegas **−100% (n=4, 0W — but its detected-edge CLV is +5.0%; four straight losses at p≈0.4 each happens 13% of the time by chance)** · onexbet/sport888 +73–78% (n=1). Diagnostic only.

### 2.5 ROI by edge band
2.0–2.5%: −45% (n=8) · 2.5–3.0%: **+44% (n=8)** · 3.0–4.0%: +39% (n=3) · 4.0–5.0%: +40% (n=2) · ≥5%: −100% (n=4, 0W vs 1.8 expW — the ghost-price band showing its teeth, consistent with the CLV trimming evidence). The middle bands are green, both tails red — directionally consistent with "moderate edges are realest", but n forbids confidence.

### 2.6 ROI by movement class (6h)
steam-in +16% (n=5) · no-history −15% (n=7) · flat −100% (n=2). First weakly positive signal for steam-in; still unanswerable properly (grid limitation documented previously).

## 3. The Research Question Answered

**"Highest-volume configuration that remains historically profitable" — strictly, no configuration in the data qualifies with statistical meaning.** The 2.5% global threshold comes closest to the spirit of the request:

- **Volume: 3.89 ideas/day** measured (in-season, current sport mix incl. tennis majors) — the single-dial configuration closest to the ≥5/day target. Adding every stored source at 2.0% reaches 4.88/day but flips the worst band (2.0–2.5%: −45% ROI, +1.5% CLV concentrated in its better half only via Allsvenskan).
- **ROI: −2.5% ± ~25pp** — statistically indistinguishable from zero or from ±20%; the calibration check (8W vs 8.2 expected) says these bets win as predicted, i.e. nothing in the *results* contradicts the +2–4% expectation implied by the detected edges; the point estimate is simply uninformative at this n.
- **CLV on the same configuration: +1.88% trimmed** — inside the owner's previously accepted band, positive, and converging ~4× faster than ROI ever will.

## 4. Highest-Volume Historically Profitable Configuration

Given §1, the defensible construction excludes only the cells where volume, ROI *and* CLV agree the class is bad, and keeps everything else:

| Component | Setting |
|---|---|
| Global threshold | **2.5%** (2.0–2.5% band excluded: ROI −45%, CLV ≈ +0.7% in core, −0.6% tennis) |
| Exception — Allsvenskan | 2.0% (its 2.0–3.0% band: 2W–0W settled, +97% ROI, +2.8% CLV — the only positive-everywhere sub-2.5 cell) |
| Sport mix | Superettan, Allsvenskan, Segunda, WNBA, Veikkausliiga, tennis majors (in season), NBA playoffs (in season) |
| Removed from alerting | MLS, Brazil Série B (negative on every metric measured), Eliteserien, J/K-League, Argentina, Brazil-A, NHL, MLB (zero ideas — pure quota waste) |
| Shadow-only | All 2.0–2.5% bands outside Allsvenskan |
| Polling | Near-kickoff booster + 60-min niche soccer (the +29%/+11% volume measured earlier applies on top) |

**Expected performance of this configuration:**

| Metric | Value | Basis |
|---|---|---|
| **Alerts/day** | **≈ 4.0–4.5 in season** (tennis-major weeks; ≈ 2.7–3.0 otherwise) | measured per-source rates + booster |
| **Historical ROI** | **−2.5% point estimate, 95% band ≈ [−25%, +20%]** | 19 settled ideas |
| Win rate | 42% at avg odds 2.52 (expected from fair probs: 43%) | settled subset |
| Profit | −0.48u on 19 ideas (i.e. ~zero) | settled subset |
| CLV (diagnostic) | ≈ +1.9–2.6% trimmed blended | scored on 100% of ideas |
| Monthly API | ~60–90k credits (with season-gating + MLB demotion) | prior audit |

This is the same architecture as the volume-first configuration, with the threshold floor moved from 3.0% to 2.5% on ROI-first grounds — that single change is what the ROI tables genuinely support: the 2.5–3.0% band is the **best-performing cell in the entire ROI dataset** (+44%, 5W–3L) *and* CLV-positive (+3.2%), making the old 3.0% floor look like it was discarding the band with the best realized results. ≥5/day remains out of reach without re-admitting classes that every metric calls negative.

## 5. Would I personally deploy this version with real money?

**No — and on ROI evidence, that answer is now better-founded than it was on CLV evidence.**

The ROI engine was asked to certify profitability. What it actually proved: with 102 locally-inferable results, the settled sample (14–25 ideas) has a ±25–35pp ROI error band; the realized win rate sits exactly on the fair-probability prediction (the good news: nothing suggests the edges are fake); and the aggregate P&L point estimate is mildly negative (−0.5 to −2.2u depending on threshold) while individual cells swing from −100% to +97% on 1–8 settles. **Nobody who reads those numbers honestly can claim to know the ROI sign.** Deploying real money on this would not be betting on the model — it would be betting on noise, with the one semi-solid ROI cell (2.5–3.0%: +44%) already promoted into the configuration where it will be validated or killed by live data.

What I *would* deploy — today — is this configuration on paper: it raises volume ~4× over the current production setup, the sample-size growth the owner now prioritizes is exactly what it maximizes (≈ 4/day → ~120 ideas/month → a *real* ROI sample inside one quarter), it removes every measured-negative source, and its CLV stays positive as the fast early-warning channel. If after ~150–200 settled live ideas the ROI is non-negative and CLV holds, that — not any backtest this dataset can produce — is the real-money trigger.

## 6. Reproduce

```
npx tsx --env-file=.env scripts/backtest/roi-settle.ts <5 run ids>
npx tsx --env-file=.env scripts/backtest/roi-report.ts 24eabcd2…:47 e0c38b46…:37 3c6b62b1…:13 601a4233…:21 35c6f9fd…:21
```
Credit usage this audit: **0**.
