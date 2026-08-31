import { createHash } from "node:crypto";

const SECRET_ASSIGNMENT =
  /(api[-_]?key|authorization|bearer|token|password|secret|database[_-]?url|connection[_-]?string)\s*[:=]\s*\S+/gi;
const SECRET_URL = /\b(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi;
const SECRET_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
const UNIX_PATH = /\/[A-Za-z0-9_./@~+-]+/g;
const HOST_PORT = /\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/g;
const BARE_PORT = /\b\d{2,5}\b/g;
const PACKAGE_COMMAND = /\b(?:pnpm|npm|cargo|git)\s+[\w:-]+/g;
const ENV_OR_CONST = /\b[A-Z][A-Z0-9_]{3,}\b/g;
const FILENAME = /\b[\w.-]+\.(?:ts|js|py|json|yml|yaml|md|sql|gguf)\b/g;
const LATIN_WORD = /[A-Za-z][A-Za-z0-9_-]{1,}/gu;
const CJK_CHAR = /[\u3400-\u9fff]/u;

export function redactUnsafeMemoryText(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT, "$1=[redacted]")
    .replace(SECRET_URL, "[redacted-url]")
    .replace(SECRET_KEY, "sk-[redacted]");
}

export function compactMemoryText(text: string, maxChars: number): string {
  const compact = redactUnsafeMemoryText(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function normalizeMemoryCompareText(text: string): string {
  return redactUnsafeMemoryText(text)
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "");
}

export function tokenizeMemoryText(text: string): string[] {
  const source = redactUnsafeMemoryText(text);
  const tokens = new Set<string>();
  const technicalPatterns = [
    UNIX_PATH,
    HOST_PORT,
    BARE_PORT,
    PACKAGE_COMMAND,
    ENV_OR_CONST,
    FILENAME
  ];

  for (const pattern of technicalPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const token = match[0]?.trim();
      if (token && token.length >= 2) tokens.add(token.toLocaleLowerCase());
    }
  }
  for (const token of extractWindowsPaths(source)) {
    tokens.add(token);
  }
  for (const match of source.matchAll(LATIN_WORD)) {
    const token = match[0]?.trim();
    if (token && token.length >= 2) tokens.add(token.toLocaleLowerCase());
  }

  const compact = source.replace(/\s+/g, "");
  for (let index = 0; index < compact.length - 1; index += 1) {
    const first = compact[index]!;
    const second = compact[index + 1]!;
    if (CJK_CHAR.test(first) && CJK_CHAR.test(second)) {
      tokens.add(`${first}${second}`);
    }
  }

  return [...tokens];
}

export function jaccardSimilarity(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let intersection = 0;
  const union = new Set(left);
  for (const token of left) {
    if (rightSet.has(token)) intersection += 1;
  }
  for (const token of right) union.add(token);
  return union.size === 0 ? 0 : intersection / union.size;
}

export function hasTechnicalExactOverlap(query: string, candidate: string): boolean {
  const queryTokens = new Set(tokenizeMemoryText(query).filter((token) => isTechnicalToken(token)));
  if (queryTokens.size === 0) return false;
  const candidateTokens = tokenizeMemoryText(candidate);
  return candidateTokens.some((token) => queryTokens.has(token));
}

export function isTechnicalToken(token: string): boolean {
  return (
    /[\\/.:]/.test(token) ||
    /^\d{2,5}$/.test(token) ||
    /^[a-z][a-z0-9_]*-[a-z0-9_-]+$/.test(token) ||
    /\.(ts|js|py|json|yml|yaml|md|sql|gguf)$/.test(token) ||
    /^(pnpm|npm|cargo|git)\s+/.test(token)
  );
}

function extractWindowsPaths(text: string): string[] {
  const paths: string[] = [];
  for (let index = 0; index < text.length - 2; index += 1) {
    const drive = text[index];
    if (!drive || !/[A-Za-z]/.test(drive)) continue;
    if (text[index + 1] !== ":") continue;
    if (text[index + 2] !== "\\") continue;
    let end = index + 3;
    while (end < text.length && !/\s/.test(text[end]!)) end += 1;
    paths.push(text.slice(index, end).toLocaleLowerCase());
  }
  return paths;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
