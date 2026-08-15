import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const YUVI_SHELL_BEGIN = "# >>> YUVI MANAGED SHELL INTEGRATION >>>";
export const YUVI_SHELL_END = "# <<< YUVI MANAGED SHELL INTEGRATION <<<";

export type ShellKind = "fish" | "posix";

export type HostEnvironmentSafetyCode =
  | "INVALID_ABSOLUTE_PATH"
  | "EPHEMERAL_PERSISTENT_TARGET"
  | "REFUSE_PERSISTENT_REFERENCE_TO_EPHEMERAL_PATH"
  | "YUVI_INTEGRATION_CONFLICT"
  | "UNSUPPORTED_PLATFORM";

export class HostEnvironmentSafetyError extends Error {
  readonly code: HostEnvironmentSafetyCode;

  constructor(code: HostEnvironmentSafetyCode, message: string) {
    super(message);
    this.name = "HostEnvironmentSafetyError";
    this.code = code;
  }
}

export type HostEnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Additional runtime/temp roots to reject in addition to platform defaults. */
  ephemeralRoots?: readonly string[];
};

type PathSafetyOptions = Pick<HostEnvironmentOptions, "env" | "ephemeralRoots" | "platform">;

export type YuviHostPaths = {
  home: string;
  configHome: string;
  stateHome: string;
  dataHome: string;
  cacheHome: string;
  yuviConfigDir: string;
  yuviStateDir: string;
  yuviDataDir: string;
  yuviCacheDir: string;
  toolchainDir: string;
  toolchainEnv: string;
  toolchainFishEnv: string;
  binDir: string;
  fishDropIn: string;
  posixShellFile: string;
  ephemeralRoots: readonly string[];
  platform: NodeJS.Platform;
};

export type InstallToolchainOptions = HostEnvironmentOptions & {
  shells?: readonly ShellKind[];
};

export type ManagedFileResult = {
  path: string;
  changed: boolean;
  created: boolean;
  previousContent?: string;
  backupPath?: string;
};

export type ToolchainIntegrationResult = {
  paths: YuviHostPaths;
  files: ManagedFileResult[];
};

function requireAbsolute(value: string, variable: string): string {
  const normalized = value.trim();
  if (!path.isAbsolute(normalized)) {
    throw new HostEnvironmentSafetyError(
      "INVALID_ABSOLUTE_PATH",
      `${variable} must be an absolute path.`
    );
  }
  return path.resolve(normalized);
}

