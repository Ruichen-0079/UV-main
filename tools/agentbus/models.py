from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from agentbus.machine import WAITING_FOR_SPEC
from agentbus.util import utc_now


SCHEMA_VERSION = 2
DEFAULT_MAX_REPAIR = 2


def default_role(sandbox: str) -> dict[str, Any]:
    return {
        "model": None,
        "effort": None,
        "execution_mode": None,
        "profile": None,
        "sandbox": sandbox,
        "extra_args": [],
    }


def empty_state(stream_id: str) -> dict[str, Any]:
    now = utc_now()
    return {
        "schema_version": SCHEMA_VERSION,
        "stream_id": stream_id,
        "aliases": [],
        "alias_source": {},
        "alias_blocked": [],
        "goal": "",
        "campaign_id": None,
        "planner_provider": "browser",
        "review_policy": None,
        "review_authority": None,
        "delegated_reviews": [],
        "pr": None,
        "branch": None,
        "impl_worktree": None,
        "audit_worktree": None,
        "created_worktrees": {"impl": False, "audit": False},
        "phase": WAITING_FOR_SPEC,
        "prior_phase": None,
        "control": "running",
        "step_armed": False,
        "repair_cycles": 0,
        "max_repair_cycles": DEFAULT_MAX_REPAIR,
        "heads": {
            "current": None,
            "spec_base": None,
            "reviewed": None,
            "implemented": None,
            "audited": None,
            "last_seen": None,
        },
        "roles": {
            "impl": default_role("workspace-write"),
            "audit": default_role("read-only"),
        },
        "status": {
            "impl": "IDLE",
            "audit": "IDLE",
            "gpt": "WAITING",
            "next_action": "SPEC",
            "blocker": None,
            "latest_authority": None,
        },
        "envelopes": {},
        "seen_comment_ids": [],
        "rejected_comment_ids": [],
        "rejected_comments": [],
        "unpublished": [],
        "github": {
            "last_sync_at": None,
            "unavailable": False,
            "unauthenticated": False,
            "last_error": None,
        },
        "browser_gpt": {
            "display_name": None,
            "url": None,
            "note": None,
            "bound_at": None,
        },
        "merge_gpt": {
            "display_name": None,
            "url": None,
            "note": None,
            "bound_at": None,
        },
        "final_gpt": {
            "display_name": None,
            "url": None,
            "note": None,
            "bound_at": None,
        },
        "wait": None,
        "codex_interruption": None,
        "final_repair": {},
        "merge_txn": {},
        "merge_review_history": [],
        "merge_gpt_gate": {},
        "merge_prompt": {},
        "audit_request": None,
        "publication": {
            "status": "idle",
            "reason": None,
            "baseline_head": None,
            "commit": None,
            "pushed": False,
            "remote_sha": None,
            "files": [],
            "message": None,
            "updated_at": None,
        },
        "infra_publication_failures": 0,
        "created_at": now,
        "updated_at": now,
    }


def migrate_state(state: dict[str, Any]) -> dict[str, Any]:
    from agentbus.config import migrate_role_config

    state.setdefault("campaign_id", None)
    state.setdefault("planner_provider", "browser")
    state.setdefault("review_policy", None)
    state.setdefault("review_authority", None)
    state.setdefault("delegated_reviews", [])
    state.setdefault("merge_gpt", {"display_name": None, "url": None, "note": None, "bound_at": None})
    state.setdefault("final_gpt", {"display_name": None, "url": None, "note": None, "bound_at": None})
    state.setdefault("wait", None)
    state.setdefault("codex_interruption", None)
    state.setdefault("final_repair", {})
    state.setdefault("merge_txn", {})
    state.setdefault("merge_review_history", [])
    state.setdefault("merge_gpt_gate", {})
    state.setdefault("merge_prompt", {})
    roles = state.setdefault("roles", {})
    for role, sandbox in (("impl", "workspace-write"), ("audit", "read-only")):
        cfg = roles.setdefault(role, default_role(sandbox))
        cfg.setdefault("execution_mode", None)
        migrate_role_config(cfg)
    if int(state.get("schema_version") or 1) < SCHEMA_VERSION:
        state["schema_version"] = SCHEMA_VERSION
    return state


def clone_state(state: dict[str, Any]) -> dict[str, Any]:
    return deepcopy(state)


def role_label(role_cfg: dict[str, Any], inherited: str | None = None) -> str:
    parts: list[str] = []
    if role_cfg.get("profile"):
        parts.append(f"profile={role_cfg['profile']}")
    if role_cfg.get("model"):
        parts.append(str(role_cfg["model"]))
    elif inherited:
        parts.append(f"inherit:{inherited}")
    else:
        parts.append("inherit")
    if role_cfg.get("effort"):
        parts.append(str(role_cfg["effort"]))
    mode = role_cfg.get("execution_mode")
    if mode and mode != "standard":
        parts.append(f"exec={mode}")
    return " ".join(parts)


def envelope_summary(record: dict[str, Any] | None) -> str:
    if not record:
        return "-"
    kind = record.get("kind") or "?"
    status = record.get("status") or "-"
    head = (record.get("head") or "-")[:7]
    return f"{kind}/{status}@{head}"


@dataclass
class RuntimeRole:
    pid: int | None = None
    start_token: str | None = None
    started_at: str | None = None
    cmd: list[str] = field(default_factory=list)
    attempt_id: str | None = None
    last_exit: int | None = None


def empty_runtime() -> dict[str, Any]:
    return {
        "impl": {
            "pid": None,
            "start_token": None,
            "started_at": None,
            "cmd": [],
            "attempt_id": None,
            "last_exit": None,
        },
        "audit": {
            "pid": None,
            "start_token": None,
            "started_at": None,
            "cmd": [],
            "attempt_id": None,
            "last_exit": None,
        },
        "last_poll": None,
        "last_github_hash": None,
        "owner_pid": None,
        "konsole": {
            "impl": {"pid": None, "dbus": None, "session": None, "title": None},
            "audit": {"pid": None, "dbus": None, "session": None, "title": None},
        },
    }
