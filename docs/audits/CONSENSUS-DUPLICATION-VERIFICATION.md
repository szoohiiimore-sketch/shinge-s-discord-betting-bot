# Consensus Duplication Verification Audit

**Audit date:** 2026-06-10

**Audit basis:** Full source trace of the pipeline from API request to edge calculation.
Files inspected:

- `src/ingestion/services/odds-snapshot-ingestion.service.ts`
- `src/ingestion/mappers/odds-api-event.mapper.ts`
- `src/ingestion/mappers/mapper.utils.ts`
- `src/integrations/the-odds-api/types.ts`
- `src/integrations/the-odds-api/the-odds-api.client.ts`
- `src/ingestion/repositories/odds-snapshot.repository.ts`
- `src/ingestion/contracts/source.types.ts`
- `src/ingestion/contracts/canonical.types.ts`
- `src/value-detection/value-detection.service.ts`
- `prisma/schema.prisma`

**Objective:** Determine whether the same bookmaker can appear multiple times in a consensus calculation, whether this inflates edge values, and how it could happen.

---

## Findings Summary

| Hypothesis | Verdict |
|---|---|
| h2h and h2h_alt both map to H2H, polluting consensus | **REJECTED — impossible by design** |
| Same bookmaker can appear twice via is_main duplication | **CONFIRMED — theoretically possible, no guard exists** |
| Minimum-consensus check counts rows, not unique bookmakers | **CONFIRMED — by design, exploitable by the above** |

---

## Finding 1 — REJECTED: h2h vs h2h_alt Duplication

### The Hypothesis

Previous audit language suggested that The Odds API might return both `h2h` and `h2h_alt` markets, that both could map to the internal `H2H` market, and that a bookmaker could therefore appear twice in the consensus set.

### Why It Cannot Happen

There are three independent, layered defenses that prevent this, in order of execution:

#### Guard 1 — API request specifies `markets: 'h2h'` only

`src/ingestion/services/odds-snapshot-ingestion.service.ts` lines 92–97:

```typescript
const rawEvents = await this._oddsApiClient.getOdds(sportKey, {
  eventIds: apiEventIds.join(','),
  regions: 'eu,us,uk',
  markets: 'h2h',
  oddsFormat: 'decimal',
});
```

The `markets` parameter is a filter. The Odds API only returns markets that are explicitly requested. `h2h_alt` is never in the response because it was never asked for.

#### Guard 2 — `OddsMarketKey` type does not include `h2h_alt`

`src/integrations/the-odds-api/types.ts` line 17:

```typescript
export type OddsMarketKey = 'h2h' | 'spreads' | 'totals';
```

`h2h_alt` is not in this union. The `Market` interface uses this type for its `key` field. Even if the API returned it at runtime, TypeScript's union type provides a compile-time signal.

#### Guard 3 — `mapOddsMarket()` returns `undefined` for any unrecognised key

`src/ingestion/mappers/mapper.utils.ts` lines 101–108:

```typescript
export function mapOddsMarket(key: OddsMarketKey): IngestionOddsMarket | undefined {
  switch (key) {
    case 'h2h':     return 'H2H';
    case 'spreads': return 'SPREADS';
    case 'totals':  return 'TOTALS';
    default:        return undefined;
  }
}
```

`src/ingestion/mappers/odds-api-event.mapper.ts` lines 110–114:

```typescript
const mappedMarket = mapOddsMarket(market.key);
if (!mappedMarket) continue;
```

Any market key outside the known set is silently discarded before snapshot creation. `h2h_alt` would produce `undefined` here and be skipped.

### Conclusion

The `h2h` vs `h2h_alt` hypothesis is **definitively rejected**. Even if The Odds API were to return `h2h_alt` data in a future version, all three guards would prevent it from entering the `OddsSnapshot` table. The assertion in the prior audit was based on a hypothetical API concern that does not apply to this implementation.

---

## Finding 2 — CONFIRMED: Bookmaker Duplication via `is_main` Field

### The Mechanism

The Odds API `Market` object (defined at `src/integrations/the-odds-api/types.ts` line 62–67):

```typescript
export interface Market {
  readonly key: OddsMarketKey;
  readonly last_update: string;
  readonly outcomes: readonly Outcome[];
  readonly is_main: boolean | null;
}
```

A single bookmaker's response can contain multiple `Market` entries with the same `key` (`h2h`), distinguished only by `is_main`. The `is_main` field marks whether a market is the primary line (`true`) or an alternate version (`null` / `false`). The canonical example is Betfair Exchange, which can return both a standard H2H and a lay-market equivalent as separate market entries within the same bookmaker block.

### The Complete Code Path

**Step 1 — All markets are iterated without an `is_main` filter:**

`src/ingestion/mappers/odds-api-event.mapper.ts` lines 108–129:

