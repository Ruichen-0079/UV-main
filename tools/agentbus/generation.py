"""Implementation generations: owned AgentBus publications vs external drift."""

from __future__ import annotations

import json
import os
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
    for item in history:
        if item.get("commit") == commit and item.get("parent") == parent:
            pub["generation"] = int(item.get("generation") or pub.get("generation") or 0)
            pub["commit"] = commit
            pub["baseline_head"] = parent or pub.get("baseline_head")
            pub["lease"] = None
            heads = state.setdefault("heads", {})
            heads["implemented"] = commit
            heads["last_seen"] = commit
            heads["current"] = commit
            return
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


def _event_records(store: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    paths = [store.events_path + ".1", store.events_path]
    for path in paths:
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(record, dict):
                        records.append(record)
        except OSError:
            continue
    return records


def _normalized_paths(values: Any) -> list[str]:
    if not isinstance(values, (list, tuple)):
        return []
    found: list[str] = []
    for value in values:
        path = str(value or "").strip().lstrip("./")
        if path and path not in found:
            found.append(path)
    return found


def _recovery_failure(reason: str, *, commit: str | None = None) -> dict[str, Any]:
    return {"ok": False, "reason": reason, "commit": commit}


def recover_lost_publication(
    store: Any,
    state: dict[str, Any],
    *,
    worktree: str | None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Recover only a publication proven by append-only AgentBus evidence.

    This is deliberately stricter than the normal publication retry path. It
    is for the narrow case where the commit, remote PR, and durable report
    survived but the local ``publication`` object was overwritten by a stale
    state save. Commit naming, author, branch naming, and PR prose are not
    ownership evidence here.
    """

    from agentbus.gitutil import changed_paths, find_worktree_by_path, git, head_sha, is_dirty
    from agentbus.publish import (
        _report_body_for_github,
        parse_claimed_paths,
    )
    from agentbus.scope import scope_of, validate_files_against_scope
    from agentbus.transport import is_bootstrap_commit

    implementation_path = state.get("impl_worktree")
    if not implementation_path or not worktree:
        return _recovery_failure("managed implementation worktree is not recorded")
    implementation_path = os.path.abspath(str(implementation_path))
    if os.path.abspath(str(worktree)) != implementation_path:
        return _recovery_failure("recovery worktree does not match the stream implementation worktree")
    if not os.path.isdir(implementation_path):
        return _recovery_failure(f"implementation worktree is missing: {implementation_path}")
    if find_worktree_by_path(store.ctx.repo_root, implementation_path) is None:
        return _recovery_failure("implementation path is not a registered worktree of this repository")
    if is_dirty(implementation_path):
        return _recovery_failure("implementation worktree is dirty; refusing ownership recovery")

    record = (state.get("envelopes") or {}).get("CODEX_REPORT") or {}
    fields = record.get("fields") if isinstance(record.get("fields"), dict) else {}
    candidate = str(fields.get("IMPLEMENTED_HEAD") or record.get("head") or "").strip()
    if not candidate:
        return _recovery_failure("durable CODEX_REPORT has no IMPLEMENTED_HEAD")
    if str(fields.get("STREAM") or record.get("stream") or "").strip().lower() != str(
        state.get("stream_id") or ""
    ).strip().lower():
        return _recovery_failure("CODEX_REPORT stream does not match the stream", commit=candidate)
    if str(record.get("status") or fields.get("STATUS") or "").strip().upper() not in {
        "READY_FOR_AUDIT",
        "PASS",
        "PASSED",
        "OK",
    }:
        return _recovery_failure("current CODEX_REPORT is not READY_FOR_AUDIT", commit=candidate)
    if head_sha(implementation_path) != candidate:
        return _recovery_failure("implementation worktree HEAD does not match CODEX_REPORT", commit=candidate)

    publication = state.get("publication") or {}
    existing_commit = str(publication.get("commit") or "").strip()
    if existing_commit and any(
        item.get("commit") == existing_commit
        and item.get("parent") == publication.get("baseline_head")
        for item in publication_history(state)
    ):
        return {"ok": True, "already": True, "commit": existing_commit}
    if existing_commit and existing_commit != candidate:
        return _recovery_failure("publication metadata conflicts with the candidate commit", commit=candidate)

    events = [
        item
        for item in _event_records(store)
        if item.get("kind") == "publish-commit" and str(item.get("commit") or "").strip() == candidate
    ]
    if not events:
        return _recovery_failure("no trusted AgentBus publish-commit event for candidate", commit=candidate)

    stream_id = str(state.get("stream_id") or "")
    spec = (state.get("envelopes") or {}).get("GPT_SPEC") or {}
    spec_fields = spec.get("fields") if isinstance(spec.get("fields"), dict) else {}
    spec_source = str(spec.get("source_id") or "").strip()
    continuation_source = str(
        spec_fields.get("SOURCE_CONTINUATION_COMMENT_ID")
        or (state.get("transport") or {}).get("continuation_comment_id")
        or ""
    ).strip()
    if not spec_source:
        return _recovery_failure("applicable GPT_SPEC has no durable source authority", commit=candidate)
    if continuation_source and continuation_source != spec_source:
        return _recovery_failure("GPT_SPEC continuation authority conflicts with its source", commit=candidate)

    event_shapes: set[tuple[str, str, str, tuple[str, ...]]] = set()
    for event in events:
        event_stream = str(event.get("stream") or "").strip()
        event_parent = str(event.get("parent") or "").strip()
        event_authority = str(event.get("authority") or "").strip()
        event_files = tuple(_normalized_paths(event.get("files")))
        event_shapes.add((event_stream, event_parent, event_authority, event_files))
    if len(event_shapes) != 1:
        return _recovery_failure("conflicting AgentBus publish-commit evidence", commit=candidate)
    event = events[-1]
    if str(event.get("stream") or "").strip() != stream_id:
        return _recovery_failure("publish-commit event stream does not match the stream", commit=candidate)
    if str(event.get("authority") or "").strip() != spec_source:
        return _recovery_failure("publish-commit event authority does not match the applicable GPT_SPEC", commit=candidate)

    transport = state.get("transport") or {}
    transport_head = str(
        transport.get("bootstrap_commit")
        or transport.get("commit_sha")
        or publication.get("bootstrap")
        or ""
    ).strip()
    parent = str(event.get("parent") or "").strip()
    if not transport_head or parent != transport_head:
        return _recovery_failure("publish-commit parent does not match the durable transport head", commit=candidate)
    if candidate == parent or is_bootstrap_commit(state, candidate):
        return _recovery_failure("candidate is a bootstrap transport commit", commit=candidate)
    try:
        actual_parent = git(implementation_path, "rev-parse", f"{candidate}^")
    except Exception as exc:  # noqa: BLE001 — fail closed on incomplete Git evidence
        return _recovery_failure(f"cannot verify candidate parent: {exc}", commit=candidate)
    if actual_parent != parent:
        return _recovery_failure("candidate Git parent does not match the publish event", commit=candidate)

    event_files = _normalized_paths(event.get("files"))
    git_files = _normalized_paths(changed_paths(implementation_path, parent, candidate))
    report_files = _normalized_paths(
        parse_claimed_paths(fields.get("CHANGED_FILES") or fields.get("FILES_CHANGED"), implementation_path)
    )
    if (
        not event_files
        or len(event_files) != len(set(event_files))
        or set(event_files) != set(git_files)
        or set(report_files) != set(git_files)
    ):
        return _recovery_failure("publish event, Git diff, and CODEX_REPORT changed files disagree", commit=candidate)
    scope_check = validate_files_against_scope(git_files, scope_of(state))
    if not scope_check.get("ok"):
        return _recovery_failure(scope_check.get("reason") or "changed files failed PATH_SCOPE", commit=candidate)

    heads = state.get("heads") or {}
    for key in ("current", "last_seen", "implemented"):
        value = str(heads.get(key) or "").strip()
        if value and value != candidate:
            return _recovery_failure(f"conflicting {key} HEAD evidence", commit=candidate)
    blocker = str((state.get("status") or {}).get("blocker") or "").lower()
    if any(marker in blocker for marker in ("external", "drift", "diverged", "remote moved", "remote head")):
        return _recovery_failure("conflicting external-head/drift evidence", commit=candidate)

    pr = state.get("pr")
    if not pr:
        return _recovery_failure("cannot recover publication without a durable PR", commit=candidate)
    try:
        from agentbus.github import list_issue_comments, pr_view

        view = pr_view(store.ctx.repo_root, int(pr), env=env)
        remote_head = str(view.get("headRefOid") or "").strip()
        if remote_head != candidate:
            return _recovery_failure("GitHub PR HEAD does not match the candidate", commit=candidate)
        comments = list_issue_comments(store.ctx.repo_root, store.ctx.origin, int(pr), env=env)
    except Exception as exc:  # noqa: BLE001 — GitHub evidence must be live and exact
        return _recovery_failure(f"could not verify GitHub publication evidence: {exc}", commit=candidate)
    expected_body = (_report_body_for_github(state) or "").strip()
    if not expected_body:
        return _recovery_failure("current CODEX_REPORT has no exact durable body", commit=candidate)
    exact_comments = [
        comment
        for comment in comments
        if str(comment.get("body") or "").strip() == expected_body
    ]
    if not exact_comments:
        return _recovery_failure("exact current CODEX_REPORT is not present on GitHub", commit=candidate)
    source_id = str(record.get("source_id") or "").strip()
    if source_id:
        matching_source = [item for item in exact_comments if str(item.get("id") or "") == source_id]
        if matching_source:
            exact_comments = matching_source
    if len(exact_comments) != 1:
        return _recovery_failure("multiple exact CODEX_REPORT comments make ownership ambiguous", commit=candidate)
    report_comment_id = str(exact_comments[0].get("id") or "").strip()
    if not report_comment_id:
        return _recovery_failure("exact CODEX_REPORT has no durable comment id", commit=candidate)

    from agentbus.publish import _update_publication

    before_history = len(publication_history(state))
    complete_owned_publication(state, commit=candidate, parent=parent)
    _update_publication(
        state,
        status="pushed",
        reason=None,
        baseline_head=parent,
        commit=candidate,
        pushed=True,
        remote_sha=candidate,
        files=event_files,
        message=event.get("message"),
        report_comment_id=report_comment_id,
        report_comment_digest=record.get("digest"),
    )
    record["source"] = "github"
    record["source_id"] = report_comment_id
    state.setdefault("status", {})["impl"] = "PASS"
    state["status"]["audit"] = "WAITING"
    state["status"]["blocker"] = None
    notes = reconcile_owned_repair(state)
    if not any(
        item.get("kind") == "publication-recovered"
        and str(item.get("commit") or "") == candidate
        for item in _event_records(store)
    ):
        store.append_event(
            "publication-recovered",
            {
                "commit": candidate,
                "parent": parent,
                "report_comment_id": report_comment_id,
                "authority": spec_source,
            },
        )
    return {
        "ok": True,
        "already": before_history == len(publication_history(state)),
        "commit": candidate,
        "parent": parent,
        "report_comment_id": report_comment_id,
        "files": event_files,
        "notes": notes,
    }


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
