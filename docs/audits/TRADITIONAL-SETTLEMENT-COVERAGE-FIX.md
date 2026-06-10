# Traditional Settlement Coverage Fix

**Fix date:** 2026-06-10

**Audit basis:** TRADITIONAL-SETTLEMENT-COVERAGE-AUDIT.md (confirms the gap) and source code for settlement, ingestion bootstrap, and application startup.

---

## Problem Statement

`SettlementWorker` held a hardcoded `TRADITIONAL_SPORT_KEYS` array of 16 sport keys. `app.ts` configures 50 traditional sport keys for ingestion. The 34 soccer expansion keys added at ingestion time were never added to the settlement list, so matches in those leagues were never marked `FINISHED` and their `ValueOpportunity` records accumulated as permanently unsettled.

---

## Files Modified

| File | Change |
|---|---|
| `src/settlement/settlement.worker.ts` | Removed hardcoded `TRADITIONAL_SPORT_KEYS`; added `traditionalSportKeys: readonly string[]` constructor parameter |
| `src/ingestion/bootstrap/ingestion-dependencies.ts` | Added `traditionalSportKeys: readonly string[]` parameter to `createIngestionDependencies`; passed to `SettlementWorker` constructor |
| `src/lib/app/app.ts` | Derived settlement keys from `TRADITIONAL_SPORT_CONFIGS.map(c => c.sportKey)` and passed to `createIngestionDependencies` |
| `src/scripts/validate-esports-pipeline.ts` | Fixed pre-existing TypeScript error: `ValueDetectionService` was called with 3 arguments; added missing `maxAlertOdds` argument (`3.0`, matching production default) |

---

## Implementation Detail

### Before

`settlement.worker.ts` owned a module-level constant that was never updated when ingestion was expanded:

```typescript
const TRADITIONAL_SPORT_KEYS: readonly string[] = [
  'icehockey_nhl',
  'baseball_mlb',
  // ... 14 more — total 16
];

export class SettlementWorker {
  constructor(service, notificationService, logger) { ... }

  async process(_job) {
    await this._service.settleTraditional(TRADITIONAL_SPORT_KEYS); // always 16 keys
  }
}
```

`app.ts` defined and passed `TRADITIONAL_SPORT_CONFIGS` (50 keys) only to the scheduler:

```typescript
const ingestionDeps = createIngestionDependencies(config, prisma, redis, logger);
// SettlementWorker constructed inside with no sport-key input
```

### After

`SettlementWorker` no longer owns the sport key list. It accepts it at construction time:

```typescript
export class SettlementWorker {
  private readonly _traditionalSportKeys: readonly string[];

  constructor(
    service: SettlementService,
    notificationService: DiscordNotificationService,
    logger: Logger,
    traditionalSportKeys: readonly string[],
  ) {
    this._traditionalSportKeys = traditionalSportKeys;
  }

  async process(_job) {
    await this._service.settleTraditional(this._traditionalSportKeys); // all 50 keys
  }
}
```

`app.ts` derives the settlement keys from the same array used for scheduling:

```typescript
const ingestionDeps = createIngestionDependencies(
  this._config,
  this._deps.prisma!,
  this._deps.redis!,
  this._logger,
  TRADITIONAL_SPORT_CONFIGS.map(c => c.sportKey), // derived from single source
);
```

`createIngestionDependencies` threads it through to the worker:

```typescript
const settlementWorker = new SettlementWorker(
  settlementService,
  discordNotificationService,
  logger,
  traditionalSportKeys,
);
```

`TRADITIONAL_SPORT_CONFIGS` in `app.ts` is now the single authoritative list for both scheduling and settlement. Adding or removing a sport key in one place automatically applies to both.

---

## Settlement Coverage: Before vs. After

### Before: 16 keys

