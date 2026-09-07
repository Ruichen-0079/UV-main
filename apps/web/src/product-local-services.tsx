import { useEffect, useRef, useState } from "react";
import { apiClient } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { ProductDailyStatus } from "./product-daily-status.js";
import {
  releaseMicrophoneCapture,
  startMicrophoneCapture,
  stopMicrophoneCapture,
  type ActiveAudioCapture
} from "./audio-capture.js";

export function ProductLocalServices(): JSX.Element {
  const status = useAsyncData((signal) => apiClient.getLocalServices(signal), []);
  const [profiles, setProfiles] = useState<Array<{ voiceProfileId: string; label: string }>>([]);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<"enroll" | "identify" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const capture = useRef<ActiveAudioCapture | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseMicrophoneCapture(capture.current);
    };
  }, []);
  useEffect(() => {
    if (status.data?.stt.selected && status.data.stt.speakerProfiles) {
      void apiClient
        .getVoiceProfiles()
        .then((result) => {
          if (mounted.current) setProfiles(result.profiles);
        })
        .catch(() => {
          if (mounted.current) setNotice("Could not read acoustic profiles.");
        });
    }
  }, [status.data]);

  async function start(next: "enroll" | "identify") {
    setBusy(true);
    setNotice("");
    try {
      const recording = await startMicrophoneCapture();
      if (!mounted.current) {
        releaseMicrophoneCapture(recording);
        return;
      }
      capture.current = recording;
      setMode(next);
    } catch {
      setNotice("Microphone unavailable. Check the browser microphone permission.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function finish() {
    const active = capture.current;
    if (!active) return;
    capture.current = null;
    setBusy(true);
    try {
      const audio = await stopMicrophoneCapture(active);
      if (mode === "enroll") {
        const result = await apiClient.enrollVoiceProfile({ ...audio, label });
        setNotice(`Saved acoustic profile: ${result.label}`);
      } else {
        const result = await apiClient.identifyVoiceProfile(audio);
        setNotice(
          result.status === "MATCHED"
            ? `MATCH · ${profiles.find((p) => p.voiceProfileId === result.voiceProfileId)?.label ?? result.voiceProfileId}`
            : "NO_MATCH · no enrolled voice was recognized"
        );
      }
      await status.refresh();
    } catch {
      setNotice(
        "Recording could not be processed. Use clear speech from one speaker and check service status."
      );
    } finally {
      if (mounted.current) {
        setMode(null);
        setBusy(false);
      }
    }
  }
  const data = status.data;
  return (
    <section className="yuvi-card grid gap-3" aria-label="Local intelligence">
      <h2>Local intelligence</h2>
      {import.meta.env["YUVI_DAILY_USE"] === true ? <ProductDailyStatus /> : null}
      <button
        className="yuvi-product-button"
        disabled={status.loading}
        onClick={() => void status.refresh()}
      >
        Refresh local services
      </button>
      {status.error ? (
        <p role="alert">
          Live status unavailable. Any displayed results are from the last successful check.
        </p>
      ) : null}
      {data ? (
        <>
          <p>
            Local STT: {data.stt.available ? "available" : "unavailable"} ·{" "}
            {data.stt.selected ? "selected" : "not selected"}. Speaker profiles:{" "}
            {data.stt.speakerProfiles ? "available" : "unavailable"}. Diarization:{" "}
            {data.stt.diarization ? "available" : "unavailable"}. Live VAD:{" "}
            {data.stt.vad ? "available" : "unavailable"}.
          </p>
          <p>
            Memory: {data.memory.backend} · {data.memory.repository} ({data.memory.database}).
            Ollama: {data.memory.ollama ? "available" : "unavailable"}. {data.memory.model}:{" "}
            {data.memory.embedderPresent ? "present" : "missing or unobserved"} ·{" "}
            {data.memory.dimensions} dimensions.
          </p>
          <p>
            Mem0: {data.memory.status}. Embedding probe:{" "}
            {data.memory.embedder ? "passed" : "not passed"}. pgvector:{" "}
            {data.memory.vectorStore ? "available" : "unavailable"}. CRUD:{" "}
            {data.memory.crud ? "available" : "unavailable"}. Search:{" "}
            {data.memory.search ? "available" : "unavailable"}. infer={String(data.memory.infer)}
            {!data.memory.infer
              ? " · automatic LLM extraction unavailable; explicit memory writes remain supported when CRUD is ready."
              : ""}
          </p>
          <p>
            TTS:{" "}
            {data.tts.configured
              ? `${data.tts.provider} configured · ${data.tts.observed}`
              : "not configured · no voice model selected"}
            . Speech recognition works independently of speech output.
          </p>
          <small>Checked {new Date(data.checkedAt).toLocaleTimeString()}</small>
          <h3>Acoustic voice profiles</h3>
          <p>
            Record one speaker for at least a few seconds. The label names an acoustic profile; it
            does not assign a person or grant trust.
          </p>
          <label className="yuvi-product-provider-field">
            Profile label{" "}
            <input
              value={label}
              maxLength={100}
              disabled={busy || mode !== null}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {mode ? (
            <button className="yuvi-product-button" disabled={busy} onClick={() => void finish()}>
              Stop recording &amp; {mode === "enroll" ? "enroll" : "identify"}
            </button>
          ) : (
            <>
              <button
                className="yuvi-product-button"
                disabled={busy || !label.trim() || !data.stt.selected || !data.stt.speakerProfiles}
                onClick={() => void start("enroll")}
              >
                Record enrollment
              </button>
              <button
                className="yuvi-product-button"
                disabled={busy || !data.stt.selected || !data.stt.speakerProfiles}
                onClick={() => void start("identify")}
              >
                Record recognition check
              </button>
            </>
          )}
          {notice ? <p role="status">{notice}</p> : null}
          <ul>
            {profiles.map((profile) => (
              <li key={profile.voiceProfileId}>
                {profile.label} · <code>{profile.voiceProfileId}</code>{" "}
                <button
                  disabled={busy || mode !== null}
                  onClick={() => {
                    setBusy(true);
                    void apiClient
                      .deleteVoiceProfile(profile.voiceProfileId)
                      .then(() => status.refresh())
                      .catch(() => setNotice("Profile deletion failed."))
                      .finally(() => setBusy(false));
                  }}
                >
                  Delete acoustic profile
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>{status.loading ? "Checking local services…" : "No live status."}</p>
      )}
    </section>
  );
}
