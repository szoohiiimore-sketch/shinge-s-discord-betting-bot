import type { Config } from './config.types';
import { loadAppConfig } from './app.config';
import { loadDatabaseConfig } from './database.config';
import { loadRedisConfig } from './redis.config';
import { loadDiscordConfig } from './discord.config';
import { loadApiConfig } from './api.config';
import { loadBettingConfig } from './betting.config';

/**
 * Loads and validates all configuration from environment variables.
 *
 * - Called exactly once during startup (in main.ts).
 * - Validates every required variable with zod schemas.
 * - Throws immediately on first validation failure (fail fast).
 * - Returns a deeply frozen, immutable Config object.
 *
 * @param env - The environment variables object (typically process.env).
 * @returns A frozen, validated Config object.
 * @throws {Error} If any configuration section fails validation.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const config: Config = {
    app: loadAppConfig(env),
    database: loadDatabaseConfig(env),
    redis: loadRedisConfig(env),
    discord: loadDiscordConfig(env),
    api: loadApiConfig(env),
    betting: loadBettingConfig(env),
  };

  return deepFreeze(config);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepFreeze<T extends Record<string, any>>(obj: T): T {
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return Object.freeze(obj);
}
