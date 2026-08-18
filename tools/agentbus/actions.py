"""Shared mutations used by CLI and WebUI. Not a second state machine."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

from agentbus.apply import refresh_next, set_phase
from agentbus.config import (
    effort_allowed_for_model,
    normalize_effort,
    parse_execution_mode,
    parse_model_spec,
)
from agentbus.gitutil import head_sha
from agentbus.github import pr_view

from agentbus.paths import AgentbusError, RepoContext, normalize_stream_id
from agentbus.store import StreamStore
from agentbus.util import utc_now
from agentbus.campaign import is_obsolete
from agentbus.machine import IMPLEMENTING, MERGED, PAUSED, READY_FOR_AUDIT, WAITING_FOR_SPEC
from agentbus.worktree import bind_or_create_impl, cleanup_stream_worktrees


def pause_stream(store: StreamStore) -> dict[str, Any]:
    with store.lock():
        state = store.load()
        state["control"] = "paused"
        store.append_event("pause", {"phase": state["phase"]})
        refresh_next(state)
        store.save(state)
    return state


def resume_stream(store: StreamStore) -> dict[str, Any]:
    with store.lock():
        state = store.load()
        if state["phase"] == PAUSED and state.get("prior_phase"):
            set_phase(state, state["prior_phase"], reason="resume")
        state["control"] = "running"
        store.append_event("resume", {"phase": state["phase"]})
        refresh_next(state)
        store.save(state)
    return state


def arm_step(store: StreamStore) -> dict[str, Any]:
    with store.lock():
        state = store.load()
        state["control"] = "step"
        state["step_armed"] = True
        refresh_next(state)
        store.save(state)
    return state


def set_role_model(
    store: StreamStore,
    role: str,
    *,
    model: str | None = None,
    effort: str | None = None,
    profile: str | None = None,
    inherit_model: bool = False,
    inherit_effort: bool = False,
    inherit_profile: bool = False,
    execution_mode: str | None = None,
    inherit_execution_mode: bool = False,
) -> dict[str, Any]:
    if role not in {"impl", "audit"}:
        raise AgentbusError("role must be impl or audit")
    with store.lock():
        state = store.load()
        cfg = state.setdefault("roles", {}).setdefault(role, {})
        if inherit_model:
            cfg["model"] = None
        elif model:
            spec = parse_model_spec(model)
            cfg["model"] = spec["model"]
            if spec["effort"] and not effort:
                cfg["effort"] = spec["effort"]
            if cfg.get("effort") and not effort_allowed_for_model(cfg.get("model"), cfg.get("effort")):
                cfg["effort_warning"] = (
                    f"effort {cfg['effort']} is not supported for {cfg['model']}; falling back to inherit"
                )
                cfg["effort"] = None
        if inherit_effort:
            cfg["effort"] = None
        elif effort:
            value = normalize_effort(effort)
            model = cfg.get("model")
            if model and not effort_allowed_for_model(model, value):
                raise AgentbusError(f"effort {value} is not supported for {model}")
            cfg["effort"] = value
        if inherit_execution_mode:
            cfg["execution_mode"] = None
        elif execution_mode:
            cfg["execution_mode"] = parse_execution_mode(execution_mode)
        if inherit_profile:
            cfg["profile"] = None
        elif profile is not None:
            cfg["profile"] = None if profile in {"", "-", "none", "inherit"} else profile
        store.append_event(
            "set-model",
            {
                "role": role,
                "model": cfg.get("model"),
                "effort": cfg.get("effort"),
                "execution_mode": cfg.get("execution_mode"),
                "profile": cfg.get("profile"),
            },
        )
        store.save(state)
    return state


def validate_browser_url(url: str) -> str:
    value = url.strip()
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise AgentbusError("Browser GPT URL must be http(s)://...")
    return value


def bind_browser_gpt(
    store: StreamStore,
    *,
    display_name: str | None,
    url: str | None,
    note: str | None,
) -> dict[str, Any]:
    with store.lock():
        state = store.load()
        binding = state.setdefault(
            "browser_gpt",
            {"display_name": None, "url": None, "note": None, "bound_at": None},
        )
        if display_name is not None:
            binding["display_name"] = display_name.strip() or None
        if url is not None:
            binding["url"] = validate_browser_url(url) if url.strip() else None
        if note is not None:
            binding["note"] = note.strip() or None
        binding["bound_at"] = utc_now()
        store.append_event(
            "bind-gpt",
            {"display_name": binding.get("display_name"), "has_url": bool(binding.get("url"))},
        )
        store.save(state)
    return state


def unbind_browser_gpt(store: StreamStore) -> dict[str, Any]:
    with store.lock():
        state = store.load()
        phase_before = state.get("phase")
        state["browser_gpt"] = {
            "display_name": None,
            "url": None,
            "note": None,
            "bound_at": None,
        }
        store.append_event("unbind-gpt", {"phase": phase_before})
        store.save(state)
    return state


def create_stream(
    ctx: RepoContext,
    stream_id: str,
    *,
    pr: int | None = None,
    branch: str | None = None,
    goal: str | None = None,
    worktree: str | None = None,
    create_worktree: bool = False,
    start_point: str | None = None,
    impl_model: str | None = None,
    impl_effort: str | None = None,
    audit_model: str | None = None,
    audit_effort: str | None = None,
    browser_name: str | None = None,
    browser_url: str | None = None,
    browser_note: str | None = None,
) -> tuple[dict[str, Any], list[str]]:
    from agentbus.streamid import assert_no_create_collision, ensure_stream_aliases

    stream_id = normalize_stream_id(stream_id)
    store = StreamStore(ctx, stream_id)
    if store.exists():
        raise AgentbusError(f"stream {stream_id} already exists")
    assert_no_create_collision(ctx, stream_id)
    goal_value = goal
    branch_value = branch
    if pr:
        try:
            view = pr_view(ctx.repo_root, int(pr))
            branch_value = branch_value or view.get("headRefName")
            goal_value = goal_value or view.get("title")
        except AgentbusError:
            pass
    state = store.initialize(goal=goal_value or "", pr=pr, branch=branch_value)
    notes = ensure_stream_aliases(ctx, state)
    notes.extend(
        bind_or_create_impl(
            store,
            state,
            repo_root=ctx.repo_root,
            requested=worktree,
            create=create_worktree,
            start_point=start_point,
        )
    )
    if impl_model:
        spec = parse_model_spec(impl_model)
        state["roles"]["impl"]["model"] = spec["model"]
        if spec["effort"]:
            state["roles"]["impl"]["effort"] = spec["effort"]
    if impl_effort:
        state["roles"]["impl"]["effort"] = normalize_effort(impl_effort)
    if audit_model:
        spec = parse_model_spec(audit_model)
        state["roles"]["audit"]["model"] = spec["model"]
        if spec["effort"]:
            state["roles"]["audit"]["effort"] = spec["effort"]
    if audit_effort:
        state["roles"]["audit"]["effort"] = normalize_effort(audit_effort)
    if browser_url or browser_name:
        if browser_url:
            validate_browser_url(browser_url)
        state["browser_gpt"] = {
            "display_name": (browser_name or "").strip() or None,
            "url": (browser_url or "").strip() or None,
            "note": (browser_note or "").strip() or None,
            "bound_at": utc_now() if (browser_url or browser_name) else None,
        }
    refresh_next(state)
    store.save(state)
    return state, notes


def resolve_audit_target(state: dict[str, Any], *, allow_pr_head: bool = False, pr_head: str | None = None) -> dict[str, Any]:
    implemented = (state.get("heads") or {}).get("implemented")
    current = (state.get("heads") or {}).get("current")
    impl_dir = state.get("impl_worktree")
    if impl_dir:
        current = head_sha(impl_dir) or current
    if implemented and (not current or implemented == current):
        return {
            "ok": True,
            "target": implemented,
            "source": "IMPLEMENTED_HEAD",
            "reason": "IMPLEMENTED_HEAD matches the current implementation HEAD.",
        }
    if implemented and current and implemented != current:
        return {
            "ok": False,
            "target": implemented,
            "source": "IMPLEMENTED_HEAD",
            "reason": (
                f"IMPLEMENTED_HEAD {implemented[:12]} != current HEAD {current[:12]}. "
                "Refuse to silently audit a different commit."
            ),
        }
    if allow_pr_head and pr_head:
        return {
            "ok": True,
            "target": pr_head,
            "source": "PR_HEAD",
            "reason": "No IMPLEMENTED_HEAD; using explicit PR HEAD.",
        }
    return {
        "ok": False,
        "target": None,
        "source": None,
        "reason": "No auditable IMPLEMENTED_HEAD. Implement first, or pass an explicit PR HEAD.",
    }


def request_audit_current(
    store: StreamStore,
    *,
    expected_target: str | None = None,
    allow_pr_head: bool = False,
    pr_head: str | None = None,
) -> dict[str, Any]:
    with store.lock():
        state = store.load()
        resolved = resolve_audit_target(state, allow_pr_head=allow_pr_head, pr_head=pr_head)
        if not resolved["ok"]:
            raise AgentbusError(resolved["reason"])
        target = resolved["target"]
        if expected_target and expected_target != target:
            raise AgentbusError(
                f"HEAD changed before audit began. Previewed {expected_target[:12]}, now {target[:12]}."
            )
        request = {
            "id": utc_now(),
            "target": target,
            "source": resolved["source"],
            "status": "pending",
            "requested_at": utc_now(),
        }
        state["audit_request"] = request
        if state["phase"] in {"READY_FOR_GPT", "GPT_REVIEW", "FINAL_GATE"}:
            set_phase(state, READY_FOR_AUDIT, reason="Audit Current")
        elif state["phase"] not in {"READY_FOR_AUDIT", "AUDITING"}:
            if state["phase"] in {"IMPLEMENTING", "VALIDATING", "WAITING_FOR_SPEC"}:
                raise AgentbusError(f"cannot Audit Current from phase {state['phase']}")
            if state["phase"] in {"RECOVERY_REQUIRED", "BLOCKED", "RE_REVIEW_REQUIRED"}:
                set_phase(state, READY_FOR_AUDIT, reason="Audit Current after recovery")
        store.append_event("audit-current", {"target": target, "source": resolved["source"]})
        store.save(state)
    return {"ok": True, **resolved, "request": request}


def publish_existing_implementation(
    ctx,
    store: StreamStore,
    *,
    reset_infra_budget: bool = False,
    expected_paths: list[str] | None = None,
    recovery: bool = False,
):
    from agentbus.publish import (
        apply_published_report,
        publish_implementation,
        reset_infra_repair_budget,
    )
    from agentbus.gitutil import head_sha

    with store.lock():
        state = store.load()
        worktree = state.get("impl_worktree")
        if not worktree:
            raise AgentbusError("no impl worktree")
        if reset_infra_budget:
            reset_infra_repair_budget(state, reason="publication recovery")
            if state["phase"] == "BLOCKED_FOR_REVIEW":
                set_phase(state, IMPLEMENTING, reason="recover unpublished implementation")
        baseline = (state.get("publication") or {}).get("baseline_head") or head_sha(worktree)
        result = publish_implementation(
            store,
            state,
            ctx,
            baseline_head=baseline,
            expected_paths=expected_paths,
            push=True,
        )
        if not result.get("ok"):
            store.save(state)
            raise AgentbusError(result.get("reason") or "publication failed")
        extra = None
        if recovery:
            extra = {"RECOVERY": "existing implementation published without Codex redo"}
        apply_published_report(
            store,
            state,
            commit=result["commit"],
            files=result.get("files") or [],
            worktree=worktree,
            envelope=None,
            extra_fields=extra,
        )
        rec = (state.get("envelopes") or {}).get("CODEX_REPORT") or {}
        if state.get("pr") and rec.get("raw"):
            from agentbus.github import publish_body

            publish_body(state, rec["raw"], repo_root=ctx.repo_root)
        store.save(state)
    return result


def stream_archivable(state: dict[str, Any], runtime: dict[str, Any] | None = None) -> dict[str, Any]:
    """MERGED campaign units and obsolete candidates may be archived."""
    if state.get("archived"):
        return {"ok": False, "reason": "already archived"}
    if is_obsolete(state):
        return {"ok": True, "reason": "obsolete"}
    if (state.get("phase") or "") == MERGED:
        return {"ok": True, "reason": "completed"}
    return {"ok": False, "reason": "only MERGED or obsolete units can be archived"}


def stream_purgeable(state: dict[str, Any], runtime: dict[str, Any] | None = None) -> dict[str, Any]:
    """True purge is only for owned abandoned local drafts."""
    from agentbus.recover import role_process_healthy

    if role_process_healthy((runtime or {}).get("impl") or {}) or role_process_healthy(
        (runtime or {}).get("audit") or {}
    ):
        return {"ok": False, "reason": "PURGE_NOT_ALLOWED: role runner is still alive"}
    if state.get("pr"):
        return {"ok": False, "reason": "PURGE_NOT_ALLOWED: PR-backed unit"}
    if (state.get("heads") or {}).get("merged"):
        return {"ok": False, "reason": "PURGE_NOT_ALLOWED: merge anchor"}
    if (state.get("phase") or "") == MERGED:
        return {"ok": False, "reason": "PURGE_NOT_ALLOWED: MERGED campaign/history unit"}
    if state.get("campaign_id") and (
        ((state.get("envelopes") or {}).get("GPT_CONTINUATION"))
        or ((state.get("campaign") or {}).get("next_stream"))
        or (state.get("transport") or {}).get("continuation_comment_id")
    ):
        return {"ok": False, "reason": "PURGE_NOT_ALLOWED: campaign continuation authority"}
    pub = state.get("publication") or {}
    if pub.get("commit") or pub.get("history"):
        return {"ok": False, "reason": "PURGE_NOT_ALLOWED: publication history"}
    if (state.get("control") or "") == "paused" and (state.get("phase") or "") == WAITING_FOR_SPEC and not state.get("pr"):
        return {"ok": True, "reason": "abandoned local draft"}
    return {"ok": False, "reason": "PURGE_NOT_ALLOWED: not an owned abandoned local draft"}


def stream_deletable(state: dict[str, Any], runtime: dict[str, Any] | None = None) -> dict[str, Any]:
    """Legacy probe. Safe delete means archive, never hard-delete campaign history."""
    archived = stream_archivable(state, runtime)
    if archived["ok"]:
        return {"ok": True, "reason": archived["reason"], "maps_to": "archive"}
    purge = stream_purgeable(state, runtime)
    if purge["ok"]:
        return {"ok": False, "reason": "use purge for abandoned local drafts", "maps_to": "purge"}
    return {"ok": False, "reason": archived.get("reason") or "active work unit"}


def forget_stream_from_campaigns(ctx: RepoContext, stream_id: str) -> list[str]:
    from agentbus.campaign import campaign_lock, list_campaigns, save_campaign

    notes: list[str] = []
    sid = normalize_stream_id(stream_id)
    with campaign_lock(ctx):
        for campaign in list_campaigns(ctx):
            changed = False
            units = [item for item in (campaign.get("units") or []) if item.get("stream_id") != sid]
            if len(units) != len(campaign.get("units") or []):
                campaign["units"] = units
                changed = True
            queue = [
                item
                for item in (campaign.get("queue") or [])
                if item.get("next_stream") != sid and item.get("after_stream") != sid
            ]
            if len(queue) != len(campaign.get("queue") or []):
                campaign["queue"] = queue
                changed = True
            if campaign.get("active_stream") == sid:
                campaign["active_stream"] = None
                changed = True
            if changed:
                save_campaign(ctx, campaign)
                notes.append(f"removed {sid} from campaign {campaign.get('campaign_id')}")
    return notes


def archive_campaign_unit(store: StreamStore, state: dict[str, Any]) -> dict[str, Any]:
    """Hide a unit without destroying continuation authority."""
    from agentbus.github import pr_web_url
    from agentbus.paths import origin_url

    cont = (state.get("envelopes") or {}).get("GPT_CONTINUATION") or {}
    campaign = state.get("campaign") or {}
    transport = state.get("transport") or {}
    comment_ids = []
    if cont.get("source_id"):
        comment_ids.append(str(cont["source_id"]))
    if transport.get("continuation_comment_id"):
        comment_ids.append(str(transport["continuation_comment_id"]))
    consumed = []
    if (state.get("continuation") or {}).get("continuation_comment_id"):
        consumed.append(str(state["continuation"]["continuation_comment_id"]))
    origin = ""
    try:
        origin = origin_url(store.ctx.repo_root)
    except Exception:  # noqa: BLE001
        origin = ""
    state["archived"] = True
    state["hidden_from_attention"] = True
    state["archive"] = {
        "stream_id": state.get("stream_id"),
        "campaign_id": state.get("campaign_id"),
        "pr_number": state.get("pr"),
        "pr": state.get("pr"),
        "pr_url": pr_web_url(origin, state.get("pr")) if state.get("pr") else None,
        "authority_source": f"PR #{state.get('pr')}" if state.get("pr") else None,
        "final_product_head": (state.get("heads") or {}).get("implemented"),
        "implemented_head": (state.get("heads") or {}).get("implemented"),
        "merge_commit": (state.get("heads") or {}).get("merged"),
        "merged_at": state.get("updated_at"),
        "continuation_comment_ids": sorted(set(comment_ids)),
        "consumed_continuation_ids": sorted(set(consumed)),
        "successor_stream": campaign.get("next_stream") or (state.get("continuation") or {}).get("created_stream"),
        "successor": campaign.get("next_stream") or (state.get("continuation") or {}).get("created_stream"),
        "review_policy": state.get("review_policy"),
        "resolved_base": (state.get("heads") or {}).get("spec_base") or (state.get("transport") or {}).get("base_sha"),
        "github_source": f"PR #{state.get('pr')}" if state.get("pr") else None,
    }
    store.append_event("archive", {"pr": state.get("pr"), "campaign": state.get("campaign_id")})
    return state


def archive_stream(ctx: RepoContext, store: StreamStore) -> dict[str, Any]:
    with store.lock():
        state = store.load()
        allowed = stream_archivable(state, store.load_runtime())
        if not allowed["ok"]:
            raise AgentbusError(allowed["reason"])
        archive_campaign_unit(store, state)
        store.save(state)
    return {"ok": True, "stream_id": store.stream_id, "archived": True, "reason": "archived", "notes": ["archived; campaign/PR/continuation anchor preserved"]}


def unarchive_stream(ctx: RepoContext, store: StreamStore) -> dict[str, Any]:
    with store.lock():
        state = store.load()
        if not state.get("archived"):
            raise AgentbusError("stream is not archived")
        state["archived"] = False
        state["hidden_from_attention"] = False
        store.append_event("unarchive", {"campaign": state.get("campaign_id")})
        store.save(state)
    return {"ok": True, "stream_id": store.stream_id, "archived": False, "reason": "unarchived"}


def purge_stream(ctx: RepoContext, store: StreamStore, *, delete_worktrees: bool = False) -> dict[str, Any]:
    import shutil

    with store.lock():
        state = store.load()
        allowed = stream_purgeable(state, store.load_runtime())
        if not allowed["ok"]:
            raise AgentbusError(allowed["reason"], code="PURGE_NOT_ALLOWED")
        notes = cleanup_stream_worktrees(store, state, repo_root=ctx.repo_root, delete=delete_worktrees)
        stream_id = state.get("stream_id") or store.stream_id
        path = store.path
        store.append_event("purge", {"reason": allowed["reason"]})
    notes.extend(forget_stream_from_campaigns(ctx, stream_id))
    if os.path.isdir(path):
        shutil.rmtree(path)
        notes.append(f"removed stream state {path}")
    return {"ok": True, "stream_id": stream_id, "purged": True, "reason": allowed["reason"], "notes": notes}


def delete_stream(
    ctx: RepoContext,
    store: StreamStore,
    *,
    delete_worktrees: bool = True,
) -> dict[str, Any]:
    """Deprecated. MERGED/obsolete units archive; never hard-deletes campaign history."""
    state = store.load()
    if stream_archivable(state, store.load_runtime())["ok"] or state.get("archived"):
        result = archive_stream(ctx, store)
        result["legacy_delete"] = True
        result["notes"] = list(result.get("notes") or []) + ["legacy delete mapped to archive"]
        return result
    raise AgentbusError(
        stream_deletable(state, store.load_runtime()).get("reason")
        or "delete is deprecated; use archive or purge"
    )
