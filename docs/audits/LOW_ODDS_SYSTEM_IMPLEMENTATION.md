# Low Odds System — Implementation Audit

**Date:** 2026-06-12
**Credit usage: 0** — the odds-bucket validation and threshold selection ran entirely on stored historical data (3 free legacy replays at a lowered floor; no new imports, no probes).
**Validation:** `npx tsc --noEmit` 0 errors · ESLint 0 errors · 11/11 low-odds checks + 3/3 dual-model regression checks pass.

---

## 1. Architecture

Two new tracks beside the existing two, all four running over the **same single snapshot read per detection pass** — zero additional polling, zero API cost:

| Track | Odds range | Edge range | Threshold source |
|---|---|---|---|
| PINNACLE_LED (unchanged) | ≤ 3.0 | ≥ 3% (+2–3% shadow) | as before |
| LEGACY (unchanged) | ≤ 3.0 | ≥ 5% | as before |
| **LOW_ODDS_PINNACLE_LED** | **[1.10, 2.20)** | **[bucket floor, 3%)** | §2 |
| **LOW_ODDS_LEGACY** | **[1.10, 2.20)** | **[3%, 5%)** where enabled | §2 |

The low-odds tracks own only the edge ranges **below** the main thresholds, so main-system behavior, volume, and thresholds are untouched by construction. The legacy core now runs once per match with a 3% floor and the results are split by band — the ≥5% set entering the LEGACY track is identical to before. The pinnacle low-odds track claims qualifying candidates that would otherwise have been **silent shadow rows** (the only main-system interaction: those triples are stored as alerting low-odds rows instead of non-alerting shadow rows — no alert loss anywhere, strictly alert gain).

New models in the `DetectionModel` enum (`LOW_ODDS_LEGACY`, `LOW_ODDS_PINNACLE_LED`) + nullable `confidence` column; migration `20260612121555_add_low_odds_tracks`. Attribution flows through detection → persistence → notifications → settlement → CLV → ROI → reporting exactly as in the dual-model implementation (settlement and CLV are row-level and model-agnostic; no changes needed).

## 2. Odds-Bucket Validation (the mandated Phase 1) and Resulting Thresholds

Idea-level, settled by the Historical ROI Engine, CLV vs the Pinnacle close (`scripts/backtest/odds-bucket-analysis.ts`; legacy 3% floor runs `48cd67b7`/`1f7f77fa`/`d11b863d`):

**Pinnacle-led (edges 2–3%, i.e. the band the low track would own):**
| Bucket | Evidence | Decision |
|---|---|---|
| 1.10–1.30 | n=1 settled, +20% ROI, CLV +0.1 | enable @ **2.0%** (sparse) |
| 1.30–1.50 | no settled evidence | enable @ **2.5%** (conservative) |
| 1.50–1.80 | 2.0–2.5% band: +58.5% ROI, CLV **+8.0**; 2.5–3.0: +71%, CLV +4.6 | enable @ **2.0%** (strongest bucket) |
| 1.80–2.20 | 2.5–3.0: +90% (n=1), CLV **+10.4**; 2.0–2.5 unsettled | enable @ **2.5%** |

The headline finding: the 2–3% shadow band — measured junk *overall* in earlier audits — is **CLV-positive in every low-odds bucket**. Low odds are where the shadow tier's value was hiding.

**Legacy (edges 3–5%, surfaced by the free lowered-floor replays):**
| Bucket | Evidence | Decision |
|---|---|---|
| 1.10–1.30 | +27% (n=1) | enable @ **3.0%** |
| 1.30–1.50 | **−43% ROI (2W–3L)** | **ABORTED — bucket disabled** (the abort condition firing as designed) |
| 1.50–1.80 | **9W–0L, +64.2% ROI** (n=9, expW 5.7 — far above calibration) | enable @ **3.0%** |
| 1.80–2.20 | **8W–2L, +58.0% ROI** (n=10) | enable @ **3.0%** |

Caveats carried from the ROI engine: 10–42% settlement coverage per cell, one-sided-finish selection, n per cell ≤ 10. These thresholds are the *evidence-supported starting configuration*, expected to be re-tuned on live settlement data.

## 3. Duplicate Protection & Conflict Resolution (mandatory requirements)

**Ownership — one system per opportunity, first claim wins, permanent:**
- Pinnacle family, per (match, bookmaker, outcome): production, shadow, and low-odds claims mutually block each other across tiers and tracks. A triple claimed by the low-odds track is never re-claimed by main (and vice versa) — no duplicate Discord messages, no duplicate accounting, ever.
- Legacy family, per (match, outcome): the owning track is recorded; the other legacy track is blocked permanently; the owner itself re-claims only after the original 12-hour suppression window.

**Contradiction suppression (Legacy V2 cleanup, applied to BOTH legacy tracks and the low-odds pinnacle track):**
1. **Batch-level keep-strongest:** at most one outcome per match per batch survives — the highest edge wins; Home+Away / Home+Draw / Away+Draw simultaneous candidates are impossible by construction, with each suppression logged (`legacy-family conflict — kept strongest (...)`).
2. **Cross-batch contradiction guard:** a candidate whose outcome differs from any already-recorded opportunity of the same family on the same match is suppressed (`contradicts an existing ... opportunity on this match`).
3. Main PINNACLE_LED is deliberately untouched ("no logic changes"): its idea-level design treats opposite-outcome ideas as distinct and rare; the audit trail flags them.

