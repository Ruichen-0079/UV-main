import { t } from "./locale.js";
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
          if (mounted.current) setNotice(t("Could not read acoustic profiles."));
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
      setNotice(t("Microphone unavailable. Check the browser microphone permission."));
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
        setNotice(t("Saved acoustic profile: {0}", result.label));
      } else {
        const result = await apiClient.identifyVoiceProfile(audio);
        setNotice(
          result.status === "MATCHED"
            ? t("MATCH · {0}", profiles.find((p) => p.voiceProfileId === result.voiceProfileId)?.label ?? result.voiceProfileId)
            : t("NO_MATCH · no enrolled voice was recognized")
        );
      }
      await status.refresh();
    } catch {
      setNotice(
        t("Recording could not be processed. Use clear speech from one speaker and check service status.")
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
    <section className="yuvi-card grid gap-3" aria-label={t("Local intelligence")}>
      <h2>{t("Local intelligence")}</h2>
      {import.meta.env["YUVI_DAILY_USE"] === true ? <ProductDailyStatus /> : null}
      <button
        className="yuvi-product-button"
        disabled={status.loading}
        onClick={() => void status.refresh()}
      >{t("Refresh local services")}</button>
      {status.error ? (
        <p role="alert">{t("Live status unavailable. Any displayed results are from the last successful check.")}</p>
      ) : null}
      {data ? (
        <>
          <p>{t("Local STT:")}{" "}{data.stt.available ? t("available") : t("unavailable")} ·{" "}
            {data.stt.selected ? t("selected") : t("not selected")}{t(". Speaker profiles:")}{" "}
            {data.stt.speakerProfiles ? t("available") : t("unavailable")}{t(". Diarization:")}{" "}
            {data.stt.diarization ? t("available") : t("unavailable")}{t(". Live VAD:")}{" "}
            {data.stt.vad ? t("available") : t("unavailable")}.
          </p>
          <p>{t("Memory:")}{" "}{data.memory.backend} · {data.memory.repository} ({data.memory.database}{t("). Ollama:")}{" "}{data.memory.ollama ? t("available") : t("unavailable")}. {data.memory.model}:{" "}
            {data.memory.embedderPresent ? t("present") : t("missing or unobserved")} ·{" "}
            {data.memory.dimensions}{" "}{t("dimensions.")}</p>
          <p>
            Mem0: {t(data.memory.status)}{t(". Embedding probe:")}{" "}
            {data.memory.embedder ? t("passed") : t("not passed")}{t(". pgvector:")}{" "}
            {data.memory.vectorStore ? t("available") : t("unavailable")}{t(". CRUD:")}{" "}
            {data.memory.crud ? t("available") : t("unavailable")}{t(". Search:")}{" "}
            {data.memory.search ? t("available") : t("unavailable")}. infer={String(data.memory.infer)}
            {!data.memory.infer
              ? t(" · automatic LLM extraction unavailable; explicit memory writes remain supported when CRUD is ready.")
              : ""}
          </p>
          <p>
            TTS:{" "}
            {data.tts.configured
              ? t("{0} configured · {1}", data.tts.provider, data.tts.message ?? data.tts.observed)
              : t("not configured · no voice model selected")}{t(". Voice conversation services:")}{" "}
            {data.stt.available && data.stt.selected && data.stt.vad && data.tts.available
              ? t("ready; microphone permission is checked in Voice Mode")
              : t("not ready for full speech input/output")}
            .
          </p>
          <small>{t("Checked")}{" "}{new Date(data.checkedAt).toLocaleTimeString()}</small>
          <h3>{t("Acoustic voice profiles")}</h3>
          <p>{t("Record one speaker for at least a few seconds. The label names an acoustic profile; it does not assign a person or grant trust.")}</p>
          <label className="yuvi-product-provider-field">{t("Profile label")}{" "}
            <input
              value={label}
              maxLength={100}
              disabled={busy || mode !== null}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          {mode ? (
            <button className="yuvi-product-button" disabled={busy} onClick={() => void finish()}>{t("Stop recording &")}{" "}{t(mode === "enroll" ? "enroll" : "identify")}
            </button>
          ) : (
            <>
              <button
                className="yuvi-product-button"
                disabled={busy || !label.trim() || !data.stt.selected || !data.stt.speakerProfiles}
                onClick={() => void start("enroll")}
              >{t("Record enrollment")}</button>
              <button
                className="yuvi-product-button"
                disabled={busy || !data.stt.selected || !data.stt.speakerProfiles}
                onClick={() => void start("identify")}
              >{t("Record recognition check")}</button>
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
                      .catch(() => setNotice(t("Profile deletion failed.")))
                      .finally(() => setBusy(false));
                  }}
                >{t("Delete acoustic profile")}</button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>{status.loading ? t("Checking local services…") : t("No live status.")}</p>
      )}
    </section>
  );
}
