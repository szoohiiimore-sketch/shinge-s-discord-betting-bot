import { z } from 'zod';
import type { DiscordConfig } from './config.types';

const schema = z
  .object({
    DISCORD_TOKEN: z
      .string()
      .min(1, 'DISCORD_TOKEN is required'),
    DISCORD_CLIENT_ID: z
      .string()
      .min(1, 'DISCORD_CLIENT_ID is required'),
    DISCORD_GUILD_ID: z
      .string()
      .min(1, 'DISCORD_GUILD_ID is required'),
    DISCORD_ALERT_CHANNEL_ID: z
      .string()
      .min(1, 'DISCORD_ALERT_CHANNEL_ID is required'),
    DISCORD_OUTCOMES_CHANNEL_ID: z.string().optional(),
  })
  .transform((env) => ({
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID,
    alertChannelId: env.DISCORD_ALERT_CHANNEL_ID,
    outcomesChannelId: env.DISCORD_OUTCOMES_CHANNEL_ID,
  }));

export function loadDiscordConfig(env: Record<string, string | undefined>): DiscordConfig {
  const result = schema.safeParse(env);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');

    throw new Error(`Discord configuration validation failed:\n${missing}`);
  }

  return result.data;
}
