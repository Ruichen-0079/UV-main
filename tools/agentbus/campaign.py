"""Campaign lineage and continuation ownership.

Campaign JSON preserves compatibility fields, but visible lifecycle is derived
from the current work unit and durable continuation queue. It is not a second
workflow engine.
"""

from __future__ import annotations

import os
from typing import Any

from agentbus.gitutil import changed_paths, head_sha, is_ancestor, rev_exists
from agentbus.machine import IMPLEMENTING, MATERIALIZING, WORKTREE_READY
from agentbus.lock import StreamLock
from agentbus.paths import AgentbusError, RepoContext, normalize_stream_id
from agentbus.protocol import Envelope, render_envelope
from agentbus.reviewpolicy import extract_path_tokens, normalize_review_policy, path_in_scope
from agentbus.store import StreamStore
from agentbus.util import atomic_write_json, read_json, utc_now


DEFAULT_MAX_QUEUED = 3
TRIGGER_MERGED = "MERGED"
ANCHOR_PREVIOUS_MERGE = "PREVIOUS_MERGE"
PLANNER_BROWSER = "browser"

STATUS_ACTIVE = "ACTIVE"
STATUS_CONTINUING = "CONTINUING"
STATUS_WAITING_FOR_PLAN = "WAITING_FOR_PLAN"
STATUS_HUMAN_REQUIRED = "HUMAN_REQUIRED"
STATUS_COMPLETE = "COMPLETE"

ITEM_QUEUED = "queued"
ITEM_CONSUMED = "consumed"
ITEM_IGNORED = "ignored"
ITEM_CONFLICT = "conflict"

AUTOPILOT = "autopilot"

# Explicit operator mapping — do not guess from string prefixes.
EXPLICIT_STREAM_CAMPAIGNS = {
    "p4_2d2": "p4",
    "p4-2d2": "p4",
    "p6-e1b": "p6",
    "p6-e2a": "p6",
    "p7-8b-canary": "p7",
    "p7-8c": "p7",
}

MERGE_REVIEW_ALWAYS = "always"
MERGE_REVIEW_RISK = "risk_triggered"
MERGE_REVIEW_OFF = "off"
DEFAULT_MERGE_REVIEW_MODE = MERGE_REVIEW_ALWAYS
DEFAULT_MERGE_GPT_PROVIDER = "browser"

WAIT_IMPLEMENTING = "IMPLEMENTING"
WAIT_AUDITING = "AUDITING"
WAIT_WAITING_FOR_GPT = "WAITING_FOR_GPT"
WAIT_WAITING_FOR_MERGE_GPT = "WAITING_FOR_MERGE_GPT"
WAIT_WAITING_FOR_HUMAN_MERGE = "WAITING_FOR_HUMAN_MERGE"
WAIT_MERGE_PENDING = "MERGE_PENDING"
WAIT_WAITING_FOR_PLAN = "WAITING_FOR_PLAN"

EXPLICIT_OBSOLETE = {
    "p6": {"superseded_by": "p6-e1b", "reason": "canonical P6 unit is p6-e1b"},
}


def max_queued(env: dict[str, str] | None = None) -> int:
    raw = (env or os.environ).get("YUVI_AGENTBUS_MAX_CONTINUATIONS")
    if not raw:
        return DEFAULT_MAX_QUEUED
    try:
        return max(1, min(8, int(raw)))
    except ValueError:
        return DEFAULT_MAX_QUEUED


def campaigns_dir(ctx: RepoContext) -> str:
    return os.path.join(ctx.repo_state, "campaigns")


def campaign_path(ctx: RepoContext, campaign_id: str) -> str:
    return os.path.join(campaigns_dir(ctx), f"{normalize_stream_id(campaign_id)}.json")


def campaign_lock(ctx: RepoContext) -> StreamLock:
    os.makedirs(campaigns_dir(ctx), exist_ok=True)
    return StreamLock(os.path.join(campaigns_dir(ctx), "lock"))


def empty_campaign(campaign_id: str) -> dict[str, Any]:
    now = utc_now()
    return {
        "campaign_id": normalize_stream_id(campaign_id),
        "status": STATUS_ACTIVE,
        "planner_provider": PLANNER_BROWSER,
        "units": [],
        "queue": [],
        "max_queued": DEFAULT_MAX_QUEUED,
        "current_stream": None,
        "active_stream": None,
        "reason": None,
        "human_required": False,
        "automation_mode": None,
        "merge_review_mode": DEFAULT_MERGE_REVIEW_MODE,
        "merge_gpt_provider": DEFAULT_MERGE_GPT_PROVIDER,
        "product_gpt": {"display_name": None, "url": None, "note": None, "bound_at": None},
        "merge_gpt": {"display_name": None, "url": None, "note": None, "bound_at": None},
        "created_at": now,
        "updated_at": now,
    }


