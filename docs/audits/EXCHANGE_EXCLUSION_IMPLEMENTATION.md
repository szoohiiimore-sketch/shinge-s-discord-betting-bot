# Exchange Exclusion — Implementation Audit

**Date:** 2026-06-11
**Authority:** standing P0 from `ROI_MAXIMIZATION_AUDIT.md` / `BOOKMAKER-COVERAGE-AUDIT.md`, ranked #1 in `ALERT_STRATEGY_REVIEW.md` Part X and `HISTORICAL_BACKTESTING_ENGINE_DESIGN.md` §9; implemented exactly as audited (candidacy-level exclusion; storage and history untouched).
**Validation:** `npx tsc --noEmit` — **0 errors**; ESLint clean; live-data replay verification below.

---

## Files Modified / Created

| File | Change |
|---|---|
| `src/value-detection/idea-aggregation.ts` | `EXCHANGE_BOOKMAKERS` set extended and re-documented — it is the single canonical exchange list, shared by detection, alerting, headline selection, and corroboration counting |
| `src/value-detection/value-detection.types.ts` | New decision variant `EXCHANGE_EXCLUDED` |
| `src/value-detection/value-detection.service.ts` | Candidate loop skips exchange bookmakers before any evaluation — they can never reach the edge computation, tier classification, or insert path |
| `scripts/exchange-exclusion-verify.ts` | **New** read-only verification: replays detection with exclusion over the Dallas Wings vs Phoenix Mercury snapshots |

**Untouched:** schema (no migration), idea-level accounting, idea-level alerts, movement annotation, CLV calculation, ROI/paper-bankroll/daily-summary/presence, settlement, scheduler, thresholds, dedup.

---

## Exact Logic Added

In `ValueDetectionService`, at the top of the per-bookmaker candidate loop (after the reference-book skip, before the market-structure guard):

```typescript
// Exchange exclusion: exchanges quote pre-commission back prices whose
// nominal edge vs de-vigged Pinnacle is overstated by the 2–5% commission.
// They never become opportunities — production or shadow.
if (isExchange(bookmaker)) {
  this._decision('EXCHANGE_EXCLUDED', { matchId, bookmaker });
  skipped++;
  continue;
}
```

Because the skip precedes every evaluation step, an exchange bookmaker can never produce a `ValueOpportunity` row of either tier — the opportunities never exist, exactly as required. Each exclusion is logged as a `EXCHANGE_EXCLUDED` decision (debug level), keeping the per-decision audit trail complete.

## Bookmakers Excluded

Canonical set (in `idea-aggregation.ts`, used by all consumers):

| Key | Exchange | Status |
|---|---|---|
| `betfair_ex_uk` | Betfair Exchange (UK label) | Required; active in current data |
| `betfair_ex_eu` | Betfair Exchange (EU label — same order book) | Required; active in current data |
| `smarkets` | Smarkets | Required; active in current data |
| `matchbook` | Matchbook | Required; active in current data |
| `betfair_ex_au` | Betfair Exchange (AU label) | **Added by audit** — arrives with the planned `au` region expansion |
| `novig` | Novig (no-vig exchange) | **Added by audit** — `us_ex` region |
| `prophetx` | ProphetX (exchange) | **Added by audit** — `us_ex` region |

