/**
 * Bundle desktop-supervisor + CLI into a single CommonJS file, then package
 * with @yao-pkg/pkg into a Windows x64 executable when available.
 *
 * Fallback (documented): keep supervisor.cjs next to bundled node.exe and run
 * via node.exe — still no system Node / pnpm / tsx.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  PKG_TARGET,
  REPO_ROOT,
  SUPERVISOR_BUNDLE_NAME,
  SUPERVISOR_EXE_NAME,
  SUPERVISOR_OUT_DIR
} from "./constants.mjs";
import { assertFile, ensureDir } from "./paths.mjs";

export async function bundleSupervisorCjs(outDir = SUPERVISOR_OUT_DIR) {
  ensureDir(outDir);
  const entry = path.join(REPO_ROOT, "scripts", "yuvi-desktop-supervisor.packaged.mjs");
  assertFile(entry, "packaged supervisor entry");
  const outfile = path.join(outDir, SUPERVISOR_BUNDLE_NAME);

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    sourcemap: false,
    logLevel: "info",
    banner: {
      js: "/* YUVI packaged Supervisor — do not edit */"
    }
  });
  assertFile(outfile, "supervisor cjs bundle");
  return outfile;
}

export function packageSupervisorExe(cjsPath, outDir = SUPERVISOR_OUT_DIR) {
  ensureDir(outDir);
  const exePath = path.join(outDir, SUPERVISOR_EXE_NAME);
  const pkgBin = path.join(REPO_ROOT, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");
  const pkgCli = path.join(REPO_ROOT, "node_modules", ".bin", "pkg");
  const pkgCmd =
    process.platform === "win32"
      ? path.join(REPO_ROOT, "node_modules", ".bin", "pkg.cmd")
      : pkgCli;

  const args = [
    cjsPath,
    "--target",
    PKG_TARGET,
    "--output",
    exePath,
    "--compress",
    "GZip"
  ];

  try {
    if (fs.existsSync(pkgCmd)) {
      execFileSync(pkgCmd, args, { stdio: "inherit", cwd: REPO_ROOT, shell: process.platform === "win32" });
    } else if (fs.existsSync(pkgBin)) {
      execFileSync(process.execPath, [pkgBin, ...args], { stdio: "inherit", cwd: REPO_ROOT });
    } else {
      throw new Error("@yao-pkg/pkg is not installed (run pnpm install)");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[desktop-package] pkg failed: ${message}`);
    console.warn(
      "[desktop-package] fallback: supervisor will run as node.exe + yuvi-desktop-supervisor.cjs"
    );
    return { exePath: null, cjsPath, mode: "node-cjs-fallback" };
  }

  if (!fs.existsSync(exePath)) {
    console.warn("[desktop-package] pkg produced no exe; using node+cjs fallback");
    return { exePath: null, cjsPath, mode: "node-cjs-fallback" };
  }
  return { exePath, cjsPath, mode: "pkg-exe" };
}

export async function buildSupervisor(outDir = SUPERVISOR_OUT_DIR) {
  const cjsPath = await bundleSupervisorCjs(outDir);
  const packaged = packageSupervisorExe(cjsPath, outDir);
  return packaged;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("build-supervisor.mjs");
if (isMain) {
  buildSupervisor()
    .then((result) => {
      console.info(`[desktop-package] supervisor mode: ${result.mode}`);
      console.info(`[desktop-package] cjs: ${result.cjsPath}`);
      if (result.exePath) console.info(`[desktop-package] exe: ${result.exePath}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
