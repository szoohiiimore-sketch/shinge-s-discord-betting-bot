# Esports Odds Provider Audit

**Date:** 2026-06-07
**Purpose:** Identify the most realistic odds data provider for the six V1 esports (CS2, Dota 2, League of Legends, Valorant, Rainbow Six Siege, Mobile Legends) at startup budget (≤ $50/month preferred, ≤ $100/month acceptable).
**Use case:** Value betting research — reading and storing aggregated bookmaker odds for algorithmic analysis. Not operating a sportsbook.

---

## Critical Product Category Distinction

Before evaluating providers, a fundamental market structure point must be understood. Esports odds providers fall into three distinct categories that are often confused:

| Category | Description | Examples | Viable? |
|----------|-------------|---------|---------|
| **Odds Aggregators** | Collect odds from 50–400+ bookmakers and expose them via API for consumption | OddsPapi, Esport-API.com, TheOddsAPI | ✅ Correct product |
| **Odds Compilers / B2B Suppliers** | Generate proprietary odds and license them TO sportsbook operators | Oddin.gg, PandaScore Odds, Kambi, BetConstruct | ❌ Wrong product — they sell to bookmakers, not to you |
| **Data / Stats Platforms** | Provide match results, tournament schedules, player statistics — no bookmaker odds | PandaScore Stats, GRID, Abios (partially) | ⚠️ Complementary — match data, not odds |

**Oddin.gg, PandaScore Odds API, Kambi, and BetConstruct are in the second category.** Evaluating them for a value-betting bot is a category error — they are the supply side of the odds market, not the aggregation side. They are excluded from the comparison below with an explanation of why.

---

## 1. Provider Evaluations

### 1.1 OddsPapi (oddspapi.io) — PRIMARY RECOMMENDATION

| Attribute | Detail |
|-----------|--------|
| **Product category** | Odds aggregator |
| **CS2** | ✅ Confirmed (Sport ID: 17) |
| **Dota 2** | ✅ Confirmed (Sport ID: 16) |
| **League of Legends** | ✅ Confirmed (Sport ID: 18) |
| **Valorant** | ✅ Confirmed (Sport ID: 61) |
| **Rainbow Six Siege** | ✅ Confirmed |
| **Mobile Legends** | ⚠️ 69 sports total listed; MLBB not explicitly named in reviewed documentation |
| **Odds type** | Pre-match + live in-play |
| **Bookmaker count** | 350+ including Pinnacle (sharp), GG.BET, Thunderpick, Stake, Bet365, Betway, 1xBet |
| **Sharp-book coverage** | ✅ Yes — Pinnacle and Singbet included |
| **Free tier** | ✅ 250 requests/month — full bookmaker access, historical odds, no credit card |
| **Paid tier pricing** | ~$49/month (developer community reports; no public pricing page — contact required for confirmation) |
| **Rate limits** | Free: 250 req/month total; Paid: not published |
| **Live odds delivery** | REST (polling) on free; WebSocket push on paid |
| **Historical odds** | ✅ Included in free tier |
| **Terms / betting use** | ✅ Explicitly designed for betting analytics — no ToS restriction on reading odds |
| **Integration style** | REST API (JSON), similar structure to TheOddsAPI |
| **Reliability** | Emerging provider; limited public track record vs TheOddsAPI |

**Notes:**  
The free tier is notably generous — Pinnacle sharp lines are included with no credit-multiplier penalty (unlike TheOddsAPI where requesting multiple markets costs multiple credits per call). The 250 req/month ceiling is the only real limitation, which is workable with aggressive caching during development. The paid tier pricing must be confirmed directly but developer community reports cluster around $49–$79/month for reasonable limits.

---

### 1.2 Esport-API.com

| Attribute | Detail |
|-----------|--------|
| **Product category** | Odds aggregator |
| **CS2** | ✅ Confirmed |
| **Dota 2** | ✅ Confirmed |
| **League of Legends** | ✅ Confirmed |
| **Valorant** | ✅ Confirmed |
| **Rainbow Six Siege** | ✅ Confirmed |
| **Mobile Legends** | ⚠️ Not listed among the 11 confirmed titles |
| **Odds type** | Pre-match fixture odds (no confirmed live in-play) |
| **Bookmaker count** | Not disclosed; sample data shows decimal odds without attribution |
| **Sharp-book coverage** | Not confirmed — bookmaker sources are opaque |
| **Free tier** | ❌ None (15-day trial at $35 is cheapest entry) |
| **Paid tier pricing** | $60/month (~€50/month) — all-in, unlimited requests, public transparent pricing |
| **Rate limits** | "Unlimited requests" on monthly plan |
| **Live odds delivery** | REST only (polling); no WebSocket confirmed |
| **Historical odds** | Not confirmed |
| **Terms / betting use** | Not restricted; designed for betting-related consumers |
| **Integration style** | REST API (JSON) |
| **Reliability** | Active since 2017; 500+ customers; longer track record than OddsPapi |

