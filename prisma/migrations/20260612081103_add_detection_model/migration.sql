-- CreateEnum
CREATE TYPE "DetectionModel" AS ENUM ('LEGACY', 'PINNACLE_LED');

-- AlterTable
ALTER TABLE "value_opportunities" ADD COLUMN     "model" "DetectionModel" NOT NULL DEFAULT 'PINNACLE_LED';

-- CreateIndex
CREATE INDEX "value_opportunities_model_idx" ON "value_opportunities"("model");

-- Backfill: legacy-era rows bet Pinnacle's own price; the Pinnacle-led model never inserts pinnacle as candidate.
UPDATE value_opportunities SET model = 'LEGACY' WHERE bookmaker = 'pinnacle';
