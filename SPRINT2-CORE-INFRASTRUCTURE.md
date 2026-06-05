# Betting Intelligence Discord Platform — Sprint 2: Core Infrastructure

> **Status:** Implementation Specification  
> **Version:** 1.0  
> **Last Updated:** 2026-06-05  
> **Prerequisites:** SPRINT1-FOUNDATION.md, schema.prisma  
> **Goal:** Build the backend foundation that every future feature will depend on

---

## Table of Contents

1. [Application Bootstrap Architecture](#1-application-bootstrap-architecture)
2. [Prisma Client Lifecycle Strategy](#2-prisma-client-lifecycle-strategy)
3. [Database Connection Strategy](#3-database-connection-strategy)
4. [Neon PostgreSQL Integration Strategy](#4-neon-postgresql-integration-strategy)
5. [Redis Connection Strategy](#5-redis-connection-strategy)
6. [BullMQ Architecture](#6-bullmq-architecture)
7. [Queue Definitions](#7-queue-definitions)
8. [Job Ownership Rules](#8-job-ownership-rules)
9. [Logger Integration Strategy](#9-logger-integration-strategy)
10. [Configuration Integration Strategy](#10-configuration-integration-strategy)
11. [Error Handling Architecture](#11-error-handling-architecture)
12. [Health Check Architecture](#12-health-check-architecture)
13. [Graceful Shutdown Architecture](#13-graceful-shutdown-architecture)
14. [Startup Sequence](#14-startup-sequence)
15. [Dependency Initialization Order](#15-dependency-initialization-order)
16. [Failure Recovery Strategy](#16-failure-recovery-strategy)
17. [Infrastructure Testing Strategy](#17-infrastructure-testing-strategy)

---

## 1. Application Bootstrap Architecture

### 1.1 Two-File Entry Point

The application uses two files for the entry point, separating concerns:

| File | Responsibility |
|---|---|
| `src/main.ts` | Process-level concerns: signal handling, process exit, top-level error catching |
| `src/app.ts` | Application-level concerns: dependency initialization, startup sequence, graceful shutdown |

**`main.ts` responsibilities:**
- Catch unhandled rejections and uncaught exceptions
- Load configuration
- Create the root logger
- Instantiate and start the `Application` class
- Handle `SIGTERM` and `SIGINT` signals
- Exit with appropriate code (0 for success, 1 for failure)

**`app.ts` responsibilities:**
- Define the `Application` class
- Initialize all dependencies in order
- Provide `start()` and `stop()` methods
- Track initialization state (not started, starting, running, stopping, stopped)
- Expose a health check status method

### 1.2 Application Class Design

```typescript
// Conceptual structure — not code

class Application {
  private state: AppState = 'not-started';
  private deps: Dependencies | null = null;

  async start(): Promise<void> {
    this.state = 'starting';
    this.deps = await initializeDependencies(config, logger);
    this.state = 'running';
  }

  async stop(): Promise<void> {
    this.state = 'stopping';
    await shutdownDependencies(this.deps);
    this.state = 'stopped';
  }

  getState(): AppState { return this.state; }
  isHealthy(): boolean { return this.state === 'running'; }
}
```

### 1.3 State Machine

```
NOT_STARTED → STARTING → RUNNING → STOPPING → STOPPED
                              ↘ FAILED
```

- `NOT_STARTED`: Application instantiated but not started
- `STARTING`: Dependencies being initialized
- `RUNNING`: All dependencies initialized, accepting work
- `STOPPING`: Graceful shutdown in progress
- `STOPPED`: All dependencies shut down
- `FAILED`: Irrecoverable error during startup

### 1.4 Dependency Container

No DI framework. Dependencies are initialized in order and passed explicitly. The `Dependencies` type is a plain interface containing all initialized services:

```typescript
interface Dependencies {
  prisma: PrismaClient;
  redis: Redis;
  queues: QueueRegistry;
  workers: WorkerRegistry;
  // Future: discord, services, etc.
}
```

Dependencies are initialized in `src/app.ts` using factory functions. Each factory function:
1. Accepts only what it needs (config, logger)
2. Returns the initialized dependency
3. Throws on failure (caught by the startup sequence)

---

## 2. Prisma Client Lifecycle Strategy

### 2.1 Single Instance

One `PrismaClient` instance for the entire application lifetime. Created during startup, destroyed during shutdown.

### 2.2 Initialization

```typescript
// Conceptual initialization
function createPrismaClient(config: DatabaseConfig, logger: Logger): PrismaClient {
  const client = new PrismaClient({
    datasources: {
      db: { url: config.url },
    },
    log: [
      { emit: 'event', level: 'query' },   // Only in development
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'info' },
      { emit: 'event', level: 'warn' },
    ],
  });

  // Wire Prisma logs to pino
  client.$on('error', (e) => logger.error({ err: e }, 'Prisma error'));
  client.$on('warn', (e) => logger.warn({ message: e.message }, 'Prisma warning'));
  client.$on('info', (e) => logger.info({ message: e.message }, 'Prisma info'));

  // Query logging only in development
  if (config.nodeEnv === 'development') {
    client.$on('query', (e) => logger.debug({ query: e.query, duration: e.duration }, 'Prisma query'));
  }

  return client;
}
```

### 2.3 Connection

Prisma Client connects lazily — the first query establishes the connection. Explicit `$connect()` is called during startup to verify the database is reachable before the application enters RUNNING state.

```typescript
await prisma.$connect();
logger.info('Database connected');
```

### 2.4 Disconnection

```typescript
await prisma.$disconnect();
logger.info('Database disconnected');
```

### 2.5 Middleware

No Prisma middleware in V1. All cross-cutting concerns (logging, error handling) are handled at the service layer.

### 2.6 Extensions

No Prisma Client extensions in V1. Keep it simple.

---

## 3. Database Connection Strategy

### 3.1 Connection String

The `DATABASE_URL` environment variable contains the full PostgreSQL connection string with connection pool configuration:

```
DATABASE_URL=postgresql://user:password@host:5432/db?connection_limit=10&pool_timeout=10&connect_timeout=10
```

### 3.2 Connection Pool

Prisma Client manages its own connection pool internally. The pool size is configured via the `connection_limit` query parameter in the connection string.

| Environment | Pool Size | Rationale |
|---|---|---|
| Development | 5 | Single developer, low concurrency |
| Production | 10 | BullMQ workers + Discord bot + health check |

### 3.3 Connection Timeout

- `connect_timeout=10`: Fail fast if database is unreachable
- `pool_timeout=10`: Fail fast if all connections are busy

### 3.4 Connection Verification

During startup, a simple query verifies the connection:

```typescript
await prisma.$queryRaw`SELECT 1`;
```

This is done after `$connect()` to confirm the database is accepting queries.

### 3.5 Connection Recovery

Prisma Client does not automatically reconnect. If the connection is lost:
1. The query will throw an error
2. The error propagates to the caller
3. The caller (service or job) handles the error
4. If the error is transient, the job retries via BullMQ
5. If the error is persistent, the application may need to restart

No automatic reconnection logic in V1. Keep it simple.

---

## 4. Neon PostgreSQL Integration Strategy

### 4.1 Neon-Specific Considerations

Neon is a serverless PostgreSQL provider with the following characteristics relevant to this project:

| Characteristic | Impact |
|---|---|
| **Connection pooling** | Neon uses PgBouncer for connection pooling. Must use pooled connection string. |
| **Cold starts** | Serverless compute may pause after inactivity. First query after idle period may be slow. |
| **Branching** | Use branches for development and testing environments. |
| **Autoscaling** | Compute resources scale automatically. No configuration needed. |

### 4.2 Connection String Format

Neon provides two connection string formats:

| Type | Format | Use Case |
|---|---|---|
| Direct | `postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/db` | Migrations, Prisma Studio |
| Pooled | `postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/db?pgbouncer=true&connection_limit=10` | Application runtime |

**The application MUST use the pooled connection string** to avoid connection exhaustion.

### 4.3 Pooled Mode Configuration

When using Neon's pooled mode with Prisma:

1. Append `?pgbouncer=true` to the connection string
2. Set `connection_limit` to match Neon's pool size (typically 10–20)
3. Set `pool_timeout=10` to fail fast if pool is exhausted
4. Disable `PREPARE` statements (PgBouncer in transaction mode does not support prepared statements across connections)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

With connection string:
```
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/db?pgbouncer=true&connection_limit=10&pool_timeout=10
```

### 4.4 Prepared Statement Handling

Prisma with Neon's PgBouncer requires disabling prepared statements. This is done by setting `?pgbouncer=true` in the connection string, which tells Prisma to disable prepared statements.

**Impact:** Slightly slower query execution (no query plan caching). Acceptable for V1.

### 4.5 Migration Connection String

Migrations use the direct (non-pooled) connection string. This is configured separately:

```bash
# .env
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/db?pgbouncer=true&connection_limit=10

# For migrations only (separate env var or override)
DIRECT_DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/db
```

Prisma supports this via the `directUrl` datasource field:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_DATABASE_URL")
}
```

### 4.6 Cold Start Mitigation

Neon's serverless compute may pause after 5 minutes of inactivity (on the free tier). To mitigate:

1. **Keep-alive query**: A scheduled job pings the database every 4 minutes during active hours
2. **Accept first-query latency**: The first query after idle may take 1–3 seconds. This is acceptable for a Discord bot.
3. **No persistent connection**: Prisma's connection pool maintains connections, which keeps Neon's compute active.

In practice, Prisma's connection pool should keep the compute active during normal operation.

---

## 5. Redis Connection Strategy

### 5.1 Redis Client

**ioredis** — The standard Redis client for Node.js. BullMQ requires ioredis.

### 5.2 Single Instance

One Redis connection for the entire application lifetime. BullMQ uses this connection for all queues.

### 5.3 Initialization

```typescript
// Conceptual initialization
function createRedisClient(config: RedisConfig, logger: Logger): Redis {
  const client = new Redis(config.url, {
    maxRetriesPerRequest: null,  // BullMQ requires this
    enableReadyCheck: true,
    retryStrategy: (times) => {
      if (times > 10) {
        logger.error('Redis connection failed after 10 retries');
        return null;  // Stop retrying
      }
      return Math.min(times * 200, 2000);  // Exponential backoff, max 2s
    },
    lazyConnect: true,  // Connect explicitly during startup
  });

  client.on('connect', () => logger.info('Redis connecting...'));
  client.on('ready', () => logger.info('Redis ready'));
  client.on('error', (err) => logger.error({ err }, 'Redis error'));
  client.on('close', () => logger.warn('Redis connection closed'));

  return client;
}
```

### 5.4 Connection Verification

```typescript
await redis.connect();
await redis.ping();
logger.info('Redis connected');
```

### 5.5 Disconnection

```typescript
await redis.quit();
logger.info('Redis disconnected');
```

### 5.6 Key Prefix

All BullMQ queue keys are automatically prefixed by BullMQ. No additional Redis key prefix is needed.

### 5.7 Redis Configuration

| Setting | Value | Rationale |
|---|---|---|
| `maxRetriesPerRequest` | `null` | Required by BullMQ |
| `enableReadyCheck` | `true` | Verify Redis is accepting commands |
| `lazyConnect` | `true` | Explicit connection during startup |
| `retryStrategy` | Exponential backoff, max 2s, stop after 10 | Fail fast if Redis is unreachable |

---

## 6. BullMQ Architecture

### 6.1 Queue Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Redis Instance                             │
│                                                                     │
│  Queues:                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ match-fetch   │  │ odds-fetch   │  │ ai-analysis              │  │
│  │ (1 worker)    │  │ (2 workers)  │  │ (2 workers)              │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ prediction    │  │ alert        │  │ settlement               │  │
│  │ (1 worker)    │  │ (1 worker)   │  │ (1 worker)               │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐                                │
│  │ learning      │  │ summary      │                                │
│  │ (1 worker)    │  │ (1 worker)   │                                │
│  └──────────────┘  └──────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.2 Queue Connection Sharing

All queues share a single Redis connection. BullMQ supports this natively:

```typescript
const connection = new Redis(config.redis.url, { maxRetriesPerRequest: null });

const matchFetchQueue = new Queue('match-fetch', { connection });
const oddsFetchQueue = new Queue('odds-fetch', { connection });
// ... etc.
```

### 6.3 Queue Configuration

| Setting | Value | Rationale |
|---|---|---|
| `defaultJobOptions.attempts` | 3 | Retry failed jobs |
| `defaultJobOptions.backoff.type` | `exponential` | Exponential backoff |
| `defaultJobOptions.backoff.delay` | 5000 | Start with 5 second delay |
| `defaultJobOptions.removeOnComplete` | 100 | Keep last 100 completed jobs |
| `defaultJobOptions.removeOnFail` | 50 | Keep last 50 failed jobs |

### 6.4 Worker Configuration

| Setting | Value | Rationale |
|---|---|---|
| `concurrency` | Per-queue (see queue definitions) | Control parallelism |
| `lockDuration` | 30000 | 30 second job lock |
| `stalledInterval` | 30000 | Check for stalled jobs every 30s |
| `maxStalledCount` | 1 | Allow one stall before marking failed |

### 6.5 Queue Registry

A `QueueRegistry` type holds all initialized queues:

```typescript
interface QueueRegistry {
  matchFetch: Queue;
  oddsFetch: Queue;
  aiAnalysis: Queue;
  prediction: Queue;
  settlement: Queue;
  alert: Queue;
  learning: Queue;
  summary: Queue;
}
```

### 6.6 Worker Registry

A `WorkerRegistry` type holds all initialized workers:

```typescript
interface WorkerRegistry {
  matchFetch: Worker;
  oddsFetch: Worker;
  aiAnalysis: Worker;
  prediction: Worker;
  settlement: Worker;
  alert: Worker;
  learning: Worker;
  summary: Worker;
}
```

### 6.7 Worker Lifecycle

Workers are created during startup and paused until all dependencies are ready:

```typescript
// Create worker (paused)
const worker = new Worker('match-fetch', processor, {
  connection,
  concurrency: 1,
  autorun: false,  // Don't start processing immediately
});

// ... create all workers ...

// Start all workers after everything is initialized
workers.forEach(w => w.run());
```

---

## 7. Queue Definitions

### 7.1 Queue: `match-fetch`

| Property | Value |
|---|---|
| **Purpose** | Fetch matches from external APIs |
| **Concurrency** | 1 |
| **Job types** | `fetch-traditional`, `fetch-esports` |
| **Schedule** | Repeatable, every 30 minutes |
| **Max attempts** | 3 |
| **Backoff** | Exponential, 30s initial |
| **Timeout** | 120 seconds |
| **Owned by** | Match Service |

### 7.2 Queue: `odds-fetch`

| Property | Value |
|---|---|
| **Purpose** | Fetch odds for active matches |
| **Concurrency** | 2 |
| **Job types** | `fetch-odds-for-match` |
| **Schedule** | Repeatable, every 15 minutes |
| **Max attempts** | 3 |
| **Backoff** | Exponential, 30s initial |
| **Timeout** | 60 seconds |
| **Owned by** | Odds Service |

### 7.3 Queue: `ai-analysis`

| Property | Value |
|---|---|
| **Purpose** | Analyze matches using DeepSeek |
| **Concurrency** | 2 |
| **Job types** | `analyze-match` |
| **Schedule** | Repeatable, every 60 minutes |
| **Max attempts** | 3 |
| **Backoff** | Exponential, 60s initial |
| **Timeout** | 120 seconds |
| **Owned by** | AI Analysis Service |

### 7.4 Queue: `prediction`

| Property | Value |
|---|---|
| **Purpose** | Generate predictions from analysis |
| **Concurrency** | 1 |
| **Job types** | `generate-predictions` |
| **Schedule** | Event-driven (triggered by analysis completion) |
| **Max attempts** | 2 |
| **Backoff** | Exponential, 10s initial |
| **Timeout** | 30 seconds |
| **Owned by** | Prediction Engine |

### 7.5 Queue: `settlement`

| Property | Value |
|---|---|
| **Purpose** | Settle predictions when matches finish |
| **Concurrency** | 1 |
| **Job types** | `settle-predictions` |
| **Schedule** | Repeatable, every 15 minutes |
| **Max attempts** | 3 |
| **Backoff** | Exponential, 60s initial |
| **Timeout** | 60 seconds |
| **Owned by** | Prediction Engine |

### 7.6 Queue: `alert`

| Property | Value |
|---|---|
| **Purpose** | Dispatch alerts to Discord |
| **Concurrency** | 1 |
| **Job types** | `send-alert` |
| **Schedule** | Event-driven |
| **Max attempts** | 5 |
| **Backoff** | Exponential, 10s initial |
| **Timeout** | 30 seconds |
| **Owned by** | Alert Service |

### 7.7 Queue: `learning`

| Property | Value |
|---|---|
| **Purpose** | Historical analysis of predictions |
| **Concurrency** | 1 |
| **Job types** | `run-learning` |
| **Schedule** | Repeatable, daily at 03:00 |
| **Max attempts** | 2 |
| **Backoff** | Exponential, 60s initial |
| **Timeout** | 300 seconds |
| **Owned by** | Historical Learning Service |

### 7.8 Queue: `summary`

| Property | Value |
|---|---|
| **Purpose** | Send daily performance summary |
| **Concurrency** | 1 |
| **Job types** | `send-daily-summary` |
| **Schedule** | Repeatable, daily at 09:00 |
| **Max attempts** | 2 |
| **Backoff** | Exponential, 30s initial |
| **Timeout** | 60 seconds |
| **Owned by** | Alert Service |

---

## 8. Job Ownership Rules

### 8.1 Ownership Principle

Each queue is owned by exactly one service module. The owning module is responsible for:

1. Defining the job processor function
2. Enqueuing jobs (scheduled or event-driven)
3. Handling job completion and failure
4. Defining job data types

### 8.2 Ownership Table

| Queue | Owner | Processor Location |
|---|---|---|
| `match-fetch` | Match Service | `src/jobs/match-fetch.job.ts` |
| `odds-fetch` | Odds Service | `src/jobs/odds-fetch.job.ts` |
| `ai-analysis` | AI Analysis Service | `src/jobs/ai-analysis.job.ts` |
| `prediction` | Prediction Engine | `src/jobs/prediction.job.ts` |
| `settlement` | Prediction Engine | `src/jobs/settlement.job.ts` |
| `alert` | Alert Service | `src/jobs/alert.job.ts` |
| `learning` | Historical Learning Service | `src/jobs/learning.job.ts` |
| `summary` | Alert Service | `src/jobs/summary.job.ts` |

### 8.3 Job File Convention

Each job file exports:
1. A `process` function (the BullMQ worker processor)
2. A `queueName` constant
3. A `JobData` type (the expected job data shape)
4. A `JobResult` type (the expected job result shape)

```typescript
// Conceptual structure of src/jobs/match-fetch.job.ts
export const queueName = 'match-fetch';

export interface MatchFetchJobData {
  sport: string;
  type: 'traditional' | 'esports';
}

export interface MatchFetchJobResult {
  matchesFetched: number;
  newMatches: number;
  updatedMatches: number;
}

export async function process(job: Job<MatchFetchJobData>): Promise<MatchFetchJobResult> {
  // Implementation added in later sprints
}
```

### 8.4 Cross-Module Communication

Jobs do not call other services directly. Instead:
1. A job completes its work
2. If another action is needed, the job enqueues a job on the appropriate queue
3. The other queue's worker picks up the job

Example flow:
```
match-fetch job completes
  → enqueues odds-fetch jobs for new matches
  → odds-fetch worker picks up the job
```

### 8.5 Job Data Size Limit

Job data must be kept small (< 1 KB). Large data (match details, odds snapshots) is loaded from the database by the processor, not passed in job data. Job data contains only identifiers and minimal context.

---

## 9. Logger Integration Strategy

### 9.1 Logger Factory

The logger factory is initialized once during startup and passed to all components:

```typescript
// src/lib/logger/logger.ts
function createLogger(name: string, config: AppConfig): Logger {
  const transport = config.nodeEnv === 'development'
    ? pino.transport({ target: 'pino-pretty' })
    : undefined;

  return pino({
    name,
    level: config.logLevel,
    transport,
    redact: {
      paths: [
        'DISCORD_TOKEN',
        'THE_ODDS_API_KEY',
        'PANDASCORE_API_KEY',
        'DEEPSEEK_API_KEY',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  });
}
```

### 9.2 Logger Propagation

The root logger is created in `main.ts` and passed to `Application`. The Application creates child loggers for each component:

```typescript
const rootLogger = createLogger('app', config.app);
const prismaLogger = rootLogger.child({ module: 'prisma' });
const redisLogger = rootLogger.child({ module: 'redis' });
const bullLogger = rootLogger.child({ module: 'bullmq' });
```

### 9.3 Module Logger Pattern

Each service module creates its own logger:

```typescript
// Inside a service constructor or factory
this.logger = rootLogger.child({ module: 'match-service' });
```

### 9.4 No Global Logger

The logger is never accessed via a global or singleton. It is passed explicitly through constructors or factory functions.

---

## 10. Configuration Integration Strategy

### 10.1 Config Loading

Configuration is loaded once during startup, before any dependency is initialized:

```typescript
// main.ts
const config = loadConfig();  // Validates all env vars, throws on failure
```

### 10.2 Config Propagation

The config object is passed to the Application constructor and then to each dependency factory:

```typescript
const app = new Application(config, logger);
await app.start();
```

### 10.3 Config Immutability

The config object is frozen with `Object.freeze()` after loading. No component can modify configuration at runtime.

### 10.4 Config Access Pattern

Components access config through their constructor parameters, not by importing config modules directly:

```typescript
// Correct: config is passed in
class MatchService {
  constructor(private config: Config, private logger: Logger) {}
}

// Wrong: importing config directly
import { config } from '@/config/config';  // Avoid this pattern
```

---

## 11. Error Handling Architecture

### 11.1 Error Class Hierarchy

```
Error
├── AppError (base application error)
│   ├── ConfigError (configuration validation failure)
│   ├── DatabaseError (database operation failure)
│   ├── RedisError (Redis operation failure)
│   ├── QueueError (BullMQ operation failure)
│   ├── ExternalApiError (external API call failure)
│   │   ├── RateLimitError (API rate limit exceeded)
│   │   └── AuthenticationError (API auth failure)
│   ├── ValidationError (data validation failure)
│   ├── NotFoundError (entity not found)
│   └── BusinessRuleError (business invariant violation)
```

### 11.2 Error Properties

Every `AppError` includes:

| Property | Type | Description |
|---|---|---|
| `message` | `string` | Human-readable error description |
| `code` | `string` | Machine-readable error code (e.g., `RATE_LIMIT_EXCEEDED`) |
| `statusCode` | `number` | HTTP-like status code (for logging and health check) |
| `retryable` | `boolean` | Whether the operation can be retried |
| `cause` | `Error?` | The original error, if any |

### 11.3 Error Handling Layers

| Layer | Responsibility |
|---|---|
| **Process level** (`main.ts`) | Catch unhandled rejections and uncaught exceptions. Log and exit. |
| **Application level** (`app.ts`) | Catch startup failures. Log and exit. |
| **Job level** (BullMQ workers) | Catch job processing errors. BullMQ handles retries. |
| **Service level** (service classes) | Catch and wrap errors. Add context. Throw typed errors. |
| **Integration level** (API clients) | Catch network errors. Wrap in typed errors. Handle rate limits. |

### 11.4 Unhandled Rejection Strategy

```typescript
// main.ts
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});
```

### 11.5 BullMQ Error Handling

BullMQ workers catch errors automatically and handle retries based on job configuration. The worker's `failed` event is used for logging:

```typescript
worker.on('failed', (job, err) => {
  logger.error({ err, jobId: job.id, queue: queueName }, 'Job failed');
});
```

The worker's `completed` event is used for success logging:

```typescript
worker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: queueName }, 'Job completed');
});
```

### 11.6 Error Wrapping Pattern

```typescript
// Conceptual pattern for service methods
async function getMatch(matchId: string): Promise<Match> {
  try {
    return await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new NotFoundError(`Match ${matchId} not found`);
    }
    throw new DatabaseError('Failed to fetch match', { cause: err, retryable: true });
  }
}
```

---

## 12. Health Check Architecture

### 12.1 Health Check Server

A minimal HTTP server using Node.js built-in `http` module (no Express). Single endpoint:

| Endpoint | Method | Response |
|---|---|---|
| `/health` | GET | `{ "status": "ok" \| "degraded" \| "down", "uptime": <seconds>, "version": "0.1.0" }` |

### 12.2 Health Check Logic

```typescript
// Conceptual health check
function getHealthStatus(app: Application): HealthStatus {
  if (app.getState() === 'running') {
    return { status: 'ok', uptime: process.uptime(), version: '0.1.0' };
  }
  if (app.getState() === 'starting' || app.getState() === 'stopping') {
    return { status: 'degraded', uptime: process.uptime(), version: '0.1.0' };
  }
  return { status: 'down', uptime: process.uptime(), version: '0.1.0' };
}
```

### 12.3 Health Check Server Lifecycle

- Started after all dependencies are initialized (last step before RUNNING state)
- Stopped before any dependency is shut down (first step during shutdown)
- Uses a separate port (default 3000) from any other service

### 12.4 Server Implementation

```typescript
// Conceptual — using Node.js http module
function createHealthServer(app: Application, logger: Logger): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const status = getHealthStatus(app);
      res.writeHead(status.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return server;
}
```

### 12.5 Health Check Usage

- **Docker**: Used for `HEALTHCHECK` instruction
- **Deployment platform**: Used for load balancer health checks
- **Monitoring**: External uptime monitoring
- **Debugging**: Quick verification that the application is running

---

## 13. Graceful Shutdown Architecture

### 13.1 Shutdown Order

```
1. Stop health check server (stop accepting new requests)
2. Pause BullMQ workers (stop processing new jobs)
3. Wait for active jobs to complete (with timeout)
4. Close BullMQ workers
5. Close BullMQ queues
6. Disconnect Redis
7. Disconnect Prisma
8. Log shutdown complete
9. Exit process (code 0)
```

### 13.2 Shutdown Timeout

Total shutdown timeout: 30 seconds. If shutdown takes longer, force exit.

```typescript
const SHUTDOWN_TIMEOUT = 30_000; // 30 seconds

async function shutdown(app: Application): Promise<void> {
  const timeout = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  try {
    await app.stop();
  } finally {
    clearTimeout(timeout);
    process.exit(0);
  }
}
```

### 13.3 Signal Handling

```typescript
// main.ts
process.on('SIGTERM', () => shutdown(app));
process.on('SIGINT', () => shutdown(app));
```

### 13.4 Worker Draining

When workers are paused, BullMQ allows the current job to complete before stopping. The `worker.close()` method waits for active jobs to finish:

```typescript
async function stopWorkers(workers: WorkerRegistry): Promise<void> {
  const closePromises = Object.values(workers).map(worker => worker.close());
  await Promise.all(closePromises);
}
```

### 13.5 Queue Draining

After workers are closed, queues are closed to release Redis resources:

```typescript
async function stopQueues(queues: QueueRegistry): Promise<void> {
  const closePromises = Object.values(queues).map(queue => queue.close());
  await Promise.all(closePromises);
}
```

---

## 14. Startup Sequence

### 14.1 Complete Startup Sequence

```
main.ts
  1. Load configuration (loadConfig)
     → If validation fails → log error → exit(1)
  2. Create root logger
  3. Create Application instance (config + logger)
  4. Call app.start()
     → Set state = STARTING
     → Initialize Prisma Client
     → Connect to database (prisma.$connect)
     → Verify database (SELECT 1)
     → Initialize Redis client
     → Connect to Redis (redis.connect + redis.ping)
     → Create BullMQ queues
     → Create BullMQ workers (paused)
     → Start BullMQ workers (worker.run)
     → Start health check server
     → Set state = RUNNING
     → Log startup complete
  5. Register signal handlers (SIGTERM, SIGINT)
  6. Log "Application started"
```

### 14.2 Startup Failure Handling

If any step in the startup sequence fails:

1. Log the error with full context
2. Set state = FAILED
3. Attempt to shut down any initialized dependencies (cleanup)
4. Exit with code 1

```typescript
// Conceptual
async function start(): Promise<void> {
  try {
    this.state = 'starting';
    await this.initPrisma();
    await this.initRedis();
    await this.initQueues();
    await this.initWorkers();
    await this.startHealthServer();
    this.state = 'running';
  } catch (err) {
    this.state = 'failed';
    await this.cleanup();  // Shut down anything that was initialized
    throw err;  // Propagate to main.ts for exit
  }
}
```

---

## 15. Dependency Initialization Order

### 15.1 Strict Order

Dependencies must be initialized in this exact order:

| Step | Dependency | Depends On | Failure Action |
|---|---|---|---|
| 1 | Configuration | Nothing | Exit immediately |
| 2 | Logger | Configuration | Exit immediately |
| 3 | Prisma Client | Configuration, Logger | Log error, cleanup, exit |
| 4 | Database connection | Prisma Client | Log error, cleanup, exit |
| 5 | Redis Client | Configuration, Logger | Log error, cleanup Prisma, exit |
| 6 | Redis connection | Redis Client | Log error, cleanup Prisma + Redis, exit |
| 7 | BullMQ Queues | Redis Client | Log error, cleanup all, exit |
| 8 | BullMQ Workers | BullMQ Queues | Log error, cleanup all, exit |
| 9 | Health Check Server | All above | Log error, cleanup all, exit |

### 15.2 Cleanup on Failure

When a dependency fails to initialize, all previously initialized dependencies must be shut down in reverse order:

```
Example: Redis connection fails
  → Log error
  → Disconnect Prisma (step 4 reverse)
  → Close Prisma Client (step 3 reverse)
  → Exit with code 1
```

### 15.3 Dependency Factory Pattern

Each dependency has a factory function:

```typescript
// Conceptual factory pattern
async function initPrisma(config: Config, logger: Logger): Promise<PrismaClient> {
  const client = createPrismaClient(config.database, logger);
  await client.$connect();
  await client.$queryRaw`SELECT 1`;
  return client;
}

async function initRedis(config: Config, logger: Logger): Promise<Redis> {
  const client = createRedisClient(config.redis, logger);
  await client.connect();
  await client.ping();
  return client;
}
```

---

## 16. Failure Recovery Strategy

### 16.1 Failure Categories

| Category | Examples | Recovery |
|---|---|---|
| **Transient** | Network timeout, rate limit, temporary API outage | Retry via BullMQ |
| **Persistent** | Database down, Redis down, invalid config | Application restart required |
| **Fatal** | Out of memory, unrecoverable error | Process exit |

### 16.2 Transient Failure Recovery

Transient failures are handled by BullMQ's retry mechanism:

1. Job fails → BullMQ waits (exponential backoff)
2. Job retries → up to `maxAttempts` times
3. All retries exhausted → job moves to failed queue
4. Failed jobs are logged and reviewed manually

### 16.3 Persistent Failure Recovery

Persistent failures require application restart:

1. Health check returns `down`
2. Deployment platform detects unhealthy state
3. Platform restarts the container
4. Application re-attempts startup sequence
5. If startup fails again → platform escalates (alert, pager)

### 16.4 Database Connection Loss

If the database connection is lost during operation:

1. The query throws a `DatabaseError`
2. The service or job catches the error
3. If the job is retryable → BullMQ retries
4. If the error persists → health check fails → container restarts

No automatic reconnection. Prisma Client does not support reconnection. Restart is the recovery mechanism.

### 16.5 Redis Connection Loss

If the Redis connection is lost during operation:

1. BullMQ workers detect the connection loss
2. Workers stop processing jobs
3. Health check fails (Redis dependency is down)
4. Container restarts
5. On restart, Redis connection is re-established

### 16.6 Startup Retry

The application does NOT retry startup. If startup fails:
1. Log the error
2. Clean up any initialized dependencies
3. Exit with code 1
4. The deployment platform handles restart

---

## 17. Infrastructure Testing Strategy

### 17.1 Test Categories

| Category | Scope | Dependencies | Speed |
|---|---|---|---|
| **Unit tests** | Individual functions, error classes, config loading | None (mocked) | Fast |
| **Integration tests** | Prisma Client, Redis Client, BullMQ | Real PostgreSQL, Real Redis | Medium |
| **Startup tests** | Application bootstrap, graceful shutdown | Real PostgreSQL, Real Redis | Slow |

### 17.2 Unit Tests

**What to test:**
- Config loading (valid env vars, missing env vars, invalid types)
- Error class construction and properties
- Logger factory (correct level, correct name)
- Health check response formatting

**What NOT to test:**
- Prisma Client initialization (integration test)
- Redis Client initialization (integration test)
- BullMQ queue creation (integration test)

### 17.3 Integration Tests

**What to test:**
- Prisma Client connects and disconnects
- Prisma Client executes a simple query
- Redis Client connects, pings, and disconnects
- BullMQ queue creates, enqueues, and processes a job
- BullMQ worker handles job failure and retry

**Test infrastructure:**
- Docker Compose with PostgreSQL and Redis for CI
- Test database is created and destroyed per test run
- Test Redis is flushed between test suites

### 17.4 Startup Tests

**What to test:**
- Application starts successfully with valid config
- Application fails startup with invalid config
- Application shuts down gracefully on SIGTERM
- Application shuts down gracefully on SIGINT
- Health check returns `ok` when running
- Health check returns `down` when failed

**Test approach:**
- Start the application in a child process
- Send signals and verify behavior
- Check health endpoint
- Verify log output

### 17.5 Test Configuration

Tests use a separate environment file (`.env.test`) with:

```bash
NODE_ENV=test
LOG_LEVEL=silent
DATABASE_URL=postgresql://betting:betting_dev@localhost:5432/betting_test
REDIS_URL=redis://localhost:6379
# API keys can be dummy values for infrastructure tests
DISCORD_TOKEN=test-token
DISCORD_CLIENT_ID=test-client-id
THE_ODDS_API_KEY=test-key
PANDASCORE_API_KEY=test-key
DEEPSEEK_API_KEY=test-key
```

### 17.6 Test File Organization

```
tests/
├── unit/
│   ├── config/
│   │   └── app.config.test.ts
│   ├── lib/
│   │   ├── logger.test.ts
│   │   └── errors.test.ts
│   └── app.test.ts
├── integration/
│   ├── prisma.test.ts
│   ├── redis.test.ts
│   └── bullmq.test.ts
└── setup.ts  # Global test setup (env vars, Docker check)
```

### 17.7 Test Setup File

```typescript
// tests/setup.ts — conceptual
import { loadConfig } from '@/config/config';

// Load test configuration before all tests
beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  // Other env vars are loaded from .env.test
});

// Verify Docker services are running
beforeAll(async () => {
  // Check PostgreSQL is reachable
  // Check Redis is reachable
  // Skip tests if infrastructure is not available
});
```

---

*End of Sprint 2: Core Infrastructure Specification*

**Next sprint:** Implement the Discord bot module (client setup, command registration, slash command handlers).


