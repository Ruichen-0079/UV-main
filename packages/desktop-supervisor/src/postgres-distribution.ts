/**
 * Locate a PostgreSQL 16 distribution without vendoring binaries into Git.
 * Packaged production will later use resource_dir/postgres (P4-2D4).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalPath, isWindowsStylePath } from "./paths.js";
import { PRIVATE_POSTGRES_MAJOR } from "./postgres-layout.js";
import type { SupervisorLayout } from "./types.js";

export type PostgresDistribution = {
  home: string;
  binDir: string;
  postgres: string;
  pgCtl: string;
  initdb: string;
  createdb: string | null;
  psql: string | null;
  major: typeof PRIVATE_POSTGRES_MAJOR;
  versionText: string;
};

export type PostgresDistributionError = {
  code:
    | "POSTGRES_HOME_MISSING"
    | "POSTGRES_BINARIES_MISSING"
    | "POSTGRES_MAJOR_UNSUPPORTED"
    | "POSTGRES_VERSION_UNREADABLE";
  message: string;
  requestedHome?: string | undefined;
  detectedMajor?: number | undefined;
};

export type PostgresDistributionResult =
  | { ok: true; distribution: PostgresDistribution }
  | { ok: false; error: PostgresDistributionError };

export function resolvePostgresHome(
  env: Record<string, string | undefined>,
  layout: SupervisorLayout
): string | null {
  const explicit = env["YUVI_POSTGRES_HOME"]?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit) && !isWindowsStylePath(explicit)) {
      throw new Error("YUVI_POSTGRES_HOME must be an absolute path.");
    }
    return canonicalPath(explicit);
  }
  if (layout.mode === "packaged") {
    const packaged = path.join(layout.resourceRoot, "postgres");
    if (fs.existsSync(packaged)) return canonicalPath(packaged);
  }
  return null;
}

export function resolvePostgresDistribution(
  env: Record<string, string | undefined>,
  layout: SupervisorLayout
): PostgresDistributionResult {
  let home: string;
  try {
    const resolved = resolvePostgresHome(env, layout);
    if (!resolved) {
      return {
        ok: false,
        error: {
          code: "POSTGRES_HOME_MISSING",
          message:
            "PostgreSQL 16 distribution was not found. Set YUVI_POSTGRES_HOME or stage resource_dir/postgres."
        }
      };
    }
    home = resolved;
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "POSTGRES_HOME_MISSING",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }

  const binDir = resolveBinDir(home);
  const postgres = findBinary(binDir, "postgres");
  const pgCtl = findBinary(binDir, "pg_ctl");
  const initdb = findBinary(binDir, "initdb");
  const psql = findBinary(binDir, "psql");
  if (!postgres || !pgCtl || !initdb) {
    return {
      ok: false,
      error: {
        code: "POSTGRES_BINARIES_MISSING",
        message: "PostgreSQL distribution is missing postgres, pg_ctl, or initdb.",
        requestedHome: home
      }
    };
  }
  if (
    !isUnderHome(postgres, home) ||
    !isUnderHome(pgCtl, home) ||
    !isUnderHome(initdb, home) ||
    (psql && !isUnderHome(psql, home))
  ) {
    return {
      ok: false,
      error: {
        code: "POSTGRES_BINARIES_MISSING",
        message: "PostgreSQL tools must resolve beneath the same distribution home.",
        requestedHome: home
      }
    };
  }

  const tools = [
    { name: "postgres", file: postgres },
    { name: "pg_ctl", file: pgCtl },
    { name: "initdb", file: initdb }
  ];
  if (psql) tools.push({ name: "psql", file: psql });
  const createdb = findBinary(binDir, "createdb");
  if (createdb) tools.push({ name: "createdb", file: createdb });

  let versionText = "";
  for (const tool of tools) {
    const inspected = inspectPostgresMajor(tool.file);
    if (!inspected.ok) {
      return {
        ok: false,
        error: {
          code: "POSTGRES_VERSION_UNREADABLE",
          message: `${tool.name}: ${inspected.message}`,
          requestedHome: home
        }
      };
    }
    if (inspected.major !== PRIVATE_POSTGRES_MAJOR) {
      return {
        ok: false,
        error: {
          code: "POSTGRES_MAJOR_UNSUPPORTED",
          message: `Private YUVI PostgreSQL requires major ${PRIVATE_POSTGRES_MAJOR} (${tool.name} is ${inspected.major}).`,
          requestedHome: home,
          detectedMajor: inspected.major
        }
      };
    }
    if (tool.name === "postgres") versionText = inspected.versionText;
  }

  return {
    ok: true,
    distribution: {
      home,
      binDir,
      postgres,
      pgCtl,
      initdb,
      createdb,
      psql,
      major: PRIVATE_POSTGRES_MAJOR,
      versionText
    }
  };
}

export function parsePostgresVersionText(
  text: string
): { ok: true; major: number } | { ok: false; message: string } {
  const labeled = text.match(/\(\s*PostgreSQL\s*\)\s*(\d+)(?:\.\d+)?/i);
  if (labeled?.[1]) {
    return { ok: true, major: Number(labeled[1]) };
  }
  const fallback = text.match(/\b(\d+)(?:\.\d+)?\b/);
  if (!fallback?.[1]) {
    return { ok: false, message: "Unrecognized postgres version string." };
  }
  const major = Number(fallback[1]);
  if (major < 10 || major > 20) {
    return { ok: false, message: "Unrecognized postgres version string." };
  }
  return { ok: true, major };
}

export function inspectPostgresMajor(
  postgresExecutable: string
): { ok: true; major: number; versionText: string } | { ok: false; message: string } {
  const result = spawnSync(postgresExecutable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    shell: false
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 || !text) {
    return { ok: false, message: "Unable to read postgres --version." };
  }
  const parsed = parsePostgresVersionText(text);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, major: parsed.major, versionText: text };
}

function resolveBinDir(home: string): string {
  const direct = path.join(home, "bin");
  if (fs.existsSync(direct)) return canonicalPath(direct);
  return canonicalPath(home);
}

function findBinary(binDir: string, name: string): string | null {
  const candidates = process.platform === "win32" ? [`${name}.exe`, name] : [name, `${name}.exe`];
  for (const candidate of candidates) {
    const full = path.join(binDir, candidate);
    if (fs.existsSync(full)) return canonicalPath(full);
  }
  return null;
}

function isUnderHome(filePath: string, home: string): boolean {
  const left = canonicalPath(filePath);
  const right = canonicalPath(home);
  if (left === right) return true;
  const prefix = right.endsWith(path.sep) ? right : `${right}${path.sep}`;
  return left.startsWith(prefix);
}
