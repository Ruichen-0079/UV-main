import type { MemoryCandidate, MemorySubtype } from "./types.js";

export const relativeTemporalPattern =
  /今早|今天|昨天|前天|刚才|刚刚|早上|中午|晚上|上周|这周|最近|\btoday\b|\byesterday\b|\bthis morning\b|\blast night\b|\brecently\b/iu;

export type TemporalResolution = {
  relativeExpression: string;
  resolvedDate?: string;
  resolutionSource: "observedAt" | "timestamp" | "server-timezone";
  confidence: number;
  suggestedRewrite?: string;
};

export type TemporalNormalizationResult = {
  hasRelativeTemporalExpression: boolean;
  confidence: number;
  candidate: MemoryCandidate;
  temporalResolution?: TemporalResolution;
};

export function hasRelativeTemporalExpression(text: string): boolean {
  relativeTemporalPattern.lastIndex = 0;
  return relativeTemporalPattern.test(text);
}

export function normalizeTemporalCandidate(
  candidate: MemoryCandidate,
  input: { timestamp?: Date | string | null; timezone?: string | null } = {}
): TemporalNormalizationResult {
  const text = candidate.content.trim();
  const expression = detectRelativeExpression(text);
  if (!expression) {
    return { hasRelativeTemporalExpression: false, confidence: 1, candidate };
  }

  const observedAt = toDate(candidate.observedAt) ?? toDate(input.timestamp) ?? new Date();
  const timezone = input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const resolution = resolveTemporalExpression(expression, observedAt, timezone);
  const rewritten = resolution.confidence >= 0.7 ? rewriteTemporalText(text, resolution) : text;
  const isDailyEvent = isOrdinaryDailyEvent(text);
  const eventTime = resolution.resolvedDate ? eventTimeForResolution(resolution, observedAt) : null;
  const validFrom = eventTime ?? observedAt;
  const validUntil = eventTime ? endOfLocalDay(eventTime) : null;
  const expiresAt = addDays(observedAt, 7);
  const metadata = {
    ...(candidate.metadata ?? {}),
    originalTemporalText: text,
    normalizedTemporalText: rewritten,
    temporalResolution: resolution
  };

  const next: MemoryCandidate = {
    ...candidate,
    ...(isDailyEvent
      ? {
          type: "episodic" as const,
          subtype: "event" as MemorySubtype,
          memoryLayer: "recall" as const,
          importance: Math.min(
            candidate.importance,
            mentionsExplicitRememberReason(candidate) ? 0.6 : 0.5
          ),
          tags: Array.from(new Set([...candidate.tags, ...dailyEventTags(text)]))
        }
      : {}),
    content: rewritten,
    summary: candidate.summary && candidate.summary !== text ? candidate.summary : rewritten,
    metadata,
    observedAt: candidate.observedAt ?? observedAt.toISOString(),
    ...(eventTime ? { eventTime: eventTime.toISOString() } : {}),
    validFrom: candidate.validFrom ?? validFrom.toISOString(),
    ...(validUntil ? { validUntil: candidate.validUntil ?? validUntil.toISOString() } : {}),
    expiresAt: candidate.expiresAt ?? expiresAt.toISOString()
  };

  return {
    hasRelativeTemporalExpression: true,
    confidence: resolution.confidence,
    candidate: next,
    temporalResolution: resolution
  };
}

export function isOrdinaryDailyEvent(text: string): boolean {
  return (
    hasRelativeTemporalExpression(text) &&
    /(吃|喝|去了|去|买了|看了|做了|喝了|ate|drank|went|bought|watched|did)/iu.test(text) &&
    !isDurableTemporalText(text)
  );
}

export function isDurableTemporalText(text: string): boolean {
  return /(喜欢|不吃|过敏|以后|默认|偏好|日程|提醒|计划|deadline|schedule|allergy|prefer|from now on|remember to)/iu.test(
    text
  );
}

