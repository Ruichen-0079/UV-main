import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MEM0_DEV_ENV_SETUP_HINT,
  resolveMem0Start,
  resolveMem0StartDetailed,
  resolveMem0VenvInterpreter
} from "./config.js";

const tempRoots: string[] = [];

function makeRepo(opts: {
  withSrc?: boolean;
  linuxVenv?: boolean;
  windowsVenv?: boolean;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-mem0-resolve-"));
  tempRoots.push(root);
  const sidecar = path.join(root, "services", "memory-mem0");
  if (opts.withSrc !== false) {
    fs.mkdirSync(path.join(sidecar, "src", "yuvi_mem0"), { recursive: true });
    fs.writeFileSync(path.join(sidecar, "src", "yuvi_mem0", "__init__.py"), "");
  } else {
    fs.mkdirSync(sidecar, { recursive: true });
  }
  if (opts.linuxVenv) {
    const py = path.join(sidecar, ".venv", "bin", "python");
    fs.mkdirSync(path.dirname(py), { recursive: true });
    fs.writeFileSync(py, "#!/bin/sh\nexit 0\n");
  }
  if (opts.windowsVenv) {
    const py = path.join(sidecar, ".venv", "Scripts", "python.exe");
    fs.mkdirSync(path.dirname(py), { recursive: true });
    fs.writeFileSync(py, "MZ");
  }
  return root;
}

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveMem0Start Linux/Windows venv resolution", () => {
  it("prefers Linux .venv/bin/python and never bare python", () => {
    const root = makeRepo({ linuxVenv: true });
    const detailed = resolveMem0StartDetailed(root, {}, "http://127.0.0.1:6131", {
      platform: "linux",
      runDefaultPreflight: false
    });
    expect(detailed.error).toBeNull();
    expect(detailed.start?.file).toBe(
      path.join(root, "services", "memory-mem0", ".venv", "bin", "python")
    );
    expect(detailed.start?.args).toEqual(["-m", "yuvi_mem0"]);
    expect(detailed.start?.file).not.toBe("python");
    expect(detailed.start?.file).not.toBe("python3");
  });

  it("prefers Windows .venv/Scripts/python.exe", () => {
    const root = makeRepo({ windowsVenv: true });
    const start = resolveMem0Start(root, {}, "http://127.0.0.1:6131", {
      platform: "win32",
      runDefaultPreflight: false
    });
    expect(start?.file).toBe(
      path.join(root, "services", "memory-mem0", ".venv", "Scripts", "python.exe")
    );
  });

  it("honors explicit YUVI_MEM0_START_COMMAND over venv discovery", () => {
    const root = makeRepo({ linuxVenv: true });
    const start = resolveMem0Start(
      root,
      { YUVI_MEM0_START_COMMAND: "/opt/custom/mem0-runner --flag" },
      "http://127.0.0.1:6131",
      { platform: "linux", runDefaultPreflight: false }
    );
    expect(start?.file).toBe("/opt/custom/mem0-runner");
    expect(start?.args).toEqual(["--flag"]);
  });

  it("fails closed with actionable error when Linux venv is missing", () => {
    const root = makeRepo({});
    const detailed = resolveMem0StartDetailed(root, {}, "http://127.0.0.1:6131", {
      platform: "linux",
      runDefaultPreflight: false
    });
    expect(detailed.start).toBeNull();
    expect(detailed.error).toMatch(/Mem0 development environment not installed\/invalid/i);
    expect(detailed.error).toContain(MEM0_DEV_ENV_SETUP_HINT);
    expect(detailed.error).toMatch(/\.venv\/bin\/python/);
  });

  it("does not resolve Windows Scripts path on Linux", () => {
    const root = makeRepo({ windowsVenv: true });
    const interpreter = resolveMem0VenvInterpreter(
      path.join(root, "services", "memory-mem0"),
      "linux"
    );
    expect(interpreter).toBeNull();
    const detailed = resolveMem0StartDetailed(root, {}, "http://127.0.0.1:6131", {
      platform: "linux",
      runDefaultPreflight: false
    });
    expect(detailed.start).toBeNull();
  });

  it("returns null without error when Mem0 sources are absent", () => {
    const root = makeRepo({ withSrc: false });
    const detailed = resolveMem0StartDetailed(root, {}, "http://127.0.0.1:6131", {
      platform: "linux",
      runDefaultPreflight: false
    });
    expect(detailed).toEqual({ start: null, error: null });
  });

  it("fails closed when interpreter preflight rejects the venv", () => {
    const root = makeRepo({ linuxVenv: true });
    const detailed = resolveMem0StartDetailed(root, {}, "http://127.0.0.1:6131", {
      platform: "linux",
      preflightInterpreter: () =>
        "Mem0 development environment not installed/invalid (No module named 'uvicorn'). " +
        MEM0_DEV_ENV_SETUP_HINT
    });
    expect(detailed.start).toBeNull();
    expect(detailed.error).toMatch(/uvicorn/i);
  });
});
