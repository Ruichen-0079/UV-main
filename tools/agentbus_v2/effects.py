"""Effect adapters for the fact-recomputed AgentBus v2 kernel."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
from typing import Any, Callable, Iterator, Mapping, Sequence

from .core import (
    Action,
    ActionKind,
    JUDGE_RESULTS,
    PLAN_RESULTS,
    GptResult,
    Observation,
    Snapshot,
    SpecFact,
    decide,
    plan_facts_digest,
)
from .facts import (
    FactError,
    GPT_JOB_RE,
    PConfig,
    PPaths,
    _validate_gpt_request,
    _load_json,
    _run,
    git,
    github_slug,
    load_charter,
    load_config,
    parse_gpt_response,
    read_merge_facts,
    read_snapshot,
    sha256_text,
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


def _safe_context_path(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise FactError(f"unsafe repository context path: {value!r}")
    return path.as_posix()


def _repository_context(config: PConfig, snapshot: Snapshot) -> str:
    worktree = Path(config.worktree)
    sections = [
        ("RECENT COMMITS", git(worktree, "log", "-8", "--format=%H %s", snapshot.head)),
        (
            "CURRENT-BASE DIFF STAT",
            git(worktree, "diff", "--stat", f"{snapshot.base}...{snapshot.head}"),
        ),
        (
            "CURRENT-BASE TEXT DIFF",
            git(
                worktree,
                "diff",
                "--no-ext-diff",
                "--no-color",
                f"{snapshot.base}...{snapshot.head}",
            ),
        ),
    ]
    paths = tuple(_safe_context_path(value) for value in config.context_paths)
    if paths:
        listing = git(worktree, "ls-tree", "-r", "--name-only", snapshot.head, "--", *paths)
        sections.append(("CONTEXT FILE INVENTORY", listing))
    if config.context_terms:
        pattern = "|".join(re.escape(term) for term in config.context_terms)
        command = (
            "git",
            "grep",
            "-n",
            "-i",
            "-E",
            pattern,
            snapshot.head,
            "--",
            *(paths or (".",)),
        )
        completed = _run(command, cwd=worktree, check=False)
        sections.append(("MATCHING SOURCE LINES", completed.stdout.strip()))
    for value in paths:
        completed = _run(
            ("git", "cat-file", "-t", f"{snapshot.head}:{value}"),
            cwd=worktree,
            check=False,
        )
        if completed.returncode != 0 or completed.stdout.strip() != "blob":
            continue
        raw = _run(
            ("git", "show", f"{snapshot.head}:{value}"), cwd=worktree, check=False
        ).stdout
        if "\x00" not in raw:
            sections.append((f"FILE {value}", raw.rstrip()))
    return "\n\n".join(f"## {title}\n\n```text\n{body}\n```" for title, body in sections)


def _evidence_text(paths: PPaths, evidence_id: str) -> str:
    candidates = (
        paths.work_results / f"{evidence_id}.json",
        paths.proof_results / f"{evidence_id}.json",
        paths.proof_partials / f"{evidence_id}.json",
    )
    pieces: list[str] = []
    for path in candidates:
        if path.exists():
            value = path.read_text(encoding="utf-8", errors="replace")
            marker = (
                f"\n[truncated to final 65536 characters; full SHA-256 "
                f"{sha256_text(value)}]"
                if len(value) > 65536
                else ""
            )
            pieces.append(value[-65536:].rstrip() + marker)
    for directory in (paths.work_logs, paths.proof_logs):
        for path in sorted(directory.glob(f"{evidence_id}*")):
            value = path.read_text(encoding="utf-8", errors="replace")
            marker = (
                f"\n[truncated to final 65536 characters; full SHA-256 "
                f"{sha256_text(value)}]"
                if len(value) > 65536
                else ""
            )
            pieces.append(f"FILE: {path.name}\n{value[-65536:].rstrip()}{marker}")
    return "\n\n".join(pieces) or "No additional evidence payload was found."


def _strict_schema(job_id: str, operation: str) -> str:
    decisions = sorted(PLAN_RESULTS if operation == "PLAN_GPT" else JUDGE_RESULTS)
    return f"""Return exactly one JSON object and no Markdown fence or extra text:
{{
  "job_id": "{job_id}",
  "operation": "{operation}",
  "decision": "{' | '.join(decisions)}",
  "body": "string"
}}

