import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { releaseSource, releaseVersion } from "./release-identity.mjs";

test("release identity rejects dirty sources and disagreement in product metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-release-identity-"));
  const previousSha = process.env.GITHUB_SHA;
  delete process.env.GITHUB_SHA;
  try {
    fs.mkdirSync(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
    for (const name of [
      "package.json",
      "apps/desktop/package.json",
      "apps/desktop/src-tauri/tauri.conf.json"
    ])
      fs.writeFileSync(path.join(root, name), JSON.stringify({ version: "0.1.1" }));
    fs.writeFileSync(
      path.join(root, "apps/desktop/src-tauri/Cargo.toml"),
      '[package]\nversion = "0.1.1"\n'
    );
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture"
    );
    assert.equal(releaseVersion(root), "0.1.1");
    assert.match(releaseSource(root), /^[a-f0-9]{40}$/);
    process.env.GITHUB_SHA = "0".repeat(40);
    assert.throws(() => releaseSource(root), /GITHUB_SHA/);
    delete process.env.GITHUB_SHA;
    fs.writeFileSync(path.join(root, "private-state.json"), "{}");
    assert.throws(() => releaseSource(root), /clean checkout/);
    fs.unlinkSync(path.join(root, "private-state.json"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
    assert.throws(() => releaseSource(root), /clean checkout/);
    assert.throws(() => releaseVersion(root), /disagree/);
  } finally {
    if (previousSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousSha;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
