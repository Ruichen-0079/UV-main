"""Current-base CI reconciliation for unchanged pull-request heads.

The branch created here is an operational Actions trigger only.  It is never
used as product or merge authority; Final GPT and the normal merge fences still
must approve the unchanged PR head.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

from agentbus.util import run_cmd, sha256_text, utc_now


WORKFLOW_FILE = ".github/workflows/check.yml"
WORKFLOW_NAME = "Check"
CI_BRANCH_PREFIX = "agentbus/ci/"
REQUIRED_CHECKS = (
    "validate (ubuntu-latest)",
    "validate (windows-latest)",
    "desktop-windows-package",
)
_SHA = re.compile(r"^[0-9a-fA-F]{40}$")


@dataclass
class CIAdapter:
    """Shell boundary used by production and replaceable by deterministic tests."""

    def git(
        self,
        args: list[str],
        *,
        cwd: str,
        env: Mapping[str, str] | None = None,
        timeout: float = 60,
        input_text: str | None = None,
        extra_env: Mapping[str, str] | None = None,
    ) -> tuple[int, str, str]:
        merged = dict(env or {})
        merged.update(extra_env or {})
        result = run_cmd(["git", *args], cwd=cwd, env=merged, timeout=timeout, input_text=input_text)
        return result.returncode, result.stdout, result.stderr

    def gh(
        self,
        args: list[str],
        *,
        cwd: str,
        env: Mapping[str, str] | None = None,
        timeout: float = 60,
    ) -> tuple[int, str, str]:
        from agentbus.github import run_gh

        return run_gh(args, cwd=cwd, env=dict(env or {}), timeout=timeout)

    def pr_view(self, cwd: str, number: int, env: Mapping[str, str] | None = None) -> dict[str, Any]:
        from agentbus.github import pr_view

        return pr_view(cwd, number, env=dict(env or {}))

    def live_base(self, cwd: str, ref: str, env: Mapping[str, str] | None = None) -> str:
        from agentbus.github import resolve_live_base_head

        return resolve_live_base_head(cwd, ref, env=dict(env or {}))


def _is_sha(value: Any) -> bool:
    return bool(_SHA.fullmatch(str(value or "").strip()))


def synthetic_generation(
    *,
    pr: int | str,
    head: str,
    base: str,
    synthetic_merge: str,
    workflow: str = WORKFLOW_NAME,
    workflow_file: str = WORKFLOW_FILE,
) -> str:
    payload = {
        "base": base,
        "head": head,
        "pr": str(pr),
        "synthetic_merge": synthetic_merge,
        "workflow": workflow,
        "workflow_file": workflow_file,
    }
    return sha256_text(json.dumps(payload, sort_keys=True, separators=(",", ":")))


def ci_branch_name(stream: str, generation: str) -> str:
    safe_stream = re.sub(r"[^A-Za-z0-9._-]+", "-", str(stream or "stream")).strip(".-") or "stream"
    return f"{CI_BRANCH_PREFIX}{safe_stream}/{generation[:24]}"


def verify_synthetic_merge(
    *,
    parents: list[str],
    merge_tree: str,
    expected_tree: str,
    base: str,
    head: str,
) -> tuple[bool, str]:
    """Pure exact-parent/tree fence for a synthetic merge commit."""

    if not _is_sha(base) or not _is_sha(head) or not _is_sha(merge_tree):
        return False, "synthetic merge evidence is not exact SHA data"
    if [str(item).strip().lower() for item in parents] != [base.lower(), head.lower()]:
        return False, "synthetic merge parents do not equal current base and PR HEAD"
    if not _is_sha(expected_tree) or merge_tree.lower() != expected_tree.lower():
        return False, "synthetic merge tree is not the current base plus PR HEAD"
    return True, "synthetic merge is current and exact"


def _historical_base(state: dict[str, Any]) -> str:
    transport = state.get("transport") if isinstance(state.get("transport"), dict) else {}
    value = str(transport.get("base_sha") or "").strip()
    if value:
        return value
    spec = (state.get("envelopes") or {}).get("GPT_SPEC") or {}
    fields = spec.get("fields") if isinstance(spec.get("fields"), dict) else {}
    value = str(fields.get("BASE_HEAD") or "").strip()
    if value:
        return value
    return str((state.get("heads") or {}).get("spec_base") or "").strip()


def current_base_ci_required(state: dict[str, Any], live: dict[str, Any] | None) -> bool:
    """Return true only after exact implementation/audit/product prerequisites."""

    from agentbus.decision import (
        active_blocker,
        audit_pass_exact,
        product_review_authority,
        report_valid_exact,
        strong_current_publication_ownership,
        unit_head,
    )

    pr = state.get("pr")
    current = live if isinstance(live, dict) else {}
    head = str(unit_head(state) or "").strip()
    base = str(current.get("baseRefOid") or "").strip()
    historical = _historical_base(state)
    if not pr or not head or not _is_sha(head) or not _is_sha(base) or not historical:
        return False
    if base.lower() == historical.lower():
        return False
    if str(current.get("state") or "").upper() != "OPEN":
        return False
    if str(current.get("headRefOid") or "").strip() != head:
        return False
    if not strong_current_publication_ownership(state, head):
        return False
    if not report_valid_exact(state) or not audit_pass_exact(state):
        return False
    if not product_review_authority(state).get("ok") or active_blocker(state):
        return False
    return True


def current_base_ci_record(state: dict[str, Any]) -> dict[str, Any]:
    record = state.get("current_base_ci")
    return dict(record) if isinstance(record, dict) else {}


def current_base_ci_matches(
    record: dict[str, Any],
    *,
    pr: int | str,
    head: str,
    base: str,
) -> bool:
    return bool(
        record
        and str(record.get("pr") or "") == str(pr)
        and str(record.get("head") or "").lower() == head.lower()
        and str(record.get("base") or "").lower() == base.lower()
        and _is_sha(record.get("synthetic_merge"))
        and str(record.get("generation") or "")
        == synthetic_generation(
            pr=pr,
            head=head,
            base=base,
            synthetic_merge=str(record.get("synthetic_merge")),
            workflow=str(record.get("workflow") or WORKFLOW_NAME),
            workflow_file=str(record.get("workflow_file") or WORKFLOW_FILE),
        )
    )


def _git_text(
    adapter: CIAdapter,
    args: list[str],
    *,
    cwd: str,
    env: Mapping[str, str] | None = None,
    timeout: float = 60,
    extra_env: Mapping[str, str] | None = None,
) -> tuple[int, str, str]:
    return adapter.git(args, cwd=cwd, env=env, timeout=timeout, extra_env=extra_env)


def _rev_parse(adapter: CIAdapter, cwd: str, expression: str, env: Mapping[str, str] | None) -> str | None:
    code, out, _ = _git_text(adapter, ["rev-parse", expression], cwd=cwd, env=env)
    value = out.strip().splitlines()[0] if code == 0 and out.strip() else ""
    return value if _is_sha(value) else None


def _merge_parents_and_tree(
    adapter: CIAdapter,
    cwd: str,
    merge: str,
    *,
    env: Mapping[str, str] | None,
) -> tuple[list[str], str] | None:
    code, out, _ = _git_text(adapter, ["rev-list", "--parents", "-n", "1", merge], cwd=cwd, env=env)
    if code != 0 or not out.strip():
        return None
    parts = out.strip().split()
    if not _is_sha(parts[0]):
        return None
    tree = _rev_parse(adapter, cwd, f"{merge}^{{tree}}", env)
    if not tree:
        return None
    return parts[1:], tree


def _expected_merge_tree(
    adapter: CIAdapter,
    cwd: str,
    base: str,
    head: str,
    *,
    env: Mapping[str, str] | None,
) -> str | None:
    code, out, _ = _git_text(adapter, ["merge-tree", "--write-tree", base, head], cwd=cwd, env=env)
    if code != 0:
        return None
    for token in out.split():
        if _is_sha(token):
            return token
    return None


def _fetch_current_refs(
    adapter: CIAdapter,
    cwd: str,
    *,
    pr: int | str,
    base_ref: str,
    expected_base: str,
    expected_head: str,
    env: Mapping[str, str] | None,
) -> tuple[bool, str]:
    refs = (
        f"refs/heads/{base_ref}",
        f"refs/pull/{int(pr)}/head",
        f"refs/pull/{int(pr)}/merge",
    )
    for index, ref in enumerate(refs):
        code, _, err = _git_text(
            adapter,
            ["fetch", "--no-tags", "--force", "origin", ref],
            cwd=cwd,
            env=env,
            timeout=90,
        )
        if code != 0:
            return False, err.strip() or f"could not fetch {ref}"
        fetched = _rev_parse(adapter, cwd, "FETCH_HEAD", env)
        if index == 0 and (not fetched or fetched.lower() != expected_base.lower()):
            return False, "remote base advanced while fetching the synthetic CI inputs"
        if index == 1 and (not fetched or fetched.lower() != expected_head.lower()):
            return False, "PR HEAD changed while fetching the synthetic CI inputs"
    return True, "fetched current base, PR head, and synthetic merge refs"


def _materialize_local_merge(
    adapter: CIAdapter,
    cwd: str,
    *,
    pr: int | str,
    base: str,
    head: str,
    env: Mapping[str, str] | None,
) -> tuple[str | None, str]:
    tree = _expected_merge_tree(adapter, cwd, base, head, env=env)
    if not tree:
        return None, "current base and PR HEAD cannot be merged cleanly"
    message = (
        "AgentBus current-base CI synthetic merge\n\n"
        f"PR: {pr}\nBASE: {base}\nHEAD: {head}\nWORKFLOW: {WORKFLOW_FILE}\n"
    )
    fixed_env = {
        "GIT_AUTHOR_NAME": "AgentBus CI",
        "GIT_AUTHOR_EMAIL": "agentbus-ci@localhost",
        "GIT_COMMITTER_NAME": "AgentBus CI",
        "GIT_COMMITTER_EMAIL": "agentbus-ci@localhost",
        "GIT_AUTHOR_DATE": "Thu, 01 Jan 1970 00:00:00 +0000",
        "GIT_COMMITTER_DATE": "Thu, 01 Jan 1970 00:00:00 +0000",
    }
    code, out, err = _git_text(
        adapter,
        ["commit-tree", tree, "-p", base, "-p", head, "-m", message],
        cwd=cwd,
        env=env,
        timeout=60,
        extra_env=fixed_env,
    )
    merge = out.strip().splitlines()[0] if code == 0 and out.strip() else ""
    if not _is_sha(merge):
        return None, err.strip() or "could not materialize the current-base CI merge commit"
    return merge, "GitHub merge ref was stale; materialized exact current B+H CI merge"


def resolve_synthetic_merge(
    adapter: CIAdapter,
    cwd: str,
    *,
    pr: int | str,
    base: str,
    head: str,
    base_ref: str,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Fetch and fence GitHub's ref, with a safe ephemeral-merge fallback."""

    fetched, fetch_reason = _fetch_current_refs(
        adapter,
        cwd,
        pr=pr,
        base_ref=base_ref,
        expected_base=base,
        expected_head=head,
        env=env,
    )
    if not fetched:
        return {"ok": False, "reason": fetch_reason}
    merge = _rev_parse(adapter, cwd, "FETCH_HEAD", env)
    # FETCH_HEAD is the last fetched ref, i.e. refs/pull/N/merge.
    observed = _merge_parents_and_tree(adapter, cwd, merge or "", env=env) if merge else None
    expected_tree = _expected_merge_tree(adapter, cwd, base, head, env=env)
    if observed and expected_tree:
        parents, merge_tree = observed
        valid, reason = verify_synthetic_merge(
            parents=parents,
            merge_tree=merge_tree,
            expected_tree=expected_tree,
            base=base,
            head=head,
        )
        if valid:
            return {"ok": True, "synthetic_merge": merge, "source": "github_pull_merge", "reason": reason}
        # A stale GitHub merge ref with the exact PR HEAD is safe to replace by
        # an ephemeral merge object. A ref with another PR HEAD is not.
        if len(parents) != 2 or parents[1].lower() != head.lower():
            return {"ok": False, "reason": reason}
        if parents[0].lower() == base.lower():
            return {"ok": False, "reason": reason}
    local_merge, local_reason = _materialize_local_merge(
        adapter,
        cwd,
        pr=pr,
        base=base,
        head=head,
        env=env,
    )
    if not local_merge:
        return {"ok": False, "reason": local_reason}
    local_observed = _merge_parents_and_tree(adapter, cwd, local_merge, env=env)
    if not local_observed or not expected_tree:
        return {"ok": False, "reason": "materialized CI merge cannot be verified"}
    parents, merge_tree = local_observed
    valid, reason = verify_synthetic_merge(
        parents=parents,
        merge_tree=merge_tree,
        expected_tree=expected_tree,
        base=base,
        head=head,
    )
    if not valid:
        return {"ok": False, "reason": reason}
    return {"ok": True, "synthetic_merge": local_merge, "source": "local_current_base", "reason": local_reason}


