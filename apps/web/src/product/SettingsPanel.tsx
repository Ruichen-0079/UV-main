import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Field, Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { Badge } from "../components/ui/badge.js";
import {
  productClient,
  type LayeredValue,
  type ProductCapabilitiesSurface,
  type ProductMemorySurface,
  type ProductOverview
} from "./product-client.js";
import type { SettingsSectionId } from "./product-hash.js";
import { capabilityNormalView, memoryNormalView } from "./product-surface-view.js";

const NAV: Array<{ id: SettingsSectionId; label: string }> = [
  { id: "general", label: "General" },
  { id: "providers", label: "Models & Providers" },
  { id: "routing", label: "AI Routing" },
  { id: "voice", label: "Voice" },
  { id: "vision", label: "Vision" },
  { id: "memory", label: "Memory" },
  { id: "mcp", label: "Capabilities" },
  { id: "companion", label: "Companion" },
  { id: "appearance", label: "Appearance" },
  { id: "advanced", label: "Advanced" }
];

function layeredText(value: LayeredValue | undefined): string {
  if (!value) return "";
  return "effective" in value ? value.effective : "";
}

function layeredConfigured(value: LayeredValue | undefined): boolean {
  if (!value) return false;
  return "effectiveConfigured" in value ? value.effectiveConfigured : Boolean(layeredText(value));
}

