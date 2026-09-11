import { useEffect, useRef, useState } from "react";
import {
  request,
  apiClient,
  type LocalConnectionFinding,
  type LocalConnectionService
} from "./api/client.js";
import { t } from "./locale.js";

/**
 * Simplified local-model connection experience.
 *
 * Presentation only: persistence always goes through the existing Product
 * configuration authority (GET/PUT /product/configuration). Detection and
 * endpoint tests never save. Configured external endpoints are routing
 * only — YUVI never manages their process lifecycle here.
 */

type LocalCapability = "embedding" | "stt" | "tts";
type Provider = {
  id: string;
  displayName: string;
  baseUrl: string;
  adapter: string;
  apiKey?: string | undefined;
  hasApiKey?: boolean;
};
type Model = {
  id: string;
  providerId: string;
  displayName: string;
  modelId: string;
  temperature: number;
  contextWindow: number | null;
  capabilities: LocalCapability[];
  enabled: boolean;
  dimensions?: number;
  voice?: string | undefined;
};
type Configuration = {
  version: 1;
  providers: Provider[];
  models: Model[];
  routes: Record<LocalCapability | "chat" | "reasoning" | "proactive" | "vision", string[]>;
};
type Snapshot = {
  configuration: Configuration;
  proactive: { threshold: number; intervalMs: number };
  revision: number;
  routes: Record<string, { state: string; modelIds: string[] }>;
  applyState: string;
};

export const LOCAL_CONNECTION_DEFAULTS: Record<LocalCapability, string> = {
  embedding: "http://127.0.0.1:8128/v1",
  stt: "http://127.0.0.1:9876",
  tts: "http://127.0.0.1:9881"
};

const SERVICE_META: Record<
  LocalCapability,
  { title: string; blurb: string; defaultModel: string; providerLabel: string }
> = {
  embedding: {
    title: "Embedding",
    blurb: "Turns text into vectors for Memory search.",
    defaultModel: "",
    providerLabel: "Local embedding"
  },
  stt: {
    title: "Speech recognition",
    blurb: "Transcribes microphone audio into text.",
    defaultModel: "sensevoice",
    providerLabel: "Local speech recognition"
  },
  tts: {
    title: "Speech synthesis",
    blurb: "Speaks replies aloud with subtitles.",
    defaultModel: "dots-studio/dots.tts-soar",
    providerLabel: "Local speech synthesis"
  }
};

const LOCAL_ADAPTERS: Record<LocalCapability, string[]> = {
  embedding: ["openai-compatible"],
  stt: ["local-stt"],
  tts: ["dots-tts", "gpt-sovits"]
};

const sameEndpoint = (a: string, b: string): boolean =>
  a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

export function localConnectionStateLabel(
  service: LocalConnectionService,
  state: LocalConnectionFinding["state"] | undefined,
  routeState: string | undefined
): string {
  if (state === "ready") return service === "tts" ? t("Ready") : t("Connected");
  if (state === "hibernated") return t("Hibernated");
  if (state === "warming") return t("Warming up");
  if (state === "needs-key") return t("Needs API key");
  if (state === "unavailable") return t("Unavailable");
  if (routeState === "ACTIVE" || routeState === "FALLBACK_ACTIVE") return t("Connected");
  if (routeState === "RESTART_REQUIRED") return t("Saved · restart to apply");
  if (routeState === "APPLY_FAILED") return t("Apply failed");
  if (routeState === "UNAVAILABLE") return t("Unavailable");
  return t("Not configured");
}

type CardForm = { endpoint: string; model: string; dimensions: string; apiKey: string };

function routedPair(
  draft: Configuration,
  service: LocalCapability
): { provider: Provider; model: Model } | null {
  const [modelId] = draft.routes[service] ?? [];
  const model = draft.models.find((m) => m.id === modelId && m.enabled);
  if (!model) return null;
  const provider = draft.providers.find((p) => p.id === model.providerId);
  if (!provider) return null;
  return { provider, model };
}

