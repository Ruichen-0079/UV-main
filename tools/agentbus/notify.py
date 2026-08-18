"""Optional KDE notifications. Never steals focus."""

from __future__ import annotations

import os
from typing import Any

from agentbus.util import run_cmd, which


NOTIFY_PHASES = {
    "READY_FOR_GPT": ("needs GPT", "Audit passed. Browser GPT review is required."),
    "FINAL_GATE": ("needs you", "Merge gate: independent Merge GPT then explicit 通过并合并. Never auto-merged."),
    "MERGE_PENDING": ("retrying merge", "FINAL_GATE passed; merge not finished."),
    "MERGE_RETRYABLE_FAILED": ("needs you", "Authorized merge did not complete."),
    "BLOCKED_FOR_REVIEW": ("needs you", "Automatic repair limit reached."),
    "RECOVERY_REQUIRED": ("needs you", "A runner crashed or recovered incompletely."),
    "RE_REVIEW_REQUIRED": ("needs you", "SHA fence failed. Human decision required."),
}


def notify_custom(stream_id: str, title: str, body: str) -> None:
    if os.environ.get("YUVI_AGENTBUS_NOTIFY") == "0":
        return
    if not which("notify-send"):
        return
    run_cmd(
        [
            "notify-send",
            "--app-name=Yuvi AgentBus",
            "--urgency=normal",
            "--expire-time=12000",
            f"Yuvi AgentBus — {stream_id.upper()} {title}",
            body,
        ],
        timeout=5,
    )


def notify_phase(stream_id: str, phase: str) -> None:
    info = NOTIFY_PHASES.get(phase)
    if not info:
        return
    title, body = info
    notify_custom(stream_id, title, body)


def maybe_notify_transition(runtime: dict[str, Any], stream_id: str, phase: str) -> dict[str, Any]:
    last = runtime.get("last_notified_phase")
    if phase == last:
        return runtime
    if phase in NOTIFY_PHASES:
        notify_phase(stream_id, phase)
        runtime["last_notified_phase"] = phase
    elif last and phase not in NOTIFY_PHASES:
        runtime["last_notified_phase"] = phase
    return runtime
