"""Read-only Codex diagnosis for stalled semantic effects.

This is operational only.  It is not WORK, does not create WorkFact, and does
not modify AgentBus semantic facts.  A diagnosis is accepted only when Git
authority and the semantic-fact fingerprint are unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass, is_dataclass
from enum import Enum
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Callable, Mapping

from .core import Action, ActionKind, Snapshot, SpecFact, decide, stable_id
from .codex_guardian import GUARDIAN_ERROR, run_guardian
from .effects import CODEX_WORK_MODEL, EffectResult
from .facts import (
    FactError,
    PConfig,
    PPaths,
    _load_json,
    git,
    load_charter,
    load_config,
    paths_for,
    read_snapshot,
    sha256_text,
    write_json_once,
    write_text_once,
)


DIAGNOSIS_OPERATION = "READONLY_DIAGNOSIS"
DIAGNOSIS_REPORT_STATUSES = frozenset({"DIAGNOSED", "INCONCLUSIVE"})
DIAGNOSIS_DOMAINS = frozenset({
    "OPERATIONAL", "SEMANTIC_OR_SOURCE", "EXTERNAL", "UNKNOWN",
})
DIAGNOSIS_ID_RE = __import__("re").compile(r"^diagnosis-[0-9a-f]{24}$")
STALL_KINDS = frozenset({
    ActionKind.PLAN, ActionKind.WORK, ActionKind.PROVE, ActionKind.JUDGE,
})
DIAGNOSIS_TIMEOUT_SECONDS = 600.0
DIAGNOSIS_OUTPUT_SCHEMA = (
    '{"type":"object","additionalProperties":false,"properties":'
    '{"status":{"enum":["DIAGNOSED","INCONCLUSIVE"]},"summary":{"type":"string"},'
    '"root_cause":{"type":"string"},"evidence":{"type":"array","items":{"type":"string"}},'
    '"likely_domain":{"enum":["OPERATIONAL","SEMANTIC_OR_SOURCE","EXTERNAL","UNKNOWN"]}},'
    '"required":["status","summary","root_cause","evidence","likely_domain"]}'
)


class DiagnosisError(FactError):
    """An invalid or unsafe operational diagnosis artifact."""


@dataclass(frozen=True)
class AuthoritySnapshot:
    head: str
    branch: str
    refs: dict[str, str]
    porcelain: str
    semantic_fingerprint: str


@dataclass(frozen=True)
class DiagnosisRun:
    launched: bool
    report: Mapping[str, Any] | None
    detail: str


DiagnosisExecutor = Callable[..., DiagnosisRun]


def semantic_fact_fingerprint(snapshot: Snapshot) -> str:
    """Hash durable AgentBus semantic facts, not live or operational observations.

    Git HEAD/BASE, GitHub/merge projection, gpt_pending transport materialization,
    repository_available, and allow_merge are excluded.  Those have separate
    currentness or Git-authority fences and are not executor semantic mutation.
    """

    def normalize(value: Any) -> Any:
        if isinstance(value, Enum):
            return value.value
        if is_dataclass(value) and not isinstance(value, type):
            return {
                field: normalize(getattr(value, field))
                for field in value.__dataclass_fields__
            }
        if isinstance(value, dict):
            return {str(key): normalize(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [normalize(item) for item in value]
        if isinstance(value, (set, frozenset)):
            return sorted(normalize(item) for item in value)
        return value

    payload = {
        "p_id": snapshot.p_id,
        "charter_digest": snapshot.charter_digest,
        "expected_repository": snapshot.expected_repository,
        "expected_branch": snapshot.expected_branch,
        "base_ref": snapshot.base_ref,
        "specs": normalize(snapshot.specs),
        "gpt_results": normalize(snapshot.gpt_results),
        "work_facts": normalize(snapshot.work_facts),
        "proof_facts": normalize(snapshot.proof_facts),
        "expected_owner_token": snapshot.expected_owner_token,
        "proof_contract_digest": snapshot.proof_contract_digest,
        "operator_directive": normalize(snapshot.operator_directive),
    }
    return sha256_text(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def reread_authorized_snapshot(paths: PPaths, snapshot: Snapshot) -> Snapshot:
    """Reread durable facts with the same operational allow_merge projection."""
    return read_snapshot(paths, allow_merge=snapshot.allow_merge)


def observation_fingerprint(action: Action, detail: str) -> str:
    return sha256_text(
        json.dumps(
            {
                "action_kind": action.kind.value,
                "effect_id": action.effect_id,
                "detail": " ".join(str(detail or "").split()),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )


def diagnosis_id(
    *,
    p_id: str,
    action_kind: str,
    causal_effect_id: str,
    head: str,
    base: str,
    observation_fingerprint: str,
) -> str:
    return stable_id(
        "diagnosis",
        {
            "p_id": p_id,
            "action_kind": action_kind,
            "causal_effect_id": causal_effect_id,
            "head": head,
            "base": base,
            "observation_fingerprint": observation_fingerprint,
        },
    )


def diagnosis_result_dir(paths: PPaths) -> Path:
    return paths.root / "diagnosis" / "results"


def diagnosis_log_dir(paths: PPaths) -> Path:
    return paths.root / "diagnosis" / "logs"


def diagnosis_result_path(paths: PPaths, job_id: str) -> Path:
    if not DIAGNOSIS_ID_RE.fullmatch(job_id):
        raise DiagnosisError(f"invalid diagnosis id: {job_id}")
    return diagnosis_result_dir(paths) / f"{job_id}.json"


def _local_refs(worktree: Path) -> dict[str, str]:
    lines = git(
        worktree, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"
    ).splitlines()
    return dict(line.split(" ", 1) for line in lines if " " in line)


def capture_authority(config: PConfig, snapshot: Snapshot) -> AuthoritySnapshot:
    worktree = Path(config.worktree)
    return AuthoritySnapshot(
        git(worktree, "rev-parse", "HEAD"),
        git(worktree, "branch", "--show-current"),
        _local_refs(worktree),
        git(worktree, "status", "--porcelain=v1"),
        semantic_fact_fingerprint(snapshot),
    )


def tracked_porcelain(text: str) -> str:
    return "\n".join(
        line for line in str(text).splitlines() if line and not line.startswith("??")
    )


def authority_mutated(
    before: AuthoritySnapshot,
    after: AuthoritySnapshot,
    *,
    allow_untracked: bool = False,
) -> bool:
    if (
        before.head != after.head
        or before.branch != after.branch
        or before.refs != after.refs
        or before.semantic_fingerprint != after.semantic_fingerprint
    ):
        return True
    if allow_untracked:
        return tracked_porcelain(before.porcelain) != tracked_porcelain(after.porcelain)
    return before.porcelain != after.porcelain


def _current_spec(snapshot: Snapshot, action: Action) -> SpecFact | None:
    spec_id = action.payload.get("spec_id")
    if type(spec_id) is str:
        return next((item for item in snapshot.specs if item.spec_id == spec_id), None)
    return snapshot.specs[-1] if snapshot.specs else None


def load_diagnosis_result(paths: PPaths, job_id: str) -> dict[str, Any] | None:
    path = diagnosis_result_path(paths, job_id)
    if not path.exists():
        return None
    value = _load_json(path)
    if value.get("diagnosis_id") != job_id:
        raise DiagnosisError(f"diagnosis result identity mismatch: {job_id}")
    return value


def current_diagnosis(
    paths: PPaths,
    snapshot: Snapshot,
    action: Action,
    *,
    detail: str = "",
) -> dict[str, Any] | None:
    if action.kind not in STALL_KINDS or not action.effect_id:
        return None
    job_id = diagnosis_id(
        p_id=snapshot.p_id,
        action_kind=action.kind.value,
        causal_effect_id=action.effect_id,
        head=snapshot.head,
        base=snapshot.base,
        observation_fingerprint=observation_fingerprint(action, detail),
    )
    try:
        value = load_diagnosis_result(paths, job_id)
    except (DiagnosisError, FactError):
        return None
    if value is None or not value.get("accepted"):
        return value
    identity = value.get("identity") if isinstance(value.get("identity"), dict) else {}
    if (
        identity.get("p_id") != snapshot.p_id
        or identity.get("action_kind") != action.kind.value
        or identity.get("causal_effect_id") != action.effect_id
        or identity.get("head") != snapshot.head
        or identity.get("base") != snapshot.base
    ):
        return {**value, "accepted": False, "operational_status": "STALE"}
    return value


def _store(
    paths: PPaths,
    job_id: str,
    identity: Mapping[str, Any],
    *,
    accepted: bool,
    operational_status: str,
    detail: str,
    report: Mapping[str, Any] | None = None,
) -> bool:
    payload = {
        "diagnosis_id": job_id,
        "identity": dict(identity),
        "accepted": accepted,
        "operational_status": operational_status,
        "detail": detail,
        "report": None if report is None else dict(report),
    }
    return write_json_once(diagnosis_result_path(paths, job_id), payload)


def _parse_report(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "status", "summary", "root_cause", "evidence", "likely_domain",
    }:
        raise DiagnosisError("diagnosis report has unexpected fields")
    if (
        value["status"] not in DIAGNOSIS_REPORT_STATUSES
        or type(value["summary"]) is not str
        or not value["summary"].strip()
        or type(value["root_cause"]) is not str
        or not value["root_cause"].strip()
        or type(value["likely_domain"]) is not str
        or value["likely_domain"] not in DIAGNOSIS_DOMAINS
        or not isinstance(value["evidence"], list)
        or any(type(item) is not str for item in value["evidence"])
    ):
        raise DiagnosisError("diagnosis report fields are invalid")
    return {
        "status": value["status"],
        "summary": value["summary"].strip(),
        "root_cause": value["root_cause"].strip(),
        "evidence": list(value["evidence"])[:16],
        "likely_domain": value["likely_domain"],
    }


def _diagnosis_prompt(
    paths: PPaths,
    config: PConfig,
    snapshot: Snapshot,
    action: Action,
    context: Mapping[str, Any],
) -> str:
    spec = _current_spec(snapshot, action)
    charter = load_charter(paths, config)
    merge = snapshot.merge
    work = snapshot.work_facts[-1] if snapshot.work_facts else None
    proof = snapshot.proof_facts[-1] if snapshot.proof_facts else None
    judge = next(
        (item for item in reversed(snapshot.gpt_results) if item.operation == "JUDGE_GPT"),
        None,
    )
    evidence = {
        "p_id": config.p_id,
        "action_kind": action.kind.value,
        "causal_effect_id": action.effect_id,
        "spec_id": None if spec is None else spec.spec_id,
        "head": snapshot.head,
        "base": snapshot.base,
        "repository": config.repository,
        "branch": config.branch,
        "pr_number": merge.pr_number if merge.available else None,
        "pr_head": merge.head_sha if merge.available else None,
        "pr_base_sha": merge.pr_base_sha if merge.available else None,
        "check_status": merge.check_status if merge.available else None,
        "work_status": None if work is None else work.status.value,
        "proof_status": None if proof is None else proof.status.value,
        "proof_summary": None if proof is None else proof.summary[:500],
        "judge_decision": None if judge is None else judge.decision,
        "context": dict(context),
    }
    spec_text = spec.text if spec is not None else "NONE"
    return f"""You are a read-only diagnostic probe for Yuvi AgentBus v2.

