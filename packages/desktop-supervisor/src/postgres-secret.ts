/**
 * Private-cluster password handling. Never persist a DATABASE_URL.
 * Packaged production: Credential Manager via YUVI_POSTGRES_PASSWORD only.
 * Development/test: optional runtime/local.secret fallback. No persistent pgpass.
 */
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { applyRestrictedPermissions } from "./postgres-acl.js";
import type { PostgresLayout } from "./postgres-layout.js";

export const POSTGRES_PASSWORD_ENV = "YUVI_POSTGRES_PASSWORD";
export const POSTGRES_SECRET_KEY = "postgres.localPassword";
export type PostgresSecretAuthority = "credential-manager" | "development-file";

export function generatePostgresPassword(): string {
  return randomBytes(32).toString("base64url");
}

export function resolvePostgresPassword(
  layout: PostgresLayout,
  env: Record<string, string | undefined>,
  authority: PostgresSecretAuthority = "development-file"
): string | null {
  const injected = env[POSTGRES_PASSWORD_ENV]?.trim();
  if (injected) return injected;
  if (authority === "credential-manager") return null;
  if (!fs.existsSync(layout.passwordFile)) return null;
  const raw = fs.readFileSync(layout.passwordFile, "utf8").trim();
  return raw || null;
}

export function persistDevelopmentPasswordFile(
  layout: PostgresLayout,
  password: string,
  options: {
    adapter?: import("./postgres-acl.js").WindowsAclAdapter;
    platform?: NodeJS.Platform;
  } = {}
): void {
  fs.mkdirSync(layout.runtime, { recursive: true });
  applyRestrictedPermissions(layout.runtime, options);
  fs.writeFileSync(layout.passwordFile, `${password}\n`, { encoding: "utf8", mode: 0o600 });
  applyRestrictedPermissions(layout.passwordFile, options);
}

/** @deprecated Packaged production must not persist filesystem secrets. */
export function persistPostgresPassword(layout: PostgresLayout, password: string): void {
  persistDevelopmentPasswordFile(layout, password);
}

export function redactSecretText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/(DATABASE_URL|PGPASSWORD|YUVI_POSTGRES_PASSWORD)=([^\s]+)/giu, "$1=[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "postgres://[REDACTED]");
}

export function containsSecret(text: string, secrets: string[]): boolean {
  return secrets.some((secret) => Boolean(secret) && text.includes(secret));
}
