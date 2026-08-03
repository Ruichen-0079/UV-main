import { describe, expect, it, vi } from "vitest";
import {
  createBrowserSpeechPlayer,
  SpeechPlaybackQueue,
  type SpeechQueueItem
} from "./speech-queue.js";

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

  it("reports a completed synthesis before that segment starts playing", async () => {
    const events: string[] = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async (output: { audioBase64: string }) => {
        events.push(`play:${output.audioBase64}`);
      },
      {
        onSynthesisCompleted: (item) => events.push(`ready:${item.sequence}:${item.item.text}`)
      }
    );
    queue.enqueue({ text: "one", language: "en" });
    queue.finish();
    await vi.waitFor(() => expect(events).toEqual(["ready:0:one", "play:one"]));
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

  it("reports playback failure without affecting the text queue caller", async () => {
    const errors: unknown[] = [];
    const states: string[] = [];
    const queue = new SpeechPlaybackQueue(
      async () => ({ audioBase64: "audio", mimeType: "audio/wav" }) as never,
      async () => {
        throw new Error("audio failed");
      },
      {
        onError: (error) => errors.push(error),
        onState: (state) => states.push(state)
      }
    );
    queue.enqueue({ text: "one", language: "en" });
    queue.finish();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(states).toContain("error");
    expect(errors[0]).toMatchObject({ message: "audio failed" });
  });

  it("reports per-item lifecycle states through completion", async () => {
    const states: Array<[string | undefined, string]> = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async () => undefined,
      { onItemState: (id, state) => states.push([id, state]) }
    );
    queue.enqueue({ text: "one", language: "en" }, "0");
    queue.enqueue({ text: "two", language: "en" }, "1");
    queue.finish();
    await vi.waitFor(() => expect(states).toContainEqual(["1", "completed"]));
    const stateFor = (id: string) =>
      states.filter(([itemId]) => itemId === id).map(([, state]) => state);
    expect(stateFor("0")).toEqual(["queued", "synthesizing", "ready", "playing", "completed"]);
    expect(stateFor("1")).toEqual(["queued", "synthesizing", "ready", "playing", "completed"]);
  });

  it("skips a failed synthesis and continues with remaining segments", async () => {
    const errors: unknown[] = [];
    const states: Array<[string | undefined, string]> = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => {
        if (item.text === "bad") throw new Error("upstream rejected");
        return { audioBase64: item.text, mimeType: "audio/wav" } as never;
      },
      async () => undefined,
      {
        onError: (error) => errors.push(error),
        onItemState: (id, state) => states.push([id, state])
      }
    );
    queue.enqueue({ text: "bad", language: "en" }, "0");
    queue.enqueue({ text: "good", language: "en" }, "1");
    queue.finish();
    await vi.waitFor(() => expect(states).toContainEqual(["1", "completed"]));
    expect(errors).toHaveLength(1);
    const stateFor = (id: string) =>
      states.filter(([itemId]) => itemId === id).map(([, state]) => state);
    expect(stateFor("0").at(-1)).toBe("failed");
    expect(stateFor("1").at(-1)).toBe("completed");
  });

  it("marks first play failure as failed and continues later sequences", async () => {
    const states: Array<[string | undefined, string]> = [];
    const errors: unknown[] = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async (output: { audioBase64: string }) => {
        if (output.audioBase64 === "one") throw new DOMException("NotAllowedError");
      },
      {
        onItemState: (id, state) => states.push([id, state]),
        onError: (error) => errors.push(error)
      }
    );
    queue.enqueue({ text: "one", language: "en" }, "0");
    queue.enqueue({ text: "two", language: "en" }, "1");
    queue.finish();
    await vi.waitFor(() => expect(states).toContainEqual(["1", "completed"]));
    expect(states.filter(([id, state]) => id === "0" && state === "failed")).toHaveLength(1);
    expect(states.filter(([id, state]) => id === "0" && state === "completed")).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("plays ready segments in ascending sequence order", async () => {
    const played: string[] = [];
    const queue = new SpeechPlaybackQueue(
      async (item) => {
        // Resolve sequence 1 before sequence 0 artificially via delay on first.
        if (item.text === "zero") await new Promise((resolve) => setTimeout(resolve, 30));
        return { audioBase64: item.text, mimeType: "audio/wav" } as never;
      },
      async (output: { audioBase64: string }) => {
        played.push(output.audioBase64);
      }
    );
    // Synthesis is serial in the queue, so order is natural; assert completion order.
    queue.enqueue({ text: "zero", language: "en" }, "0");
    queue.enqueue({ text: "one", language: "en" }, "1");
    queue.finish();
    await vi.waitFor(() => expect(played).toEqual(["zero", "one"]));
  });

  it("marks every unfinished segment cancelled and leaves none pending", async () => {
    let release: (() => void) | undefined;
    const states: Array<[string | undefined, string]> = [];
    const queue = new SpeechPlaybackQueue(
      () =>
        new Promise<never>((resolve) => {
          release = () => resolve(undefined as never);
        }),
      async () => undefined,
      { onItemState: (id, state) => states.push([id, state]) }
    );
    queue.enqueue({ text: "one", language: "en" }, "0");
    queue.enqueue({ text: "two", language: "en" }, "1");
    await vi.waitFor(() => expect(release).toBeDefined());
    queue.cancel();
    release?.();
    await Promise.resolve();
    const cancelled = states.filter(([, state]) => state === "cancelled").length;
    expect(cancelled).toBe(2);
    expect(states.map(([, state]) => state)).not.toContain("completed");
    expect(states.map(([, state]) => state)).not.toContain("ready");
  });

  it("restarts sequence state independently for a fresh turn", async () => {
    const firstStates: Array<[string | undefined, string]> = [];
    const first = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async () => undefined,
      { onItemState: (id, state) => firstStates.push([id, state]) }
    );
    first.enqueue({ text: "one", language: "en" }, "0");
    first.finish();
    await vi.waitFor(() => expect(firstStates).toContainEqual(["0", "completed"]));

    const secondStates: Array<[string | undefined, string]> = [];
    const second = new SpeechPlaybackQueue(
      async (item) => ({ audioBase64: item.text, mimeType: "audio/wav" }) as never,
      async () => undefined,
      { onItemState: (id, state) => secondStates.push([id, state]) }
    );
    second.enqueue({ text: "two", language: "en" }, "0");
    second.finish();
    await vi.waitFor(() => expect(secondStates).toContainEqual(["0", "completed"]));
    expect(secondStates.filter(([id]) => id === "0").length).toBeGreaterThan(0);
    expect(firstStates.filter(([id]) => id === "0").length).toBeGreaterThan(0);
  });

  it("exposes playback lifecycle only after the player starts", async () => {
    const audio = {} as HTMLAudioElement;
    const events: string[] = [];
    const queue = new SpeechPlaybackQueue(
      async () => ({ audioBase64: "", mimeType: "audio/wav" }) as never,
      async (_output, _signal, lifecycle) => {
        lifecycle?.emit({ type: "audioElementAttached", audio });
        lifecycle?.emit({ type: "playbackStarted", audio });
        lifecycle?.emit({ type: "playbackEnded", audio });
      },
      { onPlaybackEvent: (event) => events.push(event.type) }
    );
    queue.enqueue({ text: "one", language: "en" });
    queue.finish();
    await vi.waitFor(() =>
      expect(events).toEqual(["audioElementAttached", "playbackStarted", "playbackEnded"])
    );
  });

  it("does not emit playbackStarted after a cancelled play promise settles", async () => {
    let resolvePlay: (() => void) | undefined;
    const playPromise = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    const audio = {
      play: vi.fn(() => playPromise),
      pause: vi.fn(),
      onended: null,
      onerror: null
    } as unknown as HTMLAudioElement;
    vi.stubGlobal("Audio", vi.fn(() => audio));
    vi.stubGlobal("atob", vi.fn(() => ""));
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn()
    });
    const controller = new AbortController();
    const events: string[] = [];
    const player = createBrowserSpeechPlayer();
    const playback = player(
      { audioBase64: "", mimeType: "audio/wav" } as never,
      controller.signal,
      { sequence: 0, emit: (event) => events.push(event.type) }
    );
    controller.abort();
    resolvePlay?.();
    await expect(playback).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["audioElementAttached", "playbackStopped", "audioElementDetached"]);
    expect(audio.pause).toHaveBeenCalledTimes(1);
  });
});