Inspect the current repository and the supplied facts. Do not modify anything.
Do not create commits, change refs, edit files, write AgentBus semantic facts,
or execute recovery. likely_domain is diagnostic evidence only and is not
semantic authority.

P_CHARTER:
{charter.rstrip()}

CURRENT_SPEC:
{spec_text}

CURRENT FACTS:
```json
{json.dumps(evidence, sort_keys=True, ensure_ascii=False, separators=(",", ":"))}
```

Return exactly one JSON object matching the supplied schema.
"""


def _codex_diagnosis_command(
    config: PConfig, schema_path: Path, response_path: Path
) -> tuple[str, ...]:
    return (
        "codex", "exec", "--ephemeral",
        "--sandbox", "read-only",
        "--ask-for-approval", "never",
        "--model", CODEX_WORK_MODEL,
        "-C", config.worktree,
        "--output-schema", str(schema_path),
        "--output-last-message", str(response_path),
        "-",
    )


def _run_codex_diagnosis(
    paths: PPaths,
    config: PConfig,
    snapshot: Snapshot,
    action: Action,
    prompt: str,
    log_path: Path,
    *,
    account_home: Path,
    worktree_lock_path: Path,
    account_lock_path: Path,
) -> DiagnosisRun:
    response_path = log_path.with_suffix(".response.json")
    response_path.unlink(missing_ok=True)
    schema = tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False)
    schema_path = Path(schema.name)
    try:
        schema.write(DIAGNOSIS_OUTPUT_SCHEMA)
        schema.close()
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(account_home)
        guarded = run_guardian(
            _codex_diagnosis_command(config, schema_path, response_path),
            cwd=Path(config.worktree),
            env=environment,
            log_path=log_path,
            timeout=DIAGNOSIS_TIMEOUT_SECONDS,
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
        return DiagnosisRun(False, None, "worktree execution lock is unavailable")
    if guarded.account_busy:
        return DiagnosisRun(False, None, "Codex account lock is unavailable")
    if guarded.identity_drift:
        return DiagnosisRun(False, None, "identities drifted before diagnosis")
    if guarded.timed_out:
        return DiagnosisRun(True, None, "Codex diagnosis exceeded the timeout")
    if guarded.parent_lost:
        return DiagnosisRun(True, None, "Codex guardian cleaned up after AgentBus parent loss")
    if guarded.returncode == GUARDIAN_ERROR:
        return DiagnosisRun(False, None, "Codex guardian could not start or own the executor")
    if guarded.returncode != 0 or not response_path.exists():
        return DiagnosisRun(True, None, "Codex exited without a durable diagnosis")
    try:
        report = _parse_report(_load_json(response_path))
    except (DiagnosisError, FactError) as error:
        return DiagnosisRun(True, None, f"invalid diagnosis JSON: {error}")
    return DiagnosisRun(True, report, "read-only Codex diagnosis completed")


def run_readonly_diagnosis(
    state_root: Path,
    paths: PPaths,
    config: PConfig,
    snapshot: Snapshot,
    action: Action,
    *,
    detail: str = "",
    context: Mapping[str, Any] | None = None,
    executor: DiagnosisExecutor | None = None,
) -> EffectResult:
    """Launch exactly one read-only Codex diagnosis for the current effect."""
    if action.kind not in STALL_KINDS or not action.effect_id:
        return EffectResult(False, "read-only diagnosis is not applicable")
    fingerprint = observation_fingerprint(action, detail)
    job_id = diagnosis_id(
        p_id=snapshot.p_id,
        action_kind=action.kind.value,
        causal_effect_id=action.effect_id,
        head=snapshot.head,
        base=snapshot.base,
        observation_fingerprint=fingerprint,
    )
    identity = {
        "p_id": snapshot.p_id,
        "action_kind": action.kind.value,
        "causal_effect_id": action.effect_id,
        "head": snapshot.head,
        "base": snapshot.base,
        "observation_fingerprint": fingerprint,
    }
    existing = load_diagnosis_result(paths, job_id) if diagnosis_result_path(paths, job_id).exists() else None
    if existing is not None:
        return EffectResult(False, f"diagnosis result already present: {job_id}")
    prompt = _diagnosis_prompt(paths, config, snapshot, action, context or {"detail": detail})
    prompt_path = diagnosis_log_dir(paths) / f"{job_id}.prompt.md"
    log_path = diagnosis_log_dir(paths) / f"{job_id}.codex.log"
    write_text_once(prompt_path, prompt)
    before = capture_authority(config, snapshot)

    if executor is not None:
        run = executor(paths, config, snapshot, action, prompt)
    else:
        from .executor_pool import (
            account_lock_path,
            load_accounts,
            worktree_lock_path,
        )

        accounts = load_accounts(state_root)
        run = DiagnosisRun(False, None, "no configured Codex account is currently available")
        attempted: list[str] = []
        for account in accounts:
            if not account.enabled:
                continue
            run = _run_codex_diagnosis(
                paths, config, snapshot, action, prompt, log_path,
                account_home=account.codex_home,
                worktree_lock_path=worktree_lock_path(state_root, config.worktree),
                account_lock_path=account_lock_path(state_root, account),
            )
            if run.detail == "Codex account lock is unavailable":
                continue
            attempted.append(account.name)
            if run.detail == "worktree execution lock is unavailable":
                return EffectResult(False, run.detail)
            break
        else:
            if not attempted:
                return EffectResult(False, run.detail)
            return EffectResult(
                False,
                "all selected Codex diagnosis attempts were operationally unavailable: "
                + ", ".join(attempted),
            )
    if not run.launched:
        return EffectResult(False, run.detail)
    report = None
    detail_text = run.detail
    if run.report is not None:
        try:
            report = _parse_report(run.report)
        except DiagnosisError as error:
            detail_text = f"invalid diagnosis JSON: {error}"

    after_snapshot = reread_authorized_snapshot(paths, snapshot)
    after_action = decide(after_snapshot)
    after = capture_authority(config, after_snapshot)
    if authority_mutated(before, after):
        _store(
            paths, job_id, identity, accepted=False,
            operational_status="UNSAFE",
            detail="unsafe diagnostic mutation; diagnosis rejected",
        )
        return EffectResult(True, f"UNSAFE diagnostic mutation: {job_id}")
    if (
        after_action.kind is not action.kind
        or after_action.effect_id != action.effect_id
        or after_snapshot.head != snapshot.head
        or after_snapshot.base != snapshot.base
        or after_snapshot.p_id != snapshot.p_id
    ):
        _store(
            paths, job_id, identity, accepted=False,
            operational_status="STALE",
            detail="diagnosis is no longer current",
            report=report,
        )
        return EffectResult(True, f"stale diagnosis discarded: {job_id}")
    if report is None:
        _store(
            paths, job_id, identity, accepted=False,
            operational_status="INVALID",
            detail=detail_text,
        )
        return EffectResult(True, f"diagnosis operational failure: {job_id}")
    _store(
        paths, job_id, identity, accepted=True,
        operational_status="ACCEPTED",
        detail=detail_text,
        report=report,
    )
    return EffectResult(True, f"read-only diagnosis accepted: {job_id}")
