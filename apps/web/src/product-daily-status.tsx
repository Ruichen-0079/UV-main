import { useEffect, useState } from "react";
import { DAILY_STATUS_PATH, type DailyServiceStatus } from "./daily-service-status.js";

export function DailyStatusDetails({ data }: { data: DailyServiceStatus }): JSX.Element {
  const labels = {
    postgres: "PostgreSQL",
    ollama: "Ollama",
    mem0: "Mem0",
    runtime: "Runtime",
    local_stt: "Local STT",
    tts_wrapper: "Local TTS"
  };
  return (
    <div aria-label="Startup prerequisites">
      <p>Supervisor observations (independent of Runtime):</p>
      <ul>
        {data.services.map((service) => (
          <li key={service.id}>
            {labels[service.id]}: {service.status}
            {!service.managed
              ? service.id === "postgres" || service.id === "ollama"
                ? " · external prerequisite; YUVI does not start or stop it"
                : " · not configured as YUVI-owned"
              : " · YUVI-managed service"}
            {service.id === "postgres"
              ? " · TCP reachability only; pgvector readiness is reported by Mem0"
              : ""}
          </li>
        ))}
      </ul>
      {data.services.some((s) => !s.managed && s.status !== "healthy") ? (
        <p>
          Restore the external prerequisite using its existing installation, then refresh. If
          Runtime or Mem0 remains unavailable, restart YUVI after the prerequisite is ready.
        </p>
      ) : null}
      <small>Checked {new Date(data.checkedAt).toLocaleTimeString()}</small>
    </div>
  );
}

export function ProductDailyStatus(): JSX.Element | null {
  const [data, setData] = useState<DailyServiceStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch(DAILY_STATUS_PATH, { signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const body = (await response.json()) as DailyServiceStatus;
        if (!Array.isArray(body.services)) throw new Error("Unavailable");
        setData(body);
        setUnavailable(false);
      } catch {
        if (!controller.signal.aborted) {
          setData(null);
          setUnavailable(true);
        }
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  if (data) return <DailyStatusDetails data={data} />;
  return unavailable ? (
    <p>
      Supervisor observations unavailable. PostgreSQL and Ollama remain external prerequisites;
      check their existing installations. YUVI restart does not manage them.
    </p>
  ) : null;
}
