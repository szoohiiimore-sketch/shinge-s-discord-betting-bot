-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('CREATED', 'ACTIVE');

-- CreateEnum
CREATE TYPE "CurrencyCode" AS ENUM ('HUF', 'EUR');

-- CreateEnum
CREATE TYPE "BankrollStatus" AS ENUM ('ACTIVE');

-- CreateEnum
CREATE TYPE "SportCategory" AS ENUM ('TRADITIONAL', 'ESPORTS');

-- CreateEnum
CREATE TYPE "SportStatus" AS ENUM ('ACTIVE', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "ApiSource" AS ENUM ('THE_ODDS_API', 'PANDASCORE');

-- CreateEnum
CREATE TYPE "LeagueStatus" AS ENUM ('ACTIVE');

-- CreateEnum
CREATE TYPE "TeamStatus" AS ENUM ('ACTIVE');

-- CreateEnum
CREATE TYPE "TeamLeagueStatus" AS ENUM ('ACTIVE');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'LIVE', 'FINISHED', 'CANCELLED', 'POSTPONED');

-- CreateEnum
CREATE TYPE "MatchResult" AS ENUM ('HOME_WIN', 'AWAY_WIN', 'DRAW');

-- CreateEnum
CREATE TYPE "OddsMarket" AS ENUM ('H2H', 'SPREADS', 'TOTALS');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnalysisTrigger" AS ENUM ('SCHEDULED', 'ON_DEMAND', 'RE_ANALYSIS');

-- CreateEnum
CREATE TYPE "ValueLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'NONE');

