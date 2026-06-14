export { ValueDetectionService } from './value-detection.service';
export { ValueOpportunityRepository } from './value-opportunity.repository';
export type { ValueDetectionResult, ValueDetectionDecision, ValueOpportunityInsert, DetectionModelName } from './value-detection.types';
export { legacyDetectFromBatch, LEGACY_DETECTOR_CONFIG } from './legacy-detector-core';
export type { LegacyDetectorConfig } from './legacy-detector-core';
export { isLowOdds, pinnacleLedLowOddsThresholdPct, legacyLowOddsThresholdPct, LOW_ODDS_MIN, LOW_ODDS_MAX } from './low-odds-config';
export { alertConfidence, alertConfidenceFlags, isFlatLine, isExtremeOdds } from './alert-confidence';
export type { AlertConfidence, AlertConfidenceInput } from './alert-confidence';
export {
  bookmakerFamily,
  isExchange,
  ideaKey,
  groupIdeas,
  selectHeadline,
  corroborationCount,
  aggregateSettledIdeas,
  oddsToNumber,
} from './idea-aggregation';
export type { IdeaMemberRow, SettledIdea } from './idea-aggregation';
export { detectFromBatch, referenceMovementPct, PRODUCTION_DETECTOR_CONFIG } from './detector-core';
export type {
  DetectorInputRow,
  DetectorConfig,
  DetectorCandidate,
  DetectorDecision,
  DetectFromBatchResult,
  PricePoint,
} from './detector-core';
