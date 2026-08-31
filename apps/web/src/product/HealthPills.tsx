import { Badge } from "../components/ui/badge.js";
import type { ProductHealthItem } from "./product-client.js";

export function compactHealthSummary(items: ProductHealthItem[]): {
  label: string;
  tone: ProductHealthItem["tone"];
  failed: ProductHealthItem[];
} {
  const failed = items.filter((item) => item.tone === "bad" || item.tone === "warn");
  if (failed.length === 0) {
    return { label: "Ready", tone: "ok", failed };
  }
  const worst = failed.find((item) => item.tone === "bad") ?? failed[0];
  if (!worst) {
    return { label: "Ready", tone: "ok", failed };
  }
  const extra = failed.length > 1 ? ` · ${failed.length} need attention` : "";
  return {
    label: `${worst.label}: ${worst.summary}${extra}`,
    tone: worst.tone,
    failed
  };
}

export function HealthPills(props: {
  items: ProductHealthItem[];
  onOpenDiagnostics(): void;
}): JSX.Element {
  const summary = compactHealthSummary(props.items);
  return (
    <button
      type="button"
      className="yuvi-health-chip"
      title={props.items.map((item) => `${item.label}: ${item.summary}`).join("\n")}
      onClick={props.onOpenDiagnostics}
    >
      <span className="yuvi-health-chip-label">Status</span>
      <Badge tone={summary.tone}>{summary.label}</Badge>
    </button>
  );
}
