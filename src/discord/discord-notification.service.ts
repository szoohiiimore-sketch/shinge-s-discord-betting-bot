import { REST, Routes } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import type { SettledOpportunityNotification } from '@/settlement';
import {
  groupIdeas,
  selectHeadline,
  isExchange,
  bookmakerFamily,
  corroborationCount,
  aggregateSettledIdeas,
  oddsToNumber,
  alertConfidenceFlags,
} from '@/value-detection';
import { LIVE_BASELINE } from './reporting-config';

export interface DiscordNotificationConfig {
  readonly token: string;
  readonly alertChannelId: string;
  /** Optional — if omitted, outcome and daily-summary notifications are silently skipped. */
  readonly outcomesChannelId?: string;
  /**
   * #bet-alert-lower-odds — LOW ODDS track alerts route ONLY here, never to the
   * main alert channel. If omitted, low-odds rows are stamped without alerting
   * (storage/settlement/ROI continue) and a warning is logged.
   */
  readonly lowOddsChannelId?: string;
}

export interface NotifyResult {
  readonly notified: number;
  readonly failed: number;
}

const SPORT_DISPLAY: Record<string, string> = {
  cs2: 'CS2',
  dota2: 'Dota 2',
  lol: 'League of Legends',
  valorant: 'Valorant',
  tennis: 'Tennis',
  soccer: 'Soccer',
  basketball: 'Basketball',
  baseball: 'Baseball',
  'ice-hockey': 'Ice Hockey',
  hockey: 'Ice Hockey',
};

