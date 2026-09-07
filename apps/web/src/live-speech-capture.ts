const TARGET_SAMPLE_RATE = 16_000;
const PROCESSOR_BUFFER_SIZE = 4096;

export type LiveSpeechFrame = {
  sessionId: string;
  captureEpoch: string;
  pcmBase64: string;
  sampleRate: number;
};

export const LIVE_SPEECH_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};

export type MicrophoneTrackSettings = {
  echoCancellation: boolean | "unsupported";
  noiseSuppression: boolean | "unsupported";
  autoGainControl: boolean | "unsupported";
};

export type LiveSpeechCapture = {
  captureEpoch: string;
  trackSettings: MicrophoneTrackSettings;
  stop(): Promise<void>;
};

export type LiveSpeechCaptureOptions = {
  sessionId: string;
  postFrame(frame: LiveSpeechFrame, signal?: AbortSignal): Promise<unknown>;
  onError?: (error: Error) => void;
  onPcm?: (pcm: Int16Array, sampleRate: number) => void;
  createId?: () => string;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
};

type AudioContextConstructor = new () => AudioContext;

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  const globals = globalThis as typeof globalThis & {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return globals.AudioContext ?? globals.webkitAudioContext ?? null;
}

export async function startLiveSpeechCapture(
  options: LiveSpeechCaptureOptions
): Promise<LiveSpeechCapture> {
  const getUserMedia =
    options.getUserMedia ??
    globalThis.navigator?.mediaDevices?.getUserMedia?.bind(globalThis.navigator.mediaDevices);
  if (!getUserMedia) {
    throw new Error("此环境不支持麦克风实时采集。");
  }
  const AudioContextCtor = options.createAudioContext ? null : resolveAudioContextConstructor();
  if (!options.createAudioContext && !AudioContextCtor) {
    throw new Error("此环境不支持实时音频分析。");
  }

  const captureEpoch =
    options.createId?.() ?? globalThis.crypto?.randomUUID?.() ?? `epoch-${Date.now()}`;
  const stream = await getUserMedia({ audio: LIVE_SPEECH_AUDIO_CONSTRAINTS, video: false });
  const trackSettings = readMicrophoneTrackSettings(stream);
  const context = options.createAudioContext?.() ?? new AudioContextCtor!();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  const silentGain = context.createGain?.();
  if (silentGain) silentGain.gain.value = 0;
  const controller = new AbortController();
  let queuedSamples = 0;
  let stopped = false;
  let sending = Promise.resolve();

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = resampleToInt16(input, event.inputBuffer.sampleRate, TARGET_SAMPLE_RATE);
    if (pcm.length === 0) return;
    if (queuedSamples + pcm.length > TARGET_SAMPLE_RATE * 2) {
      // Never turn network lag into unbounded delayed speech/barge-in.
      stopped = true;
      controller.abort();
      for (const track of stream.getTracks()) track.stop();
      options.onError?.(new Error("Speech capture could not keep up. Restart Voice Mode."));
      return;
    }
    queuedSamples += pcm.length;
    options.onPcm?.(pcm, TARGET_SAMPLE_RATE);
    const frame: LiveSpeechFrame = {
      sessionId: options.sessionId,
      captureEpoch,
      pcmBase64: int16ToBase64(pcm),
      sampleRate: TARGET_SAMPLE_RATE
    };
    sending = sending
      .then(() => (stopped ? undefined : options.postFrame(frame, controller.signal)))
      .then(
        () => {
          queuedSamples -= pcm.length;
        },
        () => {
          queuedSamples -= pcm.length;
        }
      );
  };

  source.connect(processor);
  if (silentGain) {
    processor.connect(silentGain);
    silentGain.connect(context.destination);
  } else {
    processor.connect(context.destination);
  }

  return {
    captureEpoch,
    trackSettings,
    async stop() {
      stopped = true;
      controller.abort();
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
      } catch {
        // Processor may already be disconnected.
      }
      try {
        silentGain?.disconnect();
      } catch {
        // Gain may already be disconnected.
      }
      try {
        source.disconnect();
      } catch {
        // Source may already be disconnected.
      }
      for (const track of stream.getTracks()) track.stop();
      await sending;
      await context.close();
    }
  };
}

export function readMicrophoneTrackSettings(stream: MediaStream): MicrophoneTrackSettings {
  const track = stream.getAudioTracks?.()[0];
  const settings = track?.getSettings?.() ?? {};
  return {
    echoCancellation: booleanSetting(settings.echoCancellation),
    noiseSuppression: booleanSetting(settings.noiseSuppression),
    autoGainControl: booleanSetting(settings.autoGainControl)
  };
}

function booleanSetting(value: unknown): boolean | "unsupported" {
  return typeof value === "boolean" ? value : "unsupported";
}

function resampleToInt16(input: Float32Array, fromRate: number, toRate: number): Int16Array {
  if (input.length === 0) return new Int16Array();
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const source = index * ratio;
    const lower = Math.floor(source);
    const upper = Math.min(lower + 1, input.length - 1);
    const weight = source - lower;
    const sample = (input[lower] ?? 0) * (1 - weight) + (input[upper] ?? 0) * weight;
    const clipped = Math.max(-1, Math.min(1, sample));
    out[index] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
  }
  return out;
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
