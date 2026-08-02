import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryConversationRepository,
  PostgresConversationRepository,
  type ConversationDatabaseClient,
  parseConversationRepositoryEnv
} from "./conversation-repository.js";
import { PostgresMemoryRepository } from "./repository.js";

function message(
  id: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  traceId = "trace-" + id
) {
  return {
    id,
    sessionId,
    traceId,
    parentMessageId: null,
    role,
    content,
    status: "completed" as const,
    createdAt: "2026-01-01T00:00:0" + id + "Z",
    completedAt: "2026-01-01T00:00:0" + id + "Z",
    metadata: {}
  };
}

describe("ConversationRepository", () => {
  it("keeps sessions isolated, ordered, bounded, and idempotent in memory", async () => {
    const repository = new InMemoryConversationRepository();
    await repository.appendMessage(message("1", "session-a", "user", "hello"));
    await repository.appendMessage(message("2", "session-a", "assistant", "hi"));
    await repository.appendMessage(message("3", "session-b", "user", "other"));
    await repository.appendMessage(message("2", "session-a", "assistant", "duplicate"));

    const messages = await repository.listRecentMessages("session-a", { maxCharacters: 5 });
    expect(messages.map((item) => item.content)).toEqual(["hi"]);
    expect((await repository.listRecentMessages("session-b")).map((item) => item.content)).toEqual([
      "other"
    ]);

    messages[0]!.metadata["changed"] = true;
    expect((await repository.listRecentMessages("session-a"))[0]?.metadata).toEqual({});
  });

  it("uses the injectable PostgreSQL client for append and ordered reads", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const queries: string[] = [];
    let sequence = 0;
    const client = {
      async query(sql: string, values: unknown[] = []) {
        queries.push(sql);
        if (sql.includes("insert into conversation_messages")) {
          const existing = rows.find((row) => row["id"] === values[0]);
          if (existing) {
            return { rows: [] };
          }
          const row = {
            id: values[0],
            session_id: values[1],
            trace_id: values[2],
            parent_message_id: values[3],
            role: values[4],
            content: values[5],
            status: values[6],
            created_at: values[7],
            completed_at: values[8],
            metadata: values[9],
            sequence: ++sequence
          };
          rows.push(row);
          return { rows: [row] };
        }
        if (sql.includes("select * from conversation_messages where id")) {
          return { rows: rows.filter((row) => row["id"] === values[0]) };
        }
        if (sql.includes("select * from conversation_messages")) {
          return {
            rows: rows
              .filter((row) => row["session_id"] === values[0])
              .sort((left, right) => Number(right["sequence"]) - Number(left["sequence"]))
              .slice(0, Number(values[1]))
          };
        }
        return { rows: [] };
      },
      async end() {}
    };
    const repository = new PostgresConversationRepository(client);

    await repository.appendMessage(message("1", "session-a", "user", "hello"));
    await repository.appendMessage(message("2", "session-a", "assistant", "hi"));
    await repository.appendMessage(message("2", "session-a", "assistant", "duplicate"));

    expect((await repository.listRecentMessages("session-a")).map((item) => item.content)).toEqual([
      "hello",
      "hi"
    ]);
    const messageInsert = queries.find((sql) => sql.includes("insert into conversation_messages"));
    expect(messageInsert).toContain("on conflict (id) do nothing");
    expect(messageInsert).not.toMatch(/max\s*\(\s*sequence\s*\)/i);
  });

  it("allows an explicit conversation repository driver and reuses the memory default", () => {
    expect(parseConversationRepositoryEnv({ CONVERSATION_REPOSITORY: "in-memory" }).kind).toBe(
      "in-memory"
    );
    expect(parseConversationRepositoryEnv({ CONVERSATION_REPOSITORY: "postgres" }).kind).toBe(
      "postgres"
    );
    expect(parseConversationRepositoryEnv({ MEMORY_REPOSITORY: "memory" }).kind).toBe("in-memory");
    expect(parseConversationRepositoryEnv({ MEMORY_REPOSITORY: "in-memory" }).kind).toBe(
      "in-memory"
    );
    expect(parseConversationRepositoryEnv({ MEMORY_REPOSITORY: "postgres" }).kind).toBe("postgres");
    expect(
      parseConversationRepositoryEnv({
        CONVERSATION_REPOSITORY: "in-memory",
        MEMORY_REPOSITORY: "postgres"
      }).kind
    ).toBe("in-memory");
    expect(() => parseConversationRepositoryEnv({ CONVERSATION_REPOSITORY: "sqlite" })).toThrow(
      /Invalid CONVERSATION_REPOSITORY value 'sqlite'/
    );
  });

  it("does not close an injected shared Pool and closes owned Pools", async () => {
    const sharedEnd = vi.fn(async () => undefined);
    const sharedPool = {
      query: async () => ({ rows: [] }),
      end: sharedEnd
    } as unknown as Pool;
    const memoryRepository = new PostgresMemoryRepository(sharedPool);
    const conversationRepository = new PostgresConversationRepository(
      sharedPool as unknown as ConversationDatabaseClient
    );

    await conversationRepository.close();
    await memoryRepository.close();
    expect(sharedEnd).not.toHaveBeenCalled();

    const endSpy = vi.spyOn(Pool.prototype, "end").mockResolvedValue(undefined);
    await new PostgresMemoryRepository("postgres://localhost/yuvi").close();
    await new PostgresConversationRepository("postgres://localhost/yuvi").close();
    expect(endSpy).toHaveBeenCalledTimes(2);
    endSpy.mockRestore();
  });
});
