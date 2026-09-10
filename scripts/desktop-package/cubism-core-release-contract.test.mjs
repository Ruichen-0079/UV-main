import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");

test("Linux release packages only the Cubism Core provisioner, never Core", () => {
  const prepare = read("scripts/desktop-package/prepare-linux-daily.mjs");
  const audit = read("scripts/desktop-package/audit-linux-public-artifact.mjs");
  const provisioner = read("scripts/desktop-package/provision-cubism-core.mjs");

  assert.match(prepare, /provision-cubism-core\.mjs/);
  assert.match(prepare, /cubismCoreBundled:\s*false/);
  assert.match(prepare, /cubismCoreProvisioning:\s*"required-user-import"/);
  assert.match(prepare, /cubismCoreExpectedFilename:\s*"live2dcubismcore\.min\.js"/);
  assert.doesNotMatch(prepare, /copyFileSync\([^)]*live2dcubismcore\.min\.js/s);

  assert.match(audit, /live2dcubismcore/);
  assert.match(audit, /"provision-cubism-core\.mjs"/);
  assert.match(audit, /cubismCoreBundled\s*!==\s*false/);
  assert.match(audit, /required-user-import/);

  assert.doesNotMatch(provisioner, /\bfetch\s*\(/);
  assert.doesNotMatch(provisioner, /https?\.request\s*\(/);
});

test("existing Runtime resolver discovers the managed Core from the YUVI data root", () => {
  const config = read("packages/desktop-supervisor/src/config.ts");
  assert.match(
    config,
    /path\.join\(localYuvi,\s*"CubismCore",\s*"live2dcubismcore\.min\.js"\)/
  );
  assert.match(config, /out\["LIVE2D_CORE_PATH"\]\s*=\s*userCore/);
});

test("Portable Core import is confined to the version-isolated Portable data root", () => {
  const launcher = read("scripts/desktop-package/linux-launcher.mjs");
  assert.match(launcher, /command === 'cubism-core'/);
  assert.match(launcher, /provisionCubismCore\(\{ sourcePath, dataRoot: dirs\.data \}\)/);
  assert.match(launcher, /cubismCoreStatus\(\{ dataRoot: dirs\.data \}\)/);
  assert.doesNotMatch(launcher, /dataRoot:\s*['"]\/home\//);
});
