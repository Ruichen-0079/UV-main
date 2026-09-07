/** Opt-in acceptance for the installed checkout launcher. Restarts YUVI, never its external dependencies. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import fs from "node:fs";
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
const tts = env["LOCAL_TTS_BASE_URL"] || "http://127.0.0.1:9881";
const ollama = env["MEM0_OLLAMA_BASE_URL"] || "http://127.0.0.1:11434";
for (const url of [runtime, mem0, stt, tts, ollama])
  assert.equal(new URL(url).hostname, "127.0.0.1");
async function json(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST"
): Promise<any> {
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000)
  });
  assert(response.ok, `HTTP ${response.status} from ${new URL(url).pathname}`);
  return response.json();
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 180_000;
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
  const [r, m, s, w, css, t] = await Promise.all([
    json(`${runtime}/health`),
    json(`${mem0}/health`),
    json(`${stt}/health`),
    fetch("http://127.0.0.1:5173", { signal: AbortSignal.timeout(3000) }),
    fetch("http://127.0.0.1:5173/src/styles.css", { signal: AbortSignal.timeout(3000) }),
    json(`${tts}/health`)
  ]);
  return (
    t.state === "ready" &&
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
async function cgroupPids(): Promise<number[]> {
  const pids: number[] = [];
  for (const unit of ["yuvi-daily.service", "yuvi-daily-web.service"]) {
    const group = (await systemctl("show", unit, "-p", "ControlGroup", "--value")).stdout.trim();
    if (!group) continue;
    const root = `/sys/fs/cgroup${group}`;
    if (fs.existsSync(root)) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
          else if (entry.name === "cgroup.procs")
            pids.push(
              ...fs
                .readFileSync(`${dir}/${entry.name}`, "utf8")
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .map(Number)
            );
        }
      };
      walk(root);
    }
  }
  return [...new Set(pids)];
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
const scope = `campaign-g-acceptance-${randomUUID()}`;
let memoryId: string | undefined;
try {
  await systemctl("start", "yuvi-daily.service");
  await until(ready, "initial service readiness");
  const initialPid = await pid();
  await systemctl("start", "yuvi-daily.service");
  assert.equal(await pid(), initialPid, "repeated start must retain one Supervisor");
  const status = await json("http://127.0.0.1:5173/yuvi-daily/status");
  assert.deepEqual(
    status.services.map((s: any) => s.id),
    ["postgres", "ollama", "mem0", "runtime", "local_stt", "tts_wrapper"]
  );
  for (const service of status.services) {
    assert.deepEqual(Object.keys(service).sort(), ["id", "managed", "status"]);
    if (["postgres", "ollama"].includes(service.id)) assert.equal(service.managed, false);
  }
  const providers = await json(`${runtime}/providers/status`);
  assert.equal(typeof providers.providers.vision.configured, "boolean");
  assert.equal(typeof providers.providers.vision.available, "boolean");
  console.log(
    `PASS safe diagnostic projection; one-shot Vision configured=${providers.providers.vision.configured}, available=${providers.providers.vision.available}`
  );
  const turn = await json(`${runtime}/v1/messages`, {
    sessionId: scope,
    text: "Reply with OK.",
    voiceOutput: false,
    options: { useMemory: false, readMemory: false, writeMemory: false }
  });
  assert.equal(typeof turn.reply, "string");
  assert(turn.reply.trim().length > 0, "text turn must complete with a reply");
  console.log("PASS real text turn");
  const audioPath = process.env["YUVI_ACCEPT_STT_WAV"];
  assert(audioPath, "Set YUVI_ACCEPT_STT_WAV to an existing local speech WAV (never exported).");
  const transcription = await json(`${runtime}/v1/audio/transcriptions`, {
    sessionId: scope,
    audioBase64: fs.readFileSync(audioPath).toString("base64"),
    mimeType: "audio/wav"
  });
  assert.equal(typeof transcription.text, "string");
  assert(transcription.text.trim().length > 0);
  const speech = await fetch(`${tts}/tts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: scope,
      text: "今日はゆっくり話しましょう。",
      language: "JA"
    }),
    signal: AbortSignal.timeout(120_000)
  });
  assert(speech.ok, `TTS HTTP ${speech.status}`);
  assert(speech.headers.get("content-type")?.includes("audio/wav"));
  assert((await speech.arrayBuffer()).byteLength > 10000);
  assert((await fetch("http://127.0.0.1:5173/#/companion")).ok);
  const modelPath = env["VITE_LIVE2D_MODEL_URL"] || "/api/live2d/Lumi/Lumi.model3.json";
  assert(
    modelPath.startsWith("/api/live2d/"),
    "Acceptance requires the installed local Live2D route"
  );
  const model = await json(`http://127.0.0.1:5173${modelPath}`);
  assert.equal(model.Version, 3);
  const core = await fetch("http://127.0.0.1:5173/api/live2d-core/live2dcubismcore.min.js", {
    signal: AbortSignal.timeout(5000)
  });
  assert(core.ok, "Installed Cubism Core must be reachable");
  assert((await core.text()).includes("Live2DCubismCore"));
  console.log("PASS real STT and TTS; Companion shell, model and Cubism Core reachable");
  const profiles = (await json(`${runtime}/voice-profiles`)).profiles;
  const created = await json(`${mem0}/v1/memories`, {
    scope,
    content: "Campaign G restart persistence acceptance marker.",
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
  assert(
    JSON.stringify((await json(`${runtime}/voice-profiles`)).profiles) === JSON.stringify(profiles),
    "Speaker profiles changed across lifecycle"
  );
  console.log("PASS Product restart; Memory read/search and acoustic profile persistence");
  const ownedPids = await cgroupPids();
  await systemctl("stop", "yuvi-daily.service");
  await until(
    async () => ownedPids.every((p) => !fs.existsSync(`/proc/${p}`)),
    "owned process removal"
  );
  assert.equal((await cgroupPids()).length, 0);
  console.log(`PASS all ${ownedPids.length} YUVI cgroup processes removed`);
  assert(
    (await Promise.all([runtime, mem0, stt, tts, "http://127.0.0.1:5173"].map(closed))).every(
      Boolean
    ),
    "YUVI listeners must close"
  );
  await externalDatabase();
  assert(Array.isArray((await json(`${ollama}/api/tags`)).models));
  console.log(
    "PASS shutdown closes YUVI listeners; external PostgreSQL and Ollama remain reachable"
  );
  await systemctl("start", "yuvi-daily.service");
  await until(ready, "clean daily start");
  assert(
    JSON.stringify((await json(`${runtime}/voice-profiles`)).profiles) === JSON.stringify(profiles),
    "Speaker profiles changed across lifecycle"
  );
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
