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
        "archived": False,
        "hidden_from_attention": False,
        "completion": None,
        "completion_authority": None,
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
    # A compatibility status snapshot is not completion authority.  Only the
    # durable Product GPT completion record below may terminate a campaign.
    campaign.setdefault("archived", False)
    campaign.setdefault("hidden_from_attention", False)
    campaign.setdefault("completion", None)
    campaign.setdefault("completion_authority", None)
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


def _explicit_obsolete_state(state: dict[str, Any]) -> bool:
    """Distinguish a tombstoned merged unit from an obsolete unit."""
    sid = (state.get("stream_id") or "").lower()
    return bool(
        state.get("stream_class") == "OBSOLETE_CANDIDATE"
        or state.get("superseded_by")
        or sid in EXPLICIT_OBSOLETE
    )


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


def _unit_row_completed(row: dict[str, Any]) -> bool:
    """Include the existing explicit obsolete terminal semantics."""
    return unit_completed(row.get("phase") or row.get("status")) or bool(
        row.get("obsolete") or row.get("stream_class") == "OBSOLETE_CANDIDATE"
    )


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
                rec["hidden_from_attention"] = bool(state.get("hidden_from_attention"))
                rec["stream_class"] = state.get("stream_class")
                rec["obsolete"] = _explicit_obsolete_state(state)
                rec["updated_at"] = state.get("updated_at")
                rec["completed_at"] = state.get("completed_at")
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
                "hidden_from_attention": bool(state.get("hidden_from_attention")),
                "stream_class": state.get("stream_class"),
                "obsolete": _explicit_obsolete_state(state),
                "updated_at": state.get("updated_at"),
                "completed_at": state.get("completed_at"),
                "merge_sha": (state.get("heads") or {}).get("merged"),
            }
    return list(rows.values())


