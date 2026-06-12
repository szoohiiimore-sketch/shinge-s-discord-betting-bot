-- AlterTable
ALTER TABLE "historical_events" ADD COLUMN     "result_evidence_at" TIMESTAMP(3),
ADD COLUMN     "result_method" TEXT,
ADD COLUMN     "result_outcome" TEXT;
