/**
 * Provision a real Windows x64 PostgreSQL 16 distribution for installer smoke.
 *
 * This is TEST INFRASTRUCTURE only. It never stages binaries into the
 * repository, Tauri resources, NSIS tree, or shipping artifacts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/** D1-validated PostgreSQL 16.10 generation; immutable EDB Windows x64 zip. */
export const POSTGRES16_FIXTURE_VERSION = "16.10-1";
export const POSTGRES16_FIXTURE_MAJOR = 16;
export const POSTGRES16_FIXTURE_URL =
  "https://get.enterprisedb.com/postgresql/postgresql-16.10-1-windows-x64-binaries.zip";
/**
 * Independently published SHA-256 from ScoopInstaller/Versions
 * commit babc386dd30c2c6fe988b7dee0b6d5f4add83f29 (postgresql16 16.10).
 */
export const POSTGRES16_FIXTURE_SHA256 =
  "ebb3b6af4fa69dea9951b66855bc4d42dc04e56ccb9aa7024ce3c58bd89d6b0c";

const REQUIRED_TOOLS = ["postgres", "pg_ctl", "initdb"];

function fail(message) {
  throw new Error(message);
}

export function parsePostgresMajor(text) {
  const labeled = String(text ?? "").match(/\(\s*PostgreSQL\s*\)\s*(\d+)(?:\.\d+)?/i);
  if (labeled?.[1]) return Number(labeled[1]);
  const fallback = String(text ?? "").match(/\b(\d+)(?:\.\d+)?\b/);
  if (!fallback?.[1]) return null;
  const major = Number(fallback[1]);
  return major >= 10 && major <= 20 ? major : null;
}

export function sha256File(
  filePath,
  { createHash = crypto.createHash, createReadStream = fs.createReadStream } = {}
) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

export function assertSha256(actual, expected = POSTGRES16_FIXTURE_SHA256) {
  const got = String(actual ?? "").toLowerCase();
  const want = String(expected ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(got) || got !== want) {
    fail("PostgreSQL 16 fixture SHA-256 mismatch");
  }
  return got;
}

export function toolName(base, platform = process.platform) {
  return platform === "win32" ? `${base}.exe` : base;
}

export function resolveFixtureBinDir(home) {
  const direct = path.join(home, "bin");
  if (fs.existsSync(direct)) return direct;
  return home;
}

export function findRequiredTool(home, name, platform = process.platform) {
  const binDir = resolveFixtureBinDir(home);
  const file = path.join(binDir, toolName(name, platform));
  return fs.existsSync(file) ? file : null;
}

export function findExtractedDistributionHome(extractRoot, platform = process.platform) {
  const candidates = [extractRoot, path.join(extractRoot, "pgsql")];
  for (const candidate of candidates) {
    if (REQUIRED_TOOLS.every((name) => findRequiredTool(candidate, name, platform))) {
      return path.resolve(candidate);
    }
  }
  fail("extracted PostgreSQL 16 fixture is missing postgres, pg_ctl, or initdb");
}

export function inspectToolMajor(executable, { spawn = spawnSync, timeout = 5_000 } = {}) {
  const result = spawn(executable, ["--version"], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    shell: false
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0 || !text) {
    fail(`unable to read ${path.basename(executable)} --version`);
  }
  const major = parsePostgresMajor(text);
  if (!Number.isInteger(major)) {
    fail(`unrecognized ${path.basename(executable)} version string`);
  }
  return { major, versionText: text };
}

