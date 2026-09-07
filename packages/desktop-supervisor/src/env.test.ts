import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadYuviEnvFiles } from "./env.js";
import { loadSupervisorConfig } from "./config.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it("retains external configuration across checkout replacement with local precedence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-env-"));
  roots.push(root);
  const config = path.join(root, "config");
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, ".env"), "SERVER_PORT=6100\n");
  fs.writeFileSync(
    path.join(config, ".env.local"),
    "SERVER_PORT=6199\nYUVI_AUTOSTART_MEM0=false\n"
  );
  vi.stubEnv("YUVI_RUNTIME_ENV_DIR", config);
  vi.stubEnv("SERVER_PORT", "6200");
  for (const name of ["old", "new"]) {
    const checkout = path.join(root, name);
    fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(checkout, ".env.local"), "SERVER_PORT=6300\n");
    fs.writeFileSync(path.join(checkout, "scripts/dev-server-runner.sh"), "");
    expect(loadYuviEnvFiles(checkout)["SERVER_PORT"]).toBe("6199");
    const result = loadSupervisorConfig({ repositoryRoot: checkout });
    expect(result.runtimeStart?.env["YUVI_RUNTIME_ENV_DIR"]).toBe(config);
    expect(result.runtimeStart?.cwd).toBe(checkout);
  }
});
