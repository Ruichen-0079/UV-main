"""Effect adapters for the fact-recomputed AgentBus v2 kernel."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any, Callable, Mapping, Sequence

from .core import (
    Action,
    ActionKind,
    GPT_PACKET_SCHEMA,
    Observation,
    Snapshot,
    SpecFact,
    decide,
    plan_facts_digest,
    stable_id,
)
from .facts import (
    FactError,
    GPT_JOB_RE,
    PConfig,
    PPaths,
    _load_json,
    _run,
    _work_from_head,
    git,
    github_slug,
    load_charter,
    load_gpt_packet,
    load_config,
    parse_gpt_response,
    read_merge_facts,
    read_snapshot,
    sha256_text,
    gpt_response_schema,
    write_json_once,
    write_text_once,
)


@dataclass(frozen=True)
class EffectResult:
    ran: bool
    outcome: str
    detail: str = ""
    path: Path | None = None


def _spec(snapshot: Snapshot, spec_id: str | None) -> SpecFact | None:
    matches = [item for item in snapshot.specs if item.spec_id == spec_id]
    if len(matches) > 1:
        raise FactError(f"multiple SPEC facts for {spec_id}")
    return matches[0] if matches else None


def _repository_diff(config: PConfig, snapshot: Snapshot) -> str:
    worktree = Path(config.worktree)
    diff = git(
        worktree,
        "diff",
        "--no-ext-diff",
        "--no-color",
        f"{snapshot.base}...{snapshot.head}",
    )
    return f"## CURRENT-BASE DIFF\n\n```diff\n{diff}\n```"


def _evidence_text(paths: PPaths, evidence_id: str) -> str:
    candidates = [
        paths.work_results / f"{evidence_id}.json",
        paths.proof_results / f"{evidence_id}.json",
        paths.proof_partials / f"{evidence_id}.json",
        paths.work_logs / f"{evidence_id}.response.json",
        paths.work_logs / f"{evidence_id}.codex.log",
    ] + sorted(paths.proof_logs.glob(f"{evidence_id}.*"))
    pieces: list[str] = []
    for path in candidates:
        if not path.exists():
            continue
        value = path.read_text(encoding="utf-8", errors="replace")
        marker = f"\n[full SHA-256 {sha256_text(value)}]" if len(value) > 65536 else ""
        pieces.append(f"FILE: {path.name}\n{value[-65536:].rstrip()}{marker}")
    return "\n\n".join(pieces) or "No additional evidence payload was found."


def render_gpt_prompt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> str:
    if action.kind not in {ActionKind.PLAN, ActionKind.JUDGE} or not action.effect_id:
        raise FactError("not a GPT effect")
    operation = "PLAN_GPT" if action.kind is ActionKind.PLAN else "JUDGE_GPT"
    charter = load_charter(paths, config)
    parent = _spec(snapshot, action.payload.get("parent_spec_id"))
    current = _spec(snapshot, action.payload.get("spec_id")) or parent
    planning_digest = plan_facts_digest(snapshot)
    semantic: dict[str, Any] = {
        "packet_schema": GPT_PACKET_SCHEMA, "job_id": action.effect_id,
        "p_id": config.p_id, "operation": operation,
        "charter_digest": config.charter_digest, "repository": config.repository,
        "branch": config.branch, "base_ref": config.base_ref,
        "head": snapshot.head, "base": snapshot.base,
        "parent_spec_id": parent.spec_id if parent else None,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "planning_facts_digest": planning_digest,
    }
    if operation == "JUDGE_GPT":
        semantic.update({
            "spec_id": action.payload["spec_id"],
            "spec_content_digest": stable_id("spec-text", {"text": current.text if current else ""}),
            "failed_step": action.payload["failed_step"],
            "evidence_id": action.payload["evidence_id"],
            "evidence_digest": action.payload["evidence_digest"],
            "trigger_judge_id": action.payload.get("trigger_judge_id")
            if action.payload.get("trigger_judge_id") is not None
            else current.trigger_judge_id if current else None,
        })
    prior = "NONE"
    trigger = semantic.get("trigger_judge_id")
    if trigger:
        matches = [item for item in snapshot.gpt_results if item.job_id == trigger]
        if len(matches) == 1:
            prior = json.dumps(asdict(matches[0]), indent=2, ensure_ascii=False)
    spec_block = current.text if current else "NONE (PLAN_GPT must create CURRENT_SPEC)"
    evidence = _evidence_text(paths, str(semantic["evidence_id"])) if operation == "JUDGE_GPT" else "No prior evidence; use the exact repository diff below."
    packet = f"""# AGENTBUS V2 SELF-CONTAINED GPT PACKET

