# Alert Volume Expansion Audit — Evidence-Based Path from ~1/day Toward 5–7/day

**Date:** 2026-06-12
**Method:** every claim below is measured, not estimated, unless explicitly marked *extrapolation*. Instruments: the Historical Backtesting Engine over the existing 47-day import (runs A/B/C) plus **three new purchased probes** run for this audit (AU/US2 regions, Nordic look-alike leagues, ATP French Open). Total new spend: 6,954 credits; session total 15,706; ~77k remaining.
**Baseline being defended:** production config at live cadence = **0.96 ideas/day at +3.76% trimmed idea CLV** (run A, n=45).

---

## 1. Experiment Ledger

| Run | What it measures | Result |
|---|---|---|
| A `cc53907b` | Production config, live cadence (3h/60m), 4 core keys, 47d | 45 ideas (0.96/d), trimmed CLV +3.76% |
| B `24eabcd2` | Same, full grid (≈ near-kickoff booster ceiling) | 58 ideas (+29%), trimmed +3.92%; the 13 extra ideas: +5.65% avg |
| C `9f93561a` | Same, 60-min soccer cadence | 50 ideas (+11%), trimmed +3.61%; 6 extra ideas: +5.33% avg |
| Shadow analysis (A+B) | 2–3% band by sub-band × k × league × family | See §3 — mostly negative, one league exception |
| Regions probe `7ca504c4` | au+us2 books merged into Superettan+Segunda, 20d | **0 new ideas**; 2/9 headlines marginally improved |
| Leagues probe `83434e8f` | Allsvenskan+Eliteserien+Veikkausliiga, 37d, live cadence | 16 ideas (0.43/d), trimmed +2.91% |
| Tennis probe `3c6b62b1` | ATP French Open, 13d, 60-min cadence | 13 ideas (1.00/d), trimmed **+0.97%** |

## 2. The Twelve Levers, Evaluated

### 2.1 Near-kickoff polling booster — **MEASURED, STRONG YES**
Run B vs A, paired: +29% ideas at unchanged quality (paired Δ +0.19%; the *added* ideas averaged +5.65% CLV — better than baseline).
**Expected: +0.25–0.3 alerts/day · CLV: neutral-to-positive · ROI: positive (plus it fixes the stale-close gate instrument) · Confidence: HIGH (paired, same stream) · Complexity: Medium (scheduler change).**

### 2.2 AU region & 2.3 US2 region — **MEASURED, NO**
20 days of au+us2 books on the two core leagues: the new books (tabtouch, betparx, …) produced 7 candidate rows but **zero ideas that EU books hadn't already produced**. They corroborate and occasionally improve a headline price; they do not create volume. The model's binding constraint is *edges*, not *books quoting them*.
**Expected: +0.0 alerts/day · CLV: ~0 (marginal headline-price gain) · ROI: slightly negative net of +20 credits/poll · Confidence: HIGH for these leagues (probe was direct) · Complexity: Low — but don't bother.**
*Caveat: untested on US sports (WNBA/NBA), where us2 books are native; a future probe there could differ.*

### 2.4 Additional leagues — **MEASURED, YES (the biggest honest lever)**
Nordic probe, 37 days, live cadence: **+0.43 ideas/day at +2.91% trimmed** — slightly below core quality but clearly real. Decomposed: **Allsvenskan is a full-quality add** (10 ideas, +5.56% trimmed, 80% pos — indistinguishable from Superettan); Veikkausliiga marginal (5 ideas, +1.77%); Eliteserien empty (1 idea, negative). The pattern across now 7 tested leagues: *mid-tier leagues with Kindred-family (unibet/leovegas) + coolbet coverage produce 0.1–0.3 ideas/day each at +2–6% CLV; one in three tested leagues is a dud.*
**Expected: +0.1–0.3/day per productive league · CLV: −0.5 to −1 pp blended drag per marginal league · ROI: positive for Allsvenskan-class adds · Confidence: HIGH for the 3 probed; MEDIUM for extrapolating to unprobed look-alikes · Complexity: Low (config) + ~1–3k credits to probe each candidate league first.**

### 2.5 Additional sports — **MEASURED, QUALIFIED**
- **Tennis (ATP French Open):** 1.00 idea/day during the slam — the single largest volume source found — but at **+0.97% trimmed CLV**, a quarter of the soccer core's quality, with a *non-monotone* edge-bucket curve (a noise red flag: 3–4% bucket beat the ≥5% bucket). Slam-only availability (~15 weeks/year of majors+Masters).
  **Expected: +1.0/day during majors (~+0.3/day annualized) · CLV: dilutes blended trimmed CLV by ~1 pp if mixed in · ROI: ~breakeven-to-slightly-positive · Confidence: MEDIUM (13 days, one event) · Complexity: Low (config).** Recommendation: shadow-tier tennis first, or ship it as an explicitly labelled second tier.
