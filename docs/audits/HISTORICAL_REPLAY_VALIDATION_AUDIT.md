# Historical CSV Replay — Validation Audit

**Date:** 2026-06-14
**Type:** AUDIT ONLY. No production code, models, thresholds, or config modified. Read-only analysis of the existing CSV replay + cross-checks against live data and theory.
**Question:** before acting on the replay's **LEGACY −6.0% / LOW_ODDS_LEGACY −3.8%**, validate the replay's assumptions — what it omits, which omissions help/hurt legacy, the expected error, and how confident we should be that legacy is genuinely negative in production.

---

## Executive Summary

The replay is **directionally trustworthy and its sign is well-corroborated**, but it is **not a 1:1 model of production** — it is "the four detectors, run on football-data soccer, with exact settlement." The biggest gaps are **book-set** (production's edge-generating Nordic/Kindred books are absent), **sport coverage** (soccer-only; no baseball/basketball), and **single-snapshot timing** (no polling time-series). None of these plausibly flips legacy positive, and a free per-league cross-check shows **legacy loses broadly across leagues** (not one outlier), including a −7.2% on **n=608 in Segunda — the very league the production "Historical" seed claims is +9%.**

**Confidence that legacy is genuinely negative (slightly −EV) in production: ~80%.** Four independent lines agree it is negative (CSV replay −6%/n5500 exact; live realized −5%/n53; live CLV −3.9%; and the model's mechanism = the documented anti-pattern). The only positive evidence ever produced (+24% legacy backtest) was n=53 with biased in-play inference — the weakest of all. The magnitude is uncertain (plausibly −2% to −8%); the **sign is very likely negative**, and there is **no credible evidence legacy is positive**.

---

## 1. What is MISSING from the replay (vs production)

| # | Missing / different | Production reality | Replay |
|---|---|---|---|
| M1 | **Polling time-series & 12h re-alert** | each match polled many times (1–4h tiers) over its pre-match life | **one** snapshot per match |
| M2 | **Snapshot timing** | polls a 1–4h pre-kickoff window | football-data single pre-match line (collection time uncertain, often earlier) |
| M3 | **Book set** | ~16–40 OddsAPI books; edges concentrate in **unibet/coolbet/leovegas (Kindred/Nordic), 84% of live rows** | B365, BW, BV, LB, CL, BFD, BMGM, WH, VC, IW + Betfair exchange — **the Kindred books are absent** |
| M4 | **Sport coverage** | soccer **+ baseball (MLB) + basketball (WNBA)** | **soccer 1X2 only** |
| M5 | **League mix** | Superettan, Veikkausliiga, Brazil B, Chile, Segunda… | European majors/2nd-divs dominate; Nordic/SA leagues thin (<30 legacy alerts) |
| M6 | **Cross-track ownership/conflict** | full suppression across models | legacy-family one-per-match only; rest approximated |
| M7 | **Movement / confidence grade** | 6h-move flat-flag graded | no time-series → grade uncomputable (**annotation only — no ROI effect**) |
| M8 | **Settlement quality** | OddsAPI scores feed: gaps, voids, 3-day window, historic silent-LOSS default | **exact** result column (**replay is BETTER here**) |

---

## 2. Which missing components would likely HELP legacy (prod better than −6%)

- **M2/M3 — softer/earlier prices:** if production polls *before* football-data's snapshot, and/or its Kindred soft books lag more than B365, production may catch genuine soft-lag edges before the line sharpens → better realized ROI than a single, possibly-late, B365-heavy snapshot. *(Plausible, magnitude unknown.)*
- **M4 — sport mix:** soccer is **3-way (Draw)**, a notoriously inefficient/awkward market; legacy betting Pinnacle on 3-way may be its **worst** case. If 2-way baseball legacy is less bad, soccer-only **overstates** the negativity. *(Plausible.)*
- **M5 — favoured leagues:** if production's Nordic/SA leagues behave better than the European 2nd-divisions that dominate the replay. *(Weak — the per-league check below is broadly negative.)*
- **M8:** the replay's exact settlement is *cleaner* than production's noisy feed; production's measured ROI could be dragged by settlement errors that the replay doesn't have. *(This makes the replay a better truth, not a reason prod is secretly positive.)*

## 3. Which missing components would likely HURT legacy (prod worse than −6%)

- **M1 — more alerts from polling:** a −EV strategy polled repeatedly just places **more** −EV bets; re-alerts at progressively worse prices can lower per-idea ROI.
- **M2 (other direction) — sharper window:** if production actually polls *closer* to kickoff than football-data's pre-match line, it detects on **sharper** lines → fewer/worse genuine edges → as bad or worse.
- **M3 — sharper consensus:** if the absent Kindred books would have *raised* the soft consensus (making Pinnacle look *less* high), real production edges are rarer/weaker than the replay's.
- **Attainability:** N/A — legacy bets **Pinnacle**, which doesn't limit winners, so no attainability haircut (neutral; this is legacy's one structural advantage).

**Net:** the help/hurt arrows are genuinely two-sided on timing and books; the one clearly-directional gap is **M4 (soccer-only may overstate)** — which argues prod could be *less* negative, not positive.

---

## 4. Free empirical cross-check — per-league legacy ROI (closes M5 partially)

Legacy by league in the replay (alerts ≥30; the leagues with the most data):

| League | Alerts | Win% | ROI | League | Alerts | Win% | ROI |
|---|---|---|---|---|---|---|---|
| **EC** (Eng Champ) | 806 | 40.4 | **−3.8%** | E3 (Eng L2) | 348 | 35.3 | −8.7% |
| **SP2 (Segunda)** | **608** | 37.0 | **−7.2%** | F2 (Ligue 2) | 374 | 37.7 | −3.9% |
| I2 (Serie B) | 425 | 32.7 | −16.0% | T1 (Turkey) | 248 | 36.7 | −11.2% |
| SC1/SC3 (Scotland) | 243/267 | ~35 | −15% / −17% | …positives → | E2 | 303 | **+11.0%** |

- **The negativity is broad-based:** the four largest-n leagues (EC 806, SP2 608, I2 425, F2 374) are **all negative**; ~15 of 22 leagues are negative. It is **not** a single-league artifact.
- **Red flag on the existing seed:** **Segunda (SP2) is −7.2% on n=608** here — yet the production "Historical" seed (`/roi`) claims Segunda is **+9% legacy** (from the *biased in-play-inferred* backtest). The large-sample exact replay directly contradicts the seed's flagship-league claim, which **strengthens** the case that legacy is negative and the seed is optimistic.
- **Caveat:** the high-n leagues are European 2nd-divisions; production's *exact* Nordic/SA favourites are thin here (M5 only partially closed). A few lower-English-division leagues (E1/E2/D2) are genuinely positive — so legacy is **league-dependent**, not uniformly bad.

(Pinnacle-led per-league: positive in most leagues — I2 +23%, EC +28%, B1 +46% — except Segunda −17%; small n. Consistent with the family-level story.)

---

## 5. Expected replay error

- **Statistical:** negligible. n=5,500 → ROI 95% CI ≈ ±2.9pp; legacy −6% CI ≈ **[−8.7, −3.2]**, excludes zero. As a *measurement of this strategy on this data*, the number is solid.
- **Systematic (the real uncertainty):** dominated by M3 (books), M4 (sport), M2 (timing), M5 (league mix). My honest band:
  - For **"legacy on European soccer with a B365-style consensus"**: −6% ± ~3pp. High confidence.
  - For **"production legacy across all its sports/books/leagues"**: a wider **±5–8pp systematic band** — but the **sign is robust** (broad-based per-league, plus three corroborating live/theory lines). The error is large enough to move the *magnitude* materially, **not** large enough to credibly flip the *sign* to positive.

---

## 6. How confident: is legacy actually negative in production?

**~80% confident it is genuinely negative (slightly −EV).** Reasoning — four independent lines, all negative:

| Evidence | Setup | n | Result | Strength |
|---|---|---|---|---|
| CSV replay | soccer, exact settlement | 5,500 | −6.0%, broad-based | High (huge n, exact) |
| Live realized | **actual production** (all sports/books) | ~53 | −4.8% to −6.2% | Low n, but real setup |
| Live CLV | actual production | ~45 | −3.9% | Proxy, but real setup |
| Mechanism/theory | bet sharp Pinnacle vs **vig-inflated** soft mean = documented anti-pattern | — | predicts −EV | Structural |

Contrary evidence: **only** the +24% legacy backtest (n=53, **biased in-play inference**) — the least reliable instrument in the project. The convergence of four independent lines, with the contrary one being the weakest, is compelling. The residual ~20% doubt is exactly the book/sport/timing gaps (M2–M5) — they could make production *less* negative or even breakeven on some sub-universe, but nothing points to genuinely positive.

**Bottom line:** the burden of proof has flipped. There is no credible evidence legacy is positive; four lines say negative. Treat legacy as **−EV until proven otherwise**, with magnitude uncertain.

---

## 7. If directionally correct — what to TEST first (no implementation here)

Ordered by expected value; all are *tests*, not changes:

1. **Re-examine the production "Historical" seed's legacy figures — especially Segunda.** The seed feeds `/roi` and claims Segunda legacy +9%; the exact replay says −7.2% (n608). The seed's in-play-inferred legacy ROI is likely **optimistically biased**; quantify and caveat it before any decision rests on it. *(Free, highest-value — it corrects a number people are looking at today.)*
2. **Segment LIVE legacy by sport.** The replay is soccer-only (M4). Check whether live legacy also loses on **baseball/basketball**, or whether soccer is the drag. *(Free; closes the biggest "help" gap.)*
3. **Shadow the legacy family (test, don't commit).** Legacy is **95% of alert volume and −EV**; the cheapest high-EV test is to **route legacy to shadow-only** (keep recording, stop treating it as a primary staked signal) and let the forward live sample decide, while **growing the Pinnacle-led sample** (the only positive-leaning family). This is presentation/weighting, not detection.
4. **Do NOT** test de-vigging legacy (prior audit: it destroys ~99% of volume) or league-cherry-picking legacy into its few positive divisions (small-n overfit).

**Single highest-value action:** #1 + #2 (free truth-corrections) before #3 (the weighting test). Do not flip any switch on the strength of one replay — but stop treating legacy's volume as if it were value.

---

## 8. Honest limitations of THIS validation

- The per-league check covers European 2nd-divisions well but **not** production's exact Nordic/SA favourites (thin in the CSV).
- "~80% confident" is a calibrated judgement from convergent evidence, not a computed probability.
- Soccer-only remains the largest unclosed gap; only live per-sport legacy data can close it.
- The replay is a *better* settlement instrument than production, but a *narrower* universe — both facts must be held at once.

---

*Audit only. No production code, models, thresholds, sports, or configuration were modified. The per-league cross-check used a temporary, reverted console addition to the existing replay script (read-only; no data persisted). 0 API credits.*