def apply_campaign_defaults(campaign: dict[str, Any]) -> dict[str, Any]:
    """Legacy campaign JSON must gain Merge GPT fields without rewriting authority."""
    if campaign.get("status") == STATUS_COMPLETE and not campaign.get("completion"):
        # Preserve an old explicit completion without continuing to treat the
        # compatibility status snapshot as lifecycle authority.
        campaign["completion"] = STATUS_COMPLETE
    campaign.setdefault("merge_review_mode", DEFAULT_MERGE_REVIEW_MODE)
    if campaign.get("merge_review_mode") not in {MERGE_REVIEW_ALWAYS, MERGE_REVIEW_RISK, MERGE_REVIEW_OFF}:
        campaign["merge_review_mode"] = DEFAULT_MERGE_REVIEW_MODE
    campaign.setdefault("merge_gpt_provider", DEFAULT_MERGE_GPT_PROVIDER)
    campaign.setdefault("current_stream", campaign.get("active_stream"))
    product = campaign.get("product_gpt")
    if not isinstance(product, dict):
        campaign["product_gpt"] = {"display_name": None, "url": None, "note": None, "bound_at": None}
    else:
        product.setdefault("display_name", None)
        product.setdefault("url", None)
        product.setdefault("note", None)
        product.setdefault("bound_at", None)
    binding = campaign.get("merge_gpt")
    if not isinstance(binding, dict):
        campaign["merge_gpt"] = {"display_name": None, "url": None, "note": None, "bound_at": None}
    else:
        binding.setdefault("display_name", None)
        binding.setdefault("url", None)
        binding.setdefault("note", None)
        binding.setdefault("bound_at", None)
    return campaign


def load_campaign(ctx: RepoContext, campaign_id: str) -> dict[str, Any] | None:
    path = campaign_path(ctx, campaign_id)
    if not os.path.isfile(path):
        return None
    data = read_json(path, default=None)
    if not isinstance(data, dict):
        return None
    return apply_campaign_defaults(data)


def save_campaign(ctx: RepoContext, campaign: dict[str, Any]) -> dict[str, Any]:
    os.makedirs(campaigns_dir(ctx), exist_ok=True)
    apply_campaign_defaults(campaign)
    campaign["updated_at"] = utc_now()
    atomic_write_json(campaign_path(ctx, campaign["campaign_id"]), campaign)
    return campaign


def list_campaigns(ctx: RepoContext) -> list[dict[str, Any]]:
    root = campaigns_dir(ctx)
    if not os.path.isdir(root):
        return []
    found: list[dict[str, Any]] = []
    for name in sorted(os.listdir(root)):
        if not name.endswith(".json"):
            continue
        data = read_json(os.path.join(root, name), default=None)
        if isinstance(data, dict) and data.get("campaign_id"):
            found.append(apply_campaign_defaults(data))
    return found


