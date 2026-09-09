import { useEffect, useRef, useState } from "react";
import { request, productSample, apiClient } from "./api/client.js";
import { releaseMicrophoneCapture, startMicrophoneCapture, stopMicrophoneCapture, type ActiveAudioCapture } from "./audio-capture.js";
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
  const [state, setState] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [proactive, setProactive] = useState({ threshold: .7, intervalMs: 60000 });
  const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<Provider>(emptyProvider);
  const [model, setModel] = useState<Model>(() => emptyModel(""));
  const [discovered, setDiscovered] = useState<{ modelId: string; contextWindow: number | null }[]>([]);
  const [person, setPerson] = useState({ id: "", displayName: "", personaId: "", notes: "", primary: true });
  const [voices, setVoices] = useState<Voices>({ available: false, voices: [], unknown: [] });
  const [enrollPerson, setEnrollPerson] = useState(""); const [replaceVoiceId, setReplaceVoiceId] = useState<string | undefined>();
  const [recordings, setRecordings] = useState<string[]>([]); const [recording, setRecording] = useState(false);
  const capture = useRef<ActiveAudioCapture | null>(null); const timer = useRef<ReturnType<typeof setTimeout>>();
  const player = useRef<HTMLAudioElement | null>(null); const sampleUrl = useRef<string>();
  async function refresh() {
    const next = await request<Snapshot>("/product/configuration"); setState(next); setDraft(next.configuration); setProactive(next.proactive);
    setEnrollPerson(v => v || next.primaryPersonId || "");
    const primary = next.people.find(p => p.id === next.primaryPersonId);
    if (primary) setPerson({ ...primary, primary: true });
    if (show("voices")) {
      try { setVoices(await request<Voices>("/product/voices")); } catch { setNotice("Voice profiles are unavailable. Check local speaker recognition and Memory."); }
    }
  }
  useEffect(() => { void refresh().catch(e => setNotice(String(e))); return () => { clearTimeout(timer.current); releaseMicrophoneCapture(capture.current); player.current?.pause(); if (sampleUrl.current) URL.revokeObjectURL(sampleUrl.current); }; }, []);
  async function act(work: () => Promise<unknown>, message = "Saved. Effective state refreshed.") { setBusy(true); setNotice(""); try { const result = await work(); await refresh(); setNotice(result && typeof result === "object" && "message" in result ? String(result.message) : message); return true; } catch (e) { setNotice(e instanceof Error ? e.message : "Action failed."); return false; } finally { setBusy(false); } }
  async function save(configuration = draft) { if (!state || !configuration) return; return act(() => send("/product/configuration", { configuration, revision: state.revision, proactive }, "PUT")); }
  function changeRoute(cap: Capability, ids: string[]) { if (draft) setDraft({ ...draft, routes: { ...draft.routes, [cap]: ids } }); }
  async function finishRecording() {
    clearTimeout(timer.current); const active = capture.current; capture.current = null; if (!active) return;
    try { const audio = await stopMicrophoneCapture(active); setRecordings(old => [...old, audio.audioBase64].slice(0, 5)); } catch { setNotice("Recording failed. Check microphone permission."); } finally { setRecording(false); }
  }
  async function beginRecording() { try { capture.current = await startMicrophoneCapture(); setRecording(true); timer.current = setTimeout(() => void finishRecording(), 8000); } catch { setNotice("Microphone unavailable."); } }
  async function play(id: string) { try { player.current?.pause(); if (sampleUrl.current) URL.revokeObjectURL(sampleUrl.current); sampleUrl.current = URL.createObjectURL(await productSample(id)); player.current = new Audio(sampleUrl.current); await player.current.play(); } catch { setNotice("Sample unavailable or deleted."); } }
  const inputStyle = "rounded border p-2 bg-transparent w-full";
  return <section className="yuvi-configuration grid gap-5" aria-label="Product configuration">
    {show("status") && <header className="yuvi-card grid gap-2"><h1>Provider → Model → Capability Route</h1><p>Chat is the only conversation requirement. Optional capabilities can stay NOT_CONFIGURED.</p>
      <p role="status">{state ? `Conversation: ${state.conversationalReady ? "ready" : "set up Chat"} · Apply: ${state.applyState}` : "Loading configuration…"}</p>
      {state?.applyState === "RESTART_REQUIRED" && <p>Saved changes need a Runtime restart. Current effective routes remain shown below. Restart YUVI to apply them.</p>}
      {state?.applyState === "APPLY_FAILED" && <p>Settings were saved, but Runtime could not apply them. Fix the configuration and retry Save & apply.</p>}
      {notice && <p role="alert">{notice}</p>}
      <label>Dashboard token (if configured)<input className={inputStyle} type="password" onChange={e => apiClient.setDashboardDevToken(e.target.value)} /></label><button onClick={() => void refresh().catch(e => setNotice(String(e)))}>Reload saved and effective settings</button>
    </header>}
    {!show("status") && notice && <p className="yuvi-card" role="alert">{notice}</p>}
    {draft && state && <>
      {show("providers") && <section className="yuvi-card grid gap-3"><h2>Providers</h2>
        {draft.providers.map(p => <div key={p.id} className="flex gap-2 flex-wrap"><strong>{p.displayName}</strong><span>{p.baseUrl}</span><button disabled={busy} onClick={() => setProvider({ ...p, apiKey: undefined })}>Edit provider</button><button disabled={busy} onClick={() => { const ids = draft.models.filter(m => m.providerId === p.id).map(m => m.id); void save({ ...draft, providers: draft.providers.filter(x => x.id !== p.id), models: draft.models.filter(m => m.providerId !== p.id), routes: Object.fromEntries(capabilities.map(c => [c, draft.routes[c].filter(id => !ids.includes(id))])) as Configuration["routes"] }); }}>Delete provider</button><button disabled={busy} onClick={() => void act(async () => { const result = await send<{ message: string; models?: typeof discovered }>(`/product/providers/${p.id}/test`); setDiscovered(result.models ?? []); setModel(emptyModel(p.id)); return result; }, "Connection test completed. Discovered models appear below; manual IDs are always available.")}>Test connection / discover models</button></div>)}
        <form className="grid gap-2" onSubmit={e => { e.preventDefault(); void save({ ...draft, providers: [...draft.providers.filter(p => p.id !== provider.id), provider] }).then(ok => { if (ok) setProvider(emptyProvider()); }); }}>
          <label>Provider display name<input required className={inputStyle} value={provider.displayName} onChange={e => setProvider({ ...provider, displayName: e.target.value })} /></label>
          <label>Adapter<select className={inputStyle} value={provider.adapter} onChange={e => setProvider({ ...provider, adapter: e.target.value })}>{Object.keys(adapters).map(a => <option key={a}>{a}</option>)}</select></label>
          <label>Base URL<input required type="url" className={inputStyle} value={provider.baseUrl} onChange={e => setProvider({ ...provider, baseUrl: e.target.value })} placeholder="http://localhost:8000/v1" /></label>
          <label>API key (optional; blank untouched retains saved key)<input type="password" className={inputStyle} value={provider.apiKey ?? ""} onChange={e => setProvider({ ...provider, apiKey: e.target.value })} /></label><button type="button" onClick={() => setProvider({ ...provider, apiKey: "" })}>Clear API key</button><button disabled={busy}>Save provider & apply</button>
        </form>
      </section>}
      {show("models") && <section className="yuvi-card grid gap-3"><h2>Models</h2>
        {draft.models.map(m => <div key={m.id} className="flex gap-2"><strong>{m.displayName}</strong><span>{m.modelId} · {m.enabled ? "Enabled" : "Disabled"}</span><button onClick={() => setModel(m)}>Edit model</button><button disabled={busy} onClick={() => void save({ ...draft, models: draft.models.filter(x => x.id !== m.id), routes: Object.fromEntries(capabilities.map(c => [c, draft.routes[c].filter(id => id !== m.id)])) as Configuration["routes"] })}>Delete model</button></div>)}
        <form className="grid gap-2" onSubmit={e => { e.preventDefault(); const routes = Object.fromEntries(capabilities.map(c => [c, draft.routes[c].filter(id => id !== model.id || (model.enabled && model.capabilities.includes(c)))])) as Configuration["routes"]; void save({ ...draft, models: [...draft.models.filter(m => m.id !== model.id), model], routes }).then(ok => { if (ok) setModel(emptyModel(model.providerId)); }); }}>
          <label>Provider<select required className={inputStyle} value={model.providerId} onChange={e => { setModel({ ...model, providerId: e.target.value, capabilities: [] }); setDiscovered([]); }}><option value="">Select provider</option>{draft.providers.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
          {discovered.length > 0 && <label>Discovered model<select className={inputStyle} value="" onChange={e => { const m = discovered.find(m => m.modelId === e.target.value); if (m) setModel({ ...model, modelId: m.modelId, displayName: m.modelId, contextWindow: m.contextWindow }); }}><option value="">Choose a discovered model</option>{discovered.map(m => <option key={m.modelId}>{m.modelId}</option>)}</select></label>}
          <label>Model display name<input required className={inputStyle} value={model.displayName} onChange={e => setModel({ ...model, displayName: e.target.value })} /></label><label>Model ID (manual fallback)<input required className={inputStyle} value={model.modelId} onChange={e => setModel({ ...model, modelId: e.target.value })} /></label>
          <label>Temperature<input type="number" min="0" max="2" step="0.05" className={inputStyle} value={model.temperature} onChange={e => setModel({ ...model, temperature: Number(e.target.value) })} /></label><label>Context window (blank = unknown)<input type="number" min="1024" className={inputStyle} value={model.contextWindow ?? ""} onChange={e => setModel({ ...model, contextWindow: e.target.value ? Number(e.target.value) : null })} /></label>
          <fieldset><legend>Declared compatible capabilities — confirm against the model documentation</legend>{(adapters[draft.providers.find(p => p.id === model.providerId)?.adapter ?? ""] ?? []).map(c => <label className="mr-4" key={c}><input type="checkbox" checked={model.capabilities.includes(c)} onChange={e => setModel({ ...model, capabilities: e.target.checked ? [...model.capabilities, c] : model.capabilities.filter(x => x !== c) })} />{labels[c]}</label>)}</fieldset>
          {model.capabilities.includes("embedding") && <label>Embedding dimensions (required)<input required type="number" min="1" value={model.dimensions ?? ""} onChange={e => setModel({ ...model, dimensions: Number(e.target.value) })} /></label>}
          {model.capabilities.includes("tts") && <label>Voice<input value={model.voice ?? ""} onChange={e => setModel({ ...model, voice: e.target.value || undefined })} /></label>}
          <label><input type="checkbox" checked={model.enabled} onChange={e => setModel({ ...model, enabled: e.target.checked })} />Enabled model</label><button disabled={busy}>Save model & apply</button>
        </form>
      </section>}
      {show("routes") && <section className="yuvi-card grid gap-3"><h2>Capability routes</h2><p>Order is fallback order. Removing every model leaves that capability NOT_CONFIGURED.</p><div className="grid gap-3 md:grid-cols-2">{capabilities.map(c => <article className="rounded border p-3" key={c} aria-label={`${labels[c]} route`}><h3>{labels[c]} · {state.routes[c].state}</h3><p>Effective: {state.routes[c].modelIds.map(id => state.configuration.models.find(m => m.id === id)?.displayName ?? id).join(" → ") || "None"}</p><ol>{draft.routes[c].map((id, i) => <li key={id}>{draft.models.find(m => m.id === id)?.displayName}<button aria-label={`Move ${c} model up`} disabled={i === 0} onClick={() => changeRoute(c, reorderRoute(draft.routes[c], i, -1))}>↑</button><button aria-label={`Move ${c} model down`} disabled={i === draft.routes[c].length - 1} onClick={() => changeRoute(c, reorderRoute(draft.routes[c], i, 1))}>↓</button><button onClick={() => changeRoute(c, draft.routes[c].filter(m => m !== id))}>Remove from route</button></li>)}</ol><label>Add compatible model<select value="" onChange={e => changeRoute(c, [...draft.routes[c], e.target.value])}><option value="">Select model</option>{draft.models.filter(m => m.enabled && m.capabilities.includes(c) && !draft.routes[c].includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></label></article>)}</div><button disabled={busy} onClick={() => void save()}>Save routes & apply</button></section>}
      {show("proactive") && <section className="yuvi-card grid gap-3"><h2>Proactive</h2><label>主动程度 / Eagerness<input type="range" min="0" max="1" step=".05" value={1 - proactive.threshold} onChange={e => setProactive({ ...proactive, threshold: 1 - Number(e.target.value) })} /></label><p>Speak-score threshold: {proactive.threshold.toFixed(2)}. A low score skips only the current evaluation.</p><label>Evaluation interval (seconds)<input type="number" min="1" max="86400" value={proactive.intervalMs / 1000} onChange={e => setProactive({ ...proactive, intervalMs: Number(e.target.value) * 1000 })} /></label><p>Suppression: {state.proactiveState.suppression.kind} · Quiet until: {state.proactiveState.eligibleAfterMs > Date.now() ? new Date(state.proactiveState.eligibleAfterMs).toLocaleString() : "No timed quiet period"}</p><button disabled={busy} onClick={() => void act(() => send("/product/proactive/resume"))}>Resume now</button><button disabled={busy} onClick={() => void save()}>Save proactive controls & apply</button></section>}
      {show("people") && <section className="yuvi-card grid gap-3"><h2>My Profile</h2><p>Your identity is set explicitly here. Speaking first never makes someone the owner.</p>{state.primaryPersonId && <p>Stable user ID: {state.primaryPersonId}</p>}<form className="grid gap-2" onSubmit={e => { e.preventDefault(); void act(() => send("/product/people", { ...person, id: person.id || undefined })); }}><label>Display name<input required className={inputStyle} value={person.displayName} onChange={e => setPerson({ ...person, displayName: e.target.value })} /></label><label>Current Yuvi persona<input required className={inputStyle} placeholder="e.g. alice" value={person.personaId} onChange={e => setPerson({ ...person, personaId: e.target.value })} /></label><label>Profile notes (optional)<textarea className={inputStyle} value={person.notes} onChange={e => setPerson({ ...person, notes: e.target.value })} /></label><label><input type="checkbox" checked={person.primary} onChange={e => setPerson({ ...person, primary: e.target.checked })} />This is my primary profile</label><button disabled={busy}>Save person</button><button type="button" onClick={() => setPerson({ id: "", displayName: "", personaId: person.personaId, notes: "", primary: false })}>Create new person</button></form></section>}
      {show("people") && <section className="yuvi-card grid gap-3"><h2>Known People</h2>{state.people.map(p => <div key={p.id}><strong>{p.displayName}</strong> · {p.personaId}<button onClick={() => setPerson({ ...p, primary: state.primaryPersonId === p.id })}>Edit person</button><button onClick={() => { setEnrollPerson(p.id); setReplaceVoiceId(undefined); setRecordings([]); }}>Add another voice</button></div>)}</section>}
      {show("voices") && <section className="yuvi-card grid gap-3"><h2>Voice Profiles</h2><p>Person = relationship and memory identity. Voice Profile = acoustic identity. Binding = your explicit trusted mapping.</p><p>Review samples stay local: up to 8 seconds per sample, up to 30 samples. Older samples expire. You can delete each sample. They are never silently uploaded.</p>{!voices.available && <p>Own voice onboarding is available after local STT / speaker recognition is configured.</p>}
        <label>This is me / enroll for<select value={enrollPerson} onChange={e => { setEnrollPerson(e.target.value); setRecordings([]); setReplaceVoiceId(undefined); }}><option value="">Select person</option>{state.people.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label><p>Record three short utterances from this person. Each recording stops after eight seconds. {recordings.length}/3 recorded.</p>
        <button disabled={!voices.available || !enrollPerson || busy || recordings.length >= 5} onClick={() => void (recording ? finishRecording() : beginRecording())}>{recording ? "Stop recording" : "Record utterance"}</button><button disabled={busy || recording || recordings.length < 3} onClick={() => void act(() => send("/product/voices/enroll", { personId: enrollPerson, recordings, replaceVoiceId }), "Enrollment and explicit Person binding saved.").then(ok => { if (ok) setRecordings([]); })}>Enroll VoiceProfile & explicitly bind</button>
        {voices.voices.map(v => <div className="rounded border p-3" key={v.id}><strong>{v.label}</strong><p>Binding: {state.people.find(p => p.id === v.personId)?.displayName ?? (v.personId ? "Known person" : "Unknown voice")}</p>{v.sampleId && <><button onClick={() => void play(v.sampleId!)}>▶ Play sample</button><button onClick={() => void act(() => send(`/product/voice-samples/${v.sampleId}`, undefined, "DELETE"))}>Delete sample</button></>}{v.personId && <><button onClick={() => { setEnrollPerson(v.personId!); setReplaceVoiceId(v.id); setRecordings([]); }}>Re-enroll</button><button onClick={() => void act(() => send(`/product/voices/${v.id}/binding`, undefined, "DELETE"))}>Remove binding</button></>}<button onClick={() => void act(() => send(`/voice-profiles/${v.id}`, undefined, "DELETE"))}>Delete voice profile</button></div>)}
      </section>}
      {show("voices") && <section className="yuvi-card grid gap-3"><h2>Unknown Voices</h2>{!voices.unknown.length && <p>No unknown samples to review.</p>}{voices.unknown.map(v => <div className="rounded border p-3" key={v.id}><strong>Unknown voice</strong><button onClick={() => void play(v.id)}>▶ Play sample</button><p>Who is this? {v.leftUnknown ? "Left unknown." : ""}</p><label>Link to existing person<select value="" onChange={e => void act(() => send(`/product/voice-samples/${v.id}/review`, { personId: e.target.value }))}><option value="">Select person</option>{state.people.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label><button onClick={() => { setPerson({ id: "", displayName: "", personaId: person.personaId, notes: "", primary: false }); setNotice("Create a new Person in My Profile above, then return here to confirm the binding."); }}>Create new person</button><button onClick={() => void act(() => send(`/product/voice-samples/${v.id}/review`, { leaveUnknown: true }))}>Leave unknown</button><button onClick={() => void act(() => send(`/product/voice-samples/${v.id}`, undefined, "DELETE"))}>Delete sample</button></div>)}</section>}
    </>}
  </section>;
}
