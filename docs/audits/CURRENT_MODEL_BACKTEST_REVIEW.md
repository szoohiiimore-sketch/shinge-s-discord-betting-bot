# Current Model Backtest Review — Pinnacle-Led Detection, Evaluated on Purchased History

**Date:** 2026-06-12
**Instrument:** the Historical Backtesting Engine (`HISTORICAL_BACKTESTING_ENGINE_IMPLEMENTATION.md`), running the **identical pure detector core as production** (parity-verified) over purchased Odds API history.
**Stance:** evaluation, not tuning. The production config was frozen before replay; nothing below was fitted to this sample.

---

## 1. The Sample

| | |
|---|---|
| Period | **2026-04-21 → 2026-06-07** (47 days, ending exactly where the live store begins — this sample is fully independent of the running live experiment) |
| Universe | The model's actual hunting grounds: `soccer_sweden_superettan`, `soccer_spain_segunda_division`, `soccer_brazil_serie_b`, `basketball_wnba` — fixed ex ante from where live alerts come from |
| Data | 306 events, **272,067 snapshot rows**, ~38–47 books per batch, region `eu` (includes Pinnacle) |
| Plan | Targeted: T−24h, T−6h, T−1h, T−5min (close) per event; 1,048 requests, **8,752 credits** (quota after: ~84k remaining — live pipeline unaffected) |
| Runs | A = production config, **live-cadence** (3h soccer / 60min WNBA — predicts production); B = same config, **full-resolution** over the grid (the faster-polling ceiling) |
| Scoring | CLV vs de-vigged Pinnacle close at T−5min, **all 68/68 (A) and 78/78 (B) events scored, zero missing closes** — a far better close than the live system's 1–4h-stale one |

**Universe caveat, stated up front:** these four keys were chosen *because* the live model finds edges there. This review answers "is the model right where it hunts?" — it says nothing about the other 59 configured keys.

## 2. Headline Numbers (Run A — what production would have done)

