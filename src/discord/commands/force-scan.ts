import type { Logger } from '@/lib/logger';
import type { ValueDetectionService } from '@/value-detection';

export async function executeForceScan(
  valueDetectionService: ValueDetectionService,
  matchExternalIds: readonly string[],
  logger: Logger,
): Promise<{ content: string }> {
  const startedAt = Date.now();
  logger.info({
    command: 'force-scan',
    dataSource: 'PostgreSQL (OddsSnapshot table — cached data from previous ingestion runs)',
    matchExternalIdsCount: matchExternalIds.length,
  }, 'Command execution started');

  if (matchExternalIds.length === 0) {
    return { content: 'No match IDs found. Run /force-ingestion first to fetch fresh data from external APIs.' };
  }

  const result = await valueDetectionService.detectForMatchExternalIds(matchExternalIds);
  const durationMs = Date.now() - startedAt;

  logger.info({
    command: 'force-scan',
    dataSource: 'PostgreSQL (OddsSnapshot table)',
    apiCalls: 0,
    matchesScanned: result.matchesAnalyzed,
    opportunitiesDetected: result.opportunitiesDetected,
    opportunitiesRejected: result.opportunitiesRejected,
    opportunitiesSkipped: result.opportunitiesSkipped,
    durationMs,
  }, 'Command execution complete');

  const lines = [
    `**Data Source:** PostgreSQL (OddsSnapshot table — cached)`,
    `**API Calls:** 0 | **Duration:** ${durationMs}ms`,
    '',
    '🔍 **FORCE SCAN COMPLETE**',
    '',
    `**Matches scanned:** ${result.matchesAnalyzed}`,
    `**Opportunities detected:** ${result.opportunitiesDetected}`,
    `**Rejected (below threshold):** ${result.opportunitiesRejected}`,
    `**Skipped (insufficient data):** ${result.opportunitiesSkipped}`,
  ];

  return { content: lines.join('\n') };
}
