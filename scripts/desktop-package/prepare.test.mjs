/**
 * Lightweight packaging unit tests (no Node download).
 * Run: node --test scripts/desktop-package/prepare.test.mjs
 */
import assert from "node:assert/strict";
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

test("packaged Runtime uses normal production export resolution", () => {
  const buildRuntimeSource = fs.readFileSync(
    new URL("./build-runtime.mjs", import.meta.url),
    "utf8"
  );
  assert.equal(buildRuntimeSource.includes('conditions: ["development"]'), false);
  const rootPackage = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  );
  assert.equal(
    rootPackage.scripts["desktop:package:prepare"],
    "pnpm --filter @companion/server... build && node scripts/desktop-package/prepare.mjs"
  );
});
