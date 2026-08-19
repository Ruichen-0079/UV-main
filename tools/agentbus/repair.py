"""Durable, specification-scoped repair budget state.

The visible ``repair_cycles`` field is intentionally kept for compatibility,
but its meaning is the number of implementation repairs consumed by the
current durable GPT_SPEC authority.  This module keeps the epoch boundary and
historical diagnostics separate from ordinary Git/Codex generations.
"""

from __future__ import annotations

from typing import Any

from agentbus.util import sha256_text, utc_now


DEFAULT_MAX_REPAIR_REPLANS = 1
REPAIR_EPOCH_EXHAUSTED_REPLAN = "REPAIR_EPOCH_EXHAUSTED_REPLAN"
REPAIR_REPLAN_LIMIT_EXHAUSTED = "REPAIR_REPLAN_LIMIT_EXHAUSTED"
PRODUCT_GPT_REPLAN_FAILED = "PRODUCT_GPT_REPLAN_FAILED"


def _record(state: dict[str, Any], kind: str) -> dict[str, Any]:
    record = (state.get("envelopes") or {}).get(kind)
    return record if isinstance(record, dict) else {}


def _field(record: dict[str, Any], key: str) -> str:
    fields = record.get("fields") if isinstance(record.get("fields"), dict) else {}
    return str(fields.get(key) or record.get(key) or "").strip()


def spec_authority_identity(record: dict[str, Any] | None) -> str | None:
    """Return a stable identity for one durable GPT_SPEC authority.

    A GitHub source key/id distinguishes authorities; the envelope digest also
    fences an edited/re-rendered authority that happens to reuse a legacy id.
    For old local records the digest, then the canonical raw body, is enough.
    """

    if not isinstance(record, dict) or not record:
        return None
    source_key = str(record.get("source_key") or "").strip()
    source_id = str(record.get("source_id") or "").strip()
    surface = str(record.get("surface") or "").strip()
    source = source_key or (f"{surface}:{source_id}" if surface and source_id else source_id)
    digest = str(record.get("digest") or "").strip()
    raw = str(record.get("raw") or "").strip()
    if not digest and raw:
        digest = sha256_text(raw)
    if not source and not digest:
        base = _field(record, "BASE_HEAD")
        if base:
            digest = sha256_text(base)
    if not source and not digest:
        return None
    return f"{source or 'authority'}:{digest or 'undigested'}"


def spec_epoch_id(state: dict[str, Any]) -> str | None:
    epoch = state.get("repair_epoch")
    if isinstance(epoch, dict) and str(epoch.get("id") or "").strip():
        return str(epoch["id"]).strip()
    return spec_authority_identity(_record(state, "GPT_SPEC"))


def repair_replan_count(state: dict[str, Any]) -> int:
    try:
        return max(0, int(state.get("repair_replan_count") or 0))
    except (TypeError, ValueError):
        return 0


def max_repair_replans(state: dict[str, Any]) -> int:
    try:
        raw = state.get("max_repair_replans")
        if raw is None or raw == "":
            return DEFAULT_MAX_REPAIR_REPLANS
        return max(0, int(raw))
    except (TypeError, ValueError):
        return DEFAULT_MAX_REPAIR_REPLANS


def repair_epoch_exhausted(state: dict[str, Any]) -> bool:
    try:
        cycles = int(state.get("repair_cycles") or 0)
        maximum = int(state.get("max_repair_cycles") or 2)
    except (TypeError, ValueError):
        return False
    return cycles >= maximum


def _final_review_token(state: dict[str, Any]) -> str:
    review = _record(state, "GPT_MERGE_REVIEW")
    return str(review.get("source_id") or review.get("digest") or "").strip()


def _final_review_is_exact_repair(state: dict[str, Any]) -> bool:
    review = _record(state, "GPT_MERGE_REVIEW")
    status = str(review.get("status") or _field(review, "STATUS") or "").strip().upper()
    if status not in {"REPAIR", "HOLD"}:
        return False
    token = _final_review_token(state)
    if not token:
        return False
    reviewed = _field(review, "REVIEWED_HEAD") or str(review.get("head") or "").strip()
    heads = state.get("heads") if isinstance(state.get("heads"), dict) else {}
    current = str(heads.get("implemented") or heads.get("current") or "").strip()
    return bool(reviewed and current and reviewed == current)


def ensure_repair_state(state: dict[str, Any]) -> dict[str, Any]:
    """Backfill new fields without changing an existing repair counter."""

    state.setdefault("repair_history", [])
    state.setdefault("repair_epochs", [])
    state.setdefault("repair_replan_count", 0)
    state.setdefault("max_repair_replans", DEFAULT_MAX_REPAIR_REPLANS)
    epoch = state.setdefault("repair_epoch", {})
    if not isinstance(epoch, dict):
        epoch = {}
        state["repair_epoch"] = epoch
    current = spec_authority_identity(_record(state, "GPT_SPEC"))
    if not str(epoch.get("id") or "").strip() and current:
        epoch.update(
            {
                "id": current,
                "authority_source_id": _record(state, "GPT_SPEC").get("source_id") or None,
                "authority_digest": _record(state, "GPT_SPEC").get("digest") or None,
                "base_head": _field(_record(state, "GPT_SPEC"), "BASE_HEAD") or None,
                "started_at": _record(state, "GPT_SPEC").get("created_at") or utc_now(),
            }
        )
    if epoch.get("id"):
        state["repair_epoch_id"] = epoch["id"]
    state.setdefault("spec_epoch_pending_implementation", False)
    return state


