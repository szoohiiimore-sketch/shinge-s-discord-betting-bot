-- Additive enum values for the SHARP_FINAL production model family.
-- Non-breaking: existing rows and types are unaffected.
ALTER TYPE "DetectionModel" ADD VALUE IF NOT EXISTS 'SHARP_FINAL';
ALTER TYPE "DetectionModel" ADD VALUE IF NOT EXISTS 'SHARP_FINAL_LOW';
