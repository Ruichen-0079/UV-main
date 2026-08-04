export type MessageStreamTextDelta = {
  type: "text-delta";
  text: string;
  messageId: string;
  sessionId: string;
  traceId: string;
};

export type MessageStreamCompleted = {
  type: "completed";
  content: string;
  messageId: string;
  sessionId: string;
  traceId: string;
  provider: string;
};

export type MessageStreamErrorEvent = {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
  traceId?: string;
};

export type MessageStreamEvent =
  | MessageStreamTextDelta
  | MessageStreamCompleted
  | MessageStreamErrorEvent;

export type CompletedMessage = MessageStreamCompleted;

export class MessageStreamProtocolError extends Error {
  constructor(message = "The message stream protocol is invalid.") {
    super(message);
    this.name = "MessageStreamProtocolError";
  }
}

export class MessageStreamError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly traceId: string | undefined;

  constructor(event: MessageStreamErrorEvent) {
    super(safeStreamErrorMessage(event.code));
    this.name = "MessageStreamError";
    this.code = event.code;
    this.retryable = event.retryable;
    this.traceId = event.traceId;
  }
}

type ParsedFrame = {
  event: string;
  data: unknown;
};

export class MessageSseParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private completedSeen = false;
  private errorSeen = false;

  push(chunk: Uint8Array): MessageStreamEvent[] {
    this.buffer += this.decode(chunk, true);
    const events: MessageStreamEvent[] = [];

    while (true) {
      const boundary = findFrameBoundary(this.buffer);
      if (!boundary) {
        break;
      }

      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      if (frame.trim() === "") {
        continue;
      }
      events.push(this.parseFrame(frame));
    }

    return events;
  }

  finish(): void {
    this.buffer += this.decode();
    if (this.buffer.trim() !== "") {
      throw new MessageStreamProtocolError("The message stream ended with an incomplete frame.");
    }
    if (!this.completedSeen && !this.errorSeen) {
      throw new MessageStreamProtocolError("The message stream ended before completion.");
    }
  }

  private parseFrame(frame: string): MessageStreamEvent {
    const parsed = parseFrameFields(frame);
    if (this.completedSeen || this.errorSeen) {
      throw new MessageStreamProtocolError("The message stream continued after its terminal event.");
    }

    const event = parseMessageStreamEvent(parsed);
    if (event.type === "completed") {
      this.completedSeen = true;
    }
    if (event.type === "error") {
      this.errorSeen = true;
    }
    return event;
  }

  private decode(chunk?: Uint8Array, stream = false): string {
    try {
      return this.decoder.decode(chunk, { stream });
    } catch {
      throw new MessageStreamProtocolError("The message stream contains invalid UTF-8.");
    }
  }
}

function findFrameBoundary(buffer: string): { index: number; length: number } | null {
  const separators = ["\r\n\r\n", "\n\n", "\r\r"];
  let match: { index: number; length: number } | null = null;
  for (const separator of separators) {
    const index = buffer.indexOf(separator);
    if (index >= 0 && (match === null || index < match.index)) {
      match = { index, length: separator.length };
    }
  }
  return match;
}

function parseFrameFields(frame: string): ParsedFrame {
  let eventName: string | undefined;
  let data: string | undefined;
  const lines = frame.split(/\r\n|\n|\r/);

  for (const line of lines) {
    if (line === "") {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      throw new MessageStreamProtocolError("The message stream contains an invalid field.");
    }
    const field = line.slice(0, separator);
    const rawValue = line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") {
      if (eventName !== undefined) {
        throw new MessageStreamProtocolError("The message stream contains duplicate event fields.");
      }
      eventName = value;
    } else if (field === "data") {
      if (data !== undefined) {
        throw new MessageStreamProtocolError("The message stream contains duplicate data fields.");
      }
      data = value;
    } else {
      throw new MessageStreamProtocolError("The message stream contains an unsupported field.");
    }
  }

  if (!eventName || data === undefined) {
    throw new MessageStreamProtocolError("The message stream frame is missing event or data.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new MessageStreamProtocolError("The message stream contains malformed JSON.");
  }
  return { event: eventName, data: parsed };
}

function parseMessageStreamEvent(frame: ParsedFrame): MessageStreamEvent {
  if (!isRecord(frame.data)) {
    throw new MessageStreamProtocolError("The message stream data must be an object.");
  }
  if (frame.event !== "text-delta" && frame.event !== "completed" && frame.event !== "error") {
    throw new MessageStreamProtocolError("The message stream contains an unknown event.");
  }
  if (frame.data["type"] !== frame.event) {
    throw new MessageStreamProtocolError("The message stream event type does not match its frame.");
  }

  if (frame.event === "text-delta") {
    if (
      typeof frame.data["text"] !== "string" ||
      frame.data["text"].length === 0 ||
      !hasMessageIdentity(frame.data)
    ) {
      throw new MessageStreamProtocolError("The message stream text delta is invalid.");
    }
    return frame.data as unknown as MessageStreamTextDelta;
  }

  if (frame.event === "completed") {
    if (
      typeof frame.data["content"] !== "string" ||
      typeof frame.data["provider"] !== "string" ||
      frame.data["provider"].length === 0 ||
      !hasMessageIdentity(frame.data)
    ) {
      throw new MessageStreamProtocolError("The message stream completion is invalid.");
    }
    return frame.data as unknown as MessageStreamCompleted;
  }

  if (
    typeof frame.data["code"] !== "string" ||
    typeof frame.data["message"] !== "string" ||
    typeof frame.data["retryable"] !== "boolean" ||
    (frame.data["traceId"] !== undefined && typeof frame.data["traceId"] !== "string")
  ) {
    throw new MessageStreamProtocolError("The message stream error is invalid.");
  }
  return frame.data as unknown as MessageStreamErrorEvent;
}

function hasMessageIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value["messageId"] === "string" &&
    value["messageId"].length > 0 &&
    typeof value["sessionId"] === "string" &&
    value["sessionId"].length > 0 &&
    typeof value["traceId"] === "string" &&
    value["traceId"].length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStreamErrorMessage(code: string): string {
  switch (code) {
    case "PERSISTENCE_FAILED":
      return "消息保存失败，请稍后重试。";
    case "MISSING_API_KEY":
    case "INVALID_API_KEY":
    case "PERMISSION_DENIED":
      return "Provider 认证失败。";
    case "RATE_LIMITED":
      return "Provider 请求过于频繁。";
    case "TIMEOUT":
      return "Provider 请求超时。";
    case "CANCELLED":
      return "生成已取消。";
    case "PROVIDER_UNAVAILABLE":
      return "Provider 当前不可用。";
    case "INTERNAL":
      return "消息流处理失败。";
    default:
      return "消息流处理失败。";
  }
}
