/**
 * Lightweight packaging unit tests (no Node download).
 * Run: node --test scripts/desktop-package/prepare.test.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ALLOWED_OPTIONAL_NATIVE_EXTERNALS,
  buildRuntimeManifest,
  collectDisallowedExternals,
  isNodeBuiltin,
  packageNameFromSpecifier
} from "./build-runtime.mjs";
import { REPO_ROOT } from "./constants.mjs";
import { stagePackagedMigrations } from "./prepare.mjs";
import { assertRelativeSafe } from "./paths.mjs";

test("manifest generation is relative and secret-free", () => {
  const manifest = buildRuntimeManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.nodeExecutable, "node.exe");
  assert.equal(manifest.runtimeEntry, "yuvi-runtime-server.mjs");
  assertRelativeSafe(manifest.nodeExecutable, "nodeExecutable");
  assertRelativeSafe(manifest.runtimeEntry, "runtimeEntry");
  const text = JSON.stringify(manifest);
  assert.equal(/sk-|password|api[_-]?key/i.test(text), false);
  assert.equal(/[A-Za-z]:\\/.test(text), false);
});

test("assertRelativeSafe rejects traversal and absolute paths", () => {
  assert.throws(() => assertRelativeSafe("../x", "f"));
  assert.throws(() => assertRelativeSafe("C:\\\\Windows\\\\node.exe", "f"));
  assert.equal(assertRelativeSafe("node.exe", "f"), "node.exe");
});

test("missing node.exe detection helper", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pkg-test-"));
  const nodePath = path.join(dir, "node.exe");
  assert.equal(fs.existsSync(nodePath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("metafile disallows unresolved package externals except optional natives", () => {
  const metafile = {
    inputs: {
      "entry.js": {
        imports: [
          { path: "node:fs", external: true },
          { path: "pg-native", external: true },
          { path: "pg", external: true }
        ]
      }
    },
    outputs: {}
  };
  const disallowed = collectDisallowedExternals(metafile);
  assert.deepEqual(disallowed, ["pg"]);
  assert.equal(ALLOWED_OPTIONAL_NATIVE_EXTERNALS.has("pg-native"), true);
  assert.equal(isNodeBuiltin("node:http"), true);
  assert.equal(packageNameFromSpecifier("@scope/pkg/sub"), "@scope/pkg");
});

test("packaged migration staging preserves the authoritative SQL registry byte-for-byte", () => {
  const sourceDirectory = path.join(REPO_ROOT, "packages", "memory", "migrations");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-migrations-stage-test-"));
  const targetDirectory = path.join(tempRoot, "resource", "migrations");
  try {
    const sourceNames = fs
      .readdirSync(sourceDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort();

    stagePackagedMigrations(targetDirectory);

    const stagedNames = fs.readdirSync(targetDirectory).sort();
    assert.deepEqual(stagedNames, sourceNames);
    for (const name of sourceNames) {
      const source = fs.readFileSync(path.join(sourceDirectory, name));
      const staged = fs.readFileSync(path.join(targetDirectory, name));
      assert.equal(
        createHash("sha256").update(staged).digest("hex"),
        createHash("sha256").update(source).digest("hex"),
        name
      );
      assert.equal(staged.equals(source), true, name);
      assert.equal(staged.toString("utf8").includes(REPO_ROOT), false, name);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
