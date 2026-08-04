import { describe, expect, it } from "vitest";
import {
  canonicalPath,
  commandLineContainsPath,
  isWindowsStylePath,
  pathsEqual
} from "./paths.js";

describe("cross-platform path canonicalization", () => {
  it("detects Windows drive and UNC paths on any host OS", () => {
    expect(isWindowsStylePath("C:\\Dev\\UV-main")).toBe(true);
    expect(isWindowsStylePath("c:/Dev/UV-main")).toBe(true);
    expect(isWindowsStylePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsStylePath("/tmp/repo")).toBe(false);
    expect(isWindowsStylePath("relative\\path")).toBe(false);
  });

  it("standardizes Windows absolute paths without POSIX cwd pollution", () => {
    // On Ubuntu CI this must NOT become /home/runner/.../C:\Dev\UV-main
    const canon = canonicalPath("C:\\Dev\\UV-main");
    expect(canon).toBe("C:\\Dev\\UV-main");
    expect(canon.startsWith("/")).toBe(false);
    expect(pathsEqual("C:\\Dev\\UV-main", "C:\\Dev\\UV-main")).toBe(true);
    expect(pathsEqual("C:\\Dev\\UV-main", "C:/Dev/UV-main")).toBe(true);
  });

  it("treats Windows path case as equivalent", () => {
    expect(pathsEqual("C:\\Dev\\UV-main", "c:\\dev\\uv-main")).toBe(true);
    expect(pathsEqual("C:\\Dev\\UV-main\\", "c:/dev/uv-main")).toBe(true);
  });

  it("does not treat POSIX paths as case-insensitive", () => {
    // Pure POSIX inputs must not use Windows ignore-case rules.
    expect(pathsEqual("/tmp/Repo", "/tmp/repo")).toBe(
      canonicalPath("/tmp/Repo") === canonicalPath("/tmp/repo")
    );
    // Explicit: Windows ignore-case must not apply to POSIX-looking inputs.
    expect(isWindowsStylePath("/tmp/Repo")).toBe(false);
    expect(isWindowsStylePath("/tmp/repo")).toBe(false);
    // Distinct string inputs that stay distinct after canonicalize differ.
    const a = "/tmp/Repo-case-A";
    const b = "/tmp/Repo-case-B";
    expect(pathsEqual(a, b)).toBe(false);
  });

  it("strips trailing separators but keeps roots", () => {
    expect(canonicalPath("C:\\")).toBe("C:\\");
    expect(canonicalPath("C:\\Dev\\UV-main\\")).toBe("C:\\Dev\\UV-main");
    // Host root: POSIX `/` stays `/` on Linux; Windows may map `/` to a drive root.
    if (process.platform === "win32") {
      expect(canonicalPath("/")).toMatch(/^[A-Za-z]:\\$/);
    } else {
      expect(canonicalPath("/")).toBe("/");
    }
  });
});

describe("commandLineContainsPath", () => {
  it("matches quoted Windows paths in a command line", () => {
    const cmd =
      'powershell -NoProfile -File "C:\\Dev\\UV-main\\scripts\\dev-server-runner.ps1" -RepoRoot "C:\\Dev\\UV-main"';
    expect(commandLineContainsPath(cmd, "C:\\Dev\\UV-main")).toBe(true);
    expect(commandLineContainsPath(cmd, "c:/dev/uv-main")).toBe(true);
  });

  it("matches unquoted slash-variant Windows paths", () => {
    const cmd = "node C:/Dev/UV-main/apps/server/src/index.ts";
    expect(commandLineContainsPath(cmd, "C:\\Dev\\UV-main")).toBe(true);
  });

  it("rejects unrelated paths", () => {
    const cmd = "powershell -File C:\\Other\\App\\run.ps1";
    expect(commandLineContainsPath(cmd, "C:\\Dev\\UV-main")).toBe(false);
  });
});
