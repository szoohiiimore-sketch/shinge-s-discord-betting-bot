-- CreateEnum
CREATE TYPE "BetResult" AS ENUM ('WIN', 'LOSS', 'PUSH');

-- AlterTable
ALTER TABLE "value_opportunities" ADD COLUMN     "bet_result" "BetResult",
ADD COLUMN     "profit_loss_units" DECIMAL(65,30),
ADD COLUMN     "settled_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "value_opportunities_settled_at_idx" ON "value_opportunities"("settled_at");

-- CreateIndex
CREATE INDEX "value_opportunities_bet_result_idx" ON "value_opportunities"("bet_result");
