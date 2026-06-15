-- Additive enum value for the LEGACY_QUALITY model (Legacy minus the flat-movement class).
ALTER TYPE "DetectionModel" ADD VALUE IF NOT EXISTS 'LEGACY_QUALITY';
