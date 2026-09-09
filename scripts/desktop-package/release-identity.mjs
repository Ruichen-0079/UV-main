/** Root product version is authoritative; desktop declarations must agree. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./constants.mjs";
export function releaseVersion(root = REPO_ROOT) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const version = read("package.json").version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid product release version.");
  const cargo = fs.readFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
  if (
    [
      read("apps/desktop/package.json").version,
      read("apps/desktop/src-tauri/tauri.conf.json").version,
      cargo.match(/^version = "([^"]+)"/m)?.[1]
    ].some((v) => v !== version)
  )
    throw new Error("Desktop version declarations disagree with the product version.");
  return version;
}
export function releaseSource(root = REPO_ROOT) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=all"))
    throw new Error("Release builds require a clean checkout, including untracked files.");
  const sha = git("rev-parse", "HEAD");
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sha)
    throw new Error("GITHUB_SHA differs from the release checkout.");
  return sha;
}
