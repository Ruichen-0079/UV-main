import { describe, expect, it, vi } from "vitest";
import { SpeechPlaybackQueue, type SpeechQueueItem } from "./speech-queue.js";

describe("SpeechPlaybackQueue", () => {
  it("synthesizes and plays queued segments in order", async () => {
    const events: string[] = [];
    const synthesize = vi.fn(async (item: SpeechQueueItem) => {
      events.push(`synth:${item.text}`);
      return { audioBase64: "", mimeType: "audio/wav" } as never;
    });
    const play = vi.fn(async (output: unknown) => {
      void output;
      events.push(`play:${events.filter((value) => value.startsWith("synth:")).length}`);
    });
    const queue = new SpeechPlaybackQueue(synthesize, play);
    queue.enqueue({ text: "one", language: "en" });
    queue.enqueue({ text: "two", language: "en" });
    queue.finish();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(events).toEqual(["synth:one", "play:1", "synth:two", "play:2"]);
  });

  it("starts synthesizing the next segment while the previous audio is playing", async () => {
    const events: string[] = [];
    let releaseFirstPlayback: (() => void) | undefined;
    const synthesize = vi.fn(async (item: SpeechQueueItem) => {
      events.push(`synth:${item.text}`);
      return { audioBase64: item.text, mimeType: "audio/wav" } as never;
    });
    const play = vi.fn(async (output: { audioBase64: string }) => {
      events.push(`play:${output.audioBase64}`);
      if (output.audioBase64 === "one") {
        await new Promise<void>((resolve) => {
          releaseFirstPlayback = resolve;
        });
      }
    });
    const queue = new SpeechPlaybackQueue(synthesize, play);

    queue.enqueue({ text: "one", language: "en" });
    queue.enqueue({ text: "two", language: "en" });
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    expect(play).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["synth:one", "play:one", "synth:two"]);

    releaseFirstPlayback?.();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(events).toEqual(["synth:one", "play:one", "synth:two", "play:two"]);
  });

  it("does not synthesize pending work after cancellation", async () => {
    let release: (() => void) | undefined;
    const synthesize = vi.fn(
      () => new Promise<never>((resolve) => void (release = () => resolve(undefined as never)))
    );
    const play = vi.fn(async () => undefined);
    const queue = new SpeechPlaybackQueue(synthesize, play);
    queue.enqueue({ text: "one", language: "en" });
    queue.enqueue({ text: "two", language: "en" });
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    queue.cancel();
    release?.();
    await Promise.resolve();
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
  });
});
