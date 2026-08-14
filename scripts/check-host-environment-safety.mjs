#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanRoots = ["."];
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
  "packages/host-environment/src/index.test.ts"
]);
const persistentTargets = [
  ".profile",
  ".bash_profile",
  ".bashrc",
  ".zshrc",
  "config.fish",
  "conf.d",
  "environment.d"
];
const ephemeralMarkers = ["/tmp/", "/var/tmp/", "$TMPDIR", "${TMPDIR}", "mktemp"];

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

function isTextCandidate(filePath) {
  return /\.(?:cjs|cmd|fish|js|mjs|md|ps1|py|rs|sh|ts|tsx|yaml|yml|zsh)$/u.test(filePath);
}

const unsafeSourcePatterns = [
  /\bsource\s+["']?(?:\/tmp\/|\/var\/tmp\/|\$TMPDIR|\$\{TMPDIR\})/u,
  /(?:^|[\s;&])\.\s+["']?(?:\/tmp\/|\/var\/tmp\/|\$TMPDIR|\$\{TMPDIR\})/u
];
const violations = [];
for (const root of scanRoots) {
  const files = await collectFiles(path.join(repoRoot, root));
  for (const filePath of files) {
    const relative = path.relative(repoRoot, filePath).split(path.sep).join("/");
    if (ignoredFiles.has(relative) || !isTextCandidate(filePath)) continue;
    const contents = await readFile(filePath, "utf8");
    if (contents.includes("/tmp/yuvi-toolchain") || contents.includes("/var/tmp/yuvi-toolchain")) {
      violations.push(`${relative}: known unsafe toolchain path`);
    }
    for (const [lineNumber, line] of contents.split("\n").entries()) {
      if (unsafeSourcePatterns.some((pattern) => pattern.test(line))) {
        violations.push(`${relative}:${lineNumber + 1}: shell source references an ephemeral path`);
      }
      if (
        persistentTargets.some((target) => line.includes(target)) &&
        ephemeralMarkers.some((marker) => line.includes(marker))
      ) {
        violations.push(
          `${relative}:${lineNumber + 1}: persistent target references ephemeral path`
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Host environment safety check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  "Host environment safety check passed: no persistent shell target references an ephemeral path."
);
