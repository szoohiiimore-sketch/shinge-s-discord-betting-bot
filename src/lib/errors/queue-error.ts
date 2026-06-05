import { AppError } from './app-error';

/**
 * BullMQ operation failure.
 *
 * Thrown when a queue operation fails (enqueue, worker processing,
 * queue configuration) due to Redis issues or BullMQ internal errors.
 *
 * @example
 * throw new QueueError('Failed to enqueue match-fetch job', {
 *   retryable: true,
 *   cause: err,
 *   context: { queue: 'match-fetch', jobType: 'fetch-traditional' }
 * });
 */
export class QueueError extends AppError {
  constructor(message: string, options: QueueErrorOptions = {}) {
    super({
      message,
      code: 'QUEUE_ERROR',
      statusCode: 500,
      retryable: options.retryable ?? false,
      cause: options.cause,
      context: options.context,
    });
  }
}

export interface QueueErrorOptions {
  retryable?: boolean;
  cause?: Error;
  context?: Record<string, unknown>;
}
