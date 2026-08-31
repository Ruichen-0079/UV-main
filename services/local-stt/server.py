#!/usr/bin/env python3
"""YUVI local CPU STT + speaker identity sidecar (sherpa-onnx).

Process/service lifecycle only. Does not route Character or Cognition.
Never logs or returns raw speaker embeddings.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("OMP_NUM_THREADS", "4")

import numpy as np
import sherpa_onnx


def _cpu_threads(requested: int) -> int:
    cpu = os.cpu_count() or 4
    cap = max(1, cpu // 4)
    return max(1, min(requested, cap, 4))


def _read_wav_bytes(payload: bytes) -> tuple[int, np.ndarray]:
    with wave.open(io.BytesIO(payload), "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if sample_width == 2:
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif sample_width == 4:
        audio = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError("only 16-bit or 32-bit PCM WAV is supported")
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return sample_rate, np.ascontiguousarray(audio)


def _decode_audio(audio_base64: str, mime_type: str) -> tuple[int, np.ndarray]:
    raw = base64.b64decode(audio_base64)
    mime = (mime_type or "audio/wav").lower()
    if "wav" in mime or raw[:4] == b"RIFF":
        return _read_wav_bytes(raw)
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as src:
        src.write(raw)
        src_path = src.name
    dst_path = src_path + ".wav"
    try:
        import subprocess

        completed = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                src_path,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "wav",
                dst_path,
            ],
            check=False,
            capture_output=True,
            timeout=30,
        )
        if completed.returncode != 0:
            raise ValueError("ffmpeg could not decode audio")
        return _read_wav_bytes(Path(dst_path).read_bytes())
    finally:
        for path in (src_path, dst_path):
            try:
                os.unlink(path)
            except OSError:
                pass


def _resample(samples: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    if from_rate == to_rate:
        return samples
    duration = samples.shape[0] / float(from_rate)
    target = int(duration * to_rate)
    if target <= 1:
        return samples.astype(np.float32)
    x_old = np.linspace(0.0, 1.0, num=samples.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=target, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)


class SpeakerStore:
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
                    if isinstance(item, dict) and isinstance(item.get("speakerId"), str):
                        self.meta[item["speakerId"]] = {
                            "speakerId": item["speakerId"],
                            "label": str(item.get("label") or item["speakerId"]),
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
        np.savez(tmp_vec, **{key: value for key, value in self.vectors.items()})
        os.replace(tmp_vec, self.vec_path)
        os.chmod(self.vec_path, 0o600)

    def public(self, item: dict[str, str]) -> dict[str, str]:
        return {
            "speakerId": item["speakerId"],
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
        record = {"speakerId": speaker_id, "label": label, "enrolledAt": now}
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
            return {"identity": "UNKNOWN", "speakerId": None, "label": None, "score": 0.0, "threshold": self.threshold}
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
                "speakerId": None,
                "label": None,
                "score": round(best_score, 4) if best_score >= 0 else None,
                "threshold": self.threshold,
            }
        return {
            "identity": "KNOWN",
            "speakerId": best_id,
            "label": meta.get(best_id, {}).get("label"),
            "score": round(best_score, 4),
            "threshold": self.threshold,
        }


class SttEngine:
    def __init__(self, model_dir: Path, threads: int, speaker_dir: Path, threshold: float) -> None:
        self.threads = _cpu_threads(threads)
        self.model_dir = model_dir
        sense_dir = self._find_dir(["sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", "sense-voice"])
        tokens = sense_dir / "tokens.txt"
        model = sense_dir / "model.int8.onnx"
        if not model.is_file():
            model = sense_dir / "model.onnx"
        embedding_model = model_dir / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
        if not embedding_model.is_file():
            matches = list(model_dir.rglob("3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"))
            if not matches:
                raise FileNotFoundError("speaker embedding model missing")
            embedding_model = matches[0]
        seg_dir = self._find_dir(["sherpa-onnx-pyannote-segmentation-3-0", "pyannote"])
        seg_model = seg_dir / "model.onnx"
        self.asr_model = str(model)
        self.tokens = str(tokens)
        self.embedding_model = str(embedding_model)
        self.segmentation_model = str(seg_model)
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=self.asr_model,
            tokens=self.tokens,
            num_threads=self.threads,
            use_itn=True,
            debug=False,
            language="",
            provider="cpu",
        )
        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=self.embedding_model,
                num_threads=self.threads,
                debug=False,
                provider="cpu",
            )
        )
        self.diarization = sherpa_onnx.OfflineSpeakerDiarization(
            sherpa_onnx.OfflineSpeakerDiarizationConfig(
                segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                    pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                        model=self.segmentation_model
                    ),
                    num_threads=self.threads,
                    debug=False,
                    provider="cpu",
                ),
                embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                    model=self.embedding_model,
                    num_threads=self.threads,
                    debug=False,
                    provider="cpu",
                ),
                clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5),
                min_duration_on=0.3,
                min_duration_off=0.5,
            )
        )
        self.store = SpeakerStore(speaker_dir, dim=self.extractor.dim, threshold=threshold)
        self._lock = threading.Lock()

    def _find_dir(self, names: list[str]) -> Path:
        for name in names:
            candidate = self.model_dir / name
            if candidate.is_dir():
                return candidate
        for child in self.model_dir.iterdir() if self.model_dir.is_dir() else []:
            if child.is_dir() and any(token in child.name for token in names):
                return child
        raise FileNotFoundError(f"model directory not found for {names}")

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "yuvi-local-stt",
            "provider": "cpu",
            "threads": self.threads,
            "asrModel": Path(self.asr_model).name,
            "speakerModel": Path(self.embedding_model).name,
            "diarizationModel": Path(self.segmentation_model).name,
            "speakerCount": len(self.store.list_public()),
            "gpu": False,
        }

    def embed(self, sample_rate: int, samples: np.ndarray) -> np.ndarray:
        audio = _resample(samples, sample_rate, 16000)
        stream = self.extractor.create_stream()
        stream.accept_waveform(16000, audio)
        stream.input_finished()
        embedding = np.asarray(self.extractor.compute(stream), dtype=np.float32)
        return embedding

    def transcribe(self, sample_rate: int, samples: np.ndarray, language: str | None) -> dict[str, Any]:
        audio = _resample(samples, sample_rate, 16000)
        stream = self.recognizer.create_stream()
        stream.accept_waveform(16000, audio)
        self.recognizer.decode_stream(stream)
        result = stream.result
        text = getattr(result, "text", "") or ""
        lang = language or getattr(result, "lang", None) or getattr(result, "language", None)
        return {"text": text, "language": lang}

    def diarize(self, sample_rate: int, samples: np.ndarray) -> list[dict[str, Any]]:
        audio = _resample(samples, sample_rate, 16000)
        result = self.diarization.process(audio)
        ordered = result.sort_by_start_time() if hasattr(result, "sort_by_start_time") else result
        segments = []
        for item in ordered:
            segments.append(
                {
                    "startMs": int(float(item.start) * 1000),
                    "endMs": int(float(item.end) * 1000),
                    "speaker": str(item.speaker),
                }
            )
        return segments

    def handle_transcribe(self, body: dict[str, Any]) -> dict[str, Any]:
        sample_rate, samples = _decode_audio(str(body.get("audioBase64") or ""), str(body.get("mimeType") or "audio/wav"))
        with self._lock:
            started = time.perf_counter()
            asr = self.transcribe(sample_rate, samples, body.get("language") if isinstance(body.get("language"), str) else None)
            identity = None
            if body.get("identify"):
                identity = self.store.identify(self.embed(sample_rate, samples))
            segments = None
            if body.get("diarize"):
                segments = self.diarize(sample_rate, samples)
        return {
            "text": asr["text"],
            "language": asr["language"],
            "identity": identity,
            "segments": segments,
            "latencyMs": int((time.perf_counter() - started) * 1000),
            "device": "cpu",
        }

    def handle_enroll(self, body: dict[str, Any]) -> dict[str, Any]:
        speaker_id = str(body.get("speakerId") or "").strip()
        label = str(body.get("label") or speaker_id).strip()
        if not speaker_id:
            raise ValueError("speakerId is required")
        sample_rate, samples = _decode_audio(str(body.get("audioBase64") or ""), str(body.get("mimeType") or "audio/wav"))
        with self._lock:
            embedding = self.embed(sample_rate, samples)
            record = self.store.enroll(speaker_id, label, embedding)
        return record

    def handle_identify(self, body: dict[str, Any]) -> dict[str, Any]:
        sample_rate, samples = _decode_audio(str(body.get("audioBase64") or ""), str(body.get("mimeType") or "audio/wav"))
        with self._lock:
            embedding = self.embed(sample_rate, samples)
            result = self.store.identify(embedding)
        return result


ENGINE: SttEngine | None = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or "0")
        if length > 25_000_000:
            raise ValueError("request too large")
        raw = self.rfile.read(length) if length else b"{}"
        data = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(data, dict):
            raise ValueError("JSON object required")
        return data

    def do_GET(self) -> None:  # noqa: N802
        engine = ENGINE
        if engine is None:
            self._json(503, {"ok": False, "error": "not_ready"})
            return
        if self.path == "/health":
            self._json(200, engine.health())
            return
        if self.path == "/speakers":
            self._json(200, {"speakers": engine.store.list_public()})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        engine = ENGINE
        if engine is None:
            self._json(503, {"ok": False, "error": "not_ready"})
            return
        try:
            body = self._read_json()
            if self.path == "/transcribe":
                self._json(200, engine.handle_transcribe(body))
                return
            if self.path == "/identify":
                self._json(200, engine.handle_identify(body))
                return
            if self.path == "/speakers":
                self._json(200, engine.handle_enroll(body))
                return
            self._json(404, {"error": "not_found"})
        except Exception as exc:  # noqa: BLE001
            self._json(400, {"error": "bad_request", "message": str(exc)})

    def do_DELETE(self) -> None:  # noqa: N802
        engine = ENGINE
        if engine is None:
            self._json(503, {"ok": False, "error": "not_ready"})
            return
        prefix = "/speakers/"
        if not self.path.startswith(prefix):
            self._json(404, {"error": "not_found"})
            return
        speaker_id = self.path[len(prefix) :]
        existed = engine.store.delete(speaker_id)
        self._json(200 if existed else 404, {"ok": existed, "speakerId": speaker_id})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--threshold", type=float, default=0.55)
    parser.add_argument("--yuvi-local-stt", action="store_true")
    args = parser.parse_args()
    speaker_dir = Path(os.environ.get("YUVI_STT_SPEAKER_DIR", str(Path(args.model_dir) / "speakers")))
    global ENGINE
    ENGINE = SttEngine(Path(args.model_dir), args.threads, speaker_dir, args.threshold)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(
        "yuvi-local-stt listening on http://%s:%s threads=%s\n" % (args.host, args.port, ENGINE.threads)
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
