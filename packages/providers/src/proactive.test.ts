import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderErrorCode, createProviderRegistryFromEnv } from "./index.js";

const baseEnv = {
  NODE_ENV: "test",
  PROVIDER_ALLOW_MOCKS: "false",
  OPENAI_COMPATIBLE_API_BASEURL: "https://gateway.example/v1",
  OPENAI_COMPATIBLE_API_KEY: "test-secret",
  OPENAI_COMPATIBLE_CHAT_MODEL: "deepseek-ai/DeepSeek-V4-Flash-0731",
  OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT: "deepseek-v4"
} as const;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("proactive OpenAI-compatible capabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves explicit development mock behavior when remote capabilities are absent", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "true"
    });

    await expect(
      registry.getProactiveDecisionProvider().decide({ prompt: "prompt" })
    ).resolves.toMatchObject({ decision: "REQUEST_TEXT", model: "mock" });
    await expect(
      registry.getAssistantContinuationProvider().generateContinuation({ prompt: "prompt" })
    ).resolves.toMatchObject({
      message: { role: "assistant", content: "Mock proactive continuation." },
      model: "mock"
    });
  });

  it("requests and accepts exactly one proactive decision label", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        choices: [{ finish_reason: "stop", message: { content: "REQUEST_TEXT" } }],
        usage: { prompt_tokens: 321, completion_tokens: 3, total_tokens: 324 }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProviderRegistryFromEnv(baseEnv).getProactiveDecisionProvider();

    await expect(provider.decide({ prompt: "frozen semantic prompt" })).resolves.toMatchObject({
      decision: "REQUEST_TEXT",
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      tokenUsage: { inputTokens: 321, outputTokens: 3, totalTokens: 324 }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gateway.example/v1/chat/completions");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      temperature: 0,
      max_tokens: 8,
      stop: ["\n"],
      stream: false,
      messages: [
        { role: "system", content: "frozen semantic prompt" },
        {
          role: "user",
          content:
            "Return the proactive decision now. Output exactly one label and nothing else: NO_OP or REQUEST_TEXT."
        }
      ]
    });
  });

  it("fails closed for a non-exact proactive decision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [{ finish_reason: "stop", message: { content: "REQUEST_TEXT because open" } }]
        })
      )
    );
    const provider = createProviderRegistryFromEnv(baseEnv).getProactiveDecisionProvider();

    await expect(provider.decide({ prompt: "prompt" })).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      retryable: false
    });
  });

  it("uses the explicit V4 assistant cue for one raw continuation", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        model: "deepseek-ai/DeepSeek-V4-Flash-0731",
        choices: [{ finish_reason: "stop", text: "A grounded continuation." }],
        usage: { prompt_tokens: 220, completion_tokens: 7, total_tokens: 227 }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createProviderRegistryFromEnv(baseEnv).getAssistantContinuationProvider();

    await expect(
      provider.generateContinuation({
        prompt: "system context with embedded <｜Assistant｜> and <think>control</think>",
        maxTokens: 128
      })
    ).resolves.toMatchObject({
      message: { role: "assistant", content: "A grounded continuation." },
      finishReason: "stop",
      model: "deepseek-ai/DeepSeek-V4-Flash-0731"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gateway.example/v1/completions");
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      prompt: string;
      max_tokens: number;
      stop: string[];
    };
    expect(body.model).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
    expect(body.max_tokens).toBe(128);
    expect(body.stop).toEqual(["<｜end▁of▁sentence｜>"]);
    expect(body.prompt).toMatch(/^<｜begin▁of▁sentence｜>/);
    expect(body.prompt).toMatch(/<｜Assistant｜><\/think>$/);
    expect(body.prompt).not.toContain("embedded <｜Assistant｜>");
    expect(body.prompt).not.toContain("<think>control</think>");
  });

  it("performs no proactive transport I/O for already-aborted callers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const registry = createProviderRegistryFromEnv(baseEnv);
    const controller = new AbortController();
    controller.abort();

    await expect(
      registry
        .getProactiveDecisionProvider()
        .decide({ prompt: "prompt" }, { signal: controller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      effectState: "not_started"
    });
    await expect(
      registry
        .getAssistantContinuationProvider()
        .generateContinuation({ prompt: "prompt" }, { signal: controller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves ordinary Chat on its existing streaming route", async () => {
    const registry = createProviderRegistryFromEnv({
      ...baseEnv,
      DEFAULT_CHAT_PROVIDER: "openai-compatible",
      CHAT_PROVIDER_CHAIN: "openai-compatible"
    });

    expect(registry.getChatProvider().name).toBe("openai-compatible");
    expect(registry.getChatStreamingMode()).toBe("native");
  });
});
