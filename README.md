# Betting Intelligence Discord Platform

A Discord bot that collects sports and esports matches, analyzes them using AI, generates betting recommendations, and manages user bankrolls.

## Tech Stack

- **Runtime:** Node.js LTS
- **Language:** TypeScript
- **Database:** PostgreSQL (Neon)
- **ORM:** Prisma
- **Cache/Queue:** Redis + BullMQ
- **Bot Framework:** discord.js
- **Package Manager:** pnpm
- **AI:** DeepSeek V4 Flash API
- **Data Sources:** The Odds API, PandaScore API

## Prerequisites

- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Docker (for local PostgreSQL and Redis)

## Setup

```bash
# Install dependencies
pnpm install

# Copy environment file
cp .env.example .env
# Edit .env with your API keys

# Start infrastructure services
docker compose up -d

# Generate Prisma Client
pnpm db:generate

# Run migrations
pnpm db:migrate

# Start development server
pnpm dev
```

## Scripts

| Script | Description |
|---|---|
| `pnpm dev` | Development with hot reload |
| `pnpm build` | Production build |
| `pnpm start` | Production start |
| `pnpm test` | Run tests |
| `pnpm lint` | Lint code |
| `pnpm format` | Format code |
| `pnpm db:migrate` | Apply database migrations |
| `pnpm db:studio` | Open Prisma Studio |

## Project Structure

```
src/
├── config/          # Configuration loading
├── lib/             # Shared utilities (logger, errors)
├── modules/         # Application modules
│   ├── discord/     # Discord bot client and commands
│   ├── matches/     # Match service
│   ├── odds/        # Odds service
│   ├── analysis/    # AI analysis service
│   ├── predictions/ # Prediction engine
│   ├── bankroll/    # Bankroll manager
│   ├── analytics/   # Analytics service
│   ├── alerts/      # Alert service
│   ├── users/       # User service
│   ├── scheduler/   # BullMQ job definitions
│   └── learning/    # Historical learning service
├── jobs/            # BullMQ worker implementations
├── integrations/    # External API clients
├── app.ts           # Application entry point
└── main.ts          # Process entry point
```
