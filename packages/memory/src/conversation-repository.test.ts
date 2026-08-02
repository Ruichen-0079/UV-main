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

  it("appends streaming content atomically and enforces terminal transitions in memory", async () => {
    const repository = new InMemoryConversationRepository();
    await repository.appendMessage({
      ...message("stream", "session-a", "assistant", "hel"),
      status: "streaming",
      completedAt: null
    });

    await repository.appendMessageContent("stream", "lo");
    expect((await repository.listRecentMessages("session-a"))[0]).toMatchObject({
      content: "hello",
      status: "streaming",
      completedAt: null
    });

    await repository.completeMessage("stream", { provider: "mock" });
    await repository.completeMessage("stream", { ignored: true });
    expect((await repository.listRecentMessages("session-a"))[0]).toMatchObject({
      content: "hello",
      status: "completed",
      metadata: { provider: "mock" }
    });
    await expect(repository.appendMessageContent("stream", "!")).rejects.toThrow(
      /cannot append content in status 'completed'/
    );
    await expect(repository.failMessage("stream", "failed")).rejects.toThrow(
      /cannot transition from 'completed'/
    );
    await expect(repository.appendMessageContent("missing", "x")).rejects.toThrow(
      /message 'missing' was not found/
    );
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

  it("uses parameterized atomic SQL for streaming updates", async () => {
    const row: Record<string, unknown> = {
      id: "stream",
      session_id: "session-a",
      trace_id: "trace-stream",
      parent_message_id: "agent-reply",
      role: "assistant",
      content: "hel",
      status: "streaming",
      created_at: "2026-01-01T00:00:00Z",
      completed_at: null,
      metadata: {},
      sequence: 1
    };
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      async query(sql: string, values: unknown[] = []) {
        queries.push({ sql, values });
        if (sql.includes("update conversation_messages") && sql.includes("content = content ||")) {
          row["content"] = `${row["content"]}${values[1]}`;
          return { rows: [row] };
        }
        if (sql.includes("update conversation_messages") && sql.includes("status = 'completed'")) {
          row["status"] = "completed";
          row["completed_at"] = "2026-01-01T00:00:01Z";
          row["metadata"] = { provider: "mock" };
          return { rows: [row] };
        }
        if (sql.includes("insert into conversation_messages")) {
          return { rows: [row] };
        }
        if (sql.includes("select * from conversation_messages where id")) {
          return { rows: [row] };
        }
        return { rows: [] };
      },
      async end() {}
    };
    const repository = new PostgresConversationRepository(client);

    await repository.appendMessage({
      ...message("stream", "session-a", "assistant", "hel"),
      status: "streaming",
      completedAt: null
    });
    await repository.appendMessageContent("stream", "lo");
    await repository.completeMessage("stream", { provider: "mock" });

    const appendQuery = queries.find((query) => query.sql.includes("content = content ||"));
    expect(appendQuery?.sql).toMatch(/where id = \$1 and status = 'streaming'/);
    expect(appendQuery?.values).toEqual(["stream", "lo"]);
    expect(appendQuery?.sql).not.toMatch(/select content/i);
    const completeQuery = queries.find((query) => query.sql.includes("status = 'completed'"));
    expect(completeQuery?.sql).toContain("metadata = metadata || $2::jsonb");
    expect(completeQuery?.values).toEqual(["stream", JSON.stringify({ provider: "mock" })]);
  });

  it("does not treat zero-row streaming updates as successful", async () => {
    const rows: Record<string, unknown>[] = [
      {
        id: "completed",
        session_id: "session-a",
        trace_id: "trace-completed",
        parent_message_id: null,
        role: "assistant",
        content: "done",
        status: "completed",
        created_at: "2026-01-01T00:00:00Z",
        completed_at: "2026-01-01T00:00:01Z",
        metadata: {},
        sequence: 1
      },
      {
        id: "streaming",
        session_id: "session-a",
        trace_id: "trace-streaming",
        parent_message_id: null,
        role: "assistant",
        content: "partial",
        status: "streaming",
        created_at: "2026-01-01T00:00:00Z",
        completed_at: null,
        metadata: {},
        sequence: 2
      }
    ];
    const updates: string[] = [];
    const client = {
      async query(sql: string, values: unknown[] = []) {
        if (sql.trimStart().startsWith("update conversation_messages")) {
          updates.push(sql);
          return { rows: [] };
        }
        if (sql.includes("select * from conversation_messages where id")) {
          return { rows: rows.filter((row) => row["id"] === values[0]) };
        }
        return { rows: [] };
      },
      async end() {}
    };
    const repository = new PostgresConversationRepository(client);

    await expect(repository.appendMessageContent("completed", "!")).rejects.toThrow(
      /cannot append content in status 'completed'/
    );
    await expect(repository.completeMessage("completed")).resolves.toMatchObject({
      id: "completed",
      status: "completed"
    });
    await expect(repository.failMessage("completed", "cancelled")).rejects.toThrow(
      /cannot transition from 'completed'/
    );
    await expect(repository.failMessage("streaming", "failed")).rejects.toThrow(
      /update affected no rows while status is 'streaming'/
    );
    await expect(repository.appendMessageContent("streaming", "!")).rejects.toThrow(
      /update affected no rows while status is 'streaming'/
    );
    await expect(repository.completeMessage("streaming")).rejects.toThrow(
      /update affected no rows while status is 'streaming'/
    );
    await expect(repository.appendMessageContent("missing", "x")).rejects.toThrow(
      /was not found/
    );
    expect(updates).toHaveLength(7);
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
