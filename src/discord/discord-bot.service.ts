import { Client, GatewayIntentBits, Events, REST, Routes, ActivityType } from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from '@/lib/logger';
import type { QueueCollection } from '@/lib/queue/queue-types';
import { getTopValueBets } from './commands/test-value-bets';
import { getBotStatus } from './commands/bot-status';
import { executeForceScan } from './commands/force-scan';
import { executeForceIngestion } from './commands/force-ingestion';
import { getRoiStats } from './commands/roi';
import { getPaperBankroll } from './commands/paper-bankroll';
import { getBestSports } from './commands/best-sports';
import { getValueBets } from './commands/value-bets';
import type { ValueDetectionService } from '@/value-detection';
import type { Queue as BullmqQueue } from 'bullmq';

const SLASH_COMMANDS = [
  { name: 'test-value-bets', description: 'Show top 5 value bets by edge' },
  { name: 'bot-status', description: 'Display infrastructure health' },
  { name: 'force-scan', description: 'Trigger manual value detection on recent matches' },
  {
    name: 'force-ingestion',
    description: 'Trigger real API fetch → odds snapshots → value detection',
    options: [
      {
        type: 3,
        name: 'source',
        description: 'What to ingest: traditional, esports, or all',
        required: true,
        choices: [
          { name: 'Traditional Sports', value: 'traditional' },
          { name: 'Esports', value: 'esports' },
          { name: 'All', value: 'all' },
        ],
      },
      {
        type: 3,
        name: 'sport-key',
        description: 'Optional: specific sport key (e.g. basketball_nba)',
        required: false,
      },
    ],
  },
  {
    name: 'roi',
    description: 'Show paper trading ROI and win rate',
    options: [
      {
        type: 3,
        name: 'period',
        description: 'Time period: 7d, 30d, or all',
        required: false,
        choices: [
          { name: 'Last 7 Days', value: '7d' },
          { name: 'Last 30 Days', value: '30d' },
          { name: 'All Time', value: 'all' },
        ],
      },
    ],
  },
  { name: 'paper-bankroll', description: 'Show paper trading bankroll (starting: 1000 units)' },
  { name: 'best-sports', description: 'Show ROI and win rate by sport' },
  {
    name: 'value-bets',
    description: 'Show value opportunities from the database (newest first)',
    options: [
      {
        type: 3,
        name: 'status',
        description: 'Filter by alert status',
        required: false,
        choices: [
          { name: 'All', value: 'all' },
          { name: 'Open (not yet alerted)', value: 'open' },
          { name: 'Alerted', value: 'alerted' },
        ],
      },
      {
        type: 3,
        name: 'sport',
        description: 'Optional: filter by sport slug (e.g. cs2, basketball_nba)',
        required: false,
      },
    ],
  },
];

export interface DiscordBotConfig {
  readonly token: string;
  readonly clientId: string;
  readonly guildId: string;
}

export class DiscordBotService {
  private readonly _client: Client;
  private readonly _prisma: PrismaClient;
  private readonly _redis: Redis;
  private readonly _queues: QueueCollection;
  private readonly _valueDetectionService: ValueDetectionService;
  private readonly _matchFetchQueue: BullmqQueue;
  private readonly _logger: Logger;
  private readonly _config: DiscordBotConfig;

  constructor(
    config: DiscordBotConfig,
    prisma: PrismaClient,
    redis: Redis,
    queues: QueueCollection,
    valueDetectionService: ValueDetectionService,
    matchFetchQueue: BullmqQueue,
    logger: Logger,
  ) {
    this._config = config;
    this._prisma = prisma;
    this._redis = redis;
    this._queues = queues;
    this._valueDetectionService = valueDetectionService;
    this._matchFetchQueue = matchFetchQueue;
    this._logger = logger.child({ service: 'DiscordBotService' });

    this._client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    this._registerHandlers();
  }

