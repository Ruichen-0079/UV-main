import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createAppContext } from "./context.js";
import { buildServer } from "./server.js";
import { loadServerConfig } from "./config.js";

const originalEnv = { ...process.env };
const createdDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function productionTestEnv(): NodeJS.ProcessEnv {
  const runtimeEnvDir = path.join(tmpdir(), `yuvi-character-${crypto.randomUUID()}`);
  createdDirs.push(runtimeEnvDir);
  return {
    NODE_ENV: "development",
    RUNTIME_MODE: "development",
    YUVI_RUNTIME_ENV_DIR: runtimeEnvDir,
    PROVIDER_ALLOW_MOCKS: "false",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_EXTRACTOR: "llm",
    EVENT_BUS: "in-memory",
    DEFAULT_CHAT_PROVIDER: "openai-compatible",
    CHAT_PROVIDER_CHAIN: "openai-compatible",
    DEFAULT_REASONING_PROVIDER: "openai-compatible",
    REASONING_PROVIDER_CHAIN: "openai-compatible",
    DEFAULT_TTS_PROVIDER: "xai",
    DEFAULT_STT_PROVIDER: "dashscope",
    DEFAULT_VISION_PROVIDER: "xai",
    EMBEDDING_PROVIDER: "mock",
    DEFAULT_EMBEDDING_PROVIDER: "mock",
    MEMORY_MAINTENANCE_ENABLED: "false",
    MEMORY_MAINTENANCE_RUN_ON_STARTUP: "false",
    MEMORY_MAINTENANCE_INTERVAL_MINUTES: "0",
    MEMORY_MAINTENANCE_LIMIT: "500",
    OPENAI_COMPATIBLE_API_BASEURL: "https://gateway.example/v1",
    OPENAI_COMPATIBLE_API_KEY: "test-only-key",
    OPENAI_COMPATIBLE_CHAT_MODEL: "deepseek-ai/DeepSeek-V4-Flash-0731",
    OPENAI_COMPATIBLE_REASONING_MODEL: "zai-org/GLM-5.3-Flash"
  };
}

