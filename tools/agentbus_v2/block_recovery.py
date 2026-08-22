"""One-shot operational recovery for an accepted BLOCK_GPT RECOVER result.

Recovery is operational only.  It cannot change semantic facts, Git authority,
or PR ownership identity.  One accepted BLOCK result permits at most one
addressed recovery execution.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Callable, Mapping

from .block_diagnosis import BlockResult, load_block_packet
from .codex_guardian import GUARDIAN_ERROR, run_guardian
from .core import Action, Snapshot, decide, stable_id
from .effects import CODEX_WORK_MODEL, EffectResult, parse_grok_cli_payload
from .facts import (
    FactError,
    PConfig,
    PPaths,
    _load_json,
    sha256_text,
    write_json_once,
    write_text_once,
)
from .readonly_diagnosis import (
    authority_mutated,
    capture_authority,
    reread_authorized_snapshot,
    semantic_fact_fingerprint,
)


RECOVERY_STATUSES = frozenset({"APPLIED", "NOT_APPLIED", "UNSAFE"})
RECOVERY_ID_RE = re.compile(r"^recovery-[0-9a-f]{24}$")
_ABS_PATH_RE = re.compile(r"(/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+)")
RECOVERY_TIMEOUT_SECONDS = 600.0
RECOVERY_OUTPUT_SCHEMA = (
    '{"type":"object","additionalProperties":false,"properties":'
    '{"status":{"enum":["APPLIED","NOT_APPLIED","UNSAFE"]},"summary":{"type":"string"},'
    '"evidence":{"type":"array","items":{"type":"string"}}},'
    '"required":["status","summary","evidence"]}'
)
PROHIBITED_MUTATIONS = (
    "git commit", "git reset", "git rebase", "git merge",
    "git checkout to another authority", "branch deletion",
    "PR merge", "PR close", "P create/delete",
    "operator directive creation", "GPT semantic-result fabrication",
    "browser storage mutation", "source/product implementation changes",
    "semantic-fact mutation",
)


class RecoveryError(FactError):
    """An invalid or unsafe operational recovery artifact."""


@dataclass(frozen=True)
class RecoveryRun:
    launched: bool
    report: Mapping[str, Any] | None
    detail: str
    route: str


RecoveryExecutor = Callable[..., RecoveryRun]


def block_result_digest(result: BlockResult) -> str:
    return sha256_text(json.dumps(result.as_dict(), sort_keys=True, separators=(",", ":")))


def recovery_id(*, block_id: str, block_result_digest: str) -> str:
    return stable_id(
        "recovery",
        {"block_id": block_id, "block_result_digest": block_result_digest},
    )


def recovery_result_dir(paths: PPaths) -> Path:
    return paths.root / "recovery" / "results"


def recovery_log_dir(paths: PPaths) -> Path:
    return paths.root / "recovery" / "logs"


def recovery_result_path(paths: PPaths, job_id: str) -> Path:
    if not RECOVERY_ID_RE.fullmatch(job_id):
        raise RecoveryError(f"invalid recovery id: {job_id}")
    return recovery_result_dir(paths) / f"{job_id}.json"


def load_recovery_result(paths: PPaths, job_id: str) -> dict[str, Any] | None:
    path = recovery_result_path(paths, job_id)
    if not path.exists():
        return None
    value = _load_json(path)
    if value.get("recovery_id") != job_id:
        raise RecoveryError(f"recovery result identity mismatch: {job_id}")
    return value


def current_recovery(
    paths: PPaths, block: BlockResult
) -> dict[str, Any] | None:
    job_id = recovery_id(block_id=block.block_id, block_result_digest=block_result_digest(block))
    try:
        return load_recovery_result(paths, job_id)
    except (RecoveryError, FactError):
        return None


def _parse_report(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"status", "summary", "evidence"}:
        raise RecoveryError("recovery report has unexpected fields")
    if (
        value["status"] not in RECOVERY_STATUSES
        or type(value["summary"]) is not str
        or not value["summary"].strip()
        or not isinstance(value["evidence"], list)
        or any(type(item) is not str for item in value["evidence"])
    ):
        raise RecoveryError("recovery report fields are invalid")
    return {
        "status": value["status"],
        "summary": value["summary"].strip(),
        "evidence": list(value["evidence"])[:16],
    }


def _parse_grok_json(text: str) -> dict[str, Any]:
    try:
        return _parse_report(parse_grok_cli_payload(text))
    except FactError as error:
        raise RecoveryError(str(error)) from error


def _recovery_prompt(
    paths: PPaths,
    config: PConfig,
    snapshot: Snapshot,
    action: Action,
    block: BlockResult,
    diagnosis: Mapping[str, Any] | None,
) -> str:
    try:
        packet = load_block_packet(paths, block.block_id)
    except (FactError, OSError):
        packet = {"block_id": block.block_id}
    return f"""Implement this AgentBus v2 operational recovery job.

