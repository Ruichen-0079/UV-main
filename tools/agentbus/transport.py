"""PR-first durable transport. Bootstrap is AgentBus-owned zero-tree metadata.

Never treats a bootstrap commit as IMPLEMENTED_HEAD.
Never force-pushes. Never reads dirty worktree contents into a commit.
"""

from __future__ import annotations

import os
from typing import Any

from agentbus.gitutil import (
    branch_name,
    head_sha,
    porcelain_status,
    rev_exists,
    rev_tree,
)
from agentbus.github import create_draft_pr, pr_web_url, run_gh
from agentbus.machine import BOOTSTRAP_PR_READY, IMPLEMENTING, WORKTREE_READY
from agentbus.paths import AgentbusError, RepoContext
from agentbus.store import StreamStore
from agentbus.util import run_cmd, utc_now


BOOTSTRAP_KIND = "zero_tree_transport"
RETRYABLE_MARKERS = (
    "network",
    "timeout",
    "temporarily",
    "rate limit",
    "502",
    "503",
    "504",
    "connection",
    "eof",
    "unavailable",
    "try again",
)


def bootstrap_message(stream_id: str) -> str:
    return f"agentbus({stream_id}): establish durable PR transport"


def is_bootstrap_commit(state: dict[str, Any], sha: str | None) -> bool:
    if not sha:
        return False
    transport = state.get("transport") or {}
    return sha == (transport.get("bootstrap_commit") or transport.get("commit_sha"))


def _push_disabled() -> bool:
    return os.environ.get("YUVI_AGENTBUS_PUSH") == "0" and os.environ.get("YUVI_AGENTBUS_BOOTSTRAP_PR") != "1"


def _pr_enabled() -> bool:
    if os.environ.get("YUVI_AGENTBUS_BOOTSTRAP_PR") == "1":
        return True
    return os.environ.get("YUVI_AGENTBUS_PUSH") != "0"


def _retryable(message: str) -> bool:
    text = (message or "").lower()
    return any(marker in text for marker in RETRYABLE_MARKERS)


def _commit_subject(repo: str, sha: str) -> str:
    result = run_cmd(["git", "log", "-1", "--format=%s", sha], cwd=repo, timeout=10)
    return (result.stdout or "").strip() if result.returncode == 0 else ""


def classify_branch_head(
    repo: str,
    state: dict[str, Any],
    *,
    base: str,
    head: str,
) -> str:
    if not head:
        return "unknown"
    if head == base:
        return "at_base"
    if is_bootstrap_commit(state, head):
        return "bootstrap"
    subject = _commit_subject(repo, head)
    if subject == bootstrap_message(state.get("stream_id") or ""):
        return "bootstrap"
    pub = state.get("publication") or {}
    if pub.get("commit") == head and pub.get("status") in {"committed", "pushed"}:
        return "owned_implementation"
    base_tree = rev_tree(repo, base)
    head_tree = rev_tree(repo, head)
    if base_tree and head_tree and base_tree != head_tree:
        return "owned_implementation" if (pub.get("commit") == head or subject.startswith(f"agentbus({state.get('stream_id')}):")) else "product_commit"
    if subject.startswith(f"agentbus({state.get('stream_id')}):") and "establish durable PR transport" not in subject:
        return "owned_implementation"
    return "unknown"


