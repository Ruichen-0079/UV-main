/** Opt-in real Local STT + capture endpoint gate, with an isolated acoustic store. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHandsFreeUtteranceBuffer } from "../apps/web/src/hands-free-utterance.ts";
import { encodePcm16Wav } from "../apps/web/src/pcm-wav.ts";
import { LocalSTTProvider } from "../packages/providers/src/local/LocalSTTProvider.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelDir = process.env.YUVI_STT_MODEL_DIR;
const python = process.env.YUVI_STT_PYTHON;
assert(modelDir && python, "Supply existing YUVI_STT_MODEL_DIR and YUVI_STT_PYTHON.");
const stt = new LocalSTTProvider({
  baseUrl: "http://127.0.0.1:19876",
  model: "sensevoice",
  timeoutMs: 20_000
});
const wav = fs.readFileSync(
  path.join(modelDir, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/test_wavs/zh.wav")
);
let data: Buffer | undefined;
for (let offset = 12; offset + 8 <= wav.length; ) {
  const size = wav.readUInt32LE(offset + 4);
  if (wav.toString("ascii", offset, offset + 4) === "data") {
    data = wav.subarray(offset + 8, offset + 8 + size);
    break;
  }
  offset += 8 + size + (size % 2);
}
assert(data);
const fixture = Int16Array.from({ length: data.length / 2 }, (_, i) => data!.readInt16LE(i * 2));
const join = (...chunks: Int16Array[]) => {
  const result = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-voice-capture-"));
const child = spawn(
  python,
  [path.join(root, "services/local-stt/server.py"), "--model-dir", modelDir, "--port", "19876"],
  {
    env: { ...process.env, YUVI_STT_SPEAKER_DIR: temporary },
    stdio: "ignore"
  }
);
try {
  for (let i = 0; i < 100; i++) {
    if ((await stt.healthCheck()).available) break;
    assert(child.exitCode === null, "STT exited before readiness");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert((await stt.healthCheck()).available);
  for (const thinking of [false, true]) {
    const speech = thinking
      ? join(fixture.slice(0, 40000), new Int16Array(6400), fixture.slice(40000))
      : fixture;
    const timeline = join(...Array.from({ length: 3 }, () => join(speech, new Int16Array(64000))));
    const epoch = crypto.randomUUID();
    const buffer = createHandsFreeUtteranceBuffer(epoch);
    let previews = new Set<number>();
    let commits = 0;
    let speechStarts = 0;
    let wasActive = false;
    for (let offset = 0; offset < timeline.length; offset += 1600) {
      const pcm = timeline.slice(offset, offset + 1600);
      const vad = await stt.detectVoiceActivity({
        captureEpoch: epoch,
        pcmBase64: Buffer.from(pcm.buffer).toString("base64"),
        sampleRate: 16000
      });
      if (vad.active && !wasActive) speechStarts++;
      wasActive = vad.active;
      const turn = buffer.observeVad(vad.active) ?? buffer.push(pcm);
      const preview = buffer.preview();
      if (preview && !previews.has(preview.revision)) {
        previews.add(preview.revision);
        const output = await stt.transcribeAudio({
          audioBase64: Buffer.from(await encodePcm16Wav(preview.pcm).arrayBuffer()).toString(
            "base64"
          ),
          mimeType: "audio/wav",
          metadata: { identify: false, diarize: false }
        });
        buffer.observeTranscript(output.text, preview.revision);
      }
      if (turn) {
        const output = await stt.transcribeAudio({
          audioBase64: Buffer.from(await encodePcm16Wav(turn.pcm).arrayBuffer()).toString("base64"),
          mimeType: "audio/wav"
        });
        assert(output.text.trim());
        assert(output.segments?.length);
        commits++;
      }
    }
    assert.equal(commits, 3, "Each repeated sentence must commit once, including a thinking pause");
    assert(speechStarts >= 3);
    console.log(
      `${thinking ? "400ms thinking pause" : "normal speech"}: ${commits} real-STT committed turns, ${speechStarts} acoustic onsets; PASS`
    );
  }
} finally {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  fs.rmSync(temporary, { recursive: true, force: true });
}
