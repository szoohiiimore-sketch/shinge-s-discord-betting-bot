# Volume-First Configuration Audit — Maximum Alert Volume With Positive CLV

**Date:** 2026-06-12
**Objective (owner-set):** 5–7 alerts/day; acceptable trimmed CLV 1.2–2.6%; volume > CLV purity. Implement automatically if ≥5/day with positive CLV is achievable.
**Method:** Historical Backtesting Engine over all existing imported data (8 sports, ~620k rows) plus two targeted probes purchased under the 5,000-credit hard cap. Every number below is measured; nothing is estimated where data exists.

**Credit usage report (hard cap 5,000):**
| Probe | Credits |
|---|---|
| 5 soccer leagues (MLS, J-League, K-League, Argentina Primera, Brazil Série A) — 21 days | 3,045 |
| NBA + NHL playoffs — 21 days | 1,342 |
| **Total** | **4,387 / 5,000** ✓ (quota after: ~70.4k remaining) |

---

## 1. The Headline Answer

**≥5 alerts/day with positive CLV is NOT achievable on the measured evidence — and this audit can now prove why instead of guessing.** The two probes bought for this audit returned the decisive negatives:

1. **The league-expansion path is dead.** 5 plausible new soccer leagues over 21 days produced **4 production ideas (0.19/day) at −4.31% CLV, 0% positive** — and all 4 came from MLS, which is *already polled in production* and turns out to be an active CLV-negative source. Japan J-League, K-League 1, Argentina Primera, Brazil Série A: **zero ideas in 21 days combined.** The model's edge does not generalize beyond the Nordic/Iberian soft-book cluster; the prior audit's "1-in-3 dud rate" extrapolation was optimistic — outside the cluster it measured 5-in-5.
2. **US majors are not a volume source.** NBA+NHL playoffs over 21 days: 3 ideas (0.14/day) at +1.71% — Tier-B grade quality, negligible volume, all NBA (NHL: zero).
3. **The remaining unprobed universe cannot bridge the gap.** Esports, table tennis, volleyball, handball: **not offered by The Odds API at all** (esports came from the defunct OddsPapi). What remains (cricket, rugby, AFL, boxing, MMA) is structurally like NBA/tennis — sharp-priced majors where this audit's two sharp-market probes (tennis +0.97%, NBA +1.71%) bound the expectation at ~0.1–1.0 ideas/day of Tier-B quality each, in season.

The arithmetic of every positive-CLV source, maximally boosted, tops out at ≈ **4.1/day during tennis-major weeks and ≈ 2.5/day otherwise (≈ 3.0/day annualized)**. Per the owner's own criterion (implement only at ≥5/day), **no automatic implementation was performed** — the configuration below is specified, ready to ship on approval.

## 2. Complete Measured Evidence Ledger

All idea-level, trimmed CLV, live-cadence unless noted; booster = full-grid measurement where available.

| Source | Ideas/day | Trimmed CLV | n | Verdict |
|---|---|---|---|---|
| Superettan @3% | 0.47 → 0.53 boosted | **+4.7%** | 22 | **Tier A** |
| Allsvenskan @3% | 0.27 → 0.45 boosted | **+5.6%** | 10 | **Tier A (add)** |
| Segunda @3% | 0.30 → 0.40 boosted | **+4.1%** | 14 | **Tier A** |
| Segunda 2.5–3.0% band | +0.15 | **+6.0%** (avg) | 7 | **Tier A @2.5% threshold** |
| WNBA @3% | 0.09 → 0.17 boosted | **+7.0%** (100% pos) | 4–8 | **Tier A** |
| Allsvenskan/Nordic 2.0–3.0% band | +0.35 | +2.8% | 14 | **Tier B** |
| Tennis majors @3% (in-event) | 1.00 | +0.97% | 13 | **Tier B** |
| Tennis 2.5–3.0% band (in-event) | +0.62 | +2.8% | 8 | **Tier B @2.5% threshold** |
| Veikkausliiga @3% | 0.14 → 0.18 | +1.8% | 5 | **Tier B** |
| NBA playoffs @2.5% | 0.24 (in playoffs) | +1.7–3.4% | 3–6 | **Tier B (seasonal)** |
| Eliteserien | ~0 | −15% (n=1) | 1 | Shadow only |
| Brazil Série B | 0.13 | **−1.0%** | 6 | **Shadow only (remove from alerts)** |
| **MLS** | 0.19 | **−4.3% (0% pos)** | 4 | **Shadow only (remove — currently live!)** |
| J-League, K-League, Argentina, Brazil-A | **0.00** | — | 0 | Do not add |
| NHL playoffs | 0.00 | — | 0 | Do not add; 4h poll for settlement only |
| MLB | 0.00 (live store: 3,362 evals, 0 edges ≥2%) | — | — | **Quota waste — demote 60min → 4h** |
| 20 idle tennis tour keys | 0.00 (no events) | — | — | **Quota waste — season-gate** |
| 2.0–2.5% band (core leagues) | +0.55 | **−0.6 to +0.7%** | 26 | Stays shadow |
| Corroboration k≥2 promotion (sub-3%) | +0.21 | **−1.0%** | 10 | Rejected (measured) |
| AU/US2 regions | +0.00 | — | probe | Rejected (measured) |
| Esports / table tennis / volleyball / handball | — | — | — | **Not available on The Odds API** |

## 3. Optimal Configuration (highest volume that remains plausibly profitable)

