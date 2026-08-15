import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { scanHostEnvironmentSafety } from "./check-host-environment-safety.mjs";

const sandboxes = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSandbox() {
  const root = await mkdtemp(path.join(tmpdir(), "yuvi-host-safety-scanner-"));
  sandboxes.push(root);
  return root;
}

test("scans extensionless startup files and environment.d entries", async () => {
  const root = await createSandbox();
  await mkdir(path.join(root, "environment.d"));
  await writeFile(path.join(root, ".bashrc"), 'source "$TMPDIR/yuvi-toolchain/env"\n', "utf8");
  await writeFile(path.join(root, ".profile"), ". /tmp/yuvi-toolchain/env\n", "utf8");
  await writeFile(
    path.join(root, "environment.d", "yuvi.conf"),
    "YUVI_RUNTIME=$XDG_RUNTIME_DIR/yuvi\n",
    "utf8"
  );

  const violations = await scanHostEnvironmentSafety(root);

  assert(violations.some((violation) => violation.startsWith(".bashrc:")));
  assert(violations.some((violation) => violation.startsWith(".profile:")));
  assert(violations.some((violation) => violation.startsWith("environment.d/yuvi.conf:")));
});

test("detects POSIX, CMD, and PowerShell ephemeral-variable forms", async () => {
  const root = await createSandbox();
  await writeFile(
    path.join(root, ".zshenv"),
    [
      "A=$TMP",
      "B=${TMP}",
      "C=$TEMP",
      "D=${TEMP}",
      "E=$XDG_RUNTIME_DIR",
      "F=${XDG_RUNTIME_DIR}",
      "G=$env:LOCALAPPDATA",
      "H=$env:LOCALAPPDATA\\Temp\\yuvi",
      "I=${env:LOCALAPPDATA}\\Temp\\yuvi"
    ].join("\n"),
    "utf8"
  );
  await mkdir(path.join(root, "fish", "conf.d"), { recursive: true });
  await writeFile(
    path.join(root, "fish", "conf.d", "yuvi.fish"),
    "set -gx YUVI_TEMP %TEMP% %TMP% $env:TEMP $env:TMP\n",
    "utf8"
  );

  const violations = await scanHostEnvironmentSafety(root);

  assert.equal(violations.length, 9);
  assert(violations.every((violation) => violation.includes("persistent startup file")));
  assert(violations.some((violation) => violation.startsWith(".zshenv:8:")));
  assert(violations.some((violation) => violation.startsWith(".zshenv:9:")));
  assert(!violations.some((violation) => violation.startsWith(".zshenv:7:")));
});

test("allows documentation and intentional regression fixtures", async () => {
  const root = await createSandbox();
  await mkdir(path.join(root, "packages", "host-environment", "src"), { recursive: true });
  await mkdir(path.join(root, "docs"));
  await writeFile(
    path.join(root, "docs", "safety.md"),
    "Forbidden example: /tmp/yuvi-toolchain/env\n",
    "utf8"
  );
  await writeFile(
    path.join(root, "packages", "host-environment", "src", "index.test.ts"),
    'const fixture = ". /tmp/yuvi-toolchain/env";\n',
    "utf8"
  );

  assert.deepEqual(await scanHostEnvironmentSafety(root), []);
});
