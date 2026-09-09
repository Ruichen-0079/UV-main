import { describe, expect, it } from "vitest";
import { deriveFirstRunSetupState } from "./product-first-run-setup.js";

const product = (chat: string[]) => ({
  configuration: { routes: { chat } }
});

const live2d = (count: number) => ({
  models: Array.from({ length: count }, (_, index) => ({
    id: String(index),
    name: `model-${index}`,
    model: "model.model3.json",
    source: "user" as const,
    url: "/api/live2d/model.model3.json"
  }))
});

describe("deriveFirstRunSetupState", () => {
  it("requires only a configured Chat route and one installed Companion model", () => {
    expect(deriveFirstRunSetupState(product([]), live2d(0))).toEqual({
      chatConfigured: false,
      companionInstalled: false,
      complete: false
    });
    expect(deriveFirstRunSetupState(product(["chat-model"]), live2d(0))).toEqual({
      chatConfigured: true,
      companionInstalled: false,
      complete: false
    });
    expect(deriveFirstRunSetupState(product([]), live2d(1))).toEqual({
      chatConfigured: false,
      companionInstalled: true,
      complete: false
    });
    expect(deriveFirstRunSetupState(product(["chat-model"]), live2d(1))).toEqual({
      chatConfigured: true,
      companionInstalled: true,
      complete: true
    });
  });

  it("uses durable configuration instead of transient provider availability or active Live2D selection", () => {
    const ready = deriveFirstRunSetupState(product(["configured-chat"]), live2d(1));
    expect(ready.complete).toBe(true);
    expect(ready.chatConfigured).toBe(true);
    expect(ready.companionInstalled).toBe(true);
  });
});