- **WNBA** (already in baseline): n=8 at full-res, 100% CLV-positive — keep, possibly probe NBA playoffs later.

### 2.6 Corroboration-based thresholds — **MEASURED, NO (decisively)**
The hypothesis from the model review (k≥2 production ideas had great CLV) **fails in the shadow band**: 2.5–3.0% & k≥2 ideas = trimmed **−0.97%** (n=10, run B); all-shadow k≥2 = −1.03%. Corroboration does not rescue sub-threshold edges; promoting that slice would add +0.21/day while dragging the headline trimmed CLV from +3.92% to +3.21%.
**Expected: +0.2/day · CLV: −0.7 pp blended, added ideas ≈ −1% · ROI: negative · Confidence: HIGH · Complexity: n/a — rejected.**

### 2.7 Movement-based thresholds — **UNTESTABLE HERE, OPEN**
The targeted snapshot grid leaves most 6h movement windows empty (34/45 ideas "no-history"). What little exists is unpromising (steam-in n=4: −0.98%). The live movement annotation (every live alert is annotated) remains the right instrument; revisit in ~4 weeks. An interval-mode backfill (e.g. 2h grid × 30 days ≈ 9k credits) could answer it sooner if wanted.
**Confidence: NONE either way · Complexity: Low once evidence exists.**

### 2.8/2.9 Sport- & league-specific thresholds — **MEASURED, YES (both directions)**
The shadow band's value is league-specific, dramatically:
| League | 2.5–3.0% shadow ideas (run B) | Verdict |
|---|---|---|
| Segunda División | n=7, **avg +5.96%**, 71% pos | **Lower Segunda to 2.5% → +0.15/day at near-core quality** |
| Superettan | n=5, avg **−5.42%** | Keep 3% — its sub-3% band is actively bad |
| WNBA | n=5, avg +1.71% | Borderline — leave at 3% |
| Brazil Série B | n=2, −3.98% (and production tier −0.96%) | **Demote to shadow-only: −0.11/day of negative-CLV alerts removed** |
**Net: +0.04/day but materially better blended CLV · Confidence: MEDIUM (n=5–7 per cell) · Complexity: Low (per-league config map).**

### 2.10 Bookmaker-specific thresholds — **INSUFFICIENT EVIDENCE, NOT NOW**
Family-level shadow CLV (leovegas +1.37, coolbet +3.36, unibet +0.62 trimmed) hints that a coolbet/leovegas-specific 2.5% could work, but n=4–16 per cell and it compounds with league effects. Park it until ~3× more data.

### 2.11 Alternative polling schedules — **MEASURED**
The cadence ladder on identical data: 3h → 0.96/d; 60-min → 1.06/d (+11%); full grid → 1.23/d (+29%). Diminishing but real; the gains concentrate near kickoff (the booster captures most of the full-grid benefit without 60-min polling everywhere). Additionally the engine's targeted-grid result (4 polls/match ≈ full value) supports **slate-aware polling**: poll on fixture-derived times instead of fixed intervals — same detection coverage at a fraction of the quota, funding league expansion (§2.4) at zero net cost.
**Confidence: HIGH · Complexity: Medium.**

### 2.12 Not previously considered — two findings from this audit's data
1. **Slate-aware (fixture-keyed) polling** (above) — the quota saved by not polling empty hours is what pays for 10+ extra leagues.
2. **League portfolio rotation:** league productivity is seasonal (Eliteserien dead in May, Segunda ends June, Superettan/Allsvenskan run April–Nov). Volume should be managed as an in-season portfolio (~10–15 active Superettan-class leagues at any time) with cheap engine probes (1–3k credits) qualifying each league before promotion — a standing process, not a one-off config.

## 3. Can the system realistically reach 5–7 alerts/day without destroying the CLV profile?

**No — not at the current quality bar, and the evidence is specific about why.**

The measured arithmetic of every quality-preserving lever:

| Lever | Δ alerts/day | Blended trimmed CLV after |
|---|---|---|
| Baseline | 0.96 | +3.76% |
| Near-kickoff booster + 60-min niche soccer | +0.29 | ~+3.8% |
| Segunda → 2.5%, Brazil → shadow-only | +0.04 | ~+4.0% |
| Allsvenskan + Veikkausliiga (measured) | +0.43 | ~+3.6% |
| **Measured subtotal** | **≈ 1.7/day** | **≈ +3.7%** |
| +6–10 further probe-qualified Superettan-class leagues (*extrapolation*, 1-in-3 dud rate priced in) | +0.8–1.4 | ~+3.2–3.5% |
| **Realistic quality-preserving ceiling** | **≈ 2.5–3.2/day** | **≈ +3.3%** |
| Tennis majors as same-tier alerts | +1.0 (in season) | **≈ +2.4%** ← the dilution cliff starts here |
| Shadow-band promotions (k-gated etc.) | +0.4 | ≈ +1.8% — measured junk |