The keys must be exactly job_id, operation, decision, body. Repeat JOB_ID
verbatim. For SPEC, body is the complete concrete implementation plan. For a
RETURN_* result, body is the exact diagnosis and bounded direction. For WAIT
or HUMAN, body states the exact dependency or question. PASS body briefly
states why current evidence satisfies the requested judgment."""


def render_gpt_prompt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> tuple[dict[str, Any], str]:
    if action.kind not in {ActionKind.PLAN, ActionKind.JUDGE} or not action.effect_id:
        raise FactError("not a GPT effect")
    operation = "PLAN_GPT" if action.kind is ActionKind.PLAN else "JUDGE_GPT"
    charter = load_charter(paths, config)
    parent = _spec(snapshot, action.payload.get("parent_spec_id"))
    current = _spec(snapshot, action.payload.get("spec_id")) or parent
    planning_digest = plan_facts_digest(snapshot)
    semantic: dict[str, Any] = {
        "p_id": config.p_id,
        "operation": operation,
        "charter_digest": config.charter_digest,
        "repository": config.repository,
        "branch": config.branch,
        "base_ref": config.base_ref,
        "head": snapshot.head,
        "base": snapshot.base,
        "parent_spec_id": parent.spec_id if parent else None,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "planning_facts_digest": planning_digest,
    }
    if operation == "JUDGE_GPT":
        semantic.update(
            {
                "spec_id": action.payload["spec_id"],
                "failed_step": action.payload["failed_step"],
                "evidence_id": action.payload["evidence_id"],
                "evidence_digest": action.payload["evidence_digest"],
            }
        )
    request = {
        "schema_version": 1,
        "job_id": action.effect_id,
        "operation": operation,
        "semantic_input": semantic,
    }
    prior = "NONE"
    trigger = semantic.get("trigger_judge_id")
    if trigger:
        matches = [item for item in snapshot.gpt_results if item.job_id == trigger]
        if len(matches) == 1:
            prior = json.dumps(asdict(matches[0]), indent=2, ensure_ascii=False)
    spec_block = current.text if current else "NONE (PLAN_GPT must create CURRENT_SPEC)"
    evidence = (
        _evidence_text(paths, str(semantic["evidence_id"]))
        if operation == "JUDGE_GPT"
        else "PLAN_GPT evidence is the immutable charter and exact repository facts below."
    )
    role = (
        "Produce one concrete, bounded CURRENT_SPEC. Do not implement it."
        if operation == "PLAN_GPT"
        else "Judge the exact current evidence semantically. Do not invent missing evidence."
    )
    prompt = f"""# AGENTBUS V2 SELF-CONTAINED GPT PACKET

JOB_ID: {action.effect_id}
REQUESTED_ROLE: {operation}

{role}

## P_CHARTER (immutable)

{charter.rstrip()}

## CURRENT_SPEC

{spec_block}

## EXACT REPOSITORY FACTS

- repository: {config.repository}
- branch: {config.branch}
- HEAD: {semantic['head']}
- live BASE ({config.base_ref}): {semantic['base']}
- planning facts digest: {planning_digest}

{_repository_context(config, snapshot)}

## PREVIOUS RELEVANT JUDGE RESULT

```json
{prior}
```

## CURRENT EVIDENCE

```text
{evidence}
```

## SEMANTIC RULES

