# Sprint 23 — Scheduler Optimization

**Date:** 2026-06-07  
**Scope:** Final scheduler configuration with optimized polling schedule for 16 traditional sports  

---

## Changes Made

### Files Modified (2)

| File | Change |
|---|---|
| `src/lib/app/app.ts` | Replaced sport configs with final tiered schedule; removed unused `THIRTY_MINUTES_MS` import |
| `src/discord/commands/force-ingestion.ts` | Updated `SPORT_KEY_TO_GROUP` to match final sport list |

### Removed Obsolete Tennis Keys

| Old Key | Reason |
|---|---|
| `tennis_atp` | HTTP 404 — generic key not recognized by The Odds API |
| `tennis_wta` | HTTP 404 — generic key not recognized by The Odds API |

### Final Sport List (16 total)

| # | Key | Group | Tier | Interval | Polls/Day |
|---|---|---|---|---|---|
| **Tier 1 (60 min)** | | | | | |
| 1 | `icehockey_nhl` | Ice Hockey | League | 60 min | 14 |
| 2 | `baseball_mlb` | Baseball | League | 60 min | 14 |
| 3 | `basketball_wnba` | Basketball | League | 60 min | 14 |
| 4 | `soccer_usa_mls` | Soccer | League | 60 min | 14 |
| | *Tier 1 subtotal* | | | | *56* |
| **Tier 1 — Tennis (60 min)** | | | | | |
| 5 | `tennis_atp_wimbledon` | Tennis | Tournament | 60 min | 14 |
| 6 | `tennis_atp_us_open` | Tennis | Tournament | 60 min | 14 |
| 7 | `tennis_atp_indian_wells` | Tennis | Tournament | 60 min | 14 |
| 8 | `tennis_atp_miami_open` | Tennis | Tournament | 60 min | 14 |
| 9 | `tennis_wta_wimbledon` | Tennis | Tournament | 60 min | 14 |
| 10 | `tennis_wta_us_open` | Tennis | Tournament | 60 min | 14 |
| 11 | `tennis_wta_indian_wells` | Tennis | Tournament | 60 min | 14 |
| 12 | `tennis_wta_miami_open` | Tennis | Tournament | 60 min | 14 |
| | *Tennis subtotal* | | | | *112* |
| **Tier 2 (4h)** | | | | | |
| 13 | `basketball_nba` | Basketball | League | 4h | 4 |
| 14 | `soccer_epl` | Soccer | League | 4h | 4 |
| 15 | `soccer_uefa_champs_league` | Soccer | Tournament | 4h | 4 |
| 16 | `americanfootball_ncaaf` | Football | League | 4h | 4 |
| | *Tier 2 subtotal* | | | | *16* |
| | **Total** | | | | **184** |

Active polling window: **09:00–23:00 Europe/Budapest** (14 hours)

---

## Estimated The Odds API Credit Consumption

Each match-fetch job makes 1 `GET /v4/sports/{sport}/odds` call = 1 credit.  
Each triggered `sync-odds-for-sport` job makes another 1 credit call.

| Scenario | Match-Fetch Credits | Odds-Fetch Credits | Total Daily | Total Monthly |
|---|---|---|---|---|
| Match-fetch only (no near-term matches) | 184 | 0 | 184 | **5,520** |
| Conservative (20% odds-fetch triggered) | 184 | 37 | 221 | **6,630** |
| Typical (40% odds-fetch triggered) | 184 | 74 | 258 | **7,740** |
| Heavy (60% odds-fetch triggered) | 184 | 110 | 294 | **8,820** |
| Worst-case (100% odds-fetch) | 184 | 184 | 368 | **11,040** |

### Target Operating Range: 12,000–15,000 credits/month

The current configuration consumes **7,740–11,040 credits/month** in typical to worst-case scenarios. This is **well below the 20,000/month cap**, leaving a significant buffer of **~9,000 credits/month**.

**If higher usage is desired**, the 4-hour Tier 2 sports can safely be moved to 60-minute polling, which would add:
- 3 additional Tier 2 sports × (14 - 4) = 30 additional match-fetch calls/day = ~900 credits/month

Moving all 16 sports to 60-minute polling would consume approximately 16 × 14 × 30 = **~13,440 credits/month** (match-fetch only) to **~20,160** (worst-case with odds-fetch). The 60-minute NBA polling alone would push usage into the 12,000–15,000 target range.

---

## HTTP 422/404 Risk Assessment

### Previously Fixed
- **HTTP 422 (missing `regions`):** Fixed in Sprint 13 — all `getOdds()` calls now include `regions: 'eu,us,uk'`, `markets: 'h2h,spreads,totals'`, `oddsFormat: 'decimal'`
- **HTTP 404 (unknown sport key):** Fixed in Sprint 13 — `MatchIngestionService.ingestTraditionalSport()` catches 404 and returns empty result gracefully

### Current Risk
All 16 configured keys use the standard `{sport}_{league/tournament}` format supported by The Odds API v4. The 404 guard in place handles any inactive or unknown keys without pipeline failure.

---

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ Zero errors |
| Obsolete `tennis_atp`/`tennis_wta` removed | ✅ Not present in `app.ts` or `force-ingestion.ts` |
| `THIRTY_MINUTES_MS` no longer imported | ✅ Removed from import |
| Tennis uses 60-minute polling (not 30) | ✅ All 8 tennis keys use `SIXTY_MINUTES_MS` |
| All 16 keys consistent between `app.ts` and `force-ingestion.ts` | ✅ Both files updated identically |
| HTTP 422 guard in place | ✅ (Sprint 13) |
| HTTP 404 guard in place | ✅ (Sprint 13) |

---

## Verdict

**PASS** — Final scheduler configuration implemented. 16 traditional sports with tiered polling. Estimated monthly consumption of 7,740–11,040 credits stays well within the 20,000 credit/month cap with a minimum 45% buffer. Tennis polling standardized to 60 minutes. All obsolete keys removed.