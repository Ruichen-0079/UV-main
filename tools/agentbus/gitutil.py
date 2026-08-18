from __future__ import annotations

import os
from typing import Any

from agentbus.paths import AgentbusError
from agentbus.util import run_cmd


def git(cwd: str, *args: str, timeout: float = 20) -> str:
    result = run_cmd(["git", *args], cwd=cwd, timeout=timeout)
    if result.returncode != 0:
        raise AgentbusError(result.stderr.strip() or result.stdout.strip() or "git failed")
    return result.stdout.strip()


def git_ok(cwd: str, *args: str, timeout: float = 20) -> bool:
    result = run_cmd(["git", *args], cwd=cwd, timeout=timeout)
    return result.returncode == 0


def head_sha(cwd: str) -> str | None:
    result = run_cmd(["git", "rev-parse", "HEAD"], cwd=cwd, timeout=10)
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def branch_name(cwd: str) -> str | None:
    result = run_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd, timeout=10)
    if result.returncode != 0:
        return None
    name = result.stdout.strip()
    if not name or name == "HEAD":
        return None
    return name


def is_dirty(cwd: str) -> bool:
    result = run_cmd(["git", "status", "--porcelain"], cwd=cwd, timeout=15)
    if result.returncode != 0:
        return True
    return bool(result.stdout.strip())


def is_ancestor(cwd: str, maybe_ancestor: str, maybe_descendant: str) -> bool:
    result = run_cmd(
        ["git", "merge-base", "--is-ancestor", maybe_ancestor, maybe_descendant],
        cwd=cwd,
        timeout=15,
    )
    return result.returncode == 0


def rev_exists(cwd: str, rev: str) -> bool:
    return git_ok(cwd, "cat-file", "-e", f"{rev}^{{commit}}")


def worktree_list(cwd: str) -> list[dict[str, str]]:
    result = run_cmd(["git", "worktree", "list", "--porcelain"], cwd=cwd, timeout=15)
    if result.returncode != 0:
        return []
    entries: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            if current:
                entries.append(current)
                current = {}
            continue
        if line.startswith("worktree "):
            if current:
                entries.append(current)
            current = {"path": line[len("worktree ") :]}
        elif line.startswith("HEAD "):
            current["head"] = line[len("HEAD ") :]
        elif line.startswith("branch "):
            current["branch"] = line[len("branch ") :].removeprefix("refs/heads/")
        elif line == "detached":
            current["detached"] = "1"
    if current:
        entries.append(current)
    return entries


def find_worktree_for_branch(cwd: str, branch: str) -> dict[str, str] | None:
    wanted = branch.removeprefix("refs/heads/")
    for entry in worktree_list(cwd):
        if entry.get("branch") == wanted:
            return entry
    return None


def find_worktree_by_path(cwd: str, path: str) -> dict[str, str] | None:
    wanted = os.path.abspath(path)
    for entry in worktree_list(cwd):
        if os.path.abspath(entry.get("path", "")) == wanted:
            return entry
    return None


def primary_worktree(cwd: str) -> str:
    entries = worktree_list(cwd)
    if entries:
        return entries[0]["path"]
    return cwd


def add_worktree(cwd: str, path: str, *, branch: str | None = None, start_point: str = "HEAD", detach: bool = False) -> None:
    args = ["worktree", "add"]
    if detach:
        args.append("--detach")
        args.extend([path, start_point])
    elif branch:
        existing = run_cmd(["git", "rev-parse", "--verify", f"refs/heads/{branch}"], cwd=cwd, timeout=10)
        if existing.returncode == 0:
            args.extend([path, branch])
        else:
            args.extend(["-b", branch, path, start_point])
    else:
        args.extend([path, start_point])
    result = run_cmd(["git", *args], cwd=cwd, timeout=30)
    if result.returncode != 0:
        raise AgentbusError(result.stderr.strip() or "git worktree add failed")


def remove_worktree(cwd: str, path: str, *, force: bool = False) -> None:
    args = ["worktree", "remove"]
    if force:
        args.append("--force")
    args.append(path)
    result = run_cmd(["git", *args], cwd=cwd, timeout=30)
    if result.returncode != 0:
        raise AgentbusError(result.stderr.strip() or "git worktree remove failed")


def checkout_detach(cwd: str, rev: str) -> None:
    result = run_cmd(["git", "checkout", "--detach", rev], cwd=cwd, timeout=20)
    if result.returncode != 0:
        raise AgentbusError(result.stderr.strip() or "git checkout --detach failed")


def reset_hard(cwd: str, rev: str) -> None:
    result = run_cmd(["git", "reset", "--hard", rev], cwd=cwd, timeout=20)
    if result.returncode != 0:
        raise AgentbusError(result.stderr.strip() or "git reset --hard failed")


def changed_paths(cwd: str, old: str, new: str) -> list[str]:
    result = run_cmd(["git", "diff", "--name-only", f"{old}..{new}"], cwd=cwd, timeout=20)
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def classify_relation(cwd: str, base: str, current: str) -> str:
    if not base or not current:
        return "unknown"
    if base == current:
        return "equal"
    base_ok = rev_exists(cwd, base)
    current_ok = rev_exists(cwd, current)
    if not base_ok or not current_ok:
        return "unknown"
    if is_ancestor(cwd, base, current):
        return "descendant"
    if is_ancestor(cwd, current, base):
        return "behind"
    return "diverged"


def worktree_snapshot(cwd: str | None) -> dict[str, Any]:
    if not cwd or not os.path.isdir(cwd):
        return {"path": cwd, "head": None, "branch": None, "dirty": None, "missing": True}
    return {
        "path": cwd,
        "head": head_sha(cwd),
        "branch": branch_name(cwd),
        "dirty": is_dirty(cwd),
        "missing": False,
    }


def rev_tree(cwd: str, rev: str) -> str | None:
    result = run_cmd(["git", "rev-parse", f"{rev}^{{tree}}"], cwd=cwd, timeout=10)
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def porcelain_status(cwd: str) -> str:
    result = run_cmd(["git", "status", "--porcelain", "-uall"], cwd=cwd, timeout=15)
    if result.returncode != 0:
        return ""
    return result.stdout


def index_sha(cwd: str) -> str | None:
    result = run_cmd(["git", "write-tree"], cwd=cwd, timeout=15)
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None