There are only PLAN, WORK, PROVE, MERGE. ABSENT is never sent for semantic
diagnosis. There is no repair/replan/wait workflow state. A correction is only
RETURN_PLAN, RETURN_WORK, or RETURN_PROVE. GPT cannot bypass required mechanical
proof or merge fences. PASS is valid for the final PROVE_SEMANTIC judgment; it
cannot replace a missing WORK PASS or a confirmed mechanical PROVE failure.
For those failures choose RETURN_*, WAIT, or HUMAN. Base every conclusion only
on this packet.

## STRICT RESPONSE SCHEMA

{_strict_schema(action.effect_id, operation)}
"""
    request["prompt_digest"] = sha256_text(prompt)
    return request, prompt


def dispatch_manual_gpt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action
) -> EffectResult:
    request, prompt = render_gpt_prompt(paths, config, snapshot, action)
    request_path = paths.gpt_requests / f"{action.effect_id}.json"
    prompt_path = paths.gpt_outbox / f"{action.effect_id}.md"
    created = write_text_once(prompt_path, prompt)
    if write_json_once(request_path, request):
        created = True
    return EffectResult(created, "MANUAL_GPT_REQUIRED", path=prompt_path)


def submit_gpt_response(paths: PPaths, response_path: Path) -> EffectResult:
    value = _load_json(response_path)
    job_id = value.get("job_id")
    if type(job_id) is not str or not GPT_JOB_RE.fullmatch(job_id):
        raise FactError("GPT response does not contain a valid generated JOB_ID")
    request_path = paths.gpt_requests / f"{job_id}.json"
    if not request_path.exists():
        raise FactError("GPT response does not name an issued JOB_ID")
    request = _load_json(request_path)
    _validate_gpt_request(paths, load_config(paths), job_id, request)
    result = parse_gpt_response(request, value)
    destination = paths.gpt_inbox / f"{result.job_id}.json"
    created = write_json_once(destination, asdict(result))
    return EffectResult(created, "GPT_RESULT_INGESTED", path=destination)


@contextmanager
def _lease(paths: PPaths, effect_id: str, hours: int = 6) -> Iterator[bool]:
    path = paths.leases / f"{effect_id}.json"
    paths.leases.mkdir(parents=True, exist_ok=True)
    expires = (datetime.now(UTC) + timedelta(hours=hours)).isoformat()
    data = json.dumps({"effect_id": effect_id, "expires_at": expires}, sort_keys=True)
    while True:
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            try:
                existing = _load_json(path)
                existing_expiry = datetime.fromisoformat(str(existing["expires_at"]))
                if existing_expiry.tzinfo is None:
                    existing_expiry = existing_expiry.replace(tzinfo=UTC)
            except (FactError, KeyError, ValueError) as error:
                raise FactError(f"invalid operational lease {path}: {error}") from error
            if existing_expiry > datetime.now(UTC):
                yield False
                return
            path.unlink(missing_ok=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(data + "\n")
        yield True
    finally:
        path.unlink(missing_ok=True)


def _work_prompt(
    paths: PPaths, config: PConfig, snapshot: Snapshot, action: Action, spec: SpecFact
) -> str:
    trigger = action.payload.get("trigger_judge_id")
    direction = "NONE"
    if trigger:
        matches = [item for item in snapshot.gpt_results if item.job_id == trigger]
        if len(matches) == 1:
            direction = matches[0].body
    trailers = f"""AgentBus-V2-P: {config.p_id}
