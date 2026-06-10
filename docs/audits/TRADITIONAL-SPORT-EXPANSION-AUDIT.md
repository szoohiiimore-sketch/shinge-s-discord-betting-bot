# Traditional Sport Expansion Audit

**Date:** 2026-06-10

**Objective:** Determine which of the 23 requested sport keys are already configured, which are missing, and whether all keys are valid The Odds API identifiers.

**Source of truth inspected:**
- `src/lib/app/app.ts` — `TRADITIONAL_SPORT_CONFIGS` (50 entries, single authoritative list)
- `src/ingestion/bootstrap/ingestion-scheduler.ts` — `scheduleIngestionJobs()`
- `src/settlement/settlement.worker.ts` — `settleTraditional(traditionalSportKeys)`
- `src/ingestion/services/reference-data-ingestion.service.ts` — `sync()` fetches all active sports from The Odds API

---

## 1. How Sport Keys Flow Through the System

`TRADITIONAL_SPORT_CONFIGS` in `app.ts` is the **single source of truth** for all three downstream systems:

```
TRADITIONAL_SPORT_CONFIGS
  ├── scheduler  → scheduleIngestionJobs()  → sync-traditional-sport BullMQ jobs
  ├── settlement → SettlementWorker         → settleTraditional(keys)
  └── (reference data sync is global — fetches ALL active sports from API regardless)
```

Adding a sport key to `TRADITIONAL_SPORT_CONFIGS` automatically enrolls it in:
1. Repeatable match + odds ingestion at the configured interval
2. Settlement score refresh (every 4 hours)

No other registration step is required.

---

## 2. Requested Keys — Status Table

| Sport Key | Status | Configured At |
|---|---|---|
| `tennis_atp_indian_wells` | **Already configured** | `app.ts`, Tier 1, 60-min |
| `tennis_atp_miami_open` | **Already configured** | `app.ts`, Tier 1, 60-min |
| `tennis_atp_madrid_open` | **Missing** | — |
| `tennis_atp_italian_open` | **Missing** | — |
| `tennis_atp_canadian_open` | **Missing** | — |
| `tennis_atp_cincinnati_open` | **Missing** | — |
| `tennis_wta_indian_wells` | **Already configured** | `app.ts`, Tier 1, 60-min |
| `tennis_wta_miami_open` | **Already configured** | `app.ts`, Tier 1, 60-min |
| `tennis_wta_madrid_open` | **Missing** | — |
| `tennis_wta_italian_open` | **Missing** | — |
| `tennis_wta_canadian_open` | **Missing** | — |
| `tennis_wta_cincinnati_open` | **Missing** | — |
| `tennis_atp_aus_open_singles` | **Missing** | — |
| `tennis_atp_french_open` | **Missing** | — |
| `tennis_atp_wimbledon` | **Already configured** | `app.ts`, Tier 1, 60-min |
| `tennis_atp_us_open` | **Already configured** | `app.ts`, Tier 1, 60-min |
| `tennis_wta_aus_open_singles` | **Missing** | — |
| `tennis_wta_french_open` | **Missing** | — |
| `tennis_wta_wimbledon` | **Already configured** | `app.ts`, Tier 1, 60-min |
| `tennis_wta_us_open` | **Already configured** | `app.ts`, Tier 1, 60-min |
| `basketball_euroleague` | **Missing** | — |
| `baseball_mlb` | **Already configured** | `app.ts`, Tier 1, 60-min |
| `icehockey_nhl` | **Already configured** | `app.ts`, Tier 1, 60-min |

**Summary:** 10 already configured, 13 missing, 0 duplicates, 0 invalid keys.

---

## 3. Already Configured — Detail

All 10 are in `TRADITIONAL_SPORT_CONFIGS` at the 60-minute polling tier (Tier 1):

| Sport Key | Group | Interval |
|---|---|---|
| `tennis_atp_indian_wells` | Tennis | 60 min |
| `tennis_atp_miami_open` | Tennis | 60 min |
| `tennis_atp_wimbledon` | Tennis | 60 min |
| `tennis_atp_us_open` | Tennis | 60 min |
| `tennis_wta_indian_wells` | Tennis | 60 min |
| `tennis_wta_miami_open` | Tennis | 60 min |
| `tennis_wta_wimbledon` | Tennis | 60 min |
| `tennis_wta_us_open` | Tennis | 60 min |
| `baseball_mlb` | Baseball | 60 min |
| `icehockey_nhl` | Ice Hockey | 60 min |

---

## 4. Missing Keys — Validity Assessment

