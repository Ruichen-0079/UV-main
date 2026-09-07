/** Opt-in acceptance for the installed checkout launcher. Restarts YUVI, never its external dependencies. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { readRuntimeEnvFiles } from "../packages/config/src/index.js";

if (process.platform !== "linux" || !process.argv.includes("--run")) {
  throw new Error("Run on Linux with --run to restart the installed YUVI daily services.");
}
const exec = promisify(execFile);
const { env } = await readRuntimeEnvFiles();
const headers = {
  "content-type": "application/json",
  ...(env["DASHBOARD_DEV_TOKEN"] ? { authorization: `Bearer ${env["DASHBOARD_DEV_TOKEN"]}` } : {})
};
const runtime = `http://127.0.0.1:${env["SERVER_PORT"] || "6121"}`;
const mem0 = env["MEM0_BASE_URL"] || "http://127.0.0.1:6131";
const stt = env["LOCAL_STT_BASE_URL"] || "http://127.0.0.1:9876";
const ollama = env["MEM0_OLLAMA_BASE_URL"] || "http://127.0.0.1:11434";
for (const url of [runtime, mem0, stt, ollama]) assert.equal(new URL(url).hostname, "127.0.0.1");
async function json(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST"
): Promise<any> {
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000)
  });
  assert(response.ok, `HTTP ${response.status} from ${new URL(url).pathname}`);
  return response.json();
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
async function systemctl(...args: string[]) {
  return exec("systemctl", ["--user", ...args]);
}
async function pid() {
  return (await systemctl("show", "yuvi-daily.service", "-p", "MainPID", "--value")).stdout.trim();
}
async function ready() {
  const [r, m, s, w, css] = await Promise.all([
    json(`${runtime}/health`),
    json(`${mem0}/health`),
    json(`${stt}/health`),
    fetch("http://127.0.0.1:5173", { signal: AbortSignal.timeout(3000) }),
    fetch("http://127.0.0.1:5173/src/styles.css", { signal: AbortSignal.timeout(3000) })
  ]);
  return (
    r.ok &&
    r.database.status === "healthy" &&
    m.data.capabilities.crud &&
    m.data.capabilities.search &&
    s.service === "yuvi-local-stt" &&
    s.ok &&
    w.ok &&
    css.ok
  );
}
async function closed(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
}
async function externalDatabase() {
  const url = new URL(env["DATABASE_URL"]!);
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 5432) });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("External PostgreSQL unavailable"));
    });
  });
}
const scope = `campaign-b-acceptance-${randomUUID()}`;
let memoryId: string | undefined;
try {
  await until(ready, "initial service readiness");
  const profiles = (await json(`${runtime}/voice-profiles`)).profiles;
  const created = await json(`${mem0}/v1/memories`, {
    scope,
    content: "Campaign B restart persistence acceptance marker.",
    infer: false
  });
  memoryId = created.data.memoryId;
  assert(memoryId);
  const before = await pid();
  assert((await json(`${runtime}/system/local-services/restart`, {})).restartRequested);
  await until(async () => {
    const next = await pid();
    return next !== "0" && next !== before;
  }, "Product restart PID change");
  await until(ready, "services after Product restart");
  assert.equal((await json(`${mem0}/v1/memories/${memoryId}`)).data.scope, scope);
  assert(
    (
      await json(`${mem0}/v1/memories/search`, {
        scope,
        query: "restart persistence acceptance",
        limit: 5
      })
    ).data.items.some((item: any) => item.id === memoryId)
  );
  assert.deepEqual((await json(`${runtime}/voice-profiles`)).profiles, profiles);
  console.log("PASS Product restart; Memory read/search and acoustic profile persistence");
  await systemctl("stop", "yuvi-daily.service");
  assert(
    (await Promise.all([runtime, mem0, stt, "http://127.0.0.1:5173"].map(closed))).every(Boolean),
    "YUVI listeners must close"
  );
  await externalDatabase();
  assert(Array.isArray((await json(`${ollama}/api/tags`)).models));
  console.log(
    "PASS shutdown closes YUVI listeners; external PostgreSQL and Ollama remain reachable"
  );
  await systemctl("start", "yuvi-daily.service");
  await until(ready, "clean daily start");
  assert.deepEqual((await json(`${runtime}/voice-profiles`)).profiles, profiles);
  assert.equal((await json(`${mem0}/v1/memories/${memoryId}`)).data.scope, scope);
  console.log("PASS clean daily start; persistence across full shutdown");
} finally {
  await systemctl("start", "yuvi-daily.service");
  await until(ready, "restore daily services");
  if (memoryId)
    await json(
      `${mem0}/v1/memories/${memoryId}?scope=${encodeURIComponent(scope)}`,
      undefined,
      "DELETE"
    );
}
