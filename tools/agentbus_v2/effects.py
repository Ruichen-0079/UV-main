from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Sequence

from .core import (
    Action,
    ActionKind,
    GPT_PACKET_SCHEMA,
    PROOF_SCHEMA,
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
    load_charter,
    load_gpt_packet,
    load_config,
    parse_gpt_response,
    _proof_commands,
    read_snapshot,
    sha256_text,
    write_json_once,
    write_text_once,
)
from .codex_guardian import GUARDIAN_ERROR, run_guardian
from .github import (
    ensure_owned_pr,
    merge_pr,
    observe_required_checks,
    read_github_facts,
)


@dataclass(frozen=True)
class EffectResult:
    changed: bool
    detail: str


def _spec(snapshot: Snapshot, spec_id: str | None) -> SpecFact | None:
    return next((item for item in snapshot.specs if item.spec_id == spec_id), None)


def _evidence_text(paths: PPaths, evidence_id: str) -> str:
    candidates = [
        paths.root / "work" / "results" / f"{evidence_id}.json",
        paths.root / "prove" / "results" / f"{evidence_id}.json",
        paths.root / "work" / "logs" / f"{evidence_id}.response.json",
        paths.root / "work" / "logs" / f"{evidence_id}.codex.log",
    ]
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
    diff = git(
        Path(config.worktree), "diff", "--no-ext-diff", "--no-color",
        f"{snapshot.base}...{snapshot.head}",
    )
    parent = _spec(snapshot, action.payload.get("parent_spec_id"))
    current = _spec(snapshot, action.payload.get("spec_id")) or parent
    allowed = " | ".join(sorted(
        {"SPEC", "WAIT", "HUMAN"} if operation == "PLAN_GPT"
        else {"PASS", "RETURN_PLAN", "RETURN_WORK", "RETURN_PROVE", "WAIT", "HUMAN"}
    ))
    schema = (f'{{"job_id":"{action.effect_id}","operation":"{operation}",'
              f'"decision":"{allowed}","body":"string"}}')
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

## CURRENT-BASE DIFF

```diff
{diff}
```

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

Return exactly this JSON shape (with no Markdown):
{schema}
Repeat JOB_ID verbatim and put the complete bounded plan or judgment in body.
"""
    return packet


def dispatch_manual_gpt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> EffectResult:
    packet = render_gpt_prompt(paths, config, snapshot, action)
    prompt_path = paths.root / "gpt" / "outbox" / f"{action.effect_id}.md"
    created = write_text_once(prompt_path, packet)
    return EffectResult(
        created,
        detail=f"JOB_ID={action.effect_id} PACKET={prompt_path} SHA256={sha256_text(packet)}",
    )


def submit_gpt_response(paths: PPaths, response_path: Path) -> EffectResult:
    value = _load_json(response_path)
    job_id = value.get("job_id")
    if type(job_id) is not str or not GPT_JOB_RE.fullmatch(job_id):
        raise FactError("GPT response does not contain a valid generated JOB_ID")
    packet = load_gpt_packet(paths, job_id)
    result = parse_gpt_response(job_id, str(packet["operation"]), value)
    destination = paths.root / "gpt" / "results" / f"{result.job_id}.json"
    created = write_json_once(destination, asdict(result))
    return EffectResult(created, f"stored {destination}")


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
    if not spec.plan_job_id:
        raise FactError("CURRENT_SPEC lacks its causal PLAN job identity")
    trailers = f"""AgentBus-V2-P: {config.p_id}
AgentBus-V2-Spec: {spec.spec_id}
AgentBus-V2-Work: {action.effect_id}
AgentBus-V2-Input-Head: {snapshot.head}
AgentBus-V2-Plan: {spec.plan_job_id}{trigger_trailer}"""
    return f"""Implement this AgentBus v2 WORK job.

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

Implement only the approved scope, validate proportionally, do not merge, and
finish with a clean worktree and a commit descended from input HEAD. Its
message must contain these exact trailers:

{trailers}

