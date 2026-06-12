-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DetectionModel" ADD VALUE 'LOW_ODDS_LEGACY';
ALTER TYPE "DetectionModel" ADD VALUE 'LOW_ODDS_PINNACLE_LED';

-- AlterTable
ALTER TABLE "value_opportunities" ADD COLUMN     "confidence" TEXT;
