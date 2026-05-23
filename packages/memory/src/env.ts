export type MemoryRepositoryKind = "in-memory" | "postgres";

export type MemoryRepositorySelection = {
  kind: MemoryRepositoryKind;
  envValue: "in-memory" | "memory" | "postgres";
};

export function parseMemoryRepositoryEnv(
  env: Record<string, string | undefined> = process.env
): MemoryRepositorySelection {
  const rawValue = env["MEMORY_REPOSITORY"]?.trim();
  const normalized = rawValue?.toLowerCase();

  if (!normalized || normalized === "in-memory" || normalized === "memory") {
    return { kind: "in-memory", envValue: normalized === "memory" ? "memory" : "in-memory" };
  }

  if (normalized === "postgres") {
    return { kind: "postgres", envValue: "postgres" };
  }

  throw new Error(
    `Invalid MEMORY_REPOSITORY value '${rawValue}'. Valid values are: in-memory, memory, postgres.`
  );
}
