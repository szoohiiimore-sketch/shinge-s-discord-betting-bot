-- AlterTable
ALTER TABLE "value_opportunities" ADD COLUMN     "closing_pinnacle_odds" DECIMAL(65,30),
ADD COLUMN     "clv_percentage" DECIMAL(65,30),
ADD COLUMN     "clv_positive" BOOLEAN;
