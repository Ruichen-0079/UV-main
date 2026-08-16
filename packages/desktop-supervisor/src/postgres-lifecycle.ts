/**
 * High-level private PostgreSQL lifecycle used by DesktopSupervisor.
 * Does not start Runtime or apply Yuvi schema migrations.
 */
import {
  persistDevelopmentPasswordFile,
  resolvePostgresPassword,
  generatePostgresPassword,
  type PostgresSecretAuthority
} from "./postgres-secret.js";
import {
  initializePrivateCluster,
  inspectExistingCluster,
  writeLocalOnlyConfig
} from "./postgres-cluster.js";
import { selectPrivatePostgresPort } from "./postgres-port.js";
import {
  PRIVATE_POSTGRES_HOST,
  PRIVATE_POSTGRES_MAJOR,
  assertPgdataContained,
  ensurePostgresDirectories,
  readClusterMarker,
  readInitializationState,
  readListenMetadata,
  writeListenMetadata,
  type PostgresInitializationStateName,
  type PostgresLayout,
  type PostgresListenMetadata,
  type YuviClusterMarker
} from "./postgres-layout.js";
import type { PostgresDistribution } from "./postgres-distribution.js";
import type { ProcessInspectionResult, ProcessMetadata, StartCommandSpec } from "./types.js";
import { buildPostgresStartCommand } from "./postgres-cluster.js";
import { evaluatePostgresOwnership, stopPrivatePostgresIfOwned } from "./postgres-ownership.js";

export type PrivatePostgresPrepareResult =
  | {
      ok: true;
      layout: PostgresLayout;
      distribution: PostgresDistribution;
      marker: YuviClusterMarker;
      listen: PostgresListenMetadata;
      startCommand: StartCommandSpec;
      initializedNow: boolean;
      password: string;
      persistListen: boolean;
    }
  | {
      ok: false;
      code: string;
      message: string;
      layout: PostgresLayout;
    };

export async function preparePrivatePostgres(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  env: Record<string, string | undefined>;
  authority?: PostgresSecretAuthority;
  ownedPort?: number | null | undefined;
  skipPortPersistence?: boolean;
}): Promise<PrivatePostgresPrepareResult> {
  try {
    assertPgdataContained(input.layout);
  } catch (error) {
    return {
      ok: false,
      code: "POSTGRES_PGDATA_OUTSIDE_ROOT",
      message: error instanceof Error ? error.message : "PGDATA is not contained",
      layout: input.layout
    };
  }

  const inspected = inspectExistingCluster(input.layout);
  if (!inspected.ok) {
    return {
      ok: false,
      code: inspected.code,
      message: inspected.message,
      layout: input.layout
    };
  }

  const authority = input.authority ?? "development-file";
  let password = resolvePostgresPassword(input.layout, input.env, authority);
  if (!password) {
    if (authority === "credential-manager") {
      return {
        ok: false,
        code: "POSTGRES_SECRET_UNAVAILABLE",
        message:
          "Packaged private PostgreSQL password is missing from Credential Manager / YUVI_POSTGRES_PASSWORD.",
        layout: input.layout
      };
    }
    password = generatePostgresPassword();
  }

  if (!inspected.initialized) {
    ensurePostgresDirectories(input.layout);
    const listen = await selectPrivatePostgresPort({
      layout: input.layout,
      clusterId: inspected.marker.clusterId,
      ownedPort: input.ownedPort
    });
    if (authority === "development-file") {
      persistDevelopmentPasswordFile(input.layout, password);
    }
    const initialized = initializePrivateCluster({
      layout: input.layout,
      distribution: input.distribution,
      password,
      port: listen.port
    });
    if (!initialized.ok) {
      return {
        ok: false,
        code: initialized.code,
        message: initialized.message,
        layout: input.layout
      };
    }
    return {
      ok: true,
      layout: input.layout,
      distribution: input.distribution,
      marker: initialized.marker,
      listen,
      startCommand: buildPostgresStartCommand(
        input.layout,
        input.distribution,
        listen.port,
        initialized.marker.clusterId
      ),
      initializedNow: true,
      password,
      persistListen: false
    };
  }

  writeLocalOnlyConfig(
    input.layout,
    input.ownedPort ?? readListenMetadata(input.layout)?.port ?? 55432
  );
  if (authority === "development-file") {
    persistDevelopmentPasswordFile(input.layout, password);
  }
  const persisted = readListenMetadata(input.layout);
  const listen: PostgresListenMetadata =
    input.ownedPort && Number.isInteger(input.ownedPort)
      ? {
          schemaVersion: 1,
          host: PRIVATE_POSTGRES_HOST,
          port: input.ownedPort,
          clusterId: inspected.marker.clusterId,
          postgresMajor: PRIVATE_POSTGRES_MAJOR
        }
      : persisted && persisted.clusterId === inspected.marker.clusterId
        ? persisted
        : await selectPrivatePostgresPort({
            layout: input.layout,
            clusterId: inspected.marker.clusterId,
            persisted: null,
            ownedPort: input.ownedPort
          });

  return {
    ok: true,
    layout: input.layout,
    distribution: input.distribution,
    marker: inspected.marker,
    listen,
    startCommand: buildPostgresStartCommand(
      input.layout,
      input.distribution,
      listen.port,
      inspected.marker.clusterId
    ),
    initializedNow: false,
    password,
    persistListen: false
  };
}

