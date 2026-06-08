# Settlement Example Trace

**Date:** 2026-06-08  
**Scope:** Trace one completed match through the settlement pipeline using real database records  

---

## Example 1: Esports Match — LOSS (Noise-Magnified Edge)

### Match: Fluxo W7M vs paiN Gaming (LoL)

**Match ID:** `ps:1520677`  
**ValueOpportunity ID:** `0a212405-ff38-4820-9426-0562ddf36119`

---

### Step 1: Value Detection (Captured: 2026-06-07 17:52 UTC)

| Field | Value |
|---|---|
| Outcome | `Pain Gaming` (predicted) |
| Bookmaker | Pinnacle |
| Pinnacle Odds | 2.85 |
| Consensus Bookmakers | `bet365`, `bet365` |
| Consensus Odds | (estimated) ~1.95, ~1.95 (duplicate?) |
| Fair Odds | 1.8554 |
| Consensus Probability | 0.5390 |
| Edge | **+53.6%** |

The edge appears extremely high (53.6%). The `consensusBookmakers: ["bet365", "bet365"]` suggests a **data quality issue** — bet365 appears twice, meaning only one unique bookmaker contributed to consensus instead of the required 2. This inflated the consensus probability and created a false-positive value detection.

**Verification:** With N=2 consensus bookmakers and one being a duplicate, the consensus probability of 0.5390 implies:

```
1/O1 + 1/O2 = 0.5390 × 2 = 1.078
```

This sum > 1.0 implies the average payout is less than stake — standard bookmaker margin, but with only one unique consensus bookmaker (bet365 counted twice), the "consensus" is not a consensus at all.

---

### Step 2: Match Result (Settlement: 2026-06-08 04:00 UTC)

The settlement pipeline ran via `SettlementService.settleEsports()` at ~04:00 UTC:

```
SettlementWorker.process(job)
  → SettlementService.settleEsports(['cs2', 'dota2', 'lol', 'valorant'])
    → PandaScore: GET /lol/matches/past?page=1&per_page=50
    → Found match ps:1520677 with status "finished"
    → HOME_TEAM (Fluxo W7M) won 2-1
    → Match.updateMany({ externalId: 'ps:1520677', NOT: { status: 'FINISHED' } },
         { status: 'FINISHED', result: 'HOME_WIN', homeScore: 2, awayScore: 1 })
    → _settleUnsettled()
```

**Match record updated:**

| Field | Value |
|---|---|
| homeTeam | Fluxo W7M |
| awayTeam | paiN Gaming |
| homeScore | 2 |
| awayScore | 1 |
| result | `HOME_WIN` |
| status | `FINISHED` |

---

### Step 3: Outcome Determination

**Code path:** `SettlementService._settleUnsettled()` → `determineBetOutcome()`

```typescript
function determineBetOutcome(outcome, homeTeamName, awayTeamName, matchResult) {
  const outcomeLower = 'pain gaming'       // predicted outcome
  const homeNameLower = 'fluxo w7m'        // actual home team
  const awayNameLower = 'pain gaming'      // actual away team (wait — names are the same?)

  // Pass 1: Exact match
  outcomeLower === homeNameLower?  'pain gaming' === 'fluxo w7m'?  NO
  outcomeLower === awayNameLower?  'pain gaming' === 'pain gaming'? YES

  // Match: outcome == away team name
  // matchResult = 'HOME_WIN' (home team won)
  // Since outcome == away team, bet is a LOSS
  return matchResult === 'AWAY_WIN' ? 'WIN' : 'LOSS';
  // → LOSS
}
```

**Decision:**

| Check | Result |
|---|---|
| Predicted outcome | `Pain Gaming` |
| Normalized team name | `pain gaming` |
| Home team name lower | `fluxo w7m` |
| Away team name lower | `pain gaming` |
| Exact match? | ✅ `pain gaming` === `pain gaming` → outcome matches **away** team |
| Match result | `HOME_WIN` (Fluxo W7M won) |
| Bet result | `LOSS` (predicted away team, but home team won) |

---

### Step 4: Profit/Loss Calculation

