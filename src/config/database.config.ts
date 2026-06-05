import { z } from 'zod';
import type { DatabaseConfig } from './config.types';

const schema = z
  .object({
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required'),
    DIRECT_DATABASE_URL: z
      .string()
      .min(1, 'DIRECT_DATABASE_URL is required'),
  })
  .transform((env) => ({
    url: env.DATABASE_URL,
    directUrl: env.DIRECT_DATABASE_URL,
  }));

export function loadDatabaseConfig(env: Record<string, string | undefined>): DatabaseConfig {
  const result = schema.safeParse(env);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');

    throw new Error(`Database configuration validation failed:\n${missing}`);
  }

  return result.data;
}
