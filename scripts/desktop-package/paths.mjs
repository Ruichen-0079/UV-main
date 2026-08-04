import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./constants.mjs";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function repoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

export function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} missing: ${filePath}`);
  }
}

export function assertDir(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`${label} missing: ${dirPath}`);
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** Reject absolute paths and parent traversal in packaged relative fields. */
export function assertRelativeSafe(rel, field) {
  if (typeof rel !== "string" || !rel.trim()) {
    throw new Error(`${field} must be a non-empty relative path`);
  }
  const normalized = rel.replaceAll("\\", "/");
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || normalized.startsWith("/")) {
    throw new Error(`${field} must not be absolute: ${rel}`);
  }
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error(`${field} must not contain '..': ${rel}`);
  }
  return normalized;
}
