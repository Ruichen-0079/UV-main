/**
 * Prepare Windows x64 packaged artifacts and stage them into Tauri generated/.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  BUILD_ROOT,
  MEM0_EXE_NAME,
  MEM0_MANIFEST_NAME,
  MEM0_OUT_DIR,
  NODE_EXE_NAME,
  REPO_ROOT,
  RUNTIME_ENTRY_NAME,
  RUNTIME_MANIFEST_NAME,
  RUNTIME_OUT_DIR,
  SUPERVISOR_BUNDLE_NAME,
  SUPERVISOR_EXE_NAME,
  SUPERVISOR_OUT_DIR,
  TAURI_GENERATED
} from "./constants.mjs";
import { buildSupervisor, sha256File, SUPERVISOR_BUILD_INFO_NAME } from "./build-supervisor.mjs";
import { buildPackagedMem0, validateMem0Artifact } from "./build-mem0.mjs";
import { bundleRuntimeServer } from "./build-runtime.mjs";
import { prepareBundledNode } from "./download-node.mjs";
import {
  assertDir,
  assertFile,
  assertSafeGeneratedTarget,
  ensureDir,
  writeJson
} from "./paths.mjs";

const PROCESS_IDENTITY_HELPER_SOURCE = path.join(
  REPO_ROOT,
  "scripts",
  "desktop-package",
  "native",
  "yuvi-process-identity.rs"
);
const PROCESS_IDENTITY_HELPER_NAME = "yuvi-process-identity.exe";
const MEMORY_MIGRATIONS_SOURCE = path.join(REPO_ROOT, "packages", "memory", "migrations");

export function compileWindowsProcessIdentityHelper(
  outputDirectory = path.join(BUILD_ROOT, "native")
) {
  assertFile(PROCESS_IDENTITY_HELPER_SOURCE, "Windows process identity helper source");
  ensureDir(outputDirectory);
  const output = path.join(outputDirectory, PROCESS_IDENTITY_HELPER_NAME);
  fs.rmSync(output, { force: true });
  const rustc = process.env.YUVI_RUSTC?.trim() || "rustc";
  const result = spawnSync(
    rustc,
    [
      PROCESS_IDENTITY_HELPER_SOURCE,
      "--target",
      "x86_64-pc-windows-msvc",
      "--edition",
      "2021",
      "-C",
      "opt-level=z",
      "-C",
      "panic=abort",
      "-C",
      "codegen-units=1",
      "-o",
      output
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 120_000
    }
  );
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? "")
      .trim()
      .slice(-2_000);
    throw new Error(
      `Windows process identity helper compilation failed${detail ? `: ${detail}` : ""}`
    );
  }
  assertFile(output, "compiled Windows process identity helper");
  const header = fs.readFileSync(output).subarray(0, 2).toString("ascii");
  if (header !== "MZ")
    throw new Error("compiled Windows process identity helper is not a PE executable");
  return output;
}

export async function prepareDesktopPackage() {
  console.info("[desktop-package] prepare start");
  ensureDir(BUILD_ROOT);
  ensureDir(RUNTIME_OUT_DIR);
  ensureDir(SUPERVISOR_OUT_DIR);

  await prepareBundledNode(RUNTIME_OUT_DIR);
  assertFile(path.join(RUNTIME_OUT_DIR, NODE_EXE_NAME), "node.exe");

  const runtime = await bundleRuntimeServer(RUNTIME_OUT_DIR);
  assertFile(runtime.outfile, "runtime entry");
  assertFile(runtime.manifestPath, "runtime manifest");

  const supervisor = await buildSupervisor(SUPERVISOR_OUT_DIR);
  assertFile(supervisor.cjsPath, "supervisor cjs");
  assertFile(supervisor.exePath, "supervisor exe");

  const processIdentityHelper = compileWindowsProcessIdentityHelper();

  const mem0 = await buildPackagedMem0();
  validateMem0Artifact(MEM0_OUT_DIR);

  // Stage into Tauri resources tree.
  assertSafeGeneratedTarget(TAURI_GENERATED);
  const stagedRuntime = path.join(TAURI_GENERATED, "runtime");
  const stagedSupervisor = path.join(TAURI_GENERATED, "supervisor");
  const stagedMem0 = path.join(TAURI_GENERATED, "mem0");
  const stagedNative = path.join(TAURI_GENERATED, "native");
  const stagedMigrations = path.join(TAURI_GENERATED, "migrations");
  fs.rmSync(TAURI_GENERATED, { recursive: true, force: true });
  ensureDir(stagedRuntime);
  ensureDir(stagedSupervisor);
  ensureDir(stagedMem0);
  ensureDir(stagedNative);
  ensureDir(stagedMigrations);

  copyFile(path.join(RUNTIME_OUT_DIR, NODE_EXE_NAME), path.join(stagedRuntime, NODE_EXE_NAME));
  copyFile(
    path.join(RUNTIME_OUT_DIR, RUNTIME_ENTRY_NAME),
    path.join(stagedRuntime, RUNTIME_ENTRY_NAME)
  );
  copyFile(
    path.join(RUNTIME_OUT_DIR, RUNTIME_MANIFEST_NAME),
    path.join(stagedRuntime, RUNTIME_MANIFEST_NAME)
  );
  const metafile = path.join(RUNTIME_OUT_DIR, "runtime-esbuild-metafile.json");
  if (fs.existsSync(metafile)) {
    copyFile(metafile, path.join(stagedRuntime, "runtime-esbuild-metafile.json"));
  }
  copyFile(
    path.join(SUPERVISOR_OUT_DIR, SUPERVISOR_BUNDLE_NAME),
    path.join(stagedSupervisor, SUPERVISOR_BUNDLE_NAME)
  );
  copyFile(supervisor.exePath, path.join(stagedSupervisor, SUPERVISOR_EXE_NAME));
  const stagedSupervisorExe = path.join(stagedSupervisor, SUPERVISOR_EXE_NAME);
  const stagedExecutableSha256 = sha256File(stagedSupervisorExe);
  if (stagedExecutableSha256 !== supervisor.buildInfo.executableSha256) {
    throw new Error("staged Supervisor executable SHA-256 does not match build output");
  }
  const supervisorProvenance = {
    ...supervisor.buildInfo,
    stagedExecutableSha256,
    stagedBundleSha256: sha256File(path.join(stagedSupervisor, SUPERVISOR_BUNDLE_NAME))
  };
  if (supervisorProvenance.stagedBundleSha256 !== supervisorProvenance.bundleInputSha256) {
    throw new Error("staged Supervisor bundle SHA-256 does not match build input");
  }
  const buildInfoPath = path.join(SUPERVISOR_OUT_DIR, SUPERVISOR_BUILD_INFO_NAME);
  writeJson(buildInfoPath, supervisorProvenance);
  copyFile(buildInfoPath, path.join(stagedSupervisor, SUPERVISOR_BUILD_INFO_NAME));
  copyDir(MEM0_OUT_DIR, stagedMem0);
  stagePackagedMigrations(stagedMigrations);
  const stagedProcessIdentityHelper = path.join(stagedNative, PROCESS_IDENTITY_HELPER_NAME);
  copyFile(processIdentityHelper, stagedProcessIdentityHelper);
  assertFile(stagedProcessIdentityHelper, "staged Windows process identity helper");
  if (fs.readFileSync(stagedProcessIdentityHelper).subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error("staged Windows process identity helper is not a PE executable");
  }
  const stagedMem0Artifact = validateMem0Artifact(stagedMem0);

  const packagingInfo = {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    supervisorMode: supervisor.mode,
    hasSupervisorExe: true,
    supervisorBuildInfo: `supervisor/${SUPERVISOR_BUILD_INFO_NAME}`,
    runtimeEntry: RUNTIME_ENTRY_NAME,
    nodeExecutable: NODE_EXE_NAME,
    hasMem0: true,
    mem0Executable: MEM0_EXE_NAME,
    mem0Manifest: MEM0_MANIFEST_NAME,
    mem0ProtocolVersion: 1
  };
  writeJson(path.join(TAURI_GENERATED, "packaging-info.json"), packagingInfo);
  writeJson(path.join(BUILD_ROOT, "packaging-info.json"), packagingInfo);

  console.info(`[desktop-package] staged: ${TAURI_GENERATED}`);
  console.info(`[desktop-package] supervisor mode: ${supervisor.mode}`);
  return {
    packagingInfo,
    staged: TAURI_GENERATED,
    buildRoot: BUILD_ROOT,
    mem0: stagedMem0Artifact,
    processIdentityHelper: stagedProcessIdentityHelper,
    interpreter: mem0.python
  };
}

export function stagePackagedMigrations(targetDirectory) {
  assertDir(MEMORY_MIGRATIONS_SOURCE, "memory migration registry");
  ensureDir(targetDirectory);
  copyDir(MEMORY_MIGRATIONS_SOURCE, targetDirectory);
  return targetDirectory;
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  ensureDir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) copyFile(source, target);
    else throw new Error(`Unsupported Mem0 artifact entry: ${source}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("prepare.mjs");
if (isMain) {
  prepareDesktopPackage().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