Execute the exact BLOCK recovery_instruction with tools in this worktree
before returning JSON. A JSON report is not the recovery.

CURRENT_RECOVERY_INSTRUCTION:
{block.recovery_instruction or ""}

EXPECTED_POSTCONDITION:
{block.expected_postcondition or ""}

Allowed: the bounded operational repair named by recovery_instruction,
including creating or recreating a missing local runtime marker, socket, or
file that is not tracked Git source.

Do not change tracked source, product implementation, Git authority, PR
identity, or AgentBus semantic facts.

Prohibited mutations:
{chr(10).join(f"- {item}" for item in PROHIBITED_MUTATIONS)}

Exact identities:
- P: {snapshot.p_id}
- repository: {config.repository}
- branch: {config.branch}
- HEAD: {snapshot.head}
- BASE: {snapshot.base}
- current action: {action.kind.value}
- current effect: {action.effect_id}
- block_id: {block.block_id}
- causal_effect_id: {packet.get("causal_effect_id")}
- causal_action_kind: {packet.get("causal_action_kind")}

BLOCK result:
```json
{json.dumps(block.as_dict(), sort_keys=True, ensure_ascii=False, separators=(",", ":"))}
```

Diagnosis evidence:
```json
{json.dumps({} if diagnosis is None else dict(diagnosis), sort_keys=True, ensure_ascii=False, separators=(",", ":"))}
```

Use tools to inspect the named target, perform only the authorized repair,
independently re-read the expected_postcondition, then return only this JSON
object. APPLIED requires the postcondition to be true on disk; otherwise
return NOT_APPLIED with the exact blocker. UNSAFE means a prohibited
mutation occurred or would be required.

