import type { MemoryCandidate, MemorySubtype } from "./types.js";

export const relativeTemporalPattern =
  /今早|今天早上|今天上午|今天|昨天|前天|刚才|刚刚|早上|中午|晚上|上周|这周|最近|\btoday\b|\byesterday\b|\bthis morning\b|\blast night\b|\brecently\b/iu;

export const absoluteDatePattern = /\d{4}-\d{2}-\d{2}|\d{4}年\d{1,2}月\d{1,2}日/gu;

export const standaloneDayPartPattern = /^(早上|上午|中午|下午|晚上|凌晨)$/u;

export type TemporalResolution = {
  relativeExpression: string;
  resolvedDate?: string;
  resolutionSource: "observedAt" | "timestamp" | "server-timezone";
  confidence: number;
  suggestedRewrite?: string;
  eventTimePeriod?: "morning" | "noon" | "evening" | "night" | "day";
};

export type TemporalNormalizationResult = {
  hasRelativeTemporalExpression: boolean;
  confidence: number;
  candidate: MemoryCandidate;
  temporalResolution?: TemporalResolution;
};

export function hasRelativeTemporalExpression(text: string): boolean {
  if (hasAbsoluteDateExpression(text)) {
    return hasUnresolvedRelativeTemporalExpression(text);
  }
  relativeTemporalPattern.lastIndex = 0;
  return relativeTemporalPattern.test(text);
}

export function hasAbsoluteDateExpression(text: string): boolean {
  absoluteDatePattern.lastIndex = 0;
  return absoluteDatePattern.test(text);
}

export function normalizeTemporalCandidate(
  candidate: MemoryCandidate,
  input: { timestamp?: Date | string | null; timezone?: string | null } = {}
): TemporalNormalizationResult {
  if (candidate.metadata?.["temporalNormalized"] === true) {
    return {
      hasRelativeTemporalExpression: Boolean(candidate.metadata?.["hasRelativeTemporalExpression"]),
      confidence: temporalResolutionConfidence(candidate.metadata) ?? 1,
      candidate
    };
  }

  const text = candidate.content.trim();
  const observedAt = toDate(candidate.observedAt) ?? toDate(input.timestamp) ?? new Date();
  const timezone = input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (hasAbsoluteDateExpression(text) && !hasUnresolvedRelativeTemporalExpression(text)) {
    const eventDate = extractCanonicalEventDate(text, observedAt, timezone);
    const dayPart = detectDayPart(text);
    const eventTime = eventDate ? eventTimeForDate(eventDate, dayPart, observedAt, timezone) : null;
    const validWindow = eventDate ? dayBoundaries(eventDate, timezone) : null;
    const next = finalizeTemporalCandidate(candidate, {
      content: canonicalizeAbsoluteDateContent(text, eventDate, dayPart),
      observedAt,
      eventTime,
      validFrom: validWindow?.validFrom ?? null,
      validUntil: validWindow?.validUntil ?? null,
      metadata: {
        ...(candidate.metadata ?? {}),
        temporalNormalized: true,
        hasRelativeTemporalExpression: false,
        canonicalEventDate: eventDate
      }
    });
    return { hasRelativeTemporalExpression: false, confidence: 1, candidate: next };
  }

  const expression = detectRelativeExpression(text);
  if (!expression) {
    return {
      hasRelativeTemporalExpression: false,
      confidence: 1,
      candidate: finalizeTemporalCandidate(candidate, {
        content: text,
        observedAt,
        metadata: {
          ...(candidate.metadata ?? {}),
          temporalNormalized: true,
          hasRelativeTemporalExpression: false
        }
      })
    };
  }

  const resolution = resolveTemporalExpression(expression, observedAt, timezone);
  const rewritten =
    resolution.confidence >= 0.7
      ? rewriteTemporalText(text, resolution, observedAt, timezone)
      : text;
  const isDailyEvent = isOrdinaryDailyEvent(text);
  const eventDate =
    resolution.resolvedDate ?? extractCanonicalEventDate(rewritten, observedAt, timezone);
  const eventTime = eventDate
    ? eventTimeForDate(
        eventDate,
        resolution.eventTimePeriod ?? detectDayPart(text),
        observedAt,
        timezone
      )
    : null;
  const validWindow = eventDate ? dayBoundaries(eventDate, timezone) : null;
  const metadata = {
    ...(candidate.metadata ?? {}),
    originalTemporalText: candidate.metadata?.["originalTemporalText"] ?? text,
    normalizedTemporalText: rewritten,
    temporalResolution: resolution,
    temporalNormalized: true,
    hasRelativeTemporalExpression: true,
    canonicalEventDate: eventDate
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
            mentionsExplicitRememberCandidate(candidate) ? 0.6 : 0.5
          ),
          tags: Array.from(new Set([...(candidate.tags ?? []), ...dailyEventTags(text)]))
        }
      : {}),
    content: rewritten,
    summary:
      candidate.summary &&
      candidate.summary !== text &&
      !hasAbsoluteDateExpression(candidate.summary)
        ? candidate.summary
        : rewritten,
    metadata,
    observedAt: candidate.observedAt ?? observedAt.toISOString(),
    ...(eventTime ? { eventTime: candidate.eventTime ?? eventTime.toISOString() } : {}),
    ...(validWindow
      ? {
          validFrom: validWindow.validFrom.toISOString(),
          validUntil: validWindow.validUntil.toISOString()
        }
      : {}),
    ...(candidate.expiresAt !== undefined ? { expiresAt: candidate.expiresAt } : {})
  };

  return {
    hasRelativeTemporalExpression: true,
    confidence: resolution.confidence,
    candidate: next,
    temporalResolution: resolution
  };
}

