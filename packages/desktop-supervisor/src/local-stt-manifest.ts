import fs from "node:fs";
import path from "node:path";
import type { LocalSttManifest } from "./types.js";

const LOCAL_STT_MANIFEST_FIELDS = new Set([
  "schemaVersion",
  "protocolVersion",
  "platform",
  "arch",
  "executable",
  "modelDirectory",
  "modelManifest",
  "healthPath",
  "defaultHost",
  "defaultPort"
]);

function manifestError(message: string): Error {
  return new Error(`Local STT manifest ${message}.`);
}

export function readLocalSttManifest(manifestPath: string): LocalSttManifest {
  if (!fs.existsSync(manifestPath)) throw manifestError(`missing: ${manifestPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw manifestError(`invalid JSON: ${manifestPath}`);
  }
  return validateLocalSttManifest(raw);
}

export function validateLocalSttManifest(raw: unknown): LocalSttManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw manifestError("must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const extra = Object.keys(obj).find((key) => !LOCAL_STT_MANIFEST_FIELDS.has(key));
  if (extra) throw manifestError("contains unsupported field");
  if (obj["schemaVersion"] !== 1) throw manifestError("schemaVersion must be 1");
  if (obj["protocolVersion"] !== 1) throw manifestError("protocolVersion must be 1");
  if (obj["platform"] !== "win32") throw manifestError("platform must be win32");
  if (obj["arch"] !== "x64") throw manifestError("arch must be x64");
  const executable = requireBasename(obj["executable"], "executable");
  const modelDirectory = requireRelative(obj["modelDirectory"], "modelDirectory");
  const modelManifest = requireRelative(obj["modelManifest"], "modelManifest");
  if (obj["healthPath"] !== "/health") throw manifestError("healthPath must be /health");
  if (obj["defaultHost"] !== "127.0.0.1") throw manifestError("defaultHost must be 127.0.0.1");
  const defaultPort = obj["defaultPort"];
  if (
    typeof defaultPort !== "number" ||
    !Number.isInteger(defaultPort) ||
    defaultPort < 1 ||
    defaultPort > 65535
  ) {
    throw manifestError("defaultPort must be an integer between 1 and 65535");
  }
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    platform: "win32",
    arch: "x64",
    executable,
    modelDirectory,
    modelManifest,
    healthPath: "/health",
    defaultHost: "127.0.0.1",
    defaultPort
  };
}

export function resolveLocalSttManifestExecutable(
  manifestPath: string,
  manifest: LocalSttManifest
): string {
  const validated = validateLocalSttManifest(manifest);
  const manifestDir = path.resolve(path.dirname(manifestPath));
  const executable = path.resolve(manifestDir, validated.executable);
  const relative = path.relative(manifestDir, executable);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw manifestError("executable escapes its resource directory");
  }
  if (!isFile(executable)) throw manifestError(`executable missing: ${executable}`);
  return executable;
}

export function resolveLocalSttManifestPath(
  manifestPath: string,
  relativePath: string,
  field: "modelDirectory" | "modelManifest"
): string {
  const validated = validateLocalSttManifest({
    ...readLocalSttManifest(manifestPath),
    [field]: relativePath
  });
  const manifestDir = path.resolve(path.dirname(manifestPath));
  const resolved = path.resolve(manifestDir, validated[field]);
  const relative = path.relative(manifestDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw manifestError(`${field} escapes its resource directory`);
  }
  return resolved;
}

function requireBasename(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw manifestError(`${field} must be a non-empty basename`);
  const normalized = value.trim();
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("..") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /^[A-Za-z]:/.test(normalized) ||
    path.isAbsolute(normalized) ||
    path.basename(normalized) !== normalized
  ) {
    throw manifestError(`${field} must be a basename`);
  }
  return normalized;
}

function requireRelative(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw manifestError(`${field} must be non-empty`);
  const normalized = value.trim().replaceAll("\\", "/");
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || normalized.startsWith("/")) {
    throw manifestError(`${field} must be relative`);
  }
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    throw manifestError(`${field} must be a normalized relative path`);
  }
  return normalized;
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
