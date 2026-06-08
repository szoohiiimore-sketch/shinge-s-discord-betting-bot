# Discord Alert Match Metadata Enhancement

**Date:** 2026-06-08  
**Scope:** Add league name and match start time (UTC + Budapest) to Discord value-bet notifications  

---

## Files Modified

| File | Change |
|---|---|
| `src/discord/discord-notification.service.ts` | Added `league: { select: { name: true } }` to Prisma query; added local time formatting in `formatAlert()`; added league + start time to message |

---

## Data Source

All fields already exist in the current data model — no new database fields, API calls, or schema changes:

| New Field | Source Table | Column | How it was already available |
|---|---|---|---|
| League name | `Match → League` | `league.name` | `ValueOpportunity.match.league` (relation exists in Prisma schema) |
| Match start time (UTC) | `Match` | `match.startTime` | Was not included in the Prisma query but existed in the model |
| Match start time (Budapest) | `Match` | `match.startTime` | `Intl.DateTimeFormat` with `timeZone: 'Europe/Budapest'` |

---

## Implementation

### Prisma Query Change

```diff
 include: {
   match: {
     include: {
       homeTeam: { select: { name: true } },
       awayTeam: { select: { name: true } },
+      league: { select: { name: true } },
     },
   },
 },
```

### `formatAlert()` Type Signature Change

The `match` parameter now expects `startTime` and optional `league`:

```typescript
match: {
  startTime: Date;
  league?: { name: string } | null;
  homeTeam: { name: string };
  awayTeam: { name: string };
};
```

### Message Formatting

```typescript
const localStart = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
  timeZone: 'Europe/Budapest', hour12: false,
}).format(opp.match.startTime).replace(',', '');

// Lines inserted before "Sport:":
opp.match.league?.name ? `**League:** ${opp.match.league.name}` : undefined,
'',
`**Starts:**`,
`${displayTime(opp.match.startTime)}`,
`(${localStart} Budapest)`,
'',
```

`.filter(Boolean)` removes the `undefined` entry when `league?.name` is null/missing.

---

## Before/After

### Before

```
🎯 VALUE BET DETECTED

Sport: Soccer
Match: Ponte Preta vs Cuiabá

Outcome: Ponte Preta
Bookmaker: Pinnacle

Market Probability: 29.2%
Consensus Probability: 31.3%
Odds: 3.42
Fair Odds: 3.19
Edge: +7.2%

Captured: 2026-06-08 15:00 UTC
```

### After

```
🎯 VALUE BET DETECTED

League: Brazil Serie B

Starts:
2026-06-09 19:00 UTC
(2026-06-09 21:00 Budapest)

Sport: Soccer
Match: Ponte Preta vs Cuiabá

Outcome: Ponte Preta
Bookmaker: Pinnacle

Market Probability: 29.2%
Consensus Probability: 31.3%
Odds: 3.42
Fair Odds: 3.19
Edge: +7.2%

Captured: 2026-06-08 15:00 UTC
```

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| League displays correctly | ✅ `**League:** Brazil Serie B` |
| UTC time displays correctly | ✅ `2026-06-09 19:00 UTC` |
| Budapest time displays correctly | ✅ `2026-06-09 21:00 Budapest` |
| Missing league gracefully handled | ✅ `.filter(Boolean)` removes undefined line |
| No schema changes | ✅ |
| No new API calls | ✅ |
| No changes to ingestion | ✅ |
| No changes to value detection | ✅ |

---

## Verdict

**PASS** — Discord value-bet notifications now include league name and match start time in both UTC and Budapest timezones. One file modified. All existing formatting preserved.