"""Trusted host-side Git publication. Codex never writes linked-worktree metadata."""

from __future__ import annotations

import os
import re
from typing import Any

from agentbus.apply import apply_envelope, refresh_next, set_phase
from agentbus.gitutil import branch_name, classify_relation, find_worktree_by_path, git, head_sha, is_dirty
from agentbus.github import pr_view
from agentbus.machine import RE_REVIEW_REQUIRED, TransitionError
from agentbus.paths import AgentbusError, RepoContext, origin_url, sanitize_repo_id
from agentbus.protocol import Envelope
from agentbus.store import StreamStore
from agentbus.util import run_cmd, utc_now

PUBLICATION_FAILED = "IMPLEMENTATION_COMPLETE_PUBLICATION_FAILED"
BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


FORBIDDEN_PATH_RE = re.compile(r"(?:^|/)\.git(?:/|$)|(?:^|/)\.env(?:\.|$)", re.I)


def empty_publication() -> dict[str, Any]:
    return {
        "status": "idle",
        "reason": None,
        "baseline_head": None,
        "commit": None,
        "pushed": False,
        "remote_sha": None,
        "files": [],
        "message": None,
        "updated_at": None,
    }


def git_dir(cwd: str) -> str:
    return git(cwd, "rev-parse", "--absolute-git-dir")


def common_dir(cwd: str) -> str:
    raw = git(cwd, "rev-parse", "--git-common-dir")
    if not os.path.isabs(raw):
        raw = os.path.abspath(os.path.join(cwd, raw))
    return raw


def list_worktree_changes(cwd: str) -> dict[str, list[str]]:
    result = run_cmd(["git", "status", "--porcelain", "-uall"], cwd=cwd, timeout=20)
    if result.returncode != 0:
        raise AgentbusError(result.stderr.strip() or "git status failed")
    modified: list[str] = []
    deleted: list[str] = []
    untracked: list[str] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        code = line[:2]
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        path = path.strip().strip('"')
        if "D" in code:
            deleted.append(path)
        elif code.strip() == "??":
            untracked.append(path)
        else:
            modified.append(path)
    return {"modified": modified, "deleted": deleted, "untracked": untracked}


def all_change_paths(changes: dict[str, list[str]]) -> list[str]:
    seen: list[str] = []
    for group in ("modified", "deleted", "untracked"):
        for path in changes.get(group) or []:
            if path not in seen:
                seen.append(path)
    return seen


def parse_claimed_paths(raw: str | None, worktree: str) -> list[str]:
    """Normalize CHANGED_FILES / FILES_CHANGED from a Codex envelope."""
    if not raw:
        return []
    root = os.path.abspath(worktree)
    paths: list[str] = []
    for line in raw.splitlines():
        item = line.strip().lstrip("-*").strip()
        if not item:
            continue
        markdown = re.match(r"\[([^\]]+)\]\(([^)]+)\)", item)
        if markdown:
            item = markdown.group(2).strip()
        item = item.strip().strip("`")
        if item.startswith("http://") or item.startswith("https://"):
            continue
        item = item.split()[0] if item and not item.startswith("`") else item
        from agentbus.scope import looks_like_repo_path

        if not looks_like_repo_path(item):
            continue
        if os.path.isabs(item):
            if item == root or item.startswith(root + os.sep):
                item = os.path.relpath(item, root)
            else:
                continue
        item = item.lstrip("./")
        if item and item not in paths:
            paths.append(item)
    return paths


def push_argv(branch: str) -> list[str]:
    if not BRANCH_RE.fullmatch(branch) or ".." in branch or branch.startswith("-"):
        raise AgentbusError(f"refusing unsafe branch name {branch!r}")
    return ["git", "push", "origin", f"HEAD:refs/heads/{branch}"]


def _reject(reason: str) -> dict[str, Any]:
    return {"ok": False, "reason": reason}


