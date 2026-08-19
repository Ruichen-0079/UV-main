"""Read-only JSON views over existing AgentBus state. No transitions here."""

from __future__ import annotations

import json
import os
from typing import Any

from agentbus.attention import classify_attention
from agentbus.authority import current_generation_authority
from agentbus.actions import stream_archivable, stream_deletable, stream_purgeable
from agentbus.campaign import campaign_view, infer_campaign_id, is_obsolete, list_campaigns, load_campaign
from agentbus.config import (
    MODEL_REASONING_EFFORTS,
    discover_codex_capabilities,
    discover_models,
    discover_profiles,
    effective_role_config,
    effective_role_label,
    inherited_label,
)
from agentbus.decision import decision_for_stream
from agentbus.display import sanitize_display_text, sanitize_display_value
from agentbus.konsolebind import slot_alive
from agentbus.gitutil import head_sha, worktree_snapshot
from agentbus.github import pr_web_url
from agentbus.machine import (
    MERGED,
    display_state,
)
from agentbus.reviewpolicy import review_policy_of
from agentbus.models import envelope_summary
from agentbus.paths import RepoContext
from agentbus.recover import recover_stream, role_process_healthy
from agentbus.store import StreamStore, iter_stores
from agentbus.util import short_sha, tail_text


RAIL = ("GPT_SPEC", "IMPL", "AUDIT", "GPT_REVIEW", "GATE")


def attention_kind(state: dict[str, Any], runtime: dict[str, Any] | None = None) -> str:
    return classify_attention(state, runtime)["kind"]


def needs_you(state: dict[str, Any], runtime: dict[str, Any] | None = None) -> bool:
    return bool(classify_attention(state, runtime)["human_required"])


def rail_status(phase: str, control: str) -> dict[str, str]:
    visible = display_state(phase, control=control)
    order = {
        "WAITING_FOR_SPEC": 0,
        "IMPLEMENTING": 1,
        "VALIDATING": 1,
        "READY_FOR_AUDIT": 2,
        "AUDITING": 2,
        "READY_FOR_GPT": 3,
        "GPT_REVIEW": 3,
        "FINAL_GATE": 4,
        "MERGE_PENDING": 4,
        "MERGE_RETRYABLE_FAILED": 4,
        "MERGED": 5,
    }
    current = order.get(phase, 0)
    if visible == "PAUSED":
        marker = "paused"
    elif phase in {"BLOCKED", "BLOCKED_FOR_REVIEW", "RECOVERY_REQUIRED", "RE_REVIEW_REQUIRED"}:
        marker = "blocked"
    else:
        marker = "current"
    out: dict[str, str] = {}
    for index, name in enumerate(RAIL):
        if phase == MERGED or index < current:
            out[name] = "completed"
        elif index == current:
            out[name] = marker
        else:
            out[name] = "waiting"
    return out


def _terminal_state(state: dict[str, Any], runtime: dict[str, Any], role: str) -> str:
    if state.get("phase") == "RECOVERY_REQUIRED" and (state.get("status") or {}).get(role) == "CRASHED":
        return "RECOVERY_REQUIRED"
    slot = runtime.get(role) or {}
    if role_process_healthy(slot):
        return "RUNNING"
    konsole = ((runtime.get("konsole") or {}).get(role)) or {}
    if slot_alive(konsole):
        return "WAITING"
    return "CLOSED"


def _role_view(
    state: dict[str, Any],
    runtime: dict[str, Any],
    role: str,
    env: dict[str, str] | None,
    *,
    roots: tuple[str, ...] = (),
) -> dict[str, Any]:
    cfg = (state.get("roles") or {}).get(role) or {}
    slot = runtime.get(role) or {}
    konsole = ((runtime.get("konsole") or {}).get(role)) or {}
    healthy = role_process_healthy(slot)
    effective = effective_role_config(cfg, env)
    terminal = _terminal_state(state, runtime, role)
    return {
        "role": role,
        "label": effective_role_label(cfg, env),
        "model": cfg.get("model"),
        "effort": cfg.get("effort"),
        "execution_mode": effective.get("effective_execution_mode") or "standard",
        "requested_execution_mode": effective.get("requested_execution_mode"),
        "ultra_capability": effective.get("ultra_capability") or "unavailable",
        "profile": cfg.get("profile"),
        "sandbox": cfg.get("sandbox"),
        "effective": effective,
        "status": (state.get("status") or {}).get(role),
        "pid": slot.get("pid") if healthy else None,
        "process": "RUNNING" if healthy else ("CRASHED" if slot.get("last_exit") not in (None, 0) else "IDLE"),
        "last_exit": slot.get("last_exit"),
        "worktree": sanitize_display_text(
            state.get(f"{role}_worktree") or (state.get("impl_worktree") if role == "impl" else None),
            roots=roots,
        ),
        "konsole_pid": konsole.get("pid"),
        "konsole_title": konsole.get("title") or f"{str(state.get('stream_id') or '').upper()} | {role.upper()}",
        "konsole_present": slot_alive(konsole),
        "terminal": terminal,
        "applies": "next invocation",
    }


