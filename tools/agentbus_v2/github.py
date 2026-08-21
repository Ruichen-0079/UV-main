from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import json
from pathlib import Path
import re
from typing import Any, Iterable


OWNERSHIP_START = "<!-- AGENTBUS_V2_OWNERSHIP_START -->"
OWNERSHIP_END = "<!-- AGENTBUS_V2_OWNERSHIP_END -->"


class OwnershipMarkerError(ValueError):
    pass


@dataclass(frozen=True)
class ExistingPullRequest:
    number: int
    state: str
    draft: bool
    mergeable: bool | None
    head_sha: str
    head_branch: str
    head_repository: str
    base_sha: str
    base_branch: str
    base_repository: str
    body: str
    merged_at: str | None
    merge_commit_sha: str | None


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
def _marker_values(text: str) -> dict[str, str]:
    prefixes = {
        "AgentBus-V2-P:": "p_id",
        "AgentBus-V2-Spec:": "spec_id",
        "AgentBus-V2-Owner:": "owner_token",
    }
    values: dict[str, str] = {}
    for line in text.splitlines():
        recognized = False
        for prefix, key in prefixes.items():
            if not line.startswith(prefix):
                continue
            recognized = True
            value = line.removeprefix(prefix).strip()
            if not value or key in values:
                raise OwnershipMarkerError("AgentBus v2 ownership markers are partial or ambiguous")
            values[key] = value
        if line.startswith("AgentBus-V2-") and not recognized:
            raise OwnershipMarkerError("unknown AgentBus v2 ownership marker")
    return values


def _markers(body: str) -> dict[str, str]:
    starts = body.count(OWNERSHIP_START)
    ends = body.count(OWNERSHIP_END)
    if starts != ends or starts > 1:
        raise OwnershipMarkerError("AgentBus v2 ownership block is partial or ambiguous")
    if starts == 1:
        start = body.index(OWNERSHIP_START)
        end = body.index(OWNERSHIP_END)
        if end < start:
            raise OwnershipMarkerError("AgentBus v2 ownership block is malformed")
        before = body[:start]
        block = body[start + len(OWNERSHIP_START):end]
        after = body[end + len(OWNERSHIP_END):]
        if _marker_values(before) or _marker_values(after):
            raise OwnershipMarkerError("AgentBus v2 ownership markers occur outside their block")
        lines = [line for line in block.splitlines() if line.strip()]
        prefixes = ("AgentBus-V2-P:", "AgentBus-V2-Spec:", "AgentBus-V2-Owner:")
        if any(not line.startswith(prefixes) for line in lines):
            raise OwnershipMarkerError("AgentBus v2 ownership block contains unknown content")
        values = _marker_values(block)
    else:
        values = _marker_values(body)
    if values and not {"p_id", "owner_token"} <= set(values):
        raise OwnershipMarkerError("AgentBus v2 ownership markers are partial or ambiguous")
    return values


def render_ownership_block(p_id: str, owner_token: str, spec_id: str | None = None) -> str:
    if not p_id or not owner_token or spec_id == "":
        raise OwnershipMarkerError("AgentBus v2 ownership marker values must be non-empty")
    lines = [
        OWNERSHIP_START,
        f"AgentBus-V2-P: {p_id}",
        f"AgentBus-V2-Owner: {owner_token}",
    ]
    if spec_id is not None:
        lines.append(f"AgentBus-V2-Spec: {spec_id}")
    lines.append(OWNERSHIP_END)
    return "\n".join(lines)


def update_ownership_block(
    body: str, p_id: str, owner_token: str, spec_id: str | None = None
) -> str:
    markers = _markers(body)
    if markers and (
        markers.get("p_id") != p_id or markers.get("owner_token") != owner_token
    ):
        raise OwnershipMarkerError("refusing to replace foreign AgentBus v2 ownership")
    block = render_ownership_block(p_id, owner_token, spec_id)
    if OWNERSHIP_START in body:
        start = body.index(OWNERSHIP_START)
        end = body.index(OWNERSHIP_END, start) + len(OWNERSHIP_END)
        return body[:start] + block + body[end:]
    if markers:
        raise OwnershipMarkerError("legacy standalone ownership cannot be adopted implicitly")
    if not body:
        return block + "\n"
    separator = "\n" if body.endswith("\n") else "\n\n"
    return body + separator + block + "\n"


