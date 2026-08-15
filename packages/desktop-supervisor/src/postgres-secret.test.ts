import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { layoutFromRoot } from "./postgres-layout.js";
import {
  generatePostgresPassword,
  persistPostgresPassword,
  redactSecretText,
  resolvePostgresPassword
} from "./postgres-secret.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("private postgres secrets", () => {
  it("never persists a DATABASE_URL and redacts secrets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-sec-"));
    tempDirs.push(root);
    const layout = layoutFromRoot(root);
    fs.mkdirSync(layout.runtime, { recursive: true });
    const password = generatePostgresPassword();
    persistPostgresPassword(layout, password);
    expect(fs.existsSync(layout.passwordFile)).toBe(true);
    expect(fs.existsSync(layout.pgpassFile)).toBe(false);
    expect(fs.readFileSync(layout.passwordFile, "utf8")).not.toContain("postgres://");
    expect(resolvePostgresPassword(layout, {})).toBe(password);
    const redacted = redactSecretText(
      `DATABASE_URL=postgres://yuvi:${password}@127.0.0.1:55432/yuvi`,
      [password]
    );
    expect(redacted).not.toContain(password);
    expect(redacted).not.toMatch(/postgres:\/\//);
  });

  it("prefers injected YUVI_POSTGRES_PASSWORD over the file store", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-inj-"));
    tempDirs.push(root);
    const layout = layoutFromRoot(root);
    fs.mkdirSync(layout.runtime, { recursive: true });
    persistPostgresPassword(layout, "file-secret");
    expect(resolvePostgresPassword(layout, { YUVI_POSTGRES_PASSWORD: "injected-secret" })).toBe(
      "injected-secret"
    );
    expect(resolvePostgresPassword(layout, {}, "credential-manager")).toBeNull();
    expect(
      resolvePostgresPassword(
        layout,
        { YUVI_POSTGRES_PASSWORD: "injected-secret" },
        "credential-manager"
      )
    ).toBe("injected-secret");
  });
});