export function hasHistoricalEpisodicIntent(text: string | undefined): boolean {
  if (!text) return false;
  return /(我那天|那天|之前|以前|过去|历史|吃过什么|做过什么|\bhistory\b|\bpreviously\b|\bbefore\b|\bwhat did I\b)/iu.test(
    text
  );
}

export function temporalWarningForText(text: string): TemporalNormalizationResult | null {
  if (!hasRelativeTemporalExpression(text)) {
    return null;
  }
  return normalizeTemporalCandidate(
    {
      type: "episodic",
      subtype: "event",
      content: text,
      importance: 0.4,
      tags: [],
      reason: "manual-temporal-warning"
    },
    {}
  );
}

function detectRelativeExpression(text: string): string | null {
  const match = text.match(relativeTemporalPattern);
  return match?.[0] ?? null;
}

function resolveTemporalExpression(
  expression: string,
  observedAt: Date,
  _timezone: string
): TemporalResolution {
  const base = new Date(observedAt);
  const lower = expression.toLowerCase();
  let date = new Date(base);
  let confidence = 0.85;

  if (expression === "昨天" || lower === "yesterday" || lower === "last night") {
    date = addDays(base, -1);
  } else if (expression === "前天") {
    date = addDays(base, -2);
  } else if (expression === "上周") {
    date = addDays(base, -7);
    confidence = 0.65;
  } else if (expression === "最近" || lower === "recently" || expression === "这周") {
    confidence = 0.55;
  }

  const resolvedDate = confidence >= 0.65 ? toDateOnly(date) : undefined;
  return {
    relativeExpression: expression,
    ...(resolvedDate ? { resolvedDate } : {}),
    resolutionSource: "observedAt",
    confidence,
    ...(resolvedDate ? { suggestedRewrite: absoluteTimePhrase(expression, resolvedDate) } : {})
  };
}

function rewriteTemporalText(text: string, resolution: TemporalResolution): string {
  if (!resolution.resolvedDate) {
    return text;
  }
  const phrase = absoluteTimePhrase(resolution.relativeExpression, resolution.resolvedDate);
  return text
    .replace(/^(记住|请记住|remember|note this|for future)\s*[:：,-]?\s*/iu, "")
    .replace(resolution.relativeExpression, phrase)
    .replace(/^我/u, "用户")
    .trim()
    .replace(/[。.!！]?$/u, "。");
}

function absoluteTimePhrase(expression: string, date: string): string {
  if (/今早|早上|this morning/iu.test(expression)) return `在 ${date} 早上`;
  if (/中午/iu.test(expression)) return `在 ${date} 中午`;
  if (/晚上|last night/iu.test(expression)) return `在 ${date} 晚上`;
  if (/刚才|刚刚/iu.test(expression)) return `在 ${date}`;
  return `在 ${date}`;
}

function eventTimeForResolution(resolution: TemporalResolution, observedAt: Date): Date | null {
  if (!resolution.resolvedDate) return null;
  const [year, month, day] = resolution.resolvedDate.split("-").map(Number);
  if (!year || !month || !day) return null;
  const hour = /早上|今早|this morning/iu.test(resolution.relativeExpression)
    ? 8
    : /中午/iu.test(resolution.relativeExpression)
      ? 12
      : /晚上|last night/iu.test(resolution.relativeExpression)
        ? 20
        : observedAt.getHours();
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
}

function endOfLocalDay(date: Date): Date {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dailyEventTags(text: string): string[] {
  const tags = ["event"];
  if (/吃|喝|饭|早餐|午餐|晚餐|蛋糕|奶茶|ate|drank|meal|breakfast|lunch|dinner/iu.test(text)) {
    tags.push("meal");
  } else {
    tags.push("activity");
  }
  return tags;
}

function mentionsExplicitRememberReason(candidate: MemoryCandidate): boolean {
  return (
    candidate.reason === "explicit-remember" || candidate.metadata?.["explicitRemember"] === true
  );
}
