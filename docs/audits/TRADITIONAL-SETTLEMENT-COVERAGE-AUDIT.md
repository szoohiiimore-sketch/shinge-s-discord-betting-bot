# Traditional Settlement Coverage Audit

**Audit date:** 2026-06-10

**Audit basis:** Source code only — `src/lib/app/app.ts`, `src/settlement/settlement.worker.ts`, `src/settlement/settlement.service.ts`, `src/discord/daily-summary.worker.ts`, `src/discord/discord-notification.service.ts`, and `src/ingestion/bootstrap/ingestion-scheduler.ts`.

**Authority rule:** Source code is authoritative. This document extends and confirms the gap first identified in PROJECT-KNOWLEDGE-TRANSFER.md §8.

---

## Finding

**34 of 50 configured traditional sport keys are not included in settlement processing. Value opportunities generated for those leagues accumulate indefinitely as unsettled.**

This is confirmed by code, not inferred.

---

## Evidence

### Ingestion coverage — `src/lib/app/app.ts` lines 63–123

`TRADITIONAL_SPORT_CONFIGS` defines all 50 sport keys passed to the scheduler at startup:

- **12 keys at 60-minute polling** — NHL, MLB, WNBA, MLS, 8 ATP/WTA tennis tournaments
- **4 keys at 4-hour polling** — NBA, EPL, Champions League, NCAAF
- **34 keys at 3-hour polling** — soccer expansion leagues (see full list below)

All 50 keys are passed to `scheduleIngestionJobs()`. Every key can produce `OddsSnapshot` rows and, when value is detected, `ValueOpportunity` rows.

### Settlement coverage — `src/settlement/settlement.worker.ts` lines 10–27

`TRADITIONAL_SPORT_KEYS` is a hardcoded list of **16 keys** passed to `SettlementService.settleTraditional()`:

```
icehockey_nhl       baseball_mlb         basketball_wnba     soccer_usa_mls
tennis_atp_wimbledon tennis_atp_us_open   tennis_atp_indian_wells tennis_atp_miami_open
tennis_wta_wimbledon tennis_wta_us_open   tennis_wta_indian_wells tennis_wta_miami_open
basketball_nba      soccer_epl           soccer_uefa_champs_league americanfootball_ncaaf
```

These are the original 16 keys from before the soccer expansion. The 34 expansion keys are absent.

### How settlement works — `src/settlement/settlement.service.ts`

`settleTraditional(sportKeys)` iterates the supplied `sportKeys` array and calls `getScores(sportKey, 3)` for each. Completed events set matched `Match` records to `FINISHED` with a result. After all keys are processed, `_settleUnsettled()` is called once.

`_settleUnsettled()` queries `ValueOpportunity` where `settledAt IS NULL AND match.status = FINISHED`. It has **no sport filter** — it will settle any unsettled opportunity whose match has already been marked `FINISHED`.

The consequence: a match for an expansion league will only reach `FINISHED` if its sport key is passed to `settleTraditional()`. Because those 34 keys are never passed, those matches are never marked `FINISHED`, and `_settleUnsettled()` therefore never reaches their opportunities.

### Daily summary — `src/discord/discord-notification.service.ts` lines 226–290

`notifyDailySummary()` queries settled opportunities from the last 24 hours with no sport filter. It correctly reports whatever has been settled. It does not compensate for the gap — unsettled opportunities from expansion leagues are invisible to the summary.

---

## Root Cause

`TRADITIONAL_SPORT_KEYS` in `settlement.worker.ts` is a static list maintained independently of `TRADITIONAL_SPORT_CONFIGS` in `app.ts`. When the 34 soccer expansion keys were added to `app.ts`, `settlement.worker.ts` was not updated.

The two constants are never compared or derived from a shared source.

---

## Affected Keys (34)

All 34 are 3-hour-polling soccer leagues added in `app.ts`:

| Sport key | Sport group |
|---|---|
| `soccer_brazil_serie_b` | Soccer |
| `soccer_argentina_primera_division` | Soccer |
| `soccer_australia_aleague` | Soccer |
| `soccer_austria_bundesliga` | Soccer |
| `soccer_brazil_campeonato` | Soccer |
| `soccer_belgium_first_div` | Soccer |
| `soccer_chile_campeonato` | Soccer |
| `soccer_china_superleague` | Soccer |
| `soccer_denmark_superliga` | Soccer |
| `soccer_england_league2` | Soccer |
| `soccer_finland_veikkausliiga` | Soccer |
| `soccer_france_ligue_two` | Soccer |
| `soccer_germany_bundesliga2` | Soccer |
| `soccer_germany_bundesliga_women` | Soccer |
| `soccer_germany_dfb_pokal` | Soccer |
| `soccer_germany_liga3` | Soccer |
| `soccer_greece_super_league` | Soccer |
| `soccer_italy_serie_b` | Soccer |
| `soccer_japan_j_league` | Soccer |
| `soccer_korea_kleague1` | Soccer |
| `soccer_league_of_ireland` | Soccer |
| `soccer_mexico_ligamx` | Soccer |
| `soccer_netherlands_eredivisie` | Soccer |
| `soccer_norway_eliteserien` | Soccer |
| `soccer_poland_ekstraklasa` | Soccer |
| `soccer_portugal_primeira_liga` | Soccer |
| `soccer_russia_premier_league` | Soccer |
| `soccer_spain_segunda_division` | Soccer |
| `soccer_saudi_arabia_pro_league` | Soccer |
| `soccer_spl` | Soccer |
| `soccer_sweden_allsvenskan` | Soccer |
| `soccer_sweden_superettan` | Soccer |
| `soccer_switzerland_superleague` | Soccer |
| `soccer_turkey_super_league` | Soccer |

---

## Downstream Impact

| Subsystem | Impact |
|---|---|
| `ValueOpportunity` records | Accumulate with `settledAt = null` indefinitely for all 34 leagues |
| `Match` records | Remain in non-`FINISHED` status indefinitely for completed matches in those leagues |
| `/roi`, `/paper-bankroll`, `/best-sports` | Exclude all expansion-league results — reported ROI understates true paper performance |
| Daily summary | Same exclusion — summary reflects only the 16 settled leagues |
| Discord settlement notifications | Never fire for expansion leagues |
| The Odds API quota | Score-refresh calls for the 34 keys are not made, so there is no quota waste from the missing keys |

---

## Fix

The minimal fix is to add the 34 missing keys to `TRADITIONAL_SPORT_KEYS` in `src/settlement/settlement.worker.ts`.

The durable fix is to eliminate the independent list entirely. `settleTraditional()` accepts any `readonly string[]`. The settlement worker could be constructed with the same `TRADITIONAL_SPORT_CONFIGS` array used by the scheduler, extracting `sportKey` from each entry, so the two can never diverge again.

The settlement service's `_settleUnsettled()` method is already sport-agnostic — no logic changes are required there.

---

## Settlement Logic Correctness (for covered keys)

For the 16 keys that are covered, the settlement logic is structurally correct:

- Scores are fetched with `daysFrom=3`, which limits settlement to matches completed within the last three days. Matches completed more than three days ago may never be settled unless manually triggered.
- `determineBetOutcome()` uses exact string matching with a partial-match fallback. Unknown outcomes default to `LOSS`. This is a data-quality risk but not a coverage gap.
- `_settleUnsettled()` is idempotent — re-running settlement for an already-finished match updates nothing (skipped by `settledAt IS NULL` filter).

---

## Summary

The audit document PROJECT-KNOWLEDGE-TRANSFER.md §8 correctly identified this gap. This audit confirms it in code: **34 of 50 ingested sport keys have no settlement path**. The cause is a single hardcoded list that was not updated when the expansion leagues were added. The fix is contained to one file.