export function canonicalEventDate(candidate: MemoryCandidate): string | null {
  const metadataDate = candidate.metadata?.["canonicalEventDate"];
  if (typeof metadataDate === "string" && metadataDate.length > 0) {
    return metadataDate;
  }
  const observedAt = toDate(candidate.observedAt) ?? new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    extractCanonicalEventDate(candidate.content, observedAt, timezone) ??
    (candidate.eventTime ? toDateOnlyInTimezone(toDate(candidate.eventTime)!, timezone) : null) ??
    (candidate.validFrom ? toDateOnlyInTimezone(toDate(candidate.validFrom)!, timezone) : null)
  );
}

export function normalizeContentForFingerprint(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，,。！!？?.；;：:""''「」【】（）()]/gu, "")
    .replace(/\d{4}年(\d{1,2})月(\d{1,2})日/gu, (_, month: string, day: string) => {
      const year = content.match(/(\d{4})年/)?.[1] ?? "0000";
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    })
    .replace(/用户在/gu, "用户")
    .replace(/用户于/gu, "用户")
    .replace(/在(\d{4}-\d{2}-\d{2})+/gu, "$1")
    .replace(/(\d{4}-\d{2}-\d{2})(?:\1)+/gu, "$1")
    .replace(/未/gu, "没")
    .replace(/早餐/gu, "早饭")
    .replace(/没吃早饭/gu, "没吃早饭")
    .replace(/没早饭$/gu, "没吃早饭")
    .replace(/上午/gu, "早上")
    .replace(/没吃早饭饭/gu, "没吃早饭")
    .replace(/明确要求记住/gu, "");
}

