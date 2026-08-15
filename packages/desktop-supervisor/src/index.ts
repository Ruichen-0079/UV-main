export type {
  HealthProbeResult,
  ManagedServiceSpec,
  Mem0Manifest,
  OwnershipResult,
  OwnershipStatus,
  ProcessInfo,
  ProcessMetadata,
  RuntimeConfigUpdate,
  RuntimeConfigUpdateResult,
  RuntimeManifest,
  ServiceId,
  ServiceLifecycle,
  ServiceOwnership,
  ServiceSnapshot,
  StartCommandSpec,
  SupervisorConfig,
  SupervisorLayout,
  SupervisorSnapshot
} from "./types.js";

export {
  loadSupervisorConfig,
  loadPackagedSupervisorConfig,
  generateControlToken,
  assertLoopbackHost,
  deriveConfigFromEnv,
  buildChildProcessEnv,
  resolvePackagedLive2DEnv,
  resolvePackagedMem0Start,
  resolvePackagedRuntimeStart,
  resolveRuntimeStartForLayout
} from "./config.js";
export {
  readRuntimeManifest,
  validateRuntimeManifest,
  resolveManifestFile
} from "./runtime-manifest.js";
export {
  readMem0Manifest,
  validateMem0Manifest,
  resolveMem0ManifestExecutable
} from "./mem0-manifest.js";
export { loadYuviEnvFiles, envFlag, envString } from "./env.js";
export {
  probeHttpHealth,
  probeTcp,
  runtimeHealthOk,
  mem0HealthOk,
  ttsWrapperHealthOk,
  ollamaTagsOk
} from "./health.js";
export {
  PROCESS_METADATA_VERSION,
  readProcessMetadata,
  writeProcessMetadata,
  removeMetadataFile,
  testProcessOwnership,
  shouldRemoveInvalidMetadata
} from "./ownership.js";
export {
  getProcessInfo,
  isProcessAlive,
  spawnManagedProcess,
  requestGracefulStop,
  forceKillProcessTree,
  stopProcessTree
} from "./process-windows.js";
export {
  canonicalPath,
  commandLineContainsPath,
  defaultStateDirectory,
  defaultYuviLocalDataRoot,
  isWindowsStylePath,
  parseUrlOrigin,
  pathsEqual
} from "./paths.js";
export {
  PRIVATE_POSTGRES_DATABASE,
  PRIVATE_POSTGRES_HOST,
  PRIVATE_POSTGRES_MAJOR,
  PRIVATE_POSTGRES_PREFERRED_PORT,
  PRIVATE_POSTGRES_USER,
  createClusterMarker,
  describeEscapedPgdata,
  describeUnsafePostgresDataRoot,
  layoutFromRoot,
  readClusterMarker,
  resolvePostgresLayout,
  restrictPathToCurrentUser,
  writeClusterMarker,
  writeInitializationState
} from "./postgres-layout.js";
export {
  resolvePostgresDistribution,
  resolvePostgresHome,
  inspectPostgresMajor,
  parsePostgresVersionText
} from "./postgres-distribution.js";
export {
  POSTGRES_PASSWORD_ENV,
  POSTGRES_SECRET_KEY,
  generatePostgresPassword,
  redactSecretText
} from "./postgres-secret.js";
export { selectPrivatePostgresPort } from "./postgres-port.js";
export {
  inspectExistingCluster,
  initializePrivateCluster,
  writeLocalOnlyConfig,
  buildPostgresStartCommand,
  execAuthenticatedSql
} from "./postgres-cluster.js";
export {
  evaluatePostgresOwnership,
  parsePostgresArgv,
  stopPrivatePostgresIfOwned
} from "./postgres-ownership.js";
export { preparePrivatePostgres, postgresDiagnostics } from "./postgres-lifecycle.js";
export { resolvePostgresMode } from "./config.js";
export { DesktopSupervisor } from "./supervisor.js";
export {
  buildPrivateDatabaseUrl,
  migrateSupervisorPostgres,
  migrateSupervisorTarget,
  migrationSettingsFromEnv,
  resolveSupervisorMigrationTarget
} from "./postgres-migrate.js";
export type {
  SupervisorMigrateInput,
  SupervisorMigrateResult,
  SupervisorMigrationTarget
} from "./postgres-migrate.js";
export {
  startSupervisorHttpServer,
  extractControlToken,
  tokensMatch,
  CONTROL_TOKEN_HEADER
} from "./http-server.js";
export type { ControlEndpointFile } from "./types.js";
