/** Build the Tauri shell against Debian 12, then bind its hash to this clean source. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./constants.mjs";
import { releaseSource, releaseVersion } from "./release-identity.mjs";
import { buildLinuxWeb } from "./build-linux-web.mjs";
const checkoutSha = releaseSource();
const version = releaseVersion();
const root = process.env.YUVI_LINUX_BUILD_ROOTFS;
if (!root || !path.isAbsolute(root)) throw new Error("Set YUVI_LINUX_BUILD_ROOTFS.");
const os = fs.readFileSync(path.join(root, "etc/os-release"), "utf8");
if (!/^ID=debian$/m.test(os) || !/^VERSION_ID="12"$/m.test(os))
  throw new Error("Debian 12 is required for the desktop release build.");
const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
const cargoHome =
  process.env.YUVI_RELEASE_CARGO_HOME ||
  process.env.CARGO_HOME ||
  path.join(process.env.HOME, ".cargo");
const target = path.join(REPO_ROOT, "build/desktop/debian-target");
fs.mkdirSync(target, { recursive: true });
await buildLinuxWeb();
execFileSync(
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
    "--ro-bind",
    sysroot,
    "/opt/rust",
    "--bind",
    cargoHome,
    "/opt/cargo",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--clearenv",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "PATH",
    "/opt/rust/bin:/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "CARGO_HOME",
    "/opt/cargo",
    "--setenv",
    "CARGO_TARGET_DIR",
    "/workspace/build/desktop/debian-target",
    "--setenv",
    "RUSTFLAGS",
    "--remap-path-prefix=/workspace=/yuvi --remap-path-prefix=/opt/cargo=/cargo",
    "--chdir",
    "/workspace/apps/desktop/src-tauri",
    "cargo",
    "build",
    "--release",
    "--locked",
    "--features",
    "tauri/custom-protocol",
    "--offline",
    "-j",
    process.env.YUVI_BUILD_JOBS || "4"
  ],
  { stdio: "inherit" }
);
if (releaseSource() !== checkoutSha) throw new Error("Source changed during desktop build.");
const binary = path.join(target, "release/yuvi-desktop");
const receipt = {
  checkoutSha,
  version,
  baseline: "Debian 12 / glibc 2.36",
  rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  sha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex")
};
fs.writeFileSync(binary + ".provenance.json", JSON.stringify(receipt, null, 2) + "\n");
console.log(binary);