def stream_view(
    ctx: RepoContext,
    store: StreamStore,
    *,
    env: dict[str, str] | None = None,
    recover: bool = False,
    allow_busy: bool = False,
) -> dict[str, Any]:
    stream_busy = False
    if allow_busy:
        view_lock = store.lock(exclusive=recover)
        if not view_lock.try_acquire():
            # State/runtime writes are atomic.  A view can safely render the
            # last durable snapshot while the owner performs reconciliation;
            # it must not turn normal stream serialization into a 500.
            state = store.load()
            runtime = store.load_runtime()
            stream_busy = True
        else:
            try:
                state = store.load()
                if recover:
                    recover_stream(store, state)
                    store.save(state)
                runtime = store.load_runtime()
            finally:
                view_lock.release()
    elif recover:
        with store.lock():
            state = store.load()
            recover_stream(store, state)
            store.save(state)
            runtime = store.load_runtime()
    else:
        with store.lock(exclusive=False):
            state = store.load()
            runtime = store.load_runtime()
    impl = state.get("impl_worktree")
    audit_root = state.get("audit_worktree")
    display_roots = tuple(str(item) for item in (audit_root, impl, ctx.repo_root) if item)
    current = head_sha(impl) if impl else (state.get("heads") or {}).get("current")
    control = state.get("control") or "running"
    phase = state.get("phase") or ""
    envelopes = state.get("envelopes") or {}
    impl_snap = worktree_snapshot(impl)
    campaign = None
    loaded = None
    campaign_id = state.get("campaign_id") or infer_campaign_id(state)
    if campaign_id:
        loaded = load_campaign(ctx, campaign_id)
        campaign = campaign_view(loaded, ctx)
    from agentbus.mergegate import (
        fetch_live_pr,
        gpt_suggestion,
        merge_gpt_binding,
        merge_review_card,
    )

    suggestion = gpt_suggestion(state, loaded)
    live_pr = None
    # Query GitHub only for merge-terminal cards.  This prevents a stale UI
    # snapshot from enabling the human merge action; failures remain a
    # structured, disabled UI state and never make rendering fail.
    if phase in {"FINAL_GATE", "MERGE_PENDING", "MERGE_RETRYABLE_FAILED"} and state.get("pr"):
        try:
            live_pr = fetch_live_pr(ctx, state, env)
        except Exception:  # noqa: BLE001
            live_pr = None
    merge_card = merge_review_card(state, loaded, live=live_pr, ctx=ctx)
    from agentbus.decision import active_blocker

    blocker = sanitize_display_text(active_blocker(state), roots=display_roots)
    decision_live = live_pr or ((state.get("github") or {}).get("pr") if isinstance((state.get("github") or {}).get("pr"), dict) else None)
    decision = decision_for_stream(ctx, state, loaded, decision_live, runtime, env=env)
    classified = classify_attention(state, runtime, campaign=loaded, decision=decision)
    kind = classified["kind"]
    from agentbus.settings import load_settings, resolve_final_gpt_binding, resolve_product_gpt_binding

    settings = load_settings(ctx)
    product_binding = resolve_product_gpt_binding(state, loaded, settings)
    final_binding = resolve_final_gpt_binding(state, settings)
    return {
        "stream_id": state.get("stream_id"),
        "stream_busy": stream_busy,
        "goal": state.get("goal") or "",
        "pr": state.get("pr"),
        "pr_url": pr_web_url(ctx.origin, state.get("pr")),
        "branch": state.get("branch"),
        "head": current,
        "head_short": short_sha(current),
        "phase": phase,
        "visible_phase": display_state(phase, control=control),
        "control": control,
        "attention": kind,
        "attention_category": classified.get("category"),
        "attention_owner": classified["attention_owner"],
        "human_required": classified["human_required"],
        "browser_gpt_required": classified["browser_gpt_required"],
        "needs_you": classified["human_required"],
        "review_policy": review_policy_of(state),
        "review_authority": state.get("review_authority"),
        "campaign": sanitize_display_value(campaign, roots=display_roots),
        "campaign_id": state.get("campaign_id") or (campaign or {}).get("campaign_id"),
        "planner_provider": state.get("planner_provider") or "browser",
        "repair_cycles": state.get("repair_cycles") or 0,
        "max_repair_cycles": state.get("max_repair_cycles") or 2,
        "latest_authority": current_generation_authority(state),
        "next_action": decision.action,
        "next_detail": sanitize_display_text(blocker or decision.reason, roots=display_roots),
        "blocker": blocker or None,
        "who": decision.action,
        "impl": _role_view(state, runtime, "impl", env, roots=display_roots),
        "audit": _role_view(state, runtime, "audit", env, roots=display_roots),
        "browser_gpt": product_binding,
        "product_gpt": product_binding,
        "merge_gpt": final_binding,
        "final_gpt": final_binding,
        "gpt_suggestion": suggestion,
        "merge_review": merge_card,
        "heads": state.get("heads") or {},
        "envelopes": {
            kind: {
                "status": rec.get("status"),
                "head": rec.get("head"),
                "summary": sanitize_display_text(envelope_summary(rec), roots=display_roots),
                "raw": sanitize_display_text(rec.get("raw") or "", roots=display_roots),
            }
            for kind, rec in envelopes.items()
            if isinstance(rec, dict)
        },
        "github": sanitize_display_value(state.get("github") or {}, roots=display_roots),
        "rail": rail_status(phase, control),
        "impl_worktree": sanitize_display_text(impl, roots=display_roots),
        "audit_worktree": sanitize_display_text(audit_root, roots=display_roots),
        "impl_dirty": impl_snap.get("dirty"),
        "updated_at": state.get("updated_at"),
        "audit_request": sanitize_display_value(state.get("audit_request"), roots=display_roots),
        "github_connected": not bool((state.get("github") or {}).get("unavailable")),
        "publication": sanitize_display_value(state.get("publication") or {}, roots=display_roots),
        "aliases": state.get("aliases") or [],
        "rejected_comments": sanitize_display_value(state.get("rejected_comments") or [], roots=display_roots),
        "obsolete": is_obsolete(state),
        "superseded_by": state.get("superseded_by"),
        "stream_class": state.get("stream_class"),
        "gpt_gate": state.get("gpt_gate") or {},
        "automation_mode": (campaign or {}).get("automation_mode") if campaign else None,
        "deletable": stream_archivable(state, runtime)["ok"],
        "delete_reason": stream_archivable(state, runtime)["reason"],
        "archivable": stream_archivable(state, runtime)["ok"],
        "archive_reason": stream_archivable(state, runtime)["reason"],
        "purgeable": stream_purgeable(state, runtime)["ok"],
        "purge_reason": stream_purgeable(state, runtime)["reason"],
        "archived": bool(state.get("archived")),
        "archive": state.get("archive") or {},
    }


