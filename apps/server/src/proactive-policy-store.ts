import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRuntimeEnvDir } from "@companion/config";
import type { ProactivePolicySnapshot, RuntimeProactiveStateStore } from "@companion/core";

export function createFileProactiveStateStore(
  env: Record<string, string | undefined> = process.env
): RuntimeProactiveStateStore {
  const filePath = join(getRuntimeEnvDir(env), "proactive-policy.json");
  return {
    load(): ProactivePolicySnapshot | null {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return null;
        }
        return parsed as ProactivePolicySnapshot;
      } catch {
        return null;
      }
    },
    save(snapshot: ProactivePolicySnapshot): void {
      mkdirSync(dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      try {
        renameSync(tempPath, filePath);
      } catch {
        try {
          unlinkSync(tempPath);
        } catch {
          // Best-effort cleanup of the staging file.
        }
        throw new Error("Failed to persist Runtime proactive policy.");
      }
    }
  };
}
