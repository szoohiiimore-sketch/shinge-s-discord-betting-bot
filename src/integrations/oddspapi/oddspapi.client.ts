import type { Logger } from '@/lib/logger';
import { ExternalApiError, RateLimitError, AuthenticationError } from '@/lib/errors';
import type { OddspapiVideogame, OddspapiMatchOdds, OddspapiBookmaker, OddspapiOutcome } from './types';
import type { OddspapiClientConfig } from './oddspapi.config';
import { ODDSPAPI_SPORT_IDS, ODDSPAPI_H2H_MARKET_IDS } from './game-key.map';

export interface OddspapiClient {
  getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]>;
}

// ─── Internal API types (api.oddspapi.io v4) ──────────────────────────────────

interface IоTournament {
  readonly tournamentId: number;
  readonly upcomingFixtures: number;
  readonly liveFixtures: number;
}

interface IoOutcomePlayer {
  readonly bookmakerOutcomeId: 'home' | 'away';
  readonly price: number;
  readonly mainLine: boolean;
}

interface IoOutcome {
  readonly players: Record<string, IoOutcomePlayer>;
}

interface IoMarket {
  readonly marketActive: boolean;
  readonly outcomes: Record<string, IoOutcome>;
}

interface IoBookmakerOdds {
  readonly bookmakerIsActive: boolean;
  readonly suspended: boolean;
  readonly markets: Record<string, IoMarket>;
}

