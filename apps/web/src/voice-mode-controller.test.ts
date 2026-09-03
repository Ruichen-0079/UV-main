import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoiceModeController,
  type VoiceModeControllerDeps,
  type VoiceRecordedAudio,
  type VoiceSentence
} from "./voice-mode-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (rounds = 5): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
};

type Harness = {
  controller: VoiceModeController;
  captureGates: ReturnType<typeof deferred<unknown>>[];
  sttGates: { gate: ReturnType<typeof deferred<{ text: string }>>; signal: AbortSignal }[];
  runtimeTexts: { utteranceId: string; text: string }[];
  sentences: VoiceSentence[];
  finished: string[];
  cancelled: string[];
  runtimeInterrupts: number;
  released: unknown[];
  states: string[];
};

function createHarness(
  overrides: Partial<VoiceModeControllerDeps> = {},
  options: { maxRecordingMs?: number } = {}
): Harness {
  let utteranceSequence = 0;
  const harness: Harness = {
    controller: undefined as unknown as VoiceModeController,
    captureGates: [],
    sttGates: [],
    runtimeTexts: [],
    sentences: [],
    finished: [],
    cancelled: [],
    runtimeInterrupts: 0,
    released: [],
    states: []
  };
  const deps: VoiceModeControllerDeps = {
    startCapture: () => {
      const gate = deferred<unknown>();
      harness.captureGates.push(gate);
      return gate.promise;
    },
    stopCapture: async (handle: unknown) => {
      void handle;
      return {
        audioBase64: "cmVjb3JkaW5n",
        mimeType: "audio/wav",
        durationMs: 1200
      } satisfies VoiceRecordedAudio;
    },
    releaseCapture: (handle: unknown) => {
      harness.released.push(handle);
    },
    transcribe: (audio: VoiceRecordedAudio, transcribeOptions: { signal: AbortSignal }) => {
      void audio;
      const gate = deferred<{ text: string }>();
      harness.sttGates.push({ gate, signal: transcribeOptions.signal });
      return gate.promise;
    },
    sendRuntimeText: (utteranceId: string, text: string) => {
      harness.runtimeTexts.push({ utteranceId, text });
    },
    speakSentence: (sentence: VoiceSentence) => {
      harness.sentences.push(sentence);
    },
    finishSpeech: (utteranceId: string) => {
      harness.finished.push(utteranceId);
    },
    cancelSpeech: (utteranceId: string) => {
      harness.cancelled.push(utteranceId);
    },
    interruptRuntimeTurn: () => {
      harness.runtimeInterrupts += 1;
    },
    ...overrides
  };
  harness.controller = new VoiceModeController(deps, {
    ...(options.maxRecordingMs === undefined ? {} : { maxRecordingMs: options.maxRecordingMs }),
    createUtteranceId: () => {
      utteranceSequence += 1;
      return `u-${utteranceSequence}`;
    }
  });
  harness.controller.subscribe((state) => harness.states.push(state.status));
  return harness;
}