function completion(model: string, content: string, reasoningContent?: string) {
  return new Response(
    JSON.stringify({
      model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content,
            ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
          }
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

type RecordedRequest = {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
};

describe("ordinary production Character path", () => {
  it("keeps the live proactive subscription connected across runtime reload", async () => {
    const env = {
      ...productionTestEnv(),
      OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL: "decision-model"
    };
    process.env = { ...env };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completion("decision-model", '{"score":0.1}'))
    );
    const app = Fastify({ logger: false });
    const context = await createAppContext(app.log, loadServerConfig(env));
    const events: unknown[] = [];
    const unsubscribe = context.subscribeProactiveStream((event) => events.push(event));
    try {
      const previous = context.runtime;
      await context.reloadRuntimeConfig(env);
      expect(context.runtime).not.toBe(previous);
      context.runtime.stopProactiveScheduler();
      context.runtime.setProactiveConsent(true);
      for await (const event of context.runtime.streamAssistantInitiatedTurn({
        sessionId: "reload-live",
        idempotencyKey: "after-reload",
        readMemory: false
      })) {
        void event;
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "proactive-decision",
          decision: "NO_OP",
          sessionId: "reload-live"
        })
      );
    } finally {
      unsubscribe();
      await context.runtime.sealAndDrainMemoryWrites();
      context.embodiedPresentationBridge.close();
      await context.memoryIngestionCoordinator.shutdown({ graceMs: 2000 });
      await context.conversationRepository.close?.();
      await context.finalizedIngestionRepository.close?.();
      await context.memoryRepository.close?.();
      await app.close();
    }
  });

  it("keeps a simple accepted RESPOND on the selected Chat model", async () => {
    const requests: RecordedRequest[] = [];
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedRequest;
      requests.push(body);
      return completion(
        body.model ?? "unknown",
        '{"disposition":"RESPOND","text":"Simple production answer."}'
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const env = productionTestEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "production-simple",
          text: "A simple production question.",
          options: { readMemory: false, writeMemory: false, voiceOutput: false }
        }
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().reply).toBe("Simple production answer.");
      expect(response.json().provider).toMatchObject({
        name: "openai-compatible",
        model: "deepseek-ai/DeepSeek-V4-Flash-0731",
        capability: "chat"
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(requests[0]?.model).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
    } finally {
      await app.close();
    }
  });

  it("takes NEED_COGNITION through one GLM round-trip and returns clean final output", async () => {
    const requests: RecordedRequest[] = [];
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedRequest;
      requests.push(body);
      const call = requests.length;
      if (call === 1) {
        return completion(
          body.model ?? "unknown",
          '{"disposition":"NEED_COGNITION","focus":"verification"}'
        );
      }
      if (call === 2) {
        return completion(
          body.model ?? "unknown",
          "COMPLETE\nNormalized cognition answer.",
          "private trace"
        );
      }
      return completion(
        body.model ?? "unknown",
        '<think>private Character trace</think>{"disposition":"RESPOND","text":"Final production answer."}'
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const env = productionTestEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "production-cognition",
          text: "Please verify this production question.",
          options: { readMemory: false, writeMemory: false, voiceOutput: false }
        }
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().reply).toBe("Final production answer.");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(requests.map((request) => request.model)).toEqual([
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        "zai-org/GLM-5.3-Flash",
        "deepseek-ai/DeepSeek-V4-Flash-0731"
      ]);
      expect(JSON.stringify(requests[1])).toContain("Please verify this production question.");
      expect(JSON.stringify(requests[1])).not.toContain("SystemIdentity");
      expect(JSON.stringify(requests[2])).toContain("COGNITION_RESULT");
      expect(JSON.stringify(requests[2])).toContain("Normalized cognition answer.");
      expect(response.body).not.toContain("private trace");
      expect(response.body).not.toContain("private Character trace");
      expect(response.body).not.toContain("reasoning_content");
      expect(response.body).not.toContain("GLM-5.3-Flash");
    } finally {
      await app.close();
    }
  });

  it("uses the same Character disposition seam for ordinary message streaming", async () => {
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedRequest;
      return completion(
        body.model ?? "unknown",
        '{"disposition":"RESPOND","text":"Streamed Character answer."}'
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const env = productionTestEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages/stream",
        payload: {
          sessionId: "production-stream",
          content: "A streamed production question.",
          options: { readMemory: false, writeMemory: false, voiceOutput: false }
        }
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("event: text-delta");
      expect(response.body).toContain("Streamed Character answer.");
      expect(response.body).toContain("event: completed");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

it("persists a controller P8 relationship correction through restart and projects its state", async () => {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedRequest;
      requests.push(body);
      return completion(body.model ?? "unknown", '{"disposition":"RESPOND","text":"P8 reached."}');
    })
  );
  const env = {
    ...productionTestEnv(),
    MEMORY_SUBJECT_USER_ID: "person-a",
    MEMORY_PERSONA_ID: "persona-a"
  };
  process.env = { ...env };
  let app = await buildServer(loadServerConfig(env));
  const correction = {
    recordVersion: "p8-1e.v1",
    correctionReference: "controller-correction-1",
    address: {
      characterInstanceId: "yuvi-default-character-instance",
      personaProfileId: "persona-a",
      subjectScopeId: "person-a"
    },
    scopeReference: { reference: "yuvi:v1:user:person-a:character:persona-a" },
    target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
    action: "REVISE",
    replacementMeaning: "The user explicitly prefers a formal relationship.",
    provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "local-controller-1" },
    supersededEvidenceReferences: []
  };
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/p8/corrections",
          remoteAddress: "192.0.2.1",
          payload: correction
        })
      ).statusCode
    ).toBe(403);
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = await app.inject({
        method: "POST",
        url: "/p8/corrections",
        payload: correction
      });
      expect(saved.statusCode, saved.body).toBe(200);
    }
    await app.close();
    app = await buildServer(loadServerConfig(env));
    const reply = await app.inject({
      method: "POST",
      url: "/message",
      payload: { text: "Hello", options: { readMemory: false, writeMemory: false } }
    });
    expect(reply.statusCode, reply.body).toBe(200);
    const semantic = JSON.parse(
      requests.at(-1)!.messages![0]!.content.split("Semantic context:\n")[1]!.split("\n")[0]!
    );
    expect(semantic.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "IDENTITY",
          state: "KNOWN",
          summary: "character.name: Yuvi"
        }),
        expect.objectContaining({ kind: "PERSONA", state: "KNOWN" }),
        expect.objectContaining({
          kind: "RELATIONSHIP_CONTEXT",
          state: "KNOWN",
          summary: correction.replacementMeaning
        }),
        expect.objectContaining({ kind: "MEMORY_EVIDENCE", state: "UNAVAILABLE" })
      ])
    );
    expect(requests.at(-1)!.messages![0]!.content).not.toContain(
      "Warm, concise, conversational, and practical"
    );
  } finally {
    await app.close();
  }
});

it("reaches one Runtime-admitted file read, normalized observation, Cognition continuation and Character re-entry", async () => {
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(path.join(tmpdir(), "yuvi-read-text-"));
  createdDirs.push(directory);
  const authorizedPath = path.join(directory, "evidence.txt");
  await writeFile(authorizedPath, "The verified count is forty-two.");
  const requests: RecordedRequest[] = [];
  const replies = [
    '{"disposition":"NEED_COGNITION","focus":"verify count"}',
    'REQUEST_CAPABILITY\n{"capabilityRef":"capability://opaque/read-authorized-text","request":"Read the authorized count evidence."}',
    "The evidence says forty-two.",
    '{"disposition":"RESPOND","text":"The count is forty-two."}'
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedRequest;
      requests.push(body);
      return completion(body.model ?? "unknown", replies.shift()!);
    })
  );
  const env = productionTestEnv();
  process.env = { ...env };
  const app = await buildServer(loadServerConfig(env));
  try {
    const authorization = await app.inject({
      method: "POST",
      url: "/capabilities/read-text/authorize",
      payload: { sessionId: "read-text", path: authorizedPath }
    });
    expect(authorization.statusCode, authorization.body).toBe(200);
    const reply = await app.inject({
      method: "POST",
      url: "/message",
      payload: {
        sessionId: "read-text",
        text: "Verify the count",
        options: { readMemory: false, writeMemory: false }
      }
    });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.json().reply).toBe("The count is forty-two.");
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[2])).toContain("The verified count is forty-two.");
    expect(JSON.stringify(requests[3])).toContain("COGNITION_RESULT");
    expect(JSON.stringify(requests[3])).toContain("The evidence says forty-two.");
    expect(JSON.stringify(requests)).not.toContain(authorizedPath);
  } finally {
    await app.close();
  }
});