def create_zero_tree_bootstrap(
    repo: str,
    *,
    branch: str,
    expected_head: str,
    stream_id: str,
) -> dict[str, Any]:
    """Create a commit with tree == expected_head^{tree}. Never reads the index."""
    if not rev_exists(repo, expected_head):
        return {"ok": False, "reason": f"expected head {expected_head[:12]} is missing", "human_required": True}
    tree = rev_tree(repo, expected_head)
    if not tree:
        return {"ok": False, "reason": "unable to resolve expected head tree", "human_required": True}
    message = bootstrap_message(stream_id)
    created = run_cmd(
        ["git", "commit-tree", tree, "-p", expected_head, "-m", message],
        cwd=repo,
        timeout=15,
    )
    if created.returncode != 0:
        return {"ok": False, "reason": created.stderr.strip() or "git commit-tree failed", "retryable": True}
    commit = created.stdout.strip()
    new_tree = rev_tree(repo, commit)
    if not commit or new_tree != tree:
        return {
            "ok": False,
            "reason": "BOOTSTRAP_TREE_MISMATCH",
            "human_required": True,
            "expected_tree": tree,
            "got_tree": new_tree,
        }
    cas = run_cmd(
        ["git", "update-ref", f"refs/heads/{branch}", commit, expected_head],
        cwd=repo,
        timeout=10,
    )
    if cas.returncode != 0:
        current = head_sha(repo)
        return {
            "ok": False,
            "reason": "cas_failed",
            "cas_lost": True,
            "expected_head": expected_head,
            "current_head": current,
            "stderr": (cas.stderr or "").strip(),
        }
    return {
        "ok": True,
        "commit": commit,
        "tree": tree,
        "base": expected_head,
        "branch": branch,
        "message": message,
    }


def _push_branch(repo: str, branch: str) -> dict[str, Any]:
    if os.environ.get("YUVI_AGENTBUS_PUSH") == "0":
        return {"ok": True, "pushed": False, "skipped": True}
    result = run_cmd(["git", "push", "--porcelain", "origin", f"refs/heads/{branch}:refs/heads/{branch}"], cwd=repo, timeout=60)
    if result.returncode != 0:
        reason = result.stderr.strip() or result.stdout.strip() or "git push failed"
        return {"ok": False, "reason": reason, "retryable": _retryable(reason)}
    return {"ok": True, "pushed": True}


def find_pr_for_head(repo: str, head: str, env: dict[str, str] | None = None) -> dict[str, Any] | None:
    code, out, err = run_gh(
        ["pr", "list", "--head", head, "--state", "all", "--json", "number,url,isDraft,state", "--limit", "5"],
        cwd=repo,
        env=env,
        timeout=30,
    )
    if code != 0:
        return None
    try:
        import json

        rows = json.loads(out or "[]")
    except json.JSONDecodeError:
        return None
    if not isinstance(rows, list) or not rows:
        return None
    row = rows[0]
    if not isinstance(row, dict) or not row.get("number"):
        return None
    return row


