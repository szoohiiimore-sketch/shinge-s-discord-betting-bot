import { REST, Routes } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@/lib/logger';
import type { SettledOpportunityNotification } from '@/settlement';

export interface DiscordNotificationConfig {
  readonly token: string;
  readonly alertChannelId: string;
  /** Optional — if omitted, outcome and daily-summary notifications are silently skipped. */
  readonly outcomesChannelId?: string;
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

function formatAlert(opp: {
  sport: string;
  bookmaker: string;
  outcome: string;
  bookmakerOdds: unknown;
  fairOdds: unknown;
  edgePercentage: unknown;
  capturedAt: Date;
  match: {
    homeTeam: { name: string };
    awayTeam: { name: string };
  };
}): string {
  const lines = [
    '🎯 **VALUE BET DETECTED**',
    '',
    `**Sport:** ${displaySport(opp.sport)}`,
    `**Match:** ${opp.match.homeTeam.name} vs ${opp.match.awayTeam.name}`,
    '',
    `**Outcome:** ${opp.outcome}`,
    `**Bookmaker:** ${displayBookmaker(opp.bookmaker)}`,
    '',
    `**Odds:** ${displayOdds(opp.bookmakerOdds)}`,
    `**Fair Odds:** ${displayOdds(opp.fairOdds)}`,
    `**Edge:** ${displayEdge(opp.edgePercentage)}`,
    '',
    `**Captured:** ${displayTime(opp.capturedAt)}`,
  ];
  return lines.join('\n');
}

function formatOutcome(opp: SettledOpportunityNotification): string {
  const icon = opp.betResult === 'WIN' ? '✅' : opp.betResult === 'LOSS' ? '❌' : '⚪';
  const label = opp.betResult === 'WIN' ? 'WIN' : opp.betResult === 'LOSS' ? 'LOSS' : 'VOID';
  const lines = [
    `${icon} **${label}** — ${displaySport(opp.sport)} | ${opp.homeTeamName} vs ${opp.awayTeamName}`,
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
    this._logger = logger.child({ service: 'DiscordNotificationService' });
  }

  async notifyPendingOpportunities(): Promise<NotifyResult> {
    const pending = await this._prisma.valueOpportunity.findMany({
      where: { alertedAt: null },
      include: {
        match: {
          include: {
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    if (pending.length === 0) {
      return { notified: 0, failed: 0 };
    }

    this._logger.info({ count: pending.length }, 'Sending Discord alerts for pending opportunities');

    let notified = 0;
    let failed = 0;

    for (const opp of pending) {
      try {
        const content = formatAlert(opp);
        await this._rest.post(Routes.channelMessages(this._channelId), {
          body: { content },
        });
        await this._prisma.valueOpportunity.update({
          where: { id: opp.id },
          data: { alertedAt: new Date() },
        });
        notified++;
        this._logger.debug({ opportunityId: opp.id, outcome: opp.outcome }, 'Discord alert sent');
      } catch (err) {
        failed++;
        this._logger.error(
          { opportunityId: opp.id, err: (err as Error).message },
          'Discord alert failed — will retry on next run',
        );
      }
    }

    this._logger.info({ notified, failed }, 'Discord alert run complete');
    return { notified, failed };
  }

  async notifySettledOutcomes(settled: readonly SettledOpportunityNotification[]): Promise<void> {
    if (!this._outcomesChannelId || settled.length === 0) return;

    this._logger.info({ count: settled.length }, 'Sending settled outcome notifications');

    for (const opp of settled) {
      try {
        const content = formatOutcome(opp);
        await this._rest.post(Routes.channelMessages(this._outcomesChannelId), {
          body: { content },
        });
        this._logger.debug({ outcome: opp.outcome, result: opp.betResult }, 'Outcome notification sent');
      } catch (err) {
        this._logger.error(
          { outcome: opp.outcome, err: (err as Error).message },
          'Outcome notification failed',
        );
      }
    }
  }

  async notifyDailySummary(): Promise<void> {
    if (!this._outcomesChannelId) return;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const settled = await this._prisma.valueOpportunity.findMany({
      where: {
        settledAt: { gte: since },
        betResult: { not: null },
      },
      select: {
        betResult: true,
        profitLossUnits: true,
      },
    });

    if (settled.length === 0) {
      this._logger.info('No settled bets in last 24h — skipping daily summary');
      return;
    }

    let wins = 0;
    let losses = 0;
    let voids = 0;
    let totalPL = 0;

    for (const opp of settled) {
      const pl = opp.profitLossUnits
        ? (typeof opp.profitLossUnits === 'object' && 'toNumber' in opp.profitLossUnits
            ? (opp.profitLossUnits as { toNumber(): number }).toNumber()
            : Number(opp.profitLossUnits))
        : 0;
      totalPL += pl;

      if (opp.betResult === 'WIN') wins++;
      else if (opp.betResult === 'LOSS') losses++;
      else voids++;
    }

    const decidedBets = wins + losses;
    const winRate = decidedBets > 0 ? (wins / decidedBets) * 100 : 0;
    const roi = decidedBets > 0 ? (totalPL / decidedBets) * 100 : 0;

    const today = new Date().toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });

    const lines = [
      `📊 **DAILY SUMMARY** — ${today}`,
      '',
      `Settled Bets: **${settled.length}**`,
      `Wins: **${wins}** | Losses: **${losses}** | Void: **${voids}**`,
      `Win Rate: **${winRate.toFixed(1)}%**`,
      `Profit: **${displayPL(totalPL)}** | ROI: **${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%**`,
    ];

    try {
      await this._rest.post(Routes.channelMessages(this._outcomesChannelId), {
        body: { content: lines.join('\n') },
      });
      this._logger.info({ wins, losses, voids, totalPL: totalPL.toFixed(2) }, 'Daily summary sent');
    } catch (err) {
      this._logger.error({ err: (err as Error).message }, 'Daily summary notification failed');
    }
  }
}