def _exact_pull_request(repository: str, pr_number: int) -> ExistingPullRequest:
    FactError, _run, canonical_repository, _ = _deps()
    from .facts import SHA_RE

    slug = github_slug(repository)
    completed = _run(
        ("gh", "api", f"repos/{slug}/pulls/{pr_number}"),
        check=False,
        timeout=60,
    )
    if completed.returncode != 0:
        raise FactError(f"GitHub PR #{pr_number} is unavailable in {slug}")
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise FactError(f"GitHub PR #{pr_number} returned malformed JSON") from error
    if not isinstance(value, dict) or type(value.get("number")) is not int:
        raise FactError(f"GitHub PR #{pr_number} response is malformed")
    if value["number"] != pr_number:
        raise FactError(f"GitHub PR number mismatch: expected {pr_number}, found {value['number']}")
    head = value.get("head")
    base = value.get("base")
    if not isinstance(head, dict) or not isinstance(base, dict):
        raise FactError(f"GitHub PR #{pr_number} branch identity is malformed")
    head_repo = head.get("repo")
    base_repo = base.get("repo")
    if not isinstance(head_repo, dict) or not isinstance(base_repo, dict):
        raise FactError(f"GitHub PR #{pr_number} repository identity is malformed")
    body = value.get("body")
    if body is None:
        body = ""
    if type(body) is not str:
        raise FactError(f"GitHub PR #{pr_number} body is malformed")
    state = value.get("state")
    draft = value.get("draft")
    if type(state) is not str or type(draft) is not bool:
        raise FactError(f"GitHub PR #{pr_number} state is malformed")
    head_sha = head.get("sha")
    base_sha = base.get("sha")
    head_branch = head.get("ref")
    base_branch = base.get("ref")
    head_name = head_repo.get("full_name")
    base_name = base_repo.get("full_name")
    if (
        type(head_sha) is not str or not SHA_RE.fullmatch(head_sha)
        or type(base_sha) is not str or not SHA_RE.fullmatch(base_sha)
        or type(head_branch) is not str or not head_branch
        or type(base_branch) is not str or not base_branch
        or type(head_name) is not str or not head_name
        or type(base_name) is not str or not base_name
    ):
        raise FactError(f"GitHub PR #{pr_number} identity is malformed")
    merged_at = value.get("merged_at")
    merge_sha = value.get("merge_commit_sha")
    raw_mergeable = value.get("mergeable")
    if merged_at is not None and type(merged_at) is not str:
        raise FactError(f"GitHub PR #{pr_number} merge state is malformed")
    if merge_sha is not None and (
        type(merge_sha) is not str or not SHA_RE.fullmatch(merge_sha)
    ):
        raise FactError(f"GitHub PR #{pr_number} merge commit is malformed")
    if raw_mergeable is not None and type(raw_mergeable) is not bool:
        raise FactError(f"GitHub PR #{pr_number} mergeability is malformed")
    return ExistingPullRequest(
        number=pr_number,
        state="MERGED" if merged_at else state.upper(),
        draft=draft,
        mergeable=raw_mergeable if type(raw_mergeable) is bool else None,
        head_sha=head_sha,
        head_branch=head_branch,
        head_repository=canonical_repository(f"github.com/{head_name}"),
        base_sha=base_sha,
        base_branch=base_branch,
        base_repository=canonical_repository(f"github.com/{base_name}"),
        body=body,
        merged_at=str(merged_at) if merged_at else None,
        merge_commit_sha=str(merge_sha) if merge_sha else None,
    )