def select_current_unit(units: list[dict[str, Any]], campaign: dict[str, Any]) -> dict[str, Any] | None:
    live = [
        row
        for row in units
        if not row.get("archived")
        and (row.get("phase") or row.get("status"))
        and not _unit_row_completed(row)
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


def _last_completed_unit(units: list[dict[str, Any]]) -> dict[str, Any] | None:
    completed = [
        row
        for row in units
        if _unit_row_completed(row)
    ]
    if not completed:
        return None
    completed.sort(
        key=lambda row: (
            str(row.get("completed_at") or row.get("updated_at") or ""),
            str(row.get("stream_id") or ""),
        ),
        reverse=True,
    )
    return completed[0]


def _has_explicit_completion_authority(campaign: dict[str, Any]) -> bool:
    if str(campaign.get("completion") or "").upper() != STATUS_COMPLETE:
        return False
    authority = campaign.get("completion_authority")
    if not isinstance(authority, dict):
        return False
    return bool(
        authority.get("source") == "github"
        and str(authority.get("source_id") or "").strip()
        and str(authority.get("job_id") or "").strip()
        and str(authority.get("campaign") or "").strip()
        and str(authority.get("after_stream") or "").strip()
    )


def _campaign_completion_fences(
    ctx: RepoContext | None,
    campaign: dict[str, Any],
    units: list[dict[str, Any]] | None = None,
) -> tuple[bool, str]:
    """Check terminal campaign fences without deriving a new workflow phase."""
    if not _has_explicit_completion_authority(campaign):
        return False, "explicit Product GPT completion authority is missing"
    if pending_items(campaign):
        return False, "actionable continuation remains queued"
    units = units if units is not None else discover_campaign_units(ctx, campaign)
    if not units:
        return False, "campaign has no terminal unit"
    authority = campaign.get("completion_authority") or {}
    if str(authority.get("campaign") or "").strip().lower() != str(campaign.get("campaign_id") or "").strip().lower():
        return False, "completion authority campaign is stale"
    if str(authority.get("trigger") or "").upper() != TRIGGER_MERGED:
        return False, "completion authority trigger is not MERGED"
    last_completed = _last_completed_unit(units)
    if not last_completed or str(authority.get("after_stream") or "").strip().lower() != str(last_completed.get("stream_id") or "").strip().lower():
        return False, "completion authority predecessor is not the latest completed unit"
    if any(
        not _unit_row_completed(row)
        and not row.get("archived")
        for row in units
    ):
        return False, "campaign still has an active nonterminal unit"
    if not any(_unit_row_completed(row) for row in units):
        return False, "latest campaign unit is not durably merged"
    if ctx is not None:
        from agentbus.recover import role_process_healthy
        from agentbus.store import StreamStore

        for row in units:
            sid = row.get("stream_id")
            if not sid:
                continue
            store = StreamStore(ctx, sid)
            if not store.exists():
                continue
            state = store.load()
            runtime = store.load_runtime()
            if role_process_healthy(runtime.get("impl") or {}) or role_process_healthy(runtime.get("audit") or {}):
                return False, f"active executor remains for {sid}"
            publication = state.get("publication") or {}
            if str(publication.get("status") or "").lower() in {
                "pending",
                "publishing",
                "in_progress",
                "recovering",
                "push_failed",
                "pr_failed",
            }:
                return False, f"publication recovery remains for {sid}"
            txn = state.get("merge_txn") or {}
            if str(txn.get("status") or "").lower() in {
                "started",
                "requested",
                "in_progress",
                "retrying",
            }:
                return False, f"merge is still in progress for {sid}"
            status = state.get("status") if isinstance(state.get("status"), dict) else {}
            if status.get("blocker"):
                return False, f"unresolved blocker remains for {sid}"
        try:
            from agentbus.codexpool import BUSY, pool_status

            unit_ids = {str(row.get("stream_id")) for row in units if row.get("stream_id")}
            pool = pool_status(ctx)
            for slot in (pool.get("slots") or {}).values():
                if slot.get("status") == BUSY and str(slot.get("active_stream") or "") in unit_ids:
                    return False, f"active Codex ownership remains for {slot.get('active_stream')}"
        except Exception:
            # Operational pool state is a completion fence.  If it cannot be
            # read safely, leave the campaign recoverable for the next tick.
            return False, "Codex ownership could not be verified"
    return True, "completion fences passed"


def _archive_campaign_if_safe(ctx: RepoContext | None, campaign: dict[str, Any], units: list[dict[str, Any]] | None = None) -> bool:
    ok, _reason = _campaign_completion_fences(ctx, campaign, units)
    if not ok:
        return False
    campaign["status"] = STATUS_COMPLETE
    campaign["completion"] = STATUS_COMPLETE
    campaign["archived"] = True
    campaign["hidden_from_attention"] = True
    campaign["active_stream"] = None
    campaign["current_stream"] = None
    campaign["human_required"] = False
    campaign["reason"] = campaign.get("reason") or "campaign explicitly complete"
    campaign["completed_at"] = campaign.get("completed_at") or utc_now()
    return True


def project_campaign(ctx: RepoContext | None, campaign: dict[str, Any]) -> dict[str, Any]:
    """Truthful campaign lifecycle. Never treats a non-MERGED unit as completed."""
    apply_campaign_defaults(campaign)
    units = discover_campaign_units(ctx, campaign)
    current = select_current_unit(units, campaign)
    last_completed = _last_completed_unit(units)
    pending = pending_items(campaign)
    if current is not None:
        phase = current.get("phase") or current.get("status") or ""
        if not _unit_row_completed(current):
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
                "last_completed_unit": (last_completed or {}).get("stream_id"),
                "last_completed": last_completed,
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
            "last_completed_unit": (last_completed or {}).get("stream_id"),
            "last_completed": last_completed,
        }
    if _has_explicit_completion_authority(campaign):
        complete, completion_reason = _campaign_completion_fences(ctx, campaign, units)
        if complete:
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
                "last_completed_unit": (last_completed or {}).get("stream_id"),
                "last_completed": last_completed,
            }
        # Explicit completion is durable intent, but it cannot skip a
        # publication/executor/merge fence.  Keep the campaign active and
        # recoverable until the next normal reconcile.
        completion_reason = f"completion authority awaiting fence: {completion_reason}"
    else:
        completion_reason = None
    if completion_reason is not None:
        return {
            "status": STATUS_WAITING_FOR_PLAN,
            "reason": completion_reason,
            "active_stream": None,
            # ``current_unit`` remains a compatibility anchor.  Consumers
            # needing the active execution unit use ``active_stream``; the
            # completed anchor is exposed separately below.
            "current_unit": (current or last_completed or {}).get("stream_id"),
            "current_phase": "MERGED",
            "current_pr": (current or last_completed or {}).get("pr"),
            "wait_reason": WAIT_WAITING_FOR_PLAN,
            "queue_empty": True,
            "unit_completed": True,
            "last_completed_unit": (last_completed or {}).get("stream_id"),
            "last_completed": last_completed,
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
            "last_completed_unit": (last_completed or {}).get("stream_id"),
            "last_completed": last_completed,
        }
    return {
        "status": STATUS_WAITING_FOR_PLAN,
        "reason": "unit completed; continuation queue empty",
        "active_stream": None,
        # Preserve the old current_stream anchor for compatibility while
        # making the active/null distinction explicit.
        "current_unit": (current or last_completed or {}).get("stream_id"),
        "current_phase": "MERGED",
        "current_pr": (current or last_completed or {}).get("pr"),
        "wait_reason": WAIT_WAITING_FOR_PLAN,
        "queue_empty": True,
        "unit_completed": True,
        "last_completed_unit": (last_completed or {}).get("stream_id"),
        "last_completed": last_completed,
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
    campaign["last_completed_unit"] = projected.get("last_completed_unit")
    campaign["last_completed"] = projected.get("last_completed")
    if projected["status"] == STATUS_COMPLETE:
        campaign["archived"] = True
        campaign["hidden_from_attention"] = True
    else:
        # WAITING_FOR_PLAN is active campaign state, never an archive.
        campaign["archived"] = False
        campaign["hidden_from_attention"] = False
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
        "source_surface": envelope.surface or None,
        "source_key": envelope.source_key or None,
        "source_created_at": envelope.created_at or None,
        "source_updated_at": envelope.updated_at or None,
        "source_author": envelope.author or None,
        "source_url": envelope.url or None,
        "created_at": envelope.created_at or utc_now(),
        "consumed_stream": None,
        "reconciliation": None,
    }