## 4. Confidence Scoring (Legacy A/B/C — main + low-odds legacy)

`legacy-confidence.ts`: +1 per signal — consensus breadth (≥10 books), supportive movement (Pinnacle 6h drift ≥ +1%, legacy's best settled class at +33.5% ROI), edge depth (≥8%). **2–3 signals → A, 1 → B, 0 → C.** Stored on every legacy-family row, displayed in alerts (`🔠 Confidence: **A**`), distributed in `/roi` sections. **Ranking/reporting only — zero suppression, zero volume impact** (verified: grading happens after all dedup/conflict decisions).

## 5. Discord Routing

New optional env `DISCORD_LOW_ODDS_CHANNEL_ID` (→ `#bet-alert-lower-odds`). LOW ODDS alerts route **only** there; if unset, low-odds rows are stamped without posting (storage/settlement/ROI continue, warning logged) — they can never leak into the main channel. Verified rendered output:

```
🎯 **VALUE BET — Home**
**(LOW ODDS LEGACY SYSTEM)**
⚽ Soccer | Home FC vs Away FC | Superettan
💰 **Best:** 1.65 @ Pinnacle  (edge +3.0%, fair 1.60)
📊 Books agreeing: 1 family | Pinnacle 6h: +1.5% (moving away from outcome)
🔠 Confidence: **A**
```
```
🎯 **VALUE BET — Home**
**(LOW ODDS EXPERIMENTAL PINNACLE-LED SYSTEM)**
💰 **Best:** 1.72 @ Coolbet  (edge +3.0%, fair 1.67)
```

## 6. Reporting

`/roi`, `/clv`, `/paper-bankroll` now offer five views: **Combined / Legacy / Pinnacle / Low Odds Legacy / Low Odds Pinnacle** (shared `MODEL_OPTION_CHOICES`). Combined renders one clearly-labelled section per track with alert volume (ideas + rows), W/L, win rate, P&L, ROI, CLV, and — for legacy-family sections — the **A/B/C confidence distribution**. Daily summary and Rich Presence aggregate per track (ideas never merge across tracks).

## 7. Expected Impact

| | Volume (in-season) | Quality basis |
|---|---|---|
| LOW_ODDS_LEGACY | **≈ +3.5–4/day** (full-grid measured 5.7/d across enabled buckets; live cadence ≈ 65–70%; conflict resolution trims further) | 17W–2L settled across enabled buckets, +58–64% ROI point estimates |
| LOW_ODDS_PINNACLE_LED | ≈ +0.5–0.7/day | CLV +4 to +10% in its buckets; ROI cells positive but tiny n |
| Main tracks | **unchanged** | by construction |

Combined system output roughly triples (~4–5 → ~8–10 ideas/day in season), which is precisely the sample-generation objective: the low-odds tracks alone should produce a ~200-idea real-settlement sample in ~6–8 weeks.

## 8. Verification Results

| Requirement | Result |
|---|---|
| Existing systems still work | ✅ main-track code paths unchanged except documented ownership/conflict additions; dual-model render regression passes; `tsc`/ESLint clean |
| No increase in API costs | ✅ zero new polling — all four tracks share one snapshot read; validation used 0 credits |
| No duplicate alerts / accounting | ✅ first-claim permanent ownership per family (verified key logic; suppressions logged) |
| No contradictory alerts | ✅ keep-strongest per match per batch + cross-batch contradiction guard (legacy family + low-odds pinnacle) |
| Low-odds alerts only in #bet-alert-lower-odds | ✅ routing verified; unset channel ⇒ stamp-without-post, never main-channel leak |
| Reporting separated | ✅ 4 tracks × all metrics + confidence distribution; 5 command views |
| Bucket abort condition honored | ✅ legacy 1.30–1.50 disabled on −43% measured ROI, with evidence documented |

## 9. Files

`prisma/schema.prisma` + migration · `src/value-detection/low-odds-config.ts` (new) · `legacy-confidence.ts` (new) · `value-detection.service.ts` (4-track orchestration, ownership, conflicts) · `value-detection.types.ts` · `value-opportunity.repository.ts` · `index.ts` · `src/config/{discord.config,config.types}.ts` · `src/ingestion/bootstrap/ingestion-dependencies.ts` · `src/discord/discord-notification.service.ts` (routing, tags, confidence) · `reporting-config.ts` · `commands/{roi,clv,paper-bankroll}.ts` · `discord-bot.service.ts` · `scripts/verify-low-odds-system.ts` + `scripts/backtest/odds-bucket-analysis.ts` (new instruments).

*Operator action required: create `#bet-alert-lower-odds` in Discord and set `DISCORD_LOW_ODDS_CHANNEL_ID` in `.env` — until then low-odds rows accumulate (settled, CLV'd, reported) without posting.*
