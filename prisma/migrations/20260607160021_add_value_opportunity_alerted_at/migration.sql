-- AlterTable
ALTER TABLE "value_opportunities" ADD COLUMN     "alerted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "value_opportunities_alerted_at_idx" ON "value_opportunities"("alerted_at");
