-- AlterTable
ALTER TABLE "value_opportunities" ADD COLUMN     "is_shadow" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "value_opportunities_is_shadow_idx" ON "value_opportunities"("is_shadow");