Return only the supplied JSON schema. PASS requires a complete commit; otherwise
return FAIL with the exact blocker. An executor/process crash is not FAIL.
"""


CODEX_OUTPUT_SCHEMA = (
    '{"type":"object","additionalProperties":false,"properties":'
    '{"status":{"enum":["PASS","FAIL"]},"summary":{"type":"string"},'
    '"head":{"type":"string"},"evidence":{"type":"array","items":{"type":"string"}}},'
    '"required":["status","summary","head","evidence"]}\n'
)


def _local_branch_refs(worktree: Path) -> dict[str, str]:
    lines = git(worktree, "for-each-ref", "--format=%(refname) %(objectname)",
                "refs/heads").splitlines()
    return dict(line.split(" ", 1) for line in lines if " " in line)


def run_codex_work(
    paths: PPaths,
    config: PConfig,
    snapshot: Snapshot,
    action: Action,
    codex_home: Path | None = None,
    *,
    worktree_lock_path: Path | None = None,
    account_lock_path: Path | None = None,
) -> EffectResult:
    if action.kind is not ActionKind.WORK or not action.effect_id:
        raise FactError("not a WORK effect")
    spec = _spec(snapshot, str(action.payload.get("spec_id")))
    if spec is None:
        raise FactError("WORK effect references an absent SPEC")
    prompt = _work_prompt(paths, config, snapshot, action, spec)
    fresh = read_snapshot(paths)
    recalculated = decide(fresh)
    if (
        recalculated.kind is not ActionKind.WORK
        or recalculated.effect_id != action.effect_id
        or dict(recalculated.payload) != dict(action.payload)
    ):
        return EffectResult(False, "WORK identities drifted before Codex")
    if git(Path(config.worktree), "status", "--porcelain=v1"):
        raise FactError("refusing to launch Codex in a dirty WORK worktree")
    worktree = Path(config.worktree)
    protected_refs = _local_branch_refs(worktree)
    common_git = Path(git(worktree, "rev-parse", "--git-common-dir"))
    if not common_git.is_absolute():
        common_git = (worktree / common_git).resolve()
    response_path = paths.root / "work" / "logs" / f"{action.effect_id}.response.json"
    log_path = paths.root / "work" / "logs" / f"{action.effect_id}.codex.log"
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
        environment = os.environ.copy()
        if codex_home is not None:
            environment["CODEX_HOME"] = str(codex_home)
        if worktree_lock_path is None or account_lock_path is None:
            return EffectResult(False, "Codex ownership locks were not supplied")
        guarded = run_guardian(
            command,
            cwd=worktree,
            env=environment,
            log_path=log_path,
            timeout=7200.0,
            worktree_lock=worktree_lock_path,
            account_lock=account_lock_path,
            input_text=prompt,
            expected_head=snapshot.head,
            expected_branch=config.branch,
        )
    finally:
        schema.close()
        schema_path.unlink(missing_ok=True)
    try:
        completed_output = log_path.read_text(encoding="utf-8", errors="replace")[-262144:]
    except OSError:
        completed_output = ""
    if guarded.timed_out:
        return EffectResult(False, "Codex exceeded the executor timeout")
    if guarded.parent_lost:
        return EffectResult(False, "Codex guardian cleaned up after AgentBus parent loss")
    if guarded.worktree_busy:
        return EffectResult(False, "worktree execution lock is unavailable")
    if guarded.account_busy:
        return EffectResult(False, "Codex account lock is unavailable")
    if guarded.identity_drift:
        return EffectResult(False, "WORK identities drifted before Codex")
    if guarded.returncode == GUARDIAN_ERROR:
        return EffectResult(False, "Codex guardian could not start or own the executor")
    if guarded.returncode != 0 or not response_path.exists():
        return EffectResult(False, "Codex exited without a durable result")
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
        return EffectResult(False, f"invalid Codex result: {error}")
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
        return EffectResult(True, summary)
    if live_head != snapshot.head or changed_refs or response["head"] != live_head:
        raise FactError("Codex returned FAIL after changing repository HEAD")
    evidence = {
        "codex_response": response,
        "codex_log_sha256": sha256_text(completed_output),
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
    destination = paths.root / "work" / "results" / f"{action.effect_id}.json"
    write_json_once(destination, result)
    return EffectResult(True, f"{summary}; stored {destination}")


def _command_evidence(
    config: PConfig, snapshot: Snapshot
) -> tuple[dict[str, Any] | None, Observation | None]:
    worktree = Path(config.worktree)
    commands = _proof_commands(config, snapshot.base, snapshot.head)
    def record(argv: Sequence[str], output: str, exit_code: int) -> dict[str, Any]:
        return {"argv": list(argv), "exit_code": exit_code,
                "output": output[-65536:], "output_digest": sha256_text(output)}
    try:
        status_text = git(worktree, "status", "--porcelain=v1")
    except FactError:
        return None, None
    records = [record(("git", "status", "--porcelain=v1"), status_text, 1 if status_text else 0)]
    if status_text:
        return {"commands": records}, Observation.FAIL
    for argv in commands[1:-1]:
        try:
            completed = _run(argv, cwd=worktree, check=False, timeout=1800)
        except FactError:
            return None, None
        log = completed.stdout + ("\nSTDERR:\n" + completed.stderr if completed.stderr else "")
        records.append(record(argv, log, completed.returncode))
        if completed.returncode != 0:
            return {"commands": records}, Observation.FAIL
    try:
        after = git(worktree, "status", "--porcelain=v1")
    except FactError:
        return None, None
    records.append(record(("git", "status", "--porcelain=v1"), after, 1 if after else 0))
    return {"commands": records}, Observation.PASS if not after else Observation.FAIL


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
        return EffectResult(False, "base fetch unavailable")
    fresh = read_snapshot(paths)
    recalculated = decide(fresh)
    if (
        recalculated.kind is not ActionKind.PROVE
        or recalculated.effect_id != action.effect_id
        or dict(recalculated.payload) != dict(action.payload)
    ):
        return EffectResult(False, "PROVE identities drifted before proof")
    mechanical, local_status = _command_evidence(config, snapshot)
    if mechanical is None or local_status is None:
        return EffectResult(False, "mechanical proof was interrupted")
    if local_status is Observation.FAIL:
        status = local_status
        checks: list[dict[str, Any]] = []
        failed_logs: dict[str, str] = {}
        require_pr_fence = False
    else:
        require_pr_fence = True
        if not ensure_owned_pr(config, spec):
            return EffectResult(False, "push or PR transport unavailable")
        merge = read_github_facts(config)
        if (
            merge.pr_number is None
            or merge.head_sha != snapshot.head
            or merge.live_base != snapshot.base
            or merge.pr_base_sha != snapshot.base
            or merge.head_branch != config.branch
            or merge.base_branch != config.base_ref
            or merge.p_id != config.p_id
            or merge.spec_id != spec.spec_id
            or merge.owner_token != config.owner_token
        ):
            return EffectResult(False, "PR identities have not converged")
        if config.required_ci_checks:
            merge = observe_required_checks(config, merge, snapshot.head, snapshot.base)
            checks = [asdict(item) for item in merge.checks]
            failed_logs = dict(merge.failed_ci_logs)
            ci_status = merge.check_status
        else:
            ci_status, checks, failed_logs = "PASS", [], {}
        if ci_status in {"MISSING", "RUNNING"}:
            return EffectResult(False, "GitHub CI is queued/running/absent")
        status = Observation(ci_status)
    evidence = {
        "local_commands": mechanical["commands"],
        "github_checks": checks,
        "failed_ci_logs": failed_logs,
    }
    final = read_snapshot(paths)
    final_merge = final.merge
    if require_pr_fence and config.required_ci_checks and status is Observation.PASS:
        final_merge = observe_required_checks(config, final_merge, snapshot.head, snapshot.base)
        if final_merge.check_status != "PASS":
            return EffectResult(False, "CI drifted before proof result")
        checks = [asdict(item) for item in final_merge.checks]
        failed_logs = dict(final_merge.failed_ci_logs)
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
                final_merge.head_sha != snapshot.head
                or final_merge.live_base != snapshot.base
                or final_merge.pr_base_sha != snapshot.base
                or final_merge.head_branch != config.branch
                or final_merge.base_branch != config.base_ref
                or final_merge.p_id != config.p_id
                or final_merge.spec_id != spec.spec_id
                or final_merge.owner_token != config.owner_token
            )
        )
    ):
        return EffectResult(False, "HEAD, BASE, or PR drifted before proof result")
    result = {
        "schema": PROOF_SCHEMA,
        "proof_id": action.effect_id,
        "spec_id": spec.spec_id,
        "head": snapshot.head,
        "base": snapshot.base,
        "status": status.value,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "contract_digest": snapshot.proof_contract_digest,
        "summary": "required mechanical and CI evidence passed"
        if status is Observation.PASS
        else "required mechanical or CI evidence failed",
        "evidence_digest": sha256_text(json.dumps(evidence, sort_keys=True)),
        "local_commands": evidence["local_commands"],
        "github_checks": evidence["github_checks"],
        "failed_ci_logs": evidence["failed_ci_logs"],
    }
    destination = paths.root / "prove" / "results" / f"{action.effect_id}.json"
    write_json_once(destination, result)
    return EffectResult(True, f"{result['summary']}; stored {destination}")


def execute_merge(
    paths: PPaths,
    expected: Action,
) -> EffectResult:
    if expected.kind is not ActionKind.MERGE or not expected.effect_id:
        raise FactError("not a permitted MERGE effect")
    fresh = read_snapshot(paths, allow_merge=True)
    recalculated = decide(fresh)
    if recalculated.kind is not ActionKind.MERGE or recalculated.effect_id != expected.effect_id:
        return EffectResult(False, recalculated.reason)
    if dict(recalculated.payload) != dict(expected.payload):
        return EffectResult(False, "merge payload drifted")
    config = load_config(paths)
    worktree = Path(config.worktree)
    if git(worktree, "status", "--porcelain"):
        return EffectResult(False, "worktree is not clean")
    completed = merge_pr(
        config,
        int(recalculated.payload["pr_number"]),
        str(recalculated.payload["head"]),
    )
    if completed.returncode != 0:
        return EffectResult(False, completed.stderr.strip())
    return EffectResult(True, "next tick must derive DONE from GitHub")