function optionalAbsolute(value: string | undefined, variable: string): string | undefined {
  if (!value?.trim()) return undefined;
  return requireAbsolute(value, variable);
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function defaultEphemeralRoots(env: NodeJS.ProcessEnv, platform = process.platform): string[] {
  const roots = new Set<string>();

  if (platform !== "win32") {
    roots.add(path.resolve("/tmp"));
    roots.add(path.resolve("/var/tmp"));
  }
  roots.add(path.resolve(tmpdir()));

  for (const variable of ["TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR"]) {
    const value = optionalAbsolute(env[variable], variable);
    if (value) roots.add(value);
  }

  return [...roots];
}

function effectiveEphemeralRoots(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | undefined,
  additionalRoots: readonly string[] | undefined
): string[] {
  return [...new Set([...defaultEphemeralRoots(env, platform), ...(additionalRoots ?? [])])];
}

export function isEphemeralPath(value: string, options: PathSafetyOptions = {}): boolean {
  if (!value.trim()) return false;
  if (/\$\{?(?:TMPDIR|TMP|TEMP|XDG_RUNTIME_DIR)\}?/.test(value)) return true;
  if (!path.isAbsolute(value)) return false;

  const env = options.env ?? process.env;
  const roots = effectiveEphemeralRoots(env, options.platform, options.ephemeralRoots);
  const candidate = path.resolve(value);
  return roots.some((root) => isPathWithin(candidate, path.resolve(root)));
}

export function assertPersistentPath(targetPath: string, options: PathSafetyOptions = {}): void {
  if (!path.isAbsolute(targetPath)) {
    throw new HostEnvironmentSafetyError(
      "INVALID_ABSOLUTE_PATH",
      `Persistent target must be absolute: ${targetPath}`
    );
  }

  if (isEphemeralPath(targetPath, options)) {
    throw new HostEnvironmentSafetyError(
      "EPHEMERAL_PERSISTENT_TARGET",
      `Refusing persistent target under an ephemeral root: ${targetPath}`
    );
  }
}

export function assertSafePersistentReference(
  sourcePath: string,
  targetPath: string,
  options: PathSafetyOptions = {}
): void {
  assertPersistentPath(targetPath, options);

  if (isEphemeralPath(sourcePath, options)) {
    throw new HostEnvironmentSafetyError(
      "REFUSE_PERSISTENT_REFERENCE_TO_EPHEMERAL_PATH",
      `REFUSE_PERSISTENT_REFERENCE_TO_EPHEMERAL_PATH: ${targetPath} cannot reference ${sourcePath}`
    );
  }
}

function containsEphemeralReference(content: string, options: PathSafetyOptions = {}): boolean {
  if (/\${?(?:TMPDIR|TMP|TEMP|XDG_RUNTIME_DIR)}?/.test(content)) return true;
  if (/\/tmp\/|\/var\/tmp\//.test(content)) return true;
  if (/\bmktemp\b/.test(content)) return true;

  const env = options.env ?? process.env;
  const roots = effectiveEphemeralRoots(env, options.platform, options.ephemeralRoots);
  return roots.some((root) => {
    const normalizedRoot = path.resolve(root);
    return (
      content.includes(`${normalizedRoot}${path.sep}`) || content.includes(`${normalizedRoot}/`)
    );
  });
}

export function assertSafePersistentContent(
  targetPath: string,
  content: string,
  options: PathSafetyOptions = {}
): void {
  assertPersistentPath(targetPath, options);
  if (containsEphemeralReference(content, options)) {
    throw new HostEnvironmentSafetyError(
      "REFUSE_PERSISTENT_REFERENCE_TO_EPHEMERAL_PATH",
      `REFUSE_PERSISTENT_REFERENCE_TO_EPHEMERAL_PATH: ${targetPath} content contains an ephemeral path or runtime temporary reference`
    );
  }
}

async function canonicalEphemeralRoots(options: PathSafetyOptions): Promise<string[]> {
  const env = options.env ?? process.env;
  const roots = effectiveEphemeralRoots(env, options.platform, options.ephemeralRoots);
  const canonicalRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(path.resolve(root));
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      }
    })
  );
  return canonicalRoots.filter((root): root is string => root !== undefined);
}

async function assertSafeCanonicalPath(
  candidatePath: string,
  options: PathSafetyOptions
): Promise<void> {
  const candidate = path.resolve(candidatePath);
  assertPersistentPath(candidate, options);
  const roots = await canonicalEphemeralRoots(options);
  if (roots.some((root) => isPathWithin(candidate, root))) {
    throw new HostEnvironmentSafetyError(
      "EPHEMERAL_PERSISTENT_TARGET",
      `Refusing persistent path whose canonical location is under an ephemeral root: ${candidate}`
    );
  }
}

async function resolveExistingAncestor(targetPath: string): Promise<string> {
  let candidate = path.resolve(targetPath);
  for (;;) {
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) {
        try {
          return await realpath(candidate);
        } catch (error) {
          if (isNodeError(error, "ENOENT")) {
            throw new HostEnvironmentSafetyError(
              "YUVI_INTEGRATION_CONFLICT",
              `Refusing to use a dangling symlink in persistent path: ${candidate}`
            );
          }
          throw error;
        }
      }
      return await realpath(candidate);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function assertSafePersistentDestination(
  targetPath: string,
  options: PathSafetyOptions = {}
): Promise<string> {
  const normalizedTarget = path.resolve(targetPath);
  assertPersistentPath(normalizedTarget, options);

  try {
    const stats = await lstat(normalizedTarget);
    if (stats.isSymbolicLink()) {
      throw new HostEnvironmentSafetyError(
        "YUVI_INTEGRATION_CONFLICT",
        `Refusing to replace symlink integration target: ${normalizedTarget}`
      );
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const canonicalParent = await resolveExistingAncestor(path.dirname(normalizedTarget));
  await assertSafeCanonicalPath(canonicalParent, options);
  return normalizedTarget;
}

async function ensureSafeDirectory(
  directoryPath: string,
  options: PathSafetyOptions = {}
): Promise<void> {
  const directory = path.resolve(directoryPath);
  assertPersistentPath(directory, options);

  const root = path.parse(directory).root;
  let current = root;
  const relative = path.relative(root, directory);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
      }
      stats = await lstat(current);
    }

    if (!stats.isDirectory() && !stats.isSymbolicLink()) {
      throw new HostEnvironmentSafetyError(
        "YUVI_INTEGRATION_CONFLICT",
        `Refusing to use non-directory persistent path component: ${current}`
      );
    }

    const canonical = await resolveExistingAncestor(current);
    await assertSafeCanonicalPath(canonical, options);
  }
}

