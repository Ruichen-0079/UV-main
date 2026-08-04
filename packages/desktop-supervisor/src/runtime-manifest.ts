import fs from "node:fs";
import path from "node:path";
import type { RuntimeManifest } from "./types.js";

export function readRuntimeManifest(manifestPath: string): RuntimeManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Runtime manifest missing: ${manifestPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Runtime manifest invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateRuntimeManifest(raw);
}

export function validateRuntimeManifest(raw: unknown): RuntimeManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Runtime manifest must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj["schemaVersion"] !== 1) {
    throw new Error(
      `Unsupported runtime manifest schemaVersion: ${String(obj["schemaVersion"])}`
    );
  }
  const nodeExecutable = requireRelative(obj["nodeExecutable"], "nodeExecutable");
  const runtimeEntry = requireRelative(obj["runtimeEntry"], "runtimeEntry");
  const platform = typeof obj["platform"] === "string" ? obj["platform"] : "win32";
  const arch = typeof obj["arch"] === "string" ? obj["arch"] : "x64";
  const nodeVersion = typeof obj["nodeVersion"] === "string" ? obj["nodeVersion"] : undefined;
  return {
    schemaVersion: 1,
    platform,
    arch,
    ...(nodeVersion ? { nodeVersion } : {}),
    nodeExecutable,
    runtimeEntry
  };
}

function requireRelative(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  const rel = value.trim().replaceAll("\\", "/");
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || rel.startsWith("/")) {
    throw new Error(`${field} must be a relative path (got ${value})`);
  }
  if (rel.split("/").some((part) => part === "..")) {
    throw new Error(`${field} must not contain '..'`);
  }
  return rel;
}

export function resolveManifestFile(
  resourceRoot: string,
  relativePath: string
): string {
  const abs = path.resolve(resourceRoot, relativePath);
  const root = path.resolve(resourceRoot);
  if (!abs.toLowerCase().startsWith(root.toLowerCase()) && process.platform === "win32") {
    // Windows case-insensitive containment
    throw new Error(`path escapes resource root: ${relativePath}`);
  }
  if (process.platform !== "win32" && !abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error(`path escapes resource root: ${relativePath}`);
  }
  return abs;
}
