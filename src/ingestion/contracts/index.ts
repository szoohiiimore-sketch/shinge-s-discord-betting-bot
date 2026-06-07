export type {
  IngestionSource,
  IngestionSportCategory,
  IngestionMatchStatus,
  IngestionMatchResult,
  IngestionOddsMarket,
  EsportsVideogame,
  TraditionalSportKey,
  IngestionEntityType,
} from './source.types';

export type { RawOddsApiSport, RawOddsApiMatchOdds, RawPandascoreMatch } from './raw-payload.types';

export type {
  CanonicalSport,
  CanonicalLeague,
  CanonicalTeam,
  CanonicalTeamLeague,
  CanonicalMatch,
  CanonicalOddsSnapshot,
  OddsApiIngestionPlan,
  PandascoreIngestionPlan,
} from './canonical.types';

export type {
  OddsApiSportMapper,
  OddsApiEventMapper,
  PandascoreMatchMapper,
} from './mapping.contracts';

export type {
  SportDeduplicationKey,
  LeagueDeduplicationKey,
  TeamDeduplicationKey,
  MatchDeduplicationKey,
  EntityWriteAction,
  EntityWriteOutcome,
} from './deduplication.types';

export type {
  SportUpsertInput,
  LeagueUpsertInput,
  TeamUpsertInput,
  TeamLeagueUpsertInput,
  MatchUpdateFields,
  MatchUpsertInput,
  OddsSnapshotInsertInput,
} from './upsert.types';

export type {
  SyncError,
  TraditionalSportSyncResult,
  EsportsGameSyncResult,
  ReferenceSyncResult,
} from './sync-result.types';

export type {
  SyncTraditionalSportJobData,
  SyncEsportsGameJobData,
  SyncReferenceDataJobData,
  SyncOddsForSportJobData,
  SyncEsportsOddsJobData,
  SettleMatchesJobData,
  DailySummaryJobData,
  MatchFetchJobName,
  MatchFetchJobPayload,
  OddsFetchJobPayload,
} from './queue-payload.types';
