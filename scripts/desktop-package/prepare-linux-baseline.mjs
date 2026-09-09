/** Install locked build dependencies inside an existing Debian 12 rootfs. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./constants.mjs";
const root = process.env.YUVI_LINUX_BUILD_ROOTFS;
if (!root || !path.isAbsolute(root)) throw new Error("Set YUVI_LINUX_BUILD_ROOTFS.");
const release = fs.readFileSync(path.join(root, "etc/os-release"), "utf8");
if (!/^ID=debian$/m.test(release) || !/^VERSION_ID="12"$/m.test(release))
  throw new Error("Debian 12 is required.");
const lock = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, "services/local-stt/packaging/linux-wheels.lock.json"),
    "utf8"
  )
);
const requirements =
  lock.map((p) => `${p.name}==${p.version} --hash=sha256:${p.sha256}`).join("\n") + "\n";
fs.mkdirSync(path.join(root, "opt"), { recursive: true });
fs.writeFileSync(path.join(root, "opt/yuvi-release-requirements.txt"), requirements);
const run = (...args) =>
  execFileSync(
    "bwrap",
    [
      "--die-with-parent",
      "--unshare-pid",
      "--bind",
      root,
      "/",
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
      ...args
    ],
    { stdio: "inherit" }
  );
if (!fs.existsSync(path.join(root, "opt/yuvi-release-build/pyvenv.cfg")))
  run("/usr/local/bin/python3.11", "-m", "venv", "/opt/yuvi-release-build");
const offline = fs.existsSync(path.join(root, "opt/yuvi-release-wheels"))
  ? ["--no-index", "--find-links", "/opt/yuvi-release-wheels"]
  : ["--no-cache-dir"];
run(
  "/opt/yuvi-release-build/bin/python",
  "-m",
  "pip",
  "install",
  "--force-reinstall",
  "--require-hashes",
  ...offline,
  "--report",
  "/opt/yuvi-release-build/install-report.json",
  "-r",
  "/opt/yuvi-release-requirements.txt"
);
