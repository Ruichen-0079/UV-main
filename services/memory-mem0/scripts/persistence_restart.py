#!/usr/bin/env python3
"""
Full process restart persistence check (not in-process Memory reuse).

Steps:
  1. Start Sidecar process A
  2. infer=false add unique token
  3. Search confirm
  4. Kill process A; confirm port free
  5. Start Sidecar process B
  6. Search same scope; require same memoryId or same content
  7. Delete test data
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("MEM0_SIDECAR_HOST", "127.0.0.1")
# Product default Mem0 sidecar port is 6131.
PORT = int(os.environ.get("MEM0_SIDECAR_PORT", "6131"))
BASE = f"http://{HOST}:{PORT}"
SCOPE = "yuvi:v1:user:persist-test:character:alice"
PYTHON = sys.executable
_OUTPUT_TAIL_LIMIT = 200


def port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


def wait_port(up: bool, timeout: float = 45.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(HOST, PORT) == up:
            return True
        time.sleep(0.25)
    return False


def http_json(method: str, path: str, body: dict | None = None) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    with urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _drain_sidecar_output(proc: subprocess.Popen[bytes]) -> None:
    stream = proc.stdout
    if stream is None:
        return
    tail: deque[str] = getattr(proc, "_yuvi_output_tail")
    lock: threading.Lock = getattr(proc, "_yuvi_output_lock")
    for raw in iter(stream.readline, b""):
        line = raw.decode("utf-8", errors="replace").rstrip()
        with lock:
            tail.append(line)


def _sidecar_output_tail(proc: subprocess.Popen[bytes]) -> str:
    tail: deque[str] | None = getattr(proc, "_yuvi_output_tail", None)
    lock: threading.Lock | None = getattr(proc, "_yuvi_output_lock", None)
    if tail is None or lock is None:
        return ""
    with lock:
        return "\n".join(tail)


def start_sidecar() -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "src")
    # Ensure no Memory LLM is required for this script.
    env.setdefault("MEM0_LLM_MODEL", "")
    env.setdefault("MEM0_LLM_API_KEY", "")
    if not env.get("MEM0_PG_CONNECTION_STRING"):
        # Fall back to monorepo DATABASE_URL if present in process env.
        db = env.get("DATABASE_URL", "")
        if db:
            env["MEM0_PG_CONNECTION_STRING"] = db
    proc = subprocess.Popen(
        [PYTHON, "-m", "yuvi_mem0"],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    setattr(proc, "_yuvi_output_tail", deque(maxlen=_OUTPUT_TAIL_LIMIT))
    setattr(proc, "_yuvi_output_lock", threading.Lock())
    drain_thread = threading.Thread(
        target=_drain_sidecar_output,
        args=(proc,),
        name="yuvi-mem0-output-drain",
        daemon=True,
    )
    setattr(proc, "_yuvi_output_drain_thread", drain_thread)
    drain_thread.start()
    return proc


def stop_sidecar(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def main() -> int:
    token = f"persist-{uuid.uuid4().hex[:12]}"
    content = f"persistence token {token}"
    print(f"[persistence] token={token}")

    if port_open(HOST, PORT):
        print(f"[persistence] ERROR: port {PORT} already in use; stop other sidecar first")
        return 2

    # --- Process A ---
    proc_a = start_sidecar()
    pid_a = proc_a.pid
    print(f"[persistence] started process A pid={pid_a}")
    if not wait_port(True):
        stop_sidecar(proc_a)
        print("[persistence] ERROR: process A failed to bind", _sidecar_output_tail(proc_a)[-2000:])
        return 3

    try:
        health = http_json("GET", "/health")
        print(f"[persistence] health A status={health.get('data', {}).get('status')}")

        add_body = {
            "scope": SCOPE,
            "content": content,
            "infer": False,
            "metadata": {"explicit": True, "schemaVersion": 1, "createdBy": "persistence_restart"},
        }
        add_resp = http_json("POST", "/v1/memories", add_body)
        memory_id = add_resp["data"]["memoryId"]
        print(f"[persistence] wrote memoryId={memory_id}")

        search_resp = http_json(
            "POST",
            "/v1/memories/search",
            {"scope": SCOPE, "query": token, "limit": 5},
        )
        items = search_resp["data"]["items"]
        found = [i for i in items if token in (i.get("content") or "")]
        if not found:
            print("[persistence] ERROR: token not found before restart")
            return 4
        print(f"[persistence] pre-restart search hits={len(found)} id={found[0].get('id')}")
    except (HTTPError, URLError, KeyError, json.JSONDecodeError) as exc:
        print(f"[persistence] ERROR during process A ops: {type(exc).__name__}")
        stop_sidecar(proc_a)
        return 5

    stop_sidecar(proc_a)
    print(f"[persistence] stopped process A pid={pid_a}")
    if not wait_port(False, timeout=20):
        print(f"[persistence] ERROR: port {PORT} still listening after stop")
        return 6
    print(f"[persistence] confirmed port {PORT} is free")

    # --- Process B (fresh process, new Memory instance) ---
    proc_b = start_sidecar()
    pid_b = proc_b.pid
    print(f"[persistence] started process B pid={pid_b}")
    if not wait_port(True):
        stop_sidecar(proc_b)
        print("[persistence] ERROR: process B failed to bind", _sidecar_output_tail(proc_b)[-2000:])
        return 7

    try:
        search_resp = http_json(
            "POST",
            "/v1/memories/search",
            {"scope": SCOPE, "query": token, "limit": 5},
        )
        items = search_resp["data"]["items"]
        found = [i for i in items if token in (i.get("content") or "")]
        if not found:
            print("[persistence] FAIL: token not found after full process restart")
            return 8
        recovered_id = found[0].get("id")
        print(
            f"[persistence] post-restart hit id={recovered_id} same_id={recovered_id == memory_id}"
        )
        if recovered_id != memory_id and content not in (found[0].get("content") or ""):
            print("[persistence] FAIL: neither memoryId nor content matched")
            return 9

        # cleanup
        for item in found:
            mid = item.get("id")
            if mid:
                try:
                    http_json("DELETE", f"/v1/memories/{mid}?scope={SCOPE}")
                except HTTPError:
                    pass
        print("[persistence] cleaned up test memories")
        print("[persistence] PASS")
        return 0
    except (HTTPError, URLError, KeyError, json.JSONDecodeError) as exc:
        print(f"[persistence] ERROR during process B ops: {type(exc).__name__}")
        return 10
    finally:
        stop_sidecar(proc_b)
        print(f"[persistence] stopped process B pid={pid_b}")


if __name__ == "__main__":
    raise SystemExit(main())
