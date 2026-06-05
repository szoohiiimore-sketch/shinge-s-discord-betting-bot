import { z } from 'zod';
import type { AppConfig } from './config.types';

const schema = z
  .object({
    NODE_ENV: z
      .string()
      .min(1)
      .default('development'),
    LOG_LEVEL: z
      .string()
      .min(1)
      .default('info'),
    PORT: z
      .string()
      .default('3000')
      .pipe(
        z.coerce
          .number()
          .int('PORT must be an integer')
          .min(1, 'PORT must be >= 1')
          .max(65535, 'PORT must be <= 65535'),
      ),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
  }));

export function loadAppConfig(env: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(env);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');

    throw new Error(`App configuration validation failed:\n${missing}`);
  }

  return result.data;
}
