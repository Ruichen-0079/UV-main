"""Structured logging without secrets or full memory content by default."""

from __future__ import annotations

import json
import logging
import sys
from typing import Any


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def log_event(
    logger: logging.Logger,
    *,
    operation: str,
    duration_ms: int,
    scope_hash: str | None = None,
    result_count: int | None = None,
    infer: bool | None = None,
    backend: str = "mem0",
    error_code: str | None = None,
    request_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    payload: dict[str, Any] = {
        "operation": operation,
        "durationMs": duration_ms,
        "backend": backend,
    }
    if scope_hash is not None:
        payload["scopeHash"] = scope_hash
    if result_count is not None:
        payload["resultCount"] = result_count
    if infer is not None:
        payload["infer"] = infer
    if error_code is not None:
        payload["errorCode"] = error_code
    if request_id is not None:
        payload["requestId"] = request_id
    if extra:
        payload.update(extra)
    logger.info(json.dumps(payload, ensure_ascii=False))


def hash_scope(scope: str) -> str:
    value = 2166136261
    for ch in scope:
        value ^= ord(ch)
        value = (value * 16777619) & 0xFFFFFFFF
    return f"s{value:08x}"