Audit of the remaining 49 stored bookmaker keys: all are conventional sportsbooks (including `betfair_sb_uk`, which is Betfair's *sportsbook* product, not the exchange — correctly **not** excluded). The three additions exist on The Odds API in regions on the expansion roadmap (`ROI_MAXIMIZATION_AUDIT.md` P1 #9); including them now means the region expansion cannot silently reintroduce exchange candidates.

---

## Before / After — Dallas Wings vs Phoenix Mercury (required verification)

This is the exact match that produced the exchange alerts. Replay of the latest snapshot batch (2026-06-11 10:00 UTC, 29 books, Pinnacle overround 1.0494) through the new logic:

| | Before (yesterday's actual behaviour) | After (verified replay) |
|---|---|---|
| Exchange candidates | betfair_ex_uk and betfair_ex_eu evaluated as candidates | **`EXCHANGE_EXCLUDED` ×2 — never evaluated** |
| Opportunity rows | 2 shadow rows (2.11%) + 2 production rows (3.51%) created | **0 rows created** |
| Idea | exchange-only "Phoenix Mercury" idea existed (k=0) | **No idea exists** |
| Alerts | 2 Discord alerts sent (one per Betfair label) | **0 alerts** |
| Accounting entry | idea would settle into `/roi` etc. via headline fallback | **Nothing to settle** |
| Genuine bookmakers | 26 non-exchange candidates evaluated | 26 evaluated identically — **0 detections ≥2%**, confirming the match's entire "edge" was the exchange-commission illusion |

The last row is the most telling: with exchanges out, this match generates nothing at any tier — the apparent value was never real. The Helsingborgs idea (coolbet/unibet/leovegas — all genuine books) is unaffected.

---

## Impact Assessment

- **Alert volume:** of the 8 new-model rows to date, 5 (62%) were exchange rows; of the 2 ideas, 1 was exchange-only. Expected effect: roughly −40–60% of raw detections, −0 genuine alerts (the idea-level alert layer already refused exchange-only ideas; this moves the fence from the alert gate to the front door). Volume now consists only of bettable books.
- **ROI:** no displayed number changes (zero post-baseline settlements). Going forward, no commission-illusion bets can enter the sample, so per-bet paper ROI stops being inflated by edges that vanish after 2–5% commission.
- **CLV:** the gate sample is protected from its largest fake-positive source — exchange back prices systematically "beat the close" nominally while being unattainable at that effective price. The two legacy exchange production rows will still settle and receive CLV (history preserved); they are the known short-lived contamination already documented in `CLV-TRACKING-IMPLEMENTATION.md`-style caveats.
- **Idea-level accounting:** exchange-only ideas can no longer exist; the headline-selection exchange fallback in `idea-aggregation.ts` becomes legacy-only code (still correct for the 2 historical exchange rows when they settle).
- **Historical data:** zero rows deleted or modified; settled records, ROI history, and CLV history untouched. Verified by diff scope — the only write-path change is a `continue` before insert.

## Rollback

Revert the commit (or delete the 6-line block in `value-detection.service.ts`) — exchanges resume candidacy on next deploy. No data state to unwind; the `EXCHANGE_EXCLUDED` decision type and the extended set are harmless if unused.

## Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Genuine bookmaker accidentally excluded | None found | High | Set audited against all 53 stored keys; `betfair_sb_uk` (sportsbook) deliberately kept as candidate |
| Exchange row still created via another path | None | High | Single insert path (`toInsert` → repository); the skip precedes it unconditionally; replay verified 0 rows |
| Lost volume hides real edge | Low | Medium | Exchange prices remain fully stored in `OddsSnapshot` — nothing is lost for research; the backtesting engine can run `excludeExchanges: false` arms any time (`HISTORICAL_BACKTESTING_ENGINE_DESIGN.md` §5) |
| Future region expansion reintroduces exchanges | None | Medium | `betfair_ex_au`, `novig`, `prophetx` pre-excluded |
| Detection volume drop misread as system failure | Medium | Low | Expected and documented here; `EXCHANGE_EXCLUDED` decisions visible in logs; shadow tier still measures the 2–3% band on genuine books |

---

## Requirement Verification

| Requirement | Status |
|---|---|
| betfair_ex_uk / betfair_ex_eu / smarkets / matchbook never create opportunities | ✅ Skip precedes all evaluation |
| Additional exchange-type bookmakers audited and included | ✅ betfair_ex_au, novig, prophetx added; betfair_sb_uk verified as non-exchange |
| Exclusion at detection level — no production rows, no shadow rows, rows never exist | ✅ Verified by replay (0 rows, 0 ideas, 0 alerts on the Wings match) |
| Historical data preserved (no deletes, no modified settled records / ROI / CLV) | ✅ No write-path change other than the pre-insert skip |
| Storage architecture preserved (idea layer, movement, CLV, ROI, bankroll, summary) | ✅ Untouched |
| Traditional bookmakers continue working | ✅ 26 genuine candidates evaluated identically in replay |
| `npx tsc --noEmit` | ✅ 0 errors |
