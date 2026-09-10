import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CUBISM_CORE_FILENAME,
  cubismCoreStatus,
  inspectCubismCoreSource,
  provisionCubismCore,
  resolveCubismCoreDestination,
  resolveLinuxYuviDataRoot
} from "./provision-cubism-core.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-cubism-core-"));
  const sourceDir = path.join(root, "official-sdk", "Core");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(sourceDir, { recursive: true });
  const source = path.join(sourceDir, CUBISM_CORE_FILENAME);
  fs.writeFileSync(source, "window.Live2DCubismCore={Version:'test'};\n");
  return { root, source, dataRoot };
}

test("provisions exact Core filename into the managed YUVI data root", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = provisionCubismCore({ sourcePath: f.source, dataRoot: f.dataRoot });
  const destination = resolveCubismCoreDestination(f.dataRoot);
  assert.equal(result.destination, destination);
  assert.equal(fs.readFileSync(destination, "utf8"), fs.readFileSync(f.source, "utf8"));
  assert.equal(result.redistributedByYuvi, false);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);

  const provenance = JSON.parse(
    fs.readFileSync(path.join(f.dataRoot, "CubismCore", "provenance.json"), "utf8")
  );
  assert.equal(provenance.filename, CUBISM_CORE_FILENAME);
  assert.equal(provenance.sha256, result.sha256);
  assert.equal(provenance.redistributedByYuvi, false);
  assert.equal(JSON.stringify(provenance).includes(f.source), false);

  const status = cubismCoreStatus({ dataRoot: f.dataRoot });
  assert.equal(status.installed, true);
  assert.equal(status.sha256, result.sha256);
});

test("rejects a renamed, empty, symlinked, or missing Core source", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const renamed = path.join(path.dirname(f.source), "core.js");
  fs.copyFileSync(f.source, renamed);
  assert.throws(() => inspectCubismCoreSource(renamed), /named exactly/);

  fs.writeFileSync(f.source, "");
  assert.throws(() => inspectCubismCoreSource(f.source), /empty/);

  fs.writeFileSync(f.source, "core");
  const linkDir = path.join(f.root, "link");
  fs.mkdirSync(linkDir);
  const link = path.join(linkDir, CUBISM_CORE_FILENAME);
  fs.symlinkSync(f.source, link);
  assert.throws(() => inspectCubismCoreSource(link), /regular file/);

  fs.rmSync(f.source);
  assert.throws(() => inspectCubismCoreSource(f.source), /unavailable/);
});

test("Linux data-root resolution follows YUVI_DATA_ROOT then XDG data home", () => {
  assert.equal(
    resolveLinuxYuviDataRoot({
      env: { YUVI_DATA_ROOT: "/tmp/yuvi-explicit", XDG_DATA_HOME: "/tmp/xdg-data" },
      home: "/home/test"
    }),
    "/tmp/yuvi-explicit"
  );
  assert.equal(
    resolveLinuxYuviDataRoot({ env: { XDG_DATA_HOME: "/tmp/xdg-data" }, home: "/home/test" }),
    "/tmp/xdg-data/YUVI"
  );
  assert.equal(
    resolveLinuxYuviDataRoot({ env: {}, home: "/home/test" }),
    "/home/test/.local/share/YUVI"
  );
  assert.throws(
    () => resolveLinuxYuviDataRoot({ env: { YUVI_DATA_ROOT: "relative" }, home: "/home/test" }),
    /absolute path/
  );
});
