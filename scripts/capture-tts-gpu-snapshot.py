#!/usr/bin/env python3
"""Portable capture of dots-tts process GPU residency + key health endpoints.

No secrets, no required absolute private paths. Emits JSON on stdout.

Examples:
  python3 scripts/capture-tts-gpu-snapshot.py
  DOTS_TTS_HEALTH_URL=http://127.0.0.1:19881/health python3 scripts/capture-tts-gpu-snapshot.py
"""
from __future__ import annotations

import json
import os
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def _health(url: str):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return {"url": url, "http_status": response.status, "body": json.loads(response.read().decode())}
    except Exception as exc:
        return {"url": url, "error": type(exc).__name__}


def _cmdline(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
    except Exception:
        return ""


def _rss_mib(pid: int):
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return round(int(line.split()[1]) / 1024, 1)
    except Exception:
        return None
    return None


def main() -> None:
    health_url = os.environ.get("DOTS_TTS_HEALTH_URL", "http://127.0.0.1:9881/health")
    apps = []
    try:
        raw = subprocess.check_output(
            ["nvidia-smi", "--query-compute-apps=pid,process_name,used_gpu_memory", "--format=csv,noheader"],
            text=True,
        )
        for line in raw.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 3:
                continue
            pid = int(parts[0])
            cmd = _cmdline(pid)
            apps.append(
                {
                    "pid": pid,
                    "process_name": parts[1],
                    "used_gpu_memory": parts[2],
                    "rss_mib": _rss_mib(pid),
                    "cmdline": cmd,
                    "looks_like_dots_tts": ("dots-tts" in cmd) or ("services/dots-tts/server.py" in cmd),
                }
            )
    except FileNotFoundError:
        apps = [{"error": "nvidia-smi not found"}]
    except subprocess.CalledProcessError as exc:
        apps = [{"error": "nvidia-smi failed", "code": exc.returncode}]

    payload = {
        "captured_at_utc": datetime.now(timezone.utc).isoformat(),
        "compute_apps": apps,
        "health": _health(health_url),
        "extra_health": [
            _health(url)
            for url in os.environ.get("YUVI_EXTRA_HEALTH_URLS", "").split(",")
            if url.strip()
        ],
    }
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
