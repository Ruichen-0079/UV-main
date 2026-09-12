import { describe, expect, it } from "vitest";
import type { TTSResponse } from "./api/client.js";
import { SpeechSegmenter } from "./speech-segmenter.js";
import { SpeechPlaybackQueue, type SpeechPlaybackEvent } from "./speech-queue.js";
import { createSpeechPipelineFeedback, reduceSpeechPipelineFeedback } from "./speech-pipeline-feedback.js";

/**
 * Pins the realtime pipeline contract end to end with the real segmentation
 * authority and the real speech queue:
 *
 * provider text-delta -> SpeechSegmenter -> speak admission (CompanionBus
 * payload) -> SpeechPlaybackQueue -> synthesis -> playbackStarted -> subtitle.
 *
 * Synthesis and playback are deterministic gates so overlap, FIFO ordering,
 * single-flight synthesis, starvation and cancellation are observable.
 */
type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeHarness() {
  const REQUEST_ID = "turn-1";
  const feedback = createSpeechPipelineFeedback();
  const speaks: Array<{ requestId: string; sequence: number; text: string; language: string }> = [];
  const releaseReasons: string[] = [];
  const synthesisRequests: Array<{ sequence: number; text: string }> = [];
  const subtitles: Array<{ sequence: number; text: string }> = [];
  const playbackEvents: Array<{ type: string; sequence: number }> = [];
  let activeSynthesis = 0;
  let maxConcurrentSynthesis = 0;
  let nextEnqueuedTextBySequence = new Map<number, string>();

  const synthesisGate = deferred();
  const playbackGate = deferred();

  const segmenter = new SpeechSegmenter({
    pipeline: () => ({ ...feedback }),
    onRelease: (text, reason) => {
      const sequence = speaks.length;
      releaseReasons.push(reason);
      speaks.push({ requestId: REQUEST_ID, sequence, text, language: "zh" });
      // Mirrors forwardSpeechSegments -> bus speak -> companion enqueueSpeak.
      nextEnqueuedTextBySequence.set(sequence, text);
      queue.enqueue({ text, language: "zh" }, { requestId: REQUEST_ID, sequence });
    }
  });

  const fakeAudio = {} as HTMLAudioElement;
  const queue = new SpeechPlaybackQueue(
    async (item) => {
      const sequence = speaks.find((speak) => speak.text === item.text)?.sequence ?? -1;
      synthesisRequests.push({ sequence, text: item.text });
      activeSynthesis += 1;
      maxConcurrentSynthesis = Math.max(maxConcurrentSynthesis, activeSynthesis);
      await synthesisGate.promise;
      activeSynthesis -= 1;
      if (sequence >= 0) subtitles.push({ sequence, text: item.text });
      return { audioBase64: "ZmFrZQ==", mimeType: "audio/wav" } as TTSResponse;
    },
    async (_output, _signal, lifecycle) => {
      lifecycle?.emit({ type: "audioElementAttached", audio: fakeAudio });
      lifecycle?.emit({ type: "playbackStarted", audio: fakeAudio });
      await playbackGate.promise;
      lifecycle?.emit({ type: "playbackEnded", audio: fakeAudio });
    },
    {
      onState: (state) => {
        feedback.playing = state === "playing";
        feedback.synthesizing = state === "synthesizing";
      },
      onPlaybackEvent: (event: SpeechPlaybackEvent) => {
        playbackEvents.push({ type: event.type, sequence: event.sequence });
        if (event.type === "playbackEnded") {
          const reduced = reduceSpeechPipelineFeedback(feedback, { type: "playback-ended" });
          feedback.playing = reduced.playing;
          feedback.synthesizing = reduced.synthesizing;
          feedback.playbackEnded = reduced.playbackEnded;
        }
      }
    }
  );

  return {
    segmenter,
    queue,
    feedback,
    speaks,
    releaseReasons,
    synthesisRequests,
    subtitles,
    playbackEvents,
    synthesisGate,
    playbackGate,
    get maxConcurrentSynthesis() {
      return maxConcurrentSynthesis;
    }
  };
}

