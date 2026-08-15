import { describe, expect, it, vi } from "vitest";
import { CompanionBus, isCompanionBusMessage } from "./companion-bus.js";

describe("CompanionBus", () => {
  it("relays main -> companion messages across bus instances", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    try {
      const received: string[] = [];
      companion.subscribe((message) => {
        received.push(message.kind);
      });
      main.post({ kind: "user-gesture" });
      main.post({ kind: "start-generation", requestId: "r1", sessionId: "default" });
      main.post({ kind: "speak", requestId: "r1", sequence: 0, text: "你好", language: "zh" });
      main.post({ kind: "speech-end", requestId: "r1" });
      await vi.waitFor(() =>
        expect(received).toEqual(["user-gesture", "start-generation", "speak", "speech-end"])
      );
    } finally {
      main.close();
      companion.close();
    }
  });

  it("relays companion -> main speech status messages", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    try {
      const received: string[] = [];
      main.subscribe((message) => {
        if (message.kind === "speech-status") received.push(message.state);
      });
      companion.post({ kind: "speech-status", requestId: "r1", state: "playing" });
      companion.post({ kind: "speech-status", requestId: "r1", state: "idle" });
      await vi.waitFor(() => expect(received).toEqual(["playing", "idle"]));
    } finally {
      main.close();
      companion.close();
    }
  });

  it("relays voice-enabled preference from main to companion", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    try {
      const received: boolean[] = [];
      companion.subscribe((message) => {
        if (message.kind === "voice-enabled") received.push(message.enabled);
      });
      main.post({ kind: "voice-enabled", enabled: true });
      main.post({ kind: "voice-enabled", enabled: false });
      await vi.waitFor(() => expect(received).toEqual([true, false]));
    } finally {
      main.close();
      companion.close();
    }
  });

  it("ignores unknown wire payloads and self-originated messages", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    try {
      const listener = vi.fn();
      companion.subscribe(listener);
      // The same role does not observe its own messages (BroadcastChannel
      // semantics); simulate a self message directly on the channel.
      const channel = new BroadcastChannel("yuvi-companion-bus-v1");
      channel.postMessage({
        from: "companion",
        message: { kind: "speak", requestId: "r1", sequence: 0, text: "x", language: "zh" }
      });
      channel.postMessage({ from: "main", message: { kind: "unknown" } });
      channel.postMessage("junk");
      await vi.waitFor(() => expect(listener).not.toHaveBeenCalled());
      channel.close();
    } finally {
      main.close();
      companion.close();
    }
  });

  it("delivers speech segments with a monotonically increasing sequence", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    try {
      const sequences: number[] = [];
      companion.subscribe((message) => {
        if (message.kind === "speak") sequences.push(message.sequence);
      });
      main.post({ kind: "speak", requestId: "r1", sequence: 0, text: "a", language: "ja" });
      main.post({ kind: "speak", requestId: "r1", sequence: 1, text: "b", language: "ja" });
      main.post({ kind: "speak", requestId: "r1", sequence: 2, text: "c", language: "ja" });
      await vi.waitFor(() => expect(sequences).toEqual([0, 1, 2]));
    } finally {
      main.close();
      companion.close();
    }
  });

  it("does not deliver to unsubscribed listeners (StrictMode remount safety)", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    try {
      const listener = vi.fn();
      const unsubscribe = companion.subscribe(listener);
      unsubscribe();
      main.post({ kind: "voice-enabled", enabled: true });
      main.post({ kind: "speak", requestId: "r1", sequence: 0, text: "x", language: "ja" });
      await vi.waitFor(() => expect(listener).not.toHaveBeenCalled());
    } finally {
      main.close();
      companion.close();
    }
  });

  it("validates correlated message payloads before delivery", () => {
    expect(
      isCompanionBusMessage({ kind: "start-generation", requestId: "r1", sessionId: "default" })
    ).toBe(true);
    expect(
      isCompanionBusMessage({
        kind: "speak",
        requestId: "r1",
        sequence: 0,
        text: "x",
        language: "en"
      })
    ).toBe(true);
    expect(
      isCompanionBusMessage({
        kind: "speak",
        requestId: "r1",
        sequence: -1,
        text: "x",
        language: "en"
      })
    ).toBe(false);
    expect(
      isCompanionBusMessage({ kind: "generation-state", requestId: "r1", state: "unknown" })
    ).toBe(false);
    expect(isCompanionBusMessage({ kind: "user-gesture", extra: true })).toBe(false);
  });
});
