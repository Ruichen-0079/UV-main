import { t } from "../locale.js";
import { useState } from "react";
import type { RuntimeEvent } from "../api/client.js";
import { EventTable } from "../dashboard-events.js";
import { PageShell, Panel } from "../dashboard-ui.js";

export function EventsPage(props: {
  events: RuntimeEvent[];
  paused: boolean;
  wsStatus: string;
  onTogglePaused(): void;
}): JSX.Element {
  const [filter, setFilter] = useState("all");
  const filtered =
    filter === "all" ? props.events : props.events.filter((event) => event.type === filter);
  const types = Array.from(new Set(props.events.map((event) => event.type)));

  return (
    <PageShell
      title={t("Events")}
      subtitle="Recent runtime events from the server, with live WebSocket updates when connected."
    >
      <Panel
        title={t("Event Stream")}
        actions={
          <button className="button-secondary" onClick={props.onTogglePaused}>
            {props.paused ? t("Resume") : t("Pause")}
          </button>
        }
      >
        <div className="mb-3 grid grid-cols-[220px_1fr] gap-3">
          <select
            className="field"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">{t("All event types")}</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <div className="rounded-md border border-ink-200 px-3 py-2 text-sm text-ink-500">{t("WebSocket status:")}{" "}{props.wsStatus}
          </div>
        </div>
        <EventTable events={filtered} />
      </Panel>
    </PageShell>
  );
}
