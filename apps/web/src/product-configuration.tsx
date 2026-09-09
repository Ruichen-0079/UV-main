import { useEffect, useRef, useState } from "react";
import { request, productSample, apiClient } from "./api/client.js";
import { releaseMicrophoneCapture, startMicrophoneCapture, stopMicrophoneCapture, type ActiveAudioCapture } from "./audio-capture.js";
import { t } from "./locale.js";
const capabilities = ["chat", "reasoning", "proactive", "embedding", "vision", "stt", "tts"] as const;
type Capability = typeof capabilities[number];
const labels: Record<Capability, string> = { chat: "Chat", reasoning: "Reasoning", proactive: "Proactive", embedding: "Embedding", vision: "Vision", stt: "STT", tts: "TTS" };
const adapters: Record<string, Capability[]> = { "openai-compatible": ["chat", "reasoning", "proactive", "embedding", "vision"], "local-stt": ["stt"], dashscope: ["stt"], "xai-tts": ["tts"], "dots-tts": ["tts"], "gpt-sovits": ["tts"] };
type Provider = { id: string; displayName: string; baseUrl: string; adapter: string; apiKey?: string | undefined; hasApiKey?: boolean };
type Model = { id: string; providerId: string; displayName: string; modelId: string; temperature: number; contextWindow: number | null; capabilities: Capability[]; enabled: boolean; dimensions?: number; voice?: string | undefined; continuationFormat?: "deepseek-v4" };
type Configuration = { version: 1; providers: Provider[]; models: Model[]; routes: Record<Capability, string[]> };
type Person = { id: string; displayName: string; personaId: string; notes: string };
type Snapshot = { configuration: Configuration; people: Person[]; primaryPersonId: string | null; proactive: { threshold: number; intervalMs: number }; revision: number; routes: Record<Capability, { state: string; modelIds: string[] }>; conversationalReady: boolean; applyState: string; voiceAvailable: boolean; proactiveState: { suppression: { kind: string }; eligibleAfterMs: number } };
type Voices = { available: boolean; voices: { id: string; label: string; personId: string | null; sampleId?: string }[]; unknown: { id: string; leftUnknown?: boolean }[] };
type PersonDraft = { id: string; displayName: string; notes: string };
type ProfileEvidenceState = "STORED" | "UNAVAILABLE" | "APPLY_FAILED";
type PersonSaveResponse = Snapshot & {
  personId: string;
  profileEvidence: ProfileEvidenceState;
  message: string;
};
const emptyPersonDraft = (): PersonDraft => ({ id: "", displayName: "", notes: "" });
const emptyProvider = (): Provider => ({ id: crypto.randomUUID(), displayName: "", baseUrl: "", adapter: "openai-compatible" });
const emptyModel = (providerId: string): Model => ({ id: crypto.randomUUID(), providerId, displayName: "", modelId: "", temperature: .7, contextWindow: null, capabilities: [], enabled: true });
export function reorderRoute(route: string[], index: number, direction: -1 | 1): string[] { const next = [...route]; const target = index + direction; if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target]!, next[index]!]; return next; }
const send = <T,>(path: string, body?: unknown, method = "POST") => request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export type ProductConfigurationSection =
  | "status"
  | "providers"
  | "models"
  | "routes"
  | "proactive"
  | "people"
  | "voices";

const allProductConfigurationSections: readonly ProductConfigurationSection[] = [
  "status",
  "providers",
  "models",
  "routes",
  "proactive",
  "people",
  "voices"
];

