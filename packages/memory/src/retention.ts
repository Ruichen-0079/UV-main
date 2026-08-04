import type { MemoryCandidate, MemorySubtype } from "./types.js";

export type RetentionPolicy = {
  retentionClass: string;
  retentionReason: string;
  expiresAt?: Date | null;
  validUntil?: Date | null;
};

const oneDayMs = 86_400_000;

export function computeRetentionPolicy(input: {
  candidate: MemoryCandidate;
  source?: string;
  now?: Date;
}): RetentionPolicy {
  const now = input.now ?? toDate(input.candidate.observedAt) ?? new Date();
  const explicitRemember =
    input.candidate.explicitRememberRequested ||
    input.candidate.metadata?.["explicitRememberRequested"] === true ||
    input.candidate.reason === "explicit-remember" ||
    input.candidate.metadata?.["explicitRemember"] === true;
  const source = input.source ?? "";
  const subtype = input.candidate.subtype ?? undefined;
  const importance = input.candidate.importance;

  if (isTestMemory(input.candidate, source)) {
    return {
      retentionClass: "test-short",
      retentionReason: "smoke/mock/test memory expires within 1 day",
      expiresAt: addDays(now, 1)
    };
  }

  if (input.candidate.type === "working" || input.candidate.memoryLayer === "working") {
    return {
      retentionClass: "working-short",
      retentionReason: "working/session memory is short-lived",
      expiresAt: addHours(now, 24)
    };
  }

  if (
    input.candidate.type === "episodic" &&
    subtype === "event" &&
    (explicitRemember || input.source === "manual" || input.source === "dashboard")
  ) {
    return {
      retentionClass: "episodic-daily",
      retentionReason: explicitRemember
        ? "explicitly requested short-lived episodic event"
        : "explicitly stored ordinary episodic event expires after 7 days",
      expiresAt: addDays(now, 7)
    };
  }

  if (isDurableNoExpiry(subtype, importance)) {
    return {
      retentionClass: "durable-core",
      retentionReason:
        "high-importance durable identity/preference/core memory has no default expiry",
      expiresAt: null
    };
  }

  if (subtype === "identity" || subtype === "preference") {
    return {
      retentionClass: "durable-user",
      retentionReason: "stable identity/preference memory is retained long-term",
      expiresAt: importance >= 0.75 ? null : addDays(now, 365)
    };
  }

  if (
    subtype === "project" ||
    subtype === "project-fact" ||
    subtype === "provider-choice" ||
    subtype === "config" ||
    subtype === "config-decision" ||
    subtype === "workflow" ||
    subtype === "command"
  ) {
    return {
      retentionClass: "project-operational",
      retentionReason: "project/config/workflow memory uses medium-long retention",
      expiresAt: importance >= 0.85 ? null : addDays(now, importance >= 0.75 ? 365 : 180)
    };
  }

  if (subtype === "troubleshooting") {
    return {
      retentionClass: "troubleshooting",
      retentionReason: "troubleshooting conclusions are retained for 90-180 days",
      expiresAt: addDays(now, importance >= 0.75 ? 180 : 90)
    };
  }

  if (input.candidate.type === "emotional" || subtype === "emotional-pattern") {
    return {
      retentionClass: "emotional-pattern",
      retentionReason: "durable emotional patterns use bounded retention",
      expiresAt: addDays(now, importance >= 0.75 ? 365 : 90)
    };
  }

  if (subtype === "relationship") {
    return {
      retentionClass: "relationship",
      retentionReason: "explicit relationship memories use long bounded retention",
      expiresAt: importance >= 0.9 ? null : addDays(now, 365)
    };
  }

  if (subtype === "health-note") {
    return {
      retentionClass: "health-safety",
      retentionReason: "explicit health/safety notes avoid short TTL",
      expiresAt: null
    };
  }

  if (subtype === "schedule") {
    const validUntil = toDate(input.candidate.validUntil) ?? toDate(input.candidate.eventTime);
    return {
      retentionClass: "schedule",
      retentionReason: "schedule memory expires after deadline plus buffer",
      expiresAt: validUntil ? addDays(validUntil, 3) : addDays(now, 30)
    };
  }

  return {
    retentionClass: importance >= 0.75 ? "general-medium" : "general-short",
    retentionReason: "general memory retention scaled by importance",
    expiresAt: addDays(now, importance >= 0.75 ? 180 : 30)
  };
}

function isDurableNoExpiry(subtype: MemorySubtype | undefined, importance: number): boolean {
  return (
    importance >= 0.9 &&
    (subtype === "identity" ||
      subtype === "preference" ||
      subtype === "provider-choice" ||
      subtype === "project-fact" ||
      subtype === "health-note")
  );
}

function isTestMemory(candidate: MemoryCandidate, source: string): boolean {
  return (
    source === "smoke" ||
    source === "test" ||
    source === "mock" ||
    candidate.subtype === "test" ||
    candidate.metadata?.["testMemory"] === true ||
    candidate.tags.some((tag) => ["smoke", "test", "mock"].includes(tag))
  );
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * oneDayMs);
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