def list_stream_views(
    ctx: RepoContext,
    env: dict[str, str] | None = None,
    *,
    include_archived: bool = False,
    allow_busy: bool = False,
) -> list[dict[str, Any]]:
    views = [stream_view(ctx, store, env=env, allow_busy=allow_busy) for store in iter_stores(ctx)]
    for item in views:
        for rec in (item.get("envelopes") or {}).values():
            if isinstance(rec, dict):
                rec.pop("raw", None)
    if not include_archived:
        views = [item for item in views if not item.get("archived")]
    return sorted(views, key=lambda item: item.get("stream_id") or "")


def overview(
    ctx: RepoContext,
    env: dict[str, str] | None = None,
    *,
    include_archived: bool = False,
    allow_busy: bool = False,
) -> dict[str, Any]:
    all_views = list_stream_views(ctx, env, include_archived=True, allow_busy=allow_busy)
    archived = [item for item in all_views if item.get("archived")]
    streams = all_views if include_archived else [item for item in all_views if not item.get("archived")]
    counts = {
        "running": 0,
        "waiting": 0,
        "needs_gpt": 0,
        "needs_you": 0,
        "blocked": 0,
        "paused": 0,
        "complete": 0,
        "archived": len(archived),
        "total": len(streams),
    }
    categories = {"RUNNING": 0, "AUTO_WAIT": 0, "NEEDS_YOU": 0, "COMPLETE": 0}
    visible = [item for item in streams if not item.get("obsolete")]
    for item in visible:
        kind = item.get("attention") or "waiting"
        if kind in counts:
            counts[kind] += 1
        category = item.get("attention_category") or "AUTO_WAIT"
        if category in categories:
            categories[category] += 1
    campaigns = [campaign_view(item, ctx) for item in list_campaigns(ctx)]
    campaigns = [item for item in campaigns if item]
    counted_gpt = {item.get("campaign_id") for item in visible if item.get("browser_gpt_required")}
    for camp in campaigns:
        if camp.get("status") == "WAITING_FOR_PLAN" and camp.get("campaign_id") not in counted_gpt:
            counts["needs_gpt"] += 1
        elif camp.get("human_required"):
            counts["needs_you"] += 1
    handoffs = []
    for item in visible:
        gate = item.get("gpt_gate") or {}
        camp = item.get("campaign") or {}
        needs_gpt = item.get("browser_gpt_required") or camp.get("browser_gpt_required")
        binding = item.get("final_gpt") if item.get("next_action") == "FINAL_GPT" else item.get("product_gpt")
        if needs_gpt and (binding or {}).get("url"):
            handoffs.append(
                {
                    "stream_id": item.get("stream_id"),
                    "url": (binding or {}).get("url"),
                    "generation": gate.get("generation"),
                    "open_once": bool(gate.get("notified") and not gate.get("opened_at")),
                }
            )
    from agentbus.codexpool import pool_status
    from agentbus.settings import browser_bridge_status, load_settings

    return {
        "repo_id": ctx.repo_id,
        "repo_root": ctx.repo_root,
        "origin": ctx.origin,
        "inherit": inherited_label(env),
        "counts": counts,
        "attention_categories": categories,
        "streams": streams,
        "archived": archived if include_archived else [],
        "archived_count": len(archived),
        "campaigns": campaigns,
        "needs_you": [item for item in visible if item.get("human_required")],
        "needs_gpt": [item for item in visible if item.get("browser_gpt_required")],
        "handoffs": handoffs,
        "settings": load_settings(ctx),
        "browser_bridge": browser_bridge_status(ctx),
        "codex_pool": pool_status(ctx, env),
    }


