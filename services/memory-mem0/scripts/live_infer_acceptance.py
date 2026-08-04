#!/usr/bin/env python3
"""
Live infer=true acceptance against a running Sidecar with real Memory LLM.

Does not print API keys or full secrets. Uses short summaries only.
Requires: MEM0_LLM_MODEL + MEM0_LLM_API_KEY (and typically BASE_URL/PROVIDER).
"""

from __future__ import annotations

import json
import os
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HOST = os.environ.get("MEM0_SIDECAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEM0_SIDECAR_PORT", "6131"))
BASE = f"http://{HOST}:{PORT}"
RUN = uuid.uuid4().hex[:8]


def http_json(method: str, path: str, body: dict | None = None, timeout: float = 120) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def search(scope: str, query: str, limit: int = 8) -> list[dict]:
    resp = http_json(
        "POST",
        "/v1/memories/search",
        {"scope": scope, "query": query, "limit": limit},
    )
    return resp.get("data", {}).get("items") or []


def add_messages(scope: str, user: str, assistant: str, infer: bool = True) -> dict:
    return http_json(
        "POST",
        "/v1/memories",
        {
            "scope": scope,
            "messages": [
                {"role": "user", "content": user},
                {"role": "assistant", "content": assistant},
            ],
            "infer": infer,
            "metadata": {"schemaVersion": 1, "createdBy": f"live-infer-{RUN}"},
        },
    )


def add_content(scope: str, content: str, infer: bool = True) -> dict:
    return http_json(
        "POST",
        "/v1/memories",
        {
            "scope": scope,
            "content": content,
            "infer": infer,
            "metadata": {"schemaVersion": 1, "createdBy": f"live-infer-{RUN}"},
        },
    )


def contents(items: list[dict]) -> str:
    return " | ".join((i.get("content") or "")[:80] for i in items)


def contains_any(items: list[dict], needles: list[str]) -> bool:
    blob = contents(items).lower()
    return any(n.lower() in blob for n in needles)