def validate_publication(
    cwd: str,
    *,
    stream_id: str,
    expected_worktree: str | None,
    baseline_head: str | None,
    repo_root: str,
    expected_paths: list[str] | None = None,
    allow_empty: bool = False,
) -> dict[str, Any]:
    if not cwd or not os.path.isdir(cwd):
        return _reject("implementation worktree missing")
    if expected_worktree and os.path.abspath(cwd) != os.path.abspath(expected_worktree):
        return _reject("worktree does not belong to this stream")
    listed = find_worktree_by_path(repo_root, cwd)
    if listed is None:
        return _reject("path is not a git worktree of this repository")
    current = head_sha(cwd)
    if not current:
        return _reject("cannot read HEAD")
    if baseline_head and current != baseline_head:
        relation = classify_relation(cwd, baseline_head, current)
        if relation == "descendant" and not is_dirty(cwd):
            return {
                "ok": True,
                "reason": None,
                "changes": {"modified": [], "deleted": [], "untracked": []},
                "paths": [],
                "head": current,
                "already_committed": True,
            }
        return _reject(f"HEAD moved externally {baseline_head[:12]} → {current[:12]}")
    if os.path.isdir(os.path.join(cwd, ".git", "rebase-merge")) or os.path.isdir(
        os.path.join(cwd, ".git", "rebase-apply")
    ):
        return _reject("rebase in progress")
    merge_head = os.path.join(git_dir(cwd), "MERGE_HEAD")
    if os.path.isfile(merge_head):
        return _reject("unresolved merge")
    changes = list_worktree_changes(cwd)
    paths = all_change_paths(changes)
    if not paths and not allow_empty:
        return _reject("implementation produced no file changes")
    for path in paths:
        if FORBIDDEN_PATH_RE.search(path) or path == ".git":
            return _reject(f"refusing to stage forbidden path {path}")
        abs_path = os.path.abspath(os.path.join(cwd, path))
        if os.path.commonpath([os.path.abspath(cwd), abs_path]) != os.path.abspath(cwd):
            return _reject(f"path escapes worktree: {path}")
    if expected_paths:
        expected_set = set(expected_paths)
        unexpected = [path for path in paths if path not in expected_set]
        if unexpected:
            return _reject("unexpected changed files: " + ", ".join(unexpected[:8]))
        missing = [path for path in expected_paths if path not in paths]
        if missing:
            return _reject("claimed files missing from worktree: " + ", ".join(missing[:8]))
    check = run_cmd(["git", "diff", "--check"], cwd=cwd, timeout=20)
    if check.returncode != 0:
        return _reject("git diff --check failed")
    return {"ok": True, "reason": None, "changes": changes, "paths": paths, "head": current}


def commit_message(state: dict[str, Any]) -> str:
    stream = state.get("stream_id") or "stream"
    spec = (state.get("envelopes") or {}).get("GPT_SPEC") or {}
    source = spec.get("source_id") or "local"
    return f"agentbus({stream}): apply GPT_SPEC {source}"


def _update_publication(state: dict[str, Any], **fields: Any) -> dict[str, Any]:
    pub = state.setdefault("publication", empty_publication())
    pub.update(fields)
    pub["updated_at"] = utc_now()
    return pub


