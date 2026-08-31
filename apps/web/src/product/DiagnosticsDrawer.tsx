import { useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Badge } from "../components/ui/badge.js";
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
  const [copied, setCopied] = useState(false);
  const filtered = useMemo(() => {
    return props.events.filter((event) => {
      if (query && !JSON.stringify(event).toLowerCase().includes(query.toLowerCase())) return false;
      if (severity === "error" && !/error|fail/i.test(event.type)) return false;
      return true;
    });
  }, [props.events, query, severity]);

  if (!props.open) return null;

  return (
    <aside className="yuvi-diagnostics" role="dialog" aria-label="Diagnostics">
      <div className="yuvi-diagnostics-head">
        <h2 className="text-sm font-semibold">Diagnostics</h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void productClient.exportDiagnostics().then((result) => {
                void navigator.clipboard.writeText(result.text).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                });
              })
            }
          >
            {copied ? "Copied" : "Export redacted"}
          </Button>
          <Button size="sm" variant="secondary" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="yuvi-diagnostics-body">
        <div className="yuvi-diagnostics-health">
          {props.health.map((item) => (
            <div key={item.id} className="yuvi-diagnostics-health-row">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{item.label}</span>
                <Badge tone={item.tone}>{item.summary}</Badge>
              </div>
              <div className="text-xs text-[var(--yuvi-muted)]">
                {item.detail ?? item.summary}
                {item.epistemic ? ` · ${item.epistemic}` : ""}
              </div>
            </div>
          ))}
        </div>
        <div className="yuvi-diagnostics-events">
          <div className="mb-2 flex gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search events"
            />
            <select
              className="h-10 rounded-[12px] border border-[var(--yuvi-line)] bg-[var(--yuvi-bg-elevated)] px-2 text-sm"
              value={severity}
              onChange={(event) => setSeverity(event.target.value)}
            >
              <option value="all">All</option>
              <option value="error">Errors</option>
            </select>
          </div>
          <div className="yuvi-diagnostics-log">
            {filtered.length === 0 ? (
              <div className="px-1 py-2 text-[var(--yuvi-muted)]">
                No diagnostic events in this session.
              </div>
            ) : (
              filtered.slice(0, 80).map((event) => (
                <div key={event.id} className="border-b border-[var(--yuvi-line)] py-1">
                  <span className="text-[var(--yuvi-muted)]">{event.timestamp}</span> {event.type}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
