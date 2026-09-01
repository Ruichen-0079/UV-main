const SECRET_KEY =
  /(?:api[_-]?key|authorization|password|secret|token|database_url|dsn|credential)/iu;
const SECRET_VALUE = /(?:sk-|Bearer\s+|postgres(?:ql)?:\/\/[^\s]+)/iu;

export function redactDiagnosticsText(value: string): string {
  return value
    .split("\n")
    .map((line) => {
      if (SECRET_KEY.test(line) || SECRET_VALUE.test(line)) {
        return line.replace(SECRET_VALUE, "[redacted]").replace(
          /(api[_-]?key|authorization|password|secret|token|database_url)\s*[:=]\s*\S+/giu,
          "$1=[redacted]"
        );
      }
      return line;
    })
    .join("\n");
}

export function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    return SECRET_VALUE.test(value) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY.test(key) ? "[redacted]" : redactUnknown(nested, depth + 1);
    }
    return output;
  }
  return value;
}