describe("speech segmentation pipeline", () => {
  it("admits the first segment for synthesis while the provider is still streaming", async () => {
    const harness = makeHarness();
    let providerComplete = false;

    harness.segmenter.push("其实这个方案可以继续做。之后我们还需要");
    expect(harness.speaks.length).toBe(1);
    // Give the queue a microtask to start synthesis.
    await Promise.resolve();
    expect(harness.synthesisRequests.length).toBe(1);
    // The provider has NOT completed yet — later deltas are still pending.
    expect(providerComplete).toBe(false);

    harness.segmenter.push("更多内容，暂时还没有句号");
    harness.segmenter.flush("completed");
    providerComplete = true;
    expect(providerComplete).toBe(true);
    // Overlap proven: synthesis admission happened before provider completion.
    expect(harness.synthesisRequests.length).toBeGreaterThanOrEqual(1);
    harness.synthesisGate.resolve();
    harness.playbackGate.resolve();
  });

  it("keeps S1/S2/S3 strictly ordered and synthesizes one at a time", async () => {
    const harness = makeHarness();
    harness.segmenter.push("第一句话。第二句话。第三句话。");
    expect(harness.speaks.map((speak) => speak.sequence)).toEqual([0, 1, 2]);
    await Promise.resolve();
    await Promise.resolve();
    // Single-flight synthesis: S2/S3 wait for S1's gated request.
    expect(harness.synthesisRequests.length).toBe(1);
    expect(harness.maxConcurrentSynthesis).toBe(1);
    harness.synthesisGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.synthesisRequests.length).toBe(2);
    expect(harness.maxConcurrentSynthesis).toBe(1);
    harness.synthesisGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.synthesisRequests.length).toBe(3);
    expect(harness.maxConcurrentSynthesis).toBe(1);

    harness.playbackGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    harness.playbackGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    harness.playbackGate.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const starts = harness.playbackEvents.filter((event) => event.type === "playbackStarted");
    const ends = harness.playbackEvents.filter((event) => event.type === "playbackEnded");
    expect(starts.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(ends.map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  it("subtitles exactly the speech segment that reaches playbackStarted", async () => {
    const harness = makeHarness();
    harness.segmenter.push("第一句话。第二句话。");
    harness.synthesisGate.resolve();
    harness.playbackGate.resolve();
    await new Promise<void>((done) => setTimeout(done, 0));
    await new Promise<void>((done) => setTimeout(done, 0));
    await new Promise<void>((done) => setTimeout(done, 0));
    await new Promise<void>((done) => setTimeout(done, 0));

    const started = harness.playbackEvents.filter((event) => event.type === "playbackStarted");
    for (const event of started) {
      const subtitle = harness.subtitles.find((entry) => entry.sequence === event.sequence);
      const speak = harness.speaks.find((entry) => entry.sequence === event.sequence);
      expect(subtitle).toBeDefined();
      expect(subtitle?.text).toBe(speak?.text);
    }
  });

  it("releases a soft boundary when the queue is starving, holds it while playing", async () => {
    const harness = makeHarness();
    harness.segmenter.push("第一句话完整了。后面只有逗号，还没有句号");
    await Promise.resolve();
    expect(harness.speaks.length).toBe(1);
    expect(harness.releaseReasons[0]).toBe("FIRST_STRONG");

    // Playback has not ended and synthesis is gated: the soft boundary holds.
    expect(harness.speaks.length).toBe(1);

    // Let synthesis finish so audio becomes ready, then finish playback:
    // everything released has now played and nothing is in flight.
    harness.synthesisGate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    harness.playbackGate.resolve();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(harness.feedback.playbackEnded).toBe(1);

    harness.segmenter.push("，后续仍然没有句号出现");
    expect(harness.speaks.length).toBe(2);
    expect(harness.releaseReasons[1]).toBe("STARVING_SOFT_BOUNDARY");
    expect(harness.speaks[1]?.text).toContain("后面只有逗号，");

    harness.synthesisGate.resolve();
    harness.playbackGate.resolve();
  });

  it("does not leak pending text after cancellation", async () => {
    const harness = makeHarness();
    harness.segmenter.push("完整的第一句。");
    await Promise.resolve();
    expect(harness.speaks.length).toBe(1);

    harness.segmenter.push("被取消的残尾没有任何标点");
    harness.segmenter.flush("cancelled");
    harness.queue.cancel();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    // The cancelled tail never became speech and no second synthesis ran.
    expect(harness.speaks.length).toBe(1);
    expect(harness.synthesisRequests.length).toBe(1);
    harness.synthesisGate.resolve();
  });
});
