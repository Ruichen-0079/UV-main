import { Badge } from "../components/ui/badge.js";
import type { ProductHealthItem } from "./product-client.js";

export function HealthPills(props: { items: ProductHealthItem[]; onOpenDiagnostics(): void }): JSX.Element {
  const failed = props.items.filter((item) => item.tone === "bad" || item.tone === "warn");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-[var(--yuvi-line)] bg-[var(--yuvi-bg-elevated)] px-2.5 py-1 text-xs"
          title={item.detail ?? item.summary}
          onClick={props.onOpenDiagnostics}
        >
          <span className="font-medium">{item.label}</span>
          <Badge tone={item.tone}>{item.summary}</Badge>
        </button>
      ))}
      {failed.length > 0 ? (
        <button type="button" className="text-xs text-[var(--yuvi-warn)]" onClick={props.onOpenDiagnostics}>
          {failed.length} need attention
        </button>
      ) : null}
    </div>
  );
}
