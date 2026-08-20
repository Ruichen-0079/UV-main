from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any, Iterable, Mapping, Sequence

from .core import (
    ActionKind,
    JUDGE_RESULTS,
    PLAN_RESULTS,
    GPT_PACKET_SCHEMA,
    PROOF_SCHEMA,
    GptResult,
    Observation,
    ProofFact,
    Snapshot,
    SpecFact,
    WorkFact,
    judge_job_id,
    plan_facts_digest,
    plan_job_id,
    proof_id,
    spec_id,
    stable_id,
    work_effect_id,
    work_identity_id,
    decide,
)


SHA_RE = re.compile(r"^[0-9a-f]{40}$")
P_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
TRAILER_RE = re.compile(r"^AgentBus-V2-([A-Za-z-]+):\s*(.+?)\s*$")
GPT_JOB_RE = re.compile(r"^(?:plan|judge)-[0-9a-f]{24}$")


class FactError(RuntimeError):
    pass


@dataclass(frozen=True)
class PConfig:
    p_id: str
    worktree: str
    repository: str
    remote: str
    branch: str
    base_ref: str
    seed_head: str
    charter_digest: str
    proof_commands: tuple[tuple[str, ...], ...]
    required_ci_checks: tuple[str, ...]

    @property
    def owner_token(self) -> str:
        return stable_id("owner", {"p_id": self.p_id, "repository": self.repository, "branch": self.branch, "seed_head": self.seed_head})


@dataclass(frozen=True)
class PPaths:
    root: Path

    def create_dirs(self) -> None:
        for path in ("gpt/outbox", "gpt/results", "work/results", "work/logs", "prove/results"):
            (self.root / path).mkdir(parents=True, exist_ok=True)
def paths_for(state_root: Path, p_id: str) -> PPaths:
    if not P_ID_RE.fullmatch(p_id):
        raise FactError(f"invalid P_ID: {p_id!r}")
    return PPaths(state_root.resolve() / p_id)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_repository(value: str) -> str:
    result = value.strip()
    result = re.sub(r"^[a-z]+://", "", result)
    result = re.sub(r"^[^@]+@([^:]+):", r"\1/", result)
    result = result.removesuffix(".git").rstrip("/")
    return result