def _durably_merged(state: dict[str, Any]) -> bool:
    """Return true only when the local projection is compatible with GitHub MERGED."""
    if (state.get("phase") or "") != "MERGED" or not (state.get("heads") or {}).get("merged"):
        return False
    cached = (state.get("github") or {}).get("pr")
    if isinstance(cached, dict) and "state" in cached:
        return str(cached.get("state") or "").upper() == "MERGED" or bool(state.get("merge_confirmed_at"))
    # A PR-backed unit must have an explicit GitHub MERGED observation (or the
    # marker written at that observation).  A local MERGED phase alone is not
    # enough to start continuation planning.
    if state.get("pr") is not None:
        return bool(state.get("merge_confirmed_at"))
    # Legacy/local fixtures may not carry a cached PR projection.  The
    # durable GitHub sync path always fills it before invoking continuation
    # reconciliation; this fallback preserves those explicit test/repair
    # fixtures without inventing a new phase.
    return True


def apply_continuation(store: StreamStore, state: dict[str, Any], envelope: Envelope) -> dict[str, Any]:
    """Record a durable continuation. Does not mutate a merged PR."""
    from agentbus.apply import refresh_next

    from agentbus.paths import AgentbusError
    from agentbus.protocol import validate_envelope

    errors = validate_envelope(envelope)
    if errors:
        raise AgentbusError("invalid envelope: " + "; ".join(errors))
    ctx = store.ctx
    if envelope.status == "COMPLETE":
        if envelope.source != "github" or not str(envelope.source_id or "").strip():
            raise AgentbusError("GPT_CONTINUATION COMPLETE requires a durable GitHub source")
        if envelope.surface not in {"issue_comment", "review_submission"}:
            raise AgentbusError("GPT_CONTINUATION COMPLETE surface is not an allowed GitHub authority")
        campaign_id = infer_campaign_id(state, envelope)
        after_stream = normalize_stream_id(envelope.get("AFTER_STREAM") or "")
        bound_campaign = normalize_stream_id(str(state.get("campaign_id") or "")) if state.get("campaign_id") else ""
        if bound_campaign and bound_campaign != campaign_id:
            raise AgentbusError(
                f"completion campaign mismatch: envelope={campaign_id} state={bound_campaign}"
            )
        if (envelope.get("TRIGGER") or "").strip().upper() != TRIGGER_MERGED:
            raise AgentbusError("GPT_CONTINUATION COMPLETE trigger must be MERGED")
        if after_stream not in _after_stream_ids(state, state.get("stream_id") or ""):
            raise AgentbusError("completion predecessor does not match the current stream")
        if not _durably_merged(state):
            raise AgentbusError("completion predecessor is not durably MERGED")
        from agentbus.decision import PLAN_CONTINUATION, PRODUCT_GPT, browser_job_id

        campaign = load_campaign(ctx, campaign_id) or ensure_campaign(ctx, campaign_id)
        live = (state.get("github") or {}).get("pr")
        projected = project_campaign(ctx, campaign)
        existing_authority = campaign.get("completion_authority")
        same_authority = isinstance(existing_authority, dict) and (
            str(existing_authority.get("source_key") or "") == str(envelope.source_key or "")
            and str(existing_authority.get("job_id") or "") == str(envelope.get("JOB_ID") or "")
        )
        if projected.get("status") == STATUS_COMPLETE and not same_authority:
            raise AgentbusError("campaign already has a different durable completion authority")
        if not same_authority and projected.get("status") not in {STATUS_WAITING_FOR_PLAN, STATUS_COMPLETE}:
            raise AgentbusError("completion authority is stale because the campaign has an active unit")
        if not same_authority and projected.get("active_stream") not in {None, after_stream}:
            raise AgentbusError("completion authority predecessor is no longer the active planning anchor")
        expected_job = browser_job_id(
            state,
            campaign,
            live if isinstance(live, dict) else None,
            role=PRODUCT_GPT,
            task=PLAN_CONTINUATION,
        )
        if (envelope.get("JOB_ID") or "").strip() != expected_job:
            raise AgentbusError("completion authority is stale for the current planning generation")
        rec = envelope.as_record()
        rec["campaign_id"] = campaign_id
        rec["completion_authority"] = True
        state.setdefault("envelopes", {})["GPT_CONTINUATION"] = rec
        state["campaign_id"] = campaign_id
        authority = {
            "source": "github",
            "source_id": envelope.source_id,
            "source_key": envelope.source_key,
            "surface": envelope.surface,
            "created_at": envelope.created_at,
            "updated_at": envelope.updated_at,
            "url": envelope.url,
            "job_id": envelope.get("JOB_ID"),
            "campaign": campaign_id,
            "after_stream": after_stream,
            "trigger": TRIGGER_MERGED,
            "summary": envelope.get("SUMMARY"),
        }
        with campaign_lock(ctx):
            campaign = ensure_campaign(ctx, campaign_id)
            _record_unit(campaign, state)
            campaign["completion"] = STATUS_COMPLETE
            campaign["completion_authority"] = authority
            campaign["reason"] = envelope.get("SUMMARY") or "campaign explicitly complete"
            _archive_campaign_if_safe(ctx, campaign)
            persist_campaign_projection(ctx, campaign)
            save_campaign(ctx, campaign)
        if not state.get("archived"):
            archive_merged_unit(store, state)
        state["campaign"] = {
            "campaign_id": campaign_id,
            "status": campaign.get("status"),
            "next_stream": None,
            "reason": campaign.get("reason"),
        }
        store.save(state)
        return refresh_next(state)
    if envelope.status != "ACTIONABLE":
        rec = envelope.as_record()
        state.setdefault("envelopes", {})["GPT_CONTINUATION"] = rec
        return refresh_next(state)

    campaign_id = infer_campaign_id(state, envelope)
    named_raw = (envelope.get("CAMPAIGN") or "").strip()
    bound_raw = (state.get("campaign_id") or "").strip()
    named_campaign = normalize_stream_id(named_raw) if named_raw else ""
    bound_campaign = normalize_stream_id(bound_raw) if bound_raw else ""
    if named_campaign and bound_campaign and named_campaign != bound_campaign:
        raise AgentbusError(
            f"continuation campaign mismatch: envelope={named_campaign} state={bound_campaign}"
        )
    if (envelope.get("TRIGGER") or "").strip().upper() != TRIGGER_MERGED:
        raise AgentbusError("GPT_CONTINUATION ACTIONABLE trigger must be MERGED")
    after_stream = normalize_stream_id(envelope.get("AFTER_STREAM") or "")
    next_stream = normalize_stream_id(envelope.get("NEXT_STREAM") or "")
    if not after_stream:
        raise AgentbusError("GPT_CONTINUATION ACTIONABLE requires AFTER_STREAM")
    if not next_stream or next_stream == after_stream:
        raise AgentbusError("GPT_CONTINUATION ACTIONABLE requires a unique NEXT_STREAM")
    # A continuation is executable only after its predecessor is durably
    # MERGED.  This check is independent of which PR surface carried it and
    # prevents historical review backfills from reviving old units.
    predecessor = state if after_stream in _after_stream_ids(state, state.get("stream_id") or "") else None
    if predecessor is None:
        predecessor_store = StreamStore(ctx, after_stream)
        if predecessor_store.exists():
            predecessor = predecessor_store.load()
    # Existing issue-comment continuations may be observed before the merge;
    # they remain queued and are materialized only by the later MERGED edge.
    # A top-level review submission is the new durable Product GPT surface and
    # must prove its predecessor is already merged before it can be accepted.
    if envelope.surface == "review_submission" and (
        not predecessor or not _durably_merged(predecessor)
    ):
        raise AgentbusError(f"continuation predecessor {after_stream} is not durably MERGED")
    predecessor_raw = ((predecessor or {}).get("campaign_id") or "").strip()
    predecessor_campaign = normalize_stream_id(predecessor_raw) if predecessor_raw else ""
    if predecessor_campaign and predecessor_campaign != campaign_id:
        raise AgentbusError(
            f"continuation predecessor campaign mismatch: {predecessor_campaign} != {campaign_id}"
        )
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
    if not _durably_merged(state):
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
            "continuation_source_key": item.get("source_key"),
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
    if not _durably_merged(state):
        return load_campaign(store.ctx, infer_campaign_id(state)) or {}
    if merge_sha:
        state.setdefault("heads", {})["merged"] = merge_sha
    elif not (state.get("heads") or {}).get("merged"):
        state.setdefault("heads", {})["merged"] = (state.get("heads") or {}).get("current")
    if not create_next:
        campaign = ensure_campaign(store.ctx, infer_campaign_id(state))
        _record_unit(campaign, state)
        save_campaign(store.ctx, campaign)
        archive_merged_unit(store, state)
        with campaign_lock(store.ctx):
            campaign = ensure_campaign(store.ctx, infer_campaign_id(state))
            _record_unit(campaign, state)
            persist_campaign_projection(store.ctx, campaign)
            save_campaign(store.ctx, campaign)
        return campaign
    result = maybe_materialize_successor(store, state)
    # GitHub's durable MERGED edge is the unit-completion boundary.  The
    # predecessor remains a historical continuation anchor, but it no longer
    # owns active attention or an executor even when planning is still needed.
    archive_merged_unit(store, state)
    with campaign_lock(store.ctx):
        campaign = ensure_campaign(store.ctx, infer_campaign_id(state))
        _record_unit(campaign, state)
        persist_campaign_projection(store.ctx, campaign)
        save_campaign(store.ctx, campaign)
    return load_campaign(store.ctx, infer_campaign_id(state)) or result or {}


