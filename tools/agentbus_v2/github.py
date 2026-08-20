from __future__ import annotations

from dataclasses import dataclass, replace
import json
from pathlib import Path
import re
from typing import Any
@dataclass(frozen=True)
class CheckFact:
    name: str
    state: str
    bucket: str
    workflow: str
    link: str
    run_id: str
    head_sha: str
    synthetic_merge_sha: str | None
    synthetic_parents: tuple[str, ...]
    pr_head_sha: str
    pr_base_sha: str
    current_integration: bool


@dataclass(frozen=True)
class GitHubFacts:
    available: bool = True
    pr_number: int | None = None
    state: str = "ABSENT"
    draft: bool | None = None
    mergeable: bool | None = None
    head_sha: str | None = None
    live_base: str | None = None
    pr_base_sha: str | None = None
    head_branch: str | None = None
    base_branch: str | None = None
    p_id: str | None = None
    spec_id: str | None = None
    owner_token: str | None = None
    merge_commit_sha: str | None = None
    merge_parents: tuple[str, ...] = ()
    check_status: str = "MISSING"
    checks: tuple[CheckFact, ...] = ()
    failed_ci_logs: tuple[tuple[str, str], ...] = ()
def _deps():
    from .facts import FactError, _run, canonical_repository, live_remote_sha

    return FactError, _run, canonical_repository, live_remote_sha
def github_slug(repository: str) -> str:
    FactError, _, canonical_repository, _ = _deps()
    canonical = canonical_repository(repository)
    prefix = "github.com/"
    if not canonical.startswith(prefix) or canonical.count("/") != 2:
        raise FactError(f"GitHub repository required, got {repository!r}")
    return canonical.removeprefix(prefix)
def _markers(body: str) -> dict[str, str]:
    prefixes = {
        "AgentBus-V2-P:": "p_id",
        "AgentBus-V2-Spec:": "spec_id",
        "AgentBus-V2-Owner:": "owner_token",
    }
    return {
        key: line.removeprefix(prefix).strip()
        for line in body.splitlines()
        for prefix, key in prefixes.items()
        if line.startswith(prefix)
    }
def _merge_parents(commit: str | None, slug: str) -> tuple[str, ...]:
    if not commit:
        return ()
    _, _run, _, _ = _deps()
    result = _run(("gh", "api", f"repos/{slug}/git/commits/{commit}"), check=False)
    try:
        value = json.loads(result.stdout)
        parents = value.get("parents", [])
        if result.returncode != 0 or not isinstance(parents, list):
            return ()
        return tuple(str(parent.get("sha", "")) for parent in parents)
    except (json.JSONDecodeError, AttributeError):
        return ()