**Notes:**  
The most price-transparent option in the market. $60/month with unlimited requests and no credit model is predictable. The main weaknesses are opaque bookmaker sourcing (you cannot tell if you're getting sharp-book lines or only recreational-book lines) and the absence of confirmed live in-play odds. For pre-match value research the data may be sufficient, but without knowing bookmaker attribution, assessing line sharpness is difficult.

---

### 1.3 OpticOdds (opticodds.com)

| Attribute | Detail |
|-----------|--------|
| **Product category** | Odds aggregator |
| **CS2** | ✅ Confirmed |
| **Dota 2** | ✅ Confirmed |
| **League of Legends** | ✅ Confirmed |
| **Valorant** | ✅ "and more" (unconfirmed list) |
| **Rainbow Six Siege** | Not confirmed |
| **Mobile Legends** | Not confirmed |
| **Odds type** | Pre-match + live in-play |
| **Bookmaker count** | 100+ sportsbooks |
| **Sharp-book coverage** | Not confirmed publicly |
| **Free tier** | Trial by application only ("book a demo") |
| **Paid tier pricing** | Enterprise; no public pricing — likely $500+/month |
| **Rate limits** | Not published |
| **Live odds delivery** | REST + push stream |
| **Integration style** | REST API (JSON or XML) + push |

**Notes:**  
Good technical offering with push-based delivery and 100+ bookmakers, but the enterprise sales approach and absence of public pricing strongly suggests pricing above the $100/month budget. Worth requesting a trial to assess data quality, but do not plan the V1 architecture around it.

---

### 1.4 GRID Esports (grid.gg) — Match Data Only

| Attribute | Detail |
|-----------|--------|
| **Product category** | Official game data platform (stats, not odds) |
| **Odds data** | ❌ None — GRID does not provide bookmaker odds |
| **Match data** | ✅ CS2, Dota 2 (Open Access); more "coming soon" |
| **Free tier** | ✅ Open Access for qualifying developers (pre-revenue startups, researchers, students) |
| **Paid pricing** | Custom commercial terms; no public pricing |
| **Data source** | Official tournament organizer / publisher data feeds |
| **Relevance for odds** | None directly |
| **Relevance for architecture** | ✅ Could supplement PandaScore match data for CS2/Dota 2 with official tournament data |

**Notes:**  
GRID is not an odds provider. Include in this audit only because its free Open Access tier can supplement the match ingestion pipeline (CS2/Dota 2) with a second data source based on official in-game telemetry. Apply for access regardless of which odds provider is selected.

---

### 1.5 Providers in the Wrong Category (Excluded)

The following providers generate and supply odds TO licensed sportsbook operators. They are not odds aggregators and cannot be used to read bookmaker lines for value research.

| Provider | Category | Why Excluded |
|----------|----------|--------------|
| **Oddin.gg** | B2B odds compiler → bookmakers | Sells proprietary odds TO operators (Betway, Stake, etc.). Partners listed are their clients, not data sources. Enterprise contracts only. |
| **PandaScore Odds API** | B2B odds compiler → bookmakers | Separate product from their stats API. Provides odds feed TO sportsbook operators. Enterprise, contact-only. |
| **Kambi** | B2B sportsbook platform | Full B2B sports betting platform + odds feed for regulated operators. Revenue-share + fixed licensing deals. Publicly traded. |
| **BetConstruct** | B2B sportsbook platform | White-label platform for sportsbooks. €10,000+/month licensing. |
| **Sportradar** | B2B data + odds compiler | Largest sports data company globally. Enterprise contracts starting $2,000–$10,000+/month. |

---

### 1.6 PandaScore Stats API — Existing Integration Risk

This is not an odds provider but warrants a note here because the project currently uses PandaScore's free match data tier.

| Risk | Detail |
|------|--------|
| **ToS conflict** | PandaScore's terms explicitly prohibit *"betting-related usage"* and specifically ban using their data to *"develop, distribute, supply or commercialize odds or odds-related products or services."* A Discord value-betting intelligence bot almost certainly qualifies. |
| **Immediate risk** | The free match data tier is currently used for `sync-esports-game` jobs. This may already be a ToS violation. |
| **Recommended action** | Contact PandaScore directly and request written clarification on whether a personal/non-commercial betting research bot qualifies as prohibited usage. Do this before expanding to paid tiers. |
| **Contingency** | If PandaScore confirms a prohibition: GRID Open Access covers CS2 and Dota 2. For Valorant, LoL, R6 Siege, MLBB — a Liquipedia scraper or alternative match data source would be needed. |

---

## 2. Comparison Table

| Provider | CS2 | D2 | LoL | VAL | R6 | MLBB | Odds Type | Books | Sharp (Pinnacle) | Free Tier | Entry Price | Budget OK? |
|----------|----|----|-----|-----|----|------|-----------|-------|-------------------|-----------|-------------|-----------|
| **OddsPapi** | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | Pre+Live | 350+ | ✅ Yes | 250 req/mo | ~$49/mo (est.) | **YES** |
| **Esport-API.com** | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | Pre-match | Opaque | ❌ Unknown | $35 trial | $60/mo | **YES** |
| **OpticOdds** | ✅ | ✅ | ✅ | ⚠️ | ❓ | ❓ | Pre+Live | 100+ | ❓ | Demo only | Enterprise | ❌ |
| **GRID** | ✅* | ✅* | ❌ | ❌ | ❌ | ❌ | None (stats) | N/A | N/A | ✅ (apply) | Free | Partial |
| **TheOddsAPI** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | N/A | 40+ | ❌ | ✅ 500 cr/mo | $30/mo | No esports |
| **Oddin.gg** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | B2B supply | N/A | N/A | ❌ | Enterprise | ❌ wrong product |
| **PandaScore Odds** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | B2B supply | N/A | N/A | ❌ | Enterprise | ❌ wrong product |
| **Abios** | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | Pre+Live | Used by 40+ ops | ❓ | 14-day trial | ~$1k+/mo | ❌ |
| **Sportradar** | ✅ | ✅ | ✅ | ✅ | ❓ | ❓ | Pre+Live | Enterprise scale | ✅ | ❌ | $2k–$10k/mo | ❌ |
| **BetConstruct** | ✅ | ✅ | ✅ | ❓ | ❓ | ❓ | B2B supply | N/A | N/A | ❌ | €10k+/mo | ❌ wrong product |

*GRID: CS2 and Dota 2 match data only, not odds.
⚠️ Game likely supported but not explicitly confirmed in documentation reviewed.

---

## 3. Monthly Cost Estimate

### V1 — OddsPapi Free Tier (Development + Low-Volume Research)

| Component | Cost |
|-----------|------|
| OddsPapi free tier | $0/month |
| TheOddsAPI traditional sports | $0/month (existing free tier) |
| PandaScore match data | $0/month (existing free tier, pending ToS review) |
| GRID Open Access | $0/month (apply for access) |
| **Total** | **$0/month** |

**Ceiling:** 250 OddsPapi requests/month. At 1 request per match per poll cycle, this supports roughly 8–12 near-term esports matches checked once daily during active tournament periods. Adequate for development and proof-of-concept; insufficient for continuous production polling across 6 games.

---

### V1 Production — OddsPapi Paid Tier

| Component | Estimated Cost |
|-----------|----------------|
| OddsPapi paid tier (confirm exact pricing) | ~$49/month (est.) |
| TheOddsAPI Starter ($30/mo, 20,000 credits) | $30/month |
| PandaScore match data | $0/month (pending ToS review) |
| **Total** | **~$79/month** |

*Within the ≤ $100/month acceptable budget. Confirm OddsPapi paid pricing before committing.*

---

### V1 Production — Esport-API.com Alternative

| Component | Cost |
|-----------|------|
| Esport-API.com all-access | $60/month |
| TheOddsAPI Starter | $30/month |
| PandaScore match data | $0/month |
| **Total** | **$90/month** |

*Within the ≤ $100/month acceptable budget. Transparent, public pricing.*

---

### V2 Upgrade — Dual Provider (Sharp + Coverage)

| Component | Cost |
|-----------|------|
| OddsPapi paid tier (sharp lines) | ~$49/month (est.) |
| Esport-API.com (coverage breadth) | $60/month |
| TheOddsAPI Starter | $30/month |
| **Total** | **~$139/month** |

*Exceeds the stated budget but provides redundancy and broader bookmaker coverage.*

---

## 4. Recommended V1 Solution

**OddsPapi free tier → paid when validated.**

**Rationale:**
1. Start on the free tier with 250 req/month — sufficient to build and test the full esports odds ingestion pipeline with zero cost.
2. Validate data quality: compare Pinnacle CS2/Dota2/LoL lines against a manual check on the actual Pinnacle website. If they match within minutes, the feed quality is confirmed.
3. Upgrade to the paid tier (~$49/month) once the pipeline is proven end-to-end.
4. The REST API structure is similar to TheOddsAPI already integrated — a new `EsportsOddsApiClient` can be built following the same pattern as `DefaultOddsApiClient` in `src/integrations/the-odds-api/`.

**Coverage gap:** MLBB is not confirmed on OddsPapi's public documentation. If MLBB is required, verify with OddsPapi support before committing. If MLBB is absent, Esport-API.com is the fallback (opaque sourcing but confirmed $60/month cap).

---

## 5. Recommended V2 Solution

**OddsPapi paid + Esport-API.com dual-provider approach, if budget allows.**

At ~$139/month total this exceeds the target budget but significantly improves:
- **Data redundancy** — two independent sources for cross-validation
- **Coverage breadth** — MLBB coverage gap is filled if Esport-API.com confirms it
- **Uptime resilience** — if one provider's API is down, the other continues working

If budget is a hard constraint at V2, replace TheOddsAPI Starter with a higher tier and drop one esports provider.

**Longer-term:** If the project scales to have a user base, apply for a trial with OpticOdds. Their 100+ sportsbook coverage and push-stream delivery are a step up in data quality from both OddsPapi and Esport-API.com.

---

## 6. Integration Complexity Estimate

### New integration required: `EsportsOddsApiClient`

The existing architecture handles The Odds API odds in `src/integrations/the-odds-api/`. A new client integration would be needed for any esports odds provider. The existing architecture provides a clear template.

| Task | Effort | Notes |
|------|--------|-------|
| Create `src/integrations/esports-odds-api/` client | Low | Follow same pattern as `the-odds-api` client — HTTP GET, JSON, quota tracking |
| Add `SyncEsportsOddsJobData` contract type | Trivial | `{ videogame, matchExternalIds }` |
| Add `sync-esports-odds` job name to `ODDS_FETCH_JOB_NAMES` | Trivial | One constant |
| Create `EsportsOddsSnapshotIngestionService` | Medium | Similar to `OddsSnapshotIngestionService` but with different match ID scheme (`ps:` prefix vs `oa:`) |
| Create `EsportsOddsSnapshotWorker` | Small | Same pattern as `OddsSnapshotWorker` |
| Enqueue `sync-esports-odds` from `MatchIngestionWorker` after esports sync | Small | Analogous to existing `sync-odds-for-sport` enqueue in `_handleTraditionalSport` |
| Map esports odds API response to `CanonicalOddsSnapshot` | Medium | Schema diff vs The Odds API; depends on provider response shape |
| Register job with scheduler | Trivial | One BullMQ `queue.add` call |

**Total estimate:** 3–5 days of focused development for a single provider.

**OddsPapi integration advantage:** If OddsPapi's response format is similar to TheOddsAPI (REST JSON with event list and bookmaker arrays), the existing `OddsApiEventMapper` logic can be reused with minor adaptation. This could reduce the integration to 1–2 days.

**Esport-API.com integration note:** Their response schema differs from TheOddsAPI (flat match-level odds rather than per-bookmaker market arrays). A new mapper would be needed. Moderate effort.

---

## 7. Final Verdict

### BEST VALUE
**OddsPapi (free tier → ~$49/month)**

Best return on investment: Pinnacle sharp lines from a 350+ bookmaker feed on a free tier, with a realistic paid tier within budget. The Pinnacle line is the most important data point for value detection — recreational book lines without a sharp reference are significantly less useful for identifying edges. Free development access removes all financial risk during the build phase.

---

### BEST CHEAP OPTION
**Esport-API.com ($60/month)**

Transparent, public, predictable pricing with no credit model. $35 trial removes risk of committing to a product with bad data quality. Unlimited requests eliminates quota anxiety. The right choice if OddsPapi's paid pricing cannot be confirmed or if Pinnacle sharp lines are not needed for the analysis model.

---

### BEST LONG-TERM OPTION
**OpticOdds (demo required)**

If the project matures and budget grows, OpticOdds' 100+ sportsbook coverage with push-stream delivery is the natural upgrade path. Push delivery eliminates the polling overhead that both OddsPapi and Esport-API.com require. Book a demo and negotiate — small startup rates are occasionally available for promising projects.

---

## 8. Action Items

| Priority | Action |
|----------|--------|
| P0 | Sign up for OddsPapi free tier — get API key, test CS2/Dota2/LoL/Valorant/R6 response |
| P0 | Verify MLBB support with OddsPapi support chat before V1 launch |
| P0 | Contact PandaScore and request written ToS clarification on betting intelligence bot usage |
| P1 | Apply for GRID Open Access (free CS2 + Dota2 official match data) |
| P1 | Buy $35 Esport-API.com 15-day trial — cross-validate odds quality vs OddsPapi Pinnacle lines |
| P1 | Confirm OddsPapi paid tier exact pricing |
| P2 | Book OpticOdds demo for V2 planning |
| P2 | Design `EsportsOddsApiClient` interface following existing `OddsApiClient` pattern |
