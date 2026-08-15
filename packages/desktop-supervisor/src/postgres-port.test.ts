import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { layoutFromRoot } from "./postgres-layout.js";
import { selectPrivatePostgresPort } from "./postgres-port.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("private postgres port selection", () => {
  it("reuses a persisted port when it is free", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-port-"));
    tempDirs.push(root);
    const layout = layoutFromRoot(root);
    const listen = await selectPrivatePostgresPort({
      layout,
      clusterId: "cluster-a",
      persisted: {
        schemaVersion: 1,
        host: "127.0.0.1",
        port: 55440,
        clusterId: "cluster-a",
        postgresMajor: 16
      },
      isPortOccupied: async () => false
    });
    expect(listen.port).toBe(55440);
    expect(listen.host).toBe("127.0.0.1");
  });

  it("does not reuse a foreign-occupied port and never implies a kill", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-busy-"));
    tempDirs.push(root);
    const occupied = new Set([55432, 55440]);
    const listen = await selectPrivatePostgresPort({
      layout: layoutFromRoot(root),
      clusterId: "cluster-b",
      preferredPort: 55432,
      persisted: {
        schemaVersion: 1,
        host: "127.0.0.1",
        port: 55440,
        clusterId: "cluster-b",
        postgresMajor: 16
      },
      isPortOccupied: async (port) => occupied.has(port)
    });
    expect(occupied.has(listen.port)).toBe(false);
    expect(listen.port).not.toBe(5432);
  });

  it("does not rewrite a persisted port merely because it is occupied", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-keep-"));
    tempDirs.push(root);
    const listen = await selectPrivatePostgresPort({
      layout: layoutFromRoot(root),
      clusterId: "cluster-keep",
      preferredPort: 55432,
      persisted: {
        schemaVersion: 1,
        host: "127.0.0.1",
        port: 55440,
        clusterId: "cluster-keep",
        postgresMajor: 16
      },
      ownedPort: 55440,
      isPortOccupied: async () => true
    });
    expect(listen.port).toBe(55440);
  });

  it("reuses a proven owned port even if the probe would see it occupied", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-owned-"));
    tempDirs.push(root);
    const listen = await selectPrivatePostgresPort({
      layout: layoutFromRoot(root),
      clusterId: "cluster-c",
      ownedPort: 55432,
      isPortOccupied: async () => true
    });
    expect(listen.port).toBe(55432);
  });
});
