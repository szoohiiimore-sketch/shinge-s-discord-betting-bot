import { z } from 'zod';
import type { RedisConfig } from './config.types';

const schema = z
  .object({
    REDIS_URL: z
      .string()
      .min(1, 'REDIS_URL is required'),
  })
  .transform((env) => ({
    url: env.REDIS_URL,
  }));

export function loadRedisConfig(env: Record<string, string | undefined>): RedisConfig {
  const result = schema.safeParse(env);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');

    throw new Error(`Redis configuration validation failed:\n${missing}`);
  }

  return result.data;
}
