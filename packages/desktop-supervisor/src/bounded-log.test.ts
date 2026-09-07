import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { expect, it } from "vitest";
import { boundedLog, pruneInactiveLogs } from "./bounded-log.js";
it("bounds noisy output and an oversized chunk while retaining the newest bytes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-log-"));
  try {
    const file = path.join(dir, "runtime.log");
    const stream = boundedLog(file, 128);
    for (let i = 0; i < 20; i++) stream.write(Buffer.alloc(100, i));
    stream.end(Buffer.alloc(1000, 42));
    await finished(stream);
    expect(fs.statSync(file).size).toBe(128);
    expect(fs.statSync(`${file}.1`).size).toBeLessThanOrEqual(128);
    expect(fs.readFileSync(file)).toEqual(Buffer.alloc(128, 42));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("a log write failure does not crash the owning supervisor", async () => {
  const stream = boundedLog("/nonexistent-yuvi-log-directory/runtime.log");
  stream.end("diagnostic");
  await expect(finished(stream)).resolves.toBeUndefined();
});

it("expires only old known logs of inactive instances and preserves durable/unknown files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-log-ttl-"));
  try {
    for (const [suffix, pid] of [
      ["1", 2147483647],
      ["2", process.pid]
    ] as const) {
      const dir = path.join(root, `00000000-0000-0000-0000-00000000000${suffix}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "runtime.pid.json"), JSON.stringify({ pid }));
      for (const name of ["runtime.log", "profiles.json", "memory.db", "settings.json"]) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, "keep unless expired operational log");
        fs.utimesSync(file, new Date(0), new Date(0));
      }
    }
    pruneInactiveLogs(root);
    const dead = path.join(root, "00000000-0000-0000-0000-000000000001");
    const live = path.join(root, "00000000-0000-0000-0000-000000000002");
    expect(fs.existsSync(path.join(dead, "runtime.log"))).toBe(false);
    expect(fs.existsSync(path.join(live, "runtime.log"))).toBe(true);
    for (const name of ["profiles.json", "memory.db", "settings.json", "runtime.pid.json"])
      expect(fs.existsSync(path.join(dead, name))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