function resolveHome(options: HostEnvironmentOptions): string {
  const env = options.env ?? process.env;
  return requireAbsolute(options.home ?? env["HOME"] ?? env["USERPROFILE"] ?? homedir(), "HOME");
}

function resolveXdgHome(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  return optionalAbsolute(env[variable], variable) ?? path.resolve(fallback);
}

export function resolveYuviHostPaths(options: HostEnvironmentOptions = {}): YuviHostPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = resolveHome(options);
  const configFallback =
    platform === "win32"
      ? (env["APPDATA"] ?? path.join(home, "AppData", "Roaming"))
      : path.join(home, ".config");
  const stateFallback =
    platform === "win32"
      ? (env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"))
      : path.join(home, ".local", "state");
  const dataFallback =
    platform === "win32"
      ? (env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"))
      : path.join(home, ".local", "share");
  const cacheFallback =
    platform === "win32"
      ? (env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local", "Temp"))
      : path.join(home, ".cache");
  const configHome = resolveXdgHome(env, "XDG_CONFIG_HOME", configFallback);
  const stateHome = resolveXdgHome(env, "XDG_STATE_HOME", stateFallback);
  const dataHome = resolveXdgHome(env, "XDG_DATA_HOME", dataFallback);
  const cacheHome = resolveXdgHome(env, "XDG_CACHE_HOME", cacheFallback);
  const yuviConfigDir = path.join(configHome, "yuvi");
  const yuviStateDir = path.join(stateHome, "yuvi");
  const yuviDataDir = path.join(dataHome, "yuvi");
  const yuviCacheDir = path.join(cacheHome, "yuvi");
  const toolchainDir = path.join(yuviConfigDir, "toolchain");
  const binDir =
    platform === "win32" ? path.join(dataHome, "yuvi", "bin") : path.join(home, ".local", "bin");

  return {
    home,
    configHome,
    stateHome,
    dataHome,
    cacheHome,
    yuviConfigDir,
    yuviStateDir,
    yuviDataDir,
    yuviCacheDir,
    toolchainDir,
    toolchainEnv: path.join(toolchainDir, "env"),
    toolchainFishEnv: path.join(toolchainDir, "env.fish"),
    binDir,
    fishDropIn: path.join(configHome, "fish", "conf.d", "yuvi.fish"),
    posixShellFile: path.join(yuviConfigDir, "shell", "yuvi.sh"),
    ephemeralRoots: effectiveEphemeralRoots(env, platform, options.ephemeralRoots),
    platform
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fishQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

function managedHeader(): string {
  return `${YUVI_SHELL_BEGIN}\n# Generated by YUVI. Do not edit; rerun the integration writer.\n`;
}

export function renderPosixToolchainEnvironment(paths: YuviHostPaths): string {
  const bin = shellQuote(paths.binDir);
  return `${managedHeader()}__YUVI_BIN_DIR=${bin}
case ":${"${PATH-}"}:" in
  *:"${"${__YUVI_BIN_DIR}"}":*) ;;
  *) PATH="${"${__YUVI_BIN_DIR}"}${"${PATH:+:${PATH}}"}"; export PATH ;;
esac
unset __YUVI_BIN_DIR
${YUVI_SHELL_END}
`;
}

export function renderFishToolchainEnvironment(paths: YuviHostPaths): string {
  const bin = fishQuote(paths.binDir);
  return `${managedHeader()}set -l __yuvi_bin_dir ${bin}
if not contains -- $__yuvi_bin_dir $PATH
    set -gx PATH $__yuvi_bin_dir $PATH
end
set -e __yuvi_bin_dir
${YUVI_SHELL_END}
`;
}

export function renderPosixShellIntegration(envFile: string): string {
  return `${managedHeader()}if [ -r ${shellQuote(envFile)} ]; then
  . ${shellQuote(envFile)} 2>/dev/null || :
fi
${YUVI_SHELL_END}
`;
}

export function renderFishShellIntegration(envFile: string): string {
  const quoted = fishQuote(envFile);
  return `${managedHeader()}if test -r ${quoted}
    source ${quoted} >/dev/null 2>&1
    or true
end
${YUVI_SHELL_END}
`;
}

function isManagedContent(content: string): boolean {
  return content.includes(YUVI_SHELL_BEGIN) && content.includes(YUVI_SHELL_END);
}

async function readExisting(targetPath: string): Promise<string | undefined> {
  try {
    const stats = await lstat(targetPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new HostEnvironmentSafetyError(
        "YUVI_INTEGRATION_CONFLICT",
        `Refusing to replace non-regular or symlink integration target: ${targetPath}`
      );
    }
    return await readFile(targetPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

async function backupExisting(targetPath: string): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
  let backupPath = `${targetPath}.backup-${stamp}`;
  for (;;) {
    try {
      await copyFile(targetPath, backupPath, fsConstants.COPYFILE_EXCL);
      return backupPath;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      backupPath = `${targetPath}.backup-${stamp}-${randomUUID()}`;
    }
  }
}

async function atomicWrite(
  targetPath: string,
  content: string,
  options: PathSafetyOptions = {}
): Promise<void> {
  const normalizedTarget = await assertSafePersistentDestination(targetPath, options);
  const directory = path.dirname(normalizedTarget);
  await ensureSafeDirectory(directory, options);
  await assertSafePersistentDestination(normalizedTarget, options);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(normalizedTarget)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o644);
    await rename(temporaryPath, normalizedTarget);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function restoreFile(
  result: ManagedFileResult,
  options: PathSafetyOptions = {}
): Promise<void> {
  if (!result.changed) return;
  if (result.previousContent === undefined) {
    await unlink(result.path).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
    return;
  }
  await atomicWrite(result.path, result.previousContent, options);
}

export async function writeManagedFile(
  targetPath: string,
  content: string,
  options: Pick<HostEnvironmentOptions, "env" | "ephemeralRoots" | "platform"> = {}
): Promise<ManagedFileResult> {
  const normalizedTarget = await assertSafePersistentDestination(targetPath, options);
  assertSafePersistentContent(normalizedTarget, content, options);
  const previousContent = await readExisting(normalizedTarget);
  if (previousContent === content) {
    return { path: normalizedTarget, changed: false, created: false };
  }
  if (previousContent !== undefined && !isManagedContent(previousContent)) {
    throw new HostEnvironmentSafetyError(
      "YUVI_INTEGRATION_CONFLICT",
      `Refusing to overwrite non-YUVI content at ${normalizedTarget}`
    );
  }

  const backupPath =
    previousContent === undefined ? undefined : await backupExisting(normalizedTarget);
  await atomicWrite(normalizedTarget, content, options);
  return {
    path: normalizedTarget,
    changed: true,
    created: previousContent === undefined,
    ...(previousContent !== undefined ? { previousContent } : {}),
    ...(backupPath ? { backupPath } : {})
  };
}

export async function removeManagedFile(
  targetPath: string,
  options: Pick<HostEnvironmentOptions, "env" | "ephemeralRoots" | "platform"> = {}
): Promise<ManagedFileResult> {
  const normalizedTarget = await assertSafePersistentDestination(targetPath, options);
  const previousContent = await readExisting(normalizedTarget);
  if (previousContent === undefined) {
    return { path: normalizedTarget, changed: false, created: false };
  }
  if (!isManagedContent(previousContent)) {
    throw new HostEnvironmentSafetyError(
      "YUVI_INTEGRATION_CONFLICT",
      `Refusing to remove non-YUVI content at ${normalizedTarget}`
    );
  }
  const backupPath = await backupExisting(normalizedTarget);
  await unlink(normalizedTarget);
  return {
    path: normalizedTarget,
    changed: true,
    created: false,
    previousContent,
    backupPath
  };
}

function assertPlatform(paths: YuviHostPaths): void {
  if (paths.platform === "win32") {
    throw new HostEnvironmentSafetyError(
      "UNSUPPORTED_PLATFORM",
      "POSIX shell integration is not installed on Windows; use the Windows packaged runtime environment."
    );
  }
}

function assertPathSet(paths: YuviHostPaths): void {
  for (const target of [
    paths.configHome,
    paths.stateHome,
    paths.dataHome,
    paths.cacheHome,
    paths.yuviConfigDir,
    paths.yuviStateDir,
    paths.yuviDataDir,
    paths.yuviCacheDir,
    paths.toolchainDir,
    paths.toolchainEnv,
    paths.toolchainFishEnv,
    paths.binDir,
    paths.fishDropIn,
    paths.posixShellFile
  ]) {
    assertPersistentPath(target, { ephemeralRoots: paths.ephemeralRoots });
  }
}

type IntegrationSpec = { targetPath: string; content: string; sourcePath?: string };

function integrationSpecs(paths: YuviHostPaths, shells: readonly ShellKind[]): IntegrationSpec[] {
  const specs: IntegrationSpec[] = [
    { targetPath: paths.toolchainEnv, content: renderPosixToolchainEnvironment(paths) },
    { targetPath: paths.toolchainFishEnv, content: renderFishToolchainEnvironment(paths) }
  ];

  if (shells.includes("fish")) {
    specs.push({
      targetPath: paths.fishDropIn,
      content: renderFishShellIntegration(paths.toolchainFishEnv),
      sourcePath: paths.toolchainFishEnv
    });
  }
  if (shells.includes("posix")) {
    specs.push({
      targetPath: paths.posixShellFile,
      content: renderPosixShellIntegration(paths.toolchainEnv),
      sourcePath: paths.toolchainEnv
    });
  }
  return specs;
}

async function preflightSpecs(
  specs: readonly IntegrationSpec[],
  safetyOptions: PathSafetyOptions
): Promise<void> {
  for (const spec of specs) {
    await assertSafePersistentDestination(spec.targetPath, safetyOptions);
    if (spec.sourcePath) {
      await assertSafePersistentDestination(spec.sourcePath, safetyOptions);
      assertSafePersistentReference(spec.sourcePath, spec.targetPath, safetyOptions);
    }
    const existing = await readExisting(path.resolve(spec.targetPath));
    if (existing !== undefined && !isManagedContent(existing)) {
      throw new HostEnvironmentSafetyError(
        "YUVI_INTEGRATION_CONFLICT",
        `Refusing to overwrite non-YUVI content at ${spec.targetPath}`
      );
    }
  }
}

export async function installToolchainIntegration(
  options: InstallToolchainOptions = {}
): Promise<ToolchainIntegrationResult> {
  const paths = resolveYuviHostPaths(options);
  assertPlatform(paths);
  assertPathSet(paths);
  const shells = options.shells ?? ["fish", "posix"];
  const specs = integrationSpecs(paths, shells);
  const safetyOptions: PathSafetyOptions = {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ephemeralRoots: paths.ephemeralRoots
  };
  await preflightSpecs(specs, safetyOptions);

  const results: ManagedFileResult[] = [];
  try {
    for (const spec of specs) {
      results.push(
        await writeManagedFile(spec.targetPath, spec.content, {
          ...safetyOptions
        })
      );
    }
  } catch (error) {
    for (const result of [...results].reverse()) {
      await restoreFile(result, safetyOptions).catch(() => undefined);
    }
    throw error;
  }

  return { paths, files: results };
}

export async function removeToolchainIntegration(
  options: InstallToolchainOptions = {}
): Promise<ToolchainIntegrationResult> {
  const paths = resolveYuviHostPaths(options);
  assertPlatform(paths);
  assertPathSet(paths);
  const shells = options.shells ?? ["fish", "posix"];
  const specs = integrationSpecs(paths, shells);
  const safetyOptions: PathSafetyOptions = {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ephemeralRoots: paths.ephemeralRoots
  };
  await preflightSpecs(specs, safetyOptions);

  const results: ManagedFileResult[] = [];
  try {
    for (const spec of specs) {
      results.push(
        await removeManagedFile(spec.targetPath, {
          ...safetyOptions
        })
      );
    }
  } catch (error) {
    for (const result of [...results].reverse()) {
      await restoreFile(result, safetyOptions).catch(() => undefined);
    }
    throw error;
  }

  return { paths, files: results };
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}
