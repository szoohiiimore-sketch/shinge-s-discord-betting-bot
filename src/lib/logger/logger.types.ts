import type { Logger as PinoLogger } from 'pino';

/**
 * Application-level logger interface.
 *
 * Wraps pino's Logger type to provide a stable abstraction.
 * In V1, this is a direct alias to pino's Logger. If the logging
 * library changes in the future, only this type needs to change.
 */
export type Logger = PinoLogger;

/**
 * Log level configuration.
 *
 * Maps to pino's supported log levels.
 * In production, typically 'info' or 'warn'.
 * In development, typically 'debug'.
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Logger factory configuration.
 */
export interface LoggerConfig {
  /** Logger name (typically 'app' for root, module name for children) */
  name: string;
  /** Minimum log level */
  level: LogLevel;
  /** Whether to use human-readable output (development mode) */
  pretty: boolean;
}