AgentBus-V2-Spec: {spec.spec_id}
AgentBus-V2-Work: {action.effect_id}
AgentBus-V2-Input-Head: {snapshot.head}"""
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


def _codex_schema(path: Path) -> None:
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "status": {"enum": ["PASS", "FAIL"]},
            "summary": {"type": "string"},
            "head": {"type": "string"},
            "evidence": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["status", "summary", "head", "evidence"],
    }
    path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")


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
    request = {
        "schema_version": 1,
        "effect_id": action.effect_id,
        "p_id": config.p_id,
        "spec_id": spec.spec_id,
        "input_head": snapshot.head,
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
    }
    write_json_once(paths.work_requests / f"{action.effect_id}.json", request)
    prompt_path = paths.work_outbox / f"{action.effect_id}.md"
    write_text_once(prompt_path, prompt)
    with _lease(paths, action.effect_id) as acquired:
        if not acquired:
            return EffectResult(False, "WORK_ABSENT", "another executor lease is active")
        fresh = read_snapshot(paths)
        unfenced = replace(
            fresh, active_effects=fresh.active_effects - {action.effect_id}
        )
        recalculated = decide(unfenced)
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
        schema_path = paths.work_logs / f"{action.effect_id}.schema.json"
        response_path = paths.work_logs / f"{action.effect_id}.response.json"
        log_path = paths.work_logs / f"{action.effect_id}.codex.log"
        response_path.unlink(missing_ok=True)
        _codex_schema(schema_path)
        command = (
            "codex",
            "exec",
            "--ephemeral",
            "--approve-for-me",
            "-C",
            config.worktree,
            "--add-dir",
            str(common_git),
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(response_path),
            "-",
        )
        try:
            completed = subprocess.run(
                command,
                input=prompt,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
                timeout=7200,
            )
        except subprocess.TimeoutExpired as error:
            output = error.stdout if isinstance(error.stdout, str) else ""
            log_path.write_text(output[-262144:], encoding="utf-8", errors="replace")
            return EffectResult(False, "WORK_ABSENT", "Codex exceeded the executor timeout", log_path)
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
            if status is Observation.ABSENT:
                raise FactError("Codex cannot persist ABSENT")
        except (FactError, ValueError) as error:
            return EffectResult(False, "WORK_ABSENT", f"invalid Codex result: {error}", response_path)
        live_head = git(Path(config.worktree), "rev-parse", "HEAD")
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
        dirty = git(worktree, "status", "--porcelain=v1")
        if dirty:
            raise FactError("Codex completed with a dirty WORK worktree")
        if status is Observation.PASS:
            recovered = _recover_work(config, paths, live_head)
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
        elif live_head != snapshot.head or changed_refs or response["head"] != live_head:
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
            "status": status.value,
            "output_head": live_head if status is Observation.PASS else None,
            "trigger_judge_id": action.payload.get("trigger_judge_id"),
            "summary": summary,
            "evidence_digest": sha256_text(json.dumps(evidence, sort_keys=True)),
        }
        destination = paths.work_results / f"{action.effect_id}.json"
        write_json_once(destination, result)
        return EffectResult(True, f"WORK_{status.value}", summary, destination)


def _recover_work(config: PConfig, paths: PPaths, head: str):
    # Importing here keeps the commit-recovery contract defined in one place.
    from .facts import _work_from_head

    return _work_from_head(config, paths, head)


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
            commit_result = _run(
                ("gh", "api", f"repos/{slug}/git/commits/{head_sha}"),
                check=False,
                timeout=60,
            )
            try:
                commit_data = json.loads(commit_result.stdout)
                parents = [str(parent.get("sha", "")) for parent in commit_data.get("parents", [])]
            except (json.JSONDecodeError, AttributeError):
                parents = []
            current_base = (
                run_result.returncode == 0
                and commit_result.returncode == 0
                and run_data.get("event") == "pull_request"
                and len(parents) == 2
                and parents[0] == expected_base
                and parents[1] == expected_head
            )
            runs[run_id] = {
                "run_id": run_id,
                "event": run_data.get("event"),
                "head_sha": head_sha,
                "status": run_data.get("status"),
                "conclusion": run_data.get("conclusion"),
                "workflow": run_data.get("workflowName"),
                "url": run_data.get("url"),
                "parents": parents,
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
    with _lease(paths, action.effect_id) as acquired:
        if not acquired:
            return EffectResult(False, "PROVE_ABSENT", "another proof lease is active")
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
        unfenced = replace(
            fresh, active_effects=fresh.active_effects - {action.effect_id}
        )
        recalculated = decide(unfenced)
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
        final_action = decide(
            replace(final, active_effects=final.active_effects - {action.effect_id})
        )
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
