import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  aclGrantArguments,
  applyRestrictedPermissions,
  createDefaultWindowsAclAdapter,
  RestrictedAclError,
  resolveWindowsAccountIdentity,
  type RestrictedPathKind
} from "./postgres-acl.js";
import { persistDevelopmentPasswordFile } from "./postgres-secret.js";
import { ensurePostgresDirectories, layoutFromRoot } from "./postgres-layout.js";

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
        kind: "directory",
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
      applyRestrictedPermissions("C:\\YUVI\\Postgres", {
        platform: "win32",
        kind: "directory",
        adapter
      })
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

  it("routes directory and file production callers to distinct ACE grants", () => {
    const grants: Array<{ path: string; kind: RestrictedPathKind; ace: string }> = [];
    const adapter = {
      resolveAccount: () => ({ identity: "alice", source: "username" as const }),
      applyRestrictedAcl(targetPath: string, identity: string, kind: RestrictedPathKind) {
        const args = aclGrantArguments(targetPath, identity, kind);
        grants.push({ path: targetPath, kind, ace: args[3] ?? "" });
        return { ok: true, detail: "ok", status: 0 };
      }
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-acl-route-"));
    tempDirs.push(root);
    const layout = layoutFromRoot(root);
    ensurePostgresDirectories(layout, { adapter, platform: "win32" });
    persistDevelopmentPasswordFile(layout, "super-secret", { adapter, platform: "win32" });
    const directoryPaths = new Set([layout.root, layout.data, layout.runtime]);
    const directoryGrants = grants.filter((grant) => directoryPaths.has(grant.path));
    expect(directoryGrants.length).toBeGreaterThanOrEqual(3);
    expect(directoryGrants.every((grant) => grant.kind === "directory")).toBe(true);
    expect(directoryGrants.every((grant) => grant.ace === "alice:(OI)(CI)(F)")).toBe(true);
    const fileGrant = grants.find((grant) => grant.path === layout.passwordFile);
    expect(fileGrant?.kind).toBe("file");
    expect(fileGrant?.ace).toBe("alice:(F)");
    expect(fileGrant?.ace).not.toContain("(OI)");
    expect(fileGrant?.ace).not.toContain("(CI)");
  });
});

const describeWindowsNtfs = process.platform === "win32" ? describe : describe.skip;

describeWindowsNtfs("windows real directory ACL inheritance", () => {
  it("lets a second same-user process use descendants created after hardening", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-acl-live-"));
    tempDirs.push(root);
    applyRestrictedPermissions(root, { kind: "directory" });
    const childDir = path.join(root, "child");
    fs.mkdirSync(childDir);
    const input = path.join(childDir, "input.txt");
    const output = path.join(childDir, "output.txt");
    fs.writeFileSync(input, "descendant-ok\n", "utf8");
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "const fs=require('fs');fs.writeFileSync(process.argv[2],fs.readFileSync(process.argv[1]));",
        input,
        output
      ],
      { encoding: "utf8", shell: false, windowsHide: true, timeout: 8_000 }
    );
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(output, "utf8")).toBe("descendant-ok\n");
    const args = aclGrantArguments(root, "alice", "directory");
    expect(args[3]).toBe("alice:(OI)(CI)(F)");
    expect(args.join(" ")).not.toMatch(
      /Everyone|Authenticated Users|BUILTIN\\Users|(?:^|\s)\/T(?:\s|$)/i
    );
  });
});
