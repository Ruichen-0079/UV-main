import fs from "node:fs";
import path from "node:path";

/**
 * Load root .env then .env.local (local overrides).
 * Does not log values. Shell env wins over .env but loses to .env.local for
 * development parity with scripts/dev.ps1 (shell preserved over base .env).
 */
export function loadYuviEnvFiles(repositoryRoot: string): Record<string, string> {
  const result: Record<string, string> = {};
  const base = readEnvFile(path.join(repositoryRoot, ".env"));
  Object.assign(result, base);
  // Preserve process env over base .env
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") result[key] = value;
  }
  const local = readEnvFile(path.join(repositoryRoot, ".env.local"));
  Object.assign(result, local);
  return result;
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf("=");
    if (sep <= 0) continue;
    const name = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

export function envFlag(env: Record<string, string>, key: string, defaultValue: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function envString(env: Record<string, string>, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}