def prepare_replan_for_new_spec(state: dict[str, Any]) -> bool:
    """Preserve an exhaustion handoff when a legacy state lacks its marker."""

    ensure_repair_state(state)
    pending = state.get("repair_replan")
    if isinstance(pending, dict) and pending.get("pending"):
        return True
    if not repair_epoch_exhausted(state) or not _final_review_is_exact_repair(state):
        return False
    epoch_id = spec_epoch_id(state)
    token = _final_review_token(state)
    state["repair_replan"] = {
        "pending": True,
        "source_epoch_id": epoch_id,
        "source_review": token,
        "lineage": token,
        "requested_at": utc_now(),
        "reason": REPAIR_EPOCH_EXHAUSTED_REPLAN,
    }
    return True


def start_spec_epoch(state: dict[str, Any], record: dict[str, Any]) -> bool:
    """Install a new GPT_SPEC epoch, resetting only its bounded counter."""

    had_epoch = bool(
        isinstance(state.get("repair_epoch"), dict)
        and str((state.get("repair_epoch") or {}).get("id") or "").strip()
    )
    ensure_repair_state(state)
    incoming = spec_authority_identity(record)
    if not incoming:
        return False
    epoch = state.setdefault("repair_epoch", {})
    current = str(epoch.get("id") or "").strip()
    if current == incoming:
        state["repair_epoch_id"] = incoming
        # A pre-migration state can receive its first spec before an epoch
        # record exists. It is still an initial boundary, not a duplicate
        # ordinary retry. Migrated states have had_epoch=True here.
        if not had_epoch:
            state["repair_cycles"] = 0
            state["spec_epoch_pending_implementation"] = True
            return True
        return False

    now = utc_now()
    if current:
        history = state.setdefault("repair_epochs", [])
        history.append(
            {
                "id": current,
                "authority_source_id": epoch.get("authority_source_id"),
                "authority_digest": epoch.get("authority_digest"),
                "base_head": epoch.get("base_head"),
                "started_at": epoch.get("started_at"),
                "ended_at": now,
                "repair_count": int(state.get("repair_cycles") or 0),
            }
        )
        if len(history) > 40:
            del history[:-40]

    pending = state.get("repair_replan") if isinstance(state.get("repair_replan"), dict) else {}
    pending_for_current = bool(
        pending.get("pending")
        and str(pending.get("source_epoch_id") or "") == current
    )
    if pending_for_current:
        state["repair_replan_count"] = repair_replan_count(state) + 1
        state.setdefault("repair_history", []).append(
            {
                "kind": "REPLAN_EPOCH_STARTED",
                "source_epoch_id": current,
                "source_review": pending.get("source_review"),
                "replan_count": repair_replan_count(state),
                "ts": now,
            }
        )
    else:
        state["repair_replan_count"] = 0

    state["repair_replan"] = {
        "pending": False,
        "source_epoch_id": None,
        "source_review": None,
        "lineage": pending.get("lineage") if pending_for_current else None,
        "requested_at": pending.get("requested_at") if pending_for_current else None,
        "reason": REPAIR_EPOCH_EXHAUSTED_REPLAN if pending_for_current else None,
    }
    state["repair_cycles"] = 0
    state["spec_epoch_pending_implementation"] = True
    state["repair_epoch"] = {
        "id": incoming,
        "authority_source_id": record.get("source_id") or None,
        "authority_digest": record.get("digest") or None,
        "base_head": _field(record, "BASE_HEAD") or None,
        "started_at": record.get("created_at") or now,
    }
    state["repair_epoch_id"] = incoming
    return True


def note_repair_attempt(
    state: dict[str, Any],
    *,
    kind: str,
    authority: str | None,
    head: str | None,
    cycle: int,
) -> None:
    ensure_repair_state(state)
    state.setdefault("repair_history", []).append(
        {
            "kind": kind,
            "authority": authority,
            "head": head,
            "epoch_id": spec_epoch_id(state),
            "cycle": cycle,
            "ts": utc_now(),
        }
    )
    history = state["repair_history"]
    if len(history) > 80:
        del history[:-80]


def note_repair_exhausted(state: dict[str, Any], *, authority: str, head: str | None) -> None:
    ensure_repair_state(state)
    pending = state.get("repair_replan") if isinstance(state.get("repair_replan"), dict) else {}
    if pending.get("pending") and pending.get("source_review") == authority:
        return
    state["repair_replan"] = {
        "pending": True,
        "source_epoch_id": spec_epoch_id(state),
        "source_review": authority,
        "lineage": authority,
        "requested_at": utc_now(),
        "reason": REPAIR_EPOCH_EXHAUSTED_REPLAN,
    }
    state.setdefault("repair_history", []).append(
        {
            "kind": "REPAIR_EPOCH_EXHAUSTED",
            "authority": authority,
            "head": head,
            "epoch_id": spec_epoch_id(state),
            "cycle": int(state.get("repair_cycles") or 0),
            "ts": utc_now(),
        }
    )


def note_replan_failure(state: dict[str, Any], *, authority: str, reason: str) -> None:
    """Stop a bounded replan when Product GPT did not issue an actionable spec."""

    ensure_repair_state(state)
    pending = state.get("repair_replan") if isinstance(state.get("repair_replan"), dict) else {}
    if not pending.get("pending"):
        return
    pending.update(
        {
            "failed": True,
            "failed_authority": authority,
            "failed_reason": reason,
            "failed_at": utc_now(),
        }
    )
    state.setdefault("repair_history", []).append(
        {
            "kind": "PRODUCT_GPT_REPLAN_FAILED",
            "authority": authority,
            "epoch_id": spec_epoch_id(state),
            "reason": reason,
            "ts": utc_now(),
        }
    )


def clear_replan_lineage(state: dict[str, Any]) -> None:
    pending = state.get("repair_replan")
    if isinstance(pending, dict):
        pending.update({"pending": False, "source_epoch_id": None, "source_review": None, "lineage": None})
    state["repair_replan_count"] = 0