def read_github_facts(config: PConfig) -> GitHubFacts:
    FactError, _run, _, live_remote_sha = _deps()
    slug = github_slug(config.repository)
    try:
        live_base = live_remote_sha(Path(config.worktree), config.remote, config.base_ref)
    except FactError:
        return GitHubFacts(available=False)
    completed = _run(
        (
            "gh", "pr", "list", "--repo", slug, "--head", config.branch,
            "--state", "all", "--limit", "20", "--json",
            "number,state,isDraft,mergeable,headRefName,headRefOid,"
            "baseRefName,baseRefOid,body,mergedAt,mergeCommit",
        ),
        check=False,
    )
    if completed.returncode != 0:
        return GitHubFacts(available=False, live_base=live_base)
    try:
        records = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return GitHubFacts(available=False, live_base=live_base)
    if not isinstance(records, list):
        return GitHubFacts(available=False, live_base=live_base)
    open_records = [item for item in records if isinstance(item, dict) and item.get("state") == "OPEN"]
    candidates = open_records or [
        item for item in records if isinstance(item, dict) and item.get("mergedAt")
    ]
    if not candidates:
        return GitHubFacts(live_base=live_base)
    if len(candidates) != 1:
        return GitHubFacts(available=False, live_base=live_base)
    record = candidates[0]
    marker = _markers(str(record.get("body", "")))
    raw_mergeable = str(record.get("mergeable", "UNKNOWN"))
    mergeable = True if raw_mergeable == "MERGEABLE" else False if raw_mergeable == "CONFLICTING" else None
    state = "MERGED" if record.get("mergedAt") else str(record.get("state", "UNKNOWN"))
    merge_value = record.get("mergeCommit")
    merge_commit = (
        str(merge_value.get("oid"))
        if isinstance(merge_value, dict) and merge_value.get("oid")
        else None
    )
    parents = _merge_parents(merge_commit, slug) if state == "MERGED" else ()
    if state == "MERGED" and merge_commit and len(parents) != 2:
        return GitHubFacts(available=False, live_base=live_base)
    draft_value = record.get("isDraft")
    draft = True if draft_value is True else False if draft_value is False else None
    try:
        pr_number = int(record["number"])
    except (KeyError, TypeError, ValueError):
        return GitHubFacts(available=False, live_base=live_base)
    return GitHubFacts(
        pr_number=pr_number,
        state=state,
        draft=draft,
        mergeable=mergeable,
        head_sha=str(record.get("headRefOid", "")),
        live_base=live_base,
        pr_base_sha=str(record.get("baseRefOid", "")),
        head_branch=str(record.get("headRefName", "")),
        base_branch=str(record.get("baseRefName", "")),
        p_id=marker.get("p_id"),
        spec_id=marker.get("spec_id"),
        owner_token=marker.get("owner_token"),
        merge_commit_sha=merge_commit,
        merge_parents=parents,
    )

def observe_required_checks(
    config: PConfig, facts: GitHubFacts, expected_head: str, expected_base: str
) -> GitHubFacts:
    if facts.pr_number is None:
        return replace(facts, check_status="MISSING")
    FactError, _run, _, _ = _deps()
    slug = github_slug(config.repository)
    completed = _run(
        (
            "gh", "pr", "checks", str(facts.pr_number), "--repo", slug,
            "--json", "name,state,bucket,workflow,link",
        ),
        check=False,
        timeout=60,
    )
    try:
        raw = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return replace(facts, check_status="MISSING", checks=())
    if completed.returncode != 0 or not isinstance(raw, list) or not raw:
        return replace(facts, check_status="MISSING", checks=())

    pr_result = _run(
        ("gh", "api", f"repos/{slug}/pulls/{facts.pr_number}"),
        check=False, timeout=60,
    )
    try:
        pr_data = json.loads(pr_result.stdout)
    except json.JSONDecodeError:
        pr_data = {}
    if not isinstance(pr_data, dict):
        pr_data = {}
    head_data = pr_data.get("head")
    base_data = pr_data.get("base")
    pr_head = str(head_data.get("sha", "")) if isinstance(head_data, dict) else ""
    pr_base = str(base_data.get("sha", "")) if isinstance(base_data, dict) else ""
    merge_sha = str(pr_data.get("merge_commit_sha") or "")
    parents = _merge_parents(merge_sha, slug)
    synthetic_ok = (
        pr_result.returncode == 0
        and pr_head == expected_head
        and pr_base == expected_base
        and len(parents) == 2
        and parents[0] == expected_base
        and parents[1] == expected_head
    )
    runs: dict[str, dict[str, Any]] = {}
    checks: list[CheckFact] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        link = str(item.get("link", ""))
        match = re.search(r"/actions/runs/(\d+)(?:/|$)", link)
        if not match:
            continue
        run_id = match.group(1)
        if run_id not in runs:
            run_result = _run(
                (
                    "gh", "run", "view", run_id, "--repo", slug, "--json",
                    "event,headSha",
                ),
                check=False, timeout=60,
            )
            try:
                run_data = json.loads(run_result.stdout)
            except json.JSONDecodeError:
                run_data = {}
            if not isinstance(run_data, dict):
                run_data = {}
            runs[run_id] = {
                "returncode": run_result.returncode,
                "event": run_data.get("event"),
                "head_sha": str(run_data.get("headSha", "")),
            }
        run = runs[run_id]
        current = (
            run["returncode"] == 0
            and run["event"] == "pull_request"
            and run["head_sha"] == expected_head
            and synthetic_ok
        )
        if not current:
            continue
        checks.append(CheckFact(
            name=str(item.get("name", "")),
            state=str(item.get("state", "")),
            bucket=str(item.get("bucket", "")),
            workflow=str(item.get("workflow", "")),
            link=link,
            run_id=run_id,
            head_sha=run["head_sha"],
            synthetic_merge_sha=merge_sha or None,
            synthetic_parents=parents,
            pr_head_sha=pr_head,
            pr_base_sha=pr_base,
            current_integration=True,
        ))
    checks.sort(key=lambda item: (item.workflow, item.name, item.link))
    if not checks:
        return replace(facts, check_status="MISSING", checks=())
    buckets = {item.bucket for item in checks}
    failed = buckets & {"fail", "cancel"}
    logs: list[tuple[str, str]] = []
    if failed:
        for run_id in sorted({item.run_id for item in checks if item.bucket in {"fail", "cancel"}}):
            result = _run(
                ("gh", "run", "view", run_id, "--repo", slug, "--log-failed"),
                check=False, timeout=180,
            )
            logs.append((run_id, result.stdout[-65536:]))
        return replace(facts, check_status="FAIL", checks=tuple(checks), failed_ci_logs=tuple(logs))
    for required in config.required_ci_checks:
        matches = [
            item for item in checks
            if item.name == required or f"{item.workflow} / {item.name}" == required
        ]
        if not matches:
            return replace(facts, check_status="MISSING", checks=tuple(checks))
        if any(item.bucket == "pending" for item in matches):
            return replace(facts, check_status="RUNNING", checks=tuple(checks))
        if any(item.bucket != "pass" for item in matches):
            return replace(facts, check_status="FAIL", checks=tuple(checks))
    status = "RUNNING" if "pending" in buckets else "PASS" if buckets <= {"pass", "skipping"} else "MISSING"
    return replace(facts, check_status=status, checks=tuple(checks), failed_ci_logs=tuple(logs))

