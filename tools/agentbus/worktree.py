from __future__ import annotations

import os
from typing import Any

from agentbus.gitutil import (
    add_worktree,
    find_worktree_by_path,
    find_worktree_for_branch,
    git_ok,
    head_sha,
    is_dirty,
    primary_worktree,
    remove_worktree,
    reset_hard,
    run_cmd,
    worktree_list,
)
from agentbus.paths import AgentbusError
from agentbus.store import StreamStore


def default_impl_path(repo_root: str, stream_id: str) -> str:
    parent = os.path.dirname(primary_worktree(repo_root))
    return os.path.join(parent, f"yuvi-{stream_id}")


def bind_or_create_impl(
    store: StreamStore,
    state: dict[str, Any],
    *,
    repo_root: str,
    requested: str | None,
    create: bool,
    start_point: str | None = None,
) -> list[str]:
    notes: list[str] = []
    branch = state.get("branch")
    if requested:
        path = os.path.abspath(requested)
        existing = find_worktree_by_path(repo_root, path)
        if not existing:
            if not create:
                raise AgentbusError(f"path is not a worktree of this repo: {path}")
            if os.path.exists(path):
                raise AgentbusError(f"refusing to overwrite existing path {path}")
            new_branch = branch or f"agentbus/{state['stream_id']}"
            if not state.get("branch"):
                state["branch"] = new_branch
            start = (
                start_point
                or (branch if branch and git_ok(repo_root, "rev-parse", "--verify", branch) else "HEAD")
            )
            add_worktree(repo_root, path, branch=new_branch, start_point=start)
            state["created_worktrees"]["impl"] = True
            notes.append(f"created impl worktree {path}")
        else:
            notes.append(f"bound existing impl worktree {path}")
            state["created_worktrees"]["impl"] = False
        state["impl_worktree"] = path
        return notes

    if branch:
        found = find_worktree_for_branch(repo_root, branch)
        if found:
            state["impl_worktree"] = found["path"]
            state["created_worktrees"]["impl"] = False
            notes.append(f"bound existing worktree for {branch}: {found['path']}")
            return notes

    if not create:
        notes.append("no impl worktree bound; pass --worktree or --create-worktree")
        return notes

    path = default_impl_path(repo_root, state["stream_id"])
    if os.path.exists(path):
        existing = find_worktree_by_path(repo_root, path)
        if existing:
            state["impl_worktree"] = path
            state["created_worktrees"]["impl"] = False
            notes.append(f"bound existing path {path}")
            return notes
        raise AgentbusError(f"default impl path already exists and is not a worktree: {path}")
    new_branch = branch or f"agentbus/{state['stream_id']}"
    if not state.get("branch"):
        state["branch"] = new_branch
    start = (
        start_point
        or (branch if branch and git_ok(repo_root, "rev-parse", "--verify", branch) else "HEAD")
    )
    add_worktree(repo_root, path, branch=new_branch, start_point=start)
    state["impl_worktree"] = path
    state["created_worktrees"]["impl"] = True
    notes.append(f"created impl worktree {path}")
    return notes


def ensure_audit_worktree(
    store: StreamStore,
    state: dict[str, Any],
    *,
    repo_root: str,
    implemented_head: str,
) -> str:
    path = state.get("audit_worktree") or os.path.join(store.path, "audit-worktree")
    existing = find_worktree_by_path(repo_root, path)
    if existing:
        reset_hard(path, implemented_head)
        state["audit_worktree"] = path
        return path
    if os.path.exists(path):
        raise AgentbusError(f"audit worktree path exists but is not a repo worktree: {path}")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    add_worktree(repo_root, path, start_point=implemented_head, detach=True)
    state["audit_worktree"] = path
    state["created_worktrees"]["audit"] = True
    return path


