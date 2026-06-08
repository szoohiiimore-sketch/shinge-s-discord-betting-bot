import type { IngestionMatchStatus, IngestionMatchResult, IngestionOddsMarket } from '@/ingestion/contracts';
import type { PandascoreMatchStatus, MatchWinner, TeamResult } from '@/integrations/pandascore/types';
import type { OddsMarketKey } from '@/integrations/the-odds-api/types';

/**
 * Converts a display name to a stable, URL-safe slug.
 * Steps: lowercase → trim → non-alphanumeric sequences → single hyphen → strip leading/trailing hyphens.
 *
 * Used to synthesise Team.externalId from The Odds API team name strings, which carry no IDs.
 *
 * Examples:
 *   "Manchester United"   → "manchester-united"
 *   "Paris Saint-Germain" → "paris-saint-germain"
 *   "Brighton & Hove Albion" → "brighton-hove-albion"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds the source-namespaced Match.externalId for a The Odds API event.
 * Prefix "oa:" makes the source unambiguous on the globally-unique Match.externalId column.
 */
export function oddsApiMatchExternalId(eventId: string): string {
  return `oa:${eventId}`;
}

/**
 * Builds the source-namespaced Match.externalId for a PandaScore match.
 * Prefix "ps:" makes the source unambiguous on the globally-unique Match.externalId column.
 */
export function pandascoreMatchExternalId(matchId: number): string {
  return `ps:${matchId}`;
}

/**
 * Infers match status from commence time vs the API call timestamp.
 * The Odds API /odds endpoint does not return an explicit status field.
 * Matches that have not started are SCHEDULED; matches past their start time are LIVE.
 * FINISHED, CANCELLED, and POSTPONED are not observable from this endpoint.
 */
export function inferOddsApiMatchStatus(commenceTime: Date, capturedAt: Date): IngestionMatchStatus {
  return commenceTime > capturedAt ? 'SCHEDULED' : 'LIVE';
}

/**
 * Maps a PandaScore match status string to the canonical IngestionMatchStatus.
 * The mapping is 1:1 with the schema's MatchStatus enum.
 */
export function mapPandascoreMatchStatus(status: PandascoreMatchStatus): IngestionMatchStatus {
  switch (status) {
    case 'not_started': return 'SCHEDULED';
    case 'running':     return 'LIVE';
    case 'finished':    return 'FINISHED';
    case 'canceled':    return 'CANCELLED';
    case 'postponed':   return 'POSTPONED';
  }
}

/**
 * Derives match result from PandaScore winner and draw fields.
 * Returns null when the match is not yet settled (winner is null and draw is false).
 * Home/away assignment follows the opponents[0]/opponents[1] convention.
 */
export function mapPandascoreMatchResult(
  draw: boolean,
  winner: MatchWinner | null,
  homeTeamId: number,
  awayTeamId: number,
): IngestionMatchResult | null {
  if (draw) return 'DRAW';
  if (!winner) return null;
  if (winner.id === homeTeamId) return 'HOME_WIN';
  if (winner.id === awayTeamId) return 'AWAY_WIN';
  return null;
}

/**
 * Extracts the score for a specific team from a PandaScore results array.
 * Returns null if results are absent or the team is not found (pre-match state).
 * For esports, score represents maps/games won in the series.
 */
export function extractPandascoreScore(
  results: readonly TeamResult[] | null,
  teamId: number,
): number | null {
  if (!results) return null;
  const entry = results.find(r => r.team_id === teamId);
  return entry?.score ?? null;
}

/**
 * Maps an Odds API market key to the canonical IngestionOddsMarket.
 * Returns undefined for unrecognised keys (e.g. Betfair Exchange custom market keys
 * that are not in the OddsMarketKey union at runtime). Callers must filter these out.
 */
export function mapOddsMarket(key: OddsMarketKey): IngestionOddsMarket | undefined {
  switch (key) {
    case 'h2h':     return 'H2H';
    case 'spreads': return 'SPREADS';
    case 'totals':  return 'TOTALS';
    default:        return undefined;
  }
}