def publish_implementation(
    store: StreamStore,
    state: dict[str, Any],
    ctx: RepoContext,
    *,
    baseline_head: str | None,
    expected_paths: list[str] | None = None,
    allow_empty: bool = False,
    push: bool = True,
    out_write: Any = None,
    clean_at_start: bool | None = None,
) -> dict[str, Any]:
    def say(msg: str) -> None:
        if out_write:
            out_write(msg + "\n")

    worktree = state.get("impl_worktree")
    if not worktree:
        raise AgentbusError("no impl worktree")
    if clean_at_start is False:
        reason = "worktree was dirty when the Codex invocation began"
        _update_publication(state, status="failed", reason=reason, baseline_head=baseline_head)
        return {"ok": False, "reason": reason}
    pub = state.setdefault("publication", empty_publication())
    pending_commit = pub.get("commit")
    current = head_sha(worktree)

    if pending_commit and current == pending_commit and not is_dirty(worktree):
        say(f"commit {pending_commit[:12]} already exists; skipping duplicate commit")
        result = {"ok": True, "commit": pending_commit, "files": pub.get("files") or [], "reused": True}
        if push and not pub.get("pushed"):
            pushed = _push_and_verify(worktree, state, ctx, pending_commit, say)
            result.update(pushed)
            if not pushed.get("ok"):
                return pushed
        _update_publication(
            state,
            status="pushed" if pub.get("pushed") or result.get("pushed") else "committed",
            commit=pending_commit,
            baseline_head=baseline_head or pub.get("baseline_head"),
        )
        return result

    gate = validate_publication(
        worktree,
        stream_id=state["stream_id"],
        expected_worktree=worktree,
        baseline_head=baseline_head,
        repo_root=ctx.repo_root,
        expected_paths=expected_paths,
        allow_empty=allow_empty,
    )
    if not gate["ok"]:
        _update_publication(state, status="failed", reason=gate["reason"], baseline_head=baseline_head)
        return {"ok": False, "reason": gate["reason"]}

    from agentbus.scope import scope_of, validate_files_against_scope
    from agentbus.gitutil import changed_paths

    scoped_paths = list(gate.get("paths") or [])
    if gate.get("already_committed") and baseline_head and gate.get("head"):
        scoped_paths = changed_paths(worktree, baseline_head, gate["head"]) or scoped_paths
    if scoped_paths:
        scope_check = validate_files_against_scope(scoped_paths, scope_of(state))
        if not scope_check.get("ok"):
            reason = scope_check.get("reason") or "scope fence rejected files"
            _update_publication(state, status="failed", reason=reason, baseline_head=baseline_head)
            return {"ok": False, "reason": reason, "scope": scope_check}

    if gate.get("already_committed"):
        current = gate["head"]
        say(f"implementation already committed as {current[:12]}")
        from agentbus.generation import complete_owned_publication

        complete_owned_publication(state, commit=current, parent=baseline_head)
        _update_publication(
            state,
            status="committed",
            commit=current,
            baseline_head=baseline_head,
            files=expected_paths or [],
            pushed=False,
        )
        result = {"ok": True, "commit": current, "files": expected_paths or [], "reused": True}
        if push and _should_push(state):
            pushed = _push_and_verify(worktree, state, ctx, current, say)
            result.update(pushed)
            if not pushed.get("ok"):
                return result
        return result

    paths: list[str] = gate["paths"]
    parent = gate["head"]
    _update_publication(state, status="committing", baseline_head=parent, files=paths, reason=None)
    say(f"Publishing implementation... staging {len(paths)} files")
    add = run_cmd(["git", "add", "--", *paths], cwd=worktree, timeout=30)
    if add.returncode != 0:
        reason = add.stderr.strip() or "git add failed"
        _update_publication(state, status="failed", reason=reason)
        return {"ok": False, "reason": reason}

    message = commit_message(state)
    commit = run_cmd(["git", "commit", "-m", message], cwd=worktree, timeout=30)
    if commit.returncode != 0:
        reason = commit.stderr.strip() or commit.stdout.strip() or "git commit failed"
        run_cmd(["git", "reset", "HEAD"], cwd=worktree, timeout=15)
        _update_publication(state, status="failed", reason=reason)
        return {"ok": False, "reason": reason}

    new_head = head_sha(worktree)
    if not new_head or new_head == parent:
        _update_publication(state, status="failed", reason="commit did not advance HEAD")
        return {"ok": False, "reason": "commit did not advance HEAD"}
    from agentbus.generation import begin_publication_lease, complete_owned_publication

    begin_publication_lease(state, new_head, parent=parent)
    complete_owned_publication(state, commit=new_head, parent=parent)
    _update_publication(
        state,
        status="committed",
        commit=new_head,
        baseline_head=parent,
        files=paths,
        message=message,
        pushed=False,
    )
    runtime = store.load_runtime()
    store.append_event(
        "publish-commit",
        {
            "parent": parent,
            "commit": new_head,
            "files": paths,
            "stream": state["stream_id"],
            "authority": ((state.get("envelopes") or {}).get("GPT_SPEC") or {}).get("source_id"),
            "model": ((state.get("roles") or {}).get("impl") or {}).get("model"),
            "effort": ((state.get("roles") or {}).get("impl") or {}).get("effort"),
            "invocation_id": (runtime.get("impl") or {}).get("attempt_id"),
            "message": message,
        },
    )
    say(f"commit {new_head}")
    result = {"ok": True, "commit": new_head, "files": paths, "parent": parent, "reused": False}
    if push and _should_push(state):
        pushed = _push_and_verify(worktree, state, ctx, new_head, say)
        result.update(pushed)
        if not pushed.get("ok"):
            return result
    return result