```typescript
for (const bookmaker of bookmakers) {
  for (const market of bookmaker.markets) {      // ← ALL markets for this bookmaker
    const mappedMarket = mapOddsMarket(market.key);
    if (!mappedMarket) continue;                  // ← only unknown keys are skipped

    for (const outcome of market.outcomes) {
      snapshots.push({
        matchExternalId,
        bookmaker: bookmaker.key,
        market: mappedMarket,
        outcome: outcome.name,
        price: outcome.price,
        isMain: market.is_main ?? false,          // ← stored, but not used to filter
        isLive,
        capturedAt,
      });
    }
  }
}
```

If bookmaker `bet365` returns two entries with `key: 'h2h'` — one with `is_main: true` and one with `is_main: false` — both produce a `CanonicalOddsSnapshot` row with `market: 'H2H'` and the same `bookmaker: 'bet365'`, same `capturedAt`.

**Step 2 — Both rows are inserted without deduplication:**

`src/ingestion/repositories/odds-snapshot.repository.ts` lines 59–71:

```typescript
const data = inputs.map(snapshot => ({
  matchId: matchIdMap.get(snapshot.matchExternalId)!,
  bookmaker: snapshot.bookmaker,
  market: snapshot.market,
  outcome: snapshot.outcome,
  price: snapshot.price,
  isMain: snapshot.isMain,
  isLive: snapshot.isLive,
  capturedAt: snapshot.capturedAt,
}));
const result = await this._prisma.oddsSnapshot.createMany({ data });
```

There is no uniqueness constraint on `(matchId, bookmaker, market, outcome, capturedAt)` in `prisma/schema.prisma`. Both rows are inserted. The schema confirms this — `OddsSnapshot` has only a primary-key index and two performance indexes, not a uniqueness constraint on any business-key combination.

**Step 3 — Value detection queries all H2H non-live rows, no `isMain` filter:**

`src/value-detection/value-detection.service.ts` lines 56–75:

```typescript
const snapshots = await this._prisma.oddsSnapshot.findMany({
  where: {
    match: { externalId: { in: matchExternalIds as string[] } },
    market: 'H2H',
    isLive: false,
    // ← no isMain filter
  },
  ...
});
```

Both the `is_main: true` and `is_main: false` rows are returned. Both pass the timestamp filter (same `capturedAt`). Both are included in `consensusSnaps`.

**Step 4 — Consensus calculation averages all rows including duplicates:**

`src/value-detection/value-detection.service.ts` lines 122–141:

```typescript
const pinnacleSnaps = outcomeSnapshots.filter(s => s.bookmaker === CANDIDATE_BOOKMAKER);
const consensusSnaps = outcomeSnapshots.filter(s => s.bookmaker !== CANDIDATE_BOOKMAKER);

if (consensusSnaps.length < MIN_CONSENSUS_BOOKMAKERS) { // ← counts rows, not unique bookmakers
  ...
}

const consensusOdds = consensusSnaps.map(s => toNumber(s.price));
const impliedProbs = consensusOdds.map(o => 1 / o);
const consensusProbability = impliedProbs.reduce((a, b) => a + b, 0) / impliedProbs.length;
```

`MIN_CONSENSUS_BOOKMAKERS = 2` is satisfied by two rows from the same bookmaker. The duplicate rows contribute duplicate probability values to the mean.

**Step 5 — `consensusBookmakers` stores the duplicated names:**

`src/value-detection/value-detection.service.ts` line 234:

```typescript
consensusBookmakers: consensusSnaps.map(s => s.bookmaker),
```

The stored `consensusBookmakers` array would contain the duplicated bookmaker name: e.g. `['bet365', 'bet365']` instead of `['bet365']`. This is observable in the database.

---

## Finding 3 — CONFIRMED: Minimum Consensus Check Counts Rows, Not Unique Bookmakers

This is a direct consequence of Finding 2. The guard at line 131:

```typescript
if (consensusSnaps.length < MIN_CONSENSUS_BOOKMAKERS) {
```

counts the number of `OddsSnapshot` rows in the consensus set, not the number of distinct bookmakers. With one bookmaker appearing twice, `consensusSnaps.length === 2` passes the minimum even though only one bookmaker's information is actually being used.

---

## Impact Analysis

### Scenario: Two True Unique Bookmakers, One Duplicated

Inputs:
- Bet365 appears twice (rows for `is_main: true` and `is_main: false`, both `h2h`)
- Unibet appears once
- Pinnacle odds: `2.20`

**Without duplication (2 rows, 2 bookmakers):**

| Bookmaker | Price | Implied prob |
|---|---|---|
| Bet365 | 2.00 | 0.5000 |
| Unibet | 2.10 | 0.4762 |

- Consensus probability: (0.5000 + 0.4762) / 2 = **0.4881**
- Fair odds: 1 / 0.4881 = **2.049**
- Edge: (2.20 / 2.049 − 1) × 100 = **+7.4%**

**With duplication (3 rows, Bet365 counted twice):**

| Bookmaker | Price | Implied prob |
|---|---|---|
| Bet365 | 2.00 | 0.5000 |
| Bet365 | 2.00 | 0.5000 |
| Unibet | 2.10 | 0.4762 |