JOB_ID: {action.effect_id}
OPERATION: {operation}
P_ID: {config.p_id}

## SEMANTIC INPUTS
```json
{json.dumps({"packet_schema": GPT_PACKET_SCHEMA, "job_id": action.effect_id, "operation": operation, "semantic_input": semantic}, sort_keys=True, separators=(",", ":"))}
```

## P_CHARTER (immutable)

{charter.rstrip()}

## CURRENT_SPEC

{spec_block}

{_repository_diff(config, snapshot)}

## PREVIOUS RELEVANT JUDGE RESULT

```json
{prior}
```

## CURRENT EVIDENCE

```text
{evidence}
```

## SEMANTIC RULES

Only PLAN, WORK, PROVE, and MERGE exist. ABSENT is not a judgment. Corrections
are RETURN_PLAN, RETURN_WORK, or RETURN_PROVE; GPT cannot bypass proof or merge
fences. Base the decision only on this packet.

## STRICT RESPONSE SCHEMA

{gpt_response_schema(operation, action.effect_id)}
"""
    return packet


def dispatch_manual_gpt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> EffectResult:
    packet = render_gpt_prompt(paths, config, snapshot, action)
    prompt_path = paths.gpt_outbox / f"{action.effect_id}.md"
    created = write_text_once(prompt_path, packet)
    return EffectResult(
        created,
        "MANUAL_GPT_REQUIRED",
        detail=f"JOB_ID={action.effect_id} SHA256={sha256_text(packet)}",
        path=prompt_path,
    )


def submit_gpt_response(paths: PPaths, response_path: Path) -> EffectResult:
    value = _load_json(response_path)
    job_id = value.get("job_id")
    if type(job_id) is not str or not GPT_JOB_RE.fullmatch(job_id):
        raise FactError("GPT response does not contain a valid generated JOB_ID")
    packet = load_gpt_packet(paths, job_id)
    result = parse_gpt_response(job_id, str(packet["operation"]), value)
    destination = paths.gpt_results / f"{result.job_id}.json"
    created = write_json_once(destination, asdict(result))
    return EffectResult(created, "GPT_RESULT_INGESTED", path=destination)


def _work_prompt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action, spec: SpecFact
) -> str:
    trigger = action.payload.get("trigger_judge_id")
    direction = "NONE"
    if trigger:
        matches = [item for item in snapshot.gpt_results if item.job_id == trigger]
        if len(matches) == 1:
            direction = matches[0].body
    trigger_trailer = f"\nAgentBus-V2-Trigger: {trigger}" if trigger else ""
    trailers = f"""AgentBus-V2-P: {config.p_id}
AgentBus-V2-Spec: {spec.spec_id}
AgentBus-V2-Work: {action.effect_id}
AgentBus-V2-Input-Head: {snapshot.head}{trigger_trailer}"""
    return f"""Implement this AgentBus v2 WORK job in the current repository.

P_CHARTER:
{load_charter(paths, config).rstrip()}

CURRENT_SPEC:
{spec.text}

RETURN_WORK direction, if any:
{direction}

Exact identities:
- P: {config.p_id}
- repository: {config.repository}
- branch: {config.branch}
- input HEAD: {snapshot.head}
- live BASE: {snapshot.base}
- WORK effect: {action.effect_id}