def _pr_body(state: dict[str, Any], *, item: dict[str, Any] | None, bootstrap: dict[str, Any] | None) -> str:
    transport = state.get("transport") or {}
    fields = ((state.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields") or {}
    predecessor = (item or {}).get("after_stream") or fields.get("CONTINUATION_OF") or transport.get("predecessor_stream")
    comment_id = (item or {}).get("source_comment_id") or fields.get("SOURCE_CONTINUATION_COMMENT_ID") or transport.get("continuation_comment_id")
    pred_pr = (item or {}).get("previous_pr") or fields.get("SOURCE_PREDECESSOR_PR") or transport.get("predecessor_pr")
    base = transport.get("base_sha") or fields.get("BASE_HEAD") or (state.get("heads") or {}).get("spec_base")
    skip = transport.get("bootstrap_skipped_reason")
    kind = "zero-tree-change transport only" if bootstrap and bootstrap.get("ok") else "existing branch head"
    return (
        f"AgentBus continuation of `{predecessor}`.\n\n"
        f"Campaign: `{state.get('campaign_id')}`\n"
        f"Next unit: `{state.get('stream_id')}`\n"
        f"Predecessor PR: `{pred_pr or '-'}`\n"
        f"Continuation comment: `{comment_id or '-'}`\n"
        f"Resolved base: `{base or '-'}`\n"
        f"MATERIALIZED_BY: AGENTBUS\n"
        f"SOURCE_CONTINUATION_COMMENT_ID: {comment_id or '-'}\n"
        f"SOURCE_PREDECESSOR_PR: {pred_pr or '-'}\n"
        f"Transport: {kind}.\n"
        + (f"Bootstrap skipped: {skip}\n" if skip else "Bootstrap commit is not an implementation and is not IMPLEMENTED_HEAD.\n")
        + "No auto-merge.\n"
        "This PR is independently auditable.\n"
    )


def ensure_durable_pr_transport(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
    *,
    item: dict[str, Any] | None = None,
    wake_impl: bool = False,
) -> dict[str, Any]:
    """Idempotent: bootstrap if still at base, else PR from real head. Never force-push."""
    from agentbus.apply import set_phase

    worktree = state.get("impl_worktree") or ctx.repo_root
    branch = state.get("branch") or f"agentbus/{state.get('stream_id')}"
    base = (item or {}).get("resolved_base") or (state.get("heads") or {}).get("spec_base") or head_sha(worktree)
    transport = state.setdefault("transport", {})
    before_status = porcelain_status(worktree)
    before_head = head_sha(worktree)
    if state.get("pr"):
        transport["status"] = "pr_ready"
        return {"ok": True, "pr": state.get("pr"), "already": True, "head": before_head}

    existing = find_pr_for_head(worktree, branch)
    if existing and existing.get("number"):
        state["pr"] = int(existing["number"])
        transport["status"] = "pr_ready"
        transport["pr"] = state["pr"]
        return {"ok": True, "pr": state["pr"], "already": True, "recovered": True, "head": before_head}

    kind = classify_branch_head(worktree, state, base=base or "", head=before_head or "")
    bootstrap_info = None
    if kind == "unknown":
        reason = f"unknown/external ref movement at {(before_head or '')[:12]}"
        transport["status"] = "blocked"
        transport["reason"] = reason
        state.setdefault("status", {})["blocker"] = reason
        set_phase(state, "BLOCKED", reason=reason)
        return {"ok": False, "reason": reason, "human_required": True, "attention_owner": "HUMAN"}

    if kind == "at_base":
        bootstrap_info = create_zero_tree_bootstrap(
            worktree, branch=branch, expected_head=before_head or base, stream_id=state["stream_id"]
        )
        if bootstrap_info.get("cas_lost"):
            current = bootstrap_info.get("current_head") or head_sha(worktree)
            kind = classify_branch_head(worktree, state, base=base or "", head=current or "")
            if kind in {"owned_implementation", "product_commit", "bootstrap"}:
                transport["bootstrap_skipped_reason"] = "implementation_already_published" if kind != "bootstrap" else "bootstrap_exists"
            else:
                reason = "branch advanced during bootstrap; refusing to overwrite"
                transport["status"] = "blocked"
                transport["reason"] = reason
                set_phase(state, "BLOCKED", reason=reason)
                return {"ok": False, "reason": reason, "human_required": True, "cas_lost": True}
        elif not bootstrap_info.get("ok"):
            if bootstrap_info.get("reason") == "BOOTSTRAP_TREE_MISMATCH":
                return {**bootstrap_info, "attention_owner": "HUMAN"}
            return {**bootstrap_info, "attention_owner": "AGENTBUS"}
        else:
            after_status = porcelain_status(worktree)
            if after_status != before_status:
                return {
                    "ok": False,
                    "reason": "bootstrap changed worktree/index status; aborting without push",
                    "human_required": True,
                }
            transport.update(
                {
                    "owned": True,
                    "kind": BOOTSTRAP_KIND,
                    "base_sha": bootstrap_info["base"],
                    "commit_sha": bootstrap_info["commit"],
                    "bootstrap_commit": bootstrap_info["commit"],
                    "tree_sha": bootstrap_info["tree"],
                    "created_at": utc_now(),
                    "continuation_comment_id": (item or {}).get("source_comment_id"),
                }
            )
            state.setdefault("publication", {})["bootstrap"] = bootstrap_info["commit"]
    elif kind in {"owned_implementation", "product_commit"}:
        transport["bootstrap_skipped_reason"] = "implementation_already_published"
    elif kind == "bootstrap":
        transport.setdefault("bootstrap_commit", before_head)

    head = head_sha(worktree)
    pushed = _push_branch(worktree, branch)
    if not pushed.get("ok"):
        transport["status"] = "push_failed"
        transport["reason"] = pushed.get("reason")
        return {
            "ok": False,
            "reason": pushed.get("reason"),
            "retryable": bool(pushed.get("retryable")),
            "attention_owner": "AGENTBUS" if pushed.get("retryable") else "HUMAN",
        }

    if not _pr_enabled():
        transport["status"] = "pr_skipped"
        transport["reason"] = "push_disabled"
        if state.get("phase") == WORKTREE_READY:
            set_phase(state, BOOTSTRAP_PR_READY, reason="local transport without PR")
            set_phase(state, IMPLEMENTING, reason="local successor ready")
        return {"ok": True, "pr": None, "skipped": True, "head": head, "bootstrap": bootstrap_info}

    try:
        created = create_draft_pr(
            worktree,
            title=state.get("goal") or state["stream_id"],
            body=_pr_body(state, item=item, bootstrap=bootstrap_info),
            head=branch,
        )
    except AgentbusError as exc:
        reason = str(exc)
        existing = find_pr_for_head(worktree, branch)
        if existing and existing.get("number"):
            created = existing
        else:
            transport["status"] = "pr_failed"
            transport["reason"] = reason
            retryable = _retryable(reason)
            return {
                "ok": False,
                "reason": reason,
                "retryable": retryable,
                "attention_owner": "AGENTBUS" if retryable else "HUMAN",
            }

    number = created.get("number")
    if number:
        state["pr"] = int(number)
        transport["pr"] = int(number)
        transport["status"] = "pr_ready"
        transport["pr_url"] = created.get("url") or pr_web_url(ctx.origin, number)
    if state.get("phase") in {WORKTREE_READY, "WAITING_FOR_SPEC", "MATERIALIZING"}:
        set_phase(state, BOOTSTRAP_PR_READY, reason="durable PR transport ready")
        set_phase(state, IMPLEMENTING, reason="PR-first successor ready")
    store.append_event(
        "transport-pr",
        {"pr": state.get("pr"), "head": head, "bootstrap": (bootstrap_info or {}).get("commit"), "skip": transport.get("bootstrap_skipped_reason")},
    )
    if wake_impl:
        from agentbus.campaign import _wake_impl

        _wake_impl(store, state)
    return {
        "ok": True,
        "pr": state.get("pr"),
        "head": head,
        "bootstrap": bootstrap_info,
        "dirty_unchanged": porcelain_status(worktree) == before_status,
    }


def apply_continuation_provenance(state: dict[str, Any], item: dict[str, Any], after_state: dict[str, Any], base: str) -> None:
    fields = ((state.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields")
    extra = {
        "SOURCE_CONTINUATION_COMMENT_ID": item.get("source_comment_id") or "",
        "SOURCE_PREDECESSOR_PR": str(after_state.get("pr") or ""),
        "SOURCE_PREDECESSOR_STREAM": after_state.get("stream_id") or item.get("after_stream") or "",
        "MATERIALIZED_BY": "AGENTBUS",
        "CONTINUATION_OF": after_state.get("stream_id") or "",
        "BASE_HEAD": base,
    }
    if isinstance(fields, dict):
        fields.update({key: value for key, value in extra.items() if value})
    transport = state.setdefault("transport", {})
    transport.update(
        {
            "continuation_comment_id": item.get("source_comment_id"),
            "predecessor_pr": after_state.get("pr"),
            "predecessor_stream": after_state.get("stream_id"),
            "base_sha": base,
            "materialized_by": "AGENTBUS",
        }
    )
