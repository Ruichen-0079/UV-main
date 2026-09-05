import { describe, expect, it } from "vitest";
import {
  SpeechCaptureFenceError,
  admitFinalizedSpeechCapture,
  createSpeechCaptureStore
} from "./runtime-speech-capture.js";

const observation = (input: {
  text?: string;
  observationId?: string;
  captureEpoch?: string;
  segments?: Array<{ segmentId?: string; text?: string; speakerClusterId?: string }>;
}) => ({
  text: input.text ?? "hello",
  language: "en",
  confidence: 1,
  ...(input.observationId ? { observationId: input.observationId } : {}),
  ...(input.captureEpoch ? { captureEpoch: input.captureEpoch } : {}),
  ...(input.segments ? { segments: input.segments } : {})
});

describe("finalized speech capture fence", () => {
  it("suppresses the same epoch and segment as a duplicate", () => {
    const store = createSpeechCaptureStore();
    const first = admitFinalizedSpeechCapture(store, {
      observation: observation({
        observationId: "obs-1",
        segments: [{ segmentId: "seg-1", text: "hello" }]
      }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    expect(first.status).toBe("accepted");
    const second = admitFinalizedSpeechCapture(store, {
      observation: observation({
        observationId: "obs-1",
        segments: [{ segmentId: "seg-1", text: "hello" }]
      }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    expect(second.status).toBe("duplicate");
  });

  it("accepts the same text under different segment ids", () => {
    const store = createSpeechCaptureStore();
    const first = admitFinalizedSpeechCapture(store, {
      observation: observation({
        segments: [{ segmentId: "seg-a", text: "hello" }]
      }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    const second = admitFinalizedSpeechCapture(store, {
      observation: observation({
        segments: [{ segmentId: "seg-b", text: "hello" }]
      }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
  });

  it("treats the same segment id in different epochs as distinct", () => {
    const store = createSpeechCaptureStore();
    const first = admitFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-1", text: "hello" }] }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    const second = admitFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-1", text: "hello" }] }),
      sessionId: "s",
      captureEpoch: "epoch-2"
    });
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(first.captureEpoch).toBe("epoch-1");
    expect(second.captureEpoch).toBe("epoch-2");
  });

  it("rejects a late final from an obsolete epoch", () => {
    const store = createSpeechCaptureStore();
    admitFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-1" }] }),
      sessionId: "s",
      captureEpoch: "epoch-old"
    });
    admitFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-2" }] }),
      sessionId: "s",
      captureEpoch: "epoch-new"
    });
    expect(() =>
      admitFinalizedSpeechCapture(store, {
        observation: observation({ segments: [{ segmentId: "seg-late" }] }),
        sessionId: "s",
        captureEpoch: "epoch-old"
      })
    ).toThrow(SpeechCaptureFenceError);
    try {
      admitFinalizedSpeechCapture(store, {
        observation: observation({ segments: [{ segmentId: "seg-late" }] }),
        sessionId: "s",
        captureEpoch: "epoch-old"
      });
    } catch (error) {
      expect(error).toMatchObject({ name: "SpeechCaptureFenceError", reason: "stale-epoch" });
    }
  });

  it("does not derive captureEpoch from transcript or speakerClusterId", () => {
    const store = createSpeechCaptureStore();
    const result = admitFinalizedSpeechCapture(store, {
      observation: observation({
        text: "hello-world",
        segments: [{ segmentId: "seg-1", text: "hello-world", speakerClusterId: "spk_02" }]
      }),
      createId: () => "generated-epoch"
    });
    expect(result.captureEpoch).toBe("generated-epoch");
    expect(result.captureEpoch).not.toBe("hello-world");
    expect(result.captureEpoch).not.toBe("spk_02");
    expect(result.observation.segments?.[0]?.speakerClusterId).toBe("spk_02");
  });
});