### Tier A — gate-grade alerts (counted in the CLV gate sample)
| Sport key | Threshold | Polling |
|---|---|---|
| soccer_sweden_superettan | 3.0% | 60 min + near-kickoff booster (15–30 min ≤2h out) |
| soccer_sweden_allsvenskan | 3.0% | same |
| soccer_spain_segunda_division | **2.5%** (measured-positive band) | same |
| basketball_wnba | 3.0% | same |

**Tier A expected: ≈ 1.7 alerts/day @ ≈ +3.8% trimmed CLV.**

### Tier B — labelled "⚠ B-tier" alerts (excluded from the gate sample)
| Sport key | Threshold | Notes |
|---|---|---|
| tennis majors/Masters keys (seasonal) | **2.5%** | ~1.6/day during events (~35% of year), ~+1.6% |
| soccer_sweden_allsvenskan band 2.0–3.0% | 2.0% as Tier B | +0.35/day @ +2.8% |
| soccer_finland_veikkausliiga | 3.0% | +0.18/day @ +1.8% |
| basketball_nba (playoffs only) | 2.5% | +0.24/day in season @ ~+2% |

**Tier B expected: ≈ 2.3/day during tennis events, ≈ 0.7/day otherwise.**

### Shadow only (stored, never alerted)
`soccer_brazil_serie_b`, `soccer_usa_mls` (**both currently alert-eligible in production — these are the removals that *raise* ROI**), `soccer_norway_eliteserien`, 2.0–2.5% bands everywhere outside Allsvenskan.

### Removed / demoted from polling (quota recovery)
- 20 idle tennis tour keys → season-gated registration (≈ −480 polls/day idle burn)
- `baseball_mlb` 60 min → 4 h (settlement coverage only; ~60% of all snapshot volume was MLB finding nothing)
- `americanfootball_ncaaf` → off until late August
- `icehockey_nhl`, J/K/Argentina/Brazil-A keys → not added
- Esports cron remnants (C1) → standing critical, kill them

### Expected totals
| Metric | Tennis-event weeks | Other weeks | Annualized |
|---|---|---|---|
| **Alerts/day (A+B)** | **≈ 4.0–4.3** | **≈ 2.4–2.6** | **≈ 3.0** |
| Blended trimmed CLV | ≈ +2.6% | ≈ +3.4% | **≈ +2.9%** (inside the 1.2–2.6 floor with margin; Tier A alone ≈ +3.8%) |
| Profitability confidence | Tier A: moderate-high (consistent, calibrated, out-of-sample) · Tier B: low-moderate (thin positive margins, small n) | | |
| Monthly API usage | ≈ 60–90k credits (vs current 240–320k) after season-gating + MLB demotion + slate-aware polling — the config *reduces* spend while quadrupling effective coverage | | |

**This is the ceiling.** Reaching 5–7/day from here would require promoting measured-negative classes (2.0–2.5% core bands, k≥2 sub-threshold, MLS/Brazil-B) — every additional alert from those sources has *negative* expected CLV and lowers expected ROI. Volume bought there isn't cheap, it's worse than free.

## 4. Threshold Analysis Summary
- **Global threshold cut: rejected.** 2.0–2.5% band trimmed CLV: −0.57% (tennis), +0.70% (core), −1.0% (k≥2 slice) — only Allsvenskan's band is solidly positive.
- **League-specific thresholds: adopted** — Segunda 2.5% (Tier A), tennis 2.5% (Tier B), everything else 3.0%. This is where the volume-quality frontier actually lives.
- **Bookmaker-specific thresholds: insufficient n** (cells of 1–8); revisit at ~3× data.
- **Movement-based promotion: still unanswerable** from targeted grids (most 6h windows empty); the live annotation will answer it in ~3–4 weeks.

## 5. Would I personally deploy this configuration with real money?

**No.** And not because of CLV.

I *would* deploy it today as the paper/alerting configuration — it dominates the current one on every axis: ~3× volume, removes two measured-negative live alert sources (MLS, Brazil Série B), cuts API spend by ~70%, and keeps the gate sample clean via tiering. That implementation is specified above and ready.

Real money — no, for three reasons that volume cannot fix:
1. **Attainability is still a complete unknown.** Every CLV figure here is at recorded soft-book prices. The books carrying the edge (Kindred skins, Coolbet, LeoVegas) are precisely the books that limit winners within weeks. Until ~50–100 real or semi-real bets exist, expected real ROI could plausibly be anywhere from +3% to negative.
2. **The cells are thin.** Tier A rests on 50–60 ideas across 4 leagues; Tier B on 8–18 per source. One bad month would not even be distinguishable from variance. The configuration above is the right *instrument* for fixing this — at ~3/day the 200-idea gate sample arrives in ~10 weeks instead of 7 months.
3. **The platform isn't ready even if the model is** — C1/C2/C4 criticals remain open, and a real-money system with a silent-LOSS settlement default is disqualified on that alone.

The honest deployment sequence: ship this configuration on paper now → let the live CLV gate run at 3× speed → make the real-money decision on ~200 Tier-A ideas in ~10 weeks, with the attainability question answered by small-stakes live probing, not by any backtest.

## 6. Run Ledger (reproducibility)
`cc53907b` core live-cadence · `24eabcd2` core full-grid · `9f93561a` core 60-min · `83434e8f` Nordic live-cadence · `e0c38b46` Nordic full-grid · `3c6b62b1` tennis · `7ca504c4` AU/US2 · `601a4233` soccer5 probe · `35c6f9fd` NBA/NHL probe. Analyses: `scripts/backtest/shadow-band-analysis.ts`, `inventory.ts`, `region-probe-analysis.ts`.
