import { z } from "zod";

export const EventTypeSchema = z.enum([
  "user.message",
  "user.voice.transcript",
  "agent.reply",
  "avatar.speak",
  "assistant.message",
  "memory.retrieved",
  "tts.started",
  "perception.vision",
  "stt.completed",
  "vision.completed",
  "provider.error",
  "runtime.error"
]);

export type EventType = z.infer<typeof EventTypeSchema>;

export const RuntimeEventSchema = z.object({
  id: z.string().min(1),
  type: EventTypeSchema,
  timestamp: z.string().datetime(),
  traceId: z.string().min(1),
  parentId: z.string().min(1).optional(),
  payload: z.unknown()
});

export type RuntimeEvent<TType extends string = EventType, TPayload = unknown> = {
  id: string;
  type: TType;
  timestamp: string;
  traceId: string;
  parentId?: string | undefined;
  payload: TPayload;
};

export const UserMessagePayloadSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1)
});

export type UserMessagePayload = z.infer<typeof UserMessagePayloadSchema>;

export const UserMessageEventSchema = RuntimeEventSchema.extend({
  type: z.literal("user.message"),
  payload: UserMessagePayloadSchema
});

export type UserMessageEvent = RuntimeEvent<"user.message", UserMessagePayload>;

export const UserVoiceTranscriptPayloadSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
  language: z.string().optional(),
  confidence: z.number().optional()
});

export type UserVoiceTranscriptPayload = z.infer<typeof UserVoiceTranscriptPayloadSchema>;
export type UserVoiceTranscriptEvent = RuntimeEvent<
  "user.voice.transcript",
  UserVoiceTranscriptPayload
>;

export const AssistantMessagePayloadSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string()
});

export type AssistantMessagePayload = z.infer<typeof AssistantMessagePayloadSchema>;
export type AssistantMessageEvent = RuntimeEvent<"assistant.message", AssistantMessagePayload>;

export type AgentReplyEvent = RuntimeEvent<"agent.reply", AssistantMessagePayload>;

export type AvatarSpeakPayload = {
  sessionId: string;
  text: string;
  audioBase64?: string | undefined;
  mimeType: string;
  durationMs?: number | undefined;
};

export type AvatarSpeakEvent = RuntimeEvent<"avatar.speak", AvatarSpeakPayload>;

export type PerceptionVisionPayload = {
  sessionId: string;
  text: string;
  objects?: string[] | undefined;
  sceneSummary?: string | undefined;
  confidence?: number | undefined;
};

export type PerceptionVisionEvent = RuntimeEvent<"perception.vision", PerceptionVisionPayload>;

export type CreateEventOptions = {
  traceId?: string | undefined;
  parentId?: string | undefined;
};

export function createEvent<TType extends EventType, TPayload>(
  type: TType,
  payload: TPayload,
  options: CreateEventOptions = {}
): RuntimeEvent<TType, TPayload> {
  const id = crypto.randomUUID();

  return {
    id,
    type,
    timestamp: new Date().toISOString(),
    traceId: options.traceId ?? id,
    ...(options.parentId ? { parentId: options.parentId } : {}),
    payload
  };
}
