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
  LocalSttManifest,
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
  resolvePackagedLocalSttStart,
  resolvePackagedMem0Start,
  resolvePackagedRuntimeStart,
  resolveRuntimeStartForLayout,
  resolveMem0Start,
  resolveMem0StartDetailed,
  resolveMem0VenvInterpreter,
  defaultMem0InterpreterPreflight,
  MEM0_DEV_ENV_SETUP_HINT
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
export {
  readLocalSttManifest,
  validateLocalSttManifest,
  resolveLocalSttManifestExecutable,
  resolveLocalSttManifestPath
} from "./local-stt-manifest.js";
export { loadYuviEnvFiles, envFlag, envString } from "./env.js";
export {
  probeHttpHealth,
  probeTcp,
  runtimeHealthOk,
  mem0HealthOk,
  ttsWrapperHealthOk,
  ollamaTagsOk,
  localSttHealthOk
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
  stopProcessTree,
  ownedUnixProcessGroup
} from "./process-windows.js";
export {
  SUPERVISOR_INSTANCE_LOCK_FILE,
  SupervisorInstanceLockError,
  acquireSupervisorInstanceLock
} from "./instance-lock.js";
export type { SupervisorInstanceLock } from "./instance-lock.js";
export {
  YUVI_APP_IDENTIFIER,
  defaultYuviLocalDataRoot,
  resolveAppRoots
} from "./app-roots.js";
export type { AppRoots } from "./app-roots.js";
export {
  canonicalPath,
  commandLineContainsPath,
  defaultStateDirectory,
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
export {
  buildPrivatePostgresDatabaseUrl,
  preparePrivatePostgres,
  postgresDiagnostics
} from "./postgres-lifecycle.js";
export { resolvePostgresMode } from "./config.js";
export { DesktopSupervisor } from "./supervisor.js";
export {
  startSupervisorHttpServer,
  extractControlToken,
  tokensMatch,
  CONTROL_TOKEN_HEADER
} from "./http-server.js";
export type { ControlEndpointFile } from "./types.js";