export function SettingsPanel(props: {
  overview: ProductOverview;
  section: SettingsSectionId;
  onSection(section: SettingsSectionId): void;
  onClose(): void;
  onReload(): Promise<void>;
  onCompanion(action: "show_companion" | "hide_companion" | "reopen_companion"): void;
}): JSX.Element {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const settings = props.overview.settings.settings;

  function setKey(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save(keys: string[]) {
    setBusy(true);
    setStatus(null);
    try {
      const values: Record<string, string | null> = {};
      for (const key of keys) {
        if (key in draft) values[key] = draft[key] ?? "";
      }
      const result = await productClient.saveConnections(values);
      setStatus(result.message);
      await props.onReload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const providerFields = useMemo(
    () => [
      {
        id: "deepseek",
        label: "DeepSeek",
        url: "DEEPSEEK_API_BASEURL",
        key: "DEEPSEEK_API_KEY",
        model: "DEEPSEEK_CHAT_MODEL"
      },
      {
        id: "openai-compatible",
        label: "OpenAI-compatible",
        url: "OPENAI_COMPATIBLE_API_BASEURL",
        key: "OPENAI_COMPATIBLE_API_KEY",
        model: "OPENAI_COMPATIBLE_CHAT_MODEL"
      },
      {
        id: "local",
        label: "Local llama.cpp / OpenAI-compatible",
        url: "LOCAL_MODEL_BASEURL",
        model: "LOCAL_CHAT_MODEL"
      },
      {
        id: "nvidia",
        label: "NVIDIA",
        url: "NVIDIA_API_BASEURL",
        key: "NVIDIA_API_KEY",
        model: "NVIDIA_CHAT_MODEL"
      }
    ],
    []
  );

  return (
    <div className="yuvi-settings">
      <nav className="yuvi-settings-nav">
        <div className="yuvi-settings-nav-title">Settings</div>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`yuvi-settings-nav-item ${props.section === item.id ? "is-active" : ""}`}
            onClick={() => props.onSection(item.id)}
          >
            {item.label}
          </button>
        ))}
        <div className="mt-auto pt-3">
          <Button variant="secondary" size="sm" className="w-full" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </nav>
      <div className="yuvi-settings-body">
        {status ? <p className="mb-4 text-sm text-[var(--yuvi-muted)]">{status}</p> : null}

        {props.section === "general" ? (
          <div className="grid max-w-xl gap-3">
            <h2 className="text-lg font-semibold">General</h2>
            <Switch
              label="Remember last page"
              checked={props.overview.preferences.general.rememberLastPage}
              onCheckedChange={(value) =>
                void productClient
                  .savePreferences({ general: { rememberLastPage: value } })
                  .then(props.onReload)
              }
            />
            <p className="text-sm text-[var(--yuvi-muted)]">
              Language and launch behavior stay local. No accounts.
            </p>
          </div>
        ) : null}

        {props.section === "providers" ? (
          <div className="grid gap-5">
            <h2 className="text-lg font-semibold">Models &amp; Providers</h2>
            {providerFields.map((provider) => (
              <section key={provider.id} className="yuvi-card grid gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">{provider.label}</h3>
                  <Badge
                    tone={
                      layeredConfigured(settings[provider.key ?? ""]) ||
                      layeredText(settings[provider.url])
                        ? "ok"
                        : "idle"
                    }
                  >
                    {layeredConfigured(settings[provider.key ?? ""]) ? "Key saved" : "No key"}
                  </Badge>
                </div>
                <Field label="Base URL">
                  <Input
                    defaultValue={layeredText(settings[provider.url])}
                    onChange={(event) => setKey(provider.url, event.target.value)}
                  />
                </Field>
                {provider.key ? (
                  <Field
                    label="API key"
                    hint="Saved keys stay masked. Leave blank to keep the current secret."
                  >
                    <Input
                      type="password"
                      placeholder={
                        layeredConfigured(settings[provider.key])
                          ? "•••• saved"
                          : "Optional for local"
                      }
                      onChange={(event) => setKey(provider.key!, event.target.value)}
                    />
                  </Field>
                ) : null}
                {provider.model ? (
                  <Field label="Model">
                    <Input
                      defaultValue={layeredText(settings[provider.model])}
                      onChange={(event) => setKey(provider.model!, event.target.value)}
                    />
                  </Field>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void save(
                        [provider.url, provider.key, provider.model].filter(Boolean) as string[]
                      )
                    }
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void productClient
                        .testConnection(provider.id)
                        .then((result) =>
                          setStatus(
                            result.ok
                              ? `Connected in ${result.latencyMs}ms`
                              : (result.error ?? "Connection failed")
                          )
                        )
                    }
                  >
                    Test connection
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void productClient
                        .discoverModels(provider.id)
                        .then((result) =>
                          setStatus(
                            result.ok
                              ? `Found ${result.models.length} models`
                              : (result.error ?? "Discovery failed")
                          )
                        )
                    }
                  >
                    Discover models
                  </Button>
                </div>
              </section>
            ))}
          </div>
        ) : null}

        {props.section === "routing" ? (
          <div className="grid max-w-2xl gap-3">
            <h2 className="text-lg font-semibold">AI Routing</h2>
            {props.overview.roles.map((role) => (
              <section key={role.id} className="yuvi-card">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">{role.label}</h3>
                  <Badge tone={role.health.tone}>{role.health.summary}</Badge>
                </div>
                <p className="mt-2 text-sm text-[var(--yuvi-muted)]">
                  {role.fallback ?? role.capability}
                </p>
              </section>
            ))}
            {props.overview.deferredRoles.map((role) => (
              <section key={role.id} className="yuvi-card yuvi-card-dashed">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">{role.label}</h3>
                  <Badge>Deferred</Badge>
                </div>
                <p className="mt-2 text-sm text-[var(--yuvi-muted)]">
                  Intended: {role.intended}. {role.reason}
                </p>
              </section>
            ))}
            <Field label="Chat provider chain">
              <Input
                defaultValue={layeredText(settings["CHAT_PROVIDER_CHAIN"])}
                onChange={(event) => setKey("CHAT_PROVIDER_CHAIN", event.target.value)}
              />
            </Field>
            <Field label="Reasoning provider chain">
              <Input
                defaultValue={layeredText(settings["REASONING_PROVIDER_CHAIN"])}
                onChange={(event) => setKey("REASONING_PROVIDER_CHAIN", event.target.value)}
              />
            </Field>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void save(["CHAT_PROVIDER_CHAIN", "REASONING_PROVIDER_CHAIN"])}
            >
              Save routing
            </Button>
          </div>
        ) : null}

        {props.section === "voice" ? (
          <VoiceSection
            settings={settings}
            onSave={save}
            onStatus={setStatus}
            busy={busy}
            setKey={setKey}
          />
        ) : null}

        {props.section === "vision" ? (
          <div className="grid max-w-xl gap-3">
            <h2 className="text-lg font-semibold">Vision</h2>
            <Field label="Vision chain">
              <Input
                defaultValue={layeredText(settings["VISION_PROVIDER_CHAIN"])}
                onChange={(event) => setKey("VISION_PROVIDER_CHAIN", event.target.value)}
              />
            </Field>
            <Field label="xAI vision model">
              <Input
                defaultValue={layeredText(settings["XAI_VISION_MODEL"])}
                onChange={(event) => setKey("XAI_VISION_MODEL", event.target.value)}
              />
            </Field>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void save(["VISION_PROVIDER_CHAIN", "XAI_VISION_MODEL"])}
            >
              Save vision
            </Button>
          </div>
        ) : null}

        {props.section === "memory" ? <MemorySection overview={props.overview} /> : null}
        {props.section === "mcp" ? <McpSection /> : null}

        {props.section === "companion" ? (
          <div className="grid max-w-xl gap-3">
            <h2 className="text-lg font-semibold">Companion</h2>
            <p className="text-sm text-[var(--yuvi-muted)]">
              Companion rendering stays in the Lumi window. These controls only show, hide, or
              reopen it.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => props.onCompanion("show_companion")}>
                Show Lumi
              </Button>
              <Button variant="secondary" onClick={() => props.onCompanion("hide_companion")}>
                Hide Lumi
              </Button>
              <Button variant="secondary" onClick={() => props.onCompanion("reopen_companion")}>
                Reopen
              </Button>
            </div>
          </div>
        ) : null}

        {props.section === "appearance" ? (
          <div className="grid max-w-xl gap-3">
            <h2 className="text-lg font-semibold">Appearance</h2>
            <Field label="Theme">
              <select
                className="h-10 rounded-[12px] border border-[var(--yuvi-line)] bg-[var(--yuvi-bg-elevated)] px-3"
                defaultValue={props.overview.preferences.appearance.theme}
                onChange={(event) =>
                  void productClient
                    .savePreferences({ appearance: { theme: event.target.value } })
                    .then(props.onReload)
                }
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </select>
            </Field>
            <Switch
              label="Reduced motion"
              checked={props.overview.preferences.appearance.reducedMotion}
              onCheckedChange={(value) =>
                void productClient
                  .savePreferences({ appearance: { reducedMotion: value } })
                  .then(props.onReload)
              }
            />
          </div>
        ) : null}

        {props.section === "advanced" ? (
          <div className="grid max-w-xl gap-3 text-sm">
            <h2 className="text-lg font-semibold">Advanced</h2>
            <p className="text-[var(--yuvi-muted)]">
              Effective values come from Environment, then local UI config, then defaults.
            </p>
            <p className="text-[var(--yuvi-muted)]">
              Secrets are never returned in full. Restart-required keys stay visible as pending.
            </p>
            {props.overview.settings.runtime?.pendingRestart ? (
              <Badge tone="warn">
                Restart required:{" "}
                {(props.overview.settings.runtime.pendingRestartKeys ?? []).join(", ")}
              </Badge>
            ) : (
              <Badge tone="ok">No restart pending</Badge>
            )}
            <section className="yuvi-card">
              <h3 className="font-semibold">Developer dashboard</h3>
              <p className="mt-1 text-[var(--yuvi-muted)]">
                Internal console for traces and memory tables. It is not the daily companion.
              </p>
              <Button
                className="mt-3"
                size="sm"
                variant="secondary"
                onClick={() => {
                  window.location.hash = "#/dashboard";
                }}
              >
                Open developer dashboard
              </Button>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VoiceSection(props: {
  settings: Record<string, LayeredValue>;
  setKey(key: string, value: string): void;
  onSave(keys: string[]): Promise<void>;
  onStatus(value: string): void;
  busy: boolean;
}): JSX.Element {
  return (
    <div className="grid max-w-xl gap-3">
      <h2 className="text-lg font-semibold">Voice / Alice</h2>
      <Field label="TTS chain">
        <Input
          defaultValue={layeredText(props.settings["TTS_PROVIDER_CHAIN"])}
          onChange={(event) => props.setKey("TTS_PROVIDER_CHAIN", event.target.value)}
        />
      </Field>
      <Field label="Alice GPT-SoVITS URL">
        <Input
          defaultValue={layeredText(props.settings["GPT_SOVITS_TTS_BASE_URL"])}
          onChange={(event) => props.setKey("GPT_SOVITS_TTS_BASE_URL", event.target.value)}
        />
      </Field>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={props.busy}
          onClick={() => void props.onSave(["TTS_PROVIDER_CHAIN", "GPT_SOVITS_TTS_BASE_URL"])}
        >
          Save voice
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void productClient.testVoice().then((result) => {
              props.onStatus(
                result.ok ? "Voice test succeeded" : (result.error ?? "Voice test failed")
              );
              if (result.ok && result.audioBase64 && result.mimeType) {
                const audio = new Audio(`data:${result.mimeType};base64,${result.audioBase64}`);
                void audio.play().catch(() => undefined);
              }
            })
          }
        >
          Test voice
        </Button>
      </div>
    </div>
  );
}

function MemorySection(props: { overview: ProductOverview }): JSX.Element {
  const [query, setQuery] = useState("");
  const [surface, setSurface] = useState<ProductMemorySurface | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  async function load(nextQuery: string) {
    try {
      setLoadError(undefined);
      const value = await productClient.memory(nextQuery);
      setSurface(value);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Memory is unavailable.");
    }
  }

  useEffect(() => {
    void load("");
  }, []);

  const memoryHealth = props.overview.compactHealth.find((item) => item.id === "memory");
  const view = memoryNormalView({
    overview: props.overview.memory,
    surface,
    memoryHealth,
    loadError
  });
  const alertTone =
    view.overall.tone === "bad" ||
    view.epistemic === "error" ||
    view.epistemic === "unavailable" ||
    view.epistemic === "partial";

  return (
    <div className="grid max-w-2xl gap-4">
      <h2 className="text-lg font-semibold">Memory</h2>
      <section className={`yuvi-card ${alertTone ? "yuvi-card-alert" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-[var(--yuvi-muted)]">
              Overall status
            </div>
            <div className="text-base font-semibold">{view.overall.summary}</div>
          </div>
          <Badge tone={view.overall.tone}>{view.overall.summary}</Badge>
        </div>
        <p className="mt-2 text-sm text-[var(--yuvi-muted)]">{view.overall.detail}</p>
        {view.loadError ? (
          <p className="mt-2 text-sm text-[var(--yuvi-bad)]" role="alert">
            {view.loadError}
          </p>
        ) : null}
      </section>

      <div className="grid gap-3 md:grid-cols-3">
        {view.layers.map((layer) => (
          <section key={layer.id} className="yuvi-card">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">
                {layer.id} · {layer.name}
              </h3>
            </div>
            <p className="mt-1 text-xs text-[var(--yuvi-muted)]">{layer.countLabel}</p>
            <p className="mt-2 text-sm">{layer.summary}</p>
            {layer.items.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm">
                {layer.items.map((item) => (
                  <li key={item.id} className="truncate" title={item.title}>
                    {item.title}
                    {item.meta ? (
                      <span className="text-[var(--yuvi-muted)]"> · {item.meta}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="yuvi-card">
          <div className="text-xs uppercase tracking-wide text-[var(--yuvi-muted)]">
            Recent episodes
          </div>
          <div className="mt-1 text-lg font-semibold">{view.episodeCount}</div>
        </section>
        <section className="yuvi-card">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs uppercase tracking-wide text-[var(--yuvi-muted)]">
                Durable memory
              </div>
              <div className="mt-1 text-lg font-semibold">
                {view.query ? view.durableCount : "—"}
              </div>
            </div>
            <Badge tone={view.durableTone}>{view.durableStatus}</Badge>
          </div>
        </section>
      </div>

      <section className="yuvi-card">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Dream</h3>
          <Badge tone={view.dream.operational ? "ok" : "idle"}>
            {view.dream.operational ? "Active" : "Not runtime-active"}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-[var(--yuvi-muted)]">{view.dream.status}</p>
        <p className="mt-1 text-sm">Due jobs: {view.dream.dueJobCount}</p>
      </section>

      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search durable memories"
          onKeyDown={(event) => {
            if (event.key === "Enter") void load(query);
          }}
        />
        <Button size="sm" onClick={() => void load(query)}>
          Search
        </Button>
      </div>

      <details
        className="yuvi-advanced"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary>Advanced details</summary>
        <dl className="mt-3 grid gap-2 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--yuvi-muted)]">Backend</dt>
            <dd>{view.backend}</dd>
          </div>
          {view.extractor ? (
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--yuvi-muted)]">
                Extractor
              </dt>
              <dd>{view.extractor}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs uppercase tracking-wide text-[var(--yuvi-muted)]">
              Compression
            </dt>
            <dd>
              {props.overview.memory.compression.classification}
              {props.overview.memory.compression.operational ? "" : " · not runtime-active"}
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

function McpSection(): JSX.Element {
  const [data, setData] = useState<ProductCapabilitiesSurface | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    void productClient
      .capabilities()
      .then((value) => {
        setLoadError(undefined);
        setData(value);
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Capability discovery failed.");
      });
  }, []);

  const view = capabilityNormalView(data);

  return (
    <div className="grid max-w-2xl gap-4">
      <h2 className="text-lg font-semibold">Capabilities</h2>
      <section className="yuvi-card">
        <p className="text-sm">{view.notice}</p>
        <p className="mt-2 text-xs text-[var(--yuvi-muted)]">
          This page observes the static allowlist. It does not add or edit MCP servers.
        </p>
      </section>
      {loadError ? (
        <p className="text-sm text-[var(--yuvi-bad)]" role="alert">
          {loadError}
        </p>
      ) : null}
      <div className="yuvi-table">
        <div className="yuvi-table-head">
          <span>Capability</span>
          <span>Status</span>
          <span>Description</span>
        </div>
        {view.rows.length === 0 && !loadError ? (
          <div className="px-3 py-4 text-sm text-[var(--yuvi-muted)]">Loading allowlist…</div>
        ) : (
          view.rows.map((row) => (
            <div key={row.capabilityRef} className="yuvi-table-row">
              <div>
                <div className="font-medium">{row.name}</div>
                <div className="text-xs text-[var(--yuvi-muted)]">{row.capabilityRef}</div>
              </div>
              <div>
                <Badge>{row.status}</Badge>
              </div>
              <div className="text-sm text-[var(--yuvi-muted)]">{row.description}</div>
            </div>
          ))
        )}
      </div>
      {data ? (
        <details className="yuvi-advanced">
          <summary>Advanced details</summary>
          <dl className="mt-3 grid gap-2 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--yuvi-muted)]">
                Authority
              </dt>
              <dd>{data.authority}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-[var(--yuvi-muted)]">
                Allowlist version
              </dt>
              <dd>{data.version}</dd>
            </div>
          </dl>
        </details>
      ) : null}
    </div>
  );
}
