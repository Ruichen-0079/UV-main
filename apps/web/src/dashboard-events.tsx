import type { RuntimeEvent } from "./api/client.js";
import { formatDate } from "./dashboard-format.js";
import { EmptyState } from "./dashboard-ui.js";

export function EventTable(props: { events: RuntimeEvent[] }): JSX.Element {
  if (props.events.length === 0) {
    return <EmptyState title="No events" message="Runtime events will appear here." />;
  }

  return (
    <div className="max-h-[360px] overflow-auto rounded-md border border-ink-100">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-ink-50">
          <tr>
            <th className="table-cell">Type</th>
            <th className="table-cell">Trace ID</th>
            <th className="table-cell">Created</th>
          </tr>
        </thead>
        <tbody>
          {props.events.map((event) => (
            <tr key={event.id}>
              <td className="table-cell font-medium">{event.type}</td>
              <td className="table-cell font-mono text-xs">{event.traceId}</td>
              <td className="table-cell text-ink-500">
                {formatDate(event.createdAt ?? event.timestamp ?? "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