  private _registerHandlers(): void {
    this._client.on(Events.ClientReady, async () => {
      this._logger.info('Discord bot logged in and ready');
      await this._updatePresence();
    });

    this._client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const member = interaction.guild?.members.cache.get(interaction.user.id);
      const isAdmin = member?.permissions.has('Administrator') ?? false;

      if (!isAdmin) {
        await interaction.reply({ content: 'This command is admin-only.', ephemeral: true });
        return;
      }

      try {
        await this._handleCommand(interaction);
      } catch (err) {
        this._logger.error({ err: (err as Error).message, command: interaction.commandName }, 'Command execution failed');
        // After deferReply(), only editReply() is valid. Using reply() would fail silently
        // and leave the interaction in "thinking" state for up to 15 minutes.
        await interaction.editReply({ content: `Error: ${(err as Error).message}` }).catch(() => {});
      }
    });
  }

  private async _handleCommand(interaction: any): Promise<void> {
    const { commandName } = interaction;

    if (commandName === 'test-value-bets') {
      const { content } = await getTopValueBets(this._prisma, this._logger);
      await interaction.reply({ content });
      return;
    }

    if (commandName === 'bot-status') {
      const content = await getBotStatus(this._prisma, this._redis, this._queues, this._logger);
      await interaction.reply({ content });
      return;
    }

    if (commandName === 'force-scan') {
      const recentMatches = await this._prisma.oddsSnapshot.findMany({
        select: { match: { select: { externalId: true } } },
        orderBy: { capturedAt: 'desc' },
        take: 50,
        distinct: ['matchId'],
      });

      const matchExternalIds = recentMatches.map(s => s.match.externalId);
      const { content } = await executeForceScan(this._valueDetectionService, matchExternalIds, this._logger);
      await interaction.reply({ content });
      return;
    }

    if (commandName === 'force-ingestion') {
      const source = interaction.options.getString('source', true);
      const sportKey = interaction.options.getString('sport-key');
      await interaction.deferReply();
      const { content } = await executeForceIngestion(
        this._matchFetchQueue,
        { source: source as 'traditional' | 'esports' | 'all', sportKey: sportKey ?? undefined },
        this._logger,
      );
      await interaction.editReply({ content });
      return;
    }

    if (commandName === 'roi') {
      const period = (interaction.options.getString('period') ?? 'all') as '7d' | '30d' | 'all';
      const { content } = await getRoiStats(this._prisma, period, this._logger);
      await interaction.reply({ content });
      return;
    }

    if (commandName === 'paper-bankroll') {
      const { content } = await getPaperBankroll(this._prisma, this._logger);
      await interaction.reply({ content });
      return;
    }

    if (commandName === 'best-sports') {
      const { content } = await getBestSports(this._prisma, this._logger);
      await interaction.reply({ content });
      return;
    }

    if (commandName === 'value-bets') {
      const status = (interaction.options.getString('status') ?? 'all') as 'open' | 'alerted' | 'all';
      const sport = interaction.options.getString('sport') ?? undefined;
      const { content } = await getValueBets(this._prisma, { status, sport }, this._logger);
      await interaction.reply({ content });
      return;
    }
  }

  async login(): Promise<void> {
    this._logger.info('Logging in to Discord');
    await this._client.login(this._config.token);

    this._logger.info({ count: SLASH_COMMANDS.length, guildId: this._config.guildId }, 'Registering slash commands');
    const rest = new REST({ version: '10' }).setToken(this._config.token);

    try {
      await rest.put(
        Routes.applicationGuildCommands(this._config.clientId, this._config.guildId),
        { body: SLASH_COMMANDS },
      );
      this._logger.info({ count: SLASH_COMMANDS.length }, 'Slash commands registered successfully');
    } catch (err) {
      this._logger.warn({ err: (err as Error).message }, 'Slash command registration failed — bot will still receive interactions if previously registered');
    }
  }

  async refreshPresence(): Promise<void> {
    await this._updatePresence();
  }

  private async _updatePresence(): Promise<void> {
    if (!this._client.user) {
      this._logger.warn('Discord client user not available — skipping presence update');
      return;
    }

    try {
      const settled = await this._prisma.valueOpportunity.findMany({
        where: { betResult: { not: null } },
        select: { betResult: true, profitLossUnits: true },
      });

      let wins = 0;
      let losses = 0;
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
      }

      const decidedBets = wins + losses;
      const roi = decidedBets > 0 ? (totalPL / decidedBets) * 100 : 0;
      const roiStr = roi > 0 ? `+${roi.toFixed(1)}%` : `${roi.toFixed(1)}%`;

      const sportCount = 54;

      this._client.user.setPresence({
        activities: [{
          name: `ROI: ${roiStr} | ${sportCount} Sports`,
          type: ActivityType.Watching,
        }],
      });

      this._logger.debug({ roi: roiStr, sportCount, wins, losses, totalPL: totalPL.toFixed(2) }, 'Presence updated');
    } catch (err) {
      this._logger.warn({ err: (err as Error).message }, 'Failed to update Discord presence');
    }
  }

  async destroy(): Promise<void> {
    this._logger.info('Destroying Discord bot');
    this._client.destroy();
  }
}