def _run(
    argv: Sequence[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
    timeout: float = 30,
) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            list(argv),
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise FactError(f"command unavailable: {argv[0]}: {error}") from error
    if check and completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise FactError(f"command failed ({completed.returncode}): {' '.join(argv)}: {detail}")
    return completed


def git(worktree: Path, *args: str, check: bool = True) -> str:
    return _run(("git", *args), cwd=worktree, check=check).stdout.strip()


def live_remote_sha(worktree: Path, remote: str, ref: str) -> str:
    output = git(worktree, "ls-remote", "--exit-code", remote, f"refs/heads/{ref}")
    fields = output.split()
    if not fields or not SHA_RE.fullmatch(fields[0]):
        raise FactError(f"remote branch {remote}/{ref} did not resolve to one SHA")
    return fields[0]


def write_json_once(path: Path, value: Mapping[str, Any]) -> bool:
    data = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    return write_text_once(path, data)


def write_text_once(path: Path, text: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{os.urandom(4).hex()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
            return True
        except FileExistsError:
            try:
                existing = path.read_text(encoding="utf-8")
            except OSError as error:
                raise FactError(f"cannot verify immutable fact {path}: {error}") from error
            if existing != text:
                raise FactError(f"conflicting immutable fact: {path}")
            return False
    finally:
        temporary.unlink(missing_ok=True)


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FactError(f"invalid JSON fact {path}: {error}") from error
    if not isinstance(value, dict):
        raise FactError(f"JSON fact must be an object: {path}")
    return value


def init_p(
    state_root: Path,
    *,
    p_id: str,
    charter_text: str,
    worktree: Path,
    repository: str,
    branch: str,
    base_ref: str = "main",
    remote: str = "origin",
    proof_commands: Iterable[tuple[str, ...]] = (),
    required_ci_checks: Iterable[str] = (),
) -> PPaths:
    paths = paths_for(state_root, p_id)
    worktree = worktree.resolve()
    actual_root = Path(git(worktree, "rev-parse", "--show-toplevel")).resolve()
    if actual_root != worktree:
        raise FactError(f"worktree must be its Git root: {worktree}")
    actual_branch = git(worktree, "branch", "--show-current")
    if actual_branch != branch:
        raise FactError(f"branch mismatch: expected {branch}, found {actual_branch}")
    actual_repository = canonical_repository(git(worktree, "remote", "get-url", remote))
    expected_repository = canonical_repository(repository)
    if actual_repository != expected_repository:
        raise FactError(
            f"repository mismatch: expected {expected_repository}, found {actual_repository}"
        )
    head = git(worktree, "rev-parse", "HEAD")
    base = live_remote_sha(worktree, remote, base_ref)
    if git(worktree, "status", "--porcelain=v1"):
        raise FactError("P initialization requires a clean dedicated worktree")
    if head != base:
        raise FactError("P initialization HEAD must equal the freshly read live BASE")
    commands = tuple(tuple(str(arg) for arg in command) for command in proof_commands)
    if any(not command for command in commands):
        raise FactError("proof command argv cannot be empty")
    checks = tuple(str(check) for check in required_ci_checks)
    remote_branch = _run(
        ("git", "ls-remote", "--exit-code", "--heads", remote, f"refs/heads/{branch}"),
        cwd=worktree,
        check=False,
    )
    config_path = paths.root / "config.json"
    charter_path = paths.root / "charter.md"
    if remote_branch.returncode == 0 and not config_path.exists():
        raise FactError("refusing to claim an existing remote experiment branch")
    if remote_branch.returncode not in {0, 2}:
        raise FactError("cannot verify experiment branch ownership at the remote")
    charter = charter_text.replace("\r\n", "\n").strip() + "\n"
    charter_digest = sha256_text(charter)
    config = {
        "p_id": p_id,
        "worktree": str(worktree),
        "repository": expected_repository,
        "remote": remote,
        "branch": branch,
        "base_ref": base_ref,
        "seed_head": head,
        "charter_digest": charter_digest,
        "proof_commands": [list(command) for command in commands],
        "required_ci_checks": list(checks),
    }
    if config_path.exists():
        existing = load_config(paths)
        if charter_path.read_text(encoding="utf-8") != charter or asdict(existing) != asdict(
            _parse_config(config, config_path)
        ):
            raise FactError(f"P directory already exists with different facts: {paths.root}")
        return paths
    paths.create_dirs()
    write_text_once(charter_path, charter)
    write_json_once(config_path, config)
    return paths


def _parse_config(value: Mapping[str, Any], source: Path) -> PConfig:
    try:
        raw_commands = value.get("proof_commands", [])
        if not isinstance(raw_commands, list) or any(
            not isinstance(item, list) for item in raw_commands
        ):
            raise TypeError("proof_commands must be a list of argv lists")
        commands = tuple(tuple(str(arg) for arg in item) for item in raw_commands)
        config = PConfig(
            p_id=str(value["p_id"]),
            worktree=str(value["worktree"]),
            repository=canonical_repository(str(value["repository"])),
            remote=str(value["remote"]),
            branch=str(value["branch"]),
            base_ref=str(value["base_ref"]),
            seed_head=str(value["seed_head"]),
            charter_digest=str(value["charter_digest"]),
            proof_commands=commands,
            required_ci_checks=tuple(
                str(item) for item in value.get("required_ci_checks", [])
            ),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise FactError(f"invalid P config {source}: {error}") from error
    if not P_ID_RE.fullmatch(config.p_id):
        raise FactError(f"invalid P_ID in {source}")
    if not SHA_RE.fullmatch(config.seed_head):
        raise FactError(f"invalid seed HEAD in {source}")
    if any(not command for command in commands):
        raise FactError(f"empty proof command in {source}")
    return config


def load_config(paths: PPaths) -> PConfig:
    path = paths.root / "config.json"
    return _parse_config(_load_json(path), path)


def load_charter(paths: PPaths, config: PConfig) -> str:
    path = paths.root / "charter.md"
    try:
        charter = path.read_text(encoding="utf-8")
    except OSError as error:
        raise FactError(f"cannot read charter {path}: {error}") from error
    if sha256_text(charter) != config.charter_digest:
        raise FactError("P_CHARTER changed after initialization")
    return charter


GPT_DECISIONS = {
    "PLAN_GPT": PLAN_RESULTS,
    "JUDGE_GPT": JUDGE_RESULTS,
}


def parse_gpt_response(
    expected_job_id: str,
    expected_operation: str,
    value: Mapping[str, Any],
    source: str = "GPT response",
) -> GptResult:
    keys = {"job_id", "operation", "decision", "body"}
    if not isinstance(value, Mapping) or set(value) != keys:
        raise FactError(f"{source} keys must be exactly job_id, operation, decision, body")
    if any(type(item) is not str for item in value.values()):
        raise FactError(f"{source} fields must all be JSON strings")
    if value["job_id"] != expected_job_id or not GPT_JOB_RE.fullmatch(expected_job_id):
        message = "JOB_ID mismatch" if value["job_id"] != expected_job_id else "JOB_ID has an invalid shape"
        raise FactError(f"{source} {message}")
    if value["operation"] != expected_operation:
        raise FactError(f"{source} operation mismatch")
    allowed = GPT_DECISIONS.get(expected_operation)
    if allowed is None:
        raise FactError(f"{source} operation is invalid")
    if value["decision"] not in allowed:
        raise FactError(f"{source} decision is not allowed for {expected_operation}")
    if not value["body"].strip():
        raise FactError(f"{source} body must be nonempty")
    return GptResult(value["job_id"], value["operation"], value["decision"], value["body"])


def load_gpt_packet(paths: PPaths, job_id: str) -> dict[str, Any]:
    path = paths.root / "gpt" / "outbox" / f"{job_id}.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise FactError(f"GPT packet is absent: {path}") from error
    try:
        encoded = text.split("## SEMANTIC INPUTS\n```json\n", 1)[1].split("\n```", 1)[0]
        packet = json.loads(encoded)
    except (IndexError, json.JSONDecodeError) as error:
        raise FactError(f"GPT packet semantic inputs are malformed: {path}") from error
    semantic = packet.get("semantic_input") if isinstance(packet, dict) else None
    if (
        not isinstance(packet, dict)
        or packet.get("packet_schema") != GPT_PACKET_SCHEMA
        or packet.get("job_id") != job_id
        or packet.get("operation") not in GPT_DECISIONS
        or not isinstance(semantic, dict)
        or semantic.get("job_id") != job_id
        or semantic.get("operation") != packet.get("operation")
    ):
        raise FactError(f"GPT packet lacks semantic inputs: {path}")
    return packet

def _load_gpt_result(
    paths: PPaths, job_id: str, operation: str
) -> GptResult | None:
    path = paths.root / "gpt" / "results" / f"{job_id}.json"
    return (
        parse_gpt_response(job_id, operation, _load_json(path), str(path))
        if path.exists() else None
    )

def _load_plan_spec(
    paths: PPaths, config: PConfig, identity: Snapshot,
    parent: SpecFact | None, trigger: str | None, job_id: str | None = None,
) -> tuple[str, GptResult | None, SpecFact | None]:
    direct = job_id is not None
    if job_id is None:
        job_id = plan_job_id(
            identity, parent_spec_id=parent.spec_id if parent else None,
            trigger_judge_id=trigger,
        )
    result = _load_gpt_result(paths, job_id, "PLAN_GPT")
    if result is None or result.decision != "SPEC":
        return job_id, result, None
    packet = load_gpt_packet(paths, job_id)
    semantic = packet["semantic_input"]
    if direct:
        packet_head, packet_base = semantic.get("head"), semantic.get("base")
        parent_id, trigger = semantic.get("parent_spec_id"), semantic.get("trigger_judge_id")
        valid = (
            type(packet_head) is str and type(packet_base) is str
            and SHA_RE.fullmatch(packet_head) and SHA_RE.fullmatch(packet_base)
            and (parent_id is None or type(parent_id) is str)
            and (trigger is None or GPT_JOB_RE.fullmatch(str(trigger)))
        )
        if not valid:
            raise FactError(f"PLAN packet identity is malformed: {job_id}")
        identity = _identity(config, packet_head, packet_base, "")
        if plan_job_id(identity, parent_spec_id=parent_id, trigger_judge_id=trigger) != job_id:
            raise FactError(f"PLAN packet identity mismatch: {job_id}")
    else:
        parent_id = parent.spec_id if parent else None
    expected_planning = plan_facts_digest(identity)
    if packet["operation"] != "PLAN_GPT" or any(
        semantic.get(key) != expected
        for key, expected in {
            "parent_spec_id": parent_id, "trigger_judge_id": trigger,
            "head": identity.head, "base": identity.base,
            "planning_facts_digest": expected_planning,
        }.items()
    ):
        raise FactError(f"PLAN packet identity mismatch: {job_id}")
    return job_id, result, SpecFact(
        spec_id(config.charter_digest, expected_planning, result.body), result.body,
        parent_id, trigger, job_id,
    )

def _load_work(
    paths: PPaths, config: PConfig, identity: Snapshot, spec: SpecFact,
    trigger: str | None = None, recovered: WorkFact | None = None,
) -> WorkFact | None:
    effect_id = work_effect_id(identity, spec, trigger_judge_id=trigger)
    if recovered is not None and recovered.effect_id == effect_id:
        return recovered
    path = paths.root / "work" / "results" / f"{effect_id}.json"
    if not path.exists():
        return None
    value = _load_json(path)
    if set(value) != {
        "effect_id", "spec_id", "input_head", "status", "evidence_digest", "trigger_judge_id",
    } or value.get("status") != Observation.FAIL.value:
        raise FactError(f"invalid WORK result: {path}")
    if any(type(value[key]) is not str for key in (
        "effect_id", "spec_id", "input_head", "status", "evidence_digest",
    )):
        raise FactError(f"WORK result fields have invalid types: {path}")
    stored_trigger = value.get("trigger_judge_id")
    if stored_trigger is not None and type(stored_trigger) is not str:
        raise FactError(f"WORK result trigger has an invalid type: {path}")
    if (
        value["effect_id"] != effect_id
        or value["spec_id"] != spec.spec_id
        or value["input_head"] != identity.head
        or stored_trigger != trigger
        or not SHA_RE.fullmatch(value["input_head"])
        or (stored_trigger is not None and not GPT_JOB_RE.fullmatch(stored_trigger))
    ):
        raise FactError(f"invalid WORK result identity/status: {path}")
    return WorkFact(
        effect_id=effect_id, spec_id=spec.spec_id, input_head=identity.head,
        status=Observation.FAIL, evidence_digest=value["evidence_digest"],
        trigger_judge_id=trigger,
    )

def _work_from_head(config: PConfig, head: str) -> WorkFact | None:
    worktree = Path(config.worktree)
    message = git(worktree, "show", "-s", "--format=%B", head)
    trailers = {
        match.group(1): match.group(2)
        for line in message.splitlines()
        if (match := TRAILER_RE.match(line))
    }
    required = {"P", "Spec", "Work", "Input-Head"}
    if not required.issubset(trailers):
        return None
    if trailers["P"] != config.p_id:
        return None
    trigger = trailers.get("Trigger")
    if trigger in (None, "", "NONE"):
        trigger = None
    elif not GPT_JOB_RE.fullmatch(trigger):
        raise FactError("invalid WORK commit Trigger trailer")
    plan = trailers.get("Plan")
    if plan is not None and not GPT_JOB_RE.fullmatch(plan):
        raise FactError("invalid WORK commit Plan trailer")
    expected_effect = work_identity_id(
        config.p_id, trailers["Spec"], trailers["Input-Head"], trigger,
    )
    if trailers["Work"] != expected_effect:
        raise FactError("WORK commit trailers do not match deterministic effect identity")
    input_head = trailers["Input-Head"]
    if not SHA_RE.fullmatch(input_head) or input_head == head:
        raise FactError("invalid WORK commit Input-Head trailer")
    ancestor = _run(
        ("git", "merge-base", "--is-ancestor", input_head, head),
        cwd=worktree,
        check=False,
    )
    if ancestor.returncode != 0:
        raise FactError("WORK commit Input-Head is not an ancestor of HEAD")
    return WorkFact(
        effect_id=trailers["Work"],
        spec_id=trailers["Spec"],
        input_head=input_head,
        status=Observation.PASS,
        evidence_digest=sha256_text(f"{head}\n{message}"),
        output_head=head,
        trigger_judge_id=trigger,
        plan_job_id=plan,
    )

def _proof_commands(
    config: PConfig, base: str = "<BASE>", head: str = "<HEAD>"
) -> tuple[tuple[str, ...], ...]:
    return (
        ("git", "status", "--porcelain=v1"),
        ("git", "diff", "--check", f"{base}...{head}"),
        ("git", "merge-tree", "--write-tree", base, head),
        *config.proof_commands,
        ("git", "status", "--porcelain=v1"),
    )

def proof_contract_digest(config: PConfig) -> str:
    commands = _proof_commands(config)
    return stable_id("proofcontract", {
        "schema": PROOF_SCHEMA,
        "commands": [list(command) for command in commands],
        "required_ci_checks": list(config.required_ci_checks),
    })

def _validate_proof_commands(
    value: list[Any], config: PConfig, head: str, base: str, status: str, path: Path
) -> None:
    expected = _proof_commands(config, base, head)
    if not value or len(value) > len(expected):
        raise FactError(f"PROVE command evidence has an invalid length: {path}")
    first_failure: int | None = None
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != {
            "argv", "exit_code", "output", "output_digest"
        }:
            raise FactError(f"PROVE command evidence has invalid fields: {path}")
        argv = item["argv"]
        if (
            not isinstance(argv, list)
            or argv != list(expected[index])
            or any(type(arg) is not str for arg in argv)
            or type(item["exit_code"]) is not int
            or not isinstance(item["output"], str)
            or type(item["output_digest"]) is not str
            or not re.fullmatch(r"[0-9a-f]{64}", item["output_digest"])
            or len(item["output"]) > 65536
        ):
            raise FactError(f"PROVE command evidence does not match contract: {path}")
        if len(item["output"]) < 65536 and sha256_text(item["output"]) != item["output_digest"]:
            raise FactError(f"PROVE command output digest mismatch: {path}")
        if item["exit_code"] != 0 and first_failure is None:
            first_failure = index
    if status == Observation.PASS.value:
        if len(value) != len(expected) or first_failure is not None:
            raise FactError(f"PROVE PASS lacks complete passing commands: {path}")
    elif first_failure is None:
        raise FactError(f"PROVE FAIL lacks a confirmed command failure: {path}")
    elif any(item["exit_code"] != 0 for item in value[first_failure + 1:]):
        raise FactError(f"PROVE command evidence continues after failure: {path}")

def _validate_proof_ci(
    value: list[Any], failed_logs: dict[str, Any], config: PConfig,
    local_commands: list[Any], status: str, path: Path,
) -> None:
    if any(not isinstance(item, dict) for item in value) or any(
        not isinstance(key, str) or not isinstance(item, str)
        for key, item in failed_logs.items()
    ):
        raise FactError(f"PROVE CI evidence has invalid types: {path}")
    local_failed = any(
        isinstance(item, dict) and item.get("exit_code") != 0 for item in local_commands
    )
    if local_failed:
        if value or failed_logs:
            raise FactError(f"local PROVE failure contains CI evidence: {path}")
        return
    if status != Observation.PASS.value and not config.required_ci_checks:
        raise FactError(f"PROVE FAIL lacks required CI evidence: {path}")
    checks = [item for item in value if isinstance(item, dict)]
    for required in config.required_ci_checks:
        matches = [
            item for item in checks
            if item.get("name") == required
            or f"{item.get('workflow')} / {item.get('name')}" == required
        ]
        if not matches or any(item.get("bucket") != "pass" for item in matches):
            if status == Observation.PASS.value:
                raise FactError(f"PROVE PASS lacks required CI evidence: {path}")


def _identity(config: PConfig, head: str, base: str, contract: str) -> Snapshot:
    return Snapshot(
        p_id=config.p_id, charter_digest=config.charter_digest,
        expected_repository=config.repository, expected_branch=config.branch,
        base_ref=config.base_ref, head=head, base=base,
        proof_contract_digest=contract,
    )


def _load_proof(
    paths: PPaths, config: PConfig, spec: SpecFact, head: str, base: str,
    contract_digest: str, trigger: str | None = None,
) -> ProofFact | None:
    identity = _identity(config, head, base, contract_digest)
    proof_key = proof_id(identity, spec, trigger_judge_id=trigger)
    path = paths.root / "prove" / "results" / f"{proof_key}.json"
    if not path.exists():
        return None
    value = _load_json(path)
    fields = {
        "schema", "proof_id", "spec_id", "head", "base", "status", "trigger_judge_id",
        "contract_digest", "summary", "local_commands", "github_checks", "failed_ci_logs", "evidence_digest",
    }
    if set(value) != fields or value.get("schema") != PROOF_SCHEMA:
        raise FactError(f"PROVE result has unexpected fields: {path}")
    if any(value.get(key) != expected for key, expected in {
        "proof_id": proof_key, "spec_id": spec.spec_id, "head": head, "base": base,
        "trigger_judge_id": trigger, "contract_digest": contract_digest,
    }.items()) or value["status"] not in {Observation.PASS.value, Observation.FAIL.value}:
        raise FactError(f"PROVE result identity/status mismatch: {path}")
    if any(type(value.get(key)) is not str for key in (
        "proof_id", "spec_id", "head", "base", "status", "contract_digest",
        "summary", "evidence_digest",
    )) or not isinstance(value["local_commands"], list) \
            or not isinstance(value["github_checks"], list) \
            or not isinstance(value["failed_ci_logs"], dict):
        raise FactError(f"PROVE result fields have invalid types: {path}")
    if (
        not value["summary"].strip()
        or not re.fullmatch(r"[0-9a-f]{64}", value["evidence_digest"])
        or not SHA_RE.fullmatch(value["head"])
        or not SHA_RE.fullmatch(value["base"])
    ):
        raise FactError(f"PROVE result fields are malformed: {path}")
    _validate_proof_commands(value["local_commands"], config, head, base, value["status"], path)
    _validate_proof_ci(
        value["github_checks"], value["failed_ci_logs"], config,
        value["local_commands"], value["status"], path,
    )
    evidence = {
        "local_commands": value["local_commands"],
        "github_checks": value["github_checks"],
        "failed_ci_logs": value["failed_ci_logs"],
    }
    if sha256_text(json.dumps(evidence, sort_keys=True)) != value["evidence_digest"]:
        raise FactError(f"PROVE evidence digest mismatch: {path}")
    return ProofFact(
        proof_id=proof_key, spec_id=spec.spec_id, head=head, base=base,
        status=Observation(value["status"]), evidence_digest=value["evidence_digest"],
        trigger_judge_id=trigger, summary=value["summary"],
    )


def _judge_result(
    paths: PPaths, identity: Snapshot, spec: SpecFact, step: str,
    evidence_id: str, evidence_digest: str,
) -> GptResult | None:
    return _load_gpt_result(
        paths,
        judge_job_id(
            identity, spec, failed_step=step, evidence_id=evidence_id,
            evidence_digest=evidence_digest,
        ),
        "JUDGE_GPT",
    )


def _current_stage(
    paths: PPaths, config: PConfig, identity: Snapshot, spec: SpecFact,
) -> tuple[tuple[WorkFact, ...], tuple[ProofFact, ...], tuple[GptResult, ...], GptResult | None]:
    recovered = _work_from_head(config, identity.head)
    recovered_current = recovered if recovered and recovered.spec_id == spec.spec_id else None
    work = recovered_current or _load_work(paths, config, identity, spec)
    if work is None:
        return (), (), (), None
    stage_results: list[GptResult] = []
    if work.status is Observation.FAIL:
        judge = _judge_result(paths, identity, spec, "WORK", work.effect_id, work.evidence_digest)
        if judge:
            stage_results.append(judge)
        if judge is not None and judge.decision == "RETURN_WORK":
            retry = _load_work(
                paths, config, identity, spec, trigger=judge.job_id,
                recovered=recovered_current,
            )
            if retry is not None:
                work = retry
                if work.status is Observation.PASS:
                    return (work,), (), tuple(stage_results), None
                judge = _judge_result(paths, identity, spec, "WORK", work.effect_id, work.evidence_digest)
                if judge:
                    stage_results.append(judge)
        return (work,), (), tuple(stage_results), judge if judge and judge.decision == "RETURN_PLAN" else None
    proof = _load_proof(
        paths, config, spec, identity.head, identity.base, identity.proof_contract_digest
    )
    if proof is None:
        return (work,), (), (), None
    step = "PROVE_MECHANICAL" if proof.status is Observation.FAIL else "PROVE_SEMANTIC"
    judge = _judge_result(paths, identity, spec, step, proof.proof_id, proof.evidence_digest)
    if judge:
        stage_results.append(judge)
    if judge is not None and judge.decision == "RETURN_PROVE":
        retry = _load_proof(
            paths, config, spec, identity.head, identity.base,
            identity.proof_contract_digest, trigger=judge.job_id,
        )
        if retry is not None:
            proof = retry
            step = "PROVE_MECHANICAL" if proof.status is Observation.FAIL else "PROVE_SEMANTIC"
            retry_judge = _judge_result(
                paths, identity, spec, step, proof.proof_id, proof.evidence_digest,
            )
            if retry_judge:
                stage_results.append(retry_judge)
            judge = retry_judge
    return (work,), (proof,), tuple(stage_results), judge if judge and judge.decision == "RETURN_PLAN" else None


def _load_current(
    paths: PPaths, config: PConfig, head: str, base: str, contract_digest: str,
) -> tuple[tuple[GptResult, ...], tuple[SpecFact, ...], frozenset[str],
           tuple[WorkFact, ...], tuple[ProofFact, ...]]:
    identity = _identity(config, head, base, contract_digest)
    results: list[GptResult] = []
    specs: list[SpecFact] = []
    parent: SpecFact | None = None
    trigger: str | None = None
    work: tuple[WorkFact, ...] = ()
    proof: tuple[ProofFact, ...] = ()
    seen: set[str] = set()
    recovered = _work_from_head(config, head)
    head_plan = recovered.plan_job_id if recovered else None
    while True:
        if head_plan is not None:
            job_id = head_plan
            job_id, result, spec = _load_plan_spec(paths, config, identity, parent, trigger, job_id)
            head_plan = None
        else:
            job_id, result, spec = _load_plan_spec(paths, config, identity, parent, trigger)
        if job_id in seen:
            raise FactError(f"PLAN lineage cycle: {job_id}")
        seen.add(job_id)
        if result is None:
            pending = (
                frozenset({job_id})
                if (paths.root / "gpt" / "outbox" / f"{job_id}.md").exists()
                else frozenset()
            )
            return tuple(results), tuple(specs), pending, work, proof
        results.append(result)
        if spec is None:
            return tuple(results), tuple(specs), frozenset(), work, proof
        specs.append(spec)
        work, proof, stage_results, return_plan = _current_stage(
            paths, config, identity, spec
        )
        results.extend(stage_results)
        if return_plan is None:
            return tuple(results), tuple(specs), frozenset(), work, proof
        parent, trigger = spec, return_plan.job_id



def _project_current_gpt_pending(
    paths: PPaths, snapshot: Snapshot
) -> Snapshot:
    """Project one exact already-created GPT outbox as current pending.

    The outbox is never authority by itself.  Fresh core.decide() first derives
    the only current semantic GPT identity from durable causal facts; only an
    exact-addressed packet for that identity, with no result yet present, is
    projected into gpt_pending.
    """
    if snapshot.gpt_pending or not snapshot.repository_available:
        return snapshot

    action = decide(snapshot)
    if (
        action.kind not in {ActionKind.PLAN, ActionKind.JUDGE}
        or not action.effect_id
    ):
        return snapshot

    job_id = action.effect_id
    packet_path = paths.root / "gpt" / "outbox" / f"{job_id}.md"
    result_path = paths.root / "gpt" / "results" / f"{job_id}.json"

    if not packet_path.exists() or result_path.exists():
        return snapshot

    packet = load_gpt_packet(paths, job_id)
    expected_operation = (
        "PLAN_GPT" if action.kind is ActionKind.PLAN else "JUDGE_GPT"
    )
    if packet.get("operation") != expected_operation:
        raise FactError(
            f"current GPT packet operation mismatch for {job_id}"
        )

    return replace(
        snapshot,
        gpt_pending=frozenset({job_id}),
    )

def read_snapshot(paths: PPaths, *, allow_merge: bool = False) -> Snapshot:
    from .github import GitHubFacts, read_github_facts

    config = load_config(paths)
    load_charter(paths, config)
    worktree = Path(config.worktree).resolve()
    if Path(git(worktree, "rev-parse", "--show-toplevel")).resolve() != worktree:
        raise FactError("configured worktree is no longer its Git root")
    actual_repository = canonical_repository(
        git(worktree, "remote", "get-url", config.remote)
    )
    if actual_repository != config.repository:
        raise FactError("configured repository identity drifted")
    if git(worktree, "branch", "--show-current") != config.branch:
        raise FactError("configured branch identity drifted")
    head = git(worktree, "rev-parse", "HEAD")
    try:
        base = live_remote_sha(worktree, config.remote, config.base_ref)
        has_base = _run(
            ("git", "cat-file", "-e", f"{base}^{{commit}}"),
            cwd=worktree,
            check=False,
        )
        if has_base.returncode != 0:
            fetched = _run(
                ("git", "fetch", "--quiet", config.remote, config.base_ref),
                cwd=worktree,
                check=False,
                timeout=120,
            )
            if fetched.returncode != 0:
                raise FactError("live BASE object is temporarily unavailable")
            base = live_remote_sha(worktree, config.remote, config.base_ref)
            git(worktree, "cat-file", "-e", f"{base}^{{commit}}")
        repository_available = True
    except FactError:
        base = head
        repository_available = False
    contract = proof_contract_digest(config)
    if repository_available:
        results, specs, pending, work, proof = _load_current(
            paths, config, head, base, contract
        )
    else:
        results, specs, pending, work, proof = (), (), frozenset(), (), ()
    snapshot = Snapshot(
        p_id=config.p_id,
        charter_digest=config.charter_digest,
        expected_repository=config.repository,
        expected_branch=config.branch,
        base_ref=config.base_ref,
        head=head,
        base=base,
        repository_available=repository_available,
        specs=specs,
        gpt_results=results,
        gpt_pending=pending,
        work_facts=tuple(work),
        proof_facts=proof,
        merge=read_github_facts(config)
        if allow_merge or any(item.status is Observation.PASS for item in proof)
        else GitHubFacts(),
        expected_owner_token=config.owner_token,
        proof_contract_digest=contract,
        allow_merge=allow_merge,
    )
    return _project_current_gpt_pending(paths, snapshot)
