# Pure Detector Core Extraction — Implementation Audit

**Date:** 2026-06-12
**Authority:** `HISTORICAL_BACKTESTING_ENGINE_DESIGN.md` §1 — "the one production-code prerequisite": the detection math must live in a pure module shared by live detection and the replay engine, or every backtest describes a model that isn't the one in production.
**Validation:** `npx tsc --noEmit` — 0 errors; ESLint — 0 errors; live replay-parity check below.

---

## What Was Extracted

New module: `src/value-detection/detector-core.ts`

```
detectFromBatch(batch: DetectorInputRow[], config: DetectorConfig)
  → { candidates, decisions, referenceOverround, referencePrices }
```

The core now owns, as a pure function of (batch, config):

| Concern | Previously |
|---|---|
| Input validation (empty outcomes, prices ≤ 1) | inline in `ValueDetectionService` |
| Reference-market assembly + duplicate-price conflict detection | inline |
| De-vigging + overround sanity bounds [0.99, 1.15] | inline |
| Exchange exclusion (config flag `excludeExchanges`) | inline |
| Market-structure guard (outcome-set match) | inline |
| Odds cap, edge formula, edge cap | inline |
| Production / shadow tier classification | inline |

Also moved into the core: `referenceMovementPct()` + `PricePoint` (movement math is shared by live annotation and replay annotation).

**What deliberately stayed in `ValueDetectionService`** (stateful by nature): loading the latest batch per match, tier-aware permanent dedup against the database, movement *history assembly* from already-loaded batches, persistence, and the `DETECTED` / `DETECTED_SHADOW` / `SUPPRESSED` decision logging (those decisions depend on dedup state the pure core cannot know).

`PRODUCTION_DETECTOR_CONFIG` is exported as the single source of the live constants (reference book `pinnacle`, shadow 2%, production 3%, max edge 100%, odds cap 3.0, overround bounds, exchanges excluded). The service uses it verbatim with `maxCandidateOdds` injected from app config; replay baselines use it so backtests describe production by construction.

## Files Modified

| File | Change |
|---|---|
| `src/value-detection/detector-core.ts` | **New** — the pure core |
| `src/value-detection/value-detection.service.ts` | Detection math deleted; per-match loop now maps the latest batch to `DetectorInputRow[]`, calls `detectFromBatch`, logs the returned decisions (REJECTED → rejected counter, others → skipped), then applies dedup/movement/insert to the returned candidates |
| `src/value-detection/index.ts` | Exports the core function, config, and types |

No schema change, no behavior change intended.

## Behavior-Preservation Evidence

1. **Type-level:** `npx tsc --noEmit` clean; counters (`detected`, `detectedShadow`, `rejected`, `skipped`) map 1:1 to the old branches.
2. **Empirical (the strong one):** `scripts/backtest/parity-check.ts` replays the live snapshot store since the V2 baseline (2026-06-10T20:00Z) through the extracted core and diffs against the actual stored `ValueOpportunity` rows: **6 of 6 current-model rows reproduced exactly (tier included); the only 4 differences are the documented pre-exclusion exchange rows** — i.e. rows produced by a *config* that no longer exists, not by different math. Verdict: PARITY OK.
3. **Unit-level:** 16 synthetic checks in `scripts/backtest/synthetic-verify.ts` exercise the core through the replay engine (tiering, structure guard, odds filter, exchange exclusion, conflict detection via decision tallies) — all pass.

## Why This Mattered Beyond the Engine

- The money-math is now unit-testable in isolation (open P2 from `FINAL_V1_AUDIT.md`) — `detectFromBatch` needs no Prisma, no logger, no mocks.
- Every future detection tweak lands in exactly one place; live and backtest can no longer drift apart silently. The parity script is the standing tripwire: if its diff is ever non-empty for same-config data, the engine is lying about production and all runs are suspect.

## Rollback

Revert the commit. The old inline implementation is recoverable from git history; no data or schema state involved.