| Metric | Value |
|---|---|
| **Production ideas (alerts)** | **45 in 47 days ≈ 0.96/day** — independently confirms the live ~1/day observation |
| Production bookmaker rows | 93 (2.1 rows/idea — the idea layer's dedup working as designed) |
| Shadow ideas (2–3% band) | 37 (74 rows) |
| **Idea CLV (gate metric)** | **avg +5.04% · median +4.25% · 73.3% positive · top-decile-trimmed +3.76%** (n=45) |
| Shadow idea CLV | avg +1.34% · **trimmed +0.07%** (n=37) |
| Statistical weight | 33/45 positive: two-sided sign test p ≈ 0.003. The trimmed mean staying at +3.76% means this is **not** an artifact of a few ghost-price outliers |

Denominators (survivorship guard): 3,231 event-batches evaluated; 41,882 candidate prices rejected below 2%; 35,146 odds-filtered; 2,839 exchange-excluded; 112 in-play batches refused. The 45 ideas are the top ~0.1% of evaluated prices — this is a highly selective model, and its selections beat the close.

**The single most important secondary finding:** the shadow tier's trimmed CLV is **+0.07% ≈ zero**. The 2–3% edge band carries no edge once outliers are removed. The 3% production threshold is, on this evidence, placed almost exactly at the noise floor — a blanket threshold cut to 2% would roughly double volume while adding ~nothing but noise. The threshold question the shadow tier was built to answer is answered, twice now (this backtest + the live shadow tier will confirm).

## 3. Breakdowns

### By sport / league (idea CLV, run A; sport key = league for these markets)

| League | n | avg | trimmed | pos% | Verdict |
|---|---|---|---|---|---|
| **soccer_sweden_superettan** | 22 | +5.90% | +4.72% | 68% | **Strongest by volume × quality — the model's core market** |
| **soccer_spain_segunda_division** | 14 | +5.28% | +4.08% | 79% | Strong (full-res run: +6.80% on n=19) |
| **basketball_wnba** | 4 | +6.97% | — | **100%** | Promising, sample tiny (n=8, 100% pos at full-res) |
| **soccer_brazil_serie_b** | 5 | **−0.96%** | −0.96% | 60% | **The weak spot — negative in both runs (−0.93% at full-res)** |

Strongest: Superettan, Segunda. Weakest: Brazil Série B — the only segment negative in both cadence modes; small n, but the consistent sign across runs and its known thin-Pinnacle-limits profile justify demoting it to shadow-only pending more data.

### By bookmaker family (row-denominated diagnostics, run A)

| Family | n | avg | trimmed | Read |
|---|---|---|---|---|
| unibet (skins) | 40 | +3.31% | +1.73% | Highest volume, *lowest* genuine quality — many marginal edges |
| coolbet | 24 | +4.76% | +3.59% | Solidly soft |
| leovegas (skins) | 14 | +6.27% | +5.38% | **Softest meaningful-n family** |
| betsson-group | 9 | +4.75% | +4.75% | Solid |
| sport888 / williamhill | 2+2 | −1.76% | — | Negative, n too small to act on |

Concentration risk: unibet+coolbet+leovegas = 84% of production rows. The model's edge currently lives in roughly three Kindred/Nordic-flavored pricing engines. That is fine while it works and fragile if any of them sharpens.

### By edge bucket (run A) — calibration check

3–4%: trimmed +2.30% → 4–5%: +4.48% → ≥5%: +5.19%. **Monotone**: bigger detected edge = bigger realized CLV. The edge formula is measuring something real, not noise rank.

### By corroboration k

k=1: +4.02% trimmed · k=2: +6.39% · k=3: +5.71% (k≥4: n=2, −5.2%, ignore). Corroborated ideas are at least as good as lone-outlier ideas — direct evidence for the corroboration-conditional threshold experiment (§6).

### By movement class — honest caveat

34/45 ideas are "no-history": the targeted grid (T−24h → T−6h gap = 18h) usually leaves the 6h window empty, so this backtest **cannot** properly evaluate movement classes. What little exists: steam-in n=4 at −0.98% (consistent with "the move already happened"), flat n=5 mixed. **The movement question stays with the live annotation data and a future interval-mode backfill** — this sample doesn't answer it.

### By time-to-kickoff

6–24h is the sweet spot (+7.99%, 100% pos, n=7); >24h carries the volume (n=34, +3.29% trimmed); ≤2h positive (n=4). No evidence that any window the model alerts in is bad.

## 4. The Cadence Ceiling (Run B vs Run A, paired)

Full-resolution over the same stream: **58 ideas vs 45 (+29% volume)**, avg CLV +5.33% vs +5.04%, and the 13 extra ideas average **+5.65% CLV** — the additional detections from denser polling are *at least as good* as the baseline ones. Paired Δ on the 45 shared ideas: +0.19% (headline prices barely change; the gain is volume, not price). **This is the direct price tag of the near-kickoff booster / faster polling: ~+29% more alerts at equal quality, using polls the system already conceptually pays for.**

## 5. Would I Personally Trust This Model in Production?

**As a paper-trading signal generator: yes, now with actual evidence rather than theory. As a real-money system: not yet — and the blockers are not the model.**

Why yes:
1. **+3.8–5.0% idea CLV, 73% positive, on an out-of-sample 47-day window the model never saw**, with the production config frozen first. The old model measured −2.6% CLV; this one is +5% against a *better* (5-min) close. That is the cleanest possible A-to-B.
2. **It's calibrated**: monotone CLV by edge bucket, shadow band ≈ 0 — the model's internal ranking corresponds to reality, and its threshold sits where the signal starts.
3. **It's selective in the right way**: 45 alerts out of ~77k evaluated prices, with every rejection tallied. This is not a system hallucinating edges everywhere.
4. The result is robust to outlier-trimming, consistent across both cadence modes, and consistent with the live volume observation (~1/day).

Why not real money yet:
1. **Attainability is still unmeasured and unmeasurable from inside this system** — these are paper prices at soft books that limit winners; a 5% CLV you can't get down on is worth 0%. This backtest cannot move that needle; only live betting can.
2. **Weak reference where it matters**: Pinnacle's closes in Superettan/Segunda carry small limits; +5% against a soft close proves less than +5% against an NBA close. Partially mitigated by WNBA showing the same pattern, but the discount is real.
3. n=45 ideas is one good month, not a track record; Brazil Série B shows the model can be wrong in a whole segment.
4. Platform criticals (C1/C2/C4 from `FINAL_V1_AUDIT.md`) remain open — trust in the model ≠ trust in the operation around it.

## 6. Changes Most Likely to Increase Alert Volume Without Hurting CLV (evidence-ranked)

1. **Faster / near-kickoff polling** — the only item with a measured price tag from this backtest: **+29% ideas at equal CLV** (run B). Implement the near-kickoff booster and promote active niche soccer to 60 min.
2. **Add leagues that look like the winners** — the edge profile is "mid-tier European soccer with Kindred-family coverage": Allsvenskan, Eliteserien, Veikkausliiga, Danish 1st Division, Segunda-analogues. Same books, same structural softness. (And demote Brazil Série B to shadow-only — that *removes* a negative-CLV alert source, which raises average quality while the additions raise volume.)
3. **Corroboration-conditional threshold: alert k≥2 ideas from 2.5%** — k=2–3 ideas measured *better* CLV than k=1 at 3%+. The 2.5–3.0% k≥2 slice is the only defensible expansion into the shadow band; run it as an engine experiment first (one config line now).
4. **Region expansion (`au`, `us2`)** — more genuine candidate books per match; also reduces the 84% three-family concentration. Not directly measured here (eu-only backfill) but mechanically sound and exchange-proofed already.
5. **Do NOT blanket-lower the threshold to 2%** — this backtest is the strongest evidence yet against it: shadow trimmed CLV +0.07% on n=37. Doubling volume with zero-edge alerts is the failure mode, not the goal.

## 7. Ratings — brutally honest

| Dimension | Score | Rationale |
|---|---|---|
| **CLV Quality** | **8 / 10** | +5.0% avg / +3.8% trimmed / 73% positive, out-of-sample, calibrated by edge bucket, robust to trimming, against a true 5-min close. Docked 2: weak-limit reference leagues and n=45 — excellent evidence, not yet proof. |
| **Expected Profitability** | **6 / 10** | Positive CLV of this size, if attainable, implies roughly +2–4%/bet real EV after price decay. But attainability is unmeasured, the books involved limit winners fast, and one league segment is already negative. CLV is necessary, not sufficient — this score cannot exceed ~6 until real or semi-real bets exist. |
| **Alert Volume** | **3 / 10** | ~1 idea/day is too slow to validate quickly, too slow to matter as a product, and concentrated in 3 bookmaker families and 2 leagues. The fix is known and partially priced (+29% from cadence alone, more from league/region expansion). |
| **Production Readiness** | **6 / 10** | Model: ready (parity-verified core, idea-level accounting, calibrated threshold, this evidence). Platform: not — C1/C2/C4 criticals open, no deployment hardening, settlement gaps. The model is ahead of its infrastructure. |
| **Overall** | **6.5 / 10** | The strongest statement this repo has earned to date: *the detection model works, on paper, where it hunts.* What stands between 6.5 and 9 is not modeling — it's volume engineering, attainability evidence, and operational hygiene. |

## 8. Reproduce

```
npx tsx --env-file=.env scripts/backtest/backfill.ts scripts/backtest/configs/eval-2026q2.json        # resumable; ~8.8k credits
npx tsx --env-file=.env scripts/backtest/replay-run.ts scripts/backtest/configs/eval-2026q2-baseline.json
npx tsx --env-file=.env scripts/backtest/replay-run.ts scripts/backtest/configs/eval-2026q2-fullres.json
npx tsx --env-file=.env scripts/backtest/score.ts <runId>
npx tsx --env-file=.env scripts/backtest/report.ts <runIdA> [<runIdB>]
```

Run ids this review is built on: A = `cc53907b-6636-4b92-9e31-290e26bd7fcd` (live-cadence), B = `24eabcd2-1e88-4634-b20e-f8a9b1f5b5a0` (full-resolution); code `f1563fa` + this session's working tree.
