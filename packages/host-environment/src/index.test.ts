import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  YUVI_SHELL_BEGIN,
  YUVI_SHELL_END,
  assertPersistentPath,
  assertSafePersistentReference,
  assertSafePersistentContent,
  installToolchainIntegration,
  isEphemeralPath,
  pathExists,
  removeToolchainIntegration,
  renderFishShellIntegration,
  renderPosixShellIntegration,
  resolveYuviHostPaths,
  writeManagedFile
} from "./index.js";

const sandboxes: string[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSandbox(): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(homedir(), ".yuvi-host-environment-"));
  sandboxes.push(root);
  return {
    root,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      TMPDIR: path.join(root, "runtime-tmp")
    }
  };
}

describe("host environment safety", () => {
  it("resolves persistent XDG paths and rejects ephemeral references", () => {
    const paths = resolveYuviHostPaths({
      env: { HOME: "/home/yuvi" },
      ephemeralRoots: ["/tmp", "/var/tmp"]
    });

    expect(paths.toolchainEnv).toBe("/home/yuvi/.config/yuvi/toolchain/env");
    expect(paths.toolchainFishEnv).toBe("/home/yuvi/.config/yuvi/toolchain/env.fish");
    expect(paths.fishDropIn).toBe("/home/yuvi/.config/fish/conf.d/yuvi.fish");
    expect(paths.posixShellFile).not.toMatch(/\.profile|\.bashrc|\.zshrc/u);
    expect(isEphemeralPath("/tmp/yuvi-toolchain/env", { ephemeralRoots: ["/tmp"] })).toBe(true);

    expect(() =>
      assertSafePersistentReference("/tmp/yuvi-toolchain/env", "/home/yuvi/.profile", {
        ephemeralRoots: ["/tmp"]
      })
    ).toThrowError(
      expect.objectContaining({ code: "REFUSE_PERSISTENT_REFERENCE_TO_EPHEMERAL_PATH" })
    );
  });

  it("renders fail-open shell integration without persistent temp references", () => {
    const posix = renderPosixShellIntegration("/home/yuvi/.config/yuvi/toolchain/env");
    const fish = renderFishShellIntegration("/home/yuvi/.config/yuvi/toolchain/env.fish");

    expect(posix).toContain("[ -r");
    expect(posix).toContain("|| :");
    expect(fish).toContain("test -r");
    expect(fish).toContain("or true");
    expect(posix).toContain(YUVI_SHELL_BEGIN);
    expect(fish).toContain(YUVI_SHELL_END);
    expect(posix).not.toMatch(/\/tmp\/|\/var\/tmp\/|\$TMPDIR/u);
    expect(fish).not.toMatch(/\/tmp\/|\/var\/tmp\/|\$TMPDIR/u);
  });

  it("rejects ephemeral references at the persistent writer boundary", async () => {
    const { root, env } = await createSandbox();
    const target = path.join(root, ".profile");
    const unsafeContentSamples = [
      '. "/tmp/yuvi-toolchain/env"\n',
      '. "/var/tmp/yuvi-toolchain/env"\n',
      '. "$TMPDIR/yuvi-toolchain/env"\n',
      'tmp_dir="$(mktemp -d)"\n'
    ];

    expect(() =>
      assertPersistentPath("/tmp/yuvi-profile", { env, ephemeralRoots: [] })
    ).toThrowError(expect.objectContaining({ code: "EPHEMERAL_PERSISTENT_TARGET" }));
    for (const unsafeContent of unsafeContentSamples) {
      expect(() =>
        assertSafePersistentContent(target, unsafeContent, { env, ephemeralRoots: [] })
      ).toThrowError(
        expect.objectContaining({ code: "REFUSE_PERSISTENT_REFERENCE_TO_EPHEMERAL_PATH" })
      );
      await expect(
        writeManagedFile(target, unsafeContent, { env, ephemeralRoots: [] })
      ).rejects.toMatchObject({ code: "REFUSE_PERSISTENT_REFERENCE_TO_EPHEMERAL_PATH" });
    }
    expect(await pathExists(target)).toBe(false);
  });

  it("installs atomically, is idempotent, and never touches .profile", async () => {
    const { root, env } = await createSandbox();
    const profilePath = path.join(root, ".profile");
    await writeFile(profilePath, "# user content\n", "utf8");
    const beforeProfile = await readFile(profilePath, "utf8");

    const first = await installToolchainIntegration({
      env,
      home: root,
      ephemeralRoots: [],
      shells: ["fish", "posix"]
    });
    const firstContents = await Promise.all(
      [
        first.paths.toolchainEnv,
        first.paths.toolchainFishEnv,
        first.paths.fishDropIn,
        first.paths.posixShellFile
      ].map((file) => readFile(file, "utf8"))
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const repeat = await installToolchainIntegration({
        env,
        home: root,
        ephemeralRoots: [],
        shells: ["fish", "posix"]
      });
      expect(repeat.files.every((file) => !file.changed)).toBe(true);
    }

    const afterContents = await Promise.all(
      [
        first.paths.toolchainEnv,
        first.paths.toolchainFishEnv,
        first.paths.fishDropIn,
        first.paths.posixShellFile
      ].map((file) => readFile(file, "utf8"))
    );
    expect(afterContents).toEqual(firstContents);
    expect(await readFile(profilePath, "utf8")).toBe(beforeProfile);
    expect(firstContents.join("\n").match(new RegExp(YUVI_SHELL_BEGIN, "g"))?.length).toBe(4);
  });

  it("keeps POSIX and fish startup successful when environment files disappear", async () => {
    const { root, env } = await createSandbox();
    const installed = await installToolchainIntegration({
      env,
      home: root,
      ephemeralRoots: [],
      shells: ["fish", "posix"]
    });
    await rm(installed.paths.toolchainEnv);
    await rm(installed.paths.toolchainFishEnv);

    const shellEnv = { ...process.env, ...env, PATH: process.env["PATH"] ?? "" };
    for (const shell of ["sh", "bash"]) {
      const posix = spawnSync(
        shell,
        ["-lc", `. ${JSON.stringify(installed.paths.posixShellFile)}`],
        {
          env: shellEnv,
          encoding: "utf8"
        }
      );
      if (posix.error?.message.includes("ENOENT")) continue;
      expect(posix.status).toBe(0);
      expect(posix.stderr).toBe("");
    }

    const fish = spawnSync("fish", ["-l", "-c", "exit 0"], {
      env: shellEnv,
      encoding: "utf8"
    });
    if (fish.error?.message.includes("ENOENT")) return;
    expect(fish.status).toBe(0);
    expect(fish.stderr).toBe("");
  });

  it("fails before writing when an existing target is not Yuvi-owned", async () => {
    const { root, env } = await createSandbox();
    const paths = resolveYuviHostPaths({ env, home: root, ephemeralRoots: [] });
    await mkdir(path.dirname(paths.fishDropIn), { recursive: true });
    await writeFile(paths.fishDropIn, "# user-owned fish config\n", "utf8");

    await expect(
      installToolchainIntegration({ env, home: root, ephemeralRoots: [], shells: ["fish"] })
    ).rejects.toMatchObject({
      code: "YUVI_INTEGRATION_CONFLICT"
    });
    expect(await pathExists(paths.toolchainEnv)).toBe(false);
    expect(await readFile(paths.fishDropIn, "utf8")).toBe("# user-owned fish config\n");
  });

  it("removes only managed files and preserves user files", async () => {
    const { root, env } = await createSandbox();
    const profilePath = path.join(root, ".profile");
    await writeFile(profilePath, "# keep this\n", "utf8");
    const installed = await installToolchainIntegration({
      env,
      home: root,
      ephemeralRoots: [],
      shells: ["fish", "posix"]
    });

    await removeToolchainIntegration({
      env,
      home: root,
      ephemeralRoots: [],
      shells: ["fish", "posix"]
    });

    expect(await pathExists(installed.paths.toolchainEnv)).toBe(false);
    expect(await pathExists(installed.paths.toolchainFishEnv)).toBe(false);
    expect(await pathExists(installed.paths.fishDropIn)).toBe(false);
    expect(await pathExists(installed.paths.posixShellFile)).toBe(false);
    expect(await readFile(profilePath, "utf8")).toBe("# keep this\n");
  });

  it("does not install POSIX integration on Windows", async () => {
    const { root, env } = await createSandbox();

    await expect(
      installToolchainIntegration({ env, home: root, platform: "win32", shells: ["posix"] })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
    expect(await pathExists(path.join(root, ".config"))).toBe(false);
  });
});
