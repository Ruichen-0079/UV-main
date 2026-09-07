export const DAILY_STATUS_PATH = "/yuvi-daily/status";
export const DAILY_SERVICE_IDS = ["postgres", "ollama", "mem0", "runtime"] as const;
export const DAILY_SERVICE_STATES = [
  "starting",
  "healthy",
  "degraded",
  "unavailable",
  "stopped",
  "restarting"
] as const;
export type DailyServiceStatus = {
  checkedAt: string;
  services: Array<{
    id: (typeof DAILY_SERVICE_IDS)[number];
    status: (typeof DAILY_SERVICE_STATES)[number];
    managed: boolean;
  }>;
};

/** Allowlist only: no URLs, errors, process details, tokens or Memory payloads. */
export function projectDailyServiceStatus(value: unknown): DailyServiceStatus {
  const snapshot = value as { services?: unknown } | null;
  if (!Array.isArray(snapshot?.services)) throw new Error("Invalid supervisor status");
  const services = snapshot.services;
  let oldestCheck = Infinity;
  const projected = DAILY_SERVICE_IDS.map((id) => {
    const service = services.find((entry: any) => entry?.id === id);
    if (
      !service ||
      !DAILY_SERVICE_STATES.includes(service.status) ||
      typeof service.managed !== "boolean" ||
      typeof service.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(service.checkedAt))
    )
      throw new Error("Invalid service status");
    oldestCheck = Math.min(oldestCheck, Date.parse(service.checkedAt));
    return { id, status: service.status, managed: service.managed };
  });
  return {
    checkedAt: new Date(oldestCheck).toISOString(),
    services: projected
  };
}