def _should_push(state: dict[str, Any]) -> bool:
    if os.environ.get("YUVI_AGENTBUS_PUSH") == "0":
        return False
    return bool(state.get("pr") or state.get("branch"))


def _push_and_verify(
    worktree: str,
    state: dict[str, Any],
    ctx: RepoContext,
    commit: str,
    say: Any,
) -> dict[str, Any]:
    branch = state.get("branch") or branch_name(worktree)
    if not branch:
        reason = "no PR branch to push"
        _update_publication(state, status="failed", reason=reason, commit=commit)
        return {"ok": False, "reason": reason, "commit": commit, "pushed": False}
    identity = _verify_push_identity(worktree, state, ctx, branch, commit)
    if not identity.get("ok"):
        return identity
    remote_before = _ls_remote(worktree, branch)
    baseline = (state.get("publication") or {}).get("baseline_head")
    if remote_before and baseline and remote_before != baseline and remote_before != commit:
        reason = f"remote branch moved to {remote_before[:12]}; refusing to overwrite"
        return _remote_moved(state, reason, commit)
    say(f"push origin {branch}")
    argv = push_argv(branch)
    if "--force" in argv or "-f" in argv:
        raise AgentbusError("internal error: force push is forbidden")
    push = run_cmd(argv, cwd=worktree, timeout=60)
    if push.returncode != 0:
        reason = push.stderr.strip() or "git push failed"
        _update_publication(state, status="failed", reason=reason, commit=commit, pushed=False)
        return {"ok": False, "reason": reason, "commit": commit, "pushed": False}
    remote_after = _ls_remote(worktree, branch)
    if remote_after and remote_after != commit:
        reason = f"remote SHA {remote_after[:12]} != pushed {commit[:12]}"
        _update_publication(state, status="failed", reason=reason, commit=commit, pushed=False)
        return {"ok": False, "reason": reason, "commit": commit, "pushed": False}
    if state.get("pr"):
        try:
            view = pr_view(ctx.repo_root, int(state["pr"]))
            pr_head = view.get("headRefOid")
            if pr_head and pr_head != commit:
                reason = f"PR HEAD {pr_head[:12]} != pushed {commit[:12]}"
                _update_publication(state, status="failed", reason=reason, commit=commit, pushed=True)
                return {"ok": False, "reason": reason, "commit": commit, "pushed": True}
        except AgentbusError:
            pass
    _update_publication(state, status="pushed", commit=commit, pushed=True, remote_sha=remote_after or commit)
    say(f"remote verified {commit}")
    return {"ok": True, "commit": commit, "pushed": True, "remote_sha": remote_after or commit, "branch": branch}


def _ls_remote(cwd: str, branch: str) -> str | None:
    result = run_cmd(["git", "ls-remote", "origin", f"refs/heads/{branch}"], cwd=cwd, timeout=30)
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return result.stdout.split()[0]


def _verify_push_identity(
    worktree: str,
    state: dict[str, Any],
    ctx: RepoContext,
    branch: str,
    commit: str,
) -> dict[str, Any]:
    remote = origin_url(worktree)
    if ctx.origin and remote and remote != "local":
        if sanitize_repo_id(remote) != sanitize_repo_id(ctx.origin):
            reason = f"origin mismatch {remote} != {ctx.origin}"
            _update_publication(state, status="failed", reason=reason, commit=commit)
            return {"ok": False, "reason": reason, "commit": commit, "pushed": False}
    current_branch = branch_name(worktree)
    expected_branch = state.get("branch")
    if expected_branch and current_branch and current_branch != expected_branch:
        reason = f"worktree branch {current_branch} != expected {expected_branch}"
        _update_publication(state, status="failed", reason=reason, commit=commit)
        return {"ok": False, "reason": reason, "commit": commit, "pushed": False}
    if not state.get("pr"):
        return {"ok": True}
    try:
        view = pr_view(ctx.repo_root, int(state["pr"]))
    except AgentbusError as exc:
        reason = f"cannot verify PR #{state['pr']}: {exc}"
        _update_publication(state, status="failed", reason=reason, commit=commit)
        return {"ok": False, "reason": reason, "commit": commit, "pushed": False}
    if view.get("number") and int(view["number"]) != int(state["pr"]):
        reason = f"PR number mismatch {view.get('number')} != {state['pr']}"
        _update_publication(state, status="failed", reason=reason, commit=commit)
        return {"ok": False, "reason": reason, "commit": commit, "pushed": False}
    if view.get("headRefName") and view["headRefName"] != branch:
        reason = f"PR branch {view['headRefName']} != expected {branch}"
        _update_publication(state, status="failed", reason=reason, commit=commit)
        return {"ok": False, "reason": reason, "commit": commit, "pushed": False}
    pr_head = view.get("headRefOid")
    baseline = (state.get("publication") or {}).get("baseline_head")
    if pr_head and baseline and pr_head != baseline and pr_head != commit:
        reason = f"remote PR HEAD moved to {pr_head[:12]}; refusing to overwrite"
        return _remote_moved(state, reason, commit)
    return {"ok": True}