def _require_adopted_record(config: PConfig, record: ExistingPullRequest, *, seed: bool) -> None:
    FactError, _, canonical_repository, _ = _deps()
    adopted = config.adopted_pr
    if adopted is None:
        raise FactError("P config is not an adopted PR")
    repository = canonical_repository(config.repository)
    if record.number != adopted.number:
        raise FactError("adopted PR number drifted")
    if record.state != "OPEN":
        raise FactError("adopted PR is not open")
    if record.head_repository != repository or record.base_repository != repository:
        raise FactError("fork PR adoption is not supported")
    if record.head_branch != config.branch or record.head_branch != adopted.head_branch:
        raise FactError("adopted PR head branch drifted")
    if record.base_branch != config.base_ref or record.base_branch != adopted.base_branch:
        raise FactError("adopted PR base branch drifted")
    if seed and record.head_sha != adopted.seed_head_sha:
        raise FactError("adopted PR HEAD drifted during initialization")


def _validate_registry_claims(state_root: Path, config: PConfig, path: Path | None) -> None:
    from .facts import FactError, load_config, paths_for
    from .scheduler import load_registry, registry_path

    source = Path(path) if path is not None else registry_path(state_root)
    if not source.exists():
        return
    registry = load_registry(state_root, source, validate=False)
    worktree = Path(config.worktree).resolve()
    for entry in registry.entries:
        other_paths = paths_for(state_root, entry.p_id)
        try:
            other = load_config(other_paths)
        except FactError as error:
            raise FactError(
                f"registered P {entry.p_id} has no valid immutable config"
            ) from error
        if entry.p_id == config.p_id:
            if asdict(other) != asdict(config):
                raise FactError(f"registered P_ID {entry.p_id} has conflicting facts")
            if entry.enabled:
                raise FactError("an adopted P must remain disabled until ownership converges")
            continue
        if Path(other.worktree).resolve() == worktree:
            raise FactError(f"registered P {entry.p_id} already claims this worktree")
        if other.repository == config.repository and other.branch == config.branch:
            raise FactError(f"registered P {entry.p_id} already claims this branch")
        if (
            other.adopted_pr is not None
            and config.adopted_pr is not None
            and other.repository == config.repository
            and other.adopted_pr.number == config.adopted_pr.number
        ):
            raise FactError(f"registered P {entry.p_id} already claims this PR")


def _claim_adopted_pr(config: PConfig) -> None:
    FactError, _run, _, _ = _deps()
    adopted = config.adopted_pr
    if adopted is None:
        raise FactError("P config is not an adopted PR")
    record = _exact_pull_request(config.repository, adopted.number)
    _require_adopted_record(config, record, seed=True)
    try:
        markers = _markers(record.body)
    except OwnershipMarkerError as error:
        raise FactError(str(error)) from error
    if markers and (
        markers.get("p_id") != config.p_id
        or markers.get("owner_token") != config.owner_token
    ):
        raise FactError("refusing to claim a PR owned by another AgentBus v2 P")
    if markers.get("spec_id") is not None:
        raise FactError("initial adopted PR ownership must not contain a SPEC marker")
    try:
        updated_body = update_ownership_block(
            record.body, config.p_id, config.owner_token
        )
    except OwnershipMarkerError as error:
        raise FactError(str(error)) from error
    if updated_body != record.body:
        slug = github_slug(config.repository)
        updated = _run(
            (
                "gh", "api", "--method", "PATCH",
                f"repos/{slug}/pulls/{adopted.number}", "-f", f"body={updated_body}",
            ),
            check=False,
            timeout=120,
        )
        if updated.returncode != 0:
            raise FactError("adopted PR ownership claim did not reach GitHub")
    converged = _exact_pull_request(config.repository, adopted.number)
    _require_adopted_record(config, converged, seed=True)
    try:
        final_markers = _markers(converged.body)
    except OwnershipMarkerError as error:
        raise FactError(str(error)) from error
    if (
        final_markers.get("p_id") != config.p_id
        or final_markers.get("owner_token") != config.owner_token
        or final_markers.get("spec_id") is not None
    ):
        raise FactError("adopted PR ownership did not converge")


