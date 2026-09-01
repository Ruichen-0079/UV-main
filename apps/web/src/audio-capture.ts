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

type MediaRecorderConstructor = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported?: (mimeType: string) => boolean;
};

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
    return {
      audioBase64: await blobToBase64(blob),
      mimeType: capture.mimeType,
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
