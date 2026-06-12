/**
 * Derived idea-level aggregation over ValueOpportunity rows.
 *
 * A Betting Idea is (matchId, outcome [, market]) — market joins the key when
 * ValueOpportunity gains a market column (H2H-only today). Storage stays at
 * bookmaker-row granularity; ideas are computed by grouping at read time.
 * See docs/audits/IDEA_LEVEL_ARCHITECTURE_DESIGN.md.
 */

/**
 * Betting exchanges quoting pre-commission back prices — never opportunity
 * candidates, never headlines, never counted in corroboration. Their nominal
 * "edges" vs de-vigged Pinnacle are overstated by the 2–5% commission.
 *
 * Includes exchange keys from regions not yet requested (betfair_ex_au in `au`,
 * novig/prophetx in `us_ex`) so the planned region expansion cannot silently
 * reintroduce exchange candidates.
 */
const EXCHANGE_BOOKMAKERS: ReadonlySet<string> = new Set([
  'betfair_ex_uk',
  'betfair_ex_eu',
  'betfair_ex_au',
  'smarkets',
  'matchbook',
  'novig',
  'prophetx',
]);

/** Exact-key family assignments: shared owner or shared pricing engine. */
const FAMILY_BY_KEY: Readonly<Record<string, string>> = {
  betsson: 'betsson-group',
  nordicbet: 'betsson-group',
  ladbrokes_uk: 'entain',
  coral: 'entain',
  betonlineag: 'betonline-group',
  lowvig: 'betonline-group',
};

/** Prefix-based family assignments: regional skins of one brand. */
const FAMILY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['betfair', 'betfair'],
  ['unibet', 'unibet'],
  ['leovegas', 'leovegas'],
  ['winamax', 'winamax'],
  ['williamhill', 'williamhill'],
];

/** Collapses a bookmaker key to its family — identity for independent books. */
export function bookmakerFamily(key: string): string {
  const exact = FAMILY_BY_KEY[key];
  if (exact) return exact;
  for (const [prefix, family] of FAMILY_PREFIXES) {
    if (key.startsWith(prefix)) return family;
  }
  return key;
}

export function isExchange(key: string): boolean {
  return EXCHANGE_BOOKMAKERS.has(key);
}

/** Minimal row shape required for idea grouping and headline selection. */
export interface IdeaMemberRow {
  readonly matchId: string;
  readonly outcome: string;
  readonly bookmaker: string;
  readonly bookmakerOdds: unknown;
  readonly createdAt: Date;
}

export function oddsToNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  if (v !== null && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
  return 0;
}

/** Idea key: one betting idea per (match, outcome). */
export function ideaKey(row: Pick<IdeaMemberRow, 'matchId' | 'outcome'>): string {
  return `${row.matchId}|${row.outcome}`;
}

/** Groups rows into ideas. Insertion order of the input is preserved per idea. */
export function groupIdeas<T extends IdeaMemberRow>(rows: readonly T[]): Map<string, T[]> {
  const byIdea = new Map<string, T[]>();
  for (const row of rows) {
    const key = ideaKey(row);
    let members = byIdea.get(key);
    if (!members) {
      members = [];
      byIdea.set(key, members);
    }
    members.push(row);
  }
  return byIdea;
}

/**
 * Headline row for an idea: the best-odds NON-EXCHANGE row (the price a user
 * acting on the alert would take). Falls back to the best exchange row only
 * when the idea has no non-exchange member (legacy rows). Tie-break: earliest
 * createdAt. Returns undefined for an empty input.
 */
export function selectHeadline<T extends IdeaMemberRow>(rows: readonly T[]): T | undefined {
  const pick = (candidates: readonly T[]): T | undefined => {
    let best: T | undefined;
    let bestOdds = -Infinity;
    for (const row of candidates) {
      const odds = oddsToNumber(row.bookmakerOdds);
      if (odds > bestOdds) {
        best = row;
        bestOdds = odds;
      } else if (odds === bestOdds && best && row.createdAt < best.createdAt) {
        best = row;
      }
    }
    return best;
  };

  const nonExchange = rows.filter(r => !isExchange(r.bookmaker));
  return pick(nonExchange.length > 0 ? nonExchange : rows);
}

/** Family-collapsed corroboration count; exchanges excluded. */
export function corroborationCount(rows: ReadonlyArray<Pick<IdeaMemberRow, 'bookmaker'>>): number {
  const families = new Set<string>();
  for (const row of rows) {
    if (isExchange(row.bookmaker)) continue;
    families.add(bookmakerFamily(row.bookmaker));
  }
  return families.size;
}

/** One settled idea: its headline row plus how many bookmaker rows it collapsed. */
export interface SettledIdea<T> {
  readonly headline: T;
  readonly rowCount: number;
}

/**
 * Groups settled rows into ideas and resolves each idea's headline row.
 * Idea-level accounting reads exactly one row (the headline) per idea.
 */
export function aggregateSettledIdeas<T extends IdeaMemberRow>(
  rows: readonly T[],
): SettledIdea<T>[] {
  const ideas: SettledIdea<T>[] = [];
  for (const members of groupIdeas(rows).values()) {
    const headline = selectHeadline(members);
    if (headline) ideas.push({ headline, rowCount: members.length });
  }
  return ideas;
}