def adopt_existing_pr(
    state_root: Path,
    *,
    p_id: str,
    charter_text: str,
    worktree: Path,
    repository: str,
    pr_number: int,
    branch: str,
    base_ref: str = "main",
    remote: str = "origin",
    proof_commands: Iterable[tuple[str, ...]] = (),
    required_ci_checks: Iterable[str] = (),
    registry: Path | None = None,
) -> PPaths:
    """Claim one exact existing same-repository PR as a fresh v2 P."""
    from .facts import (
        AdoptedPr,
        FactError,
        PConfig,
        SHA_RE,
        canonical_repository,
        git,
        init_adopted_p_facts,
        live_remote_sha,
        paths_for,
        sha256_text,
    )

    if type(pr_number) is not int or pr_number <= 0:
        raise FactError("adopted PR number must be a positive integer")
    worktree = Path(worktree).resolve()
    if not worktree.exists():
        raise FactError(f"adoption worktree does not exist: {worktree}")
    actual_root = Path(git(worktree, "rev-parse", "--show-toplevel")).resolve()
    if actual_root != worktree:
        raise FactError(f"worktree must be its Git root: {worktree}")
    actual_branch = git(worktree, "branch", "--show-current")
    if actual_branch != branch:
        raise FactError(f"branch mismatch: expected {branch}, found {actual_branch}")
    expected_repository = canonical_repository(repository)
    actual_repository = canonical_repository(git(worktree, "remote", "get-url", remote))
    if actual_repository != expected_repository:
        raise FactError(
            f"repository mismatch: expected {expected_repository}, found {actual_repository}"
        )
    if git(worktree, "status", "--porcelain=v1"):
        raise FactError("P adoption requires a clean dedicated worktree")
    local_head = git(worktree, "rev-parse", "HEAD")
    if not SHA_RE.fullmatch(local_head):
        raise FactError("local adoption HEAD is malformed")
    record = _exact_pull_request(expected_repository, pr_number)
    if record.state != "OPEN":
        raise FactError("only an open PR can be adopted")
    if (
        record.head_repository != expected_repository
        or record.base_repository != expected_repository
    ):
        raise FactError("fork PR adoption is not supported")
    if record.head_branch != branch:
        raise FactError("PR head branch does not match the requested branch")
    if record.base_branch != base_ref:
        raise FactError("PR base branch does not match the requested base")
    if record.head_sha != local_head:
        raise FactError("local HEAD does not match the exact PR HEAD")
    remote_head = live_remote_sha(worktree, remote, branch)
    if remote_head != local_head:
        raise FactError("remote branch, PR HEAD, and local HEAD do not match")
    observed_base = live_remote_sha(worktree, remote, base_ref)
    adopted = AdoptedPr(
        number=pr_number,
        seed_head_sha=local_head,
        head_branch=branch,
        base_branch=base_ref,
        observed_base_sha=observed_base,
    )
    commands = tuple(tuple(str(arg) for arg in command) for command in proof_commands)
    checks = tuple(str(check) for check in required_ci_checks)
    charter = charter_text.replace("\r\n", "\n").strip() + "\n"
    desired = PConfig(
        p_id=p_id,
        worktree=str(worktree),
        repository=expected_repository,
        remote=remote,
        branch=branch,
        base_ref=base_ref,
        seed_head=local_head,
        charter_digest=sha256_text(charter),
        proof_commands=commands,
        required_ci_checks=checks,
        adopted_pr=adopted,
    )
    paths = paths_for(state_root, p_id)
    try:
        markers = _markers(record.body)
    except OwnershipMarkerError as error:
        raise FactError(str(error)) from error
    if not (paths.root / "config.json").exists() and markers:
        raise FactError("new adoption cannot reuse pre-existing AgentBus v2 ownership")
    if markers and (
        markers.get("p_id") != p_id
        or markers.get("owner_token") != desired.owner_token
    ):
        raise FactError("refusing to claim a PR owned by another AgentBus v2 P")
    if markers.get("spec_id") is not None:
        raise FactError("initial adopted PR ownership must not contain a SPEC marker")
    _validate_registry_claims(Path(state_root).resolve(), desired, registry)
    paths = init_adopted_p_facts(
        state_root,
        p_id=p_id,
        charter_text=charter,
        worktree=worktree,
        repository=expected_repository,
        branch=branch,
        adopted_pr=adopted,
        base_ref=base_ref,
        remote=remote,
        proof_commands=commands,
        required_ci_checks=checks,
    )
    _claim_adopted_pr(desired)
    return paths
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
    FactError, _run, canonical_repository, live_remote_sha = _deps()
    slug = github_slug(config.repository)
    try:
        live_base = live_remote_sha(Path(config.worktree), config.remote, config.base_ref)
    except FactError:
        return GitHubFacts(available=False)
    if config.adopted_pr is not None:
        try:
            record = _exact_pull_request(config.repository, config.adopted_pr.number)
            marker = _markers(record.body)
        except (FactError, OwnershipMarkerError):
            return GitHubFacts(available=False, live_base=live_base)
        repository = canonical_repository(config.repository)
        if (
            record.number != config.adopted_pr.number
            or record.head_repository != repository
            or record.base_repository != repository
            or record.head_branch != config.branch
            or record.base_branch != config.base_ref
        ):
            return GitHubFacts(available=False, live_base=live_base)
        parents = (
            _merge_parents(record.merge_commit_sha, slug)
            if record.state == "MERGED" else ()
        )
        if record.state == "MERGED" and record.merge_commit_sha and len(parents) != 2:
            return GitHubFacts(available=False, live_base=live_base)
        return GitHubFacts(
            pr_number=record.number,
            state=record.state,
            draft=record.draft,
            mergeable=record.mergeable,
            head_sha=record.head_sha,
            live_base=live_base,
            pr_base_sha=record.base_sha,
            head_branch=record.head_branch,
            base_branch=record.base_branch,
            p_id=marker.get("p_id"),
            spec_id=marker.get("spec_id"),
            owner_token=marker.get("owner_token"),
            merge_commit_sha=(
                record.merge_commit_sha if record.state == "MERGED" else None
            ),
            merge_parents=parents,
        )
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
    try:
        marker = _markers(str(record.get("body", "")))
    except OwnershipMarkerError:
        return GitHubFacts(available=False, live_base=live_base)
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
    FactError, _run, _, live_remote_sha = _deps()
    worktree = Path(config.worktree)
    if config.adopted_pr is not None:
        before_push = _exact_pull_request(config.repository, config.adopted_pr.number)
        _require_adopted_record(config, before_push, seed=False)
        try:
            before_markers = _markers(before_push.body)
        except OwnershipMarkerError as error:
            raise FactError(str(error)) from error
        if (
            before_markers.get("p_id") != config.p_id
            or before_markers.get("owner_token") != config.owner_token
        ):
            raise FactError("refusing to push an adopted PR not owned by this P")
    pushed = _run(
        ("git", "push", "--set-upstream", config.remote, config.branch),
        cwd=worktree, check=False, timeout=120,
    )
    if pushed.returncode != 0:
        return False
    slug = github_slug(config.repository)
    if config.adopted_pr is not None:
        record = _exact_pull_request(config.repository, config.adopted_pr.number)
        _require_adopted_record(config, record, seed=False)
        local_head = _run(
            ("git", "rev-parse", "HEAD"), cwd=worktree, check=False
        ).stdout.strip()
        remote_head = live_remote_sha(worktree, config.remote, config.branch)
        if record.head_sha != local_head or remote_head != local_head:
            return False
        try:
            markers = _markers(record.body)
        except OwnershipMarkerError as error:
            raise FactError(str(error)) from error
        if markers != before_markers:
            if (
                markers.get("p_id") != config.p_id
                or markers.get("owner_token") != config.owner_token
            ):
                raise FactError("adopted PR ownership drifted during push")
        if (
            markers.get("p_id") != config.p_id
            or markers.get("owner_token") != config.owner_token
        ):
            raise FactError("refusing to alter an adopted PR not owned by this P")
        try:
            body = update_ownership_block(
                record.body, config.p_id, config.owner_token, spec.spec_id
            )
        except OwnershipMarkerError as error:
            raise FactError(str(error)) from error
        if body == record.body:
            return True
        updated = _run(
            (
                "gh", "api", "--method", "PATCH",
                f"repos/{slug}/pulls/{config.adopted_pr.number}",
                "-f", f"body={body}",
            ),
            check=False,
        )
        return updated.returncode == 0
    facts = read_github_facts(config)
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
