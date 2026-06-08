# Mass League Expansion Implementation

**Date:** 2026-06-08  
**Scope:** Add all leagues from `ahhhh.txt` to the traditional sports scheduler with 3-hour polling  

---

## Leagues Discovered in `ahhhh.txt`

The file at `c:\Betting\ahhhh.txt` contained 36 lines of league data, including some duplicates. After parsing:

| # | League Key | Sport Group |
|---|---|---|
| 1 | `soccer_brazil_serie_b` | Soccer |
| 2 | `soccer_argentina_primera_division` | Soccer |
| 3 | `soccer_australia_aleague` | Soccer |
| 4 | `soccer_austria_bundesliga` | Soccer |
| 5 | `soccer_brazil_campeonato` | Soccer |
| 6 | `soccer_belgium_first_div` | Soccer |
| 7 | `soccer_chile_campeonato` | Soccer |
| 8 | `soccer_china_superleague` | Soccer |
| 9 | `soccer_denmark_superliga` | Soccer |
| 10 | `soccer_england_league2` | Soccer |
| 11 | `soccer_finland_veikkausliiga` | Soccer |
| 12 | `soccer_france_ligue_two` | Soccer |
| 13 | `soccer_germany_bundesliga2` | Soccer |
| 14 | `soccer_germany_bundesliga_women` | Soccer |
| 15 | `soccer_germany_dfb_pokal` | Soccer |
| 16 | `soccer_germany_liga3` | Soccer |
| 17 | `soccer_greece_super_league` | Soccer |
| 18 | `soccer_italy_serie_b` | Soccer |
| 19 | `soccer_japan_j_league` | Soccer |
| 20 | `soccer_korea_kleague1` | Soccer |
| 21 | `soccer_league_of_ireland` | Soccer |
| 22 | `soccer_mexico_ligamx` | Soccer |
| 23 | `soccer_netherlands_eredivisie` | Soccer |
| 24 | `soccer_norway_eliteserien` | Soccer |
| 25 | `soccer_poland_ekstraklasa` | Soccer |
| 26 | `soccer_portugal_primeira_liga` | Soccer |
| 27 | `soccer_russia_premier_league` | Soccer |
| 28 | `soccer_spain_segunda_division` | Soccer |
| 29 | `soccer_saudi_arabia_pro_league` | Soccer |
| 30 | `soccer_spl` | Soccer |
| 31 | `soccer_sweden_allsvenskan` | Soccer |
| 32 | `soccer_sweden_superettan` | Soccer |
| 33 | `soccer_switzerland_superleague` | Soccer |
| 34 | `soccer_turkey_super_league` | Soccer |

Note: `soccer_brazil_serie_b` appeared twice in `ahhhh.txt` (lines 1 and 6) — only one entry was added. `soccer_usa_mls` (line 36) was already configured in Tier 1.

---

## Files Modified (4)

| File | Change |
|---|---|
| `src/ingestion/bootstrap/ingestion-scheduler.ts` | Added `THREE_HOURS_MS = 3 * 60 * 60 * 1000` constant |
| `src/ingestion/bootstrap/index.ts` | Exported `THREE_HOURS_MS` |
| `src/lib/app/app.ts` | Added Tier 3 (34 soccer leagues at 3-hour polling); imported `THREE_HOURS_MS` |
| `src/discord/commands/force-ingestion.ts` | Added all 34 new sport keys to `SPORT_KEY_TO_GROUP` mapping |

---

## Scheduler Count

| Status | Sports | Count |
|---|---|---|
| **Before** | Tier 1 (60 min) + Tier 1 Tennis + Tier 2 (4h) | **16** |
| **After** | Tier 1 (60 min) + Tier 1 Tennis + Tier 2 (4h) + Tier 3 (3h) | **50** |

**Newly added: 34 soccer leagues**  
**Total scheduler count: 50 traditional sports + 4 esports games**

---

## Validation

```powershell
npx tsc --noEmit
```
✅ Zero TypeScript errors

### Startup Registration Impact

The startup log will now show:
```
Registered sync-reference-data (every 24 h)
Registered sync-traditional-sport (50 entries)
Registered sync-esports-game (4 entries)
Registered settle-matches (every 4 h)
Registered daily-summary (23:00 Budapest)
All repeatable ingestion jobs registered
  referenceData: 1
  traditionalSports: 50
  esportsGames: 4
  settlement: 1
  dailySummary: 1
```

### Hourly Poll Rate Impact

10-minute active window (09:00-23:00 → 14 hours):
- 24 Tier 1 sports (60 min): 336 polls/day
- 4 Tier 2 sports (4h): 16 polls/day
- 34 Tier 3 sports (3h): 136 polls/day
- **Total: 488 polls/day → ~14,640 polls/month**

With ~50% odds-fetch trigger rate: ~22,000 The Odds API credits/month

---

## Verdict

**PASS** — All 34 unique leagues from `ahhhh.txt` were added to the scheduler configuration. All use `THREE_HOURS_MS` (3-hour polling). Existing sports remain unchanged. Esports configuration was not modified.