function displaySport(slug: string): string {
  return SPORT_DISPLAY[slug] ?? slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function displayOdds(raw: unknown): string {
  const n = typeof raw === 'object' && raw !== null && 'toNumber' in raw
    ? (raw as { toNumber(): number }).toNumber()
    : Number(raw);
  return n.toFixed(2);
}

function displayEdge(raw: unknown): string {
  const n = typeof raw === 'object' && raw !== null && 'toNumber' in raw
    ? (raw as { toNumber(): number }).toNumber()
    : Number(raw);
  return `+${n.toFixed(1)}%`;
}

function displayTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function displayBookmaker(key: string): string {
  const KNOWN: Record<string, string> = {
    pinnacle: 'Pinnacle',
    bet365: 'Bet365',
    unibet: 'Unibet',
    '1xbet': '1xBet',
    betway: 'Betway',
  };
  return KNOWN[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function displayPL(units: number): string {
  return units >= 0 ? `+${units.toFixed(2)}u` : `${units.toFixed(2)}u`;
}

const SPORT_EMOJI: Record<string, string> = {
  soccer: '⚽',
  basketball: '🏀',
  baseball: '⚾',
  'ice-hockey': '🏒',
  hockey: '🏒',
  tennis: '🎾',
  football: '🏈',
};

/** Visible model attribution shown directly under every alert title. */
const MODEL_TAG: Record<string, string> = {
  LEGACY: '(LEGACY SYSTEM)',
  PINNACLE_LED: '(EXPERIMENTAL PINNACLE-LED SYSTEM)',
  LOW_ODDS_LEGACY: '(LOW ODDS LEGACY SYSTEM)',
  LOW_ODDS_PINNACLE_LED: '(LOW ODDS EXPERIMENTAL PINNACLE-LED SYSTEM)',
  SHARP_FINAL: '(SHARP FINAL — MULTI-SOURCE CONSENSUS)',
  SHARP_FINAL_LOW: '(SHARP FINAL LOW ODDS)',
};

/** LOW ODDS tracks route to the dedicated channel, never the main one. */
function isLowOddsModel(model: string): boolean {
  return model === 'LOW_ODDS_LEGACY' || model === 'LOW_ODDS_PINNACLE_LED';
}

/** One pending ValueOpportunity row with its match relation, as loaded for alerting. */
export interface PendingAlertRow {
  readonly id: string;
  readonly model: string;
  readonly matchId: string;
  readonly sport: string;
  readonly bookmaker: string;
  readonly outcome: string;
  readonly bookmakerOdds: unknown;
  readonly fairOdds: unknown;
  readonly edgePercentage: unknown;
  readonly pinnacleMove6h: unknown;
  readonly confidence?: string | null;
  readonly createdAt: Date;
  readonly match: {
    startTime: Date;
    league?: { name: string } | null;
    homeTeam: { name: string };
    awayTeam: { name: string };
  };
}

function toEdgeNumber(v: unknown): number {
  return oddsToNumber(v);
}

function movementSuffix(move6h: unknown): string {
  if (move6h === null || move6h === undefined) return '';
  const m = oddsToNumber(move6h);
  const direction = m < -1 ? 'moving toward outcome' : m > 1 ? 'moving away from outcome' : 'stable';
  return ` | Pinnacle 6h: ${m >= 0 ? '+' : ''}${m.toFixed(1)}% (${direction})`;
}

/**
 * Formats one idea-level alert: best non-exchange bookmaker headlined,
 * family-collapsed alternatives listed, corroboration count + movement shown.
 * Returns null when the idea has no non-exchange member (exchange-only ideas
 * are stamped silently and never alerted).
 */
export function formatIdeaAlert(members: readonly PendingAlertRow[]): string | null {
  const nonExchange = members.filter(m => !isExchange(m.bookmaker));
  if (nonExchange.length === 0) return null;

  const headline = selectHeadline(nonExchange)!;

  // Alternatives: best skin per family among non-exchange members, headline's family excluded.
  const bestPerFamily = new Map<string, PendingAlertRow>();
  for (const m of nonExchange) {
    const family = bookmakerFamily(m.bookmaker);
    const current = bestPerFamily.get(family);
    if (!current || oddsToNumber(m.bookmakerOdds) > oddsToNumber(current.bookmakerOdds)) {
      bestPerFamily.set(family, m);
    }
  }
  bestPerFamily.delete(bookmakerFamily(headline.bookmaker));
  const alternatives = [...bestPerFamily.values()]
    .sort((a, b) => oddsToNumber(b.bookmakerOdds) - oddsToNumber(a.bookmakerOdds))
    .slice(0, 6);

  const localStart = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Budapest', hour12: false,
  }).format(headline.match.startTime).replace(',', '');

  const emoji = SPORT_EMOJI[headline.sport] ?? '🏟️';
  const league = headline.match.league?.name ? ` | ${headline.match.league.name}` : '';
  const k = corroborationCount(members);

  const lines = [
    `🎯 **VALUE BET — ${headline.outcome}**`,
    `**${MODEL_TAG[headline.model] ?? `(${headline.model})`}**`,
    `${emoji} ${displaySport(headline.sport)} | ${headline.match.homeTeam.name} vs ${headline.match.awayTeam.name}${league}`,
    `🕐 ${displayTime(headline.match.startTime)} (${localStart} Budapest)`,
    '',
    `💰 **Best:** ${displayOdds(headline.bookmakerOdds)} @ ${displayBookmaker(headline.bookmaker)}  (edge ${displayEdge(headline.edgePercentage)}, fair ${displayOdds(headline.fairOdds)})`,
  ];

  if (alternatives.length > 0) {
    const alts = alternatives
      .map(a => `${displayOdds(a.bookmakerOdds)} @ ${displayBookmaker(a.bookmaker)} (${displayEdge(a.edgePercentage)})`)
      .join(' · ');
    lines.push(`📋 **Also:** ${alts}`);
  }

  lines.push(
    '',
    `📊 Books agreeing: ${k} ${k === 1 ? 'family' : 'families'}${movementSuffix(headline.pinnacleMove6h)}`,
  );

  // Quality grade — realized-outcome based (6h line movement + odds range), all
  // models. Ranking/presentation only; never affects detection or thresholds.
  // A = no red flags · B = one · C = two (flat line and/or extreme odds).
  if (headline.confidence) {
    const move6h = headline.pinnacleMove6h == null ? null : oddsToNumber(headline.pinnacleMove6h);
    const flags = alertConfidenceFlags({ bookmakerOdds: oddsToNumber(headline.bookmakerOdds), move6hPct: move6h });
    const meaning = flags.length === 0
      ? 'no red flags'
      : `red flag${flags.length > 1 ? 's' : ''}: ${flags.join(', ')}`;
    lines.push(`🏅 Quality: **${headline.confidence}** — ${meaning}`);
  }

  return lines.join('\n');
}

/** Minimum improvement over the alerted best price to justify an upgrade message. */
const UPGRADE_ODDS_RATIO = 1.02;
const UPGRADE_EDGE_DELTA_PP = 1.5;

/**
 * Builds an upgrade message for an already-alerted idea, or null when the new
 * rows don't improve materially on what was alerted (silent stamp).
 */
function formatUpgradeAlert(
  members: readonly PendingAlertRow[],
  alerted: ReadonlyArray<{ bookmaker: string; bookmakerOdds: unknown; edgePercentage: unknown }>,
): string | null {
  const nonExchange = members.filter(m => !isExchange(m.bookmaker));
  if (nonExchange.length === 0) return null;

  const newHeadline = selectHeadline(nonExchange)!;
  const newOdds = oddsToNumber(newHeadline.bookmakerOdds);
  const newEdge = toEdgeNumber(newHeadline.edgePercentage);

  const alertedNonExchange = alerted.filter(a => !isExchange(a.bookmaker));
  const baseline = alertedNonExchange.length > 0 ? alertedNonExchange : alerted;
  const prevBestOdds = Math.max(...baseline.map(a => oddsToNumber(a.bookmakerOdds)));
  const prevBestEdge = Math.max(...baseline.map(a => toEdgeNumber(a.edgePercentage)));

  const materiallyBetter =
    newOdds >= prevBestOdds * UPGRADE_ODDS_RATIO || newEdge >= prevBestEdge + UPGRADE_EDGE_DELTA_PP;
  if (!materiallyBetter) return null;

  return [
    `⬆️ **VALUE BET UPGRADE — ${newHeadline.outcome}**`,
    `**${MODEL_TAG[newHeadline.model] ?? `(${newHeadline.model})`}**`,
    `${newHeadline.match.homeTeam.name} vs ${newHeadline.match.awayTeam.name}`,
    `💰 New best: ${displayOdds(newHeadline.bookmakerOdds)} @ ${displayBookmaker(newHeadline.bookmaker)} (edge ${displayEdge(newHeadline.edgePercentage)}) — previous best ${prevBestOdds.toFixed(2)}`,
  ].join('\n');
}

function formatOutcome(opp: SettledOpportunityNotification): string {
  const icon = opp.betResult === 'WIN' ? '✅' : opp.betResult === 'LOSS' ? '❌' : '⚪';
  const label = opp.betResult === 'WIN' ? 'WIN' : opp.betResult === 'LOSS' ? 'LOSS' : 'VOID';
  const lines = [
    `${icon} **${label}** — ${displaySport(opp.sport)} | ${opp.homeTeamName} vs ${opp.awayTeamName}`,
    `**${MODEL_TAG[opp.model] ?? `(${opp.model})`}**`,
    `Outcome: ${opp.outcome} | Odds: ${opp.bookmakerOdds.toFixed(2)} | Edge: +${opp.edgePercentage.toFixed(1)}% | P/L: ${displayPL(opp.profitLossUnits)}`,
    `Settled: ${displayTime(opp.settledAt)}`,
  ];
  return lines.join('\n');
}

export class DiscordNotificationService {
  private readonly _prisma: PrismaClient;
  private readonly _rest: REST;
  private readonly _channelId: string;
  private readonly _outcomesChannelId: string | undefined;
  private readonly _lowOddsChannelId: string | undefined;
  private readonly _logger: Logger;

  constructor(
    prisma: PrismaClient,
    config: DiscordNotificationConfig,
    logger: Logger,
  ) {
    this._prisma = prisma;
    this._rest = new REST({ version: '10' }).setToken(config.token);
    this._channelId = config.alertChannelId;
    this._outcomesChannelId = config.outcomesChannelId;
    this._lowOddsChannelId = config.lowOddsChannelId;
    this._logger = logger.child({ service: 'DiscordNotificationService' });
  }

  /**
   * Idea-level alerting: pending production rows are grouped into betting ideas
   * (matchId, outcome); one Discord message is sent per idea — best non-exchange
   * bookmaker headlined, alternatives listed. All member rows are stamped
   * `alertedAt` together ("consumed by the alert layer"). Ideas that were already
   * alerted get no second message unless the upgrade rule fires; exchange-only
   * ideas are stamped silently and never alerted.
   */
  async notifyPendingOpportunities(): Promise<NotifyResult> {
    const pending = await this._prisma.valueOpportunity.findMany({
      where: { alertedAt: null, isShadow: false, match: { sport: { category: 'TRADITIONAL' as const } } },
      include: {
        match: {
          include: {
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
            league: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    if (pending.length === 0) {
      return { notified: 0, failed: 0 };
    }

    // Dual-model A/B: ideas must NEVER merge across models — the same
    // (match, outcome) can legitimately be alerted once per model, each tagged.
    const ideasByModel = new Map<string, ReturnType<typeof groupIdeas<(typeof pending)[number]>>>();
    for (const model of new Set(pending.map(p => p.model))) {
      ideasByModel.set(model, groupIdeas(pending.filter(p => p.model === model)));
    }

    // Already-alerted sibling rows of the same ideas — detect re-alerts and upgrade baselines.
    const alertedSiblings = await this._prisma.valueOpportunity.findMany({
      where: {
        matchId: { in: [...new Set(pending.map(p => p.matchId))] },
        alertedAt: { not: null },
        isShadow: false,
      },
      select: {
        matchId: true,
        outcome: true,
        bookmaker: true,
        bookmakerOdds: true,
        edgePercentage: true,
        createdAt: true,
        model: true,
      },
    });

    const totalIdeas = [...ideasByModel.values()].reduce((s, m) => s + m.size, 0);
    this._logger.info(
      { pendingRows: pending.length, ideas: totalIdeas, models: [...ideasByModel.keys()] },
      'Sending idea-level Discord alerts for pending opportunities',
    );

    let notified = 0;
    let failed = 0;

    for (const [model, ideas] of ideasByModel) {
      const alertedByIdea = groupIdeas(alertedSiblings.filter(s => s.model === model));
      for (const [key, members] of ideas) {
        const alerted = alertedByIdea.get(key) ?? [];
        try {
          let content = alerted.length > 0
            ? formatUpgradeAlert(members, alerted)
            : formatIdeaAlert(members);

          // Channel routing: LOW ODDS tracks go ONLY to #bet-alert-lower-odds.
          let channelId = this._channelId;
          if (isLowOddsModel(model)) {
            if (this._lowOddsChannelId) {
              channelId = this._lowOddsChannelId;
            } else {
              if (content) this._logger.warn({ idea: key, model }, 'Low-odds alert dropped — LOW_ODDS_ALERT_CHANNEL_ID not configured (row stamped, accounting unaffected)');
              content = null; // stamp silently; never leak into the main channel
            }
          }

          if (content) {
            await this._rest.post(Routes.channelMessages(channelId), {
              body: { content },
            });
            notified++;
            this._logger.debug(
              { idea: key, model, rows: members.length, upgrade: alerted.length > 0 },
              'Idea-level Discord alert sent',
            );
          } else {
            this._logger.debug(
              { idea: key, model, rows: members.length, reason: alerted.length > 0 ? 'no material upgrade' : 'exchange-only idea' },
              'Idea stamped without alert',
            );
          }

          // Stamp every member row in one update — rows are consumed by the idea alert.
          await this._prisma.valueOpportunity.updateMany({
            where: { id: { in: members.map(m => m.id) } },
            data: { alertedAt: new Date() },
          });
        } catch (err) {
          failed++;
          this._logger.error(
            { idea: key, model, err: (err as Error).message },
            'Idea-level Discord alert failed — will retry on next run',
          );
        }
      }
    }

    this._logger.info({ notified, failed, ideas: totalIdeas }, 'Discord alert run complete');
    return { notified, failed };
  }

  async notifySettledOutcomes(settled: readonly SettledOpportunityNotification[]): Promise<void> {
    if (!this._outcomesChannelId || settled.length === 0) return;

    // Idea-level: a settled idea is (model, matchId, outcome). The settlement
    // pipeline emits one row per bookmaker/capture, so multiple rows can describe
    // the SAME idea (same match result → identical WIN/LOSS). Collapse them to one
    // card per idea — scored on the headline row (best non-exchange price) — using
    // the same aggregation the daily summary and /roi already use. Models are NEVER
    // merged: (match, outcome) under LEGACY and under PINNACLE_LED stay two ideas.
    type Member = SettledOpportunityNotification & { createdAt: Date };
    const members: Member[] = settled.map(s => ({ ...s, createdAt: s.settledAt }));

    const ideas: Member[] = [];
    for (const model of new Set(members.map(m => m.model))) {
      for (const group of groupIdeas(members.filter(m => m.model === model)).values()) {
        const headline = selectHeadline(group);
        if (headline) ideas.push(headline);
      }
    }

    this._logger.info(
      { rows: settled.length, ideas: ideas.length },
      'Sending idea-level settled outcome notifications',
    );

    for (const idea of ideas) {
      try {
        const content = formatOutcome(idea);
        await this._rest.post(Routes.channelMessages(this._outcomesChannelId), {
          body: { content },
        });
        this._logger.debug({ model: idea.model, outcome: idea.outcome, result: idea.betResult }, 'Outcome notification sent');
      } catch (err) {
        this._logger.error(
          { model: idea.model, outcome: idea.outcome, err: (err as Error).message },
          'Outcome notification failed',
        );
      }
    }
  }

  async notifyDailySummary(): Promise<void> {
    if (!this._outcomesChannelId) return;

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Live metrics never look before the live baseline
    const since = since24h > LIVE_BASELINE ? since24h : LIVE_BASELINE;

    const settledRows = await this._prisma.valueOpportunity.findMany({
      where: {
        settledAt: { gte: since },
        betResult: { not: null },
        isShadow: false,
        match: { sport: { category: 'TRADITIONAL' as const } },
      },
      select: {
        matchId: true,
        outcome: true,
        bookmaker: true,
        bookmakerOdds: true,
        createdAt: true,
        betResult: true,
        profitLossUnits: true,
        clvPercentage: true,
        clvPositive: true,
        model: true,
      },
    });

    if (settledRows.length === 0) {
      this._logger.info('No settled bets in last 24h — skipping daily summary');
      return;
    }

    const today = new Date().toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    const lines = [`📊 **DAILY SUMMARY** — ${today}`];
    let totalIdeas = 0;

    // Per-model sections — idea-level accounting is computed strictly within a
    // model (ideas never merge across models in the dual-model A/B).
    for (const model of ['PINNACLE_LED', 'LEGACY', 'LOW_ODDS_PINNACLE_LED', 'LOW_ODDS_LEGACY', 'SHARP_FINAL', 'SHARP_FINAL_LOW'] as const) {
      const modelRows = settledRows.filter(r => r.model === model);
      if (modelRows.length === 0) continue;
      const ideas = aggregateSettledIdeas(modelRows).map(i => i.headline);
      totalIdeas += ideas.length;

      let wins = 0;
      let losses = 0;
      let voids = 0;
      let totalPL = 0;
      for (const idea of ideas) {
        totalPL += idea.profitLossUnits ? oddsToNumber(idea.profitLossUnits) : 0;
        if (idea.betResult === 'WIN') wins++;
        else if (idea.betResult === 'LOSS') losses++;
        else voids++;
      }
      const decidedBets = wins + losses;
      const winRate = decidedBets > 0 ? (wins / decidedBets) * 100 : 0;
      const roi = decidedBets > 0 ? (totalPL / decidedBets) * 100 : 0;

      lines.push(
        '',
        `**${MODEL_TAG[model]}**`,
        `Settled Ideas: **${ideas.length}** (from ${modelRows.length} bookmaker rows)`,
        `Wins: **${wins}** | Losses: **${losses}** | Void: **${voids}** | Win Rate: **${winRate.toFixed(1)}%**`,
        `Profit: **${displayPL(totalPL)}** | ROI: **${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%**`,
      );

      // CLV — headline-row CLV per idea, only when at least one idea has CLV data.
      const clvValues = ideas
        .filter(i => i.clvPercentage !== null)
        .map(i => oddsToNumber(i.clvPercentage))
        .sort((a, b) => a - b);
      if (clvValues.length > 0) {
        const clvAvg = clvValues.reduce((a, b) => a + b, 0) / clvValues.length;
        const mid = Math.floor(clvValues.length / 2);
        const clvMedian = clvValues.length % 2 === 0
          ? (clvValues[mid - 1] + clvValues[mid]) / 2
          : clvValues[mid];
        const clvPositive = ideas.filter(i => i.clvPositive === true).length;
        const sign = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
        lines.push(
          `📈 CLV (ideas, vs Pinnacle close): avg **${sign(clvAvg)}** | median **${sign(clvMedian)}** | positive **${((clvPositive / clvValues.length) * 100).toFixed(0)}%** (n=${clvValues.length})`,
        );
      }
    }

    try {
      await this._rest.post(Routes.channelMessages(this._outcomesChannelId), {
        body: { content: lines.join('\n') },
      });
      this._logger.info({ ideas: totalIdeas, rows: settledRows.length }, 'Daily summary sent');
    } catch (err) {
      this._logger.error({ err: (err as Error).message }, 'Daily summary notification failed');
    }
  }
}
