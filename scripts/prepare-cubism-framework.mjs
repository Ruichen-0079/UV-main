/**
 * Build Live2D Cubism Web Framework JS from the vendored TypeScript sources.
 *
 * Why: root .gitignore ignores all `dist/` directories, so
 * `apps/web/vendor/cubism-framework/dist` is never in git. Local machines that
 * once ran `tsc` in that folder appear fine; clean CI checkouts fail
 * `pnpm check` on imports under dist/.
 *
 * License: Cubism Web Framework is Live2D Open Software License (see
 * apps/web/vendor/cubism-framework/LICENSE.md). We only compile the Framework
 * sources already in this repo. Cubism Core (Proprietary) is NOT built or
 * committed here — Core is loaded at runtime from LIVE2D_CORE_PATH / API.
 *
 * Determinism: fixed sources under apps/web/vendor/cubism-framework/src +
 * monorepo TypeScript. No network fetch, no machine-local paths.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frameworkDir = join(root, "apps", "web", "vendor", "cubism-framework");
const tsconfig = join(frameworkDir, "tsconfig.json");
const marker = join(frameworkDir, "dist", "live2dcubismframework.js");

if (!existsSync(tsconfig)) {
  console.error(
    `[prepare-cubism-framework] missing Framework tsconfig: ${tsconfig}`
  );
  process.exit(1);
}

const tscJs = join(root, "node_modules", "typescript", "lib", "tsc.js");
if (!existsSync(tscJs)) {
  console.error(
    "[prepare-cubism-framework] TypeScript is not installed. Run `pnpm install` first."
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [tscJs, "-p", tsconfig, "--pretty", "false"],
  {
    cwd: root,
    stdio: "inherit",
    env: process.env
  }
);

if (result.error) {
  console.error("[prepare-cubism-framework] failed to spawn tsc:", result.error);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `[prepare-cubism-framework] tsc exited with code ${result.status ?? "unknown"}`
  );
  process.exit(result.status ?? 1);
}

if (!existsSync(marker)) {
  console.error(
    `[prepare-cubism-framework] build finished but marker missing: ${marker}`
  );
  process.exit(1);
}

console.log("[prepare-cubism-framework] Cubism Framework dist ready.");