def _remote_branch_sha(adapter: CIAdapter, cwd: str, branch: str, env: Mapping[str, str] | None) -> str | None:
    code, out, _ = _git_text(
        adapter,
        ["ls-remote", "--heads", "origin", f"refs/heads/{branch}"],
        cwd=cwd,
        env=env,
        timeout=45,
    )
    if code != 0 or not out.strip():
        return None
    value = out.strip().split()[0]
    return value if _is_sha(value) else None


def cleanup_ci_branch(
    adapter: CIAdapter,
    cwd: str,
    record: dict[str, Any],
    *,
    stream: str,
    pr: int | str,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Delete only an exact AgentBus CI branch with an exact recorded object."""

    branch = str(record.get("branch") or "")
    commit = str(record.get("synthetic_merge") or "")
    if not branch.startswith(CI_BRANCH_PREFIX):
        return {"ok": False, "reason": "refusing cleanup outside the AgentBus CI namespace"}
    if str(record.get("stream") or "") != str(stream) or str(record.get("pr") or "") != str(pr):
        return {"ok": False, "reason": "CI branch ownership binding does not match stream/PR"}
    if not _is_sha(commit):
        return {"ok": False, "reason": "CI branch has no exact recorded synthetic merge"}
    remote = _remote_branch_sha(adapter, cwd, branch, env)
    if remote is None:
        return {"ok": True, "status": "already-absent", "branch": branch}
    if remote.lower() != commit.lower():
        return {"ok": False, "reason": "CI branch object changed; refusing deletion", "branch": branch}
    code, _, err = _git_text(
        adapter,
        ["push", "origin", "--delete", branch],
        cwd=cwd,
        env=env,
        timeout=90,
    )
    if code != 0:
        return {"ok": False, "reason": err.strip() or "could not delete owned CI branch", "branch": branch}
    return {"ok": True, "status": "deleted", "branch": branch}


def _record(
    *,
    state: dict[str, Any],
    pr: int | str,
    head: str,
    base: str,
    synthetic_merge: str,
    generation: str,
    branch: str,
    source: str,
) -> dict[str, Any]:
    return {
        "status": "RUNNING",
        "result": None,
        "pr": int(pr),
        "stream": str(state.get("stream_id") or ""),
        "head": head,
        "base": base,
        "base_ref": str(((state.get("github") or {}).get("pr") or {}).get("baseRefName") or ""),
        "synthetic_merge": synthetic_merge,
        "source": source,
        "generation": generation,
        "workflow": WORKFLOW_NAME,
        "workflow_file": WORKFLOW_FILE,
        "branch": branch,
        "run_id": None,
        "checks": [],
        "updated_at": utc_now(),
    }


def _observe_run(
    adapter: CIAdapter,
    cwd: str,
    record: dict[str, Any],
    *,
    env: Mapping[str, str] | None,
) -> dict[str, Any]:
    branch = str(record.get("branch") or "")
    merge = str(record.get("synthetic_merge") or "")
    args = [
        "run",
        "list",
        "--workflow",
        "check.yml",
        "--branch",
        branch,
        "--limit",
        "20",
        "--json",
        "databaseId,headSha,status,conclusion,workflowName,event,headBranch,createdAt,url",
    ]
    code, out, err = adapter.gh(args, cwd=cwd, env=env, timeout=45)
    if code != 0:
        return {"status": "RUNNING", "last_error": err.strip() or "GitHub Actions run lookup failed"}
    try:
        rows = json.loads(out or "[]")
    except json.JSONDecodeError:
        return {"status": "RUNNING", "last_error": "GitHub Actions run lookup returned invalid JSON"}
    if not isinstance(rows, list):
        rows = []
    candidates = [
        item
        for item in rows
        if isinstance(item, dict)
        and str(item.get("headSha") or "").lower() == merge.lower()
        and str(item.get("workflowName") or "") == WORKFLOW_NAME
        and str(item.get("event") or "") == "push"
        and str(item.get("headBranch") or branch) == branch
    ]
    candidates.sort(key=lambda item: (str(item.get("createdAt") or ""), int(item.get("databaseId") or 0)))
    if not candidates:
        return {"status": "RUNNING", "last_error": "waiting for the exact synthetic CI run"}
    selected = candidates[-1]
    run_id = str(selected.get("databaseId") or "")
    detail = dict(selected)
    if run_id:
        code, detail_out, detail_err = adapter.gh(
            [
                "run",
                "view",
                run_id,
                "--json",
                "databaseId,headSha,headBranch,status,conclusion,workflowName,event,jobs,url",
            ],
            cwd=cwd,
            env=env,
            timeout=60,
        )
        if code == 0:
            try:
                parsed = json.loads(detail_out or "{}")
                if isinstance(parsed, dict):
                    detail.update(parsed)
            except json.JSONDecodeError:
                pass
        elif str(selected.get("status") or "").lower() == "completed":
            return {"status": "RUNNING", "run_id": run_id, "last_error": detail_err.strip() or "run detail unavailable"}

    status = str(detail.get("status") or "").lower()
    result = str(detail.get("conclusion") or "").lower()
    jobs = detail.get("jobs") if isinstance(detail.get("jobs"), list) else []
    checks: list[dict[str, Any]] = []
    by_name: dict[str, dict[str, Any]] = {}
    for item in jobs:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        by_name[name] = item
    for required in REQUIRED_CHECKS:
        item = by_name.get(required)
        checks.append(
            {
                "name": required,
                "status": str((item or {}).get("status") or "missing").lower(),
                "conclusion": str((item or {}).get("conclusion") or "").lower(),
            }
        )
    if status != "completed":
        return {"status": "RUNNING", "run_id": run_id, "result": result or None, "checks": checks}
    if (
        str(detail.get("headSha") or "").lower() != merge.lower()
        or str(detail.get("workflowName") or "") != WORKFLOW_NAME
        or str(detail.get("event") or "") != "push"
        or str(detail.get("headBranch") or branch) != branch
    ):
        return {"status": "FAIL", "run_id": run_id, "result": "invalid", "checks": checks, "last_error": "run identity fence failed"}
    if all(item["status"] == "completed" and item["conclusion"] == "success" for item in checks):
        return {"status": "PASS", "run_id": run_id, "result": result or "success", "checks": checks}
    return {"status": "FAIL", "run_id": run_id, "result": result or "failure", "checks": checks}


def _set_record(state: dict[str, Any], record: dict[str, Any], store: Any) -> None:
    old = current_base_ci_record(state)
    record = dict(record)
    record["updated_at"] = utc_now()
    state["current_base_ci"] = record
    if old != record:
        store.append_event("current-base-ci", {key: value for key, value in record.items() if key != "checks"})


def reconcile_current_base_ci(
    ctx: Any,
    store: Any,
    state: dict[str, Any],
    live: dict[str, Any] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    adapter: CIAdapter | None = None,
) -> dict[str, Any]:
    """Ensure one exact current-base CI generation, without changing PR HEAD."""

    adapter = adapter or CIAdapter()
    current = live if isinstance(live, dict) else (state.get("github") or {}).get("pr") or {}
    if not current_base_ci_required(state, current):
        old = current_base_ci_record(state)
        if old and state.get("pr"):
            cleanup = cleanup_ci_branch(
                adapter,
                ctx.repo_root,
                old,
                stream=str(state.get("stream_id") or store.stream_id),
                pr=state.get("pr"),
                env=env,
            )
            if cleanup.get("ok"):
                state["current_base_ci"] = None
            return {"ok": True, "status": "not-required", "cleanup": cleanup}
        return {"ok": True, "status": "not-required", "reason": "current-base CI prerequisites are not complete"}

    pr = int(state["pr"])
    head = str(((state.get("heads") or {}).get("implemented")) or "").strip()
    base_ref = str(current.get("baseRefName") or "").strip()
    if not base_ref:
        return {"ok": True, "status": "WAIT", "reason": "PR base ref is unavailable", "wait_reason": "CI_REVALIDATION"}
    try:
        fresh = adapter.pr_view(ctx.repo_root, pr, env=env)
        state.setdefault("github", {})["pr"] = dict(fresh)
    except Exception as exc:  # noqa: BLE001 — external liveness condition
        return {"ok": True, "status": "WAIT", "reason": f"could not refresh PR for CI fence: {exc}", "wait_reason": "CI_REVALIDATION"}
    current = fresh
    base = str(current.get("baseRefOid") or "").strip()
    if (
        str(current.get("state") or "").upper() != "OPEN"
        or str(current.get("headRefOid") or "").strip() != head
        or str(current.get("baseRefName") or "").strip() != base_ref
        or not _is_sha(base)
    ):
        return {"ok": True, "status": "WAIT", "reason": "PR HEAD/base/state drifted during CI fence", "wait_reason": "CI_REVALIDATION"}
    mergeable = str(current.get("mergeable") or "").upper()
    merge_state = str(current.get("mergeStateStatus") or "").upper()
    if mergeable != "MERGEABLE" or merge_state not in {"CLEAN", "HAS_HOOKS"}:
        return {"ok": True, "status": "WAIT", "reason": "PR is not currently mergeable for synthetic CI", "wait_reason": "CI_REVALIDATION"}
    resolved_base = adapter.live_base(ctx.repo_root, base_ref, env=env)
    if str(resolved_base).lower() != base.lower():
        return {"ok": True, "status": "WAIT", "reason": "remote base advanced during CI fence", "wait_reason": "CI_REVALIDATION"}

    old = current_base_ci_record(state)
    stream = str(state.get("stream_id") or store.stream_id)
    if old and current_base_ci_matches(old, pr=pr, head=head, base=base):
        branch_sha = _remote_branch_sha(adapter, ctx.repo_root, str(old.get("branch") or ""), env)
        if branch_sha is None and str(old.get("status") or "") not in {"PASS", "FAIL"}:
            return {"ok": True, "status": "WAIT", "reason": "owned current-base CI branch disappeared", "wait_reason": "CI_REVALIDATION"}
        if str(old.get("status") or "") in {"PASS", "FAIL"}:
            return {"ok": True, "status": old.get("status"), "record": old, "reused": True}
        observed = _observe_run(adapter, ctx.repo_root, old, env=env)
        updated = dict(old)
        updated.update(observed)
        _set_record(state, updated, store)
        return {"ok": True, "status": updated.get("status"), "record": updated, "reused": True}

    if old:
        cleanup = cleanup_ci_branch(adapter, ctx.repo_root, old, stream=stream, pr=pr, env=env)
        if not cleanup.get("ok"):
            return {"ok": True, "status": "WAIT", "reason": cleanup.get("reason"), "wait_reason": "CI_REVALIDATION"}
        state["current_base_ci"] = None

    resolved = resolve_synthetic_merge(
        adapter,
        ctx.repo_root,
        pr=pr,
        base=base,
        head=head,
        base_ref=base_ref,
        env=env,
    )
    if not resolved.get("ok"):
        return {"ok": True, "status": "WAIT", "reason": resolved.get("reason"), "wait_reason": "CI_REVALIDATION"}
    merge = str(resolved["synthetic_merge"])
    generation = synthetic_generation(pr=pr, head=head, base=base, synthetic_merge=merge)
    branch = ci_branch_name(stream, generation)
    record = _record(
        state=state,
        pr=pr,
        head=head,
        base=base,
        synthetic_merge=merge,
        generation=generation,
        branch=branch,
        source=str(resolved.get("source") or "unknown"),
    )
    remote = _remote_branch_sha(adapter, ctx.repo_root, branch, env)
    if remote and remote.lower() != merge.lower():
        return {"ok": True, "status": "WAIT", "reason": "owned CI branch has a conflicting object", "wait_reason": "CI_REVALIDATION"}
    if not remote:
        code, _, err = _git_text(
            adapter,
            ["push", "origin", f"{merge}:refs/heads/{branch}"],
            cwd=ctx.repo_root,
            env=env,
            timeout=120,
        )
        if code != 0:
            return {"ok": True, "status": "WAIT", "reason": err.strip() or "could not push exact current-base CI object", "wait_reason": "CI_REVALIDATION"}
        store.append_event(
            "current-base-ci-push",
            {"pr": pr, "stream": stream, "head": head, "base": base, "synthetic_merge": merge, "branch": branch, "generation": generation},
        )
    _set_record(state, record, store)
    observed = _observe_run(adapter, ctx.repo_root, record, env=env)
    record.update(observed)
    _set_record(state, record, store)
    return {"ok": True, "status": record.get("status"), "record": record, "pushed": not bool(remote), "reason": resolved.get("reason")}