Inspect the repository, implement only the approved scope, and validate in
proportion to the change. Do not modify AgentBus v1, AgentBus v2, the Browser
Bridge, P6 proactive code, or any other worktree. Do not merge. Finish with a
clean worktree and a new commit descended from input HEAD. The final commit
message must contain these exact trailers:

{trailers}

Return only the JSON required by the supplied output schema. Use PASS only when
the committed implementation is complete; otherwise return a durable FAIL with
the exact blocker. An executor/process crash is not FAIL.
"""


CODEX_OUTPUT_SCHEMA = (
    '{"type":"object","additionalProperties":false,"properties":'
    '{"status":{"enum":["PASS","FAIL"]},"summary":{"type":"string"},'
    '"head":{"type":"string"},"evidence":{"type":"array","items":{"type":"string"}}},'
    '"required":["status","summary","head","evidence"]}\n'
)


def _local_branch_refs(worktree: Path) -> dict[str, str]:
    lines = git(
        worktree,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
    ).splitlines()
    return dict(line.split(" ", 1) for line in lines if " " in line)


def run_codex_work(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> EffectResult:
    if action.kind is not ActionKind.WORK or not action.effect_id:
        raise FactError("not a WORK effect")
    spec = _spec(snapshot, str(action.payload.get("spec_id")))
    if spec is None:
        raise FactError("WORK effect references an absent SPEC")
    prompt = _work_prompt(paths, config, snapshot, action, spec)
    # The per-P flock held by cli.tick_once is the only local exclusion. A
    # fresh fact read here prevents a queued effect from running against stale
    # semantic identities, while a crash simply leaves WORK ABSENT unless its
    # commit trailers can be recovered on the next tick.
    fresh = read_snapshot(paths)
    recalculated = decide(fresh)
    if (
        recalculated.kind is not ActionKind.WORK
        or recalculated.effect_id != action.effect_id
        or dict(recalculated.payload) != dict(action.payload)
    ):
        return EffectResult(False, "WORK_ABSENT", "WORK identities drifted before Codex")
    if git(Path(config.worktree), "status", "--porcelain=v1"):
        raise FactError("refusing to launch Codex in a dirty WORK worktree")
    worktree = Path(config.worktree)
    protected_refs = _local_branch_refs(worktree)
    common_git = Path(git(worktree, "rev-parse", "--git-common-dir"))
    if not common_git.is_absolute():
        common_git = (worktree / common_git).resolve()
    response_path = paths.work_logs / f"{action.effect_id}.response.json"
    log_path = paths.work_logs / f"{action.effect_id}.codex.log"
    response_path.unlink(missing_ok=True)
    schema = tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False)
    schema_path = Path(schema.name)
    try:
        schema.write(CODEX_OUTPUT_SCHEMA)
        schema.close()
        command = (
            "codex", "exec", "--ephemeral", "--approve-for-me", "-C", config.worktree,
            "--add-dir", str(common_git), "--output-schema", str(schema_path),
            "--output-last-message", str(response_path), "-",
        )
        try:
            completed = subprocess.run(
                command, input=prompt, text=True, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, check=False, timeout=7200,
            )
        except subprocess.TimeoutExpired as error:
            output = error.stdout if isinstance(error.stdout, str) else ""
            log_path.write_text(output[-262144:], encoding="utf-8", errors="replace")
            return EffectResult(False, "WORK_ABSENT", "Codex exceeded the executor timeout", log_path)
    finally:
        schema.close()
        schema_path.unlink(missing_ok=True)
    log_path.write_text(completed.stdout[-262144:], encoding="utf-8", errors="replace")
    if completed.returncode != 0 or not response_path.exists():
        return EffectResult(False, "WORK_ABSENT", "Codex exited without a durable result", log_path)
    try:
        response = _load_json(response_path)
        if set(response) != {"status", "summary", "head", "evidence"}:
            raise FactError("Codex response has unexpected fields")
        if (
            type(response["status"]) is not str
            or type(response["summary"]) is not str
            or type(response["head"]) is not str
            or not isinstance(response["evidence"], list)
            or any(type(item) is not str for item in response["evidence"])
            or not response["summary"].strip()
        ):
            raise FactError("Codex response fields have invalid types or are empty")
        status = Observation(response["status"])
    except (FactError, ValueError) as error:
        return EffectResult(False, "WORK_ABSENT", f"invalid Codex result: {error}", response_path)
    live_head = git(worktree, "rev-parse", "HEAD")
    summary = response["summary"]
    current_refs = _local_branch_refs(worktree)
    changed_refs = {
        name
        for name in set(protected_refs) | set(current_refs)
        if protected_refs.get(name) != current_refs.get(name)
    }
    allowed_ref = f"refs/heads/{config.branch}"
    if changed_refs - {allowed_ref}:
        raise FactError(
            "Codex altered protected local refs: "
            + ", ".join(sorted(changed_refs - {allowed_ref}))
        )
    if git(worktree, "status", "--porcelain=v1"):
        raise FactError("Codex completed with a dirty WORK worktree")
    if status is Observation.PASS:
        recovered = _work_from_head(config, live_head)
        if (
            recovered is None
            or recovered.effect_id != action.effect_id
            or recovered.spec_id != spec.spec_id
            or recovered.input_head != snapshot.head
            or response["head"] != live_head
        ):
            raise FactError(
                "Codex claimed PASS without the exact committed WORK identity trailers"
            )
        # The commit is the durable PASS fact. The response remains in the
        # bounded executor log for diagnosis but is not persisted as a WORK
        # result artifact.
        return EffectResult(True, "WORK_PASS", summary)
    if live_head != snapshot.head or changed_refs or response["head"] != live_head:
        raise FactError("Codex returned FAIL after changing repository HEAD")
    evidence = {
        "codex_response": response,
        "codex_log_sha256": sha256_text(completed.stdout),
        "live_head": live_head,
    }
    result = {
        "effect_id": action.effect_id,
        "spec_id": spec.spec_id,
        "input_head": snapshot.head,
        "status": Observation.FAIL.value,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "evidence_digest": sha256_text(json.dumps(evidence, sort_keys=True)),
    }
    destination = paths.work_results / f"{action.effect_id}.json"
    write_json_once(destination, result)
    return EffectResult(True, "WORK_FAIL", summary, destination)


def _owned_pr_body(config: PConfig, spec: SpecFact) -> str:
    return f"""Standalone AgentBus v2 maintenance P.