def main() -> int:
    if not (os.environ.get("MEM0_LLM_API_KEY") and os.environ.get("MEM0_LLM_MODEL")):
        print("[infer] SKIP: MEM0_LLM_MODEL/API_KEY not set")
        return 0

    provider = os.environ.get("MEM0_LLM_PROVIDER", "")
    model = os.environ.get("MEM0_LLM_MODEL", "")
    base_url = os.environ.get("MEM0_LLM_BASE_URL", "")
    base_label = base_url or "(default)"
    print(f"[infer] provider={provider or '(default)'} model={model}")
    print(f"[infer] base_url={base_label}")
    key_len = len(os.environ.get("MEM0_LLM_API_KEY", ""))
    print(f"[infer] key_set=yes key_len={key_len}")

    health = http_json("GET", "/health")
    data = health.get("data") or {}
    print(
        f"[infer] health status={data.get('status')} "
        f"memoryLlm={data.get('components', {}).get('memoryLlm')} "
        f"infer={data.get('capabilities', {}).get('infer')}"
    )
    if not data.get("capabilities", {}).get("infer"):
        print("[infer] FAIL: capabilities.infer is false")
        return 2

    failures: list[str] = []
    scope_a = f"yuvi:v1:user:infer-a-{RUN}:character:alice"
    scope_lumi = f"yuvi:v1:user:infer-a-{RUN}:character:lumi"
    scope_b = f"yuvi:v1:user:infer-b-{RUN}:character:alice"

    # A. Fact extraction (two facts may land as multiple memories)
    print("[infer] A fact extraction")
    r = add_messages(
        scope_a,
        "我平时更喜欢简短回复，而且早上通常喝咖啡。",
        "知道了，我以后会尽量简短。",
    )
    op = r.get("data", {}).get("operation")
    mid = r.get("data", {}).get("memoryId")
    print(f"  operation={op} memoryId={mid}")
    time.sleep(0.8)
    hits_short = search(scope_a, "简短回复")
    hits_coffee = search(scope_a, "咖啡")
    sample = contents(hits_short + hits_coffee)
    print(f"  short_hits={len(hits_short)} coffee_hits={len(hits_coffee)} sample={sample[:200]}")
    ok_short = contains_any(hits_short, ["简短", "short"])
    ok_coffee = contains_any(hits_coffee, ["咖啡", "coffee"])
    if not (ok_short and ok_coffee):
        # Fallback: list scope contents (Mem0 may rank poorly for combined query).
        listed = http_json(
            "GET",
            f"/v1/memories?scope={scope_a}&limit=20",
        )
        listed_items = (listed.get("data") or {}).get("items") or []
        blob = contents(listed_items)
        print(f"  list_fallback n={len(listed_items)} sample={blob[:200]}")
        ok_short = ok_short or any(k in blob for k in ("简短", "short"))
        ok_coffee = ok_coffee or any(k in blob for k in ("咖啡", "coffee"))
    if not (ok_short and ok_coffee):
        failures.append("A fact extraction semantic miss")

    # B. Multilingual
    print("[infer] B multilingual")
    add_content(scope_a, "用户喜欢科幻作品。", infer=True)
    add_content(scope_a, "User prefers science fiction.", infer=True)
    add_content(scope_a, "ユーザーは紅茶が好きです。", infer=True)
    time.sleep(0.5)
    zh = search(scope_a, "科幻")
    en = search(scope_a, "science fiction")
    ja = search(scope_a, "紅茶")
    print(f"  zh={len(zh)} en={len(en)} ja={len(ja)}")
    if not (zh and en and ja):
        # looser semantic check
        if not contains_any(zh + en, ["科幻", "science", "fiction", "sci-fi", "scifi"]):
            failures.append("B multilingual zh/en miss")
        if not contains_any(ja, ["紅茶", "tea", "紅茶"]):
            # Japanese may be stored as translation
            if not contains_any(search(scope_a, "tea"), ["茶", "tea", "紅茶"]):
                failures.append("B multilingual ja miss")

    # C. Duplicate facts
    print("[infer] C duplicate")
    before = search(scope_a, "蓝色 颜色", limit=20)
    before_n = len(before)
    add_content(scope_a, "用户喜欢蓝色。", infer=True)
    add_content(scope_a, "用户最喜欢的颜色是蓝色。", infer=True)
    time.sleep(0.5)
    after = search(scope_a, "蓝色 颜色", limit=20)
    blue_hits = [
        i for i in after if any(k in (i.get("content") or "") for k in ("蓝", "blue", "Blue"))
    ]
    print(f"  before={before_n} after={len(after)} blue_hits={len(blue_hits)}")
    # Must not explode unbounded duplicates — soft cap
    if len(blue_hits) > 6:
        failures.append(f"C too many blue memories: {len(blue_hits)}")

    # D. Correction (prefer conversational messages — mem0 update tools work better)
    print("[infer] D correction")
    corr_scope = f"yuvi:v1:user:corr-{RUN}:character:alice"
    r1 = add_messages(
        corr_scope,
        "用户喜欢红色。",
        "好的，记下了。",
        infer=True,
    )
    mid1 = (r1.get("data") or {}).get("memoryId")
    print(f"  first op={(r1.get('data') or {}).get('operation')} id={mid1}")
    time.sleep(0.5)
    r2 = add_messages(
        corr_scope,
        "用户之前说错了，真正喜欢的是蓝色，不再喜欢红色。",
        "已更新为蓝色。",
        infer=True,
    )
    op2 = (r2.get("data") or {}).get("operation")
    mid2 = (r2.get("data") or {}).get("memoryId")
    print(f"  second op={op2} id={mid2}")
    time.sleep(0.5)
    color_hits = search(corr_scope, "用户喜欢什么颜色")
    blob = contents(color_hits)
    print(f"  color hits={blob[:240]}")
    has_blue = any(k in blob for k in ("蓝", "blue", "Blue"))
    # Effective recall must surface blue; red-only is a failure.
    if not has_blue:
        failures.append("D blue not recalled after correction")
    # If red still present, it must not be the only/top equal fact without blue.
    has_red_only = ("红" in blob or "red" in blob.lower()) and not has_blue
    if has_red_only:
        failures.append("D red remains sole color fact after correction")
    # History must show real UPDATE/DELETE/ADD behaviour when id known.
    hist_id = mid2 if mid2 and mid2 != "unchanged" else mid1
    if hist_id and hist_id != "unchanged":
        hist = http_json("GET", f"/v1/memories/{hist_id}/history?scope={corr_scope}")
        events = [h.get("event") for h in (hist.get("data", {}).get("items") or [])]
        print(f"  history events={events}")
        if not any(e in ("UPDATE", "DELETE", "ADD") for e in events):
            failures.append("D history missing ADD/UPDATE/DELETE events")
        if op2 not in ("updated", "created", "deleted") and "UPDATE" not in events:
            # unchanged with no UPDATE history is an acceptance miss
            if op2 == "unchanged" and "UPDATE" not in events:
                failures.append("D correction produced no update operation/history")

    # E. Scope isolation
    print("[infer] E scope isolation")
    fact = f"隔离标记 {RUN}"
    add_content(scope_a, f"用户的隔离标记是 {RUN}-alice", infer=False)
    add_content(scope_lumi, f"用户的隔离标记是 {RUN}-lumi", infer=False)
    add_content(scope_b, f"用户的隔离标记是 {RUN}-b", infer=False)
    ha = search(scope_a, fact)
    hl = search(scope_lumi, fact)
    hb = search(scope_b, fact)
    a_ok = any(f"{RUN}-alice" in (i.get("content") or "") for i in ha)
    l_ok = any(f"{RUN}-lumi" in (i.get("content") or "") for i in hl)
    b_ok = any(f"{RUN}-b" in (i.get("content") or "") for i in hb)
    cross = any(f"{RUN}-lumi" in (i.get("content") or "") for i in ha) or any(
        f"{RUN}-alice" in (i.get("content") or "") for i in hb
    )
    print(f"  a={a_ok} lumi={l_ok} b={b_ok} cross={cross}")
    if not (a_ok and l_ok and b_ok) or cross:
        failures.append("E scope isolation failed")

    if failures:
        print("[infer] FAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("[infer] PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HTTPError, URLError) as exc:
        print(f"[infer] ERROR: {type(exc).__name__}")
        raise SystemExit(3) from exc
