"""Durable fact collection for AgentBus v2.

Files in a P directory are immutable requests/results or bounded executor
evidence. No file stores a phase, current step, retry count, or derived
workflow status.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any, Iterable, Mapping, Sequence

from .core import (
    JUDGE_RESULTS,
    PLAN_RESULTS,
    GPT_PACKET_SCHEMA,
    PROOF_SCHEMA,
    GptResult,
    MergeFacts,
    Observation,
    ProofFact,
    Snapshot,
    SpecFact,
    WorkFact,
    proof_id,
    spec_id,
    stable_id,
)


CONFIG_SCHEMA = 2
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
P_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
TRAILER_RE = re.compile(r"^AgentBus-V2-([A-Za-z-]+):\s*(.+?)\s*$")
GPT_JOB_RE = re.compile(r"^(?:plan|judge)-[0-9a-f]{24}$")


class FactError(RuntimeError):
    pass


@dataclass(frozen=True)
class PConfig:
    schema_version: int
    p_id: str
    worktree: str
    repository: str
    remote: str
    branch: str
    base_ref: str
    seed_head: str
    seed_base: str
    charter_digest: str
    owner_token: str
    proof_commands: tuple[tuple[str, ...], ...]
    required_ci_checks: tuple[str, ...]


@dataclass(frozen=True)
class PPaths:
    root: Path

    @property
    def config(self) -> Path:
        return self.root / "config.json"

    @property
    def charter(self) -> Path:
        return self.root / "charter.md"

    @property
    def gpt_outbox(self) -> Path:
        return self.root / "gpt" / "outbox"

    @property
    def gpt_results(self) -> Path:
        return self.root / "gpt" / "results"

    @property
    def work_results(self) -> Path:
        return self.root / "work" / "results"

    @property
    def work_logs(self) -> Path:
        return self.root / "work" / "logs"

    @property
    def proof_results(self) -> Path:
        return self.root / "prove" / "results"

    def create_dirs(self) -> None:
        for path in (
            self.gpt_outbox,
            self.gpt_results,
            self.work_results,
            self.work_logs,
            self.proof_results,
        ):
            path.mkdir(parents=True, exist_ok=True)


def default_state_root() -> Path:
    base = os.environ.get("XDG_STATE_HOME")
    if base:
        return Path(base).expanduser() / "yuvi-agentbus-v2"
    return Path.home() / ".local" / "state" / "yuvi-agentbus-v2"


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


def github_slug(repository: str) -> str:
    canonical = canonical_repository(repository)
    prefix = "github.com/"
    if not canonical.startswith(prefix) or canonical.count("/") != 2:
        raise FactError(f"GitHub repository required, got {repository!r}")
    return canonical.removeprefix(prefix)


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
    """Create an immutable JSON fact, or verify an identical existing fact."""

    data = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    return write_text_once(path, data)


def write_text_once(path: Path, text: str) -> bool:
    """Publish immutable text with create-only filesystem semantics."""

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
    if remote_branch.returncode == 0 and not paths.config.exists():
        raise FactError("refusing to claim an existing remote experiment branch")
    if remote_branch.returncode not in {0, 2}:
        raise FactError("cannot verify experiment branch ownership at the remote")
    charter = charter_text.replace("\r\n", "\n").strip() + "\n"
    charter_digest = sha256_text(charter)
    owner_token = stable_id(
        "owner",
        {
            "p_id": p_id,
            "repository": expected_repository,
            "branch": branch,
            "seed_head": head,
        },
    )
    config = {
        "schema_version": CONFIG_SCHEMA,
        "p_id": p_id,
        "worktree": str(worktree),
        "repository": expected_repository,
        "remote": remote,
        "branch": branch,
        "base_ref": base_ref,
        "seed_head": head,
        "seed_base": base,
        "charter_digest": charter_digest,
        "owner_token": owner_token,
        "proof_commands": [list(command) for command in commands],
        "required_ci_checks": list(checks),
    }
    if paths.config.exists():
        existing = load_config(paths)
        if paths.charter.read_text(encoding="utf-8") != charter or asdict(existing) != asdict(
            _parse_config(config, paths.config)
        ):
            raise FactError(f"P directory already exists with different facts: {paths.root}")
        return paths
    paths.create_dirs()
    write_text_once(paths.charter, charter)
    write_json_once(paths.config, config)
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
            schema_version=int(value["schema_version"]),
            p_id=str(value["p_id"]),
            worktree=str(value["worktree"]),
            repository=canonical_repository(str(value["repository"])),
            remote=str(value["remote"]),
            branch=str(value["branch"]),
            base_ref=str(value["base_ref"]),
            seed_head=str(value["seed_head"]),
            seed_base=str(value["seed_base"]),
            charter_digest=str(value["charter_digest"]),
            owner_token=str(value["owner_token"]),
            proof_commands=commands,
            required_ci_checks=tuple(
                str(item) for item in value.get("required_ci_checks", [])
            ),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise FactError(f"invalid P config {source}: {error}") from error
    if config.schema_version != CONFIG_SCHEMA:
        raise FactError(f"unsupported config schema in {source}")
    if not P_ID_RE.fullmatch(config.p_id):
        raise FactError(f"invalid P_ID in {source}")
    if not SHA_RE.fullmatch(config.seed_head) or not SHA_RE.fullmatch(config.seed_base):
        raise FactError(f"invalid seed SHA in {source}")
    if any(not command for command in commands):
        raise FactError(f"empty proof command in {source}")
    return config


def load_config(paths: PPaths) -> PConfig:
    return _parse_config(_load_json(paths.config), paths.config)


def load_charter(paths: PPaths, config: PConfig) -> str:
    try:
        charter = paths.charter.read_text(encoding="utf-8")
    except OSError as error:
        raise FactError(f"cannot read charter {paths.charter}: {error}") from error
    if sha256_text(charter) != config.charter_digest:
        raise FactError("P_CHARTER changed after initialization")
    return charter


GPT_DECISIONS = {
    "PLAN_GPT": PLAN_RESULTS,
    "JUDGE_GPT": JUDGE_RESULTS,
}


def gpt_response_schema(operation: str, job_id: str) -> str:
    decisions = GPT_DECISIONS.get(operation)
    if decisions is None:
        raise FactError(f"unsupported GPT operation: {operation}")
    return (f'Return exactly one JSON object and no Markdown fence:\n{{\n'
            f'  "job_id": "{job_id}",\n  "operation": "{operation}",\n'
            f'  "decision": "{" | ".join(sorted(decisions))}",\n  "body": "string"\n}}\n\n'
            'Keys are exactly job_id, operation, decision, body. Repeat JOB_ID '
            'verbatim; body is the complete bounded plan or judgment.')


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
    path = paths.gpt_outbox / f"{job_id}.md"
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


def _load_gpt(paths: PPaths, config: PConfig) -> tuple[
    tuple[GptResult, ...], tuple[SpecFact, ...], frozenset[str]
]:
    responses: dict[str, GptResult] = {}
    packets: dict[str, dict[str, Any]] = {}
    for path in sorted(paths.gpt_results.glob("*.json")):
        job_id = path.stem
        if not GPT_JOB_RE.fullmatch(job_id):
            raise FactError(f"GPT result JOB_ID is invalid: {path}")
        value = _load_json(path)
        operation = value.get("operation")
        if type(operation) is not str:
            raise FactError(f"GPT result operation is invalid: {path}")
        result = parse_gpt_response(job_id, operation, value, str(path))
        responses[job_id] = result
        if result.operation == "PLAN_GPT" and result.decision == "SPEC":
            packet = load_gpt_packet(paths, job_id)
            if packet["operation"] != result.operation:
                raise FactError(f"GPT packet/result operation mismatch: {job_id}")
            packets[job_id] = packet

    specs: list[SpecFact] = []
    for job_id, result in responses.items():
        if result.operation != "PLAN_GPT" or result.decision != "SPEC":
            continue
        semantic = packets[job_id]["semantic_input"]
        planning_digest = str(semantic.get("planning_facts_digest", ""))
        if not planning_digest:
            raise FactError(f"PLAN packet lacks planning facts: {job_id}")
        parent = str(semantic["parent_spec_id"]) if semantic.get("parent_spec_id") is not None else None
        trigger_id = str(semantic["trigger_judge_id"]) if semantic.get("trigger_judge_id") is not None else None
        specs.append(SpecFact(spec_id(config.charter_digest, planning_digest, result.body), job_id,
                              result.body, planning_digest, str(semantic["head"]),
                              str(semantic["base"]), parent, trigger_id))
    for item in specs:
        if item.parent_spec_id is None:
            if item.trigger_judge_id is not None:
                raise FactError(f"root SPEC has a judge trigger: {item.spec_id}")
            continue
        trigger = responses.get(item.trigger_judge_id or "")
        trigger_packet = packets.get(item.trigger_judge_id or "")
        if trigger_packet is None and trigger is not None:
            trigger_packet = load_gpt_packet(paths, trigger.job_id)
            if trigger_packet["operation"] != trigger.operation:
                raise FactError(f"GPT packet/result operation mismatch: {trigger.job_id}")
        trigger_semantic = trigger_packet.get("semantic_input", {}) if trigger_packet else {}
        if (
            trigger is None
            or trigger.decision != "RETURN_PLAN"
            or not isinstance(trigger_semantic, dict)
            or trigger_semantic.get("spec_id") != item.parent_spec_id
        ):
            raise FactError(f"successor SPEC lacks a valid RETURN_PLAN edge: {item.spec_id}")
    pending = frozenset(path.stem for path in paths.gpt_outbox.glob("*.md")
                        if GPT_JOB_RE.fullmatch(path.stem) and path.stem not in responses)
    return tuple(responses.values()), tuple(specs), pending


def _load_work(paths: PPaths, config: PConfig) -> list[WorkFact]:
    facts: list[WorkFact] = []
    for path in sorted(paths.work_results.glob("*.json")):
        value = _load_json(path)
        # PASS is commit-trailer evidence; no result artifact is loaded.
        if value.get("status") == Observation.PASS.value:
            continue
        try:
            if set(value) != {
                "effect_id", "spec_id", "input_head", "status",
                "evidence_digest", "trigger_judge_id",
            }:
                raise FactError(f"WORK result has unexpected fields: {path}")
            if any(type(value.get(key)) is not str for key in (
                "effect_id", "spec_id", "input_head", "status",
                "evidence_digest",
            )):
                raise FactError(f"WORK result fields have invalid types: {path}")
            if value.get("trigger_judge_id") is not None and type(value["trigger_judge_id"]) is not str:
                raise FactError(f"WORK result trigger has an invalid type: {path}")
            fact = WorkFact(
                effect_id=value["effect_id"],
                spec_id=value["spec_id"],
                input_head=value["input_head"],
                status=Observation.FAIL,
                evidence_digest=value["evidence_digest"],
                trigger_judge_id=value["trigger_judge_id"]
                if value.get("trigger_judge_id") is not None
                else None,
            )
        except (KeyError, ValueError) as error:
            raise FactError(f"invalid WORK fact {path}: {error}") from error
        expected_id = stable_id(
            "work",
            {
                "p_id": config.p_id,
                "spec": fact.spec_id,
                "input_head": fact.input_head,
                "trigger_judge": fact.trigger_judge_id,
            },
        )
        if (
            fact.effect_id != path.stem
            or fact.effect_id != expected_id
            or value["status"] != Observation.FAIL.value
            or not SHA_RE.fullmatch(fact.input_head)
            or (fact.trigger_judge_id is not None and not GPT_JOB_RE.fullmatch(fact.trigger_judge_id))
        ):
            raise FactError(f"invalid WORK result identity/status: {path}")
        facts.append(fact)
    return facts


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
    expected_effect = stable_id(
        "work",
        {
            "p_id": config.p_id,
            "spec": trailers["Spec"],
            "input_head": trailers["Input-Head"],
            "trigger_judge": trigger,
        },
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
    )


def _proof_commands(
    config: PConfig, base: str = "<BASE>", head: str = "<HEAD>"
) -> tuple[tuple[str, ...], ...]:
    """Return the one ordered mechanical proof contract."""
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


def _load_proof(
    paths: PPaths,
    config: PConfig,
    specs: tuple[SpecFact, ...],
    results: tuple[GptResult, ...],
    head: str,
    base: str,
    contract_digest: str,
) -> tuple[ProofFact, ...]:
    identity = Snapshot(
        p_id=config.p_id, charter_digest=config.charter_digest,
        expected_repository=config.repository, expected_branch=config.branch,
        base_ref=config.base_ref, head=head, base=base,
        proof_contract_digest=contract_digest,
    )
    candidates: dict[str, tuple[SpecFact, str | None]] = {}
    triggers = (None, *(
        item.job_id for item in results
        if item.operation == "JUDGE_GPT" and item.decision == "RETURN_PROVE"
    ))
    for spec in specs:
        for trigger in triggers:
            identity_id = proof_id(identity, spec, trigger_judge_id=trigger)
            candidates[identity_id] = (spec, trigger)
    facts: list[ProofFact] = []
    for proof_key, (spec, trigger) in candidates.items():
        path = paths.proof_results / f"{proof_key}.json"
        if not path.exists():
            continue
        value = _load_json(path)
        expected = {
            "schema", "proof_id", "spec_id", "head", "base", "status",
            "trigger_judge_id", "contract_digest", "summary", "local_commands",
            "github_checks", "failed_ci_logs", "evidence_digest",
        }
        if set(value) != expected or value.get("schema") != PROOF_SCHEMA:
            raise FactError(f"PROVE result has unexpected fields: {path}")
        if (
            value.get("proof_id") != proof_key
            or value.get("spec_id") != spec.spec_id
            or value.get("head") != head
            or value.get("base") != base
            or value.get("trigger_judge_id") != trigger
            or value.get("contract_digest") != contract_digest
            or value.get("status") not in {Observation.PASS.value, Observation.FAIL.value}
        ):
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
        _validate_proof_commands(
            value["local_commands"], config, head, base, value["status"], path
        )
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
        facts.append(ProofFact(
            proof_id=proof_key, spec_id=spec.spec_id, head=head, base=base,
            status=Observation(value["status"]), evidence_digest=value["evidence_digest"],
            trigger_judge_id=trigger, summary=value["summary"],
        ))
    return tuple(facts)


def _markers(body: str) -> dict[str, str]:
    prefixes = {
        "AgentBus-V2-P:": "p_id",
        "AgentBus-V2-Spec:": "spec_id",
        "AgentBus-V2-Owner:": "owner_token",
    }
    found: dict[str, str] = {}
    for line in body.splitlines():
        for prefix, key in prefixes.items():
            if line.startswith(prefix):
                found[key] = line.removeprefix(prefix).strip()
    return found


def read_merge_facts(config: PConfig, *, live_base: str | None = None) -> MergeFacts:
    slug = github_slug(config.repository)
    if live_base is None:
        try:
            live_base = live_remote_sha(Path(config.worktree), config.remote, config.base_ref)
        except FactError:
            return MergeFacts(available=False, repository=config.repository)
    completed = _run(
        (
            "gh",
            "pr",
            "list",
            "--repo",
            slug,
            "--head",
            config.branch,
            "--state",
            "all",
            "--limit",
            "20",
            "--json",
            "number,state,isDraft,mergeable,headRefName,headRefOid,baseRefName,baseRefOid,body,mergedAt,mergeCommit",
        ),
        check=False,
    )
    if completed.returncode != 0:
        return MergeFacts(available=False, repository=config.repository)
    try:
        records = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return MergeFacts(available=False, repository=config.repository)
    if not isinstance(records, list):
        return MergeFacts(available=False, repository=config.repository)
    open_records = [item for item in records if item.get("state") == "OPEN"]
    candidates = open_records or [item for item in records if item.get("mergedAt")]
    if not candidates:
        return MergeFacts(repository=config.repository)
    if len(candidates) != 1:
        return MergeFacts(available=False, repository=config.repository)
    record = candidates[0]
    marker = _markers(str(record.get("body", "")))
    raw_mergeable = str(record.get("mergeable", "UNKNOWN"))
    mergeable = True if raw_mergeable == "MERGEABLE" else False if raw_mergeable == "CONFLICTING" else None
    state = "MERGED" if record.get("mergedAt") else str(record.get("state", "UNKNOWN"))
    merge_commit_value = record.get("mergeCommit")
    merge_commit = (
        str(merge_commit_value.get("oid"))
        if isinstance(merge_commit_value, dict) and merge_commit_value.get("oid")
        else None
    )
    merge_parent_base = None
    merge_parent_head = None
    if state == "MERGED" and merge_commit:
        commit_result = _run(
            ("gh", "api", f"repos/{slug}/git/commits/{merge_commit}"), check=False
        )
        try:
            commit_data = json.loads(commit_result.stdout)
            parents = commit_data.get("parents", [])
        except (json.JSONDecodeError, AttributeError):
            parents = []
        if commit_result.returncode != 0 or not isinstance(parents, list) or len(parents) != 2:
            return MergeFacts(available=False, repository=config.repository)
        merge_parent_base = str(parents[0].get("sha", ""))
        merge_parent_head = str(parents[1].get("sha", ""))
    return MergeFacts(
        repository=config.repository,
        pr_number=int(record["number"]),
        state=state,
        draft=bool(record.get("isDraft")),
        mergeable=mergeable,
        head=str(record.get("headRefOid", "")),
        base=live_base,
        pr_base=str(record.get("baseRefOid", "")),
        head_ref=str(record.get("headRefName", "")),
        base_ref=str(record.get("baseRefName", "")),
        p_id=marker.get("p_id"),
        spec_id=marker.get("spec_id"),
        owner_token=marker.get("owner_token"),
        merge_commit=merge_commit,
        merge_parent_base=merge_parent_base,
        merge_parent_head=merge_parent_head,
    )


def read_snapshot(paths: PPaths, *, allow_merge: bool = False) -> Snapshot:
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
        base = config.seed_base
        repository_available = False
    results, specs, pending = _load_gpt(paths, config)
    work = _load_work(paths, config)
    recovered = _work_from_head(config, head)
    if recovered is not None:
        stored = [item for item in work if item.effect_id == recovered.effect_id]
        if stored:
            item = stored[0]
            if (
                item.status is not Observation.PASS
                or item.spec_id != recovered.spec_id
                or item.input_head != recovered.input_head
                or item.output_head != recovered.output_head
                or item.trigger_judge_id != recovered.trigger_judge_id
            ):
                raise FactError("stored WORK result conflicts with Git commit evidence")
        else:
            work.append(recovered)
    contract = proof_contract_digest(config)
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
        proof_facts=_load_proof(paths, config, specs, results, head, base, contract),
        merge=read_merge_facts(config, live_base=base),
        expected_owner_token=config.owner_token,
        proof_contract_digest=contract,
        allow_merge=allow_merge,
    )
    return snapshot