The honest ceiling at the current CLV profile is **≈ 3/day sustained (≈ 4/day during tennis majors if a lower bar is accepted for a labelled second tier)**. Getting from 3 to 5–7 within a single quality tier requires sources that don't exist in the evidence: the shadow band is junk outside Segunda (measured), corroboration doesn't rescue it (measured), new regions add nothing (measured), and each new league adds only ~0.15/day with a 1-in-3 dud rate (measured). 5–7/day at +3.5% trimmed CLV would need ~25–35 simultaneously productive Superettan-class leagues; The Odds API's in-season universe of such leagues at any moment is plausibly 15–20, and a third of them won't perform. **The math does not reach 5–7 without dilution. Anyone promising otherwise is selling alert count, not edge.**

What 5–7/day *can* honestly be: a **two-tier product**. Tier A (the bet signal, gate-relevant): ~3/day at ~+3.3–3.7% trimmed CLV. Tier B (labelled "watchlist"; tennis majors, Veikkausliiga-class leagues, Segunda-style 2.5% bands): +1.5–2.5/day at ~+1–2% CLV, excluded from the CLV gate sample. That reaches 4.5–5.5/day total — at the cost of admitting the tiers differ, which is the truthful version of this product.

## 4. Your Recommended Roadmap to Reach 5–7 Alerts/Day

Ranked by (volume gain × CLV preservation × ROI preservation ÷ implementation cost):

| # | Action | Δ/day | CLV | ROI | Conf. | Cost | Cumulative/day |
|---|---|---|---|---|---|---|---|
| 1 | **Demote Brazil Série B to shadow-only** | −0.11 | **+** (removes measured-negative alerts) | + | High | Trivial | 0.85 |
| 2 | **Add Allsvenskan** (measured full-quality) | +0.22 | = | + | High | Trivial | 1.07 |
| 3 | **Near-kickoff booster** (≤2h → 15–30 min polls) | +0.20 | =/+ (also fixes live close) | + | High | Medium | 1.27 |
| 4 | **Niche soccer 3h → 60 min** (active leagues only) | +0.10 | = | + | High | Low | 1.37 |
| 5 | **Segunda league-specific 2.5% threshold** | +0.15 | =/+ | + | Med | Low | 1.52 |
| 6 | **Slate-aware polling + H4 quota fix** — funds everything below | 0 | = | + | High | Medium | 1.52 |
| 7 | **League qualification pipeline**: probe ~12 Superettan-class candidates (1–3k credits each, ~25k total), promote the ~8 that pass | +0.8–1.2 | −0.3 pp | + | Med (*extrapolation*) | Medium + credits | **2.3–2.7** |
| 8 | **Veikkausliiga + similar B-grade leagues** into a *labelled* Tier B | +0.3 | Tier-B only | ~0 | Med | Low | ~3.0 total |
| 9 | **Tennis majors as Tier B** (shadow first for 1 slam to confirm +1%) | +1.0 in season | Tier-B only | ~0 | Med | Low | **4.0–5.0 in season** |
| 10 | **Movement-based promotion** — revisit when live annotation has ~4 weeks of data | +0.2–0.4 if confirmed | ? | ? | None yet | Low | — |
| — | ~~Corroboration-threshold promotion~~ | +0.2 | **−0.7 pp** | − | High | — | **rejected on evidence** |
| — | ~~AU/US2 regions for current leagues~~ | +0.0 | = | − | High | — | **rejected on evidence** |

**Bottom line, brutally:** ~1 → **~2.5–3/day is achievable with measured, quality-preserving changes** (steps 1–7), keeping trimmed idea CLV ≥ +3.3%. **5–7/day in a single quality tier is not achievable on current evidence** — the volume simply isn't in the data at this bar. The defensible route to a 5ish-per-day *product* is the two-tier design (steps 8–9), which gets to ~4–5/day total while keeping the gate sample and the bettable signal clean. Steps 1–6 should ship now; step 7 is a 2-week probe program away; steps 8–9 are product decisions, not modeling ones.

## 5. Reproduce

Run ids: A `cc53907b-6636-4b92-9e31-290e26bd7fcd` · B `24eabcd2-1e88-4634-b20e-f8a9b1f5b5a0` · C `9f93561a-fc01-4604-be1b-47f4c6ff7232` · regions `7ca504c4-4647-4018-9345-64fe65e0a3de` · leagues `83434e8f-fb10-48f4-bec1-040d769814c5` · tennis `3c6b62b1-c86d-41df-bd86-e203cee64d03`.
New instruments: `scripts/backtest/shadow-band-analysis.ts`, `scripts/backtest/region-probe-analysis.ts`; probe plans and replay configs under `scripts/backtest/configs/probe-*`.