{RECOVERY_OUTPUT_SCHEMA}
"""


def _codex_recovery_command(
    config: PConfig, schema_path: Path, response_path: Path
) -> tuple[str, ...]:
    return (
        "codex",
        "--ask-for-approval", "never",
        "exec", "--ephemeral",
        "--sandbox", "workspace-write",
        "--model", CODEX_WORK_MODEL,
        "-C", config.worktree,
        "--output-schema", str(schema_path),
        "--output-last-message", str(response_path),
        "-",
    )


def _grok_recovery_command(config: PConfig, prompt_path: Path, model: str) -> tuple[str, ...]:
    # Recovery must use tools before reporting. Constraining the first model
    # output with --json-schema lets Grok emit APPLIED/NOT_APPLIED without
    # performing the authorized repair. WORK keeps --json-schema because PASS
    # is independently reconstructed from commit trailers.
    return (
        "grok",
        "--prompt-file", str(prompt_path),
        "--model", model,
        "--cwd", config.worktree,
        "--output-format", "json",
        "--always-approve",
        "--no-alt-screen",
    )


def _run_codex_recovery(
    config: PConfig,
    snapshot: Snapshot,
    prompt: str,
    log_path: Path,
    *,
    account_home: Path,
    worktree_lock_path: Path,
    account_lock_path: Path,
) -> RecoveryRun:
    response_path = log_path.with_suffix(".response.json")
    response_path.unlink(missing_ok=True)
    schema = tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False)
    schema_path = Path(schema.name)
    try:
        schema.write(RECOVERY_OUTPUT_SCHEMA)
        schema.close()
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(account_home)
        guarded = run_guardian(
            _codex_recovery_command(config, schema_path, response_path),
            cwd=Path(config.worktree),
            env=environment,
            log_path=log_path,
            timeout=RECOVERY_TIMEOUT_SECONDS,
            worktree_lock=worktree_lock_path,
            account_lock=account_lock_path,
            input_text=prompt,
            expected_head=snapshot.head,
            expected_branch=config.branch,
        )
    finally:
        schema.close()
        schema_path.unlink(missing_ok=True)
    if guarded.worktree_busy:
        return RecoveryRun(False, None, "worktree execution lock is unavailable", "CODEX")
    if guarded.account_busy:
        return RecoveryRun(False, None, "Codex account lock is unavailable", "CODEX")
    if guarded.identity_drift:
        return RecoveryRun(False, None, "identities drifted before recovery", "CODEX")
    if guarded.timed_out:
        return RecoveryRun(True, None, "Codex recovery exceeded the timeout", "CODEX")
    if guarded.parent_lost:
        return RecoveryRun(True, None, "Codex guardian cleaned up after AgentBus parent loss", "CODEX")
    if guarded.returncode == GUARDIAN_ERROR:
        return RecoveryRun(False, None, "Codex guardian could not start or own the executor", "CODEX")
    if guarded.returncode != 0 or not response_path.exists():
        return RecoveryRun(True, None, "Codex exited without a durable recovery result", "CODEX")
    try:
        report = _parse_report(_load_json(response_path))
    except (RecoveryError, FactError) as error:
        return RecoveryRun(True, None, f"invalid recovery JSON: {error}", "CODEX")
    return RecoveryRun(True, report, "Codex recovery completed", "CODEX")


def _run_grok_recovery(
    config: PConfig,
    snapshot: Snapshot,
    prompt: str,
    prompt_path: Path,
    log_path: Path,
    *,
    grok_home: Path,
    model: str,
    worktree_lock_path: Path,
    account_lock_path: Path,
) -> RecoveryRun:
    write_text_once(prompt_path, prompt)
    environment = os.environ.copy()
    environment["GROK_HOME"] = str(grok_home)
    guarded = run_guardian(
        _grok_recovery_command(config, prompt_path, model),
        cwd=Path(config.worktree),
        env=environment,
        log_path=log_path,
        timeout=RECOVERY_TIMEOUT_SECONDS,
        worktree_lock=worktree_lock_path,
        account_lock=account_lock_path,
        input_text="",
        expected_head=snapshot.head,
        expected_branch=config.branch,
    )
    if guarded.worktree_busy:
        return RecoveryRun(False, None, "worktree execution lock is unavailable", "GROK")
    if guarded.account_busy:
        return RecoveryRun(False, None, "Grok account lock is unavailable", "GROK")
    if guarded.identity_drift:
        return RecoveryRun(False, None, "identities drifted before recovery", "GROK")
    if guarded.timed_out:
        return RecoveryRun(True, None, "Grok recovery exceeded the timeout", "GROK")
    if guarded.parent_lost:
        return RecoveryRun(True, None, "Grok guardian cleaned up after AgentBus parent loss", "GROK")
    if guarded.returncode == GUARDIAN_ERROR:
        return RecoveryRun(False, None, "Grok guardian could not start or own the executor", "GROK")
    if guarded.returncode != 0:
        return RecoveryRun(True, None, "Grok exited without a durable recovery result", "GROK")
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")[-262144:]
        report = _parse_grok_json(text)
    except (RecoveryError, OSError, json.JSONDecodeError, TypeError, ValueError) as error:
        return RecoveryRun(True, None, f"invalid Grok recovery result: {error}", "GROK")
    return RecoveryRun(True, report, "Grok recovery completed", "GROK")


def _store(
    paths: PPaths,
    job_id: str,
    *,
    block_id: str,
    route: str,
    launched: bool,
    accepted: bool,
    operational_status: str,
    detail: str,
    report: Mapping[str, Any] | None,
    same_blocker: bool | None = None,
) -> bool:
    payload = {
        "recovery_id": job_id,
        "block_id": block_id,
        "route": route,
        "launched": launched,
        "accepted": accepted,
        "operational_status": operational_status,
        "detail": detail,
        "report": None if report is None else dict(report),
        "same_blocker": same_blocker,
    }
    return write_json_once(recovery_result_path(paths, job_id), payload)


def _pr_identity(snapshot: Snapshot) -> tuple[object, object, object]:
    merge = snapshot.merge
    if not merge.available:
        return None, None, None
    return merge.pr_number, merge.head_sha, merge.base_branch


def _named_absolute_paths(*texts: str | None) -> tuple[Path, ...]:
    found: list[Path] = []
    seen: set[str] = set()
    for text in texts:
        if not text:
            continue
        for match in _ABS_PATH_RE.findall(text):
            if match in seen or len(match) < 8:
                continue
            seen.add(match)
            found.append(Path(match))
    return tuple(found)


def _path_is_observable(path: Path) -> bool:
    try:
        return path.exists() and not path.is_dir()
    except OSError:
        return False


def _postcondition_holds(
    snapshot: Snapshot,
    action: Action,
    before_action: Action,
    block: BlockResult,
    report: Mapping[str, Any] | None,
) -> bool:
    if report is None or report.get("status") != "APPLIED":
        return False
    if action.kind is not before_action.kind or action.effect_id != before_action.effect_id:
        return True
    named = _named_absolute_paths(block.recovery_instruction, block.expected_postcondition)
    if named:
        return all(_path_is_observable(path) for path in named)
    expected = (block.expected_postcondition or "").strip().lower()
    if expected and expected in (action.reason or "").lower():
        return True
    return False


def run_block_recovery(
    state_root: Path,
    paths: PPaths,
    config: PConfig,
    snapshot: Snapshot,
    action: Action,
    block: BlockResult,
    *,
    route: str,
    diagnosis: Mapping[str, Any] | None = None,
    executor: RecoveryExecutor | None = None,
) -> EffectResult:
    """Execute at most one addressed recovery for an accepted BLOCK RECOVER."""
    if block.decision != "RECOVER":
        return EffectResult(False, "BLOCK decision does not authorize recovery")
    if route not in {"CODEX", "GROK"}:
        return EffectResult(False, f"unsupported recovery route: {route}")
    digest = block_result_digest(block)
    job_id = recovery_id(block_id=block.block_id, block_result_digest=digest)
    existing = load_recovery_result(paths, job_id) if recovery_result_path(paths, job_id).exists() else None
    if existing is not None:
        return EffectResult(False, f"recovery result already present: {job_id}")
    prompt = _recovery_prompt(paths, config, snapshot, action, block, diagnosis)
    prompt_path = recovery_log_dir(paths) / f"{job_id}.{route.lower()}.prompt.md"
    log_path = recovery_log_dir(paths) / f"{job_id}.{route.lower()}.log"
    before = capture_authority(config, snapshot)
    before_pr = _pr_identity(snapshot)
    before_action = action

    if executor is not None:
        run = executor(paths, config, snapshot, action, prompt, route)
    elif route == "CODEX":
        from .executor_pool import account_lock_path, load_accounts, worktree_lock_path

        run = RecoveryRun(False, None, "no configured Codex account is currently available", "CODEX")
        attempted: list[str] = []
        for account in load_accounts(state_root):
            if not account.enabled:
                continue
            run = _run_codex_recovery(
                config, snapshot, prompt, log_path,
                account_home=account.codex_home,
                worktree_lock_path=worktree_lock_path(state_root, config.worktree),
                account_lock_path=account_lock_path(state_root, account),
            )
            if run.detail.endswith("account lock is unavailable"):
                continue
            attempted.append(account.name)
            if run.detail == "worktree execution lock is unavailable":
                return EffectResult(False, run.detail)
            break
        else:
            return EffectResult(False, run.detail if not attempted else (
                "all selected Codex recovery attempts were operationally unavailable: "
                + ", ".join(attempted)
            ))
    else:
        from .executor_pool import grok_account_lock_path, load_grok_executors, worktree_lock_path

        accounts = load_grok_executors(state_root)
        if not any(account.enabled for account in accounts):
            return EffectResult(False, "RECOVERY_GROK_UNAVAILABLE")
        run = RecoveryRun(False, None, "RECOVERY_GROK_UNAVAILABLE", "GROK")
        attempted = []
        for account in accounts:
            if not account.enabled:
                continue
            run = _run_grok_recovery(
                config, snapshot, prompt, prompt_path, log_path,
                grok_home=account.grok_home, model=account.model,
                worktree_lock_path=worktree_lock_path(state_root, config.worktree),
                account_lock_path=grok_account_lock_path(state_root, account),
            )
            if run.detail.endswith("account lock is unavailable"):
                continue
            attempted.append(account.name)
            if run.detail == "worktree execution lock is unavailable":
                return EffectResult(False, run.detail)
            break
        else:
            return EffectResult(False, "RECOVERY_GROK_UNAVAILABLE")
    if not run.launched:
        return EffectResult(False, run.detail)

    after_snapshot = reread_authorized_snapshot(paths, snapshot)
    after_action = decide(after_snapshot)
    after = capture_authority(config, after_snapshot)
    after_pr = _pr_identity(after_snapshot)
    mutated = authority_mutated(before, after, allow_untracked=True) or before_pr != after_pr
    report = None
    detail_text = run.detail
    if run.report is not None:
        try:
            report = _parse_report(run.report)
        except RecoveryError as error:
            detail_text = f"invalid recovery JSON: {error}"
    if mutated:
        _store(
            paths, job_id, block_id=block.block_id, route=route, launched=True,
            accepted=False, operational_status="UNSAFE",
            detail="unsafe recovery mutation; automation stopped",
            report=report, same_blocker=True,
        )
        return EffectResult(True, f"UNSAFE recovery mutation: {job_id}")
    if report is None:
        _store(
            paths, job_id, block_id=block.block_id, route=route, launched=True,
            accepted=False, operational_status="INVALID",
            detail=detail_text, report=None, same_blocker=True,
        )
        return EffectResult(True, f"recovery operational failure: {job_id}")
    if report["status"] == "UNSAFE":
        _store(
            paths, job_id, block_id=block.block_id, route=route, launched=True,
            accepted=False, operational_status="UNSAFE",
            detail=report["summary"], report=report, same_blocker=True,
        )
        return EffectResult(True, f"UNSAFE recovery: {job_id}")
    same_blocker = (
        after_action.kind is before_action.kind
        and after_action.effect_id == before_action.effect_id
        and semantic_fact_fingerprint(after_snapshot) == semantic_fact_fingerprint(snapshot)
    )
    if report["status"] == "APPLIED" and not _postcondition_holds(
        after_snapshot, after_action, before_action, block, report
    ):
        _store(
            paths, job_id, block_id=block.block_id, route=route, launched=True,
            accepted=False, operational_status="NOT_APPLIED",
            detail="recovery postcondition could not be established",
            report=report, same_blocker=same_blocker,
        )
        return EffectResult(True, f"recovery postcondition unresolved: {job_id}")
    _store(
        paths, job_id, block_id=block.block_id, route=route, launched=True,
        accepted=report["status"] == "APPLIED",
        operational_status=report["status"],
        detail=report["summary"],
        report=report,
        same_blocker=same_blocker,
    )
    if same_blocker:
        return EffectResult(
            True,
            f"recovery completed but the exact blocker remains; HUMAN: {job_id}",
        )
    return EffectResult(True, f"recovery applied: {job_id}")



