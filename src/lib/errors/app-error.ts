/**
 * Base application error class.
 *
 * All application errors extend this class, providing:
 * - Machine-readable error codes
 * - HTTP-like status codes for logging
 * - Retryable flag for BullMQ job retry decisions
 * - Cause chain for debugging
 * - Context object for structured logging
 *
 * Errors are immutable after construction.
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly cause: Error | undefined;
  public readonly context: Record<string, unknown>;

  constructor(options: AppErrorOptions) {
    super(options.message);

    this.name = this.constructor.name;
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
    this.context = Object.freeze({ ...options.context });

    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);

    // Capture stack trace, excluding constructor
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }

    // Freeze the instance to enforce immutability
    Object.freeze(this);
  }
}

export interface AppErrorOptions {
  /** Human-readable error description */
  message: string;
  /** Machine-readable error code (e.g., 'RATE_LIMIT_EXCEEDED') */
  code: string;
  /** HTTP-like status code for logging and health check (default: 500) */
  statusCode?: number;
  /** Whether the operation can be retried (default: false) */
  retryable?: boolean;
  /** The original error, if wrapping another error */
  cause?: Error;
  /** Additional structured context for logging */
  context?: Record<string, unknown>;
}
