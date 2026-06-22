const explicitRememberPatterns: RegExp[] = [
  /(?:^|[，,。！!？?\s])请记住[，,：:\s]/u,
  /(?:^|[，,。！!？?\s])请记住$/u,
  /(?:^|[，,。！!？?\s])记住[，,：:\s]/u,
  /(?:^|[，,。！!？?\s])记住$/u,
  /帮我记住/u,
  /帮我记一下/u,
  /(?:^|[，,。！!？?\s])记一下/u,
  /不要忘记/u,
  /以后记得/u,
  /\bplease\s+remember\b/iu,
  /\bremember\s+that\b/iu,
  /\bremember\b[,:]?\s+(?:that\s+)?/iu,
  /\bdon'?t\s+forget\b/iu,
  /\bmake\s+a\s+note\b/iu
];

const explicitRememberFalsePositivePatterns: RegExp[] = [
  /想不起来.*记住/u,
  /《记住》/u,
  /电影.*《?记住》?/u,
  /这个词.*记住/u,
  /记住.*怎么写/u
];

export function detectExplicitRememberRequest(userMessage: string): boolean {
  const text = normalizeIntentInput(userMessage);
  if (!text) {
    return false;
  }
  if (explicitRememberFalsePositivePatterns.some((pattern) => pattern.test(text))) {
    return false;
  }
  return explicitRememberPatterns.some((pattern) => pattern.test(text));
}

export function stripExplicitRememberPrefix(text: string): string {
  return text
    .replace(
      /^(?:请记住|记住|帮我记住|帮我记一下|记一下|不要忘记|以后记得|please\s+remember|remember\s+that|remember|don't\s+forget|make\s+a\s+note)\s*[:：,，-]?\s*/iu,
      ""
    )
    .trim();
}

function normalizeIntentInput(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