/** Drives one utterance through capture + STT to the thinking state. */
async function startThinking(
  harness: Harness,
  transcript: string,
  utteranceIndex = 0
): Promise<string> {
  const { controller } = harness;
  controller.start();
  await flush();
  const utteranceId = `u-${utteranceIndex + 1}`;
  harness.captureGates[utteranceIndex]?.resolve({ id: `mic-${utteranceId}` });
  await flush();
  controller.stopRecording();
  await flush();
  harness.sttGates[utteranceIndex]?.gate.resolve({ text: transcript });
  await flush();
  return utteranceId;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("voice mode happy path", () => {
  it("records, transcribes, runs the normal runtime path, and speaks sentences in order", async () => {
    const harness = createHarness();
    const utteranceId = await startThinking(harness, "  hello voice world  ");

    // The transcript enters the normal Runtime path exactly once, trimmed.
    expect(harness.runtimeTexts).toEqual([{ utteranceId, text: "hello voice world" }]);
    expect(harness.controller.getState().status).toBe("thinking");

    harness.controller.notifyTextDelta(
      utteranceId,
      "Hello voice world, this is the first sentence. And here is the second sentence for order."
    );
    await flush();
    expect(harness.controller.getState().status).toBe("speaking");
    expect(harness.sentences.map((sentence) => sentence.sequence)).toEqual([0, 1]);
    expect(harness.sentences[0]).toMatchObject({ utteranceId });
    expect(harness.sentences[0]?.text).toContain("first sentence");
    expect(harness.sentences[1]?.text).toContain("second sentence");

    harness.controller.notifyTextDelta(utteranceId, " Finally the tail sentence arrives here.");
    harness.controller.notifyRuntimeCompleted(utteranceId);
    await flush();

    const ordered = harness.sentences.map((sentence) => sentence.text);
    expect(ordered).toHaveLength(3);
    expect(harness.sentences.map((sentence) => sentence.sequence)).toEqual(
      ordered.map((_, index) => index)
    );
    expect(harness.finished).toEqual([utteranceId]);

    harness.controller.notifyPlaybackEnded(utteranceId);
    expect(harness.controller.getState()).toEqual({ status: "idle", utteranceId: null, error: null });
  });

  it("returns to idle without speech when the reply has no speakable sentence", async () => {
    const harness = createHarness();
    const utteranceId = await startThinking(harness, "hello");
    harness.controller.notifyTextDelta(utteranceId, "   ");
    harness.controller.notifyRuntimeCompleted(utteranceId);
    await flush();
    expect(harness.sentences).toEqual([]);
    expect(harness.finished).toEqual([]);
    expect(harness.controller.getState().status).toBe("idle");
  });

  it("emits nothing when TTS was not requested for the turn", async () => {
    const harness = createHarness();
    harness.controller.start({ ttsRequested: false });
    await flush();
    harness.captureGates[0]?.resolve({ id: "mic" });
    await flush();
    harness.controller.stopRecording();
    await flush();
    harness.sttGates[0]?.gate.resolve({ text: "hello" });
    await flush();
    const utteranceId = harness.controller.getState().utteranceId ?? "missing";
    harness.controller.notifyTextDelta(utteranceId, "Hello world, this sentence stays silent.");
    harness.controller.notifyRuntimeCompleted(utteranceId);
    await flush();
    expect(harness.sentences).toEqual([]);
    expect(harness.finished).toEqual([]);
    expect(harness.controller.getState().status).toBe("idle");
  });
});

describe("voice mode recording races", () => {
  it("treats repeated start as a no-op and rapid start/stop settles exactly once", async () => {
    const stopCalls: unknown[] = [];
    const harness = createHarness({
      stopCapture: async (handle: unknown) => {
        stopCalls.push(handle);
        return { audioBase64: "eA==", mimeType: "audio/wav", durationMs: 500 };
      }
    });
    harness.controller.start();
    harness.controller.start();
    harness.controller.start();
    expect(harness.captureGates).toHaveLength(1);

    // Stop before MediaRecorder fully started: settle on handle arrival.
    harness.controller.stopRecording();
    harness.captureGates[0]?.resolve({ id: "mic-1" });
    await flush(10);

    expect(stopCalls).toHaveLength(1);
    expect(harness.sttGates).toHaveLength(1);
    expect(harness.controller.getState().status).toBe("transcribing");
  });

  it("releases the microphone when the capture is superseded while permission is pending", async () => {
    const harness = createHarness();
    harness.controller.start();
    await flush();
    harness.controller.dispose();
    harness.captureGates[0]?.resolve({ id: "mic-orphan" });
    await flush();
    expect(harness.released).toEqual([{ id: "mic-orphan" }]);
    expect(harness.runtimeTexts).toEqual([]);
  });

  it("surfaces mic permission failure and recovers on the next start", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const harness = createHarness({
      startCapture: async () => {
        throw denied;
      }
    });
    harness.controller.start();
    await flush();
    const failed = harness.controller.getState();
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("麦克风权限");

    harness.controller.dismiss();
    expect(harness.controller.getState().status).toBe("idle");
  });

  it("surfaces a missing microphone device with a recoverable error", async () => {
    const missing = Object.assign(new Error("no device"), { name: "NotFoundError" });
    const harness = createHarness({
      startCapture: async () => {
        throw missing;
      }
    });
    harness.controller.start();
    await flush();
    expect(harness.controller.getState().status).toBe("error");
    expect(harness.controller.getState().error).toContain("麦克风设备");
  });

  it("treats empty audio as a recoverable error instead of entering runtime", async () => {
    const harness = createHarness({
      stopCapture: async () => ({ audioBase64: "", mimeType: "audio/wav", durationMs: 0 })
    });
    harness.controller.start();
    await flush();
    harness.captureGates[0]?.resolve({ id: "mic" });
    await flush();
    harness.controller.stopRecording();
    await flush(10);
    expect(harness.controller.getState().status).toBe("error");
    expect(harness.runtimeTexts).toEqual([]);
  });

  it("auto-stops a bounded utterance instead of recording forever", async () => {
    vi.useFakeTimers();
    const harness = createHarness({}, { maxRecordingMs: 1000 });
    harness.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    harness.captureGates[0]?.resolve({ id: "mic" });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.controller.getState().status).toBe("recording");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.controller.getState().status).toBe("transcribing");
  });
});

