#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectoryNames = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  "vendor",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  "__pycache__",
  "dist-types",
  ".cache",
  ".pnpm-store",
  ".turbo",
  ".vite"
]);
const ignoredFiles = new Set([
  "scripts/check-host-environment-safety.mjs",
  "scripts/check-host-environment-safety.node.mjs",
  "packages/host-environment/src/index.test.ts"
]);
const startupFileNames = new Set([
  ".profile",
  ".bash_profile",
  ".bash_login",
  ".bashrc",
  ".zprofile",
  ".zlogin",
  ".zshrc",
  ".zshenv",
  "config.fish"
]);
const environmentDirectoryNames = new Set(["conf.d", "environment.d"]);
const operationalExtensions =
  /\.(?:bash|cjs|cmd|conf|fish|js|mjs|ps1|py|rs|sh|ts|tsx|yaml|yml|zsh)$/u;
const persistentTargets = [
  ".profile",
  ".bash_profile",
  ".bash_login",
  ".bashrc",
  ".zprofile",
  ".zlogin",
  ".zshrc",
  ".zshenv",
  "config.fish",
  "conf.d",
  "environment.d"
];
const ephemeralVariablePattern =
  /(?:\$(?:TMP|TMPDIR|TEMP|XDG_RUNTIME_DIR)\b|\$\{(?:TMP|TMPDIR|TEMP|XDG_RUNTIME_DIR)(?:[^}]*)\}|%(?:TEMP|TMP)%|\$env:(?:TEMP|TMP)\b)/iu;
const ephemeralLocalAppDataPattern =
  /(?:%LOCALAPPDATA%|\$env:LOCALAPPDATA|\$\{env:LOCALAPPDATA\})[\\/]temp(?:[\\/]|$|["'`\s;])/iu;
const ephemeralPathPattern =
  /(?:^|[\s"'`=:(])(?:\/(?:var\/|private\/)?tmp\/|\\(?:var\\)?tmp[\\/])/iu;
const mktempPattern = /\bmktemp\b/u;
const shellSourcePattern = /(?:\bsource\b|(?:^|[\s;&])\.)\s+/u;

async function collectFiles(root) {
  const output = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredDirectoryNames.has(entry.name)) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      output.push(entryPath);
    }
  }
  return output;
}

function pathSegments(relativePath) {
  return relativePath.split("/").filter(Boolean);
}

function isInEnvironmentDirectory(relativePath) {
  return pathSegments(relativePath).some((segment) => environmentDirectoryNames.has(segment));
}

function isTextCandidate(filePath, relativePath) {
  const basename = path.basename(filePath);
  return (
    startupFileNames.has(basename) ||
    isInEnvironmentDirectory(relativePath) ||
    operationalExtensions.test(basename)
  );
}

async function readTextCandidate(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function hasEphemeralReference(line) {
  return (
    ephemeralVariablePattern.test(line) ||
    ephemeralLocalAppDataPattern.test(line) ||
    ephemeralPathPattern.test(line) ||
    mktempPattern.test(line)
  );
}

function isPersistentStartupFile(relativePath) {
  return (
    startupFileNames.has(path.basename(relativePath)) || isInEnvironmentDirectory(relativePath)
  );
}

export async function scanHostEnvironmentSafety(scanRoot = repoRoot) {
  const violations = [];
  const files = await collectFiles(scanRoot);

  for (const filePath of files) {
    const relative = path.relative(scanRoot, filePath).split(path.sep).join("/");
    if (ignoredFiles.has(relative) || !isTextCandidate(filePath, relative)) continue;

    const contents = await readTextCandidate(filePath);
    if (contents === undefined) continue;

    if (contents.includes("/tmp/yuvi-toolchain") || contents.includes("/var/tmp/yuvi-toolchain")) {
      violations.push(`${relative}: known unsafe toolchain path`);
    }

    const persistentStartup = isPersistentStartupFile(relative);
    for (const [lineNumber, line] of contents.split("\n").entries()) {
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (!hasEphemeralReference(line)) continue;

      if (persistentStartup) {
        violations.push(
          `${relative}:${lineNumber + 1}: persistent startup file references an ephemeral path`
        );
        continue;
      }

      if (shellSourcePattern.test(line)) {
        violations.push(`${relative}:${lineNumber + 1}: shell source references an ephemeral path`);
        continue;
      }

      if (persistentTargets.some((target) => line.includes(target))) {
        violations.push(
          `${relative}:${lineNumber + 1}: persistent target references ephemeral path`
        );
      }
    }
  }

  return violations;
}

async function main() {
  const violations = await scanHostEnvironmentSafety();
  if (violations.length > 0) {
    console.error("Host environment safety check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    "Host environment safety check passed: no persistent shell target references an ephemeral path."
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
