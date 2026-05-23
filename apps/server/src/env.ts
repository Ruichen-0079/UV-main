import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export type RuntimeEnvFile = {
  path: string;
  exists: boolean;
  values: Record<string, string>;
};

export type RuntimeEnvFiles = {
  runtimeEnvDir: string;
  base: RuntimeEnvFile;
  local: RuntimeEnvFile;
  env: Record<string, string | undefined>;
};

export function getRuntimeEnvDir(): string {
  const configured = process.env["YUVI_RUNTIME_ENV_DIR"]?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  return findWorkspaceRoot(process.cwd()) ?? process.cwd();
}

export function getRuntimeEnvPath(filename: ".env" | ".env.local"): string {
  return path.join(getRuntimeEnvDir(), filename);
}

export async function readRuntimeEnvFiles(): Promise<RuntimeEnvFiles> {
  const runtimeEnvDir = getRuntimeEnvDir();
  const base = await readRuntimeEnvFile(path.join(runtimeEnvDir, ".env"));
  const local = await readRuntimeEnvFile(path.join(runtimeEnvDir, ".env.local"));

  return {
    runtimeEnvDir,
    base,
    local,
    env: {
      ...base.values,
      ...process.env,
      ...local.values
    }
  };
}

export async function readRuntimeEnvFile(envPath: string): Promise<RuntimeEnvFile> {
  try {
    await access(envPath);
    return {
      path: envPath,
      exists: true,
      values: parseEnvText(await readFile(envPath, "utf8"))
    };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return {
        path: envPath,
        exists: false,
        values: {}
      };
    }
    throw error;
  }
}

export function applyRuntimeEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

export function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    result[trimmed.slice(0, separator)] = unquoteEnvValue(trimmed.slice(separator + 1));
  }
  return result;
}

export function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

async function readRuntimeEnvFileExists(envPath: string): Promise<boolean> {
  try {
    await access(envPath);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function getLegacyServerLocalEnvWarning(): Promise<string | undefined> {
  const runtimeEnvDir = getRuntimeEnvDir();
  const repoRoot = findWorkspaceRoot(runtimeEnvDir);
  if (!repoRoot || path.resolve(runtimeEnvDir) !== path.resolve(repoRoot)) {
    return undefined;
  }

  const legacyPath = path.join(repoRoot, "apps", "server", ".env.local");
  if (await readRuntimeEnvFileExists(legacyPath)) {
    return `${legacyPath} exists but YUVI_RUNTIME_ENV_DIR points to the repository root; this legacy misplaced file will not be used. Move its settings to ${path.join(repoRoot, ".env.local")}.`;
  }

  return undefined;
}

function findWorkspaceRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
