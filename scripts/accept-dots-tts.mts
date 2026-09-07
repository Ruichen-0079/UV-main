/** Opt-in real-model gate. Private assets supplied only through the external environment. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DesktopSupervisor,
  loadSupervisorConfig
} from "../packages/desktop-supervisor/src/index.ts";
import { createProviderRegistryFromEnv } from "../packages/providers/src/registry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.DOTS_TTS_PYTHON;
assert(python, "Set DOTS_TTS_PYTHON to the externally provisioned interpreter.");
for (const key of ["DOTS_TTS_MODEL_DIR", "DOTS_TTS_REFERENCE_AUDIO", "DOTS_TTS_REFERENCE_TEXT"])
  assert(process.env[key], `Set ${key}.`);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-dots-accept-"));
const port = process.env.DOTS_TTS_PORT ?? "19881";
const baseUrl = `http://127.0.0.1:${port}`;
const config = loadSupervisorConfig({
  repositoryRoot: root,
  stateDirectory: path.join(directory, "state")
});
config.autostartRuntime = config.autostartMem0 = config.autostartLocalStt = false;
config.autostartTts = true;
config.ttsWrapperUrl = baseUrl;
config.ttsUpstreamStart = null;
config.ttsWrapperStart = {
  file: python,
  args: [path.join(root, "services/dots-tts/server.py")],
  cwd: root,
  env: { DOTS_TTS_PORT: port },
  commandMarker: "services/dots-tts/server.py"
};
const supervisor = new DesktopSupervisor(config);
const snapshot = () =>
  supervisor.snapshot().services.find((service) => service.id === "tts_wrapper")!;
const registry = createProviderRegistryFromEnv({
  DEFAULT_TTS_PROVIDER: "local",
  TTS_PROVIDER_CHAIN: "local",
  LOCAL_TTS_MODEL: "dots-studio/dots.tts-soar",
  LOCAL_TTS_BASE_URL: baseUrl,
  PROVIDER_ALLOW_MOCKS: "false"
});
const provider = registry.getTTSProvider();
try {
  await Promise.all([
    supervisor.ensureService("tts_wrapper"),
    supervisor.ensureService("tts_wrapper")
  ]);
  assert.equal(snapshot().status, "healthy");
  assert.equal(snapshot().ownership, "owned");
  const firstPid = snapshot().pid;
  assert(firstPid);
  await supervisor.ensureService("tts_wrapper");
  assert.equal(snapshot().pid, firstPid, "ensure must not load another model");
  console.log("owned readiness and duplicate ensure: PASS");
  for (const [language, text] of [
    ["ja", "今日は早めに帰って、夕食の準備をします。"],
    ["en", "I will make some tea while you get ready for bed."],
    ["zh", "今天我们可以慢慢聊，不用着急。"]
  ]) {
    const output = await provider.synthesizeSpeech({
      text: text!,
      format: "wav",
      metadata: { language }
    });
    assert.equal(output.mimeType, "audio/wav");
    assert(output.audio.length > 10000);
    fs.writeFileSync(path.join(directory, `${language}.wav`), output.audio);
    console.log(`${language} real provider synthesis: PASS (${output.audio.length} bytes)`);
  }
  const controller = new AbortController();
  const cancelled = provider.synthesizeSpeech(
    { text: "This response should never play.", metadata: { language: "en" } },
    { signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(
    cancelled,
    (error: unknown) => (error as { code?: string }).code === "CANCELLED"
  );
  const next = await provider.synthesizeSpeech({
    text: "次の会話です。",
    metadata: { language: "ja" }
  });
  assert(next.audio.length > 10000);
  console.log("active cancellation then replacement synthesis: PASS");
  await supervisor.restartService("tts_wrapper");
  assert.equal(snapshot().status, "healthy");
  assert.notEqual(snapshot().pid, firstPid);
  assert.throws(() => process.kill(firstPid, 0));
  const restartedPid = snapshot().pid!;
  const pending = provider.synthesizeSpeech({
    text: "Shutdown must stop this synthesis.",
    metadata: { language: "en" }
  });
  const observed = pending.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await supervisor.shutdown();
  await observed;
  assert.throws(() => process.kill(restartedPid, 0));
  console.log("restart and shutdown during synthesis: PASS");
  const warming = new DesktopSupervisor({
    ...config,
    stateDirectory: path.join(directory, "warm-state"),
    instanceId: crypto.randomUUID()
  });
  try {
    const starting = warming.ensureService("tts_wrapper");
    let warmPid: number | null = null;
    for (let i = 0; i < 100; i++) {
      warmPid =
        warming.snapshot().services.find((service) => service.id === "tts_wrapper")?.pid ?? null;
      if (warmPid) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(warmPid);
    await warming.shutdown();
    await starting;
    assert.throws(() => process.kill(warmPid!, 0));
    console.log("shutdown during model warmup: PASS");
  } finally {
    await warming.shutdown();
  }
  console.log(`Temporary acceptance artifacts: ${directory}`);
} finally {
  await supervisor.shutdown();
}
