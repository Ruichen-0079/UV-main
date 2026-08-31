import { useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Field, Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { Badge } from "../components/ui/badge.js";
import {
  productClient,
  type LayeredValue,
  type ProductOverview
} from "./product-client.js";

const NAV = [
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
] as const;

type SectionId = (typeof NAV)[number]["id"];

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
  onReload(): Promise<void>;
  onCompanion(action: "show_companion" | "hide_companion" | "reopen_companion"): void;
}): JSX.Element {
  const [section, setSection] = useState<SectionId>("providers");
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
      { id: "deepseek", label: "DeepSeek", url: "DEEPSEEK_API_BASEURL", key: "DEEPSEEK_API_KEY", model: "DEEPSEEK_CHAT_MODEL" },
      {
        id: "openai-compatible",
        label: "OpenAI-compatible",
        url: "OPENAI_COMPATIBLE_API_BASEURL",
        key: "OPENAI_COMPATIBLE_API_KEY",
        model: "OPENAI_COMPATIBLE_CHAT_MODEL"
      },
      { id: "local", label: "Local llama.cpp / OpenAI-compatible", url: "LOCAL_MODEL_BASEURL", model: "LOCAL_CHAT_MODEL" },
      { id: "nvidia", label: "NVIDIA", url: "NVIDIA_API_BASEURL", key: "NVIDIA_API_KEY", model: "NVIDIA_CHAT_MODEL" }
    ],
    []
  );

  return (
    <div className="grid min-h-[70vh] grid-cols-[220px_1fr] overflow-hidden rounded-[18px] border border-[var(--yuvi-line)] bg-[var(--yuvi-bg-elevated)]">
      <nav className="border-r border-[var(--yuvi-line)] p-3">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`mb-1 w-full rounded-[12px] px-3 py-2 text-left text-sm ${
              section === item.id ? "bg-[var(--yuvi-accent-soft)] font-medium" : "text-[var(--yuvi-muted)]"
            }`}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="max-h-[78vh] overflow-auto p-6">
        {status ? <p className="mb-4 text-sm text-[var(--yuvi-muted)]">{status}</p> : null}

        {section === "general" ? (
          <div className="grid gap-3">
            <Switch
              label="Remember last page"
              checked={props.overview.preferences.general.rememberLastPage}
              onCheckedChange={(value) =>
                void productClient.savePreferences({ general: { rememberLastPage: value } }).then(props.onReload)
              }
            />
            <p className="text-sm text-[var(--yuvi-muted)]">
              Language and launch behavior stay local. No accounts.
            </p>
          </div>
        ) : null}

        {section === "providers" ? (
          <div className="grid gap-6">
            {providerFields.map((provider) => (
              <section key={provider.id} className="grid gap-3 rounded-[16px] border border-[var(--yuvi-line)] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{provider.label}</h3>
                  <Badge tone={layeredConfigured(settings[provider.key ?? ""] ) || layeredText(settings[provider.url]) ? "ok" : "idle"}>
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
                  <Field label="API key" hint="Saved keys stay masked. Leave blank to keep the current secret.">
                    <Input
                      type="password"
                      placeholder={layeredConfigured(settings[provider.key]) ? "•••• saved" : "Optional for local"}
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
                  <Button size="sm" disabled={busy} onClick={() => void save([provider.url, provider.key, provider.model].filter(Boolean) as string[])}>
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
                              : result.error ?? "Connection failed"
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
                      void productClient.discoverModels(provider.id).then((result) =>
                        setStatus(
                          result.ok
                            ? `Found ${result.models.length} models`
                            : result.error ?? "Discovery failed"
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

        {section === "routing" ? (
          <div className="grid gap-3">
            {props.overview.roles.map((role) => (
              <section key={role.id} className="rounded-[16px] border border-[var(--yuvi-line)] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{role.label}</h3>
                  <Badge tone={role.health.tone}>{role.health.summary}</Badge>
                </div>
                <p className="mt-2 text-sm text-[var(--yuvi-muted)]">{role.fallback ?? role.capability}</p>
              </section>
            ))}
            {props.overview.deferredRoles.map((role) => (
              <section key={role.id} className="rounded-[16px] border border-dashed border-[var(--yuvi-line)] p-4">
                <div className="flex items-center justify-between">
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
            <Button size="sm" disabled={busy} onClick={() => void save(["CHAT_PROVIDER_CHAIN", "REASONING_PROVIDER_CHAIN"])}>
              Save routing
            </Button>
          </div>
        ) : null}

        {section === "voice" ? (
          <VoiceSection
            settings={settings}
            onSave={save}
            onStatus={setStatus}
            busy={busy}
            setKey={setKey}
          />
        ) : null}

        {section === "vision" ? (
          <div className="grid gap-3">
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
            <Button size="sm" disabled={busy} onClick={() => void save(["VISION_PROVIDER_CHAIN", "XAI_VISION_MODEL"])}>
              Save vision
            </Button>
          </div>
        ) : null}

        {section === "memory" ? <MemorySection /> : null}
        {section === "mcp" ? <McpSection /> : null}

        {section === "companion" ? (
          <div className="grid gap-3">
            <p className="text-sm text-[var(--yuvi-muted)]">
              Companion rendering stays in the Lumi window. These controls only show, hide, or reopen it.
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

        {section === "appearance" ? (
          <div className="grid gap-3">
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
                void productClient.savePreferences({ appearance: { reducedMotion: value } }).then(props.onReload)
              }
            />
          </div>
        ) : null}

        {section === "advanced" ? (
          <div className="grid gap-3 text-sm text-[var(--yuvi-muted)]">
            <p>Effective values come from Environment, then local UI config, then defaults.</p>
            <p>Secrets are never returned in full. Restart-required keys stay visible as pending.</p>
            {props.overview.settings.runtime?.pendingRestart ? (
              <Badge tone="warn">Restart required: {(props.overview.settings.runtime.pendingRestartKeys ?? []).join(", ")}</Badge>
            ) : (
              <Badge tone="ok">No restart pending</Badge>
            )}
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
    <div className="grid gap-3">
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
              props.onStatus(result.ok ? "Voice test succeeded" : result.error ?? "Voice test failed");
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

function MemorySection(): JSX.Element {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  return (
    <div className="grid gap-3">
      <div className="flex gap-2">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memories" />
        <Button
          size="sm"
          onClick={() =>
            void productClient.memory(query).then((value) => setData(value as Record<string, unknown>))
          }
        >
          Search
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto rounded-[12px] bg-[var(--yuvi-bg)] p-3 text-xs">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

function McpSection(): JSX.Element {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  return (
    <div className="grid gap-3">
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          void productClient
            .capabilities()
            .then((value) => setData(value as Record<string, unknown>))
        }
      >
        Refresh discovery
      </Button>
      <pre className="max-h-80 overflow-auto rounded-[12px] bg-[var(--yuvi-bg)] p-3 text-xs">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
