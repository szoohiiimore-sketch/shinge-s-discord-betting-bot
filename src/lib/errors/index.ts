export { AppError } from './app-error';
export type { AppErrorOptions } from './app-error';

export { ConfigError } from './config-error';
export type { ConfigErrorOptions } from './config-error';

export { DatabaseError } from './database-error';
export type { DatabaseErrorOptions } from './database-error';

export { RedisError } from './redis-error';
export type { RedisErrorOptions } from './redis-error';

export { QueueError } from './queue-error';
export type { QueueErrorOptions } from './queue-error';

export {
  ExternalApiError,
  RateLimitError,
  AuthenticationError,
} from './external-api-error';
export type {
  ExternalApiErrorOptions,
  RateLimitErrorOptions,
  AuthenticationErrorOptions,
} from './external-api-error';

export { ValidationError } from './validation-error';
export type { ValidationErrorOptions } from './validation-error';

export { NotFoundError } from './not-found-error';
export type { NotFoundErrorOptions } from './not-found-error';

export { BusinessRuleError } from './business-rule-error';
export type { BusinessRuleErrorOptions } from './business-rule-error';
