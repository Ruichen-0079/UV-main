import { useEffect, useReducer, useRef, useState, type Dispatch } from "react";
import {
  initialServiceStatusState,
  reduceServiceStatus,
  runtimeChatAvailability,
  selectPrimaryServices,
  type ServiceStatusAction,
  type UiServiceSnapshot
} from "./service-status-state.js";
import { isTauriRuntime } from "./tauri-window.js";
import {
  invokeServiceAction,
  isServiceSupervisorAvailable,
  subscribeServiceStatus,
  type SupervisorSnapshotDto
} from "./service-supervisor-client.js";

/**
 * Compact service status strip for the Tauri main window.
 * Companion must not mount this component.
 */
export function ServiceStatusPanel(): JSX.Element | null {
  const [state, dispatch] = useReducer(reduceServiceStatus, initialServiceStatusState);
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime() && !isServiceSupervisorAvailable()) {
      return;
    }
    // StrictMode-safe: only one subscription per mount cycle.
    if (startedRef.current) return;
    startedRef.current = true;

    const unsubscribe = subscribeServiceStatus({
      onSnapshot(snapshot) {
        dispatch({
          type: "snapshot",
          instanceId: snapshot.instanceId,
          shuttingDown: snapshot.shuttingDown,
          services: snapshot.services as UiServiceSnapshot[],
          updatedAt: snapshot.updatedAt
        });
      },
      onConnected(instanceId) {
        dispatch({ type: "supervisor-connected", instanceId });
      },
      onDisconnected(error) {
        if (error) {
          dispatch({ type: "supervisor-disconnected", error });
        } else {
          dispatch({ type: "supervisor-disconnected" });
        }
      }
    });

    return () => {
      startedRef.current = false;
      unsubscribe();
    };
  }, []);

  if (!isTauriRuntime() && !isServiceSupervisorAvailable()) {
    return null;
  }

  const primary = selectPrimaryServices(state.services);
  const chat = runtimeChatAvailability(state.services);

  return (
    <section className="border-b border-ink-200 bg-white px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
          Services
        </span>
        {primary.map((service) => (
          <ServiceChip key={service.id} service={service} />
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="button-secondary text-xs"
            onClick={() => void runAction(null, "refresh", dispatch, setBusyId)}
          >
            Refresh
          </button>
          <button
            type="button"
            className="button-secondary text-xs"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        </div>
      </div>

      {!chat.available && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Chat unavailable: {chat.reason ?? "Runtime is not healthy."}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void runAction("runtime", "restart", dispatch, setBusyId)}
          >
            Retry Runtime
          </button>
        </div>
      )}

      {state.lastError && (
        <div className="mt-2 text-xs text-rose-600">{state.lastError}</div>
      )}

      {expanded && (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {state.services.map((service) => (
            <ServiceDetailCard
              key={service.id}
              service={service}
              busy={busyId === service.id}
              onRestart={() => void runAction(service.id, "restart", dispatch, setBusyId)}
              onStop={() => void runAction(service.id, "stop", dispatch, setBusyId)}
              onStart={() => void runAction(service.id, "start", dispatch, setBusyId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ServiceChip(props: { service: UiServiceSnapshot }): JSX.Element {
  const tone = statusTone(props.service.status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${tone}`}
      title={props.service.summary}
    >
      <span className="font-medium">{shortLabel(props.service)}</span>
      <span className="opacity-70">{props.service.status}</span>
      <span className="opacity-50">{props.service.ownership === "owned" ? "owned" : props.service.ownership}</span>
    </span>
  );
}

function ServiceDetailCard(props: {
  service: UiServiceSnapshot;
  busy: boolean;
  onRestart(): void;
  onStop(): void;
  onStart(): void;
}): JSX.Element {
  const { service } = props;
  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50/40 p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-ink-800">{service.label}</div>
          <div className="text-ink-600">{service.summary}</div>
        </div>
        <span className={`rounded px-1.5 py-0.5 ${statusTone(service.status)}`}>
          {service.status}
        </span>
      </div>
      <div className="mt-1 text-ink-500">
        {service.ownership} {service.url ? `· ${service.url}` : ""}
      </div>
      {service.detail && <div className="mt-1 text-ink-500">{service.detail}</div>}
      {service.lastError && (
        <details className="mt-1">
          <summary className="cursor-pointer text-ink-500">Error detail</summary>
          <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-rose-700">
            {service.lastError}
          </pre>
        </details>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {service.canRestart && (
          <button
            type="button"
            className="button-secondary text-xs"
            disabled={props.busy}
            onClick={props.onRestart}
          >
            Restart
          </button>
        )}
        {service.canStop && (
          <button
            type="button"
            className="button-secondary text-xs"
            disabled={props.busy}
            onClick={props.onStop}
          >
            Stop
          </button>
        )}
        {service.managed && service.status !== "healthy" && service.canRestart && (
          <button
            type="button"
            className="button-secondary text-xs"
            disabled={props.busy}
            onClick={props.onStart}
          >
            Start
          </button>
        )}
      </div>
    </div>
  );
}

function shortLabel(service: UiServiceSnapshot): string {
  switch (service.id) {
    case "runtime":
      return "Runtime";
    case "mem0":
      return "Memory";
    case "ollama":
      return "Ollama";
    case "postgres":
      return "Postgres";
    case "tts_wrapper":
      return "TTS";
    case "tts_upstream":
      return "TTS↑";
    default:
      return service.label;
  }
}

function statusTone(status: string): string {
  switch (status) {
    case "healthy":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "degraded":
    case "starting":
    case "restarting":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "unavailable":
      return "border-rose-200 bg-rose-50 text-rose-800";
    default:
      return "border-ink-200 bg-white text-ink-700";
  }
}

async function runAction(
  serviceId: string | null,
  action: "refresh" | "restart" | "stop" | "start",
  dispatch: Dispatch<ServiceStatusAction>,
  setBusyId: (id: string | null) => void
): Promise<void> {
  setBusyId(serviceId ?? "all");
  try {
    const snapshot = await invokeServiceAction(action, serviceId);
    if (snapshot) {
      applySnapshot(dispatch, snapshot);
    }
  } catch (error) {
    dispatch({
      type: "local-error",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    setBusyId(null);
  }
}

function applySnapshot(
  dispatch: Dispatch<ServiceStatusAction>,
  snapshot: SupervisorSnapshotDto
): void {
  dispatch({
    type: "snapshot",
    instanceId: snapshot.instanceId,
    shuttingDown: snapshot.shuttingDown,
    services: snapshot.services as UiServiceSnapshot[],
    updatedAt: snapshot.updatedAt
  });
}