-- CreateEnum
CREATE TYPE "PredictionStatus" AS ENUM ('PENDING', 'PLACED', 'SETTLED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PredictionResult" AS ENUM ('WON', 'LOST', 'PUSH', 'VOID');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "discord_id" TEXT NOT NULL,
    "discord_username" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'CREATED',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "default_stake_percent" DECIMAL(65,30) NOT NULL DEFAULT 1.00,
    "min_confidence_threshold" DECIMAL(65,30) NOT NULL DEFAULT 0.60,
    "min_odds_threshold" DECIMAL(65,30) NOT NULL DEFAULT 1.50,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bankrolls" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "currency" "CurrencyCode" NOT NULL DEFAULT 'HUF',
    "starting_balance" DECIMAL(65,30) NOT NULL,
    "current_balance" DECIMAL(65,30) NOT NULL,
    "status" "BankrollStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bankrolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sports" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "SportCategory" NOT NULL,
    "status" "SportStatus" NOT NULL DEFAULT 'ACTIVE',
    "external_api_source" "ApiSource" NOT NULL,
    "external_sport_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leagues" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "LeagueStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leagues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TeamStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_leagues" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "league_id" UUID NOT NULL,
    "status" "TeamLeagueStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_leagues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "sport_id" UUID NOT NULL,
    "league_id" UUID NOT NULL,
    "home_team_id" UUID NOT NULL,
    "away_team_id" UUID NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "home_score" INTEGER,
    "away_score" INTEGER,
    "result" "MatchResult",
    "last_fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odds_snapshots" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "bookmaker" TEXT NOT NULL,
    "market" "OddsMarket" NOT NULL,
    "outcome" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "is_live" BOOLEAN NOT NULL DEFAULT false,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analyses" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "AnalysisTrigger" NOT NULL,
    "predicted_winner" TEXT,
    "confidence" DECIMAL(65,30),
    "reasoning" TEXT,
    "key_factors" TEXT[],
    "recommended_market" "OddsMarket",
    "value_assessment" "ValueLevel",
    "odds_used" JSONB,
    "tokens_used" INTEGER,
    "cost_usd" DECIMAL(65,30),
    "error_message" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "predictions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "analysis_id" UUID NOT NULL,
    "status" "PredictionStatus" NOT NULL DEFAULT 'PENDING',
    "market" "OddsMarket" NOT NULL,
    "predicted_outcome" TEXT NOT NULL,
    "odds_at_placement" DECIMAL(65,30) NOT NULL,
    "bookmaker" TEXT NOT NULL,
    "stake" DECIMAL(65,30) NOT NULL,
    "confidence" DECIMAL(65,30) NOT NULL,
    "expected_value" DECIMAL(65,30) NOT NULL,
    "value_assessment" "ValueLevel" NOT NULL,
    "result" "PredictionResult",
    "pnl" DECIMAL(65,30),
    "roi" DECIMAL(65,30),
    "closing_odds" DECIMAL(65,30),
    "was_correct" BOOLEAN,
    "settled_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "predictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "users_discord_id_key" ON "users"("discord_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "bankrolls_user_id_key" ON "bankrolls"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sports_slug_key" ON "sports"("slug");

-- CreateIndex
CREATE INDEX "leagues_sport_id_idx" ON "leagues"("sport_id");

-- CreateIndex
CREATE UNIQUE INDEX "leagues_sport_id_external_id_key" ON "leagues"("sport_id", "external_id");

-- CreateIndex
CREATE INDEX "teams_sport_id_idx" ON "teams"("sport_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_sport_id_external_id_key" ON "teams"("sport_id", "external_id");

-- CreateIndex
CREATE INDEX "team_leagues_team_id_idx" ON "team_leagues"("team_id");

-- CreateIndex
CREATE INDEX "team_leagues_league_id_idx" ON "team_leagues"("league_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_leagues_team_id_league_id_key" ON "team_leagues"("team_id", "league_id");

-- CreateIndex
CREATE INDEX "matches_sport_id_idx" ON "matches"("sport_id");

-- CreateIndex
CREATE INDEX "matches_league_id_idx" ON "matches"("league_id");

-- CreateIndex
CREATE INDEX "matches_home_team_id_idx" ON "matches"("home_team_id");

-- CreateIndex
CREATE INDEX "matches_away_team_id_idx" ON "matches"("away_team_id");

-- CreateIndex
CREATE INDEX "matches_start_time_status_idx" ON "matches"("start_time", "status");

-- CreateIndex
CREATE INDEX "matches_status_idx" ON "matches"("status");

-- CreateIndex
CREATE UNIQUE INDEX "matches_external_id_key" ON "matches"("external_id");

-- CreateIndex
CREATE INDEX "odds_snapshots_match_id_idx" ON "odds_snapshots"("match_id");

-- CreateIndex
CREATE INDEX "odds_snapshots_match_id_captured_at_idx" ON "odds_snapshots"("match_id", "captured_at");

-- CreateIndex
CREATE INDEX "analyses_match_id_idx" ON "analyses"("match_id");

-- CreateIndex
CREATE INDEX "analyses_match_id_status_idx" ON "analyses"("match_id", "status");

-- CreateIndex
CREATE INDEX "analyses_status_idx" ON "analyses"("status");

-- CreateIndex
CREATE INDEX "predictions_user_id_idx" ON "predictions"("user_id");

-- CreateIndex
CREATE INDEX "predictions_match_id_idx" ON "predictions"("match_id");

-- CreateIndex
CREATE INDEX "predictions_analysis_id_idx" ON "predictions"("analysis_id");

-- CreateIndex
CREATE INDEX "predictions_user_id_status_idx" ON "predictions"("user_id", "status");

-- CreateIndex
CREATE INDEX "predictions_match_id_status_idx" ON "predictions"("match_id", "status");

-- CreateIndex
CREATE INDEX "predictions_status_idx" ON "predictions"("status");

-- CreateIndex
CREATE INDEX "predictions_created_at_idx" ON "predictions"("created_at");

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bankrolls" ADD CONSTRAINT "bankrolls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_leagues" ADD CONSTRAINT "team_leagues_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_leagues" ADD CONSTRAINT "team_leagues_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_home_team_id_fkey" FOREIGN KEY ("home_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_away_team_id_fkey" FOREIGN KEY ("away_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds_snapshots" ADD CONSTRAINT "odds_snapshots_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