export function isOrdinaryDailyEvent(text: string): boolean {
  return (
    hasRelativeTemporalExpression(text) &&
    /(吃|喝|去了|去|买了|看了|做了|喝了|饭|早饭|早餐|ate|drank|went|bought|watched|did|breakfast|meal)/iu.test(
      text
    ) &&
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

export type TemporalDebugStatus = "not-needed" | "normalized" | "unresolved";

export type TemporalDebugInfo = {
  temporalStatus: TemporalDebugStatus;
  temporalSuggestion?: string;
};

export function hasUnresolvedRelativeTime(input: string | MemoryCandidate): boolean {
  const text = typeof input === "string" ? input : input.content;
  const candidate = typeof input === "string" ? null : input;

  if (candidate?.metadata?.["temporalNormalized"] === true) {
    return hasUnresolvedRelativeTemporalExpression(text);
  }

  if (hasAbsoluteDateExpression(text) && !hasUnresolvedRelativeTemporalExpression(text)) {
    return false;
  }

  if (
    canonicalEventDate(
      candidate ?? { type: "episodic", content: text, importance: 0, tags: [], reason: "probe" }
    )
  ) {
    return hasUnresolvedRelativeTemporalExpression(text);
  }

  return (
    hasUnresolvedRelativeTemporalExpression(text) ||
    (!hasAbsoluteDateExpression(text) && hasRelativeTemporalExpression(text))
  );
}

export function resolveTemporalDebug(candidate: MemoryCandidate): TemporalDebugInfo {
  if (!hasUnresolvedRelativeTime(candidate)) {
    if (candidate.metadata?.["temporalNormalized"] === true || canonicalEventDate(candidate)) {
      return { temporalStatus: "normalized" };
    }
    return { temporalStatus: "not-needed" };
  }

  const suggestion = buildTemporalSuggestion(candidate.content);
  return {
    temporalStatus: "unresolved",
    ...(suggestion ? { temporalSuggestion: suggestion } : {})
  };
}

export function resolveTimezoneFromObservedAt(
  observedAt: Date | string | null | undefined,
  fallback?: string
): string {
  if (typeof observedAt === "string") {
    if (/\+08:00$/.test(observedAt) || /\+08:00:/.test(observedAt)) {
      return "Asia/Shanghai";
    }
    const offsetMatch = observedAt.match(/([+-]\d{2}:\d{2})$/u);
    if (offsetMatch?.[1] === "+08:00") {
      return "Asia/Shanghai";
    }
  }
  return fallback ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function resolveCanonicalTemporalBounds(
  candidate: MemoryCandidate,
  timezone?: string
): { validFrom: string; validUntil: string } | null {
  const eventDate = canonicalEventDate(candidate);
  if (!eventDate) {
    return null;
  }
  const tz = timezone ?? resolveTimezoneFromObservedAt(candidate.observedAt);
  const window = dayBoundaries(eventDate, tz);
  return {
    validFrom: window.validFrom.toISOString(),
    validUntil: window.validUntil.toISOString()
  };
}

export function canonicalEventKey(candidate: MemoryCandidate): string | null {
  const eventDate = canonicalEventDate(candidate);
  if (!eventDate) {
    return null;
  }
  const slot = detectDayPart(candidate.content) ?? "day";
  const topic = detectEventTopic(candidate.content);
  return [
    candidate.subjectUserId ?? candidate.metadata?.["subjectUserId"] ?? "default-user",
    candidate.personaId ?? candidate.metadata?.["personaId"] ?? "default-persona",
    candidate.scope ?? "user",
    candidate.scopeId ?? "",
    eventDate,
    slot,
    topic
  ].join("|");
}

export function temporalWarningForText(text: string): TemporalNormalizationResult | null {
  if (!hasUnresolvedRelativeTime(text)) {
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

export function buildTemporalSuggestion(text: string): string | null {
  const result = temporalWarningForText(text);
  return result?.candidate.content ?? null;
}

function hasUnresolvedRelativeTemporalExpression(text: string): boolean {
  return /今天|昨天|前天|今早|今天早上|今天上午|今晚|昨晚|刚才|刚刚|上周|这周|最近|\btoday\b|\byesterday\b|\bthis morning\b|\blast night\b|\brecently\b/iu.test(
    text
  );
}

function detectRelativeExpression(text: string): string | null {
  if (hasAbsoluteDateExpression(text) && !hasUnresolvedRelativeTemporalExpression(text)) {
    return null;
  }

  const prioritized = [
    "今天早上",
    "今天上午",
    "今早",
    "今天早上",
    "昨晚",
    "今天",
    "昨天",
    "前天",
    "刚才",
    "刚刚",
    "上周",
    "这周",
    "最近",
    "this morning",
    "last night",
    "today",
    "yesterday",
    "recently",
    "早上",
    "中午",
    "晚上"
  ];

  for (const expression of prioritized) {
    if (text.includes(expression)) {
      if (
        hasAbsoluteDateExpression(text) &&
        standaloneDayPartPattern.test(expression) &&
        !hasUnresolvedRelativeTemporalExpression(text)
      ) {
        continue;
      }
      return expression;
    }
  }

  relativeTemporalPattern.lastIndex = 0;
  const match = text.match(relativeTemporalPattern);
  return match?.[0] ?? null;
}

function resolveTemporalExpression(
  expression: string,
  observedAt: Date,
  timezone: string
): TemporalResolution {
  const lower = expression.toLowerCase();
  let date = observedAt;
  let confidence = 0.85;
  let eventTimePeriod: TemporalResolution["eventTimePeriod"];

  if (/今早|今天早上|今天上午|this morning|早上|上午/u.test(expression)) {
    eventTimePeriod = "morning";
  } else if (/中午/u.test(expression)) {
    eventTimePeriod = "noon";
  } else if (/晚上|昨晚|last night/u.test(expression)) {
    eventTimePeriod = /昨晚|last night/u.test(expression) ? "night" : "evening";
  }

  if (expression === "昨天" || lower === "yesterday" || lower === "last night") {
    date = addDaysInTimezone(observedAt, -1, timezone);
  } else if (expression === "前天") {
    date = addDaysInTimezone(observedAt, -2, timezone);
  } else if (expression === "上周") {
    date = addDaysInTimezone(observedAt, -7, timezone);
    confidence = 0.65;
  } else if (expression === "最近" || lower === "recently" || expression === "这周") {
    confidence = 0.55;
  }

  const resolvedDate = confidence >= 0.65 ? toDateOnlyInTimezone(date, timezone) : undefined;
  return {
    relativeExpression: expression,
    ...(resolvedDate ? { resolvedDate } : {}),
    resolutionSource: "observedAt",
    confidence,
    ...(eventTimePeriod ? { eventTimePeriod } : {}),
    ...(resolvedDate
      ? { suggestedRewrite: absoluteTimePhrase(expression, resolvedDate, eventTimePeriod) }
      : {})
  };
}

function rewriteTemporalText(
  text: string,
  resolution: TemporalResolution,
  observedAt: Date,
  timezone: string
): string {
  if (!resolution.resolvedDate) {
    return text;
  }
  const phrase = absoluteTimePhrase(
    resolution.relativeExpression,
    resolution.resolvedDate,
    resolution.eventTimePeriod
  );
  const stripped = text
    .replace(
      /^(?:请记住|记住|帮我记住|帮我记一下|记一下|please\s+remember|remember\s+that|remember|don't\s+forget|make\s+a\s+note)\s*[:：,，-]?\s*/iu,
      ""
    )
    .replace(resolution.relativeExpression, phrase)
    .replace(/^我/u, "用户");
  return canonicalizeAbsoluteDateContent(
    stripped,
    resolution.resolvedDate,
    resolution.eventTimePeriod,
    {
      observedAt,
      timezone
    }
  );
}

function canonicalizeAbsoluteDateContent(
  text: string,
  eventDate: string | null,
  dayPart?: TemporalResolution["eventTimePeriod"],
  context?: { observedAt: Date; timezone: string }
): string {
  let content = text.trim();
  content = content.replace(/\d{4}年\d{1,2}月\d{1,2}日/gu, (match) => {
    const parts = match.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/u);
    if (!parts) return match;
    return `${parts[1]}-${parts[2]!.padStart(2, "0")}-${parts[3]!.padStart(2, "0")}`;
  });
  content = content.replace(/在\s*(\d{4}-\d{2}-\d{2})\s*在\s*\1/gu, "在 $1");
  content = content.replace(/(\d{4}-\d{2}-\d{2})\s*[（(]\s*\1\s*[）)]/gu, "$1");
  content = content.replace(/(\d{4}-\d{2}-\d{2})(?:\s*[（(]\s*\1\s*[）)])+/gu, "$1");

  const date =
    eventDate ??
    (context ? extractCanonicalEventDate(content, context.observedAt, context.timezone) : null);
  if (date) {
    const period = dayPartLabel(dayPart ?? detectDayPart(content));
    const canonicalPrefix = period ? `用户在 ${date} ${period}` : `用户在 ${date}`;
    if (/^用户/u.test(content) && content.includes(date)) {
      content = content
        .replace(/^用户在\s*/u, "")
        .replace(new RegExp(`(?:在\\s*)?${date}(?:\\s*[（(]\\s*${date}\\s*[）)])?`, "gu"), "")
        .replace(/^(?:在\s*)?(?:早上|上午|中午|下午|晚上|凌晨)\s*/u, "")
        .trim();
      content = `${canonicalPrefix}${content ? content : "。"}`;
    }
  }

  return content.trim().replace(/[。.!！]?$/u, "。");
}

function absoluteTimePhrase(
  expression: string,
  date: string,
  dayPart?: TemporalResolution["eventTimePeriod"]
): string {
  const period = dayPart ?? detectDayPart(expression);
  if (period) {
    return `在 ${date} ${dayPartLabel(period)}`;
  }
  return `在 ${date}`;
}

function detectDayPart(text: string): TemporalResolution["eventTimePeriod"] | undefined {
  if (/今早|今天早上|今天上午|早上|上午|this morning/iu.test(text)) return "morning";
  if (/中午/iu.test(text)) return "noon";
  if (/晚上|今晚/iu.test(text)) return "evening";
  if (/昨晚|last night|凌晨/iu.test(text)) return "night";
  return undefined;
}

function dayPartLabel(dayPart: TemporalResolution["eventTimePeriod"]): string {
  switch (dayPart) {
    case "morning":
      return "早上";
    case "noon":
      return "中午";
    case "evening":
      return "晚上";
    case "night":
      return "晚上";
    default:
      return "";
  }
}

function eventTimeForDate(
  eventDate: string,
  dayPart: TemporalResolution["eventTimePeriod"] | undefined,
  observedAt: Date,
  timezone: string
): Date {
  const hour =
    dayPart === "morning"
      ? 8
      : dayPart === "noon"
        ? 12
        : dayPart === "evening" || dayPart === "night"
          ? 20
          : getLocalHour(observedAt, timezone);
  return zonedDateTime(eventDate, hour, 0, 0, timezone);
}

function dayBoundaries(eventDate: string, timezone: string): { validFrom: Date; validUntil: Date } {
  return {
    validFrom: zonedDateTime(eventDate, 0, 0, 0, timezone),
    validUntil: zonedDateTime(eventDate, 0, 0, 0, timezone, 1)
  };
}

function extractCanonicalEventDate(
  text: string,
  observedAt: Date,
  timezone: string
): string | null {
  const iso = text.match(/(\d{4}-\d{2}-\d{2})/u)?.[1];
  if (iso) {
    return iso;
  }
  const chinese = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/u);
  if (chinese) {
    return `${chinese[1]}-${chinese[2]!.padStart(2, "0")}-${chinese[3]!.padStart(2, "0")}`;
  }
  if (hasUnresolvedRelativeTemporalExpression(text)) {
    return toDateOnlyInTimezone(observedAt, timezone);
  }
  return null;
}

function detectEventTopic(text: string): string {
  if (/吃|喝|饭|早饭|早餐|面包|蛋糕|meal|breakfast|bread|ate|drank/iu.test(text)) {
    return "meal";
  }
  if (/喝|水|茶|coffee|tea|drink/iu.test(text)) {
    return "drink";
  }
  return "activity";
}

function finalizeTemporalCandidate(
  candidate: MemoryCandidate,
  input: {
    content: string;
    observedAt: Date;
    eventTime?: Date | null;
    validFrom?: Date | string | null;
    validUntil?: Date | string | null;
    metadata: Record<string, unknown>;
  }
): MemoryCandidate {
  return {
    ...candidate,
    content: input.content,
    summary:
      candidate.summary &&
      candidate.summary !== candidate.content &&
      !hasAbsoluteDateExpression(candidate.summary)
        ? candidate.summary
        : input.content,
    observedAt: candidate.observedAt ?? input.observedAt.toISOString(),
    ...(input.eventTime ? { eventTime: input.eventTime.toISOString() } : {}),
    ...(input.validFrom ? { validFrom: toIso(input.validFrom) } : {}),
    ...(input.validUntil ? { validUntil: toIso(input.validUntil) } : {}),
    metadata: input.metadata
  };
}

function mentionsExplicitRememberCandidate(candidate: MemoryCandidate): boolean {
  return Boolean(
    candidate.explicitRememberRequested ||
    candidate.reason === "explicit-remember" ||
    candidate.metadata?.["explicitRemember"] === true ||
    candidate.metadata?.["explicitRememberRequested"] === true
  );
}

function temporalResolutionConfidence(
  metadata: Record<string, unknown> | undefined
): number | null {
  const value = metadata?.["temporalResolution"];
  if (!value || typeof value !== "object") {
    return null;
  }
  const confidence = (value as TemporalResolution).confidence;
  return typeof confidence === "number" ? confidence : null;
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

function zonedDateTime(
  dateOnly: string,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
  dayOffset = 0
): Date {
  const [year, month, day] = dateOnly.split("-").map(Number);
  if (!year || !month || !day) {
    return new Date();
  }
  const utcGuess = new Date(Date.UTC(year, month - 1, day + dayOffset, hour, minute, second));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(utcGuess).map((part) => [part.type, part.value])
  );
  const actual = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"])
  );
  const desired = Date.UTC(year, month - 1, day + dayOffset, hour, minute, second);
  return new Date(utcGuess.getTime() + (desired - actual));
}

function toDateOnlyInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date);
}

function getLocalHour(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23"
  });
  return Number(formatter.format(date));
}

function addDaysInTimezone(date: Date, days: number, timezone: string): Date {
  const base = toDateOnlyInTimezone(date, timezone);
  const [year, month, day] = base.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days, 12, 0, 0));
  return shifted;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
