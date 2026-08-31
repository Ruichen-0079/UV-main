import type { RecentEpisode } from "./recent-episode.js";

export const THIN_TEMPORAL_PROJECTION_VERSION = "memory-vnext-temporal.v1" as const;

export const TemporalAgeBands = [
  "just-now",
  "minutes-ago",
  "hours-ago",
  "earlier-today",
  "yesterday",
  "this-week",
  "older",
  "unknown"
] as const;
export type TemporalAgeBand = (typeof TemporalAgeBands)[number];

export type ThinTemporalEvidenceStamp = {
  id: string;
  occurredAt?: string | null | undefined;
  recordedAt?: string | null | undefined;
  temporalConfidence?: "high" | "medium" | "low" | "unknown" | undefined;
};

export type ThinTemporalProjectionInput = {
  now: Date;
  timezone?: string | undefined;
  lastInteractionAt?: string | Date | null | undefined;
  episodes?: readonly RecentEpisode[] | undefined;
  evidence?: readonly ThinTemporalEvidenceStamp[] | undefined;
};

export type ThinTemporalEpisodePosition = {
  episodeId: string;
  ageBand: TemporalAgeBand;
  occurredAt: string | null;
  recordedAt: string | null;
  occurredRecordedDistinct: boolean;
  temporalConfidence: "high" | "medium" | "low" | "unknown";
  localPosition: string | null;
};

export type ThinTemporalProjection = {
  version: typeof THIN_TEMPORAL_PROJECTION_VERSION;
  isoTimestamp: string;
  timezone: string;
  localDate: string;
  localDateTime: string;
  lastInteractionAt: string | null;
  elapsedSinceLastInteractionMs: number | null;
  elapsedSinceLastInteractionLabel: string | null;
  lastInteractionAgeBand: TemporalAgeBand;
  temporalConfidence: "high" | "medium" | "low" | "unknown";
  gapAcknowledged: boolean;
  inventedGapEvents: false;
  episodes: ThinTemporalEpisodePosition[];
  promptText: string;
};

export function projectThinTemporalContext(
  input: ThinTemporalProjectionInput
): ThinTemporalProjection {
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = input.now;
  const isoTimestamp = now.toISOString();
  const localDate = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const localDateTime = now.toLocaleString("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const lastInteraction = parseDate(input.lastInteractionAt);
  const elapsedMs =
    lastInteraction === undefined ? null : Math.max(0, now.getTime() - lastInteraction.getTime());
  const lastInteractionAgeBand = ageBand(elapsedMs, lastInteraction, now, timezone);
  const temporalConfidence: ThinTemporalProjection["temporalConfidence"] =
    lastInteraction === undefined ? "unknown" : "high";
  const episodes = (input.episodes ?? []).map((episode) => projectEpisode(episode, now, timezone));

  const projection: ThinTemporalProjection = {
    version: THIN_TEMPORAL_PROJECTION_VERSION,
    isoTimestamp,
    timezone,
    localDate,
    localDateTime: localDateTime.replace(",", ""),
    lastInteractionAt: lastInteraction?.toISOString() ?? null,
    elapsedSinceLastInteractionMs: elapsedMs,
    elapsedSinceLastInteractionLabel:
      elapsedMs === null ? null : formatElapsedLabel(elapsedMs, lastInteractionAgeBand),
    lastInteractionAgeBand,
    temporalConfidence,
    gapAcknowledged: elapsedMs !== null && elapsedMs >= 30 * 60 * 1000,
    inventedGapEvents: false,
    episodes,
    promptText: ""
  };
  return { ...projection, promptText: formatTemporalPrompt(projection) };
}

export function ageBand(
  elapsedMs: number | null,
  occurred: Date | undefined,
  now: Date,
  timezone: string
): TemporalAgeBand {
  if (elapsedMs === null || occurred === undefined) return "unknown";
  if (elapsedMs < 2 * 60 * 1000) return "just-now";
  if (elapsedMs < 60 * 60 * 1000) return "minutes-ago";
  const occurredDate = occurred.toLocaleDateString("en-CA", { timeZone: timezone });
  const nowDate = now.toLocaleDateString("en-CA", { timeZone: timezone });
  if (occurredDate === nowDate && elapsedMs < 12 * 60 * 60 * 1000) return "earlier-today";
  if (elapsedMs < 24 * 60 * 60 * 1000) return "hours-ago";
  if (isLocalYesterday(occurredDate, nowDate)) return "yesterday";
  if (elapsedMs < 7 * 24 * 60 * 60 * 1000) return "this-week";
  return "older";
}

function projectEpisode(
  episode: RecentEpisode,
  now: Date,
  timezone: string
): ThinTemporalEpisodePosition {
  const occurred = parseDate(episode.occurredAt ?? episode.startedAt);
  const recorded = parseDate(episode.recordedAt);
  const elapsed = occurred ? Math.max(0, now.getTime() - occurred.getTime()) : null;
  const occurredIso = occurred?.toISOString() ?? null;
  const recordedIso = recorded?.toISOString() ?? null;
  return {
    episodeId: episode.id,
    ageBand: ageBand(elapsed, occurred, now, timezone),
    occurredAt: occurredIso,
    recordedAt: recordedIso,
    occurredRecordedDistinct: Boolean(occurredIso && recordedIso && occurredIso !== recordedIso),
    temporalConfidence: episode.temporalConfidence,
    localPosition: occurred
      ? occurred
          .toLocaleString("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
          })
          .replace(",", "")
      : null
  };
}

function formatTemporalPrompt(projection: ThinTemporalProjection): string {
  const lines = [
    `ISO timestamp: ${projection.isoTimestamp}`,
    `Timezone: ${projection.timezone}`,
    `Local date: ${projection.localDate}`,
    `Local date-time: ${projection.localDateTime}`
  ];
  if (projection.lastInteractionAt && projection.elapsedSinceLastInteractionLabel) {
    lines.push(
      `Elapsed since last interaction: ${projection.elapsedSinceLastInteractionLabel} [${projection.lastInteractionAgeBand}]`
    );
  } else {
    lines.push("Elapsed since last interaction: unknown");
  }
  if (projection.gapAcknowledged) {
    lines.push(
      "An interaction gap exists. Do not invent events, feelings, or an off-screen life during the gap."
    );
  }
  if (projection.episodes.length > 0) {
    lines.push("Recent episodes:");
    for (const episode of projection.episodes.slice(0, 4)) {
      const occurred = episode.occurredAt ?? "unknown";
      const recorded = episode.recordedAt ?? "unknown";
      const distinct = episode.occurredRecordedDistinct
        ? `occurredAt=${occurred}; recordedAt=${recorded}`
        : `time=${occurred}`;
      lines.push(
        `- ${episode.localPosition ?? "time-unknown"} [${episode.ageBand}] [${episode.temporalConfidence}] ${distinct}`
      );
    }
  }
  lines.push("Missing timestamps remain unknown. Do not replace them with now.");
  return lines.join("\n");
}

function formatElapsedLabel(elapsedMs: number, band: TemporalAgeBand): string {
  const minutes = Math.round(elapsedMs / 60000);
  if (band === "just-now") return "less than 2 minutes";
  if (band === "minutes-ago") return `${minutes} minutes`;
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

function isLocalYesterday(episodeDate: string, nowDate: string): boolean {
  const episode = Date.parse(`${episodeDate}T00:00:00Z`);
  const current = Date.parse(`${nowDate}T00:00:00Z`);
  return !Number.isNaN(episode) && !Number.isNaN(current) && current - episode === 86400000;
}

function parseDate(value: Date | string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