AgentBus-V2-P: {config.p_id}
AgentBus-V2-Spec: {spec.spec_id}
AgentBus-V2-Owner: {config.owner_token}

This PR is never auto-merged during Experiment 1.
"""


def ensure_owned_pr(config: PConfig, snapshot: Snapshot, spec: SpecFact) -> bool:
    worktree = Path(config.worktree)
    pushed = _run(
        ("git", "push", "--set-upstream", config.remote, config.branch),
        cwd=worktree,
        check=False,
        timeout=120,
    )
    if pushed.returncode != 0:
        return False
    merge = read_merge_facts(config)
    slug = github_slug(config.repository)
    body = _owned_pr_body(config, spec)
    if merge.pr_number is None:
        created = _run(
            (
                "gh",
                "pr",
                "create",
                "--repo",
                slug,
                "--base",
                config.base_ref,
                "--head",
                config.branch,
                "--title",
                f"{config.p_id}: implement current specification",
                "--body",
                body,
            ),
            cwd=worktree,
            check=False,
            timeout=120,
        )
        return created.returncode == 0
    if merge.p_id != config.p_id or merge.owner_token != config.owner_token:
        raise FactError("refusing to alter a PR not owned by this P")
    if merge.spec_id != spec.spec_id:
        updated = _run(
            (
                "gh",
                "api",
                "--method",
                "PATCH",
                f"repos/{slug}/pulls/{merge.pr_number}",
                "-f",
                f"body={body}",
            ),
            check=False,
        )
        return updated.returncode == 0
    return True


def _command_evidence(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> tuple[dict[str, Any], bool]:
    worktree = Path(config.worktree)
    commands = [
        ("git-diff-check", ("git", "diff", "--check", f"{snapshot.base}...{snapshot.head}")),
        ("merge-tree", ("git", "merge-tree", "--write-tree", snapshot.base, snapshot.head)),
        *((item.name, item.argv) for item in config.proof_commands),
    ]
    status_text = git(worktree, "status", "--porcelain=v1")
    status_log = paths.proof_logs / f"{action.effect_id}.00.clean-worktree.log"
    status_log.write_text(status_text, encoding="utf-8")
    records: list[dict[str, Any]] = [
        {
            "name": "clean-worktree",
            "argv": ["git", "status", "--porcelain=v1"],
            "exit_code": 1 if status_text else 0,
            "output_digest": sha256_text(status_text),
        }
    ]
    if status_text:
        value = {
            "effect_id": action.effect_id,
            "spec_id": action.payload["spec_id"],
            "head": snapshot.head,
            "base": snapshot.base,
            "trigger_judge_id": action.payload.get("trigger_judge_id"),
            "commands": records,
        }
        return value, False
    passed = True
    for index, (name, argv) in enumerate(commands, start=1):
        completed = _run(argv, cwd=worktree, check=False, timeout=1800)
        log = completed.stdout + ("\nSTDERR:\n" + completed.stderr if completed.stderr else "")
        log_path = paths.proof_logs / f"{action.effect_id}.{index:02d}.{name}.log"
        log_path.write_text(log, encoding="utf-8", errors="replace")
        records.append(
            {
                "name": name,
                "argv": list(argv),
                "exit_code": completed.returncode,
                "output_digest": sha256_text(log),
            }
        )
        if completed.returncode != 0:
            passed = False
            break
    if passed:
        after = git(worktree, "status", "--porcelain=v1")
        log_path = paths.proof_logs / f"{action.effect_id}.{len(records):02d}.clean-worktree-after.log"
        log_path.write_text(after, encoding="utf-8")
        records.append(
            {
                "name": "clean-worktree-after",
                "argv": ["git", "status", "--porcelain=v1"],
                "exit_code": 1 if after else 0,
                "output_digest": sha256_text(after),
            }
        )
        passed = not after
    value = {
        "effect_id": action.effect_id,
        "spec_id": action.payload["spec_id"],
        "head": snapshot.head,
        "base": snapshot.base,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "commands": records,
    }
    return value, passed


def _validate_partial(
    paths: PPaths,
    config: PConfig,
    snapshot: Snapshot,
    action: Action,
    value: Mapping[str, Any],
) -> bool:
    if set(value) != {
        "effect_id",
        "spec_id",
        "head",
        "base",
        "trigger_judge_id",
        "commands",
    }:
        raise FactError("PROVE partial has unexpected fields")
    expected_identity = {
        "effect_id": action.effect_id,
        "spec_id": action.payload["spec_id"],
        "head": snapshot.head,
        "base": snapshot.base,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
    }
    if any(value.get(key) != expected for key, expected in expected_identity.items()):
        raise FactError("PROVE partial identity mismatch")
    commands = value.get("commands")
    if not isinstance(commands, list) or not commands:
        raise FactError("PROVE partial command evidence is absent")
    expected_commands = [
        ("clean-worktree", ["git", "status", "--porcelain=v1"]),
        ("git-diff-check", ["git", "diff", "--check", f"{snapshot.base}...{snapshot.head}"]),
        ("merge-tree", ["git", "merge-tree", "--write-tree", snapshot.base, snapshot.head]),
        *((item.name, list(item.argv)) for item in config.proof_commands),
        ("clean-worktree-after", ["git", "status", "--porcelain=v1"]),
    ]
    for index, item in enumerate(commands):
        if not isinstance(item, dict) or set(item) != {
            "name",
            "argv",
            "exit_code",
            "output_digest",
        }:
            raise FactError("invalid PROVE command evidence")
        if index >= len(expected_commands) or (item["name"], item["argv"]) != expected_commands[index]:
            raise FactError("PROVE command contract mismatch")
        log_path = paths.proof_logs / f"{action.effect_id}.{index:02d}.{item['name']}.log"
        if not log_path.exists() or sha256_text(
            log_path.read_text(encoding="utf-8", errors="replace")
        ) != item["output_digest"]:
            raise FactError("PROVE command log digest mismatch")
    if all(int(item["exit_code"]) == 0 for item in commands) and len(commands) != len(
        expected_commands
    ):
        raise FactError("passing PROVE partial omitted required commands")
    return all(int(item["exit_code"]) == 0 for item in commands)


def _ci_checks(
    config: PConfig, pr_number: int, expected_head: str, expected_base: str
) -> tuple[str, list[dict[str, Any]], dict[str, str]]:
    completed = _run(
        (
            "gh",
            "pr",
            "checks",
            str(pr_number),
            "--repo",
            github_slug(config.repository),
            "--json",
            "name,state,bucket,workflow,link",
        ),
        check=False,
        timeout=60,
    )
    try:
        raw = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return "ABSENT", [], {}
    if not isinstance(raw, list) or not raw:
        return "ABSENT", [], {}
    slug = github_slug(config.repository)
    # A pull_request Actions run reports the branch head in `headSha`, not the
    # synthetic merge commit that was tested against the live base.  Bind the
    # evidence to the PR's current merge commit and its exact first-parent
    # relationship instead of guessing that run.headSha is that merge commit.
    pr_result = _run(
        ("gh", "api", f"repos/{slug}/pulls/{pr_number}"),
        check=False,
        timeout=60,
    )
    try:
        pr_data = json.loads(pr_result.stdout)
    except json.JSONDecodeError:
        pr_data = {}
    if not isinstance(pr_data, dict):
        pr_data = {}
    pr_head = str((pr_data.get("head") or {}).get("sha", ""))
    pr_base = str((pr_data.get("base") or {}).get("sha", ""))
    merge_sha = str(pr_data.get("merge_commit_sha") or "")
    merge_result = _run(
        ("gh", "api", f"repos/{slug}/git/commits/{merge_sha}"),
        check=False,
        timeout=60,
    ) if merge_sha else None
    try:
        merge_data = json.loads(merge_result.stdout) if merge_result else {}
        merge_parents = [
            str(parent.get("sha", ""))
            for parent in merge_data.get("parents", [])
        ]
    except (json.JSONDecodeError, AttributeError):
        merge_parents = []
    merge_identity = (
        pr_result.returncode == 0
        and merge_result is not None
        and merge_result.returncode == 0
        and pr_head == expected_head
        and pr_base == expected_base
        and len(merge_parents) == 2
        and merge_parents[0] == expected_base
        and merge_parents[1] == expected_head
    )
    runs: dict[str, dict[str, Any]] = {}
    failed_logs: dict[str, str] = {}
    checks: list[dict[str, Any]] = []
    for item in raw:
        link = str(item.get("link", ""))
        match = re.search(r"/actions/runs/(\d+)(?:/|$)", link)
        if not match:
            continue
        run_id = match.group(1)
        if run_id not in runs:
            run_result = _run(
                (
                    "gh",
                    "run",
                    "view",
                    run_id,
                    "--repo",
                    slug,
                    "--json",
                    "event,headSha,status,conclusion,workflowName,url",
                ),
                check=False,
                timeout=60,
            )
            try:
                run_data = json.loads(run_result.stdout)
            except json.JSONDecodeError:
                run_data = {}
            if not isinstance(run_data, dict):
                run_data = {}
            head_sha = str(run_data.get("headSha", "")) if isinstance(run_data, dict) else ""
            current_base = (
                run_result.returncode == 0
                and run_data.get("event") == "pull_request"
                and head_sha == expected_head
                and merge_identity
            )
            runs[run_id] = {
                "run_id": run_id,
                "event": run_data.get("event"),
                "head_sha": head_sha,
                "status": run_data.get("status"),
                "conclusion": run_data.get("conclusion"),
                "workflow": run_data.get("workflowName"),
                "url": run_data.get("url"),
                "merge_sha": merge_sha,
                "merge_parents": merge_parents,
                "pr_head": pr_head,
                "pr_base": pr_base,
                "current_base_identity": current_base,
            }
        if not runs[run_id]["current_base_identity"]:
            continue
        checks.append(
            {
                "name": str(item.get("name", "")),
                "state": str(item.get("state", "")),
                "bucket": str(item.get("bucket", "")),
                "workflow": str(item.get("workflow", "")),
                "link": link,
                "run": runs[run_id],
            }
        )
    checks.sort(key=lambda item: (item["workflow"], item["name"], item["link"]))
    if not checks:
        return "ABSENT", [], {}
    buckets = {item["bucket"] for item in checks}
    if buckets & {"fail", "cancel"}:
        for run_id in sorted({str(item["run"]["run_id"]) for item in checks if item["bucket"] in {"fail", "cancel"}}):
            failed = _run(
                ("gh", "run", "view", run_id, "--repo", slug, "--log-failed"),
                check=False,
                timeout=180,
            )
            # Keep JUDGE packets self-contained without allowing CI output to
            # grow the manual packet without bound.
            failed_logs[run_id] = failed.stdout[-65536:]
        return "FAIL", checks, failed_logs
    if config.required_ci_checks:
        for required in config.required_ci_checks:
            matches = [
                item
                for item in checks
                if item["name"] == required
                or f"{item['workflow']} / {item['name']}" == required
            ]
            if not matches or any(item["bucket"] == "pending" for item in matches):
                return "ABSENT", checks, {}
            if any(item["bucket"] != "pass" for item in matches):
                return "FAIL", checks, failed_logs
    if "pending" in buckets:
        return "ABSENT", checks, {}
    if buckets <= {"pass", "skipping"}:
        return "PASS", checks, {}
    return "ABSENT", checks, {}


def run_prove(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> EffectResult:
    if action.kind is not ActionKind.PROVE or not action.effect_id:
        raise FactError("not a PROVE effect")
    spec = _spec(snapshot, str(action.payload.get("spec_id")))
    if spec is None:
        raise FactError("PROVE effect references an absent SPEC")
    worktree = Path(config.worktree)
    fetched = _run(
        ("git", "fetch", config.remote, config.base_ref),
        cwd=worktree,
        check=False,
        timeout=120,
    )
    if fetched.returncode != 0:
        return EffectResult(False, "PROVE_ABSENT", "base fetch unavailable")
    fresh = read_snapshot(paths)
    recalculated = decide(fresh)
    if (
        recalculated.kind is not ActionKind.PROVE
        or recalculated.effect_id != action.effect_id
        or dict(recalculated.payload) != dict(action.payload)
    ):
        return EffectResult(False, "PROVE_ABSENT", "PROVE identities drifted before proof")
    partial_path = paths.proof_partials / f"{action.effect_id}.json"
    if partial_path.exists():
        mechanical = _load_json(partial_path)
        local_pass = _validate_partial(paths, config, snapshot, action, mechanical)
    else:
        mechanical, local_pass = _command_evidence(paths, config, snapshot, action)
        write_json_once(partial_path, mechanical)
    if not local_pass or any(
        int(item.get("exit_code", 1)) != 0 for item in mechanical.get("commands", [])
    ):
        status = Observation.FAIL
        checks: list[dict[str, Any]] = []
        failed_logs: dict[str, str] = {}
        require_pr_fence = False
    else:
        require_pr_fence = True
        if not ensure_owned_pr(config, snapshot, spec):
            return EffectResult(False, "PROVE_ABSENT", "push or PR transport unavailable")
        merge = read_merge_facts(config)
        if (
            merge.pr_number is None
            or merge.head != snapshot.head
            or merge.base != snapshot.base
            or merge.pr_base != snapshot.base
            or merge.p_id != config.p_id
            or merge.spec_id != spec.spec_id
            or merge.owner_token != config.owner_token
        ):
            return EffectResult(False, "PROVE_ABSENT", "PR identities have not converged")
        ci_status, checks, failed_logs = (
            _ci_checks(config, merge.pr_number, snapshot.head, snapshot.base)
            if config.require_github_ci
            else ("PASS", [], {})
        )
        if ci_status == "ABSENT":
            return EffectResult(False, "PROVE_ABSENT", "GitHub CI is queued/running/absent")
        status = Observation(ci_status)
    evidence = {
        "mechanical": mechanical,
        "github_checks": checks,
        "failed_ci_logs": failed_logs,
    }
    final = read_snapshot(paths)
    final_merge = final.merge
    final_action = decide(final)
    if (
        final.head != snapshot.head
        or final.base != snapshot.base
        or final_action.kind is not ActionKind.PROVE
        or final_action.effect_id != action.effect_id
        or dict(final_action.payload) != dict(action.payload)
        or (
            require_pr_fence
            and (
                final_merge.head != snapshot.head
                or final_merge.base != snapshot.base
                or final_merge.pr_base != snapshot.base
                or final_merge.p_id != config.p_id
                or final_merge.spec_id != spec.spec_id
                or final_merge.owner_token != config.owner_token
            )
        )
    ):
        return EffectResult(False, "PROVE_ABSENT", "HEAD, BASE, or PR drifted before proof result")
    result = {
        "effect_id": action.effect_id,
        "spec_id": spec.spec_id,
        "head": snapshot.head,
        "base": snapshot.base,
        "status": status.value,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "summary": "required mechanical and CI evidence passed"
        if status is Observation.PASS
        else "required mechanical or CI evidence failed",
        "evidence_digest": sha256_text(json.dumps(evidence, sort_keys=True)),
        "evidence": evidence,
    }
    destination = paths.proof_results / f"{action.effect_id}.json"
    write_json_once(destination, result)
    return EffectResult(True, f"PROVE_{status.value}", result["summary"], destination)


def execute_merge(
    paths: PPaths,
    expected: Action,
    *,
    snapshot_reader: Callable[..., Snapshot] = read_snapshot,
    command_runner: Callable[..., subprocess.CompletedProcess[str]] = _run,
) -> EffectResult:
    if expected.kind is not ActionKind.MERGE or not expected.effect_id:
        raise FactError("not a permitted MERGE effect")
    fresh = snapshot_reader(paths, allow_merge=True)
    recalculated = decide(fresh)
    if recalculated.kind is not ActionKind.MERGE or recalculated.effect_id != expected.effect_id:
        return EffectResult(False, "MERGE_FENCE_DRIFT", recalculated.reason)
    if dict(recalculated.payload) != dict(expected.payload):
        return EffectResult(False, "MERGE_FENCE_DRIFT", "merge payload drifted")
    config = load_config(paths)
    worktree = Path(config.worktree)
    if git(worktree, "status", "--porcelain"):
        return EffectResult(False, "MERGE_FENCE_DRIFT", "worktree is not clean")
    completed = command_runner(
        (
            "gh",
            "pr",
            "merge",
            str(recalculated.payload["pr_number"]),
            "--repo",
            github_slug(config.repository),
            "--merge",
            "--match-head-commit",
            str(recalculated.payload["head"]),
        ),
        cwd=worktree,
        check=False,
        timeout=120,
    )
    if completed.returncode != 0:
        return EffectResult(False, "MERGE_ABSENT", completed.stderr.strip())
    return EffectResult(True, "MERGE_SUBMITTED", "next tick must derive DONE from GitHub")