describe("voice mode STT races", () => {
  it("ignores a stale transcript and never sends it to runtime", async () => {
    const harness = createHarness();
    harness.controller.start();
    await flush();
    harness.captureGates[0]?.resolve({ id: "mic-1" });
    await flush();
    harness.controller.stopRecording();
    await flush();
    expect(harness.controller.getState().status).toBe("transcribing");

    // User aborts the STT and starts a fresh utterance before A settles.
    harness.controller.stop();
    expect(harness.controller.getState().status).toBe("interrupted");
    expect(harness.sttGates[0]?.signal.aborted).toBe(true);

    harness.controller.start();
    await flush();
    expect(harness.controller.getState()).toMatchObject({ status: "recording", utteranceId: "u-2" });

    // The late transcript for u-1 arrives anyway: it must not enter runtime.
    harness.sttGates[0]?.gate.resolve({ text: "stale transcript" });
    await flush(10);
    expect(harness.runtimeTexts).toEqual([]);

    harness.captureGates[1]?.resolve({ id: "mic-2" });
    await flush();
    harness.controller.stopRecording();
    await flush();
    harness.sttGates[1]?.gate.resolve({ text: "fresh transcript" });
    await flush();
    expect(harness.runtimeTexts).toEqual([{ utteranceId: "u-2", text: "fresh transcript" }]);
  });

  it("never triggers a message from an aborted STT", async () => {
    const harness = createHarness({
      transcribe: (_audio, { signal }) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        })
    });
    harness.controller.start();
    await flush();
    harness.captureGates[0]?.resolve({ id: "mic" });
    await flush();
    harness.controller.stopRecording();
    await flush();
    harness.controller.stop();
    await flush(10);
    expect(harness.controller.getState().status).toBe("interrupted");
    expect(harness.runtimeTexts).toEqual([]);
  });

  it("treats an empty transcript as a recoverable error", async () => {
    const harness = createHarness();
    await startThinking(harness, "   ");
    expect(harness.controller.getState().status).toBe("error");
    expect(harness.runtimeTexts).toEqual([]);
  });

  it("recovers to idle after an STT error", async () => {
    const harness = createHarness();
    harness.controller.start();
    await flush();
    harness.captureGates[0]?.resolve({ id: "mic" });
    await flush();
    harness.controller.stopRecording();
    await flush();
    harness.sttGates[0]?.gate.reject(new Error("stt down"));
    await flush();
    expect(harness.controller.getState().status).toBe("error");
    harness.controller.dismiss();
    expect(harness.controller.getState().status).toBe("idle");
  });
});

