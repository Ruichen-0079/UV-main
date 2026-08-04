#!/usr/bin/env python3
"""Measure p50/p95 for embed / add / search / get and cold/warm sidecar timings."""

from __future__ import annotations

import json
import os
import statistics
import time
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("MEM0_SIDECAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEM0_SIDECAR_PORT", "6131"))
BASE = f"http://{HOST}:{PORT}"
SCOPE = "yuvi:v1:user:perf-bench:character:alice"
N = 10


def http_json(
    method: str, path: str, body: dict | None = None, timeout: float = 60
) -> tuple[dict, float]:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    started = time.perf_counter()
    with urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    ms = (time.perf_counter() - started) * 1000
    return payload, ms


def percentile(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    k = (len(ordered) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(ordered) - 1)
    if f == c:
        return ordered[f]
    return ordered[f] + (ordered[c] - ordered[f]) * (k - f)


def report(name: str, samples: list[float]) -> None:
    p50 = percentile(samples, 50)
    p95 = percentile(samples, 95)
    lo = min(samples)
    hi = max(samples)
    print(f"{name}: n={len(samples)} p50={p50:.1f}ms p95={p95:.1f}ms")
    print(f"  min={lo:.1f}ms max={hi:.1f}ms")


def ollama_embed_ms() -> float:
    import httpx

    base = os.environ.get("MEM0_OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    started = time.perf_counter()
    with httpx.Client(timeout=30.0) as client:
        r = client.post(
            f"{base}/api/embed",
            json={"model": "yuvi-embedding:0.6b", "input": "short fact"},
        )
        r.raise_for_status()
        dims = len((r.json().get("embeddings") or [[]])[0])
        assert dims == 1024, dims
    return (time.perf_counter() - started) * 1000


def main() -> int:
    print(f"[perf] base={BASE} n={N}")
    try:
        health, warm0 = http_json("GET", "/health")
        print(
            f"[perf] warm health first={warm0:.1f}ms status={health.get('data', {}).get('status')}"
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[perf] ERROR: sidecar not reachable: {type(exc).__name__}")
        return 2

    embed_samples = [ollama_embed_ms() for _ in range(N)]
    report("ollama_embed", embed_samples)

    warm_samples: list[float] = []
    for _ in range(N):
        _, ms = http_json("GET", "/health")
        warm_samples.append(ms)
    report("sidecar_warm_health", warm_samples)

    add_samples: list[float] = []
    search_samples: list[float] = []
    get_samples: list[float] = []
    ids: list[str] = []

    facts = [
        "用户喜欢简短回复",
        "User prefers sci-fi books",
        "ユーザーは紅茶が好きです",
    ]

    for i in range(N):
        token = uuid.uuid4().hex[:8]
        content = f"{facts[i % len(facts)]} [{token}]"
        body = {
            "scope": SCOPE,
            "content": content,
            "infer": False,
            "metadata": {"explicit": True, "schemaVersion": 1},
        }
        resp, ms = http_json("POST", "/v1/memories", body)
        add_samples.append(ms)
        mid = resp["data"]["memoryId"]
        ids.append(mid)

        sresp, sms = http_json(
            "POST",
            "/v1/memories/search",
            {"scope": SCOPE, "query": token, "limit": 3},
        )
        search_samples.append(sms)
        _ = sresp

        gresp, gms = http_json("GET", f"/v1/memories/{mid}?scope={SCOPE}")
        get_samples.append(gms)
        _ = gresp

    report("infer_false_add", add_samples)
    report("search", search_samples)
    report("get", get_samples)

    # Optional infer=true timing (range only)
    if os.environ.get("MEM0_LLM_API_KEY") and os.environ.get("MEM0_LLM_MODEL"):
        infer_samples: list[float] = []
        for i in range(3):
            body = {
                "scope": SCOPE,
                "messages": [
                    {"role": "user", "content": f"我喜欢绿色饮料 #{i}"},
                    {"role": "assistant", "content": "好的，记住了。"},
                ],
                "infer": True,
                "metadata": {"schemaVersion": 1},
            }
            try:
                _, ms = http_json("POST", "/v1/memories", body, timeout=120)
                infer_samples.append(ms)
            except Exception as exc:  # noqa: BLE001
                print(f"[perf] infer=true sample failed: {type(exc).__name__}")
        if infer_samples:
            print(
                f"infer_true_add: n={len(infer_samples)} "
                f"range={min(infer_samples):.0f}-{max(infer_samples):.0f}ms "
                f"mean={statistics.mean(infer_samples):.0f}ms"
            )
    else:
        print("infer_true_add: skipped (MEM0_LLM_* not set)")

    # cleanup
    for mid in ids:
        try:
            http_json("DELETE", f"/v1/memories/{mid}?scope={SCOPE}")
        except Exception:
            pass
    print("[perf] done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