def archive_merged_unit(store: StreamStore, state: dict[str, Any]) -> bool:
    """Archive a durably merged unit while preserving all authority/history."""
    if state.get("archived") or not _durably_merged(state):
        return False
    from agentbus.actions import archive_campaign_unit

    previous_archive = state.get("archive") if isinstance(state.get("archive"), dict) else {}
    state["completed_at"] = (
        previous_archive.get("merged_at")
        or ((state.get("github") or {}).get("pr") or {}).get("mergedAt")
        or state.get("completed_at")
        or utc_now()
    )
    archive_campaign_unit(store, state)
    # A direct GitHub reconcile may call this before the normal executor
    # projection runs.  Reuse the existing fenced cleanup; it never closes a
    # healthy/unowned process and never touches a successor stream.
    try:
        from agentbus.autopilot import _cleanup_unneeded_executor_surfaces

        _cleanup_unneeded_executor_surfaces(store, state, action="DONE")
    except Exception:  # noqa: BLE001 - cleanup is best-effort and fenced
        pass
    store.save(state)
    return True


def backfill_archived_units(ctx: RepoContext, campaign_id: str) -> list[str]:
    """Idempotently hide historical merged units without replaying workflow."""
    from agentbus.store import iter_stores

    archived: list[str] = []
    touched: list[str] = []
    with campaign_lock(ctx):
        for store in iter_stores(ctx):
            if not store.exists():
                continue
            stream_lock = store.lock()
            if not stream_lock.try_acquire():
                # A live runner owns this stream; leave it untouched for its
                # next normal reconcile rather than contending with product
                # work or turning migration into a blocker.
                continue
            try:
                state = store.load()
                if state.get("campaign_id") != campaign_id:
                    continue
                if state.get("archived"):
                    touched.append(str(state.get("stream_id") or store.stream_id))
                    archive = state.get("archive") if isinstance(state.get("archive"), dict) else {}
                    merged_at = archive.get("merged_at")
                    if merged_at and state.get("completed_at") != merged_at:
                        state["completed_at"] = merged_at
                        store.save(state)
                    continue
                if not _durably_merged(state):
                    continue
                if archive_merged_unit(store, state):
                    stream_id = str(state.get("stream_id") or store.stream_id)
                    archived.append(stream_id)
                    touched.append(stream_id)
            finally:
                stream_lock.release()
        campaign = ensure_campaign(ctx, campaign_id)
        for sid in touched:
            store = StreamStore(ctx, sid)
            if store.exists():
                _record_unit(campaign, store.load())
        persist_campaign_projection(ctx, campaign)
        save_campaign(ctx, campaign)
    return archived


