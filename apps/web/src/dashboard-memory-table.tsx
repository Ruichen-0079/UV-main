import type { MemoryRecord, RetrievedMemoryDebug } from "./api/client.js";
import { formatDate } from "./dashboard-format.js";
import {
  formatRankComponents,
  formatScope,
  memoryPreview,
  shortTrace
} from "./dashboard-memory-view.js";

export function MemoryTable(props: {
  memories: MemoryRecord[];
  debugById?: Map<string, RetrievedMemoryDebug>;
  compact?: boolean;
  onView?(memory: MemoryRecord): void;
  onEdit?(memory: MemoryRecord): void;
  onArchive?(memory: MemoryRecord): void;
  onRestore?(memory: MemoryRecord): void;
  onForget?(memory: MemoryRecord): void;
  onDelete?(memory: MemoryRecord): void;
}): JSX.Element {
  return (
    <div className="max-h-[420px] overflow-auto rounded-md border border-ink-100">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-ink-50">
          <tr>
            <th className="table-cell">Type</th>
            {!props.compact && <th className="table-cell">Subtype</th>}
            {!props.compact && <th className="table-cell">Layer</th>}
            {!props.compact && <th className="table-cell">Status</th>}
            {!props.compact && <th className="table-cell">Scope</th>}
            <th className="table-cell">Content</th>
            {!props.compact && <th className="table-cell">Importance</th>}
            {!props.compact && <th className="table-cell">Tags</th>}
            {!props.compact && <th className="table-cell">Source</th>}
            {!props.compact && <th className="table-cell">Embedding</th>}
            {!props.compact && <th className="table-cell">Matched</th>}
            {!props.compact && <th className="table-cell">Trace</th>}
            <th className="table-cell">Created</th>
            {!props.compact && <th className="table-cell">Updated</th>}
            {(props.onView ||
              props.onEdit ||
              props.onArchive ||
              props.onRestore ||
              props.onForget ||
              props.onDelete) && <th className="table-cell">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {props.memories.map((memory) => {
            const debug = props.debugById?.get(memory.id);
            return (
              <tr key={memory.id}>
                <td className="table-cell">{memory.type}</td>
                {!props.compact && <td className="table-cell">{memory.subtype ?? "none"}</td>}
                {!props.compact && (
                  <td className="table-cell text-ink-500">{memory.memoryLayer ?? "unknown"}</td>
                )}
                {!props.compact && (
                  <td className="table-cell text-ink-500">{memory.status ?? "active"}</td>
                )}
                {!props.compact && (
                  <td className="table-cell text-ink-500">{formatScope(memory)}</td>
                )}
                <td className="table-cell">{memoryPreview(memory)}</td>
                {!props.compact && (
                  <td className="table-cell text-ink-500">{memory.importance.toFixed(2)}</td>
                )}
                {!props.compact && (
                  <td className="table-cell text-ink-500">{memory.tags.join(", ") || "none"}</td>
                )}
                {!props.compact && <td className="table-cell text-ink-500">{memory.source}</td>}
                {!props.compact && (
                  <td className="table-cell text-ink-500">
                    <span
                      className={`rounded px-2 py-1 text-[10px] font-semibold ${
                        (memory.hasEmbedding ?? memory.embeddedAt)
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {(memory.hasEmbedding ?? memory.embeddedAt) ? "Embedded" : "Missing"}
                    </span>
                    {memory.embeddingProvider ? (
                      <span className="block text-[10px] text-ink-400">
                        {memory.embeddingProvider}
                        {memory.embeddingModel ? ` · ${memory.embeddingModel}` : ""}
                        {memory.embeddingDimensions ? ` · ${memory.embeddingDimensions}d` : ""}
                      </span>
                    ) : null}
                    {memory.embeddedAt ? (
                      <span className="block text-[10px] text-ink-400">
                        {formatDate(memory.embeddedAt)}
                      </span>
                    ) : null}
                    {memory.semanticEmbedding === false ? (
                      <span className="block text-[10px] text-amber-700">non-semantic mock</span>
                    ) : null}
                    {memory.embeddingError ? (
                      <span className="block text-[10px] text-rose-700">
                        {memory.embeddingError}
                      </span>
                    ) : null}
                  </td>
                )}
                {!props.compact && (
                  <td className="table-cell text-ink-500">
                    {debug?.matchedBy ?? "n/a"}
                    {debug?.retrievalMode ? (
                      <span className="block text-[10px] text-ink-400">{debug.retrievalMode}</span>
                    ) : null}
                    {debug?.score !== undefined ? ` · ${debug.score.toFixed(2)}` : ""}
                    {debug?.rankComponents ? (
                      <span className="block text-[10px] text-ink-400">
                        {formatRankComponents(debug.rankComponents)}
                      </span>
                    ) : null}
                  </td>
                )}
                {!props.compact && (
                  <td className="table-cell font-mono text-xs text-ink-500">
                    {shortTrace(memory.sourceTraceId ?? undefined)}
                  </td>
                )}
                <td className="table-cell text-ink-500">{formatDate(memory.createdAt)}</td>
                {!props.compact && (
                  <td className="table-cell text-ink-500">{formatDate(memory.updatedAt ?? "")}</td>
                )}
                {(props.onView ||
                  props.onEdit ||
                  props.onArchive ||
                  props.onRestore ||
                  props.onForget ||
                  props.onDelete) && (
                  <td className="table-cell">
                    <div className="flex flex-wrap gap-2">
                      {props.onView && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onView?.(memory)}
                        >
                          View
                        </button>
                      )}
                      {props.onEdit && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onEdit?.(memory)}
                        >
                          Edit
                        </button>
                      )}
                      {props.onArchive && memory.status !== "archived" && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onArchive?.(memory)}
                        >
                          Archive
                        </button>
                      )}
                      {props.onRestore && memory.status !== "active" && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onRestore?.(memory)}
                        >
                          Restore
                        </button>
                      )}
                      {props.onForget && memory.status !== "forgotten" && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onForget?.(memory)}
                        >
                          Forget
                        </button>
                      )}
                      {props.onDelete && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onDelete?.(memory)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
