-- CreateTable
CREATE TABLE "value_opportunities" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "sport" TEXT NOT NULL,
    "bookmaker" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "bookmaker_odds" DECIMAL(65,30) NOT NULL,
    "fair_odds" DECIMAL(65,30) NOT NULL,
    "edge_percentage" DECIMAL(65,30) NOT NULL,
    "consensus_probability" DECIMAL(65,30) NOT NULL,
    "consensus_bookmakers" TEXT[],
    "captured_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "value_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "value_opportunities_match_id_idx" ON "value_opportunities"("match_id");

-- CreateIndex
CREATE INDEX "value_opportunities_edge_percentage_idx" ON "value_opportunities"("edge_percentage");

-- CreateIndex
CREATE INDEX "value_opportunities_captured_at_idx" ON "value_opportunities"("captured_at");

-- CreateIndex
CREATE INDEX "value_opportunities_created_at_idx" ON "value_opportunities"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "value_opportunities_match_id_bookmaker_outcome_captured_at_key" ON "value_opportunities"("match_id", "bookmaker", "outcome", "captured_at");

-- AddForeignKey
ALTER TABLE "value_opportunities" ADD CONSTRAINT "value_opportunities_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
