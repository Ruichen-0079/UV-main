import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Lookup index only. Person meaning and binding validity remain Memory/P8 authority. */
export interface VoiceBindingReferences {
  load(scope: string): readonly string[];
  append(scope: string, eventId: string): void;
}
export function createFileVoiceBindingReferences(filePath: string): VoiceBindingReferences {
  function read(): Record<string, string[]> {
    try {
      const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.values(value).some(
          (ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)
        )
      )
        throw new Error("Invalid voice binding references");
      return value as Record<string, string[]>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  return {
    load: (scope) => read()[scope] ?? [],
    append(scope, eventId) {
      const values = read();
      values[scope] = [...new Set([...(values[scope] ?? []), eventId])];
      mkdirSync(dirname(filePath), { recursive: true });
      const temp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(values), { mode: 0o600 });
      renameSync(temp, filePath);
    }
  };
}