export function validatePostgres16Distribution(
  home,
  { platform = process.platform, inspect = inspectToolMajor } = {}
) {
  const resolved = path.resolve(home);
  if (!path.isAbsolute(resolved) && !/^[A-Za-z]:[\\/]/.test(String(home))) {
    fail("PostgreSQL 16 fixture home must be an absolute path");
  }
  if (!fs.existsSync(resolved)) fail("PostgreSQL 16 fixture home does not exist");
  const tools = {};
  for (const name of REQUIRED_TOOLS) {
    const file = findRequiredTool(resolved, name, platform);
    if (!file) fail(`PostgreSQL 16 fixture is missing ${toolName(name, platform)}`);
    tools[name] = file;
  }
  const majors = [];
  for (const name of REQUIRED_TOOLS) {
    const inspected = inspect(tools[name]);
    if (inspected.major !== POSTGRES16_FIXTURE_MAJOR) {
      fail(
        `PostgreSQL 16 fixture requires major ${POSTGRES16_FIXTURE_MAJOR} (${name} is ${inspected.major})`
      );
    }
    majors.push(inspected.major);
  }
  if (new Set(majors).size !== 1) fail("PostgreSQL 16 fixture tools report mixed majors");
  return {
    home: resolved,
    binDir: resolveFixtureBinDir(resolved),
    tools,
    major: POSTGRES16_FIXTURE_MAJOR
  };
}

function assertSafeExtractRoot(extractRoot) {
  const resolved = path.resolve(extractRoot);
  const tempRoot = path.resolve(os.tmpdir());
  const runnerTemp = process.env.RUNNER_TEMP ? path.resolve(process.env.RUNNER_TEMP) : null;
  const allowed = [tempRoot, runnerTemp].filter(Boolean);
  const inside = allowed.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );
  if (!inside) fail("PostgreSQL 16 fixture must extract under temporary storage");
  return resolved;
}

export function downloadFile(url, destination, { request = https.get } = {}) {
  return new Promise((resolve, reject) => {
    const finishError = (error) => {
      try {
        fs.rmSync(destination, { force: true });
      } catch {
        /* ignore */
      }
      reject(error);
    };
    const file = fs.createWriteStream(destination);
    const follow = (target, remaining = 5) => {
      const req = request(target, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (remaining <= 0) {
            finishError(new Error("PostgreSQL 16 fixture download redirected too many times"));
            return;
          }
          follow(response.headers.location, remaining - 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          finishError(new Error(`PostgreSQL 16 fixture download failed (${status})`));
          return;
        }
        response.pipe(file);
        file.once("finish", () =>
          file.close((error) => (error ? finishError(error) : resolve(destination)))
        );
      });
      req.once("error", finishError);
    };
    file.once("error", finishError);
    follow(url);
  });
}

export function extractZip(
  archive,
  destination,
  { exec = spawnSync, platform = process.platform } = {}
) {
  fs.mkdirSync(destination, { recursive: true });
  const tar = platform === "win32" ? "tar.exe" : "tar";
  const result = exec(tar, ["-xf", archive, "-C", destination], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.status !== 0) {
    fail(`PostgreSQL 16 fixture extraction failed (${result.status})`);
  }
  return destination;
}

export async function provisionPostgres16Fixture({
  destRoot = process.env.RUNNER_TEMP || os.tmpdir(),
  url = POSTGRES16_FIXTURE_URL,
  expectedSha256 = POSTGRES16_FIXTURE_SHA256,
  download = downloadFile,
  extract = extractZip,
  hashFile = sha256File,
  validate = validatePostgres16Distribution,
  platform = process.platform
} = {}) {
  const root = assertSafeExtractRoot(path.join(destRoot, "yuvi-postgres-16-fixture"));
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const archive = path.join(root, "postgresql-16.10-1-windows-x64-binaries.zip");
  const extracted = path.join(root, "extracted");
  fs.mkdirSync(extracted, { recursive: true });
  await download(url, archive);
  const digest = await hashFile(archive);
  assertSha256(digest, expectedSha256);
  extract(archive, extracted, { platform });
  const home = findExtractedDistributionHome(extracted, platform);
  const validated = validate(home, { platform });
  console.error(
    `[postgres16-fixture] provisioned version=${POSTGRES16_FIXTURE_VERSION} major=${validated.major} home=${validated.home}`
  );
  return validated.home;
}

function writeGithubOutput(home) {
  const dest = process.env.GITHUB_OUTPUT;
  if (!dest) return;
  fs.appendFileSync(dest, `home=${home}\n`, "utf8");
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  provisionPostgres16Fixture()
    .then((home) => {
      writeGithubOutput(home);
      process.stdout.write(`${home}\n`);
    })
    .catch((error) => {
      console.error(
        `[postgres16-fixture] ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
    });
}
