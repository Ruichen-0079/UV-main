import type { MemoryRecord, RetrievedMemoryDebug } from "./api/client.js";

export function formatRankComponents(rank: NonNullable<RetrievedMemoryDebug["rankComponents"]>): string {
  return Object.entries(rank)
    .filter(([, value]) => typeof value === "number" && value > 0)
    .map(([key, value]) => `${key.replace(/Score$/, "")}:${Number(value).toFixed(1)}`)
    .join(" · ");
}

export function memoryPreview(memory: MemoryRecord): string {
  const text = (memory.summary || memory.content).replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

export function formatScope(memory: MemoryRecord): string {
  return `${memory.scope ?? "user"}${memory.scopeId ? `/${memory.scopeId}` : ""}`;
}

export function shortTrace(value: string | undefined): string {
  return value ? value.slice(0, 8) : "unknown";
}
