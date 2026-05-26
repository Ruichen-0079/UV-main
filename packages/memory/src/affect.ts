import type { CurrentAffect, CurrentAffectLabel } from "./types.js";

type AffectRule = {
  label: CurrentAffectLabel;
  valence: number;
  arousal: number;
  confidence: number;
  pattern: RegExp;
  promptHint: string;
};

const affectRules: AffectRule[] = [
  {
    label: "frustrated",
    valence: -0.55,
    arousal: 0.72,
    confidence: 0.86,
    pattern: /烦死了|崩溃了|受不了了|frustrated|so annoying|fed up/iu,
    promptHint: "User appears frustrated. Respond with concise, concrete debugging steps."
  },
  {
    label: "anxious",
    valence: -0.45,
    arousal: 0.68,
    confidence: 0.82,
    pattern: /焦虑|慌了|担心|anxious|worried|panic/iu,
    promptHint: "User appears anxious. Keep the response steady, bounded, and actionable."
  },
  {
    label: "confused",
    valence: -0.28,
    arousal: 0.42,
    confidence: 0.8,
    pattern: /看不懂|搞不懂|不明白|confused|lost|don't understand|do not understand/iu,
    promptHint: "User appears confused. Explain the next step plainly and avoid extra branches."
  },
  {
    label: "angry",
    valence: -0.7,
    arousal: 0.86,
    confidence: 0.84,
    pattern: /气死了|火大|angry|furious|mad as hell/iu,
    promptHint: "User appears angry. Stay calm, avoid defensiveness, and focus on resolution."
  },
  {
    label: "sad",
    valence: -0.65,
    arousal: 0.32,
    confidence: 0.78,
    pattern: /难过|伤心|sad|depressed|upset/iu,
    promptHint: "User appears sad. Be gentle and practical without overclaiming."
  },
  {
    label: "tired",
    valence: -0.3,
    arousal: 0.24,
    confidence: 0.8,
    pattern: /累了|太累|疲惫|tired|exhausted/iu,
    promptHint: "User appears tired. Keep the response short and reduce cognitive load."
  },
  {
    label: "excited",
    valence: 0.72,
    arousal: 0.78,
    confidence: 0.78,
    pattern: /太好了|爽|开心|excited|awesome|great news|let'?s go/iu,
    promptHint: "User appears excited. Match positive momentum while staying grounded."
  },
  {
    label: "calm",
    valence: 0.25,
    arousal: 0.2,
    confidence: 0.65,
    pattern: /冷静|慢慢来|calm|no rush/iu,
    promptHint: "User appears calm. Use a steady, straightforward response."
  }
];

export function detectCurrentAffect(input: {
  text: string;
  timestamp?: string | Date;
  sourceTraceId?: string | null;
}): CurrentAffect | null {
  const text = input.text.trim();
  if (!text) return null;
  const rule = affectRules.find((candidate) => candidate.pattern.test(text));
  if (!rule) return null;
  const timestamp =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : (input.timestamp ?? new Date().toISOString());
  return {
    affectLabel: rule.label,
    affectValence: rule.valence,
    affectArousal: rule.arousal,
    confidence: rule.confidence,
    evidenceSnippet: redactSnippet(text),
    timestamp,
    sourceTraceId: input.sourceTraceId ?? null,
    promptHint: rule.promptHint
  };
}

function redactSnippet(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(
      /([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)[A-Z0-9_]*)=([^\s]+)/giu,
      "$1=[REDACTED]"
    )
    .slice(0, 160);
}