```typescript
function calcProfitLoss(outcome, odds) {
  if (outcome === 'WIN')  return odds - 1;   // would return 1.85 units profit
  if (outcome === 'LOSS') return -1;          // returns -1 unit (full stake lost)
  return 0;                                    // PUSH
}
```

| Result | Calculation | Value |
|---|---|---|
| **LOSS** | `calcProfitLoss('LOSS', 2.85)` | **-1.00 units** |

---

### Step 5: Database Update

```sql
UPDATE value_opportunities
SET settledAt = '2026-06-08T04:00:35.399Z',
    bet_result = 'LOSS',
    profit_loss_units = -1.00
WHERE id = '0a212405-ff38-4820-9426-0562ddf36119';
```

---

## Example 2: Dota 2 Match — WIN (Legitimate Value)

### Match: VooDooSh Club vs TPaBoMaH Club

**ValueOpportunity ID:** `af6626c2-b3a1-45b2-84a3-948dbe167c61`

| Step | Detail | Value |
|---|---|---|
| **Value Detection** | Pinnacle Odds | 3.50 |
| | Fair Odds | 2.549 |
| | Edge | +37.3% |
| **Match Result** | HOME_WIN (VooDooSh Club won 2-1) | |
| **Outcome Match** | `VooDooSh Club` | Matches home team name |
| **Match Result** | `HOME_WIN` | Home team won |
| **Bet Result** | `WIN` | ✅ Correct |
| **P&L** | `calcProfitLoss('WIN', 3.50)` | **+2.50 units** |

---

## Example 3: Esports LOSS (Name Normalization Issue Uncovered)

### Match: paiN Gaming spelling mismatch

The database stores `awayTeam: "paiN Gaming"` (exact capitalisation). The ValueOpportunity stores `outcome: "Pain Gaming"` (different capitalisation). The `determineBetOutcome()` function lowercases both strings, so `"Pain Gaming"` → `"pain gaming"` correctly matches `"paiN Gaming"` → `"pain gaming"`. **The name normalization works correctly for this case.**

However, the `consensusBookmakers: ["bet365", "bet365"]` duplicate is a **data quality issue** — the esports odds pipeline (OddsPapi) uses only Pinnacle. For esports matches, the consensus bookmakers list comes from... wait — OddsPapi is Pinnacle-only since Sprint 21. The `bet365` entries must have been stored before the Sprint 21 bookmaker reduction. This means the consensus was generated from a single bookmaker counted twice, which inflated the edge calculation and created a false-positive value detection.

---

## Pipeline Summary

```
1. Odds Ingestion
   → OddsSnapshot created (capturedAt, bookmaker, market, outcome, price)

2. Value Detection
   → detectForMatchExternalIds()
   → Pinnacle odds = 2.85
   → Consensus = [bet365, bet365] (duplicate — only 1 unique bookmaker)
   → consensusProbability = 0.5390
   → fairOdds = 1.8554
   → edge = +53.6%
   → ValueOpportunity created (alerted via Discord)

3. Settlement (every 4h)
   → settleEsports() called
   → PandaScore getPastMatches() returns finished matches
   → Match.updateMany() sets status=FINISHED, result=HOME_WIN

4. _settleUnsettled()
   → Finds ValueOpportunity with settledAt IS NULL
   → determineBetOutcome('Pain Gaming', 'Fluxo W7M', 'paiN Gaming', 'HOME_WIN')
   → outcome 'pain gaming' === awayTeam name 'pain gaming'
   → matchResult is HOME_WIN, but outcome matches away team → LOSS
   → calcProfitLoss('LOSS', 2.85) = -1.00

5. Database Update
   → ValueOpportunity.settledAt = 2026-06-08T04:00:35Z
   → ValueOpportunity.betResult = 'LOSS'
   → ValueOpportunity.profitLossUnits = -1.00

6. Discord Notification (not directly triggered by settlement)
   → SettlementWorker calls notifySettledOutcomes()
   → Posts to outcomes channel:
     ❌ LOSS — league-of-legends | Fluxo W7M vs paiN Gaming
     Outcome: Pain Gaming | Odds: 2.85 | Edge: +53.6% | P/L: -1.00u
     Settled: 2026-06-08 04:00 UTC