#!/usr/bin/env node
/**
 * Real Linux microphone validation for Atom 09B-2.
 * Records a short Pulse/ALSA clip and posts PCM frames to Runtime.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const apiBase = process.env.YUVI_API_BASE?.trim() || "http://127.0.0.1:6121";
const sessionId = process.env.YUVI_SESSION_ID?.trim() || "live-speech-validation";
const captureEpoch = `epoch-validate-${Date.now()}`;
const dir = mkdtempSync(path.join(tmpdir(), "yuvi-live-speech-"));
const wavPath = path.join(dir, "clip.wav");

function record() {
  const arecord = spawnSync(
    "arecord",
    ["-d", "2", "-f", "S16_LE", "-r", "16000", "-c", "1", wavPath],
    { timeout: 5000, encoding: "utf8" }
  );
  if (arecord.status !== 0 && !readFileSyncSafe(wavPath)) {
    throw new Error(
      `microphone record failed: ${arecord.stderr || arecord.error || arecord.status}`
    );
  }
  return "arecord";
}

function readFileSyncSafe(filePath) {
  try {
    return readFileSync(filePath).byteLength > 44;
  } catch {
    return false;
  }
}

function pcmFromWav(bytes) {
  if (bytes.length < 44) throw new Error("recorded clip was empty");
  const dataIndex = bytes.indexOf(Buffer.from("data"));
  const start = dataIndex >= 0 ? dataIndex + 8 : 44;
  return bytes.subarray(start);
}

async function main() {
  const producer = record();
  const pcm = pcmFromWav(readFileSync(wavPath));
  const chunkSize = 512 * 2;
  let last = null;
  for (let offset = 0; offset + chunkSize <= pcm.length; offset += chunkSize) {
    const response = await fetch(`${apiBase}/v1/speech-activity/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        captureEpoch,
        pcmBase64: pcm.subarray(offset, offset + chunkSize).toString("base64"),
        sampleRate: 16000
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`speech-activity/frames failed ${response.status}: ${JSON.stringify(body)}`);
    }
    last = body;
  }
  const inactiveResponse = await fetch(`${apiBase}/v1/speech-activity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, captureEpoch, active: false })
  });
  const inactive = await inactiveResponse.json();
  if (!inactiveResponse.ok) {
    throw new Error(
      `speech-activity inactive failed ${inactiveResponse.status}: ${JSON.stringify(inactive)}`
    );
  }
  const snapshot = await fetch(
    `${apiBase}/v1/speech-activity?sessionId=${encodeURIComponent(sessionId)}`
  ).then((response) => response.json());
  console.log(
    JSON.stringify({ producer, captureEpoch, last, inactive, snapshot, bytes: pcm.length }, null, 2)
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
