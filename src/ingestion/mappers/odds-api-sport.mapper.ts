import type { OddsApiSportMapper as IOddsApiSportMapper } from '@/ingestion/contracts';
import type { RawOddsApiSport, CanonicalSport, CanonicalLeague } from '@/ingestion/contracts';
import { slugify } from './mapper.utils';

/**
 * Maps a raw The Odds API sport entry to canonical reference entities.
 *
 * One RawOddsApiSport record encodes both a sport group (the Sport entity) and a
 * specific competition (the League entity). The group field determines Sport identity;
 * the key field determines League identity.
 *
 * Multiple raw sport records share the same group (e.g., "soccer_epl" and
 * "soccer_bundesliga" both have group "Soccer"). All produce the same CanonicalSport
 * value — the repository upsert handles idempotency.
 */
export class OddsApiSportMapper implements IOddsApiSportMapper {
  toCanonicalSport(raw: RawOddsApiSport): CanonicalSport {
    const groupSlug = slugify(raw.group);
    return {
      slug: groupSlug,
      name: raw.group,
      category: 'TRADITIONAL',
      externalApiSource: 'THE_ODDS_API',
      externalSportKey: groupSlug,
    };
  }

  toCanonicalLeague(raw: RawOddsApiSport): CanonicalLeague {
    return {
      externalId: raw.key,
      name: raw.title,
      slug: raw.key,
      sportSlug: slugify(raw.group),
    };
  }
}
