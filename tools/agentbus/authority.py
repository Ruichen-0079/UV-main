"""Current-generation latest_authority projection. Does not change protocol semantics."""

from __future__ import annotations

from typing import Any

from agentbus import machine
from agentbus.reviewpolicy import DELEGATED_AUTHORITY


# Lowest → highest current-generation durable authority.
GENERATION_ORDER = (
    "GPT_SPEC",
    "CODEX_REPORT",
    "CODEX_AUDIT",
    "GPT_REVIEW",
    "GPT_MERGE_REVIEW",
    "FINAL_GATE",
)


def generation_head(state: dict[str, Any]) -> str | None:
    heads = state.get("heads") or {}
    return heads.get("implemented") or heads.get("current")


def _head_of(rec: dict[str, Any] | None) -> str | None:
    if not rec:
        return None
    return rec.get("head") or None


def matches_current_generation(kind: str, rec: dict[str, Any] | None, state: dict[str, Any]) -> bool:
    if not rec:
        return False
    head = _head_of(rec)
    current = generation_head(state)
    if kind == "GPT_SPEC":
        return True
    if not head or not current:
        return False
    return head == current


def current_generation_authority(state: dict[str, Any]) -> str:
    envelopes = state.get("envelopes") or {}
    phase = state.get("phase") or ""
    if phase == machine.MERGED:
        rec = envelopes.get("FINAL_GATE") or envelopes.get("GPT_REVIEW")
        if rec:
            return f"{rec.get('kind') or 'FINAL_GATE'}:{rec.get('status') or '-'}"
        return "MERGED"
    if state.get("review_authority") == DELEGATED_AUTHORITY and phase == machine.FINAL_GATE:
        return f"GPT_REVIEW_DELEGATED:{DELEGATED_AUTHORITY}"

    report = envelopes.get("CODEX_REPORT")
    if isinstance(report, dict) and matches_current_generation("CODEX_REPORT", report, state) and state.get("pr"):
        from agentbus.publish import report_is_durable

        if not report_is_durable(state):
            return "CODEX_REPORT:PUBLICATION_PENDING"

    best_kind = None
    best_rec = None
    for kind in GENERATION_ORDER:
        rec = envelopes.get(kind)
        if not isinstance(rec, dict):
            continue
        if not matches_current_generation(kind, rec, state):
            continue
        best_kind, best_rec = kind, rec
    if best_kind and best_rec:
        return f"{best_kind}:{best_rec.get('status') or '-'}"
    return "-"


def refresh_authority(state: dict[str, Any]) -> dict[str, Any]:
    status = state.setdefault("status", {})
    status["latest_authority"] = current_generation_authority(state)
    return state
