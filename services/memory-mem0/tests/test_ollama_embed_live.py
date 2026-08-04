"""Live Ollama embedding probe (skips if Ollama is offline)."""

from __future__ import annotations

import httpx
import pytest

OLLAMA = "http://127.0.0.1:11434"
MODEL = "yuvi-embedding:0.6b"


def test_ollama_yuvi_embedding_is_1024() -> None:
    try:
        response = httpx.post(
            f"{OLLAMA}/api/embed",
            json={"model": MODEL, "input": "用户喜欢与本地 AI 伴侣聊天。"},
            timeout=20.0,
        )
    except httpx.HTTPError as exc:
        pytest.skip(f"Ollama unavailable: {exc}")
    if response.status_code >= 400:
        pytest.skip(f"Ollama embed failed: HTTP {response.status_code}")
    data = response.json()
    embeddings = data.get("embeddings") or []
    assert embeddings, "expected embeddings array"
    assert len(embeddings[0]) == 1024
