# Market-Undefined Fix — OddsSnapshot Ingestion

**Date:** 2026-06-08
**Severity:** Production blocker (OddsSnapshot count frozen at 118, no new value bets)
**TypeScript:** ✅ Clean after fix

---

## Root Cause

`mapOddsMarket(key: OddsMarketKey)` in `src/ingestion/mappers/mapper.utils.ts` had a `switch` statement with three explicit cases (`h2h`, `spreads`, `totals`) and **no `default` branch**. When called with any other value — including `undefined` — the function returned `undefined` implicitly.

At runtime, Betfair Exchange bookmakers (`betfair_ex_uk`, `betfair_ex_eu`) appear in The Odds API response when `regions: 'eu,us,uk'` is requested. These bookmakers return markets whose `key` values are not in the `OddsMarketKey = 'h2h' | 'spreads' | 'totals'` union (TypeScript types are erased at runtime; the API can return any string).

The resulting `CanonicalOddsSnapshot` objects had `market: undefined`. When `OddsSnapshotRepository.insertMany()` passed these records to `prisma.oddsSnapshot.createMany()`, Prisma validated every record and threw:

```
PrismaClientValidationError: Argument `market` is missing.
```

Because `createMany` is atomic, **the entire batch failed** — including all valid records from other bookmakers. The failed job was retried, failed again, and the `odds-fetch failed` counter grew while `OddsSnapshots` stayed at 118.

### Data flow

```
API response (Betfair, market.key = unknown)
  → OddsApiEventMapper._mapOddsSnapshots()
  → mapOddsMarket(market.key)   ← returns undefined (no default branch)
  → CanonicalOddsSnapshot { market: undefined }
  → OddsSnapshotRepository.insertMany(snapshots)
  → prisma.oddsSnapshot.createMany(data)   ← PrismaClientValidationError: market missing
  → ENTIRE BATCH fails (0 records inserted)
```

---

## Files Changed

### `src/ingestion/mappers/mapper.utils.ts`

Changed `mapOddsMarket` return type from `IngestionOddsMarket` to `IngestionOddsMarket | undefined` and added a `default: return undefined` branch.

```diff
-export function mapOddsMarket(key: OddsMarketKey): IngestionOddsMarket {
+export function mapOddsMarket(key: OddsMarketKey): IngestionOddsMarket | undefined {
   switch (key) {
     case 'h2h':     return 'H2H';
     case 'spreads': return 'SPREADS';
     case 'totals':  return 'TOTALS';
+    default:        return undefined;
   }
 }
```

### `src/ingestion/mappers/odds-api-event.mapper.ts`

Added an early `continue` in `_mapOddsSnapshots()` to skip any market whose key does not map to a known canonical value.

```diff
+        // Skip markets with unrecognised keys (e.g. Betfair Exchange non-standard keys).
+        // An undefined key here would cause the entire createMany batch to fail.
+        if (!mappedMarket) continue;
+
         for (const outcome of market.outcomes) {
```

---

## Fix Summary

| Layer | Before | After |
|-------|--------|-------|
| `mapOddsMarket` | No default — unknown keys silently return `undefined` | Default branch returns `undefined` explicitly |
| `_mapOddsSnapshots` | All bookmaker/market/outcome triples inserted, including those with `market: undefined` | Unknown markets skipped; only valid markets reach `CanonicalOddsSnapshot` |
| `insertMany` | Entire batch fails if any record has undefined `market` | No longer reachable — mapper filters at source |

---

## Validation

### TypeScript

```
npx tsc --noEmit
```

**Result:** 0 errors. TypeScript correctly narrows `mappedMarket` to `IngestionOddsMarket` (non-undefined) after the `if (!mappedMarket) continue` guard, so `CanonicalOddsSnapshot.market` remains typed as the non-optional `IngestionOddsMarket` throughout.

### Expected runtime behaviour after fix

- Betfair Exchange records with non-standard market keys are silently skipped at the mapper stage
- All valid records from Pinnacle, Bet365, Unibet, and other bookmakers (with `h2h`/`spreads`/`totals` keys) are inserted normally
- `OddsSnapshot` count resumes growing with each odds-fetch job
- `ValueDetectionService` receives new snapshots and resumes generating `ValueOpportunity` records
- The `odds-fetch failed` counter stops increasing

### Bookmakers affected by skip (Betfair Exchange only)

`betfair_ex_uk` and `betfair_ex_eu` are exchange bookmakers that return exchange-specific market keys. They do not participate in Pinnacle-consensus value detection regardless — value detection requires Pinnacle as the candidate bookmaker and at least two non-Pinnacle bookmakers as consensus. Betfair Exchange odds are not used in the consensus calculation even when ingested, so skipping their non-standard markets has no impact on value detection results.
