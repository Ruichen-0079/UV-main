import {
  MEMORY_INGESTION_DIAGNOSTICS_UNAVAILABLE,
  type MemoryIngestionCoordinator,
  type MemoryIngestionCoordinatorDiagnostics,
  type MemoryIngestionCoordinatorStatus
} from "@companion/memory";

export type MemoryIngestionHealthSnapshot = {
  status: MemoryIngestionCoordinatorStatus | "unavailable";
  ownerId: string | null;
  diagnosticsAvailability: MemoryIngestionCoordinatorDiagnostics["diagnosticsAvailability"];
  diagnosticsErrorCode: string | null;
  diagnosticsError: string | null;
  pendingCount: number | null;
  processingCount: number | null;
  retryableFailedCount: number | null;
  dueRetryCount: number | null;
  reconcileRequiredCount: number | null;
  partialCount: number | null;
  terminalFailedCount: number | null;
  staleLeaseCount: number | null;
  historicalUnknownCount: number | null;
  activeWorkerCount: number | null;
  lastScanAt: string | null;
  lastSuccessfulExecutionAt: string | null;
  lastError: string | null;
};

export async function readMemoryIngestionDiagnostics(
  coordinator: Pick<MemoryIngestionCoordinator, "getDiagnostics" | "getStatus" | "getOwnerId">
): Promise<MemoryIngestionCoordinatorDiagnostics> {
  try {
    return await coordinator.getDiagnostics();
  } catch (error) {
    let status: MemoryIngestionCoordinatorStatus | undefined;
    let ownerId: string | undefined;
    try {
      status = coordinator.getStatus();
      ownerId = coordinator.getOwnerId();
    } catch {
      // Coordinator local status is also unavailable.
    }
    return {
      pendingCount: null,
      processingCount: null,
      retryableFailedCount: null,
      dueRetryCount: null,
      reconcileRequiredCount: null,
      completeCount: null,
      unchangedCount: null,
      skippedCount: null,
      terminalFailedCount: null,
      partialParentCount: null,
      staleLeaseCount: null,
      historicalUnknownCount: null,
      diagnosticsAvailability: status === undefined ? "unavailable" : "error",
      diagnosticsErrorCode: MEMORY_INGESTION_DIAGNOSTICS_UNAVAILABLE,
      diagnosticsError: sanitizeDiagnosticsError(error),
      activeWorkerCount: null,
      lastScanAt: null,
      lastSuccessfulExecutionAt: null,
      lastError: sanitizeDiagnosticsError(error),
      status: status ?? "idle",
      ownerId: ownerId ?? ""
    };
  }
}

export function toMemoryIngestionHealthSnapshot(
  diagnostics: MemoryIngestionCoordinatorDiagnostics
): MemoryIngestionHealthSnapshot {
  return {
    status: diagnostics.status,
    ownerId: diagnostics.ownerId || null,
    diagnosticsAvailability: diagnostics.diagnosticsAvailability,
    diagnosticsErrorCode: diagnostics.diagnosticsErrorCode,
    diagnosticsError: diagnostics.diagnosticsError,
    pendingCount: diagnostics.pendingCount,
    processingCount: diagnostics.processingCount,
    retryableFailedCount: diagnostics.retryableFailedCount,
    dueRetryCount: diagnostics.dueRetryCount,
    reconcileRequiredCount: diagnostics.reconcileRequiredCount,
    partialCount: diagnostics.partialParentCount,
    terminalFailedCount: diagnostics.terminalFailedCount,
    staleLeaseCount: diagnostics.staleLeaseCount,
    historicalUnknownCount: diagnostics.historicalUnknownCount,
    activeWorkerCount: diagnostics.activeWorkerCount,
    lastScanAt: diagnostics.lastScanAt,
    lastSuccessfulExecutionAt: diagnostics.lastSuccessfulExecutionAt,
    lastError: diagnostics.lastError
  };
}

function sanitizeDiagnosticsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(DATABASE_URL|API_KEY|TOKEN|SECRET|PASSWORD)=([^\s]+)/giu, "$1=[REDACTED]")
    .slice(0, 300);
}
