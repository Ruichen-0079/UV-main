#!/usr/bin/env python3
"""One loopback-only, offline dots runtime. Assets stay outside the repository."""
from __future__ import annotations

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


class Service:
    def __init__(self):
        self.state = "warming"
        self.runtime = None
        self.lock = threading.Lock()
        self.cancel_lock = threading.Lock()
        self.cancelled = OrderedDict()
        self.active = None
        self.voice = os.environ.get("DOTS_TTS_VOICE", "rei")

    def load(self):
        try:
            model = Path(os.environ["DOTS_TTS_MODEL_DIR"])
            self.reference = Path(os.environ["DOTS_TTS_REFERENCE_AUDIO"])
            self.transcript = os.environ["DOTS_TTS_REFERENCE_TEXT"].strip()
            if not model.is_dir() or not self.reference.is_file() or not self.transcript:
                raise ValueError("missing local assets")
            from dots_tts.runtime import DotsTtsRuntime
            self.runtime = DotsTtsRuntime.from_pretrained(str(model), precision="bfloat16", optimize=False)
            self.state = "ready"
        except Exception:
            # Public diagnostics never expose reference paths, transcripts or library traces.
            self.state = "error"

    def cancel(self, request_id):
        with self.cancel_lock:
            self.cancelled[request_id] = time.monotonic()
            while len(self.cancelled) > 256:
                self.cancelled.popitem(last=False)

    def is_cancelled(self, request_id):
        with self.cancel_lock:
            return request_id in self.cancelled

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
        if self.state != "ready":
            return 503, {"error": self.state}
        # No abandoned queue, model per request, or concurrent CUDA generations.
        if not self.lock.acquire(blocking=False):
            return 429, {"error": "busy"}
        try:
            if self.is_cancelled(request_id):
                return 409, {"error": "cancelled"}
            self.active = request_id
            from dots_tts.utils.util import seed_everything
            import soundfile as sf
            import numpy as np
            seed_everything(42)
            result = self.runtime.generate(text=text, language=language,
                prompt_audio_path=str(self.reference), prompt_text=self.transcript,
                num_steps=10, guidance_scale=1.2, speaker_scale=1.5, normalize_text=False)
            # Upstream's complete-result API has no safe compute interruption hook.
            # A cancelled active kernel finishes once; its audio is discarded.
            if self.is_cancelled(request_id):
                return 409, {"error": "cancelled"}
            audio = result["audio"].float().detach().cpu().squeeze().numpy()
            if audio.ndim != 1 or not audio.size or not np.isfinite(audio).all():
                return 500, {"error": "invalid generated audio"}
            from audio_output import trim_leading_silence
            audio = trim_leading_silence(audio, int(result["sample_rate"]))
            output = io.BytesIO()
            sf.write(output, audio, int(result["sample_rate"]), format="WAV", subtype="PCM_16")
            return 200, output.getvalue()
        except Exception:
            return 500, {"error": "synthesis failed"}
        finally:
            self.active = None
            self.lock.release()


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
        self.send_result(200 if service.state == "ready" else 503, {
            "service": "yuvi-dots-tts", "state": service.state,
            "model_loaded": service.state == "ready", "voice": service.voice,
            "busy": service.active is not None, "cancellation": "discard-active-result"})

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
        os._exit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever(poll_interval=0.2)


if __name__ == "__main__":
    main()