- Consensus probability: (0.5000 + 0.5000 + 0.4762) / 3 = **0.4921**
- Fair odds: 1 / 0.4921 = **2.033**
- Edge: (2.20 / 2.033 − 1) × 100 = **+8.2%**

**Impact: +0.8 percentage points overstatement.** The inflated consensus probability pulls fair odds down, making Pinnacle appear more generous than it is. The effect is proportional to how many duplicate rows exist and how much the duplicated bookmaker differs from other consensus books.

### Scenario: Single True Bookmaker, Duplicated Twice

If Bet365 is the only non-Pinnacle bookmaker and appears twice, the minimum consensus check (`>= 2`) is satisfied by two identical rows from the same book:

| Bookmaker | Price | Implied prob |
|---|---|---|
| Bet365 | 2.00 | 0.5000 |
| Bet365 | 2.00 | 0.5000 |

- Consensus probability: (0.5000 + 0.5000) / 2 = **0.5000**
- Fair odds: **2.000**

This produces the same result as a single-bookmaker consensus — numerically harmless in this case because the values are identical. However, it would also generate a `ValueOpportunity` when the true consensus condition (at least two genuinely independent bookmakers) was not met.

### False Positive Risk

If the duplicated bookmaker has a price that makes Pinnacle look good relative to a skewed consensus, a false alert could fire. This is most concerning when only one real consensus book is available and its duplication satisfies the two-row minimum.

---

## Probability of Occurrence in Practice

The trigger requires The Odds API to return the same bookmaker with two `h2h` market entries (different `is_main` values) for the same event. This is uncommon for standard bookmakers. The most likely candidate is Betfair Exchange, which operates differently from fixed-odds books and does appear in `eu` region responses.

The `eu,us,uk` region request includes Betfair. If Betfair returns a standard H2H and a lay-market H2H under the same `h2h` key, both would pass through. Whether this actually occurs in practice cannot be determined from static analysis — it depends on The Odds API's current Betfair formatting, which changes over time.

The risk is real but low-probability in the current configuration. It has not been confirmed to have occurred in the database.

---

## Severity Assessment

**MEDIUM**

The h2h / h2h_alt hypothesis is rejected and carries zero risk. However, the `is_main` duplication path is real code that exists in production. It requires no code change on The Odds API side to activate — it depends only on how a bookmaker formats its response for a given event. The impact when it triggers is inflated edge values and potentially false alerts. The minimum-consensus check does not protect against it. The duplicated bookmaker names would be visible in `consensusBookmakers` arrays stored on settled `ValueOpportunity` records.

The severity is MEDIUM rather than HIGH because:
- Triggering requires a specific API response structure that is uncommon for H2H markets
- The magnitude of inflation in typical cases is under 1–2 percentage points, not an order-of-magnitude error
- The 100% edge cap (`MAX_EDGE_THRESHOLD_PCT`) would reject extreme values

---

## Recommended Fix

A single additional filter in the value detection query prevents the duplication entirely:

```typescript
const snapshots = await this._prisma.oddsSnapshot.findMany({
  where: {
    match: { externalId: { in: matchExternalIds as string[] } },
    market: 'H2H',
    isLive: false,
    isMain: true,   // ← add this
  },
  ...
});
```

This restricts consensus input to primary-line H2H rows only, which is what the consensus calculation intends.

An alternative — deduplicating by bookmaker within `consensusSnaps` before calculating the mean — would also work and is more robust against future duplication sources:

```typescript
const seen = new Set<string>();
const deduplicatedConsensus = consensusSnaps.filter(s => {
  if (seen.has(s.bookmaker)) return false;
  seen.add(s.bookmaker);
  return true;
});
```

The `isMain: true` filter is the simpler change. The deduplication approach is more defensive but changes the consensus semantics slightly (it would use only the first snapshot per bookmaker within a batch, which may not always be the main line).

**Classification: Exact fix required.** The issue is real code with no guard. The fix is a one-line filter. The recommendation is to add `isMain: true` to the value detection query.

---

## Appendix: Full Pipeline Summary

| Stage | File | Relevant behavior |
|---|---|---|
| API request | `odds-snapshot-ingestion.service.ts:92` | Requests `markets: 'h2h'` only — `h2h_alt` never requested |
| Market type | `types.ts:17` | `OddsMarketKey` does not include `h2h_alt` |
| Market mapping | `mapper.utils.ts:101` | Unknown keys return `undefined` and are skipped |
| `is_main` handling | `odds-api-event.mapper.ts:117` | Stored in snapshot but not used as a filter |
| Persistence | `odds-snapshot.repository.ts:71` | No uniqueness constraint — all rows inserted |
| Value detection query | `value-detection.service.ts:56` | Filters `market: H2H, isLive: false` — no `isMain` filter |
| Consensus minimum | `value-detection.service.ts:131` | Counts rows, not unique bookmakers |
| Consensus calculation | `value-detection.service.ts:154` | Arithmetic mean of all non-Pinnacle rows |
| Stored bookmakers | `value-detection.service.ts:234` | All bookmaker names including duplicates |