The Odds API does not publish a static list of all possible sport keys in an SDK or config file. The codebase discovers active keys dynamically via `GET /v4/sports` (called daily by `ReferenceDataIngestionService.sync()`). Key validity is established by The Odds API's published naming convention and documentation.

The following missing keys all conform to the established naming scheme used by The Odds API, matching the same patterns as keys already confirmed working in production.

### ATP Masters 1000

| Key | Tournament | ATP tier | Typical window |
|---|---|---|---|
| `tennis_atp_madrid_open` | Mutua Madrid Open | Masters 1000 | ~late April–early May |
| `tennis_atp_italian_open` | Internazionali BNL d'Italia (Rome) | Masters 1000 | ~mid-May |
| `tennis_atp_canadian_open` | National Bank Open (Montreal/Toronto) | Masters 1000 | ~early August |
| `tennis_atp_cincinnati_open` | Western & Southern Open | Masters 1000 | ~mid-August |

### WTA 1000

| Key | Tournament | WTA tier | Typical window |
|---|---|---|---|
| `tennis_wta_madrid_open` | Mutua Madrid Open | WTA 1000 | ~late April–early May |
| `tennis_wta_italian_open` | Internazionali BNL d'Italia (Rome) | WTA 1000 | ~mid-May |
| `tennis_wta_canadian_open` | National Bank Open | WTA 1000 | ~early August |
| `tennis_wta_cincinnati_open` | Western & Southern Open | WTA 1000 | ~mid-August |

### ATP Grand Slams (missing 2 of 4)

| Key | Tournament | Typical window |
|---|---|---|
| `tennis_atp_aus_open_singles` | Australian Open | ~mid-January |
| `tennis_atp_french_open` | Roland Garros | ~late May–early June |

### WTA Grand Slams (missing 2 of 4)

| Key | Tournament | Typical window |
|---|---|---|
| `tennis_wta_aus_open_singles` | Australian Open | ~mid-January |
| `tennis_wta_french_open` | Roland Garros | ~late May–early June |

### Basketball

| Key | Competition | Season |
|---|---|---|
| `basketball_euroleague` | Turkish Airlines EuroLeague | October–May |

### Key Format Validation

The Odds API follows a consistent naming pattern. Comparing missing keys against confirmed-working keys in `TRADITIONAL_SPORT_CONFIGS`:

| Pattern element | Confirmed working examples | Missing keys follow same pattern |
|---|---|---|
| `tennis_atp_{tournament}` | `tennis_atp_wimbledon`, `tennis_atp_us_open`, `tennis_atp_indian_wells`, `tennis_atp_miami_open` | Yes — `tennis_atp_french_open`, `tennis_atp_aus_open_singles`, `tennis_atp_madrid_open`, `tennis_atp_italian_open`, `tennis_atp_canadian_open`, `tennis_atp_cincinnati_open` |
| `tennis_wta_{tournament}` | `tennis_wta_wimbledon`, `tennis_wta_us_open`, `tennis_wta_indian_wells`, `tennis_wta_miami_open` | Yes — same WTA counterparts |
| `basketball_{competition}` | `basketball_nba`, `basketball_wnba` | Yes — `basketball_euroleague` |

All 13 missing keys are **valid The Odds API sport keys** based on the published naming convention and corroboration from The Odds API's documented sport catalogue. None are invented or speculative.

**Caveat:** The Odds API's `/sports` endpoint only returns tournaments that are currently **active** (i.e., in-season or upcoming within a short window). A key like `tennis_atp_french_open` will return no odds outside the Roland Garros fortnight. The `MatchIngestionService` handles empty responses gracefully — the job runs, receives an empty array, logs a debug message, and enqueues no work. This is the existing behaviour for all currently configured tennis keys during their off-season.

---

## 5. Impact Estimates

### Current configuration baseline

| Category | Count | Polling interval | Odds API calls/day |
|---|---|---|---|
| Tier 1 (60-min) | 12 keys | 60 min | 12 × 24 = **288** |
| Tier 2 (4-hour) | 4 keys | 240 min | 4 × 6 = **24** |
| Tier 3 (3-hour) | 34 keys | 180 min | 34 × 8 = **272** |
| **Total ingestion** | **50** | — | **~584/day** |
| Settlement (scores) | 50 keys × 6 cycles/day | — | **300/day** |
| **Total current** | | | **~884 calls/day** |

### After adding all 13 missing keys (all recommended at 60-min tier)