export function ProductConfigurationPanel(props: {
  sections?: readonly ProductConfigurationSection[];
} = {}): JSX.Element {
  const visibleSections = new Set(props.sections ?? allProductConfigurationSections);
  const show = (section: ProductConfigurationSection): boolean => visibleSections.has(section);
  const showVoices = show("voices");
  const [state, setState] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [proactive, setProactive] = useState({ threshold: .7, intervalMs: 60000 });
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<Provider>(emptyProvider);
  const [model, setModel] = useState<Model>(() => emptyModel(""));
  const [discovered, setDiscovered] = useState<{ modelId: string; contextWindow: number | null }[]>([]);
  const [selfProfile, setSelfProfile] = useState<PersonDraft>(emptyPersonDraft);
  const [otherPerson, setOtherPerson] = useState<PersonDraft>(emptyPersonDraft);
  const [editingOther, setEditingOther] = useState(false);
  const [profileEvidence, setProfileEvidence] = useState<{ personId: string; state: ProfileEvidenceState } | null>(null);
  const [voices, setVoices] = useState<Voices>({ available: false, voices: [], unknown: [] });
  const [enrollPerson, setEnrollPerson] = useState(""); const [replaceVoiceId, setReplaceVoiceId] = useState<string | undefined>();
  const [recordings, setRecordings] = useState<string[]>([]); const [recording, setRecording] = useState(false);
  const capture = useRef<ActiveAudioCapture | null>(null); const timer = useRef<ReturnType<typeof setTimeout>>();
  const player = useRef<HTMLAudioElement | null>(null); const sampleUrl = useRef<string>();
  async function refresh() {
    const next = await request<Snapshot>("/product/configuration"); setState(next); setDraft(next.configuration); setProactive(next.proactive);
    setEnrollPerson(v => next.people.some(p => p.id === v) ? v : "");
    const primary = next.people.find(p => p.id === next.primaryPersonId);
    setSelfProfile(primary ? { id: primary.id, displayName: primary.displayName, notes: primary.notes } : emptyPersonDraft());
    if (showVoices) {
      try { setVoices(await request<Voices>("/product/voices")); } catch { setNotice(t("Voice profiles are unavailable. Check local speaker recognition and Memory.")); }
    }
  }
  useEffect(() => { void refresh().catch(e => setNotice(String(e))); return () => { clearTimeout(timer.current); releaseMicrophoneCapture(capture.current); player.current?.pause(); if (sampleUrl.current) URL.revokeObjectURL(sampleUrl.current); }; }, [showVoices]);
  async function act(work: () => Promise<unknown>, message = t("Saved. Effective state refreshed.")) { setBusy(true); setNotice(""); try { const result = await work(); await refresh(); setNotice(result && typeof result === "object" && "message" in result ? String(result.message) : message); return true; } catch (e) { setNotice(e instanceof Error ? e.message : t("Action failed.")); return false; } finally { setBusy(false); } }
  async function save(configuration = draft) { if (!state || !configuration) return; return act(() => send("/product/configuration", { configuration, revision: state.revision, proactive }, "PUT")); }
  function changeRoute(cap: Capability, ids: string[]) { if (draft) setDraft({ ...draft, routes: { ...draft.routes, [cap]: ids } }); }
  async function finishRecording() {
    clearTimeout(timer.current); const active = capture.current; capture.current = null; if (!active) return;
    try { const audio = await stopMicrophoneCapture(active); setRecordings(old => [...old, audio.audioBase64].slice(0, 5)); } catch { setNotice(t("Recording failed. Check microphone permission.")); } finally { setRecording(false); }
  }
  async function beginRecording() { try { capture.current = await startMicrophoneCapture(); setRecording(true); timer.current = setTimeout(() => void finishRecording(), 8000); } catch { setNotice(t("Microphone unavailable.")); } }
  async function play(id: string) { try { player.current?.pause(); if (sampleUrl.current) URL.revokeObjectURL(sampleUrl.current); sampleUrl.current = URL.createObjectURL(await productSample(id)); player.current = new Audio(sampleUrl.current); await player.current.play(); } catch { setNotice(t("Sample unavailable or deleted.")); } }
  async function savePersonProfile(draft: PersonDraft, primary: boolean) {
    let savedResult: PersonSaveResponse | undefined;
    const ok = await act(async () => {
      savedResult = await send<PersonSaveResponse>("/product/people", {
        displayName: draft.displayName,
        notes: draft.notes,
        primary,
        ...(draft.id ? { id: draft.id } : {})
      });
      return savedResult;
    });
    if (ok && savedResult) {
      setProfileEvidence({ personId: savedResult.personId, state: savedResult.profileEvidence });
      if (!primary) {
        setEditingOther(false);
        setOtherPerson(emptyPersonDraft());
      }
    }
  }
  function startEnrollment(personId: string, replaceVoiceId?: string) {
    setEnrollPerson(personId);
    setReplaceVoiceId(replaceVoiceId);
    setRecordings([]);
  }
  async function finishEnrollment() {
    if (!enrollPerson) return;
    const ok = await act(
      () => send("/product/voices/enroll", { personId: enrollPerson, recordings, replaceVoiceId }),
      t("Voice enrolled and linked to this person.")
    );
    if (ok) {
      setEnrollPerson("");
      setReplaceVoiceId(undefined);
      setRecordings([]);
    }
  }
  const inputStyle = "rounded border p-2 bg-transparent w-full";
  const primaryPerson = state?.people.find(p => p.id === state.primaryPersonId);
  const knownPeople = state?.people.filter(p => p.id !== state.primaryPersonId) ?? [];
  const voiceProfilesFor = (personId: string) => voices.voices.filter(v => v.personId === personId);
  const evidenceLabel = (personId: string) => {
    if (profileEvidence?.personId !== personId) return null;
    if (profileEvidence.state === "STORED") return t("Memory: profile saved");
    if (profileEvidence.state === "UNAVAILABLE") return t("Memory: unavailable; profile is still saved locally");
    return t("Memory: profile evidence write failed");
  };
  return <section className="yuvi-configuration grid gap-5" aria-label={t("Product configuration")}>
    {show("status") && <header className="yuvi-card grid gap-2"><h1>{t("Provider → Model → Capability Route")}</h1><p>{t("Chat is the only conversation requirement. Optional capabilities can stay NOT_CONFIGURED.")}</p>
      <p role="status">{state ? t("Conversation: {0} · Apply: {1}", state.conversationalReady ? t("ready") : t("set up Chat"), state.applyState) : t("Loading configuration…")}</p>
      {state?.applyState === "RESTART_REQUIRED" && <p>{t("Saved changes need a Runtime restart. Current effective routes remain shown below. Restart YUVI to apply them.")}</p>}
      {state?.applyState === "APPLY_FAILED" && <p>{t("Settings were saved, but Runtime could not apply them. Fix the configuration and retry Save & apply.")}</p>}
      {notice && <p role="alert">{notice}</p>}
      <label>{t("Dashboard token (if configured)")}<input className={inputStyle} type="password" onChange={e => apiClient.setDashboardDevToken(e.target.value)} /></label><button onClick={() => void refresh().catch(e => setNotice(String(e)))}>{t("Reload saved and effective settings")}</button>
    </header>}
    {!show("status") && notice && <p className="yuvi-card" role="alert">{notice}</p>}
    {draft && state && <>
      {show("providers") && <section className="yuvi-card grid gap-3"><h2>{t("Providers")}</h2>
        {draft.providers.map(p => <div key={p.id} className="flex gap-2 flex-wrap"><strong>{p.displayName}</strong><span>{p.baseUrl}</span><button disabled={busy} onClick={() => setProvider({ ...p, apiKey: undefined })}>{t("Edit provider")}</button><button disabled={busy} onClick={() => { const ids = draft.models.filter(m => m.providerId === p.id).map(m => m.id); void save({ ...draft, providers: draft.providers.filter(x => x.id !== p.id), models: draft.models.filter(m => m.providerId !== p.id), routes: Object.fromEntries(capabilities.map(c => [c, draft.routes[c].filter(id => !ids.includes(id))])) as Configuration["routes"] }); }}>{t("Delete provider")}</button><button disabled={busy} onClick={() => void act(async () => { const result = await send<{ message: string; models?: typeof discovered }>(`/product/providers/${p.id}/test`); setDiscovered(result.models ?? []); setModel(emptyModel(p.id)); return result; }, t("Connection test completed. Discovered models appear below; manual IDs are always available."))}>{t("Test connection / discover models")}</button></div>)}
        <form className="grid gap-2" onSubmit={e => { e.preventDefault(); void save({ ...draft, providers: [...draft.providers.filter(p => p.id !== provider.id), provider] }).then(ok => { if (ok) setProvider(emptyProvider()); }); }}>
          <label>{t("Provider display name")}<input required className={inputStyle} value={provider.displayName} onChange={e => setProvider({ ...provider, displayName: e.target.value })} /></label>
          <label>{t("Adapter")}<select className={inputStyle} value={provider.adapter} onChange={e => setProvider({ ...provider, adapter: e.target.value })}>{Object.keys(adapters).map(a => <option key={a}>{a}</option>)}</select></label>
          <label>{t("Base URL")}<input required type="url" className={inputStyle} value={provider.baseUrl} onChange={e => setProvider({ ...provider, baseUrl: e.target.value })} placeholder="http://localhost:8000/v1" /></label>
          <label>{t("API key (optional; blank untouched retains saved key)")}<input type="password" className={inputStyle} value={provider.apiKey ?? ""} onChange={e => setProvider({ ...provider, apiKey: e.target.value })} /></label><button type="button" onClick={() => setProvider({ ...provider, apiKey: "" })}>{t("Clear API key")}</button><button disabled={busy}>{t("Save provider & apply")}</button>
        </form>
      </section>}
      {show("models") && <section className="yuvi-card grid gap-3"><h2>{t("Models")}</h2>
        {draft.models.map(m => <div key={m.id} className="flex gap-2"><strong>{m.displayName}</strong><span>{m.modelId} · {m.enabled ? t("Enabled") : t("Disabled")}</span><button onClick={() => setModel(m)}>{t("Edit model")}</button><button disabled={busy} onClick={() => void save({ ...draft, models: draft.models.filter(x => x.id !== m.id), routes: Object.fromEntries(capabilities.map(c => [c, draft.routes[c].filter(id => id !== m.id)])) as Configuration["routes"] })}>{t("Delete model")}</button></div>)}
        <form className="grid gap-2" onSubmit={e => { e.preventDefault(); const routes = Object.fromEntries(capabilities.map(c => [c, draft.routes[c].filter(id => id !== model.id || (model.enabled && model.capabilities.includes(c)))])) as Configuration["routes"]; void save({ ...draft, models: [...draft.models.filter(m => m.id !== model.id), model], routes }).then(ok => { if (ok) setModel(emptyModel(model.providerId)); }); }}>
          <label>{t("Provider")}<select required className={inputStyle} value={model.providerId} onChange={e => { setModel({ ...model, providerId: e.target.value, capabilities: [] }); setDiscovered([]); }}><option value="">{t("Select provider")}</option>{draft.providers.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          {discovered.length > 0 && <label>{t("Discovered model")}<select className={inputStyle} value="" onChange={e => { const m = discovered.find(m => m.modelId === e.target.value); if (m) setModel({ ...model, modelId: m.modelId, displayName: m.modelId, contextWindow: m.contextWindow }); }}><option value="">{t("Choose a discovered model")}</option>{discovered.map(m => <option key={m.modelId}>{m.modelId}</option>)}</select></label>}
          <label>{t("Model display name")}<input required className={inputStyle} value={model.displayName} onChange={e => setModel({ ...model, displayName: e.target.value })} /></label><label>{t("Model ID (manual fallback)")}<input required className={inputStyle} value={model.modelId} onChange={e => setModel({ ...model, modelId: e.target.value })} /></label>
          <label>{t("Temperature")}<input type="number" min="0" max="2" step="0.05" className={inputStyle} value={model.temperature} onChange={e => setModel({ ...model, temperature: Number(e.target.value) })} /></label><label>{t("Context window (blank = unknown)")}<input type="number" min="1024" className={inputStyle} value={model.contextWindow ?? ""} onChange={e => setModel({ ...model, contextWindow: e.target.value ? Number(e.target.value) : null })} /></label>
          <fieldset><legend>{t("Declared compatible capabilities — confirm against the model documentation")}</legend>{(adapters[draft.providers.find(p => p.id === model.providerId)?.adapter ?? ""] ?? []).map(c => <label className="mr-4" key={c}><input type="checkbox" checked={model.capabilities.includes(c)} onChange={e => setModel({ ...model, capabilities: e.target.checked ? [...model.capabilities, c] : model.capabilities.filter(x => x !== c) })} />{labels[c]}</label>)}</fieldset>
          {model.capabilities.includes("embedding") && <label>{t("Embedding dimensions (required)")}<input required type="number" min="1" value={model.dimensions ?? ""} onChange={e => setModel({ ...model, dimensions: Number(e.target.value) })} /></label>}
          {model.capabilities.includes("tts") && <label>{t("Voice")}<input value={model.voice ?? ""} onChange={e => setModel({ ...model, voice: e.target.value || undefined })} /></label>}
          <label><input type="checkbox" checked={model.enabled} onChange={e => setModel({ ...model, enabled: e.target.checked })} />{t("Enabled model")}</label><button disabled={busy}>{t("Save model & apply")}</button>
        </form>
      </section>}
      {show("routes") && <section className="yuvi-card grid gap-3"><h2>{t("Capability routes")}</h2><p>{t("Order is fallback order. Removing every model leaves that capability NOT_CONFIGURED.")}</p><div className="grid gap-3 md:grid-cols-2">{capabilities.map(c => <article className="rounded border p-3" key={c} aria-label={t("{0} route", t(labels[c]))}><h3>{t(labels[c])} · {state.routes[c].state}</h3><p>{t("Effective")}: {state.routes[c].modelIds.map(id => state.configuration.models.find(m => m.id === id)?.displayName ?? id).join(" → ") || t("None")}</p><ol>{draft.routes[c].map((id, i) => <li key={id}>{draft.models.find(m => m.id === id)?.displayName}<button aria-label={t("Move {0} model up", t(labels[c]))} disabled={i === 0} onClick={() => changeRoute(c, reorderRoute(draft.routes[c], i, -1))}>↑</button><button aria-label={t("Move {0} model down", t(labels[c]))} disabled={i === draft.routes[c].length - 1} onClick={() => changeRoute(c, reorderRoute(draft.routes[c], i, 1))}>↓</button><button onClick={() => changeRoute(c, draft.routes[c].filter(m => m !== id))}>{t("Remove from route")}</button></li>)}</ol><label>{t("Add compatible model")}<select value="" onChange={e => changeRoute(c, [...draft.routes[c], e.target.value])}><option value="">{t("Select model")}</option>{draft.models.filter(m => m.enabled && m.capabilities.includes(c) && !draft.routes[c].includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></label></article>)}</div><button disabled={busy} onClick={() => void save()}>{t("Save routes & apply")}</button></section>}
      {show("proactive") && <section className="yuvi-card grid gap-3"><h2>{t("Proactive")}</h2><label>{t("Eagerness")}<input type="range" min="0" max="1" step=".05" value={1 - proactive.threshold} onChange={e => setProactive({ ...proactive, threshold: 1 - Number(e.target.value) })} /></label><p>{t("Speak-score threshold: {0}. A low score skips only the current evaluation.", proactive.threshold.toFixed(2))}</p><label>{t("Evaluation interval (seconds)")}<input type="number" min="1" max="86400" value={proactive.intervalMs / 1000} onChange={e => setProactive({ ...proactive, intervalMs: Number(e.target.value) * 1000 })} /></label><p>{t("Suppression")}: {state.proactiveState.suppression.kind} · {t("Quiet until")}: {state.proactiveState.eligibleAfterMs > Date.now() ? new Date(state.proactiveState.eligibleAfterMs).toLocaleString() : t("No timed quiet period")}</p><button disabled={busy} onClick={() => void act(() => send("/product/proactive/resume"))}>{t("Resume now")}</button><button disabled={busy} onClick={() => void save()}>{t("Save proactive controls & apply")}</button></section>}
      {show("people") && <section className="yuvi-card grid gap-4">
        <div>
          <h2>{t("My profile")}</h2>
          <p>{t("This is the person YUVI treats as you. Your name and notes become explicit long-term identity evidence when Memory is available.")}</p>
        </div>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); void savePersonProfile(selfProfile, true); }}>
          <label>{t("Name")}<input required className={inputStyle} value={selfProfile.displayName} onChange={e => setSelfProfile({ ...selfProfile, displayName: e.target.value })} /></label>
          <label>{t("About me (optional)")}<textarea className={inputStyle} value={selfProfile.notes} onChange={e => setSelfProfile({ ...selfProfile, notes: e.target.value })} /></label>
          <div className="flex gap-2 flex-wrap">
            <button disabled={busy}>{t("Save my profile")}</button>
            {primaryPerson && showVoices ? <button type="button" disabled={!voices.available || busy} onClick={() => startEnrollment(primaryPerson.id)}>{voiceProfilesFor(primaryPerson.id).length ? t("Add another voice") : t("Add my voice")}</button> : null}
          </div>
          {primaryPerson && evidenceLabel(primaryPerson.id) ? <p role="status">{evidenceLabel(primaryPerson.id)}</p> : null}
          {primaryPerson && showVoices ? <>
            <p>{t("Voice: {0}", voiceProfilesFor(primaryPerson.id).length ? t("{0} enrolled", voiceProfilesFor(primaryPerson.id).length) : t("not enrolled"))}</p>
            {voiceProfilesFor(primaryPerson.id).map(v => <div className="flex gap-2 flex-wrap items-center" key={v.id}>
              <span>{t("Voice enrolled")}</span>
              {v.sampleId ? <button type="button" onClick={() => void play(v.sampleId!)}>{t("Play sample")}</button> : null}
              <button type="button" onClick={() => startEnrollment(primaryPerson.id, v.id)}>{t("Re-enroll")}</button>
              <button type="button" onClick={() => void act(() => send(`/voice-profiles/${v.id}`, undefined, "DELETE"), t("Voice deleted."))}>{t("Delete voice")}</button>
            </div>)}
          </> : null}
        </form>
      </section>}
      {show("people") && <section className="yuvi-card grid gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2>{t("People I know")}</h2>
            <p>{t("Save a name and optional notes. YUVI keeps the same current persona scope automatically.")}</p>
          </div>
          <button type="button" onClick={() => { setOtherPerson(emptyPersonDraft()); setEditingOther(true); }}>{t("Add person")}</button>
        </div>
        {!knownPeople.length ? <p>{t("No other people saved yet.")}</p> : null}
        {knownPeople.map(p => {
          const personVoices = voiceProfilesFor(p.id);
          return <article className="rounded border p-3 grid gap-2" key={p.id}>
            <div><strong>{p.displayName}</strong>{p.notes ? <p className="m-0">{p.notes}</p> : null}</div>
            {showVoices ? <p className="m-0">{t("Voice: {0}", personVoices.length ? t("{0} enrolled", personVoices.length) : t("not enrolled"))}</p> : null}
            {evidenceLabel(p.id) ? <p role="status">{evidenceLabel(p.id)}</p> : null}
            <div className="flex gap-2 flex-wrap">
              <button type="button" onClick={() => { setOtherPerson({ id: p.id, displayName: p.displayName, notes: p.notes }); setEditingOther(true); }}>{t("Edit")}</button>
              {showVoices ? <button type="button" disabled={!voices.available || busy} onClick={() => startEnrollment(p.id)}>{personVoices.length ? t("Add another voice") : t("Add voice")}</button> : null}
            </div>
            {showVoices && personVoices.map(v => <div className="flex gap-2 flex-wrap items-center" key={v.id}>
              <span>{t("Voice enrolled")}</span>
              {v.sampleId ? <button type="button" onClick={() => void play(v.sampleId!)}>{t("Play sample")}</button> : null}
              <button type="button" onClick={() => startEnrollment(p.id, v.id)}>{t("Re-enroll")}</button>
              <button type="button" onClick={() => void act(() => send(`/voice-profiles/${v.id}`, undefined, "DELETE"), t("Voice deleted."))}>{t("Delete voice")}</button>
            </div>)}
          </article>;
        })}
        {editingOther ? <form className="rounded border p-3 grid gap-3" onSubmit={e => { e.preventDefault(); void savePersonProfile(otherPerson, false); }}>
          <h3>{otherPerson.id ? t("Edit person") : t("Add person")}</h3>
          <label>{t("Name")}<input required className={inputStyle} value={otherPerson.displayName} onChange={e => setOtherPerson({ ...otherPerson, displayName: e.target.value })} /></label>
          <label>{t("Notes (optional)")}<textarea className={inputStyle} value={otherPerson.notes} onChange={e => setOtherPerson({ ...otherPerson, notes: e.target.value })} /></label>
          <div className="flex gap-2">
            <button disabled={busy}>{t("Save person")}</button>
            <button type="button" onClick={() => { setEditingOther(false); setOtherPerson(emptyPersonDraft()); }}>{t("Cancel")}</button>
          </div>
        </form> : null}
      </section>}
      {show("voices") && <section className="yuvi-card grid gap-3">
        <div>
          <h2>{t("Voice enrollment")}</h2>
          <p>{t("Voice profiles identify acoustic identity only. YUVI links them to a saved person through the existing trusted Memory binding.")}</p>
        </div>
        {!voices.available ? <p>{t("Local speaker recognition is not available. Person profiles can still be saved.")}</p> : null}
        {enrollPerson ? <>
          <p><strong>{state.people.find(p => p.id === enrollPerson)?.displayName ?? t("Selected person")}</strong> · {t("{0}/3 recordings ready", recordings.length)}</p>
          <p>{t("Record three short clear utterances. Each recording stops after eight seconds.")}</p>
          <div className="flex gap-2 flex-wrap">
            <button type="button" disabled={!voices.available || busy || recordings.length >= 5} onClick={() => void (recording ? finishRecording() : beginRecording())}>{recording ? t("Stop recording") : t("Record voice")}</button>
            <button type="button" disabled={busy || recording || recordings.length < 3} onClick={() => void finishEnrollment()}>{replaceVoiceId ? t("Replace voice") : t("Save voice")}</button>
            <button type="button" disabled={recording} onClick={() => { setEnrollPerson(""); setReplaceVoiceId(undefined); setRecordings([]); }}>{t("Cancel")}</button>
          </div>
        </> : <p>{t("Choose Add voice on a saved person to begin.")}</p>}
      </section>}
      {show("voices") && <section className="yuvi-card grid gap-3">
        <div>
          <h2>{t("Unrecognized voices")}</h2>
          <p>{t("Only locally retained review samples appear here. Nothing is silently assigned to a person.")}</p>
        </div>
        {!voices.unknown.length ? <p>{t("No unrecognized voices to review.")}</p> : null}
        {voices.unknown.map(v => <article className="rounded border p-3 grid gap-2" key={v.id}>
          <strong>{t("Unrecognized voice")}</strong>
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={() => void play(v.id)}>{t("Play sample")}</button>
            <label>{t("Assign to person")}<select value="" onChange={e => { if (e.target.value) void act(() => send(`/product/voice-samples/${v.id}/review`, { personId: e.target.value }), t("Voice assigned.")); }}><option value="">{t("Select person")}</option>{state.people.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
            <button type="button" onClick={() => { setOtherPerson(emptyPersonDraft()); setEditingOther(true); }}>{t("Add person")}</button>
            <button type="button" onClick={() => void act(() => send(`/product/voice-samples/${v.id}/review`, { leaveUnknown: true }), t("Left unrecognized."))}>{t("Keep unrecognized")}</button>
            <button type="button" onClick={() => void act(() => send(`/product/voice-samples/${v.id}`, undefined, "DELETE"), t("Sample deleted."))}>{t("Delete sample")}</button>
          </div>
        </article>)}
      </section>}
    </>}
  </section>;
}