def infer_campaign_id(state: dict[str, Any], envelope: Envelope | None = None) -> str:
    if envelope:
        named = (envelope.get("CAMPAIGN") or "").strip()
        if named:
            return normalize_stream_id(named)
    explicit = (state.get("campaign_id") or "").strip()
    if explicit:
        return normalize_stream_id(explicit)
    mapped = EXPLICIT_STREAM_CAMPAIGNS.get((state.get("stream_id") or "").lower())
    if mapped:
        return mapped
    spec = ((state.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields") or {}
    if isinstance(spec, dict) and (spec.get("CAMPAIGN") or "").strip():
        return normalize_stream_id(spec["CAMPAIGN"])
    return normalize_stream_id(state["stream_id"])


def bind_explicit_campaign(
    ctx: RepoContext,
    state: dict[str, Any],
    campaign_id: str,
    *,
    automation_mode: str | None = AUTOPILOT,
) -> dict[str, Any]:
    cid = normalize_stream_id(campaign_id)
    state["campaign_id"] = cid
    campaign = ensure_campaign(ctx, cid)
    if automation_mode:
        campaign["automation_mode"] = automation_mode
    sid = state.get("stream_id")
    found = False
    for unit in campaign.setdefault("units", []):
        if unit.get("stream_id") == sid:
            unit["status"] = state.get("phase")
            unit["pr"] = state.get("pr")
            found = True
    if not found:
        campaign["units"].append(
            {
                "stream_id": sid,
                "status": state.get("phase"),
                "pr": state.get("pr"),
                "merge_sha": (state.get("heads") or {}).get("merged"),
            }
        )
    campaign["current_stream"] = sid
    persist_campaign_projection(ctx, campaign)
    save_campaign(ctx, campaign)
    return campaign


def mark_obsolete(state: dict[str, Any], *, superseded_by: str, reason: str) -> dict[str, Any]:
    state["stream_class"] = "OBSOLETE_CANDIDATE"
    state["superseded_by"] = superseded_by
    state["hidden_from_attention"] = True
    state["obsolete_reason"] = reason
    return state


def is_obsolete(state: dict[str, Any]) -> bool:
    if state.get("hidden_from_attention") or state.get("stream_class") == "OBSOLETE_CANDIDATE":
        return True
    sid = (state.get("stream_id") or "").lower()
    return sid in EXPLICIT_OBSOLETE


def apply_known_obsolete(state: dict[str, Any]) -> bool:
    rec = EXPLICIT_OBSOLETE.get((state.get("stream_id") or "").lower())
    if not rec:
        return False
    mark_obsolete(state, superseded_by=rec["superseded_by"], reason=rec["reason"])
    return True


def ensure_campaign(ctx: RepoContext, campaign_id: str) -> dict[str, Any]:
    existing = load_campaign(ctx, campaign_id)
    if existing:
        return existing
    campaign = empty_campaign(campaign_id)
    save_campaign(ctx, campaign)
    return campaign


def pending_items(campaign: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item in (campaign.get("queue") or []) if item.get("status") == ITEM_QUEUED]


def unit_completed(phase: str | None) -> bool:
    """A work unit is completed only after the PR is MERGED."""
    return (phase or "") == "MERGED"


def _candidate_stream_ids(campaign: dict[str, Any]) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()

    def add(value: str | None) -> None:
        sid = (value or "").strip()
        if not sid or sid in seen:
            return
        seen.add(sid)
        found.append(sid)

    add(campaign.get("current_stream") or campaign.get("active_stream"))
    for unit in campaign.get("units") or []:
        add(unit.get("stream_id"))
    for item in campaign.get("queue") or []:
        add(item.get("consumed_stream"))
        add(item.get("created_stream"))
        add(item.get("next_stream"))
    return found


def discover_campaign_units(ctx: RepoContext | None, campaign: dict[str, Any]) -> list[dict[str, Any]]:
    """Live units for a campaign. Prefer on-disk stream state over tombstone rows."""
    from agentbus.store import StreamStore, iter_stores

    recorded: dict[str, dict[str, Any]] = {}
    for unit in campaign.get("units") or []:
        sid = unit.get("stream_id")
        if sid:
            recorded[sid] = dict(unit)
    rows: dict[str, dict[str, Any]] = {}
    for sid in _candidate_stream_ids(campaign):
        rec = dict(recorded.get(sid) or {"stream_id": sid})
        rec["stream_id"] = sid
        if ctx is not None:
            store = StreamStore(ctx, sid)
            if store.exists():
                state = store.load()
                rec["status"] = state.get("phase")
                rec["phase"] = state.get("phase")
                rec["pr"] = state.get("pr")
                rec["archived"] = bool(state.get("archived"))
                rec["updated_at"] = state.get("updated_at")
                rec["merge_sha"] = (state.get("heads") or {}).get("merged")
        rec.setdefault("phase", rec.get("status"))
        rows[sid] = rec
    if ctx is not None:
        cid = campaign.get("campaign_id")
        for store in iter_stores(ctx):
            try:
                state = store.load()
            except Exception:  # noqa: BLE001
                continue
            if (state.get("campaign_id") or "") != cid:
                continue
            sid = state.get("stream_id")
            if not sid:
                continue
            rows[sid] = {
                "stream_id": sid,
                "status": state.get("phase"),
                "phase": state.get("phase"),
                "pr": state.get("pr"),
                "archived": bool(state.get("archived")),
                "updated_at": state.get("updated_at"),
                "merge_sha": (state.get("heads") or {}).get("merged"),
            }
    return list(rows.values())


def select_current_unit(units: list[dict[str, Any]], campaign: dict[str, Any]) -> dict[str, Any] | None:
    live = [
        row
        for row in units
        if not row.get("archived")
        and (row.get("phase") or row.get("status"))
        and not unit_completed(row.get("phase") or row.get("status"))
    ]
    if not live:
        wanted = campaign.get("current_stream") or campaign.get("active_stream")
        for row in units:
            if not row.get("archived") and row.get("stream_id") == wanted:
                return row
        by_id = {row.get("stream_id"): row for row in units if row.get("stream_id")}
        for recorded in reversed(campaign.get("units") or []):
            row = by_id.get(recorded.get("stream_id"))
            if row and not row.get("archived"):
                return row
        return None
    wanted = campaign.get("current_stream") or campaign.get("active_stream")
    for row in live:
        if row.get("stream_id") == wanted:
            return row
    live.sort(key=lambda row: str(row.get("updated_at") or ""), reverse=True)
    return live[0]


def project_campaign(ctx: RepoContext | None, campaign: dict[str, Any]) -> dict[str, Any]:
    """Truthful campaign lifecycle. Never treats a non-MERGED unit as completed."""
    apply_campaign_defaults(campaign)
    units = discover_campaign_units(ctx, campaign)
    current = select_current_unit(units, campaign)
    pending = pending_items(campaign)
    if current is not None:
        phase = current.get("phase") or current.get("status") or ""
        if not unit_completed(phase):
            return {
                "status": STATUS_ACTIVE,
                "reason": None,
                "active_stream": current.get("stream_id"),
                "current_unit": current.get("stream_id"),
                "current_phase": phase,
                "current_pr": current.get("pr"),
                "wait_reason": None,
                "queue_empty": not pending,
                "unit_completed": False,
            }
    if pending:
        nxt = pending[0].get("next_stream")
        return {
            "status": STATUS_ACTIVE,
            "reason": f"queued successor {nxt}",
            "active_stream": nxt,
            "current_unit": nxt,
            "current_phase": None,
            "current_pr": None,
            "wait_reason": None,
            "queue_empty": False,
            "unit_completed": False,
        }
    if campaign.get("completion") == STATUS_COMPLETE:
        return {
            "status": STATUS_COMPLETE,
            "reason": campaign.get("reason") or "campaign explicitly complete",
            "active_stream": None,
            "current_unit": None,
            "current_phase": "MERGED",
            "current_pr": None,
            "wait_reason": None,
            "queue_empty": True,
            "unit_completed": True,
        }
    if campaign.get("continuation_error") or any(
        isinstance(item, dict) and item.get("status") == ITEM_CONFLICT
        for item in campaign.get("queue") or []
    ):
        return {
            "status": STATUS_HUMAN_REQUIRED,
            "reason": campaign.get("continuation_error") or campaign.get("reason") or "conflicting continuation",
            "active_stream": None,
            "current_unit": (current or {}).get("stream_id"),
            "current_phase": "MERGED",
            "current_pr": (current or {}).get("pr"),
            "wait_reason": None,
            "queue_empty": True,
            "unit_completed": True,
        }
    return {
        "status": STATUS_WAITING_FOR_PLAN,
        "reason": "unit completed; continuation queue empty",
        "active_stream": None,
        "current_unit": (current or {}).get("stream_id"),
        "current_phase": "MERGED",
        "current_pr": (current or {}).get("pr"),
        "wait_reason": WAIT_WAITING_FOR_PLAN,
        "queue_empty": True,
        "unit_completed": True,
    }


def persist_campaign_projection(ctx: RepoContext, campaign: dict[str, Any]) -> dict[str, Any]:
    projected = project_campaign(ctx, campaign)
    # Only persist campaign-owned lineage. Legacy status/reason fields remain
    # readable compatibility data, never lifecycle authority.
    campaign["current_stream"] = projected["current_unit"]
    campaign["active_stream"] = projected["active_stream"]
    # Existing fields remain a compatibility snapshot only. project_campaign
    # never reads them to determine a live unit's lifecycle.
    campaign["status"] = projected["status"]
    campaign["reason"] = projected.get("reason")
    campaign["human_required"] = projected["status"] == STATUS_HUMAN_REQUIRED
    campaign["wait_reason"] = projected.get("wait_reason")
    campaign["projection_version"] = 2
    return projected


def continuation_key(item: dict[str, Any]) -> tuple[str, str, str]:
    return (
        (item.get("after_stream") or "").lower(),
        (item.get("next_stream") or "").lower(),
        (item.get("trigger") or TRIGGER_MERGED).upper(),
    )


def _item_from_envelope(envelope: Envelope, *, source_stream: str) -> dict[str, Any]:
    fields = envelope.fields
    return {
        "id": envelope.digest[:16],
        "status": ITEM_QUEUED,
        "campaign": normalize_stream_id(envelope.get("CAMPAIGN") or ""),
        "after_stream": normalize_stream_id(envelope.get("AFTER_STREAM") or source_stream),
        "next_stream": normalize_stream_id(envelope.get("NEXT_STREAM") or ""),
        "trigger": (envelope.get("TRIGGER") or TRIGGER_MERGED).strip().upper(),
        "target": envelope.get("TARGET"),
        "base_anchor": (envelope.get("BASE_ANCHOR") or ANCHOR_PREVIOUS_MERGE).strip().upper(),
        "scope": envelope.get("SCOPE"),
        "path_scope": envelope.get("PATH_SCOPE"),
        "out_of_scope": envelope.get("OUT_OF_SCOPE"),
        "acceptance": envelope.get("ACCEPTANCE_CRITERIA"),
        "review_policy": normalize_review_policy(envelope.get("REVIEW_POLICY")),
        "next_action": (envelope.get("NEXT_ACTION") or "CREATE_AND_IMPLEMENT").strip().upper(),
        "envelope_status": envelope.status,
        "digest": envelope.digest,
        "source_stream": source_stream,
        "source_comment_id": envelope.source_id or None,
        "created_at": utc_now(),
        "consumed_stream": None,
        "reconciliation": None,
    }


def apply_continuation(store: StreamStore, state: dict[str, Any], envelope: Envelope) -> dict[str, Any]:
    """Record a durable continuation. Does not mutate a merged PR."""
    from agentbus.apply import refresh_next

    from agentbus.paths import AgentbusError
    from agentbus.protocol import validate_envelope

    errors = validate_envelope(envelope)
    if errors:
        raise AgentbusError("invalid envelope: " + "; ".join(errors))
    if envelope.status != "ACTIONABLE":
        rec = envelope.as_record()
        state.setdefault("envelopes", {})["GPT_CONTINUATION"] = rec
        return refresh_next(state)

    ctx = store.ctx
    campaign_id = infer_campaign_id(state, envelope)
    state["campaign_id"] = campaign_id
    item = _item_from_envelope(envelope, source_stream=state["stream_id"])
    with campaign_lock(ctx):
        campaign = ensure_campaign(ctx, campaign_id)
        campaign["max_queued"] = max_queued()
        notes = _enqueue(campaign, item)
        save_campaign(ctx, campaign)
    rec = envelope.as_record()
    rec["campaign_id"] = campaign_id
    rec["queue_note"] = notes
    state.setdefault("envelopes", {})["GPT_CONTINUATION"] = rec
    store.append_event(
        "continuation",
        {"campaign": campaign_id, "next": item["next_stream"], "note": notes, "digest": item["digest"][:12]},
    )
    maybe_materialize_successor(store, state)
    return refresh_next(state)


def _enqueue(campaign: dict[str, Any], item: dict[str, Any]) -> str:
    if item["envelope_status"] != "ACTIONABLE":
        item["status"] = ITEM_IGNORED
        campaign.setdefault("queue", []).append(item)
        return "non-actionable continuation ignored"
    key = continuation_key(item)
    for existing in campaign.get("queue") or []:
        if continuation_key(existing) == key:
            return "duplicate continuation idempotent"
    after = item["after_stream"]
    for existing in campaign.get("queue") or []:
        if existing.get("status") in {ITEM_IGNORED}:
            continue
        if existing.get("after_stream") == after and existing.get("next_stream") != item["next_stream"]:
            item["status"] = ITEM_CONFLICT
            campaign.setdefault("queue", []).append(item)
            campaign["status"] = STATUS_HUMAN_REQUIRED
            campaign["human_required"] = True
            campaign["reason"] = (
                f"conflicting continuations after {after}: "
                f"{existing.get('next_stream')} vs {item['next_stream']}"
            )
            return "conflicting continuation"
    if len(pending_items(campaign)) >= int(campaign.get("max_queued") or DEFAULT_MAX_QUEUED):
        item["status"] = ITEM_IGNORED
        item["reason"] = "queue bound exceeded"
        campaign.setdefault("queue", []).append(item)
        return "queue bound exceeded; not executable"
    campaign.setdefault("queue", []).append(item)
    if campaign.get("status") in {STATUS_WAITING_FOR_PLAN, STATUS_COMPLETE, None, ""}:
        campaign["status"] = STATUS_ACTIVE
        campaign["human_required"] = False
        campaign["reason"] = None
    return "queued"


def _after_stream_ids(state: dict[str, Any] | None, stream_id: str) -> set[str]:
    from agentbus.streamid import accepted_ids

    sid = (stream_id or "").strip().lower()
    ids = {sid} if sid else set()
    if state:
        ids.update(accepted_ids(state))
    ids.discard("")
    return ids


def matching_continuation(
    campaign: dict[str, Any],
    stream_id: str,
    state: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    ids = _after_stream_ids(state, stream_id)
    matches = [
        item
        for item in pending_items(campaign)
        if (item.get("after_stream") or "").lower() in ids and item.get("trigger") == TRIGGER_MERGED
    ]
    if not matches:
        return None
    if len(matches) > 1:
        nexts = {item.get("next_stream") for item in matches}
        if len(nexts) > 1:
            return None
    return matches[0]


def authority_source_needs_rescan(state: dict[str, Any], campaign: dict[str, Any] | None) -> bool:
    """MERGED campaign units remain readable authority sources until continuation is known."""
    if (state.get("phase") or "") != "MERGED":
        return False
    if not (state.get("pr") or state.get("campaign_id") or campaign):
        return False
    if not campaign:
        return True
    ids = _after_stream_ids(state, state.get("stream_id") or "")
    known = False
    for item in campaign.get("queue") or []:
        if (item.get("after_stream") or "").lower() not in ids:
            continue
        if item.get("trigger") and item.get("trigger") != TRIGGER_MERGED:
            continue
        known = True
        if item.get("status") == ITEM_QUEUED:
            return False
        if item.get("status") == ITEM_CONSUMED:
            return False
    return not known


def resolve_base_anchor(
    repo: str,
    after_state: dict[str, Any],
    item: dict[str, Any],
    *,
    main_ref: str = "refs/heads/main",
) -> dict[str, Any]:
    merge_sha = (after_state.get("heads") or {}).get("merged") or (after_state.get("heads") or {}).get("current")
    if not merge_sha:
        return {"ok": False, "reason": "previous merge SHA is unknown", "human_required": True}
    if not rev_exists(repo, merge_sha):
        ensure_origin_main(repo)
    if not rev_exists(repo, merge_sha):
        return {"ok": False, "reason": f"merge SHA {merge_sha[:12]} is not in this repo", "human_required": True}
    anchor = (item.get("base_anchor") or ANCHOR_PREVIOUS_MERGE).upper()
    if anchor not in {ANCHOR_PREVIOUS_MERGE, "PREVIOUS_MERGE_COMMIT"}:
        return {"ok": False, "reason": f"unsupported BASE_ANCHOR {anchor}", "human_required": True}

    from agentbus.util import run_cmd

    # Prefer GitHub/origin main. Local refs/heads/main in an AgentBus
    # worktree is often an old product line and is not campaign authority.
    main = None
    refs = ("origin/main", "refs/remotes/origin/main", main_ref, "refs/heads/main")
    seen_refs: list[str] = []
    for ref in refs:
        if ref in seen_refs:
            continue
        seen_refs.append(ref)
        result = run_cmd(["git", "rev-parse", ref], cwd=repo, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            main = result.stdout.strip()
            break
    if not main:
        main = head_sha(repo)
    if not main or main == merge_sha:
        return {"ok": True, "base": merge_sha, "mode": "previous_merge", "reconciliation": None}
    if not is_ancestor(repo, merge_sha, main):
        return {
            "ok": False,
            "reason": "current main is not a descendant of the previous merge commit",
            "human_required": True,
            "merge_sha": merge_sha,
            "main": main,
        }
    from agentbus.scope import extract_explicit_paths

    scopes = extract_explicit_paths(item.get("scope")) or extract_path_tokens(item.get("scope"))
    if not scopes:
        return {
            "ok": False,
            "reason": "main advanced and continuation SCOPE is not path-bounded; re-review required",
            "human_required": True,
            "merge_sha": merge_sha,
            "main": main,
        }
    newer = changed_paths(repo, merge_sha, main)
    overlap = [path for path in newer if path_in_scope(path, scopes)]
    if overlap:
        return {
            "ok": False,
            "reason": "newer main changes overlap continuation scope",
            "human_required": True,
            "overlap": overlap,
            "merge_sha": merge_sha,
            "main": main,
        }
    return {
        "ok": True,
        "base": main,
        "mode": "reconciled_current_main",
        "reconciliation": "main_advanced_non_overlapping",
        "base_anchor": merge_sha,
        "resolved_base": main,
        "overlap": [],
        "previous_merge": merge_sha,
        "main": main,
    }


def maybe_materialize_successor(store: StreamStore, state: dict[str, Any]) -> dict[str, Any] | None:
    """Edge-order independent: ACTIONABLE continuation + MERGED predecessor → create next once."""
    if (state.get("phase") or "") != "MERGED":
        return None
    ctx = store.ctx
    campaign_id = infer_campaign_id(state)
    state["campaign_id"] = campaign_id
    with campaign_lock(ctx):
        campaign = ensure_campaign(ctx, campaign_id)
        _record_unit(campaign, state)
        from agentbus.decision import NEXT, derive_next_action

        decision = derive_next_action(state, campaign)
        if decision.action != NEXT:
            persist_campaign_projection(ctx, campaign)
            save_campaign(ctx, campaign)
            state["campaign"] = {
                "campaign_id": campaign_id,
                "status": campaign["status"],
                "next_stream": None,
                "reason": decision.reason,
            }
            return None
        item = matching_continuation(campaign, state["stream_id"], state)
        if item is None:
            persist_campaign_projection(ctx, campaign)
            existing = campaign.get("current_stream") or campaign.get("active_stream") or _existing_successor(ctx, campaign, state)
            save_campaign(ctx, campaign)
            state["campaign"] = {
                "campaign_id": campaign_id,
                "status": campaign["status"],
                "next_stream": existing,
                "reason": campaign.get("reason"),
            }
            return {"ok": True, "stream_id": existing, "idempotent": True} if existing else None
        next_id = item.get("next_stream")
        if next_id and StreamStore(ctx, next_id).exists():
            _mark_consumed(campaign, item, next_id, None)
            save_campaign(ctx, campaign)
            return {"ok": True, "stream_id": next_id, "idempotent": True}
        campaign["status"] = STATUS_CONTINUING
        campaign["human_required"] = False
        campaign["reason"] = f"creating {item['next_stream']}"
        campaign["current_stream"] = item["next_stream"]
        campaign["active_stream"] = item["next_stream"]
        save_campaign(ctx, campaign)
    result = start_next_unit(ctx, store, state, item)
    with campaign_lock(ctx):
        campaign = ensure_campaign(ctx, campaign_id)
        if result.get("ok"):
            _mark_consumed(campaign, item, result.get("stream_id"), result)
            campaign["status"] = STATUS_ACTIVE
            campaign["human_required"] = False
            campaign["reason"] = f"next unit {result.get('stream_id')} started"
            campaign["current_stream"] = result.get("stream_id")
            campaign["active_stream"] = result.get("stream_id")
        else:
            campaign["status"] = STATUS_HUMAN_REQUIRED
            campaign["human_required"] = True
            campaign["reason"] = result.get("reason") or "continuation could not start"
        save_campaign(ctx, campaign)
    rec = (state.get("envelopes") or {}).get("GPT_CONTINUATION")
    if isinstance(rec, dict) and result.get("ok"):
        rec["consumed_stream"] = result.get("stream_id")
        rec["status"] = "consumed"
    if result.get("ok"):
        state["continuation"] = {
            "continuation_comment_id": item.get("source_comment_id"),
            "status": "consumed",
            "created_stream": result.get("stream_id"),
            "resolved_base": result.get("base"),
            "reconciliation": result.get("reconciliation"),
            "base_anchor": (state.get("heads") or {}).get("merged"),
        }
    state["campaign"] = {
        "campaign_id": campaign_id,
        "status": campaign["status"],
        "next_stream": result.get("stream_id"),
        "reason": campaign.get("reason"),
    }
    return result


def _existing_successor(ctx: RepoContext, campaign: dict[str, Any], state: dict[str, Any]) -> str | None:
    ids = _after_stream_ids(state, state.get("stream_id") or "")
    for row in campaign.get("queue") or []:
        if (row.get("after_stream") or "").lower() not in ids:
            continue
        nxt = row.get("consumed_stream") or row.get("created_stream") or row.get("next_stream")
        if row.get("status") == ITEM_CONSUMED and nxt and StreamStore(ctx, nxt).exists():
            return nxt
    return None


def _mark_consumed(
    campaign: dict[str, Any],
    item: dict[str, Any],
    stream_id: str | None,
    result: dict[str, Any] | None,
) -> None:
    item_id = item.get("id")
    comment_id = item.get("source_comment_id")
    reconciliation = None
    resolved_base = None
    if isinstance(result, dict):
        reconciliation = result.get("reconciliation")
        resolved_base = result.get("base") or result.get("resolved_base")
    for row in campaign.get("queue") or []:
        same = row.get("id") == item_id or (
            comment_id and row.get("source_comment_id") == comment_id
        ) or (
            row.get("next_stream") == item.get("next_stream")
            and row.get("after_stream") == item.get("after_stream")
        )
        if same:
            row["status"] = ITEM_CONSUMED
            row["consumed_stream"] = stream_id
            row["continuation_comment_id"] = comment_id
            row["created_stream"] = stream_id
            row["resolved_base"] = resolved_base
            row["reconciliation"] = reconciliation
            row["consumed_at"] = utc_now()


def after_unit_merged(
    store: StreamStore,
    state: dict[str, Any],
    *,
    merge_sha: str | None = None,
    create_next: bool = True,
) -> dict[str, Any]:
    """Mark the work unit complete and maybe start the next unit. Never auto-merges."""
    if merge_sha:
        state.setdefault("heads", {})["merged"] = merge_sha
    elif not (state.get("heads") or {}).get("merged"):
        state.setdefault("heads", {})["merged"] = (state.get("heads") or {}).get("current")
    if not create_next:
        campaign = ensure_campaign(store.ctx, infer_campaign_id(state))
        _record_unit(campaign, state)
        save_campaign(store.ctx, campaign)
        return campaign
    result = maybe_materialize_successor(store, state)
    return load_campaign(store.ctx, infer_campaign_id(state)) or result or {}


def _record_unit(campaign: dict[str, Any], state: dict[str, Any]) -> None:
    sid = state["stream_id"]
    phase = state.get("phase") or ""
    rec = {
        "stream_id": sid,
        "status": phase,
        "pr": state.get("pr"),
        "merge_sha": (state.get("heads") or {}).get("merged"),
    }
    if unit_completed(phase):
        rec["completed_at"] = utc_now()
    if not campaign.get("current_stream"):
        campaign["current_stream"] = sid
    for unit in campaign.setdefault("units", []):
        if unit.get("stream_id") == sid:
            unit.update(rec)
            return
    campaign["units"].append(rec)


def ensure_origin_main(repo: str) -> str | None:
    from agentbus.util import run_cmd

    run_cmd(["git", "fetch", "--quiet", "origin", "main"], cwd=repo, timeout=20)
    result = run_cmd(["git", "rev-parse", "origin/main"], cwd=repo, timeout=10)
    if result.returncode == 0:
        return result.stdout.strip() or None
    return None


def start_next_unit(
    ctx: RepoContext,
    after_store: StreamStore,
    after_state: dict[str, Any],
    item: dict[str, Any],
) -> dict[str, Any]:
    from agentbus.actions import create_stream
    from agentbus.apply import apply_envelope, set_phase
    from agentbus.gitutil import head_sha as live_head
    from agentbus.transport import apply_continuation_provenance, ensure_durable_pr_transport

    next_id = item["next_stream"]
    existing = StreamStore(ctx, next_id)
    if existing.exists():
        nxt = existing.load()
        if nxt.get("phase") == WORKTREE_READY or (not nxt.get("pr") and nxt.get("phase") != IMPLEMENTING):
            transport = ensure_durable_pr_transport(ctx, existing, nxt, item=item, wake_impl=True)
            existing.save(nxt)
            return {"ok": bool(transport.get("ok") or nxt.get("pr")), "stream_id": next_id, "idempotent": True, **transport}
        return {"ok": True, "stream_id": next_id, "idempotent": True, "reason": "next stream already exists", "pr": nxt.get("pr")}

    repo = ctx.repo_root or after_state.get("impl_worktree")
    resolved = resolve_base_anchor(repo, after_state, item)
    if not resolved.get("ok"):
        return {"ok": False, "reason": resolved.get("reason"), "human_required": True}

    base = resolved["base"]
    try:
        state, notes = create_stream(
            ctx,
            next_id,
            branch=f"agentbus/{next_id}",
            goal=item.get("target") or "",
            create_worktree=True,
            start_point=base,
        )
    except AgentbusError as exc:
        return {"ok": False, "reason": str(exc), "human_required": True}

    next_store = StreamStore(ctx, next_id)
    set_phase(state, MATERIALIZING, reason="successor worktree created")
    state["campaign_id"] = item.get("campaign") or after_state.get("campaign_id")
    state["review_policy"] = item.get("review_policy")
    state["planner_provider"] = PLANNER_BROWSER
    set_phase(state, WORKTREE_READY, reason="successor worktree ready")
    spec = Envelope(
        kind="GPT_SPEC",
        fields={
            "STATUS": "ACTIONABLE",
            "STREAM": next_id,
            "GOAL": item.get("target") or "",
            "TARGET": item.get("target") or "",
            "BASE_HEAD": base,
            "SCOPE": item.get("scope") or "",
            "OUT_OF_SCOPE": item.get("out_of_scope") or "",
            "ACCEPTANCE_CRITERIA": item.get("acceptance") or "",
            "REVIEW_POLICY": item.get("review_policy") or "GPT_REQUIRED",
            "NEXT_ACTION": "IMPLEMENT",
            "CAMPAIGN": state["campaign_id"] or "",
            "CONTINUATION_OF": after_state["stream_id"],
            "SOURCE_CONTINUATION_COMMENT_ID": item.get("source_comment_id") or "",
            "SOURCE_PREDECESSOR_PR": str(after_state.get("pr") or ""),
            "SOURCE_PREDECESSOR_STREAM": after_state["stream_id"],
            "MATERIALIZED_BY": "AGENTBUS",
        },
        source="continuation",
        source_id=item.get("source_comment_id") or item.get("digest") or "",
    )
    spec.raw = render_envelope(spec)
    apply_envelope(
        next_store,
        state,
        spec,
        repo=state.get("impl_worktree") or repo,
        current_head=live_head(state.get("impl_worktree") or repo),
        allow_stale=True,
    )
    apply_continuation_provenance(state, item, after_state, base)
    from agentbus.scope import attach_scope, materialize_path_scope

    comment_id = item.get("source_comment_id") or ""
    attach_scope(
        state,
        materialize_path_scope(
            raw_scope=item.get("scope") or spec.fields.get("SCOPE"),
            path_scope_field=item.get("path_scope") or spec.fields.get("PATH_SCOPE"),
            source=f"continuation:{comment_id}" if comment_id else f"continuation:{after_state.get('stream_id')}",
        ),
    )
    transport = ensure_durable_pr_transport(ctx, next_store, state, item={**item, "resolved_base": base, "previous_pr": after_state.get("pr")}, wake_impl=True)
    if not transport.get("ok") and transport.get("retryable"):
        state.setdefault("status", {})["blocker"] = transport.get("reason")
        notes = list(notes) + [f"PR transport retryable: {transport.get('reason')}"]
    elif not transport.get("ok") and transport.get("human_required"):
        notes = list(notes) + [f"PR transport blocked: {transport.get('reason')}"]
    pr_info = {"number": state.get("pr")} if state.get("pr") else transport
    next_store.save(state)
    if state.get("phase") == IMPLEMENTING:
        _wake_impl(next_store, state)
    after_store.append_event(
        "campaign-continue",
        {
            "from": after_state["stream_id"],
            "to": next_id,
            "base": base,
            "mode": resolved.get("mode"),
            "pr": (pr_info or {}).get("number"),
            "notes": notes,
            "transport": (state.get("transport") or {}).get("status"),
        },
    )
    return {
        "ok": True,
        "stream_id": next_id,
        "base": base,
        "reconciliation": resolved.get("reconciliation"),
        "pr": state.get("pr") or (pr_info or {}).get("number"),
        "notes": notes,
        "previous_pr": after_state.get("pr"),
        "phase": state.get("phase"),
        "transport": state.get("transport"),
    }


def _wake_impl(store: StreamStore, state: dict[str, Any]) -> None:
    if (state.get("phase") or "") != "IMPLEMENTING":
        return
    if os.environ.get("YUVI_AGENTBUS_WAKE_IMPL") == "0":
        return
    worktree = state.get("impl_worktree")
    if not worktree:
        return
    try:
        from agentbus.konsolebind import launch_role_konsole

        launch_role_konsole(store, state["stream_id"], "impl", worktree, reuse=True)
    except Exception:  # noqa: BLE001
        return


def _maybe_bootstrap_pr(ctx: RepoContext, state: dict[str, Any], item: dict[str, Any]) -> dict[str, Any] | None:
    if os.environ.get("YUVI_AGENTBUS_PUSH") == "0" and os.environ.get("YUVI_AGENTBUS_BOOTSTRAP_PR") != "1":
        return None
    try:
        from agentbus.github import create_draft_pr

        worktree = state.get("impl_worktree") or ctx.repo_root
        result = create_draft_pr(
            worktree,
            title=item.get("target") or state.get("goal") or state["stream_id"],
            body=_bootstrap_body(state, item),
            head=state.get("branch") or f"agentbus/{state['stream_id']}",
        )
        if result.get("number"):
            state["pr"] = int(result["number"])
        return result
    except Exception as exc:  # noqa: BLE001 — bootstrap is best-effort; unit already exists
        state.setdefault("github", {})["last_error"] = f"bootstrap PR failed: {exc}"[:400]
        return None


def _bootstrap_body(state: dict[str, Any], item: dict[str, Any]) -> str:
    return (
        f"AgentBus continuation of `{item.get('after_stream')}`.\n\n"
        f"Campaign: `{state.get('campaign_id')}`\n"
        f"Next unit: `{state.get('stream_id')}`\n"
        f"This PR is independently auditable. AgentBus will not auto-merge.\n"
    )


def campaign_view(campaign: dict[str, Any] | None, ctx: RepoContext | None = None) -> dict[str, Any] | None:
    if not campaign:
        return None
    from agentbus.attention import campaign_attention

    projected = project_campaign(ctx, campaign)
    wait_reason = projected.get("wait_reason")
    current_state: dict[str, Any] | None = None
    if ctx is not None and projected.get("current_unit") and not projected.get("unit_completed"):
        from agentbus.mergegate import wait_reason_for_state
        from agentbus.store import StreamStore

        store = StreamStore(ctx, projected["current_unit"])
        if store.exists():
            current_state = store.load()
            wait_reason = wait_reason_for_state(current_state, campaign)
    view_campaign = dict(campaign)
    view_campaign["status"] = projected["status"]
    view_campaign["reason"] = projected.get("reason") or campaign.get("reason")
    view_campaign["current_stream"] = projected.get("current_unit")
    view_campaign["active_stream"] = projected.get("active_stream")
    att = campaign_attention(view_campaign)
    if current_state is not None:
        # A campaign with a live unit inherits that unit's next authority.
        # Otherwise P6/P7 incorrectly look like AgentBus work while they are
        # explicitly waiting for independent Browser GPT review.
        from agentbus.attention import classify_attention
        from agentbus.decision import decision_for_stream

        live = (current_state.get("github") or {}).get("pr")
        decision = decision_for_stream(
            ctx,
            current_state,
            campaign,
            live if isinstance(live, dict) else None,
        )
        if decision.wait_reason:
            wait_reason = decision.wait_reason
        att = classify_attention(current_state, campaign=campaign, decision=decision)
    pending = pending_items(campaign)
    next_stream = pending[0].get("next_stream") if pending else None
    if projected.get("unit_completed"):
        next_label = None
    else:
        next_label = projected.get("current_unit") or next_stream
    return {
        "campaign_id": campaign.get("campaign_id"),
        "status": projected["status"],
        "reason": projected.get("reason") if projected.get("unit_completed") else (projected.get("reason") or campaign.get("reason")),
        "wait_reason": wait_reason,
        "current_stream": projected.get("current_unit"),
        "active_stream": projected.get("active_stream"),
        "current_unit": projected.get("current_unit"),
        "current_phase": projected.get("current_phase"),
        "unit_completed": bool(projected.get("unit_completed")),
        "units": campaign.get("units") or [],
        "queue": pending,
        "queue_size": len(pending),
        "max_queued": campaign.get("max_queued") or DEFAULT_MAX_QUEUED,
        "human_required": projected["status"] == STATUS_HUMAN_REQUIRED,
        "planner_provider": campaign.get("planner_provider") or PLANNER_BROWSER,
        "automation_mode": campaign.get("automation_mode"),
        "merge_review_mode": campaign.get("merge_review_mode") or DEFAULT_MERGE_REVIEW_MODE,
        "merge_gpt_provider": campaign.get("merge_gpt_provider") or DEFAULT_MERGE_GPT_PROVIDER,
        "merge_gpt": campaign.get("merge_gpt") or {},
        "product_gpt": campaign.get("product_gpt") or {},
        "attention": att["kind"],
        "attention_owner": att["attention_owner"],
        "browser_gpt_required": att["browser_gpt_required"],
        "next_stream": next_label,
    }
