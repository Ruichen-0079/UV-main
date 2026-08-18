from __future__ import annotations

import os
from typing import Any

from agentbus.gitutil import (
    add_worktree,
    find_worktree_by_path,
    find_worktree_for_branch,
    git_ok,
    primary_worktree,
    remove_worktree,
    reset_hard,
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
