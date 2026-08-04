import fs from "node:fs";
import path from "node:path";
import type { OwnershipResult, ProcessInfo, ProcessMetadata } from "./types.js";
import { canonicalPath } from "./paths.js";

export const PROCESS_METADATA_VERSION = 1 as const;

export function writeProcessMetadata(filePath: string, metadata: ProcessMetadata): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export function readProcessMetadata(filePath: string): ProcessMetadata | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ProcessMetadata;
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

export function removeMetadataFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/**
 * Validate ownership without trusting pid alone.
 * Mirrors scripts/lib/yuvi-process.ps1 rules + ownershipToken / instanceId.
 */
export function testProcessOwnership(input: {
  metadataPath: string;
  expectedRole: string;
  repositoryRoot: string;
  stateDirectory: string;
  ownershipToken: string;
  instanceId: string;
  processInfo: ProcessInfo | null;
}): OwnershipResult {
  if (!fs.existsSync(input.metadataPath)) {
    return { status: "missing", owned: false, processId: 0, message: "metadata missing", metadata: null };
  }

  const metadata = readProcessMetadata(input.metadataPath);
  if (!metadata) {
    return { status: "invalid", owned: false, processId: 0, message: "metadata is not valid JSON", metadata: null };
  }

  if (metadata.schemaVersion !== PROCESS_METADATA_VERSION) {
    return {
      status: "mismatch",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "schema version mismatch",
      metadata
    };
  }
  if (metadata.role !== input.expectedRole) {
    return {
      status: "mismatch",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "role mismatch",
      metadata
    };
  }
  if (canonicalPath(metadata.repositoryRoot) !== canonicalPath(input.repositoryRoot)) {
    return {
      status: "mismatch",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "repository root mismatch",
      metadata
    };
  }
  if (canonicalPath(metadata.stateDirectory) !== canonicalPath(input.stateDirectory)) {
    return {
      status: "mismatch",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "state directory mismatch",
      metadata
    };
  }
  if (
    !metadata.ownershipToken ||
    metadata.ownershipToken !== input.ownershipToken ||
    metadata.instanceId !== input.instanceId
  ) {
    return {
      status: "mismatch",
      owned: false,
      processId: metadata.pid ?? 0,
      message: "ownership token / instance mismatch",
      metadata
    };
  }

  const processId = Number(metadata.pid);
  if (!Number.isInteger(processId) || processId <= 0) {
    return { status: "invalid", owned: false, processId: 0, message: "pid invalid", metadata };
  }

  if (!input.processInfo) {
    return {
      status: "stale",
      owned: false,
      processId,
      message: "process is not running",
      metadata
    };
  }

  const marker = metadata.commandMarker ?? "";
  if (!marker || !input.processInfo.commandLine.includes(marker)) {
    return {
      status: "mismatch",
      owned: false,
      processId,
      message: "command marker mismatch",
      metadata
    };
  }

  const expectedRepo = canonicalPath(input.repositoryRoot);
  if (!input.processInfo.commandLine.toLowerCase().includes(expectedRepo.toLowerCase())) {
    // On Windows command lines may use different slash style; try both.
    const alt = expectedRepo.replaceAll("\\", "/");
    if (!input.processInfo.commandLine.toLowerCase().includes(alt.toLowerCase())) {
      return {
        status: "mismatch",
        owned: false,
        processId,
        message: "repository root not present in command line",
        metadata
      };
    }
  }

  if (input.processInfo.createdAtUtc && metadata.processStartedAtUtc) {
    const metaStart = Date.parse(metadata.processStartedAtUtc);
    const procStart = input.processInfo.createdAtUtc.getTime();
    if (Number.isFinite(metaStart) && Number.isFinite(procStart)) {
      if (Math.abs(procStart - metaStart) > 2_500) {
        return {
          status: "mismatch",
          owned: false,
          processId,
          message: "start time mismatch",
          metadata
        };
      }
    }
  }

  return {
    status: "running",
    owned: true,
    processId,
    message: "owned process is running",
    metadata
  };
}

export function shouldRemoveInvalidMetadata(result: OwnershipResult): boolean {
  return !result.owned && result.status !== "missing";
}
