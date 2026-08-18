"""Canonical stream IDs plus explicit/separator aliases with collision checks."""

from __future__ import annotations

from typing import Any, Iterable

from agentbus.paths import AgentbusError, RepoContext, normalize_stream_id


# Durable envelopes published by AgentBus use the local stream_id as-is.
# Hyphen/underscore twins are accepted as aliases only when no other stream claims them.


def separator_twin(stream_id: str) -> str | None:
    value = (stream_id or "").strip().lower()
    if not value:
        return None
    has_us = "_" in value
    has_hy = "-" in value
    if has_us == has_hy:
        return None
    if has_us:
        return value.replace("_", "-")
    return value.replace("-", "_")


def explicit_aliases(state: dict[str, Any]) -> list[str]:
    found: list[str] = []
    for item in state.get("aliases") or []:
        value = str(item).strip().lower()
        if value and value not in found:
            found.append(value)
    return found


def accepted_ids(state: dict[str, Any]) -> set[str]:
    ids = {str(state.get("stream_id") or "").strip().lower()}
    ids.update(explicit_aliases(state))
    ids.discard("")
    return ids


def claimed_ids(ctx: RepoContext, *, except_stream: str | None = None) -> set[str]:
    from agentbus.store import iter_stores

    claimed: set[str] = set()
    for store in iter_stores(ctx):
        if except_stream and store.stream_id == except_stream:
            continue
        try:
            other = store.load()
        except Exception:  # noqa: BLE001
            claimed.add(store.stream_id)
            continue
        claimed.add(str(other.get("stream_id") or store.stream_id).strip().lower())
        claimed.update(explicit_aliases(other))
    claimed.discard("")
    return claimed


def ensure_stream_aliases(ctx: RepoContext | None, state: dict[str, Any]) -> list[str]:
    """Attach a separator twin as an explicit alias when that does not collide."""
    notes: list[str] = []
    stream_id = str(state.get("stream_id") or "").strip().lower()
    aliases = explicit_aliases(state)
    state["aliases"] = list(aliases)
    twin = separator_twin(stream_id)
    others: set[str] = set()
    if ctx is not None:
        others = claimed_ids(ctx, except_stream=stream_id)
    blocked = [item for item in (state.get("alias_blocked") or []) if isinstance(item, dict)]
    if twin:
        if twin in others:
            if not any(item.get("alias") == twin for item in blocked):
                blocked.append({"alias": twin, "reason": "collision"})
                notes.append(f"separator alias {twin} blocked by another stream")
            if twin in aliases:
                aliases = [item for item in aliases if item != twin]
                state["aliases"] = aliases
                notes.append(f"removed colliding alias {twin}")
        elif twin not in aliases:
            aliases.append(twin)
            state["aliases"] = aliases
            sources = state.setdefault("alias_source", {})
            sources[twin] = "separator_compat"
            notes.append(f"accepted separator alias {twin} → {stream_id}")
    state["alias_blocked"] = blocked
    return notes


def classify_envelope_stream(
    raw: str | None,
    state: dict[str, Any],
    *,
    claimed: Iterable[str] | None = None,
    envelope: Any = None,
) -> str:
    """Return self | foreign | unknown | missing."""
    if envelope is not None and getattr(envelope, "kind", None) == "GPT_CONTINUATION":
        after = (envelope.get("AFTER_STREAM") or raw or "").strip().lower()
        if after in accepted_ids(state):
            return "self"
        if not after:
            return "self"
        others = set(claimed or ())
        others.discard(str(state.get("stream_id") or "").strip().lower())
        others.difference_update(accepted_ids(state))
        if after in others:
            return "foreign"
        campaign = (envelope.get("CAMPAIGN") or "").strip().lower()
        if campaign and campaign == str(state.get("campaign_id") or "").strip().lower():
            return "self"
        return "unknown"
    value = (raw or "").strip().lower()
    if not value:
        return "missing"
    if value in accepted_ids(state):
        return "self"
    others = set(claimed or ())
    others.discard(str(state.get("stream_id") or "").strip().lower())
    others.difference_update(accepted_ids(state))
    if value in others:
        return "foreign"
    return "unknown"


def assert_no_create_collision(ctx: RepoContext, stream_id: str) -> None:
    normalized = normalize_stream_id(stream_id)
    claimed = claimed_ids(ctx)
    if normalized in claimed:
        raise AgentbusError(f"stream id {normalized} already exists or is an alias")
    twin = separator_twin(normalized)
    if twin and twin in claimed:
        raise AgentbusError(
            f"stream id {normalized} collides with existing stream/alias {twin}"
        )