describe("voice mode runtime races", () => {
  it("lets a second utterance invalidate the first: old deltas never speak", async () => {
    const harness = createHarness();
    const first = await startThinking(harness, "first question");
    harness.controller.notifyTextDelta(first, "First answer sentence one, still streaming along.");
    await flush();
    expect(harness.controller.getState().status).toBe("speaking");
    expect(harness.sentences).toHaveLength(1);

    harness.controller.start();
    await flush();
    // Barge-in interrupts the old turn: runtime aborted, old TTS cancelled.
    expect(harness.runtimeInterrupts).toBe(1);
    expect(harness.cancelled).toEqual([first]);
    expect(harness.controller.getState()).toMatchObject({ status: "recording", utteranceId: "u-2" });

    // Every late callback for the old utterance is dropped.
    harness.controller.notifyTextDelta(first, "Late stale sentence that must never be spoken aloud.");
    harness.controller.notifyRuntimeCompleted(first);
    harness.controller.notifyPlaybackEnded(first);
    await flush();
    expect(harness.sentences).toHaveLength(1);
    expect(harness.finished).toEqual([]);

    harness.captureGates[1]?.resolve({ id: "mic-2" });
    await flush();
    harness.controller.stopRecording();
    await flush();
    harness.sttGates[1]?.gate.resolve({ text: "second question" });
    await flush();
    expect(harness.runtimeTexts.map((entry) => entry.text)).toEqual([
      "first question",
      "second question"
    ]);
  });

  it("interrupts speaking on user stop and clears the queued old sentences", async () => {
    const harness = createHarness();
    const utteranceId = await startThinking(harness, "tell me a story");
    harness.controller.notifyTextDelta(
      utteranceId,
      "Once upon a time there was a very long story streaming out slowly."
    );
    await flush();
    expect(harness.controller.getState().status).toBe("speaking");

    harness.controller.stop();
    expect(harness.controller.getState().status).toBe("interrupted");
    expect(harness.runtimeInterrupts).toBe(1);
    expect(harness.cancelled).toEqual([utteranceId]);

    const spoken = harness.sentences.length;
    harness.controller.notifyTextDelta(utteranceId, "More stale story text arriving after interrupt.");
    harness.controller.notifyRuntimeCompleted(utteranceId);
    await flush();
    expect(harness.sentences).toHaveLength(spoken);
    expect(harness.finished).toEqual([]);
  });

  it("drops stale assistant chunks after the turn is cancelled", async () => {
    const harness = createHarness();
    const utteranceId = await startThinking(harness, "hello");
    harness.controller.notifyRuntimeAborted(utteranceId);
    expect(harness.controller.getState().status).toBe("interrupted");
    harness.controller.notifyTextDelta(utteranceId, "Late chunk after cancel, long enough to segment.");
    harness.controller.notifyRuntimeCompleted(utteranceId);
    await flush();
    expect(harness.sentences).toEqual([]);
    expect(harness.finished).toEqual([]);
  });

  it("keeps sentence order stable across chunk boundaries", async () => {
    const harness = createHarness();
    const utteranceId = await startThinking(harness, "summarize this");
    harness.controller.notifyTextDelta(utteranceId, "The first important point is quite clear. ");
    harness.controller.notifyTextDelta(utteranceId, "The second important point follows right after. ");
    harness.controller.notifyTextDelta(utteranceId, "The third important point concludes the summary.");
    harness.controller.notifyRuntimeCompleted(utteranceId);
    await flush();
    expect(harness.sentences).toHaveLength(3);
    expect(harness.sentences.map((sentence) => sentence.sequence)).toEqual([0, 1, 2]);
    expect(harness.sentences[0]?.text).toContain("first");
    expect(harness.sentences[1]?.text).toContain("second");
    expect(harness.sentences[2]?.text).toContain("third");
  });

  it("emits each sentence exactly once: no double synthesis", async () => {
    const harness = createHarness();
    const utteranceId = await startThinking(harness, "say it twice?");
    harness.controller.notifyTextDelta(
      utteranceId,
      "Only the first sentence is ready here. Only the second sentence is ready here."
    );
    harness.controller.notifyRuntimeCompleted(utteranceId);
    await flush();
    const texts = harness.sentences.map((sentence) => sentence.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(harness.finished.filter((id) => id === utteranceId)).toHaveLength(1);
  });

  it("surfaces a runtime failure as a recoverable error", async () => {
    const harness = createHarness();
    const utteranceId = await startThinking(harness, "hello");
    harness.controller.notifyRuntimeFailed(utteranceId, "runtime exploded");
    expect(harness.controller.getState()).toMatchObject({ status: "error" });
    harness.controller.start();
    await flush();
    expect(harness.controller.getState().status).toBe("recording");
  });
});

describe("voice mode playback and lifecycle", () => {
  it("ignores stale playback signals from a superseded turn", async () => {
    const harness = createHarness();
    const first = await startThinking(harness, "first");
    harness.controller.start();
    await flush();
    harness.controller.notifyPlaybackEnded(first);
    harness.controller.notifyPlaybackFailed(first, "late boom");
    expect(harness.controller.getState().utteranceId).toBe("u-2");
  });

  it("never locks on playback failure: error recovers to a fresh utterance", async () => {
    const harness = createHarness();
    const utteranceId = await startThinking(harness, "speak please");
    harness.controller.notifyTextDelta(
      utteranceId,
      "This sentence will start playing and then the audio will fail badly."
    );
    await flush();
    harness.controller.notifyPlaybackFailed(utteranceId, "audio element exploded");
    const failed = harness.controller.getState();
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("audio");
    harness.controller.start();
    await flush();
    expect(harness.controller.getState().status).toBe("recording");
  });

  it("cleans up capture, STT, timers, and late callbacks on dispose", async () => {
    vi.useFakeTimers();
    const harness = createHarness({}, { maxRecordingMs: 1000 });
    const states: string[] = [];
    harness.controller.subscribe((state) => states.push(state.status));
    harness.controller.start();
    await vi.advanceTimersByTimeAsync(0);
    harness.captureGates[0]?.resolve({ id: "mic" });
    await vi.advanceTimersByTimeAsync(0);
    harness.controller.dispose();
    // Late capture/STT settlements and timer firings become no-ops.
    await vi.advanceTimersByTimeAsync(5000);
    harness.sttGates[0]?.gate.resolve({ text: "too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.released).toEqual([{ id: "mic" }]);
    expect(harness.runtimeTexts).toEqual([]);
    expect(harness.controller.getState().status).toBe("recording");
    expect(states).not.toContain("transcribing");
  });

  it("aborts in-flight STT on dispose", async () => {
    const harness = createHarness();
    harness.controller.start();
    await flush();
    harness.captureGates[0]?.resolve({ id: "mic" });
    await flush();
    harness.controller.stopRecording();
    await flush();
    expect(harness.sttGates[0]?.signal.aborted).toBe(false);
    harness.controller.dispose();
    expect(harness.sttGates[0]?.signal.aborted).toBe(true);
  });
});
