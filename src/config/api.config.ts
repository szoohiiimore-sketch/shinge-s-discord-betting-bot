import { z } from 'zod';
import type { ApiConfig } from './config.types';

const schema = z
  .object({
    THE_ODDS_API_KEY: z
      .string()
      .min(1, 'THE_ODDS_API_KEY is required'),
    PANDASCORE_API_KEY: z
      .string()
      .min(1, 'PANDASCORE_API_KEY is required'),
    DEEPSEEK_API_KEY: z
      .string()
      .min(1, 'DEEPSEEK_API_KEY is required'),
    ODDSPAPI_API_KEY: z
      .string()
      .min(1, 'ODDSPAPI_API_KEY is required'),
  })
  .transform((env) => ({
    theOddsApiKey: env.THE_ODDS_API_KEY,
    pandascoreApiKey: env.PANDASCORE_API_KEY,
    deepseekApiKey: env.DEEPSEEK_API_KEY,
    oddsPapiApiKey: env.ODDSPAPI_API_KEY,
  }));

export function loadApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const result = schema.safeParse(env);

  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');

    throw new Error(`API configuration validation failed:\n${missing}`);
  }

  return result.data;
}