def discard_rejected_scope_attempt(
    store: StreamStore,
    state: dict[str, Any],
    *,
    runtime_role: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Clear one uncommitted, scope-rejected attempt from a managed worktree.

    This is deliberately narrower than general recovery. It only acts on a
    worktree AgentBus created, whose Codex invocation started clean, whose
    HEAD never advanced, and whose publication was rejected by the explicit
    scope fence. It restores only paths currently reported by Git and removes
    only those untracked paths; it never resets a committed HEAD or a
    user-owned worktree.
    """

    from agentbus.decision import scope_failure_route
    from agentbus.recover import role_process_healthy

    path = str(state.get("impl_worktree") or "").strip()
    publication = state.get("publication") if isinstance(state.get("publication"), dict) else {}
    created = state.get("created_worktrees") if isinstance(state.get("created_worktrees"), dict) else {}
    baseline = str(
        publication.get("baseline_head")
        or (state.get("heads") or {}).get("current")
        or ""
    ).strip()

    def refused(reason: str) -> dict[str, Any]:
        return {"ok": False, "recovered": False, "reason": reason, "paths": []}

    if not path or not created.get("impl"):
        return refused("implementation worktree is not AgentBus-created")
    if not os.path.isdir(path) or find_worktree_by_path(store.ctx.repo_root, path) is None:
        return refused("implementation worktree is not a registered repository worktree")
    if str(publication.get("status") or "").lower() != "failed":
        return refused("publication is not failed")
    if "scope fence rejected files" not in str(publication.get("reason") or "").lower():
        return refused("publication failure is not an explicit scope rejection")
    route = scope_failure_route(state)
    if not route or route.get("scope_failure_kind") != "CODER_SCOPE_VIOLATION":
        return refused("scope failure is not classified as coder-only")
    if not baseline or head_sha(path) != baseline:
        return refused("worktree HEAD is not the failed attempt baseline")
    if not is_dirty(path):
        return refused("worktree is already clean")
    role = runtime_role or {}
    if role_process_healthy(role):
        return refused("Codex invocation is still active")
    if role.get("clean_at_start") is not True:
        return refused("failed Codex invocation did not start from a clean worktree")
    interruption = state.get("codex_interruption") if isinstance(state.get("codex_interruption"), dict) else {}
    if interruption.get("kind") == "INTERRUPTED_CAPACITY":
        return refused("capacity interruption owns the dirty worktree")

    status = run_cmd(["git", "status", "--porcelain", "-uall"], cwd=path, timeout=20)
    if status.returncode != 0:
        return refused(status.stderr.strip() or "could not inspect rejected worktree")
    tracked: list[str] = []
    untracked: list[str] = []
    paths: list[str] = []
    for line in status.stdout.splitlines():
        if len(line) < 4:
            continue
        item = line[3:].strip().strip('"')
        if " -> " in item:
            item = item.split(" -> ", 1)[1]
        normalized = os.path.normpath(item)
        if not normalized or normalized == "." or normalized.startswith("..") or os.path.isabs(normalized):
            return refused(f"unsafe worktree path in status: {item}")
        if normalized.startswith(".git"):
            return refused(f"refusing to clean Git metadata path: {item}")
        if normalized not in paths:
            paths.append(normalized)
        if line[:2] == "??":
            untracked.append(normalized)
        else:
            tracked.append(normalized)
    if not paths:
        return refused("worktree status contained no recoverable paths")

    if tracked:
        restored = run_cmd(
            ["git", "restore", "--source", baseline, "--staged", "--worktree", "--", *tracked],
            cwd=path,
            timeout=30,
        )
        if restored.returncode != 0:
            return refused(restored.stderr.strip() or "could not restore rejected tracked paths")
    if untracked:
        cleaned = run_cmd(["git", "clean", "-fd", "--", *untracked], cwd=path, timeout=30)
        if cleaned.returncode != 0:
            return refused(cleaned.stderr.strip() or "could not remove rejected untracked paths")
    if is_dirty(path) or head_sha(path) != baseline:
        return refused("rejected worktree did not return cleanly to its baseline")

    store.append_event(
        "scope-attempt-discarded",
        {"baseline": baseline, "paths": paths, "reason": "coder-only scope rejection"},
    )
    return {"ok": True, "recovered": True, "baseline": baseline, "paths": paths}


def cleanup_stream_worktrees(
    store: StreamStore,
    state: dict[str, Any],
    *,
    repo_root: str,
    delete: bool,
) -> list[str]:
    notes: list[str] = []
    if not delete:
        return notes
    created = state.get("created_worktrees") or {}
    for role in ("audit", "impl"):
        path = state.get(f"{role}_worktree")
        if not path or not created.get(role):
            continue
        if role == "impl":
            still = find_worktree_by_path(repo_root, path)
            if still:
                # Never delete a worktree that looks like a long-lived project checkout
                # unless we created it for this stream.
                remove_worktree(repo_root, path, force=True)
                notes.append(f"removed {role} worktree {path}")
        else:
            if find_worktree_by_path(repo_root, path):
                remove_worktree(repo_root, path, force=True)
                notes.append(f"removed {role} worktree {path}")
        state[f"{role}_worktree"] = None
        created[role] = False
    return notes


def unmanaged_worktrees(repo_root: str, managed_paths: set[str]) -> list[dict[str, str]]:
    extra = []
    for entry in worktree_list(repo_root):
        path = os.path.abspath(entry.get("path") or "")
        if path not in managed_paths:
            extra.append(entry)
    return extra
