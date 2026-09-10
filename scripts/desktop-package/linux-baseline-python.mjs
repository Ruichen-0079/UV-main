#!/usr/bin/env node
/** PyInstaller interpreter wrapper: every probe and build runs inside Debian 12. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { REPO_ROOT } from "./constants.mjs";
const root = process.env.YUVI_LINUX_BUILD_ROOTFS;
if (!root || !path.isAbsolute(root))
  throw new Error("Set YUVI_LINUX_BUILD_ROOTFS to the prepared Debian 12 build root.");
const release = fs.readFileSync(path.join(root, "etc/os-release"), "utf8");
if (!/^ID=debian$/m.test(release) || !/^VERSION_ID="12"$/m.test(release))
  throw new Error("The Local STT release build requires Debian 12.");
fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
const args = process.argv
  .slice(2)
  .map((arg) =>
    arg.startsWith(REPO_ROOT + path.sep) ? "/workspace/" + path.relative(REPO_ROOT, arg) : arg
  );
const epoch = execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8"
}).trim();
// Preserve the service builder's working directory inside the mounted checkout.
const relativeCwd = path.relative(REPO_ROOT, process.cwd());
if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd))
  throw new Error("Linux Python build must run inside the release checkout.");
const result = spawnSync(
  "bwrap",
  [
    "--die-with-parent",
    "--unshare-pid",
    "--bind",
    root,
    "/",
    "--bind",
    REPO_ROOT,
    "/workspace",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "PYTHONHASHSEED",
    "0",
    "--setenv",
    "SOURCE_DATE_EPOCH",
    epoch,
    "--chdir",
    path.posix.join("/workspace", relativeCwd),
    "/opt/yuvi-release-build/bin/python",
    ...args
  ],
  { stdio: "inherit" }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
