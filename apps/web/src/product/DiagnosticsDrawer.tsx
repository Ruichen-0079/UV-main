import { useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { productClient } from "./product-client.js";
import type { ProductHealthItem } from "./product-client.js";

export function DiagnosticsDrawer(props: {
  open: boolean;
  onClose(): void;
  health: ProductHealthItem[];
  events: Array<{ id: string; type: string; timestamp?: string; payload?: unknown }>;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("all");
  const filtered = useMemo(() => {
    return props.events.filter((event) => {
      if (query && !JSON.stringify(event).toLowerCase().includes(query.toLowerCase())) return false;
      if (severity === "error" && !/error|fail/i.test(event.type)) return false;
      return true;
    });
  }, [props.events, query, severity]);

  if (!props.open) return null;

  return (
    <aside
      className="fixed inset-x-0 bottom-0 z-40 max-h-[48vh] border-t border-[var(--yuvi-line)] bg-[var(--yuvi-bg-elevated)] shadow-2xl"
      role="dialog"
      aria-label="Diagnostics"
    >
      <div className="flex items-center justify-between border-b border-[var(--yuvi-line)] px-4 py-2">
        <h2 className="text-sm font-semibold">Diagnostics</h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void productClient.exportDiagnostics().then((result) => {
                void navigator.clipboard.writeText(result.text);
              })
            }
          >
            Export redacted
          </Button>
          <Button size="sm" variant="secondary" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[240px_1fr] gap-4 p-4">
        <div className="space-y-2 text-sm">
          {props.health.map((item) => (
            <div key={item.id}>
              <div className="font-medium">{item.label}</div>
              <div className="text-xs text-[var(--yuvi-muted)]">
                {item.summary}
                {item.epistemic ? ` · ${item.epistemic}` : ""}
              </div>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-2 flex gap-2">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search events" />
            <select
              className="h-10 rounded-[12px] border border-[var(--yuvi-line)] px-2 text-sm"
              value={severity}
              onChange={(event) => setSeverity(event.target.value)}
            >
              <option value="all">All</option>
              <option value="error">Errors</option>
            </select>
          </div>
          <div className="h-48 overflow-auto rounded-[12px] bg-[var(--yuvi-bg)] p-2 font-mono text-xs">
            {filtered.slice(0, 80).map((event) => (
              <div key={event.id} className="border-b border-[var(--yuvi-line)] py-1">
                <span className="text-[var(--yuvi-muted)]">{event.timestamp}</span> {event.type}
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