export function ProductLocalServicesPanel(): JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [findings, setFindings] = useState<Record<LocalCapability, LocalConnectionFinding | null>>({
    embedding: null,
    stt: null,
    tts: null
  });
  const [open, setOpen] = useState<Record<LocalCapability, boolean>>({
    embedding: false,
    stt: false,
    tts: false
  });
  const [forms, setForms] = useState<Record<LocalCapability, CardForm>>({
    embedding: { endpoint: "", model: "", dimensions: "", apiKey: "" },
    stt: { endpoint: "", model: "", dimensions: "", apiKey: "" },
    tts: { endpoint: "", model: "", dimensions: "", apiKey: "" }
  });
  const [testing, setTesting] = useState<Record<LocalCapability, boolean>>({
    embedding: false,
    stt: false,
    tts: false
  });
  const [testNotes, setTestNotes] = useState<Record<LocalCapability, string>>({
    embedding: "",
    stt: "",
    tts: ""
  });
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const next = await request<Snapshot>("/product/configuration");
      setSnapshot(next);
      setDraft(structuredClone(next.configuration) as Configuration);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Could not load settings."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function detect(): Promise<void> {
    setDetecting(true);
    setNotice("");
    try {
      const result = await apiClient.detectLocalServices();
      setFindings({ embedding: result.services.embedding, stt: result.services.stt, tts: result.services.tts });
      setNotice(t("Detection finished. Nothing was saved — review the findings, then Save & apply."));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Detection failed."));
    } finally {
      setDetecting(false);
    }
  }

  function openConfigure(service: LocalCapability): void {
    if (!draft) return;
    const saved = routedPair(draft, service);
    const finding = findings[service];
    const endpoint = saved?.provider.baseUrl ?? finding?.testedEndpoint ?? LOCAL_CONNECTION_DEFAULTS[service];
    // Never silently change an existing vector-dimension contract: keep the
    // configured value and only suggest detected dimensions for new setups.
    const dimensions =
      service === "embedding"
        ? String(saved?.model.dimensions ?? finding?.dimensions ?? "")
        : "";
    setForms((current) => ({
      ...current,
      [service]: {
        endpoint,
        model: saved?.model.modelId ?? finding?.model ?? SERVICE_META[service].defaultModel,
        dimensions,
        apiKey: ""
      }
    }));
    setOpen((current) => ({ ...current, [service]: true }));
  }

  async function testEndpoint(service: LocalCapability): Promise<void> {
    if (!draft) return;
    const saved = routedPair(draft, service);
    const form = forms[service];
    const edited = open[service] && !sameEndpoint(form.endpoint.trim() || LOCAL_CONNECTION_DEFAULTS[service], saved?.provider.baseUrl ?? "");
    const endpoint = (open[service] ? form.endpoint.trim() : "") || saved?.provider.baseUrl || findings[service]?.testedEndpoint || LOCAL_CONNECTION_DEFAULTS[service];
    setTesting((current) => ({ ...current, [service]: true }));
    setTestNotes((current) => ({ ...current, [service]: "" }));
    try {
      if (saved && LOCAL_ADAPTERS[service].includes(saved.provider.adapter) && !edited) {
        const result = await request<{ message: string }>(`/product/providers/${saved.provider.id}/test`, { method: "POST" });
        setTestNotes((current) => ({ ...current, [service]: t("Tested {0}: {1}", endpoint, result.message) }));
      } else {
        const finding = await apiClient.probeLocalService({
          service,
          endpoint,
          ...(service === "embedding" && form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
        });
        setFindings((current) => ({ ...current, [service]: finding }));
        setTestNotes((current) => ({
          ...current,
          [service]: t("Tested {0}: {1}", finding.testedEndpoint, finding.detail ?? finding.state)
        }));
      }
    } catch (error) {
      setTestNotes((current) => ({
        ...current,
        [service]: t("Tested {0}: {1}", endpoint, error instanceof Error ? error.message : t("Connection unavailable."))
      }));
    } finally {
      setTesting((current) => ({ ...current, [service]: false }));
    }
  }

  async function save(service: LocalCapability): Promise<void> {
    if (!draft || !snapshot || writing.current) return;
    const form = forms[service];
    const endpoint = form.endpoint.trim();
    const modelName = form.model.trim() || SERVICE_META[service].defaultModel;
    if (!endpoint) {
      setNotice(t("Endpoint is required."));
      return;
    }
    if (service === "embedding") {
      const dims = Number(form.dimensions);
      if (!Number.isSafeInteger(dims) || dims < 1) {
        setNotice(t("Embedding dimensions must be a positive whole number."));
        return;
      }
    }
    if (!modelName) {
      setNotice(t("Model is required."));
      return;
    }
    writing.current = true;
    setBusy(true);
    setNotice("");
    try {
      const next: Configuration = structuredClone(draft) as Configuration;
      const adapters = LOCAL_ADAPTERS[service];
      let provider = next.providers.find((p) => adapters.includes(p.adapter) && sameEndpoint(p.baseUrl, endpoint));
      if (!provider) {
        provider = {
          id: crypto.randomUUID(),
          displayName: SERVICE_META[service].providerLabel,
          baseUrl: endpoint,
          adapter: adapters[0]!
        };
        next.providers.push(provider);
      } else {
        provider.baseUrl = endpoint;
      }
      if (service === "embedding" && form.apiKey.trim()) provider.apiKey = form.apiKey.trim();
      let model = next.models.find((m) => m.providerId === provider!.id && m.capabilities.includes(service));
      if (!model) {
        model = {
          id: crypto.randomUUID(),
          providerId: provider.id,
          displayName: modelName,
          modelId: modelName,
          temperature: 0.7,
          contextWindow: null,
          capabilities: [service],
          enabled: true
        };
        next.models.push(model);
      } else {
        model.modelId = modelName;
        if (!model.displayName) model.displayName = modelName;
        model.enabled = true;
        if (!model.capabilities.includes(service)) model.capabilities = [...model.capabilities, service];
      }
      if (service === "embedding") model.dimensions = Number(form.dimensions);
      next.routes[service] = [model.id];
      const saved = await request<Snapshot>("/product/configuration", {
        method: "PUT",
        body: JSON.stringify({ configuration: next, revision: snapshot.revision, proactive: snapshot.proactive })
      });
      setSnapshot(saved);
      setDraft(structuredClone(saved.configuration) as Configuration);
      setOpen((current) => ({ ...current, [service]: false }));
      setNotice(t("Saved. {0} now routes to {1}.", SERVICE_META[service].title, endpoint));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Save failed."));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  const inputStyle = "rounded border p-2 bg-transparent w-full";
  const services: LocalCapability[] = ["embedding", "stt", "tts"];

  return (
    <section className="yuvi-card grid gap-4" aria-label={t("Local models")}>
      <header className="grid gap-2">
        <h2>{t("Local models")}</h2>
        <p>
          {t("Connect YUVI to services already running on this machine. Detection only checks known local endpoints and never saves on its own.")}
        </p>
        <div>
          <button type="button" disabled={detecting || loading} onClick={() => void detect()}>
            {detecting ? t("Detecting…") : t("Detect local services")}
          </button>
        </div>
        {notice && <p role="status">{notice}</p>}
        {loading && <p role="status">{t("Loading configuration…")}</p>}
      </header>
      {draft &&
        services.map((service) => {
          const saved = routedPair(draft, service);
          const finding = findings[service];
          const shownEndpoint = saved?.provider.baseUrl ?? finding?.testedEndpoint ?? t("Not configured");
          const shownModel =
            saved?.model.modelId ?? finding?.model ?? (service === "tts" ? finding?.voice : undefined) ?? "—";
          const configuredDims = saved?.model.dimensions;
          const detectedDims = finding?.dimensions;
          const stateLabel = localConnectionStateLabel(service, finding?.state, snapshot?.routes[service]?.state);
          const form = forms[service];
          return (
            <article key={service} className="rounded border p-3 grid gap-2" aria-label={SERVICE_META[service].title}>
              <h3>{t(SERVICE_META[service].title)}</h3>
              <p>{t(SERVICE_META[service].blurb)}</p>
              <dl className="grid gap-1">
                <div>
                  <dt>{t("Model")}</dt>
                  <dd>{shownModel}</dd>
                </div>
                <div>
                  <dt>{t("Endpoint")}</dt>
                  <dd>{shownEndpoint}</dd>
                </div>
                <div>
                  <dt>{t("Connection")}</dt>
                  <dd>{stateLabel}</dd>
                </div>
                {service === "embedding" && (configuredDims !== undefined || detectedDims !== undefined) && (
                  <div>
                    <dt>{t("Dimensions")}</dt>
                    <dd>
                      {configuredDims !== undefined ? configuredDims : "—"}
                      {detectedDims !== undefined && detectedDims !== configuredDims
                        ? t(" (detected: {0})", detectedDims)
                        : ""}
                    </dd>
                  </div>
                )}
              </dl>
              {finding?.detail && <p role="status">{finding.detail}</p>}
              {testNotes[service] && <p role="status">{testNotes[service]}</p>}
              <div className="flex gap-2 flex-wrap">
                <button type="button" disabled={testing[service] || loading} onClick={() => void testEndpoint(service)}>
                  {testing[service] ? t("Testing…") : t("Test")}
                </button>
                <button type="button" onClick={() => (open[service] ? setOpen((c) => ({ ...c, [service]: false })) : openConfigure(service))}>
                  {open[service] ? t("Close configuration") : t("Configure")}
                </button>
              </div>
              {open[service] && (
                <form
                  className="grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(service);
                  }}
                >
                  <label>
                    {t("Endpoint")}
                    <input
                      required
                      type="url"
                      className={inputStyle}
                      value={form.endpoint}
                      placeholder={LOCAL_CONNECTION_DEFAULTS[service]}
                      onChange={(e) => setForms((c) => ({ ...c, [service]: { ...c[service], endpoint: e.target.value } }))}
                    />
                  </label>
                  <label>
                    {t("Model")}
                    <input
                      required
                      className={inputStyle}
                      value={form.model}
                      placeholder={SERVICE_META[service].defaultModel || t("Discovered automatically when available")}
                      onChange={(e) => setForms((c) => ({ ...c, [service]: { ...c[service], model: e.target.value } }))}
                    />
                  </label>
                  {finding?.model && finding.model !== form.model && (
                    <p role="status">
                      {t("Detected model: {0}", finding.model)}
                      <button
                        type="button"
                        onClick={() => setForms((c) => ({ ...c, [service]: { ...c[service], model: finding.model! } }))}
                      >
                        {t("Use detected")}
                      </button>
                    </p>
                  )}
                  {service === "embedding" && (
                    <>
                      <label>
                        {t("Dimensions")}
                        <input
                          required
                          type="number"
                          min="1"
                          className={inputStyle}
                          value={form.dimensions}
                          onChange={(e) => setForms((c) => ({ ...c, [service]: { ...c[service], dimensions: e.target.value } }))}
                        />
                      </label>
                      <label>
                        {t("API key (only if the endpoint requires one)")}
                        <input
                          type="password"
                          className={inputStyle}
                          value={form.apiKey}
                          placeholder={t("Leave blank unless the endpoint needs a key")}
                          onChange={(e) => setForms((c) => ({ ...c, [service]: { ...c[service], apiKey: e.target.value } }))}
                        />
                      </label>
                    </>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    <button type="button" disabled={testing[service]} onClick={() => void testEndpoint(service)}>
                      {t("Test endpoint")}
                    </button>
                    <button type="submit" disabled={busy}>
                      {t("Save & apply")}
                    </button>
                  </div>
                </form>
              )}
            </article>
          );
        })}
    </section>
  );
}

/** Historic alias: the dedicated local-services surface now renders the simplified panel. */
export const ProductLocalServices = ProductLocalServicesPanel;
