#!/usr/bin/env python3
"""One loopback-only, offline dots runtime. Assets stay outside the repository.

Idle GPU hibernation (Campaign I): after a configurable quiet period the CUDA
runtime is fully unloaded (Strategy A). The next /tts call lazy-reloads. Health
reports hibernated as ready-on-demand — not broken.
"""
from __future__ import annotations

import gc
import io
import json
import os
import re
import signal
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Must precede importing the model libraries. Ordinary startup never downloads.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

# Few-minute default: reload cost is acceptable after meaningful idle; 0 disables.
_DEFAULT_IDLE_HIBERNATE_SECONDS = 180.0


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value >= 0 else default


class Service:
    def __init__(
        self,
        *,
        runtime_factory=None,
        idle_hibernate_seconds=None,
        start_idle_watcher=True,
    ):
        self.state = "warming"
        self.runtime = None
        self.lock = threading.Lock()
        self.cancel_lock = threading.Lock()
        self.cancelled = OrderedDict()
        self.active = None
        self.voice = os.environ.get("DOTS_TTS_VOICE", "rei")
        self.model_path = None
        self.reference = None
        self.transcript = None
        self._runtime_factory = runtime_factory
        self.idle_hibernate_seconds = (
            float(idle_hibernate_seconds)
            if idle_hibernate_seconds is not None
            else _env_float("DOTS_TTS_IDLE_HIBERNATE_SECONDS", _DEFAULT_IDLE_HIBERNATE_SECONDS)
        )
        self._last_activity = time.monotonic()
        self._stop = threading.Event()
        self._watcher = None
        if start_idle_watcher:
            self._watcher = threading.Thread(target=self._idle_loop, daemon=True)
            self._watcher.start()

    def _touch(self):
        self._last_activity = time.monotonic()

    def _resolve_assets(self):
        model = Path(os.environ["DOTS_TTS_MODEL_DIR"])
        reference = Path(os.environ["DOTS_TTS_REFERENCE_AUDIO"])
        transcript = os.environ["DOTS_TTS_REFERENCE_TEXT"].strip()
        if not model.is_dir() or not reference.is_file() or not transcript:
            raise ValueError("missing local assets")
        self.model_path = model
        self.reference = reference
        self.transcript = transcript

    def _create_runtime(self):
        if self._runtime_factory is not None:
            return self._runtime_factory()
        from dots_tts.runtime import DotsTtsRuntime
        return DotsTtsRuntime.from_pretrained(
            str(self.model_path), precision="bfloat16", optimize=False
        )

    def _release_cuda(self):
        """Drop the runtime and ask CUDA to return free blocks to the driver."""
        self.runtime = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def load(self):
        try:
            self._resolve_assets()
            self.runtime = self._create_runtime()
            self.state = "ready"
            self._touch()
        except Exception:
            # Public diagnostics never expose reference paths, transcripts or library traces.
            self.runtime = None
            self.state = "error"

    def _unload_gpu_locked(self):
        """Strategy A: full CUDA unload. Caller must hold self.lock."""
        if self.runtime is None and self.state == "hibernated":
            return
        self._release_cuda()
        if self.state in ("ready", "hibernated"):
            self.state = "hibernated"

    def _ensure_runtime_locked(self):
        """Lazy reload after hibernation. Caller must hold self.lock."""
        if self.runtime is not None and self.state == "ready":
            return
        self.state = "warming"
        try:
            if self.model_path is None or self.reference is None or not self.transcript:
                self._resolve_assets()
            self.runtime = self._create_runtime()
            self.state = "ready"
            self._touch()
        except Exception:
            self._release_cuda()
            self.state = "error"
            raise

    def try_hibernate(self):
        """Unload GPU if idle long enough. Returns True when a transition occurred."""
        if self.idle_hibernate_seconds <= 0:
            return False
        if not self.lock.acquire(blocking=False):
            return False
        try:
            if self.state != "ready" or self.active is not None or self.runtime is None:
                return False
            if time.monotonic() - self._last_activity < self.idle_hibernate_seconds:
                return False
            self._unload_gpu_locked()
            return self.state == "hibernated"
        finally:
            self.lock.release()

    def _idle_loop(self):
        while not self._stop.wait(1.0):
            if self.idle_hibernate_seconds <= 0:
                continue
            self.try_hibernate()

    def shutdown(self):
        """Stop idle watcher and release GPU; process exit still owned by Supervisor."""
        self._stop.set()
        with self.lock:
            self._release_cuda()
            if self.state not in ("error", "warming"):
                self.state = "hibernated"

    def cancel(self, request_id):
        with self.cancel_lock:
            self.cancelled[request_id] = time.monotonic()
            while len(self.cancelled) > 256:
                self.cancelled.popitem(last=False)

    def is_cancelled(self, request_id):
        with self.cancel_lock:
            return request_id in self.cancelled

    def _generate_wav_bytes(self, text, language):
        from dots_tts.utils.util import seed_everything
        import soundfile as sf
        import numpy as np
        seed_everything(42)
        result = self.runtime.generate(
            text=text,
            language=language,
            prompt_audio_path=str(self.reference),
            prompt_text=self.transcript,
            num_steps=10,
            guidance_scale=1.2,
            speaker_scale=1.5,
            normalize_text=False,
        )
        audio = result["audio"].float().detach().cpu().squeeze().numpy()
        if audio.ndim != 1 or not audio.size or not np.isfinite(audio).all():
            raise ValueError("invalid generated audio")
        from audio_output import trim_leading_silence
        audio = trim_leading_silence(audio, int(result["sample_rate"]))
        output = io.BytesIO()
        sf.write(output, audio, int(result["sample_rate"]), format="WAV", subtype="PCM_16")
        return output.getvalue()

    def synthesize(self, body):
        request_id = body.get("requestId", "")
        text = body.get("text", "")
        language = body.get("language")
        if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", request_id):
            return 400, {"error": "invalid request identity"}
        if not isinstance(text, str) or not 0 < len(text.strip()) <= 2000:
            return 400, {"error": "text must contain 1–2000 characters"}
        if language not in ("JA", "EN", "ZH", None) or body.get("voice", self.voice) != self.voice:
            return 400, {"error": "unsupported language or voice"}
        # Hibernated is admissible: auto-restore under the synthesis lock.
        if self.state not in ("ready", "hibernated"):
            return 503, {"error": self.state}
        # No abandoned queue, model per request, or concurrent CUDA generations.
        if not self.lock.acquire(blocking=False):
            return 429, {"error": "busy"}
        try:
            if self.is_cancelled(request_id):
                return 409, {"error": "cancelled"}
            try:
                self._ensure_runtime_locked()
            except Exception:
                return 503, {"error": self.state}
            if self.state != "ready":
                return 503, {"error": self.state}
            if self.is_cancelled(request_id):
                return 409, {"error": "cancelled"}
            self.active = request_id
            self._touch()
            try:
                wav = self._generate_wav_bytes(text, language)
            except ValueError:
                return 500, {"error": "invalid generated audio"}
            # Upstream's complete-result API has no safe compute interruption hook.
            # A cancelled active kernel finishes once; its audio is discarded.
            if self.is_cancelled(request_id):
                return 409, {"error": "cancelled"}
            return 200, wav
        except Exception:
            return 500, {"error": "synthesis failed"}
        finally:
            self.active = None
            self._touch()
            self.lock.release()

    def health_payload(self):
        hibernated = self.state == "hibernated"
        ready = self.state == "ready"
        return {
            "service": "yuvi-dots-tts",
            "state": self.state,
            "model_loaded": ready,
            "gpu_resident": ready and self.runtime is not None,
            "ready_on_demand": ready or hibernated,
            "voice": self.voice,
            "busy": self.active is not None,
            "cancellation": "discard-active-result",
            "idle_hibernate_seconds": self.idle_hibernate_seconds,
        }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_result(self, status, body):
        audio = isinstance(body, bytes)
        data = body if audio else json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "audio/wav" if audio else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        service = self.server.service
        if self.path != "/health":
            return self.send_result(404, {"error": "not found"})
        # Hibernated: HTTP 200 — service alive and will auto-restore on next speech.
        ok = service.state in ("ready", "hibernated")
        self.send_result(200 if ok else 503, service.health_payload())

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16384:
                return self.send_result(413, {"error": "request too large"})
            self.connection.settimeout(10)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError()
        except (ValueError, OSError):
            return self.send_result(400, {"error": "invalid JSON"})
        if self.path == "/cancel":
            request_id = body.get("requestId")
            if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", request_id):
                return self.send_result(400, {"error": "invalid request identity"})
            self.server.service.cancel(request_id)
            return self.send_result(200, {"ok": True})
        if self.path != "/tts":
            return self.send_result(404, {"error": "not found"})
        self.send_result(*self.server.service.synthesize(body))


def main():
    # Bind before loading: a second invocation cannot allocate a duplicate model.
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("DOTS_TTS_PORT", "9881"))), Handler)
    server.daemon_threads = True
    server.service = Service()
    threading.Thread(target=server.service.load, daemon=True).start()
    # Supervisor owns this PID/process group. Termination also stops warmup/inference.
    def stop(*_):
        try:
            server.service.shutdown()
        except Exception:
            pass
        os._exit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever(poll_interval=0.2)


if __name__ == "__main__":
    main()
