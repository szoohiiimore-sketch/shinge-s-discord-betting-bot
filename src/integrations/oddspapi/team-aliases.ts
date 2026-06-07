/**
 * Maps normalized team name variants to their canonical normalized form.
 *
 * Only the non-canonical form needs an entry. The canonical form is used
 * as both the map value and implicitly as the result when no entry exists.
 */
export const TEAM_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['navi', 'natusvincere'],
  ['liquid', 'teamliquid'],
  ['vitality', 'teamvitality'],
  ['faze', 'fazeclan'],
  ['g2', 'g2esports'],
  ['falcons', 'teamfalcons'],
  ['rng', 'royalnevergiveup'],
  ['t1', 't1'],
]);

export function resolveAlias(normalized: string): string {
  return TEAM_ALIASES.get(normalized) ?? normalized;
}

export function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}