def _record_unit(campaign: dict[str, Any], state: dict[str, Any]) -> None:
    sid = state["stream_id"]
    phase = state.get("phase") or ""
    rec = {
        "stream_id": sid,
        "status": phase,
        "pr": state.get("pr"),
        "merge_sha": (state.get("heads") or {}).get("merged"),
        "archived": bool(state.get("archived")),
        "obsolete": _explicit_obsolete_state(state),
    }
    if unit_completed(phase):
        rec["completed_at"] = state.get("completed_at") or utc_now()
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
    view_campaign["last_completed_unit"] = projected.get("last_completed_unit")
    view_campaign["last_completed"] = projected.get("last_completed")
    # Archive is a projection of explicit campaign completion, never a stale
    # saved boolean.  In particular WAITING_FOR_PLAN remains visible/active
    # even when its last completed unit is archived.
    projected_archived = projected["status"] == STATUS_COMPLETE
    view_campaign["archived"] = projected_archived
    view_campaign["hidden_from_attention"] = projected_archived
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
        "active_unit": projected.get("active_stream"),
        "last_completed_unit": projected.get("last_completed_unit"),
        "last_completed": projected.get("last_completed"),
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
        "archived": projected_archived,
        "hidden_from_attention": projected_archived,
        "completion_authority": campaign.get("completion_authority"),
    }
