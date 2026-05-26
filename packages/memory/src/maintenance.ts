import type { MemoryRepository } from "./repository.js";
import type { Memory, MemoryScope } from "./types.js";

export type MemoryMaintenanceOptions = {
  dryRun?: boolean;
  limit?: number;
  scope?: MemoryScope;
  scopeId?: string;
  now?: Date | string;
  includeArchived?: boolean;
  includeSuperseded?: boolean;
};

export type MemoryMaintenanceWarning = {
  memoryId: string;
  kind: "active-has-supersededBy" | "superseded-missing-supersededAt" | "supersedes-missing-memory";
  message: string;
  relatedId?: string | undefined;
  fixed?: boolean | undefined;
};

export type MemoryMaintenanceSummary = {
  dryRun: boolean;
  scanned: number;
  expired: number;
  stale: number;
  supersessionWarnings: number;
  skipped: number;
  failed: number;
  expiredIds: string[];
  staleIds: string[];
  warnings: MemoryMaintenanceWarning[];
};

export type MemoryHealthSummary = {
  scanned: number;
  active: number;
  expired: number;
  archived: number;
  superseded: number;
  forgotten: number;
  staleEpisodic: number;
  missingEmbedding: number;
};

const DEFAULT_LIMIT = 100;

export class MemoryMaintenanceService {
  constructor(private readonly repository: MemoryRepository) {}

  async run(options: MemoryMaintenanceOptions = {}): Promise<MemoryMaintenanceSummary> {
    const dryRun = Boolean(options.dryRun);
    const now = toDate(options.now) ?? new Date();
    const memories = await this.listMaintenanceMemories(options);
    const summary: MemoryMaintenanceSummary = {
      dryRun,
      scanned: memories.length,
      expired: 0,
      stale: 0,
      supersessionWarnings: 0,
      skipped: 0,
      failed: 0,
      expiredIds: [],
      staleIds: [],
      warnings: []
    };

    for (const memory of memories) {
      if (memory.status === "archived" && !options.includeArchived) {
        summary.skipped += 1;
        continue;
      }

      try {
        const auditFixed = await this.auditSupersession(memory, now, dryRun, summary);
        if (auditFixed) {
          continue;
        }

        if (isExpiredActiveMemory(memory, now)) {
          summary.expired += 1;
          summary.expiredIds.push(memory.id);
          if (!dryRun) {
            await this.repository.updateMemory(memory.id, {
              status: "expired",
              metadata: {
                ...memory.metadata,
                maintenanceReason: "expiresAt elapsed",
                expiredByMaintenance: true
              }
            });
          }
          continue;
        }

        if (isStaleEpisodicMemory(memory, now)) {
          summary.stale += 1;
          summary.staleIds.push(memory.id);
          if (!dryRun && memory.metadata["staleByValidity"] !== true) {
            await this.repository.updateMemory(memory.id, {
              metadata: {
                ...memory.metadata,
                maintenanceReason: "validUntil elapsed",
                staleByValidity: true
              }
            });
          }
        }
      } catch {
        summary.failed += 1;
      }
    }

    return summary;
  }

  async getHealth(options: MemoryMaintenanceOptions = {}): Promise<MemoryHealthSummary> {
    const now = toDate(options.now) ?? new Date();
    const memories = await this.listMaintenanceMemories({
      ...options,
      includeArchived: true,
      includeSuperseded: true
    });
    return {
      scanned: memories.length,
      active: memories.filter((memory) => memory.status === "active").length,
      expired: memories.filter((memory) => memory.status === "expired").length,
      archived: memories.filter((memory) => memory.status === "archived").length,
      superseded: memories.filter((memory) => memory.status === "superseded").length,
      forgotten: memories.filter((memory) => memory.status === "forgotten").length,
      staleEpisodic: memories.filter((memory) => isStaleEpisodicMemory(memory, now)).length,
      missingEmbedding: memories.filter((memory) => memory.status === "active" && !memory.embedding)
        .length
    };
  }

  private async listMaintenanceMemories(options: MemoryMaintenanceOptions): Promise<Memory[]> {
    return this.repository.searchMemoriesByTextFallback({
      text: "",
      includeHistory: true,
      includeExpired: true,
      includeArchived: true,
      includeSuperseded: true,
      limit: options.limit ?? DEFAULT_LIMIT,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.scopeId ? { scopeId: options.scopeId } : {})
    });
  }

  private async auditSupersession(
    memory: Memory,
    now: Date,
    dryRun: boolean,
    summary: MemoryMaintenanceSummary
  ): Promise<boolean> {
    if (memory.status === "active" && memory.supersededBy) {
      summary.supersessionWarnings += 1;
      summary.warnings.push({
        memoryId: memory.id,
        relatedId: memory.supersededBy,
        kind: "active-has-supersededBy",
        message: "Active memory has supersededBy set.",
        fixed: !dryRun
      });
      if (!dryRun) {
        await this.repository.updateMemory(memory.id, {
          status: "superseded",
          supersededAt: memory.supersededAt ?? now,
          metadata: {
            ...memory.metadata,
            maintenanceReason: "supersededBy present",
            supersededByMaintenance: true
          }
        });
      }
      return true;
    }

    if (memory.status === "superseded" && !memory.supersededAt) {
      summary.supersessionWarnings += 1;
      summary.warnings.push({
        memoryId: memory.id,
        kind: "superseded-missing-supersededAt",
        message: "Superseded memory is missing supersededAt.",
        fixed: !dryRun
      });
      if (!dryRun) {
        await this.repository.updateMemory(memory.id, {
          supersededAt: now,
          metadata: {
            ...memory.metadata,
            maintenanceReason: "supersededAt missing",
            supersededAtByMaintenance: true
          }
        });
      }
    }

    for (const relatedId of memory.supersedes) {
      const related = await this.repository.getMemoryById(relatedId);
      if (!related) {
        summary.supersessionWarnings += 1;
        summary.warnings.push({
          memoryId: memory.id,
          relatedId,
          kind: "supersedes-missing-memory",
          message: "Memory supersedes an unknown or deleted memory id.",
          fixed: false
        });
      }
    }

    return false;
  }
}

export async function runMemoryMaintenance(
  repository: MemoryRepository,
  options: MemoryMaintenanceOptions = {}
): Promise<MemoryMaintenanceSummary> {
  return new MemoryMaintenanceService(repository).run(options);
}

export async function getMemoryHealth(
  repository: MemoryRepository,
  options: MemoryMaintenanceOptions = {}
): Promise<MemoryHealthSummary> {
  return new MemoryMaintenanceService(repository).getHealth(options);
}

function isExpiredActiveMemory(memory: Memory, now: Date): boolean {
  return (
    memory.status === "active" &&
    Boolean(memory.expiresAt) &&
    memory.expiresAt!.getTime() <= now.getTime()
  );
}

function isStaleEpisodicMemory(memory: Memory, now: Date): boolean {
  return (
    memory.status === "active" &&
    memory.type === "episodic" &&
    memory.memoryLayer === "recall" &&
    Boolean(memory.validUntil) &&
    memory.validUntil!.getTime() <= now.getTime()
  );
}

function toDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
