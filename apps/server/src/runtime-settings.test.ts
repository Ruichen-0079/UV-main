import { describe, expect, it } from "vitest";
import {
  editableKeys,
  getPendingRestartKeys,
  getRuntimeSettingApplyMode,
  sanitizeUrlUserinfo,
  validateRuntimeSettings
} from "./runtime-settings.js";

describe("runtime settings contract", () => {
  it("has one apply mode for every editable key", () => {
    expect(editableKeys).toHaveLength(new Set(editableKeys).size);
    expect(editableKeys.every((key) => getRuntimeSettingApplyMode(key))).toBe(true);
    expect(getRuntimeSettingApplyMode("SERVER_PORT")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("DEEPSEEK_CHAT_MODEL")).toBe("hot_reload");
    expect(getRuntimeSettingApplyMode("OPENAI_COMPATIBLE_CHAT_MODEL")).toBe("hot_reload");
    expect(getRuntimeSettingApplyMode("OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL")).toBe(
      "hot_reload"
    );
    expect(getRuntimeSettingApplyMode("OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT")).toBe(
      "hot_reload"
    );
    expect(getRuntimeSettingApplyMode("MEMORY_VECTOR_IVFFLAT_PROBES")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("GPT_SOVITS_TTS_GPT_WEIGHTS")).toBe("restart_required");
  });

  it("reports pending restart only when desired restart state differs from active state", () => {
    const active = {
      MEMORY_REPOSITORY: "in-memory",
      SERVER_PORT: "6121",
      PROVIDER_ALLOW_MOCKS: "false"
    };
    expect(getPendingRestartKeys({ ...active, SERVER_PORT: "6122" }, active)).toContain(
      "SERVER_PORT"
    );
    expect(getPendingRestartKeys({ ...active, MEMORY_REPOSITORY: "memory" }, active)).not.toContain(
      "MEMORY_REPOSITORY"
    );
    expect(getPendingRestartKeys({ SERVER_PORT: "6121" }, {})).not.toContain("SERVER_PORT");
    expect(getPendingRestartKeys({}, { SERVER_PORT: "6121" })).not.toContain("SERVER_PORT");
  });

  it("validates typed settings without echoing values", () => {
    const result = validateRuntimeSettings({
      MEMORY_REPOSITORY: "sqlite",
      EVENT_BUS: "nats",
      SERVER_PORT: "6121abc",
      PROVIDER_ALLOW_MOCKS: "maybe",
      CHAT_PROVIDER_CHAIN: "deepseek,unknown",
      OPENAI_COMPATIBLE_API_BASEURL: "not-a-url",
      OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT: "unknown",
      XAI_API_BASEURL: "not-a-url",
      EMBEDDING_PROVIDER: "unsupported",
      GPT_SOVITS_TTS_TOP_P: "2"
    });
    expect(result.fieldErrors).toMatchObject({
      MEMORY_REPOSITORY: expect.any(String),
      EVENT_BUS: expect.any(String),
      EMBEDDING_PROVIDER: expect.any(String),
      SERVER_PORT: expect.any(String),
      PROVIDER_ALLOW_MOCKS: expect.any(String),
      CHAT_PROVIDER_CHAIN: expect.any(String),
      OPENAI_COMPATIBLE_API_BASEURL: expect.any(String),
      OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT: expect.any(String),
      XAI_API_BASEURL: expect.any(String),
      GPT_SOVITS_TTS_TOP_P: expect.any(String)
    });
    expect(JSON.stringify(result)).not.toContain("sqlite");

    expect(
      validateRuntimeSettings({ MEMORY_REPOSITORY: "postgres" }).fieldErrors["MEMORY_REPOSITORY"]
    ).toEqual(expect.any(String));
    expect(validateRuntimeSettings({}).fieldErrors).not.toHaveProperty("EMBEDDING_PROVIDER");
    expect(
      validateRuntimeSettings({ EMBEDDING_PROVIDER: "openai-compatible" }).fieldErrors
    ).not.toHaveProperty("EMBEDDING_PROVIDER");
    expect(validateRuntimeSettings({ EMBEDDING_PROVIDER: "" }).fieldErrors).toMatchObject({
      EMBEDDING_PROVIDER: expect.any(String)
    });
  });

  it("redacts URL userinfo without changing the URL path", () => {
    expect(sanitizeUrlUserinfo("https://user:password@example.com/v1")).toBe(
      "https://example.com/v1"
    );
    expect(sanitizeUrlUserinfo("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
  });
});