interface IoFixture {
  readonly fixtureId: string;
  readonly participant1Id: number;
  readonly participant2Id: number;
  readonly sportId: number;
  readonly startTime: string;
  readonly bookmakerOdds: Record<string, IoBookmakerOdds>;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class DefaultOddspapiClient implements OddspapiClient {
  private readonly _config: OddspapiClientConfig;
  private readonly _logger: Logger;

  constructor(config: OddspapiClientConfig, logger: Logger) {
    this._config = config;
    this._logger = logger.child({ module: 'oddspapi' });
  }

  async getOddsForGame(videogame: OddspapiVideogame): Promise<OddspapiMatchOdds[]> {
    const sportId = ODDSPAPI_SPORT_IDS[videogame];
    const h2hMarketId = String(ODDSPAPI_H2H_MARKET_IDS[videogame]);

    // Step 1 — get active tournament IDs for this sport
    const tournaments = await this._request<IоTournament[]>('/v4/tournaments', { sportId: String(sportId) });
    const activeTournamentIds = tournaments
      .filter(t => (t.upcomingFixtures ?? 0) > 0 || (t.liveFixtures ?? 0) > 0)
      .map(t => t.tournamentId);

    if (activeTournamentIds.length === 0) {
      this._logger.debug({ videogame }, 'No active tournaments — returning empty odds');
      return [];
    }

    this._logger.debug(
      { videogame, activeTournamentIds: activeTournamentIds.length },
      'Fetching odds for active tournaments',
    );

    // Step 2 — fetch odds per bookmaker (API: one bookmaker per call, max 5 tournament IDs per call)
    const MAX_TOURNAMENT_IDS = 5;
    const fixtureMap = new Map<string, IoFixture & { bookmakerOdds: Record<string, IoBookmakerOdds> }>();

    for (const bookmaker of this._config.bookmakers) {
      // Chunk tournament IDs — API returns 400 if more than 5 are passed
      for (let i = 0; i < activeTournamentIds.length; i += MAX_TOURNAMENT_IDS) {
        const chunk = activeTournamentIds.slice(i, i + MAX_TOURNAMENT_IDS);
        await this._sleep(1100);
        let fixtures: IoFixture[];
        try {
          fixtures = await this._request<IoFixture[]>('/v4/odds-by-tournaments', {
            tournamentIds: chunk.join(','),
            bookmaker,
          });
        } catch (err) {
          // 404 = bookmaker has no fixtures for these tournaments — not an error
          if (err instanceof ExternalApiError && err.statusCode === 404) {
            this._logger.debug({ videogame, bookmaker }, 'No fixtures for bookmaker chunk — skipping');
            continue;
          }
          throw err;
        }

        for (const f of fixtures) {
          const existing = fixtureMap.get(f.fixtureId);
          if (existing) {
            Object.assign(existing.bookmakerOdds, f.bookmakerOdds);
          } else {
            fixtureMap.set(f.fixtureId, { ...f, bookmakerOdds: { ...f.bookmakerOdds } });
          }
        }
      }
    }

    if (fixtureMap.size === 0) {
      this._logger.debug({ videogame }, 'No fixtures with odds — returning empty');
      return [];
    }

    // Step 3 — resolve participant IDs to team names
    const participantIds = [
      ...new Set([...fixtureMap.values()].flatMap(f => [f.participant1Id, f.participant2Id])),
    ];

    await this._sleep(300);
    const participants = await this._request<Record<string, string>>('/v4/participants', {
      participantIds: participantIds.join(','),
      sportId: String(sportId),
    });

    // Step 4 — build OddspapiMatchOdds[]
    const results: OddspapiMatchOdds[] = [];

    for (const fixture of fixtureMap.values()) {
      const homeTeam = participants[String(fixture.participant1Id)];
      const awayTeam = participants[String(fixture.participant2Id)];

      if (!homeTeam || !awayTeam) {
        this._logger.debug(
          { fixtureId: fixture.fixtureId, participant1Id: fixture.participant1Id, participant2Id: fixture.participant2Id },
          'Skipping fixture — participant names unresolvable',
        );
        continue;
      }

      const bookmakers: OddspapiBookmaker[] = [];

      for (const [bookmakerKey, bmOdds] of Object.entries(fixture.bookmakerOdds)) {
        if (!bmOdds.bookmakerIsActive) continue;

        const market = bmOdds.markets[h2hMarketId];
        if (!market?.marketActive) continue;

        const outcomes: OddspapiOutcome[] = [];

        for (const outcomeData of Object.values(market.outcomes)) {
          const player = outcomeData.players?.['0'];
          if (!player || player.price == null) continue;

          const teamName = player.bookmakerOutcomeId === 'home' ? homeTeam : awayTeam;
          outcomes.push({ name: teamName, price: player.price });
        }

        if (outcomes.length === 2) {
          bookmakers.push({ key: bookmakerKey, title: bookmakerKey, outcomes });
        }
      }

      if (bookmakers.length === 0) continue;

      results.push({
        id: fixture.fixtureId,
        game: videogame,
        home_team: homeTeam,
        away_team: awayTeam,
        commence_time: fixture.startTime,
        bookmakers,
      });
    }

    this._logger.debug(
      { videogame, fixtures: fixtureMap.size, withOdds: results.length },
      'OddsPapi odds fetch complete',
    );

    return results;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async _request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this._config.baseUrl}${path}`);
    // Auth via query parameter (api.oddspapi.io v4 — not header-based)
    url.searchParams.set('apiKey', this._config.apiKey);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this._config.timeoutMs);

    try {
      this._logger.debug({ path: url.pathname, query: url.search.replace(this._config.apiKey, '***') }, 'Sending request to OddsPapi');

      const response = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        await this._handleErrorResponse(response, path);
      }

      const data: unknown = await response.json();

      this._logger.debug({ path: url.pathname, status: response.status }, 'Received response from OddsPapi');

      return data as T;
    } catch (error) {
      if (error instanceof ExternalApiError) throw error;

      if (error instanceof Error && error.name === 'AbortError') {
        throw new ExternalApiError(`Request to ${path} timed out after ${this._config.timeoutMs}ms`, {
          retryable: true,
          context: { api: 'oddspapi', endpoint: path, timeoutMs: this._config.timeoutMs },
        });
      }

      throw new ExternalApiError(`Request to ${path} failed: ${(error as Error).message}`, {
        retryable: true,
        cause: error instanceof Error ? error : undefined,
        context: { api: 'oddspapi', endpoint: path },
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async _handleErrorResponse(response: Response, path: string): Promise<never> {
    const statusCode = response.status;
    let errorBody: string | undefined;
    try { errorBody = await response.text(); } catch { /* ignore */ }

    const context: Record<string, unknown> = { api: 'oddspapi', endpoint: path, statusCode, errorBody };

    if (statusCode === 401 || statusCode === 403) {
      throw new AuthenticationError(`OddsPapi authentication failed (HTTP ${statusCode})`, { context });
    }

    if (statusCode === 429) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter !== null) context.retryAfterMs = parseInt(retryAfter, 10) * 1000;
      throw new RateLimitError(`OddsPapi rate limit exceeded (HTTP 429)`, { context });
    }

    throw new ExternalApiError(`OddsPapi returned HTTP ${statusCode} for ${path}`, {
      statusCode,
      retryable: statusCode >= 500,
      context,
    });
  }
}
