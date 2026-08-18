"""Implementation generations: owned AgentBus publications vs external drift."""

from __future__ import annotations

from typing import Any

from agentbus import machine
from agentbus.util import utc_now


LEASE_SECONDS = 180


def _pub(state: dict[str, Any]) -> dict[str, Any]:
    return state.setdefault("publication", {})


def owned_commit(state: dict[str, Any]) -> str | None:
    sha = (_pub(state).get("commit") or "").strip()
    return sha or None


def publication_history(state: dict[str, Any]) -> list[dict[str, Any]]:
    raw = _pub(state).get("history") or []
    return [item for item in raw if isinstance(item, dict)]


def owned_shas(state: dict[str, Any]) -> set[str]:
    found: set[str] = set()
    commit = owned_commit(state)
    if commit:
        found.add(commit)
    for item in publication_history(state):
        for key in ("commit", "parent"):
            value = (item.get(key) or "").strip()
            if value:
                found.add(value)
    return found


def is_owned_head(state: dict[str, Any], sha: str | None) -> bool:
    if not sha:
        return False
    return sha == owned_commit(state)


def is_prior_generation_head(state: dict[str, Any], sha: str | None) -> bool:
    if not sha:
        return False
    if is_owned_head(state, sha):
        return False
    pub = _pub(state)
    if sha == (pub.get("last_product_audit_head") or ""):
        return True
    if sha == (pub.get("baseline_head") or ""):
        return True
    if sha == ((state.get("heads") or {}).get("prior_audited") or ""):
        return True
    for item in publication_history(state):
        if sha == (item.get("parent") or "") or (
            sha == (item.get("commit") or "") and sha != owned_commit(state)
        ):
            return True
    return False


def begin_publication_lease(state: dict[str, Any], sha: str, *, parent: str | None) -> None:
    pub = _pub(state)
    pub["lease"] = {
        "sha": sha,
        "parent": parent,
        "started_at": utc_now(),
    }
    pub["status"] = pub.get("status") or "committing"


def complete_owned_publication(
    state: dict[str, Any],
    *,
    commit: str,
    parent: str | None,
) -> None:
    pub = _pub(state)
    history = publication_history(state)
    generation = int(pub.get("generation") or 0) + 1
    history.append(
        {
            "generation": generation,
            "commit": commit,
            "parent": parent,
            "ts": utc_now(),
        }
    )
    if len(history) > 40:
        history = history[-40:]
    pub["history"] = history
    pub["generation"] = generation
    pub["commit"] = commit
    pub["baseline_head"] = parent or pub.get("baseline_head")
    pub["lease"] = None
    heads = state.setdefault("heads", {})
    previous_audited = heads.get("audited")
    if previous_audited and previous_audited != commit:
        heads["prior_audited"] = previous_audited
        heads["audited"] = None
    heads["implemented"] = commit
    heads["last_seen"] = commit
    heads["current"] = commit


def lease_matches(state: dict[str, Any], sha: str | None) -> bool:
    if not sha:
        return False
    lease = _pub(state).get("lease") or {}
    return bool(lease.get("sha") == sha)


def expire_failed_lease(state: dict[str, Any]) -> bool:
    pub = _pub(state)
    if pub.get("status") != "failed":
        return False
    if pub.get("lease"):
        pub["lease"] = None
        return True
    return False


def should_ignore_stale_audit(state: dict[str, Any], audited: str | None) -> bool:
    implemented = (state.get("heads") or {}).get("implemented") or owned_commit(state)
    if not audited or not implemented:
        return False
    if audited == implemented:
        return False
    return is_owned_head(state, implemented) and is_prior_generation_head(state, audited)


def report_is_owned(state: dict[str, Any], implemented: str | None) -> bool:
    if not implemented:
        return False
    if is_owned_head(state, implemented):
        return True
    return lease_matches(state, implemented)


def note_stale_audit(state: dict[str, Any], envelope: Any) -> None:
    history = state.setdefault("audit_history", [])
    history.append(
        {
            "head": getattr(envelope, "head", None),
            "status": getattr(envelope, "status", None),
            "source_id": getattr(envelope, "source_id", None),
            "ts": utc_now(),
        }
    )
    if len(history) > 40:
        del history[:-40]


def reconcile_owned_repair(state: dict[str, Any]) -> list[str]:
    """If current HEAD is an owned repair publication, expect a new audit."""
    notes: list[str] = []
    owned = owned_commit(state)
    if not owned:
        return notes
    heads = state.setdefault("heads", {})
    current = heads.get("current") or owned
    if current != owned:
        return notes
    if not report_is_owned(state, owned):
        return notes
    audited = heads.get("audited")
    if audited and audited != owned and is_prior_generation_head(state, audited):
        heads["prior_audited"] = audited
        heads["audited"] = None
        notes.append(f"retained prior audit {audited[:12]} as previous generation")
    heads["implemented"] = owned
    heads["last_seen"] = owned
    heads["current"] = owned
    if state.get("phase") == machine.RE_REVIEW_REQUIRED:
        state.setdefault("status", {})["audit"] = "WAITING"
        state["status"]["impl"] = "PASS"
    blocker = (state.get("status") or {}).get("blocker") or ""
    if "AUDITED_HEAD" in blocker or "does not match" in blocker:
        state.setdefault("status", {})["blocker"] = None
    if state.get("phase") == machine.RE_REVIEW_REQUIRED:
        from agentbus.apply import set_phase

        set_phase(state, machine.READY_FOR_AUDIT, reason="owned repair publication")
        notes.append("reconciled owned publication to READY_FOR_AUDIT")
    from agentbus.apply import refresh_next

    refresh_next(state)
    return notes
