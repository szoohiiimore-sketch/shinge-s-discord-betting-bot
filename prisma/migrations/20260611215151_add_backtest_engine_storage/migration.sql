-- CreateTable
CREATE TABLE "historical_events" (
    "id" TEXT NOT NULL,
    "sport_key" TEXT NOT NULL,
    "commence_time" TIMESTAMP(3) NOT NULL,
    "home_team" TEXT NOT NULL,
    "away_team" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historical_odds_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "sport_key" TEXT NOT NULL,
    "bookmaker" TEXT NOT NULL,
    "market" TEXT NOT NULL DEFAULT 'h2h',
    "outcome" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "snapshot_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_odds_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historical_ingestion_cursors" (
    "id" TEXT NOT NULL,
    "sport_key" TEXT NOT NULL,
    "plan_key" TEXT NOT NULL,
    "last_timestamp" TIMESTAMP(3),
    "requests_used" INTEGER NOT NULL DEFAULT 0,
    "credits_used" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "historical_ingestion_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "code_version" TEXT NOT NULL,
    "cadence_mode" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_opportunities" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "sport_key" TEXT NOT NULL,
    "bookmaker" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "bookmaker_odds" DECIMAL(65,30) NOT NULL,
    "fair_odds" DECIMAL(65,30) NOT NULL,
    "edge_percentage" DECIMAL(65,30) NOT NULL,
    "consensus_probability" DECIMAL(65,30) NOT NULL,
    "is_shadow" BOOLEAN NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "commence_time" TIMESTAMP(3) NOT NULL,
    "reference_overround" DECIMAL(65,30) NOT NULL,
    "bookmaker_family" TEXT NOT NULL,
    "minutes_to_kickoff" INTEGER NOT NULL,
    "pinnacle_move_1h" DECIMAL(65,30),
    "pinnacle_move_6h" DECIMAL(65,30),
    "pinnacle_move_24h" DECIMAL(65,30),
    "price_gap_pct" DECIMAL(65,30),
    "corroboration_k" INTEGER NOT NULL,
    "closing_pinnacle_odds" DECIMAL(65,30),
    "closing_fair_odds" DECIMAL(65,30),
    "clv_percentage" DECIMAL(65,30),
    "clv_positive" BOOLEAN,
    "bet_result" TEXT,
    "profit_loss_units" DECIMAL(65,30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historical_events_sport_key_commence_time_idx" ON "historical_events"("sport_key", "commence_time");

-- CreateIndex
CREATE INDEX "historical_odds_snapshots_sport_key_snapshot_at_idx" ON "historical_odds_snapshots"("sport_key", "snapshot_at");

-- CreateIndex
CREATE INDEX "historical_odds_snapshots_event_id_snapshot_at_idx" ON "historical_odds_snapshots"("event_id", "snapshot_at");

-- CreateIndex
CREATE UNIQUE INDEX "historical_odds_snapshots_event_id_bookmaker_market_outcome_key" ON "historical_odds_snapshots"("event_id", "bookmaker", "market", "outcome", "snapshot_at");

-- CreateIndex
CREATE INDEX "backtest_opportunities_run_id_idx" ON "backtest_opportunities"("run_id");

-- CreateIndex
CREATE INDEX "backtest_opportunities_run_id_event_id_idx" ON "backtest_opportunities"("run_id", "event_id");

-- CreateIndex
CREATE INDEX "backtest_opportunities_run_id_is_shadow_idx" ON "backtest_opportunities"("run_id", "is_shadow");

-- AddForeignKey
ALTER TABLE "historical_odds_snapshots" ADD CONSTRAINT "historical_odds_snapshots_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "historical_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_opportunities" ADD CONSTRAINT "backtest_opportunities_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "backtest_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