def event_rows(store: StreamStore, limit: int = 80) -> list[dict[str, Any]]:
    path = store.events_path
    if not os.path.isfile(path):
        return []
    lines = tail_text(path, limit).splitlines()
    rows: list[dict[str, Any]] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = rec.get("kind") or "event"
        detail = sanitize_display_text(_event_detail(rec))
        rows.append(
            {
                "ts": rec.get("ts"),
                "kind": kind,
                "label": _event_label(kind, rec),
                "detail": detail,
                "raw": sanitize_display_value(rec),
            }
        )
    return list(reversed(rows))


def _event_label(kind: str, rec: dict[str, Any]) -> str:
    mapping = {
        "created": "Stream created",
        "envelope": f"{rec.get('envelope') or 'envelope'} ingested",
        "invoke": f"{str(rec.get('role') or '').upper()} started",
        "invoke_done": f"{str(rec.get('role') or '').upper()} finished",
        "pause": "Paused",
        "resume": "Resumed",
        "set-model": "Role model updated",
        "bind-gpt": "Browser GPT bound",
        "unbind-gpt": "Browser GPT cleared",
        "ack": "Acknowledged",
    }
    if kind == "envelope" and rec.get("status"):
        return f"{rec.get('envelope')} ingested — {rec.get('status')}"
    if kind == "invoke_done" and rec.get("head_after"):
        return f"{str(rec.get('role') or '').upper()} completed — {short_sha(str(rec.get('head_after')))}"
    return mapping.get(kind, kind.replace("_", " "))


def _event_detail(rec: dict[str, Any]) -> str:
    parts = []
    for key in ("phase", "status", "head", "model", "effort", "role", "display_name"):
        if rec.get(key):
            parts.append(f"{key}={rec[key]}")
    return " ".join(parts)


def catalog(env: dict[str, str] | None = None) -> dict[str, Any]:
    caps = discover_codex_capabilities(env)
    ultra = caps.get("ultra") or {}
    return {
        "models": discover_models(env),
        "profiles": discover_profiles(env),
        "inherit": inherited_label(env),
        "efforts": list(MODEL_REASONING_EFFORTS),
        "execution_modes": caps.get("execution_modes") or ["standard"],
        "ultra": {
            "supported": bool(ultra.get("exposed_as_exec_mode")),
            "message": None if ultra.get("exposed_as_exec_mode") else "Ultra：当前 Codex CLI 不支持",
            "meaning": ultra.get("meaning"),
            "invocation": ultra.get("invocation"),
        },
        "codex": {"version": caps.get("version"), "writes_global_config": False},
    }
