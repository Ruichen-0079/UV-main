const PREFERRED_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg"
] as const;

export type ActiveAudioCapture = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
};

export type RecordedAudio = {
  audioBase64: string;
  mimeType: string;
  durationMs: number;
};

type AudioContextConstructor = new () => AudioContext;

type MediaRecorderConstructor = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported?: (mimeType: string) => boolean;
};

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  const globals = globalThis as typeof globalThis & {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return globals.AudioContext ?? globals.webkitAudioContext ?? null;
}

function resolveMediaRecorderConstructor(): MediaRecorderConstructor | null {
  const candidate = (
    globalThis as typeof globalThis & {
      MediaRecorder?: MediaRecorderConstructor;
    }
  ).MediaRecorder;
  return typeof candidate === "function" ? candidate : null;
}

export function resolveAudioRecordingMimeType(
  recorderConstructor: MediaRecorderConstructor | null = resolveMediaRecorderConstructor()
): string {
  if (!recorderConstructor) return "";
  for (const mimeType of PREFERRED_AUDIO_MIME_TYPES) {
    if (recorderConstructor.isTypeSupported?.(mimeType) ?? false) return mimeType;
  }
  return "";
}

export async function startMicrophoneCapture(): Promise<ActiveAudioCapture> {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
    throw new Error("此环境不支持麦克风录音。");
  }
  const recorderConstructor = resolveMediaRecorderConstructor();
  if (!recorderConstructor) {
    throw new Error("此环境不支持浏览器录音。");
  }

  const stream = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = resolveAudioRecordingMimeType(recorderConstructor);
  const chunks: Blob[] = [];
  try {
    const recorder = mimeType
      ? new recorderConstructor(stream, { mimeType })
      : new recorderConstructor(stream);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.start();
    return {
      recorder,
      stream,
      chunks,
      mimeType: recorder.mimeType || mimeType || "audio/webm",
      startedAt: performance.now()
    };
  } catch (error) {
    stopMediaStream(stream);
    throw error;
  }
}

export async function stopMicrophoneCapture(capture: ActiveAudioCapture): Promise<RecordedAudio> {
  try {
    await stopRecorder(capture.recorder);
    const blob = new Blob(capture.chunks, { type: capture.mimeType });
    if (blob.size === 0) throw new Error("没有捕获到音频，请重试。");
    const wav = await normalizeRecordingToWav(blob);
    return {
      audioBase64: await blobToBase64(wav),
      mimeType: "audio/wav",
      durationMs: Math.max(0, Math.round(performance.now() - capture.startedAt))
    };
  } finally {
    stopMediaStream(capture.stream);
  }
}

export function releaseMicrophoneCapture(capture: ActiveAudioCapture | null): void {
  if (!capture) return;
  if (capture.recorder.state !== "inactive") {
    try {
      capture.recorder.stop();
    } catch {
      // Cleanup must still release the microphone when the recorder is already
      // closing or the browser has revoked the capture session.
    }
  }
  stopMediaStream(capture.stream);
}

function stopRecorder(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === "inactive") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onStop = (): void => resolve();
    const onError = (): void => reject(new Error("录音失败，请重试。"));
    recorder.addEventListener("stop", onStop, { once: true });
    recorder.addEventListener("error", onError, { once: true });
    try {
      recorder.stop();
    } catch (error) {
      reject(error);
    }
  });
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function normalizeRecordingToWav(blob: Blob): Promise<Blob> {
  const bytes = await blob.arrayBuffer();
  if (isWav(bytes)) return new Blob([bytes], { type: "audio/wav" });

  const AudioContextCtor = resolveAudioContextConstructor();
  if (!AudioContextCtor) {
    throw new Error("此环境无法将录音转换为 WAV 音频。");
  }
  const context = new AudioContextCtor();
  try {
    const decoded = await context.decodeAudioData(bytes.slice(0));
    return encodeWav(decoded, 16_000);
  } finally {
    await context.close();
  }
}

function isWav(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  return (
    view.length >= 12 &&
    view[0] === 0x52 &&
    view[1] === 0x49 &&
    view[2] === 0x46 &&
    view[3] === 0x46 &&
    view[8] === 0x57 &&
    view[9] === 0x41 &&
    view[10] === 0x56 &&
    view[11] === 0x45
  );
}

function encodeWav(audio: AudioBuffer, targetRate: number): Blob {
  const samples = mixAndResample(audio, targetRate);
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

function mixAndResample(audio: AudioBuffer, targetRate: number): Float32Array {
  const mixed = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    const data = audio.getChannelData(channel);
    for (let index = 0; index < mixed.length; index += 1) {
      mixed[index] = (mixed[index] ?? 0) + (data[index] ?? 0) / audio.numberOfChannels;
    }
  }
  if (audio.sampleRate === targetRate) return mixed;

  const length = Math.max(1, Math.round((mixed.length * targetRate) / audio.sampleRate));
  const resampled = new Float32Array(length);
  const ratio = audio.sampleRate / targetRate;
  for (let index = 0; index < length; index += 1) {
    const source = index * ratio;
    const lower = Math.floor(source);
    const upper = Math.min(lower + 1, mixed.length - 1);
    const weight = source - lower;
    resampled[index] = (mixed[lower] ?? 0) * (1 - weight) + (mixed[upper] ?? 0) * weight;
  }
  return resampled;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