def _remote_moved(state: dict[str, Any], reason: str, commit: str) -> dict[str, Any]:
    _update_publication(state, status="failed", reason=reason, commit=commit)
    try:
        set_phase(state, RE_REVIEW_REQUIRED, reason=reason)
    except TransitionError:
        state["status"]["blocker"] = reason
    return {"ok": False, "reason": reason, "commit": commit, "pushed": False, "remote_moved": True}


def mark_publication_failed(
    state: dict[str, Any],
    reason: str,
    *,
    remote_moved: bool = False,
) -> dict[str, Any]:
    _update_publication(state, status="failed", reason=reason)
    state["status"]["impl"] = PUBLICATION_FAILED
    state["status"]["blocker"] = reason
    state["status"]["next_action"] = "PUBLISH"
    state["infra_publication_failures"] = int(state.get("infra_publication_failures") or 0) + 1
    if remote_moved:
        try:
            set_phase(state, RE_REVIEW_REQUIRED, reason=reason)
        except TransitionError:
            pass
    refresh_next(state)
    return state


def apply_published_report(
    store: StreamStore,
    state: dict[str, Any],
    *,
    commit: str,
    files: list[str],
    worktree: str,
    envelope: Envelope | None,
    extra_fields: dict[str, str] | None = None,
) -> Envelope:
    fields = dict(envelope.fields) if envelope else {}
    fields["STATUS"] = "READY_FOR_AUDIT"
    fields["STREAM"] = state["stream_id"]
    fields["IMPLEMENTED_HEAD"] = commit
    fields["CHANGED_FILES"] = "\n".join(f"- {path}" for path in files) or fields.get("CHANGED_FILES", "")
    fields["NEXT_ACTION"] = "AUDIT"
    comment_id = (
        ((state.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields") or {}
    ).get("SOURCE_CONTINUATION_COMMENT_ID") or (state.get("transport") or {}).get(
        "continuation_comment_id"
    )
    if comment_id and not fields.get("SOURCE_CONTINUATION_COMMENT_ID"):
        fields["SOURCE_CONTINUATION_COMMENT_ID"] = str(comment_id)
    if extra_fields:
        fields.update(extra_fields)
    if is_dirty(worktree):
        raise AgentbusError("refusing READY_FOR_AUDIT: worktree still dirty after commit")
    actual = head_sha(worktree)
    if actual != commit:
        raise AgentbusError("refusing READY_FOR_AUDIT: IMPLEMENTED_HEAD is not worktree HEAD")
    published = Envelope(kind="CODEX_REPORT", fields=fields, source="agentbus-publish")
    apply_envelope(store, state, published, repo=worktree, current_head=commit)
    return published


def reset_infra_repair_budget(state: dict[str, Any], *, reason: str) -> None:
    """Publication failures must not consume product repair cycles."""
    infra = int(state.get("infra_publication_failures") or 0)
    burned = int(state.get("repair_cycles") or 0)
    state["infra_publication_failures"] = infra + burned
    state["repair_cycles"] = 0
    state.setdefault("status", {})["blocker"] = None
    state["status"]["impl"] = "WAITING"
    state["control"] = "running"


def report_is_durable(state: dict[str, Any]) -> bool:
    rec = (state.get("envelopes") or {}).get("CODEX_REPORT") or {}
    if not isinstance(rec, dict) or not (rec.get("raw") or rec.get("status")):
        return False
    if rec.get("source") == "github" and rec.get("source_id"):
        return True
    pub = state.get("publication") or {}
    if pub.get("report_comment_id"):
        return True
    # Local inbox is the durable store only when there is no GitHub PR.
    return not bool(state.get("pr"))


def _report_body_for_github(state: dict[str, Any]) -> str | None:
    rec = (state.get("envelopes") or {}).get("CODEX_REPORT") or {}
    if not isinstance(rec, dict):
        return None
    raw = rec.get("raw") or ""
    if not raw.strip():
        return None
    fields = rec.get("fields") if isinstance(rec.get("fields"), dict) else {}
    comment_id = (
        ((state.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields") or {}
    ).get("SOURCE_CONTINUATION_COMMENT_ID") or (state.get("transport") or {}).get(
        "continuation_comment_id"
    )
    if comment_id and "SOURCE_CONTINUATION_COMMENT_ID" not in raw:
        raw = raw.rstrip() + f"\n\nSOURCE_CONTINUATION_COMMENT_ID: {comment_id}\n"
    if fields.get("IMPLEMENTED_HEAD") and "IMPLEMENTED_HEAD:" not in raw:
        return None
    return raw if raw.endswith("\n") else raw + "\n"


def _matching_report_comment(comments: list[dict[str, Any]], state: dict[str, Any]) -> dict[str, Any] | None:
    implemented = (state.get("heads") or {}).get("implemented") or ""
    stream = state.get("stream_id") or ""
    for comment in comments:
        body = comment.get("body") or ""
        if "[CODEX_REPORT]" not in body:
            continue
        if implemented and implemented not in body:
            continue
        if stream and f"STREAM: {stream}" not in body and f"STREAM:{stream}" not in body:
            continue
        return comment
    return None


def ensure_durable_report(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Exact-once CODEX_REPORT publication to the current PR. Never invents results."""
    from agentbus.github import list_issue_comments, parse_owner_repo, post_pr_comment

    rec = (state.get("envelopes") or {}).get("CODEX_REPORT")
    if not isinstance(rec, dict) or not rec.get("raw"):
        return {"ok": False, "reason": "no local CODEX_REPORT artifact"}
    if report_is_durable(state):
        return {"ok": True, "already": True, "comment_id": rec.get("source_id") or (state.get("publication") or {}).get("report_comment_id")}
    pr = state.get("pr")
    if not pr:
        return {"ok": False, "reason": "no PR for durable report", "retryable": True}
    repo = state.get("impl_worktree") or ctx.repo_root
    try:
        comments = list_issue_comments(repo, ctx.origin, int(pr), env=env)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": str(exc)[:300], "retryable": True}
    existing = _matching_report_comment(comments, state)
    if existing and existing.get("id"):
        rec["source"] = "github"
        rec["source_id"] = str(existing["id"])
        state.setdefault("publication", {})["report_comment_id"] = str(existing["id"])
        return {"ok": True, "already": True, "comment_id": str(existing["id"])}
    body = _report_body_for_github(state)
    if not body:
        return {"ok": False, "reason": "local CODEX_REPORT is empty"}
    try:
        posted = post_pr_comment(repo, int(pr), body, env=env)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": str(exc)[:300], "retryable": True}
    comment_id = str((posted or {}).get("id") or "")
    if not comment_id:
        try:
            comments = list_issue_comments(repo, ctx.origin, int(pr), env=env)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": f"posted but could not verify: {exc}"[:300], "retryable": True}
        match = _matching_report_comment(comments, state)
        comment_id = str((match or {}).get("id") or "")
        if not comment_id:
            return {"ok": False, "reason": "CODEX_REPORT post not visible on PR", "retryable": True}
    rec["source"] = "github"
    rec["source_id"] = comment_id
    state.setdefault("publication", {})["report_comment_id"] = comment_id
    store.append_event("durable-report", {"pr": pr, "comment_id": comment_id, "head": rec.get("head")})
    return {"ok": True, "comment_id": comment_id}


def consume_product_repair(state: dict[str, Any], audited_head: str | None) -> bool:
    """Return True if this audit should count against the product repair budget."""
    published = (state.get("publication") or {}).get("commit")
    last_product = (state.get("publication") or {}).get("last_product_audit_head")
    if not published or not audited_head:
        return False
    if audited_head != published:
        return False
    if last_product == audited_head:
        return False
    return True