def ensure_owned_pr(config: PConfig, spec: Any) -> bool:
    FactError, _run, _, _ = _deps()
    worktree = Path(config.worktree)
    pushed = _run(
        ("git", "push", "--set-upstream", config.remote, config.branch),
        cwd=worktree, check=False, timeout=120,
    )
    if pushed.returncode != 0:
        return False
    facts = read_github_facts(config)
    slug = github_slug(config.repository)
    body = f"""Standalone AgentBus v2 maintenance P.

AgentBus-V2-P: {config.p_id}
AgentBus-V2-Spec: {spec.spec_id}
AgentBus-V2-Owner: {config.owner_token}
"""
    if facts.pr_number is None:
        created = _run(
            (
                "gh", "pr", "create", "--repo", slug, "--base", config.base_ref,
                "--head", config.branch,
                "--title", f"{config.p_id}: implement current specification",
                "--body", body,
            ),
            cwd=worktree, check=False, timeout=120,
        )
        return created.returncode == 0
    if facts.p_id != config.p_id or facts.owner_token != config.owner_token:
        raise FactError("refusing to alter a PR not owned by this P")
    if facts.spec_id != spec.spec_id:
        updated = _run(
            (
                "gh", "api", "--method", "PATCH",
                f"repos/{slug}/pulls/{facts.pr_number}", "-f", f"body={body}",
            ),
            check=False,
        )
        return updated.returncode == 0
    return True


def merge_pr(config: PConfig, pr_number: int, expected_head: str, *, command_runner=None):
    _, _run, _, _ = _deps()
    runner = command_runner or _run
    return runner(
        (
            "gh", "pr", "merge", str(pr_number), "--repo", github_slug(config.repository),
            "--merge", "--match-head-commit", expected_head,
        ),
        cwd=Path(config.worktree), check=False, timeout=120,
    )
