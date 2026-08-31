import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { LocalAiResourceUsage } from "./types.js";

const empty: LocalAiResourceUsage = {
  rssBytes: null,
  cpuPercent: null,
  gpuVramBytes: null,
  threads: null
};

export function sampleProcessResources(pid: number | null): LocalAiResourceUsage {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return { ...empty };
  const usage = samplePosix(pid);
  usage.gpuVramBytes = sampleGpuVramForPid(pid);
  return usage;
}

export function mergeResources(parts: LocalAiResourceUsage[]): LocalAiResourceUsage {
  const sum = (pick: (item: LocalAiResourceUsage) => number | null): number | null => {
    let total = 0;
    let any = false;
    for (const part of parts) {
      const value = pick(part);
      if (value == null) continue;
      total += value;
      any = true;
    }
    return any ? total : null;
  };
  return {
    rssBytes: sum((item) => item.rssBytes),
    cpuPercent: sum((item) => item.cpuPercent),
    gpuVramBytes: sum((item) => item.gpuVramBytes),
    threads: sum((item) => item.threads)
  };
}

function samplePosix(pid: number): LocalAiResourceUsage {
  if (process.platform === "win32") return { ...empty };
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
    const rssPages = Number(statm[1] ?? "0");
    const pageSize = 4096;
    const rssBytes = Number.isFinite(rssPages) ? rssPages * pageSize : parseKb(status, "VmRSS");
    const threads = parseStatusInt(status, "Threads");
    return {
      rssBytes,
      cpuPercent: null,
      gpuVramBytes: null,
      threads
    };
  } catch {
    return { ...empty };
  }
}

function parseKb(status: string, key: string): number | null {
  const match = status.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
  if (!match?.[1]) return null;
  return Number(match[1]) * 1024;
}

function parseStatusInt(status: string, key: string): number | null {
  const match = status.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) ? n : null;
}

function sampleGpuVramForPid(pid: number): number | null {
  const result = spawnSync(
    "nvidia-smi",
    ["--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"],
    { encoding: "utf8", timeout: 2_000, windowsHide: true }
  );
  if (result.status !== 0 || !result.stdout) return null;
  let total = 0;
  let hit = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    const [rawPid, rawMiB] = line.split(",").map((part) => part.trim());
    if (Number(rawPid) !== pid) continue;
    const miB = Number(rawMiB);
    if (!Number.isFinite(miB)) continue;
    total += Math.round(miB * 1024 * 1024);
    hit = true;
  }
  return hit ? total : null;
}

export function sampleGpuVramTotalUsed(): number | null {
  const result = spawnSync(
    "nvidia-smi",
    ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
    { encoding: "utf8", timeout: 2_000, windowsHide: true }
  );
  if (result.status !== 0 || !result.stdout) return null;
  const miB = Number(result.stdout.trim().split(/\r?\n/)[0]);
  return Number.isFinite(miB) ? Math.round(miB * 1024 * 1024) : null;
}
