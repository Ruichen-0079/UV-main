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

  it("relays correlated proactive text requests and admission results", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    try {
      const requests: string[] = [];
      const results: Array<[string, string, string]> = [];
      main.subscribe((message) => {
        if (message.kind === "proactive-text-request") requests.push(message.decisionId);
      });
      companion.subscribe((message) => {
        if (message.kind === "proactive-text-admission-result") {
          results.push([message.decisionId, message.decision, message.reason]);
        }
      });

      companion.post({
        kind: "proactive-text-request",
        decisionId: "decision-1",
        modality: "text"
      });
      main.post({
        kind: "proactive-text-admission-result",
        decisionId: "decision-1",
        decision: "denied",
        reason: "consent-unavailable"
      });

      await vi.waitFor(() => {
        expect(requests).toEqual(["decision-1"]);
        expect(results).toEqual([["decision-1", "denied", "consent-unavailable"]]);
      });
    } finally {
      main.close();
      companion.close();
    }
  });

  it("relays correlated browser playback status messages", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    try {
      const received: Array<[string, number]> = [];
      main.subscribe((message) => {
        if (message.kind === "playback-status") {
          received.push([message.state, message.segmentSequence]);
        }
      });
      companion.post({
        kind: "playback-status",
        requestId: "r1",
        segmentSequence: 0,
        state: "started"
      });
      companion.post({
        kind: "playback-status",
        requestId: "r1",
        segmentSequence: 0,
        state: "ended"
      });
      await vi.waitFor(() =>
        expect(received).toEqual([
          ["started", 0],
          ["ended", 0]
        ])
      );
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

  it("relays persistent TTS configuration separately from voice preference", async () => {
    const main = new CompanionBus("main");
    const companion = new CompanionBus("companion");
    try {
      const received: Array<{ enabled: boolean; mode: "managed" | "external" } | null> = [];
      companion.subscribe((message) => {
        if (message.kind === "tts-config") received.push(message.config);
      });
      main.post({ kind: "tts-config", config: { enabled: false, mode: "managed" } });
      main.post({ kind: "tts-config", config: null });
      await vi.waitFor(() => expect(received).toEqual([{ enabled: false, mode: "managed" }, null]));
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
      channel.postMessage({
        from: "main",
        message: {
          kind: "proactive-text-request",
          decisionId: "decision-1",
          modality: "text",
          prompt: "not allowed"
        }
      });
      channel.postMessage({
        from: "main",
        message: {
          kind: "proactive-text-admission-result",
          decisionId: "decision-1",
          decision: "accepted",
          reason: "runtime-admitted",
          content: "not allowed"
        }
      });
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
      isCompanionBusMessage({ kind: "playback-status", requestId: "r1", state: "started" })
    ).toBe(false);
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
    expect(
      isCompanionBusMessage({
        kind: "playback-status",
        requestId: "r1",
        segmentSequence: 0,
        state: "started"
      })
    ).toBe(true);
    expect(
      isCompanionBusMessage({
        kind: "playback-status",
        requestId: "r1",
        segmentSequence: 0,
        state: "playing"
      })
    ).toBe(false);
    expect(isCompanionBusMessage({ kind: "user-gesture", extra: true })).toBe(false);
    expect(
      isCompanionBusMessage({
        kind: "tts-config",
        config: { enabled: true, mode: "external" }
      })
    ).toBe(true);
    expect(isCompanionBusMessage({ kind: "tts-config", config: { enabled: true } })).toBe(false);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-request",
        decisionId: "decision-1",
        modality: "text"
      })
    ).toBe(true);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-request",
        decisionId: "decision-1",
        modality: "speech"
      })
    ).toBe(false);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-request",
        decisionId: "   ",
        modality: "text"
      })
    ).toBe(false);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-request",
        decisionId: "decision-1",
        modality: "text",
        sessionId: "runtime-session"
      })
    ).toBe(false);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-request",
        decisionId: "decision-1",
        modality: "text",
        idempotencyKey: "runtime-key"
      })
    ).toBe(false);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-request",
        decisionId: "decision-1",
        modality: "text",
        prompt: "do not cross the gate"
      })
    ).toBe(false);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-request",
        decisionId: "decision-1",
        modality: "text",
        createdAtMs: 1,
        expiresAtMs: 2
      })
    ).toBe(false);
    for (const forbiddenField of [
      "text",
      "content",
      "writeMemory",
      "memoryWrite",
      "voiceOutput",
      "tts",
      "speech"
    ]) {
      expect(
        isCompanionBusMessage({
          kind: "proactive-text-request",
          decisionId: "decision-1",
          modality: "text",
          [forbiddenField]: true
        })
      ).toBe(false);
    }
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-admission-result",
        decisionId: "decision-1",
        decision: "accepted",
        reason: "runtime-admitted"
      })
    ).toBe(true);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-admission-result",
        decisionId: "decision-1",
        decision: "denied",
        reason: "consent-disabled"
      })
    ).toBe(true);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-admission-result",
        decisionId: "decision-1",
        decision: "accepted",
        reason: "consent-disabled"
      })
    ).toBe(false);
    expect(
      isCompanionBusMessage({
        kind: "proactive-text-admission-result",
        decisionId: "decision-1",
        decision: "denied",
        reason: "consent-unavailable",
        content: "not a result payload"
      })
    ).toBe(false);
  });
});
