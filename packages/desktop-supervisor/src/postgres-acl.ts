/**
 * Fail-closed permission adapter for private PostgreSQL state.
 * Windows uses icacls with argv (no shell). POSIX uses fchmod-at-create + chmod.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export type WindowsAccountIdentity = {
  identity: string;
  source: "username" | "userdomain-username";
};

export type WindowsAclApplyResult = {
  ok: boolean;
  detail: string;
  status: number | null;
};

export type WindowsAclAdapter = {
  resolveAccount(): WindowsAccountIdentity | null;
  applyRestrictedAcl(targetPath: string, identity: string): WindowsAclApplyResult;
};

export class RestrictedAclError extends Error {
  readonly code = "POSTGRES_ACL_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "RestrictedAclError";
  }
}

export function resolveWindowsAccountIdentity(
  env: Record<string, string | undefined> = process.env
): WindowsAccountIdentity | null {
  const user = env["USERNAME"]?.trim() || env["USER"]?.trim();
  if (!user) return null;
  const domain = env["USERDOMAIN"]?.trim();
  if (domain && !user.includes("\\") && domain.toUpperCase() !== "UNKNOWN") {
    return { identity: `${domain}\\${user}`, source: "userdomain-username" };
  }
  return { identity: user, source: "username" };
}

export function aclGrantArguments(targetPath: string, identity: string): string[] {
  return [targetPath, "/inheritance:r", "/grant:r", `${identity}:(F)`];
}

export function createDefaultWindowsAclAdapter(
  env: Record<string, string | undefined> = process.env
): WindowsAclAdapter {
  return {
    resolveAccount() {
      return resolveWindowsAccountIdentity(env);
    },
    applyRestrictedAcl(targetPath: string, identity: string) {
      const args = aclGrantArguments(targetPath, identity);
      try {
        const result = spawnSync("icacls", args, {
          windowsHide: true,
          timeout: 8_000,
          encoding: "utf8",
          shell: false
        });
        if (result.error) {
          return {
            ok: false,
            detail: result.error.message,
            status: result.status
          };
        }
        if (result.status !== 0) {
          const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
          return {
            ok: false,
            detail: output || `icacls exited ${result.status}`,
            status: result.status
          };
        }
        return { ok: true, detail: "ok", status: result.status };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "icacls threw",
          status: null
        };
      }
    }
  };
}

export function applyRestrictedPermissions(
  targetPath: string,
  options: { adapter?: WindowsAclAdapter; platform?: NodeJS.Platform } = {}
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      const stat = fs.statSync(targetPath);
      fs.chmodSync(targetPath, stat.isDirectory() ? 0o700 : 0o600);
    } catch (error) {
      throw new RestrictedAclError(
        `Failed to restrict POSIX mode on ${targetPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return;
  }
  const adapter = options.adapter ?? createDefaultWindowsAclAdapter();
  const account = adapter.resolveAccount();
  if (!account) {
    throw new RestrictedAclError(
      "Cannot restrict private PostgreSQL ACL: no Windows account identity (USERNAME/USERDOMAIN)."
    );
  }
  const applied = adapter.applyRestrictedAcl(targetPath, account.identity);
  if (!applied.ok) {
    throw new RestrictedAclError(
      `Failed to restrict private PostgreSQL ACL on ${targetPath}: ${applied.detail}`
    );
  }
}

export function writeRestrictedFile(filePath: string, contents: string): void {
  const directory = require("node:path").dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  applyRestrictedPermissions(directory);
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o600 });
  applyRestrictedPermissions(filePath);
}
