import path from "node:path";

export function canonicalPath(input: string): string {
  try {
    return path.resolve(input).replace(/[\\/]+$/, "");
  } catch {
    return input.replace(/[\\/]+$/, "");
  }
}

export function defaultStateDirectory(): string {
  const local = process.env["LOCALAPPDATA"];
  if (local && local.trim()) {
    return path.join(local, "YUVI", "DesktopSupervisor");
  }
  return path.join(process.cwd(), ".yuvi-desktop-supervisor");
}

export function parseUrlOrigin(url: string): { host: string; port: number; origin: string } | null {
  try {
    const parsed = new URL(url);
    const port =
      parsed.port !== ""
        ? Number(parsed.port)
        : parsed.protocol === "https:"
          ? 443
          : 80;
    if (!Number.isFinite(port)) return null;
    return {
      host: parsed.hostname || "127.0.0.1",
      port,
      origin: `${parsed.protocol}//${parsed.host}`
    };
  } catch {
    return null;
  }
}
