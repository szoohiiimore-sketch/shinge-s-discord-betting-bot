import pino from 'pino';
import type { Logger, LoggerConfig } from './logger.types';

/**
 * Secret keys that must be redacted from all log output.
 *
 * These match environment variable names and any object paths
 * that may contain sensitive values. The redaction is case-sensitive
 * and matches the full path.
 */
const REDACTED_PATHS = [
  'DISCORD_TOKEN',
  'THE_ODDS_API_KEY',
  'PANDASCORE_API_KEY',
  'DEEPSEEK_API_KEY',
  // Wildcard patterns for nested objects
  '*.DISCORD_TOKEN',
  '*.THE_ODDS_API_KEY',
  '*.PANDASCORE_API_KEY',
  '*.DEEPSEEK_API_KEY',
];

/**
 * Creates a root logger instance.
 *
 * Called exactly once during application startup (in main.ts).
 * The root logger is passed to the Application class, which creates
 * child loggers for each component.
 *
 * @param config - Logger configuration (name, level, pretty mode)
 * @returns A configured pino Logger instance
 */
export function createLogger(config: LoggerConfig): Logger {
  const pinoOptions: pino.LoggerOptions = {
    name: config.name,
    level: config.level,
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    serializers: {
      err: (err: unknown): unknown => {
        if (err == null || typeof err !== 'object') return err;
        try {
          return pino.stdSerializers.err(err as Error);
        } catch {
          const e = err as Error;
          return {
            type: e.constructor?.name ?? 'Error',
            message: typeof e.message === 'string' ? e.message : String(e),
            name: e.name,
            stack: e.stack,
          };
        }
      },
    },
    base: undefined, // Omit pid, hostname from all logs
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (config.pretty) {
    // Development mode: human-readable output via pino-pretty
    return pino({
      ...pinoOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  // Production mode: raw JSON output (no transport)
  return pino(pinoOptions);
}

/**
 * Creates a child logger for a sub-module.
 *
 * Each service or component creates its own child logger with a
 * `module` property for identifying log sources.
 *
 * @param parent - The parent logger (typically the root logger or another child)
 * @param moduleName - The name of the module (e.g., 'match-service', 'prisma')
 * @returns A child Logger instance with module context
 *
 * @example
 * const matchLogger = createChildLogger(rootLogger, 'match-service');
 * matchLogger.info({ matchId: 'abc' }, 'Match fetched successfully');
 * // Output includes: { "module": "match-service", "matchId": "abc" }
 */
export function createChildLogger(parent: Logger, moduleName: string): Logger {
  return parent.child({ module: moduleName });
}
