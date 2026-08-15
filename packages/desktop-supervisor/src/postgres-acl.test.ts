import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRestrictedPermissions,
  createDefaultWindowsAclAdapter,
  RestrictedAclError,
  resolveWindowsAccountIdentity
} from "./postgres-acl.js";
import { persistDevelopmentPasswordFile } from "./postgres-secret.js";
import { layoutFromRoot } from "./postgres-layout.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("windows ACL adapter", () => {
  it("fails closed when account identity is missing", () => {
    expect(resolveWindowsAccountIdentity({})).toBeNull();
    expect(() =>
      applyRestrictedPermissions("/tmp/unused", {
        platform: "win32",
        adapter: {
          resolveAccount: () => null,
          applyRestrictedAcl: () => ({ ok: true, detail: "ok", status: 0 })
        }
      })
    ).toThrow(RestrictedAclError);
  });

  it("fails closed when icacls is unavailable or non-zero", () => {
    const adapter = {
      resolveAccount: () => ({ identity: "alice", source: "username" as const }),
      applyRestrictedAcl: () => ({ ok: false, detail: "icacls missing", status: null })
    };
    expect(() =>
      applyRestrictedPermissions("C:\\YUVI\\Postgres", { platform: "win32", adapter })
    ).toThrow(/icacls missing/);
  });

  it("does not treat a secret as persisted after ACL failure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-acl-"));
    tempDirs.push(root);
    const layout = layoutFromRoot(root);
    expect(() =>
      persistDevelopmentPasswordFile(layout, "super-secret", {
        platform: "win32",
        adapter: {
          resolveAccount: () => ({ identity: "alice", source: "username" }),
          applyRestrictedAcl: () => ({ ok: false, detail: "denied", status: 1 })
        }
      })
    ).toThrow(RestrictedAclError);
    expect(fs.existsSync(layout.passwordFile)).toBe(false);
  });

  it("builds default adapter arguments without a shell", () => {
    const adapter = createDefaultWindowsAclAdapter({ USERNAME: "alice smith", USERDOMAIN: "CORP" });
    const account = adapter.resolveAccount();
    expect(account?.identity).toBe("CORP\\alice smith");
  });
});