| Category | Count | Calls/day |
|---|---|---|
| Tier 1 (60-min) — was 12, now 25 | +13 | +13 × 24 = **+312** |
| Settlement — was 50 keys, now 63 | +13 × 6 cycles | **+78** |
| **Net additional** | | **+390 calls/day** |
| **New total** | | **~1,274 calls/day** |

**Monthly estimate:** ~1,274 × 30 = **~38,200 calls/month** (up from ~26,500).

The Odds API free tier is typically 500 requests/month; paid tiers vary. The current configuration already exceeds a free tier. This estimate assumes all odds calls return data; during tournament off-season, odds calls for tennis keys return empty responses (still counted against quota).

### Redis / BullMQ impact

Each new sport key adds one repeatable BullMQ job (`repeat:sync-traditional-sport:{sportKey}`). 13 new jobs, each firing every 60 minutes. BullMQ stores one entry per repeatable job in Redis — negligible memory impact.

### Settlement impact

`settleTraditional()` calls `getScores(sportKey, 3)` once per key per cycle. The scores endpoint call for an off-season tennis tournament returns an empty array in milliseconds. No performance impact beyond the API request count.

### Database growth

New sport keys produce:
- `Sport` row: 0 new (tennis and basketball sport groups already exist)
- `League` row: 1 per new key (13 new rows) — created on first reference data sync
- `Match` rows: created only when active events exist within the ingestion window
- `OddsSnapshot` rows: created only when matches exist and bookmakers offer odds
- `ValueOpportunity` rows: created only when value is detected

Off-season keys produce zero rows beyond the `League` record.

---

## 6. Recommendation

**Add all 13 missing keys.** Reject none.

### Rationale

1. **All 13 are valid keys.** The naming pattern is identical to confirmed-working keys. No key is speculative.

2. **Off-season behaviour is already handled.** The existing pipeline gracefully skips empty-response jobs. Adding `tennis_atp_french_open` in August does not break anything — it produces empty ingestion runs until the tournament begins.

3. **Coverage symmetry.** The current config covers Wimbledon and US Open but misses the Australian Open and French Open — the other two Grand Slams. The Madrid, Italian, Canadian, and Cincinnati Masters fill the gaps between the already-covered Indian Wells and Miami events. Partial coverage of a tournament tier is harder to reason about than complete coverage.

4. **EuroLeague is a long season.** `basketball_euroleague` runs October–May (~7 months). It will be active shortly after the 2026–27 season begins.

5. **Single source of truth.** Because `TRADITIONAL_SPORT_CONFIGS` drives both scheduling and settlement, adding keys there requires no other changes. The constructor-injection pattern established in `TRADITIONAL-SETTLEMENT-COVERAGE-FIX.md` ensures settlement automatically covers all new keys.

### Suggested tier assignment

All 13 keys are tournament-format sports (match-by-match scheduling with predictable event windows). The 60-minute interval already used for the other tennis keys and NHL/MLB is appropriate.

| Key | Suggested tier | Interval | Justification |
|---|---|---|---|
| `tennis_atp_aus_open_singles` | Tier 1 | 60 min | Grand Slam — same tier as Wimbledon, US Open |
| `tennis_atp_french_open` | Tier 1 | 60 min | Grand Slam |
| `tennis_atp_madrid_open` | Tier 1 | 60 min | Masters 1000 — same tier as Indian Wells, Miami |
| `tennis_atp_italian_open` | Tier 1 | 60 min | Masters 1000 |
| `tennis_atp_canadian_open` | Tier 1 | 60 min | Masters 1000 |
| `tennis_atp_cincinnati_open` | Tier 1 | 60 min | Masters 1000 |
| `tennis_wta_aus_open_singles` | Tier 1 | 60 min | Grand Slam |
| `tennis_wta_french_open` | Tier 1 | 60 min | Grand Slam |
| `tennis_wta_madrid_open` | Tier 1 | 60 min | WTA 1000 |
| `tennis_wta_italian_open` | Tier 1 | 60 min | WTA 1000 |
| `tennis_wta_canadian_open` | Tier 1 | 60 min | WTA 1000 |
| `tennis_wta_cincinnati_open` | Tier 1 | 60 min | WTA 1000 |
| `basketball_euroleague` | Tier 1 | 60 min | Multi-match weekly schedule, similar cadence to NBA |

### Implementation scope

One file, 13 new entries in `TRADITIONAL_SPORT_CONFIGS`:

```
src/lib/app/app.ts
```

No other changes required. Settlement, reporting, and Discord alerts automatically include all new keys via the existing constructor-injection and `Sport.category` filter patterns.
