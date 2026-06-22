export type {
  CreateEntityInput,
  CreateMemoryInput,
  UpdateMemoryInput,
  CreateRelationInput,
  Entity,
  Memory,
  MemoryCandidate,
  MemoryOriginRole,
  MemoryCandidateStorageResult,
  CurrentAffect,
  CurrentAffectLabel,
  MemoryExtractionInput,
  MemoryExtractor,
  MemoryExtractorActive,
  MemoryExtractorMode,
  MemoryExtractorStatus,
  MemoryLayer,
  MemoryScope,
  MemoryMatchReason,
  MemoryQuery,
  MemoryRetrievalMode,
  MemoryRetrievalResult,
  MemorySearchRankComponents,
  MemorySearchQuery,
  MemoryStatus,
  MemorySubtype,
  MemoryType,
  MemoryVectorIndexStatus,
  RetrievedMemoryCandidate,
  RetrievedMemoryDebug,
  Relation
} from "./types.js";
export { detectCurrentAffect } from "./affect.js";
export { computeRetentionPolicy, type RetentionPolicy } from "./retention.js";
export {
  MemoryLayers,
  MemoryScopes,
  MemoryStatuses,
  MemorySubtypes,
  MemoryTypes
} from "./types.js";
export {
  buildCandidateFingerprint,
  deduplicateCandidateBatch,
  type CandidateDedupeResult
} from "./candidate-dedupe.js";
export { detectExplicitRememberRequest, stripExplicitRememberPrefix } from "./intent.js";
export { enrichCandidateProvenance, isAssistantOnlyRestatement } from "./provenance.js";
export {
  hasHistoricalEpisodicIntent,
  hasRelativeTemporalExpression,
  normalizeTemporalCandidate,
  temporalWarningForText,
  type TemporalNormalizationResult,
  type TemporalResolution
} from "./temporal.js";
export {
  detectMemoryRelationships,
  relationshipSearchText,
  type MemoryRelationshipSuggestion
} from "./relationships.js";
export {
  MemoryMaintenanceService,
  getMemoryHealth,
  runMemoryMaintenance,
  type MemoryHealthSummary,
  type MemoryMaintenanceOptions,
  type MemoryMaintenanceSummary,
  type MemoryMaintenanceWarning
} from "./maintenance.js";
export { parseMemoryRepositoryEnv, type MemoryRepositoryKind } from "./env.js";
export { normalizePostgresConnectionString } from "./postgres-connection.js";
export {
  InMemoryMemoryRepository,
  PostgresMemoryRepository,
  createMemoryRepositoryFromEnv,
  type MemoryRepository
} from "./repository.js";
export { MemoryScorer } from "./scorer.js";
export { MemoryRetriever } from "./retriever.js";
export {
  LlmMemoryExtractor,
  RuleBasedMemoryExtractor,
  type LlmMemoryExtractorOptions,
  type MemoryExtractionReasoner
} from "./extractor.js";
export { MemoryService } from "./service.js";
export {
  MissingDatabaseUrlError,
  parseDotEnv,
  readSqlMigrations,
  resolveDatabaseUrl,
  runPostgresMigrations,
  type SqlMigration
} from "./migrations.js";