it("binds a voice through the controller, restores it, and isolates resolved, mixed and conflicting speech turns", async () => {
  const records = new Map<string, Record<string, unknown>>();
  const searchScopes: string[] = [];
  const chatRequests: RecordedRequest[] = [];
  let mixed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.hostname === "stt.example") {
        if (url.pathname === "/speakers")
          return Response.json({ speakers: [{ speakerId: "profile-a", label: "Voice A" }] });
        if (url.pathname === "/transcribe")
          return Response.json({
            text: "Hello from speech",
            voiceProfileMatch: { status: "MATCHED", voiceProfileId: "profile-a" },
            ...(mixed
              ? {
                  segments: [
                    {
                      text: "Hello",
                      speaker: "0",
                      voiceProfileMatch: { status: "MATCHED", voiceProfileId: "profile-a" }
                    },
                    { text: "from speech", speaker: "1", voiceProfileMatch: { status: "NO_MATCH" } }
                  ]
                }
              : {})
          });
      }
      if (url.hostname === "memory.example") {
        if (url.pathname === "/v1/memories" && init?.method === "POST") {
          const id = `binding-${records.size}`;
          const record = { id, content: body.content, scope: body.scope, metadata: body.metadata };
          records.set(id, record);
          return Response.json({ ok: true, data: { memoryId: id, operation: "created", record } });
        }
        if (url.pathname === "/v1/memories/search") {
          searchScopes.push(body.scope);
          return Response.json({
            ok: true,
            data: {
              items: [
                {
                  id: "mint-evidence",
                  content: "The user grows mint in the garden.",
                  scope: body.scope,
                  metadata: {},
                  score: 0.9
                }
              ]
            }
          });
        }
        if (url.pathname.startsWith("/v1/memories/"))
          return Response.json({ ok: true, data: records.get(url.pathname.split("/").at(-1)!) });
        return Response.json({ ok: true, data: {} });
      }
      chatRequests.push(body);
      return completion(
        body.model ?? "unknown",
        '{"disposition":"RESPOND","text":"Speech reached Character."}'
      );
    })
  );
  const env = {
    ...productionTestEnv(),
    MEMORY_BACKEND: "mem0",
    MEM0_BASE_URL: "http://memory.example",
    MEMORY_PERSONA_ID: "persona-a",
    MEMORY_SUBJECT_USER_ID: "default-must-not-inherit",
    STT_PROVIDER_CHAIN: "local",
    DEFAULT_STT_PROVIDER: "local",
    LOCAL_STT_BASE_URL: "http://stt.example",
    LOCAL_STT_MODEL: "sensevoice"
  };
  process.env = { ...env };
  let app = await buildServer(loadServerConfig(env));
  const bind = (personId: string) =>
    app.inject({ method: "POST", url: "/voice-profiles/profile-a/person", payload: { personId } });
  const speak = (sessionId: string) =>
    app.inject({
      method: "POST",
      url: "/v1/voice/message",
      payload: {
        sessionId,
        audioBase64: "YXVkaW8=",
        mimeType: "audio/wav",
        subjectUserId: "forged-person",
        options: { readMemory: true, writeMemory: false, voiceOutput: false }
      }
    });
  try {
    const unresolved = await speak("unresolved");
    expect(unresolved.statusCode, unresolved.body).toBe(200);
    expect(searchScopes).toEqual([]);
    const binding = await bind("person-a");
    expect(binding.statusCode, binding.body).toBe(200);
    await app.close();
    app = await buildServer(loadServerConfig(env));
    const resolved = await speak("resolved");
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(searchScopes).toContain("yuvi:v1:user:person-a:character:persona-a");
    expect(JSON.stringify(chatRequests)).toContain("person-a");
    expect(JSON.stringify(chatRequests)).toContain("The user grows mint in the garden.");
    expect(JSON.stringify(chatRequests)).toContain("mem0:mint-evidence");
    expect(JSON.stringify(chatRequests)).not.toMatch(
      /profile-a|voiceProfileId|speakerClusterId|embedding/
    );
    searchScopes.length = 0;
    mixed = true;
    const mixedReply = await speak("mixed");
    expect(mixedReply.statusCode, mixedReply.body).toBe(200);
    expect(searchScopes).toEqual([]);
    mixed = false;
    expect((await bind("person-b")).statusCode).toBe(200);
    const conflicting = await speak("conflicting");
    expect(conflicting.statusCode, conflicting.body).toBe(200);
    expect(searchScopes).toEqual([]);
  } finally {
    await app.close();
  }
});
