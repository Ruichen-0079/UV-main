"""Acoustic voice-profile store for the local STT sidecar.

The persisted `speakerId` field is a legacy name for the durable acoustic
template identity (`voiceProfileId`). It is not a person id, not a
diarization cluster id, and not a display name.

This module owns embeddings and cosine matching only. It never stores or
returns personId, canonicalName, P8 identity, relationship, or trust.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

# Legacy persisted key. Mapped to provider-neutral voiceProfileId at the HTTP
# boundary. Do not migrate speakers.json/speakers.npz merely to rename this.
LEGACY_SPEAKER_ID_FIELD = "speakerId"

VOICE_PROFILE_MATCH_MATCHED = "MATCHED"
VOICE_PROFILE_MATCH_NO_MATCH = "NO_MATCH"

# Diarization min_duration_on is 0.3s; shorter cluster audio cannot be matched.
MIN_CLUSTER_DURATION_SEC = 0.3


class SpeakerStore:
    """Local acoustic templates: speakers.json metadata + speakers.npz vectors (0600)."""

    def __init__(self, directory: Path, dim: int, threshold: float) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.meta_path = self.directory / "speakers.json"
        self.vec_path = self.directory / "speakers.npz"
        self.dim = dim
        self.threshold = threshold
        self._lock = threading.Lock()
        self.meta: dict[str, dict[str, str]] = {}
        self.vectors: dict[str, np.ndarray] = {}
        self._load()

    def _load(self) -> None:
        if self.meta_path.is_file():
            raw = json.loads(self.meta_path.read_text(encoding="utf-8"))
            speakers = raw.get("speakers") if isinstance(raw, dict) else []
            if isinstance(speakers, list):
                for item in speakers:
                    if isinstance(item, dict) and isinstance(item.get(LEGACY_SPEAKER_ID_FIELD), str):
                        speaker_id = item[LEGACY_SPEAKER_ID_FIELD]
                        self.meta[speaker_id] = {
                            LEGACY_SPEAKER_ID_FIELD: speaker_id,
                            "label": str(item.get("label") or speaker_id),
                            "enrolledAt": str(item.get("enrolledAt") or ""),
                        }
        if self.vec_path.is_file():
            with np.load(self.vec_path, allow_pickle=False) as data:
                for key in data.files:
                    self.vectors[key] = np.asarray(data[key], dtype=np.float32)

    def _persist(self) -> None:
        payload = {"speakers": [self.public(item) for item in self.meta.values()]}
        tmp_meta = self.meta_path.with_suffix(".tmp")
        tmp_meta.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp_meta, self.meta_path)
        os.chmod(self.meta_path, 0o600)
        tmp_vec = self.vec_path.with_suffix(".tmp.npz")
        if self.vectors:
            np.savez(tmp_vec, **{key: value for key, value in self.vectors.items()})
        else:
            np.savez(tmp_vec)
        os.replace(tmp_vec, self.vec_path)
        os.chmod(self.vec_path, 0o600)

    def public(self, item: dict[str, str]) -> dict[str, str]:
        # Acoustic template public metadata. `label` is a sidecar presentation
        # string, never a person identity.
        return {
            LEGACY_SPEAKER_ID_FIELD: item[LEGACY_SPEAKER_ID_FIELD],
            "label": item["label"],
            "enrolledAt": item["enrolledAt"],
        }

    def list_public(self) -> list[dict[str, str]]:
        with self._lock:
            return [self.public(item) for item in self.meta.values()]

    def enroll(self, speaker_id: str, label: str, embedding: np.ndarray) -> dict[str, str]:
        vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
        if vector.size != self.dim:
            raise ValueError("speaker embedding dimension mismatch")
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        record = {LEGACY_SPEAKER_ID_FIELD: speaker_id, "label": label, "enrolledAt": now}
        with self._lock:
            self.meta[speaker_id] = record
            self.vectors[speaker_id] = vector.copy()
            self._persist()
        return self.public(record)

    def delete(self, speaker_id: str) -> bool:
        with self._lock:
            existed = speaker_id in self.meta
            self.meta.pop(speaker_id, None)
            self.vectors.pop(speaker_id, None)
            self._persist()
        return existed

    def identify(self, embedding: np.ndarray) -> dict[str, Any]:
        vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
        norm = np.linalg.norm(vector)
        if norm == 0:
            return {
                "identity": "UNKNOWN",
                LEGACY_SPEAKER_ID_FIELD: None,
                "label": None,
                "score": 0.0,
                "threshold": self.threshold,
            }
        vector = vector / norm
        best_id = None
        best_score = -1.0
        with self._lock:
            items = list(self.vectors.items())
            meta = dict(self.meta)
        for speaker_id, stored in items:
            stored_norm = np.linalg.norm(stored)
            if stored_norm == 0:
                continue
            score = float(np.dot(vector, stored / stored_norm))
            if score > best_score:
                best_score = score
                best_id = speaker_id
        if best_id is None or best_score < self.threshold:
            return {
                "identity": "UNKNOWN",
                LEGACY_SPEAKER_ID_FIELD: None,
                "label": None,
                "score": round(best_score, 4) if best_score >= 0 else None,
                "threshold": self.threshold,
            }
        return {
            "identity": "KNOWN",
            LEGACY_SPEAKER_ID_FIELD: best_id,
            "label": meta.get(best_id, {}).get("label"),
            "score": round(best_score, 4),
            "threshold": self.threshold,
        }


def voice_profile_match_from_identify(result: dict[str, Any] | None) -> dict[str, Any]:
    """Map a legacy identify() result to provider-neutral acoustic evidence.

    Numeric score/threshold stay on the legacy identify payload for sidecar
    diagnostics and are deliberately omitted here. Similarity is not person
    truth.
    """

    if not isinstance(result, dict):
        return {"status": VOICE_PROFILE_MATCH_NO_MATCH}
    speaker_id = result.get(LEGACY_SPEAKER_ID_FIELD)
    if result.get("identity") == "KNOWN" and isinstance(speaker_id, str) and speaker_id.strip():
        return {
            "status": VOICE_PROFILE_MATCH_MATCHED,
            "voiceProfileId": speaker_id.strip(),
        }
    return {"status": VOICE_PROFILE_MATCH_NO_MATCH}


def unique_cluster_ids(segments: list[dict[str, Any]] | None) -> list[str]:
    if not segments:
        return []
    seen: list[str] = []
    for item in segments:
        speaker = item.get("speaker")
        if speaker is None:
            continue
        cluster_id = str(speaker)
        if cluster_id not in seen:
            seen.append(cluster_id)
    return seen


def is_mixed_capture(segments: list[dict[str, Any]] | None) -> bool:
    return len(unique_cluster_ids(segments)) > 1


def collect_cluster_audio(
    samples: np.ndarray,
    sample_rate: int,
    segments: list[dict[str, Any]],
) -> dict[str, np.ndarray]:
    """Concatenate each capture-local cluster's time spans. No second diarization."""

    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    grouped: dict[str, list[np.ndarray]] = {}
    for item in segments:
        speaker = item.get("speaker")
        if speaker is None:
            continue
        cluster_id = str(speaker)
        start_ms = item.get("startMs")
        end_ms = item.get("endMs")
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            continue
        start = max(0, int(float(start_ms) / 1000.0 * sample_rate))
        end = min(audio.shape[0], int(float(end_ms) / 1000.0 * sample_rate))
        if end <= start:
            continue
        grouped.setdefault(cluster_id, []).append(audio[start:end])
    return {cluster_id: np.concatenate(clips) for cluster_id, clips in grouped.items() if clips}


def cluster_audio_is_matchable(clip: np.ndarray, sample_rate: int) -> bool:
    if clip.size <= 0 or sample_rate <= 0:
        return False
    return (clip.size / float(sample_rate)) >= MIN_CLUSTER_DURATION_SEC


def attach_cluster_voice_profile_matches(
    segments: list[dict[str, Any]],
    matches_by_cluster: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    attached: list[dict[str, Any]] = []
    for item in segments:
        speaker = item.get("speaker")
        cluster_id = str(speaker) if speaker is not None else ""
        match = matches_by_cluster.get(cluster_id) or {"status": VOICE_PROFILE_MATCH_NO_MATCH}
        attached.append({**item, "voiceProfileMatch": match})
    return attached