```
icehockey_nhl           baseball_mlb            basketball_wnba         soccer_usa_mls
tennis_atp_wimbledon    tennis_atp_us_open      tennis_atp_indian_wells  tennis_atp_miami_open
tennis_wta_wimbledon    tennis_wta_us_open      tennis_wta_indian_wells  tennis_wta_miami_open
basketball_nba          soccer_epl              soccer_uefa_champs_league americanfootball_ncaaf
```

### After: 50 keys (all 16 above plus the 34 expansion keys)

```
soccer_brazil_serie_b           soccer_argentina_primera_division  soccer_australia_aleague
soccer_austria_bundesliga       soccer_brazil_campeonato           soccer_belgium_first_div
soccer_chile_campeonato         soccer_china_superleague           soccer_denmark_superliga
soccer_england_league2          soccer_finland_veikkausliiga       soccer_france_ligue_two
soccer_germany_bundesliga2      soccer_germany_bundesliga_women    soccer_germany_dfb_pokal
soccer_germany_liga3            soccer_greece_super_league         soccer_italy_serie_b
soccer_japan_j_league           soccer_korea_kleague1              soccer_league_of_ireland
soccer_mexico_ligamx            soccer_netherlands_eredivisie      soccer_norway_eliteserien
soccer_poland_ekstraklasa       soccer_portugal_primeira_liga      soccer_russia_premier_league
soccer_spain_segunda_division   soccer_saudi_arabia_pro_league     soccer_spl
soccer_sweden_allsvenskan       soccer_sweden_superettan           soccer_switzerland_superleague
soccer_turkey_super_league
```

---

## Validation Results

### TypeScript build — `npx tsc --noEmit`

**Before changes:** 1 error

```
src/scripts/validate-esports-pipeline.ts(356,31): error TS2554: Expected 4 arguments, but got 3.
```

This was a pre-existing error unrelated to settlement coverage (missing `maxAlertOdds` argument in the validation script). It was fixed as part of this change set.

**After changes:** 0 errors

---

## Existing Behavior Unchanged

- `SettlementService.settleTraditional()` signature and logic: unchanged
- `SettlementService._settleUnsettled()`: unchanged — it has no sport filter and already settles all unsettled opportunities on `FINISHED` matches
- All ROI calculations, Discord notifications, value detection, and database schema: unchanged
- Esports settlement path: unchanged
- Settlement frequency (every 4 hours): unchanged
- The Odds API `daysFrom=3` lookback window: unchanged — this remains a separate operational consideration (matches completed more than 3 days ago may still not settle)

---

## Risk Assessment

| Risk | Likelihood | Severity | Notes |
|---|---|---|---|
| Expanded API quota consumption | Certain | Low | Settlement now calls `getScores()` for 50 keys instead of 16. The scores endpoint counts against The Odds API quota. The settlement job runs every 4 hours — 34 additional score requests per cycle. At ~8,736 additional requests per month this should be within most plan allocations, but it should be monitored against the active API plan. |
| Backlog of previously unsettled opportunities | Certain | Low | All pre-existing unsettled `ValueOpportunity` rows for expansion-league matches will be settled on the next run if their matches are within the 3-day score window. Matches older than 3 days remain unsettled unless manually resolved. |
| Score data availability | Low | Low | The Odds API must have score data for all 50 configured keys. Keys for inactive competitions return empty arrays and log a warning — existing behavior, unchanged. |
| Constructor signature change | None | None | `SettlementWorker` has one call site (`createIngestionDependencies`). TypeScript enforces the new signature. There are no test files. |

---

## Residual Limitations (Not Addressed by This Fix)

These were identified in TRADITIONAL-SETTLEMENT-COVERAGE-AUDIT.md and remain unchanged:

- The Odds API scores endpoint uses `daysFrom=3`. Matches completed more than 3 days ago will not be settled by the automatic settlement cycle.
- The traditional sport list remains duplicated in the `/force-ingestion` Discord command handler (which is separate from the scheduler and settlement). This is a maintenance risk but does not affect settlement correctness.
- PandaScore past-match settlement is not paginated.