export function publishListenMetadata(
  layout: PostgresLayout,
  listen: PostgresListenMetadata
): void {
  writeListenMetadata(layout, listen);
}

export function adoptSurvivingPostgres(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  processInspection: ProcessInspectionResult;
  metadata: ProcessMetadata | null;
}):
  | { adopted: true; evidence: ReturnType<typeof evaluatePostgresOwnership> }
  | { adopted: false; reason: string } {
  const evidence = evaluatePostgresOwnership({
    layout: input.layout,
    distribution: input.distribution,
    processInspection: input.processInspection,
    metadata: input.metadata,
    requirePreviousMetadata: true
  });
  if (!evidence.owned) {
    return { adopted: false, reason: evidence.reason };
  }
  return { adopted: true, evidence };
}

export function postgresDiagnostics(input: {
  mode: "private" | "external";
  layout: PostgresLayout | null;
  distributionError?: string | null | undefined;
  ownership: "owned" | "external" | "none";
  status: string;
}): PostgresDiagnostics {
  const marker = input.layout ? readClusterMarker(input.layout) : null;
  const listen = input.layout ? readListenMetadata(input.layout) : null;
  const init = input.layout ? readInitializationState(input.layout) : null;
  return {
    mode: input.mode,
    status: input.status,
    host: listen?.host ?? (input.mode === "private" ? PRIVATE_POSTGRES_HOST : null),
    port: listen?.port ?? null,
    postgresMajor:
      marker?.postgresMajor ?? (input.mode === "private" ? PRIVATE_POSTGRES_MAJOR : null),
    clusterId: marker?.clusterId ?? null,
    dataDirectory: input.layout?.data ?? null,
    dataDirectoryKind: input.layout ? "yuvi-local" : "none",
    initializationState: init?.state ?? (input.mode === "private" ? "missing" : null),
    ownership: input.ownership,
    distributionError: input.distributionError ?? null
  };
}

export type PostgresDiagnostics = {
  mode: "private" | "external";
  status: string;
  host: string | null;
  port: number | null;
  postgresMajor: number | null;
  clusterId: string | null;
  dataDirectory: string | null;
  dataDirectoryKind: "yuvi-local" | "none";
  initializationState: PostgresInitializationStateName | null;
  ownership: "owned" | "external" | "none";
  distributionError: string | null;
};

export { stopPrivatePostgresIfOwned };
