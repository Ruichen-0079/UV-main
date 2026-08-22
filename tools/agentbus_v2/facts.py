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
    Action,
    ActionKind,
    JUDGE_RESULTS,
    PLAN_RESULTS,
    GPT_PACKET_SCHEMA,
    PROOF_SCHEMA,
    GptResult,
    OperatorDirective,
    Observation,
    ProofFact,
    Snapshot,
    SpecFact,
    WorkFact,
    plan_facts_digest,
    plan_job_id,
    operator_directive_id,
    operator_directive_id_from_authority,
    operator_directive_text_digest,
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
class AdoptedPr:
    number: int
    seed_head_sha: str
    head_branch: str
    base_branch: str
    observed_base_sha: str


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
    adopted_pr: AdoptedPr | None = None

    @property
    def owner_token(self) -> str:
        identity: dict[str, Any] = {
            "p_id": self.p_id,
            "repository": self.repository,
            "branch": self.branch,
            "seed_head": self.seed_head,
        }
        if self.adopted_pr is not None:
            identity["adopted_pr"] = asdict(self.adopted_pr)
        return stable_id("owner", identity)


@dataclass(frozen=True)
class PPaths:
    root: Path

    def create_dirs(self) -> None:
        for path in (
            "gpt/outbox", "gpt/results", "work/results", "work/logs", "prove/results",
            "operator", "control/outbox", "control/results",
        ):
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


def init_adopted_p_facts(
    state_root: Path,
    *,
    p_id: str,
    charter_text: str,
    worktree: Path,
    repository: str,
    branch: str,
    adopted_pr: AdoptedPr,
    base_ref: str = "main",
    remote: str = "origin",
    proof_commands: Iterable[tuple[str, ...]] = (),
    required_ci_checks: Iterable[str] = (),
) -> PPaths:
    """Write only the immutable local half of an already-validated PR adoption.

    The public administrative operation lives in ``github.adopt_existing_pr``;
    it validates the exact GitHub PR before calling this helper.  Local facts
    are deliberately written before the idempotent remote ownership claim, so
    a fresh process can resume convergence without a recovery-state file.
    """
    paths = paths_for(state_root, p_id)
    worktree = worktree.resolve()
    actual_root = Path(git(worktree, "rev-parse", "--show-toplevel")).resolve()
    if actual_root != worktree:
        raise FactError(f"worktree must be its Git root: {worktree}")
    actual_branch = git(worktree, "branch", "--show-current")
    if actual_branch != branch or adopted_pr.head_branch != branch:
        raise FactError(f"branch mismatch: expected {branch}, found {actual_branch}")
    if adopted_pr.base_branch != base_ref:
        raise FactError("adopted PR base branch does not match configured base")
    actual_repository = canonical_repository(git(worktree, "remote", "get-url", remote))
    expected_repository = canonical_repository(repository)
    if actual_repository != expected_repository:
        raise FactError(
            f"repository mismatch: expected {expected_repository}, found {actual_repository}"
        )
    head = git(worktree, "rev-parse", "HEAD")
    if head != adopted_pr.seed_head_sha:
        raise FactError("local HEAD does not match adopted PR seed HEAD")
    if git(worktree, "status", "--porcelain=v1"):
        raise FactError("P adoption requires a clean dedicated worktree")
    remote_head = live_remote_sha(worktree, remote, branch)
    if remote_head != head:
        raise FactError("remote branch, PR seed HEAD, and local HEAD do not match")
    commands = tuple(tuple(str(arg) for arg in command) for command in proof_commands)
    if any(not command for command in commands):
        raise FactError("proof command argv cannot be empty")
    checks = tuple(str(check) for check in required_ci_checks)
    charter = charter_text.replace("\r\n", "\n").strip() + "\n"
    config = {
        "p_id": p_id,
        "worktree": str(worktree),
        "repository": expected_repository,
        "remote": remote,
        "branch": branch,
        "base_ref": base_ref,
        "seed_head": head,
        "charter_digest": sha256_text(charter),
        "proof_commands": [list(command) for command in commands],
        "required_ci_checks": list(checks),
        "adopted_pr": asdict(adopted_pr),
    }
    config_path = paths.root / "config.json"
    charter_path = paths.root / "charter.md"
    if config_path.exists():
        if not charter_path.exists():
            raise FactError(f"adopted P config exists without its charter: {paths.root}")
        existing = load_config(paths)
        expected = _parse_config(config, config_path)
        if (
            charter_path.read_text(encoding="utf-8") != charter
            or asdict(existing) != asdict(expected)
        ):
            raise FactError(f"P directory already exists with different facts: {paths.root}")
        return paths
    if paths.root.exists():
        conflicting = [
            item for item in paths.root.rglob("*")
            if item.is_file() and item != charter_path
        ]
        if conflicting:
            raise FactError(f"P directory already contains conflicting facts: {paths.root}")
        if charter_path.exists() and charter_path.read_text(encoding="utf-8") != charter:
            raise FactError(f"P directory already contains a conflicting charter: {paths.root}")
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
        raw_adopted = value.get("adopted_pr")
        adopted_pr: AdoptedPr | None
        if raw_adopted is None:
            adopted_pr = None
        else:
            fields = {
                "number", "seed_head_sha", "head_branch", "base_branch",
                "observed_base_sha",
            }
            if not isinstance(raw_adopted, dict) or set(raw_adopted) != fields:
                raise TypeError("adopted_pr has unexpected fields")
            if type(raw_adopted["number"]) is not int or raw_adopted["number"] <= 0:
                raise TypeError("adopted PR number must be a positive integer")
            for field in fields - {"number"}:
                if type(raw_adopted[field]) is not str or not raw_adopted[field]:
                    raise TypeError(f"adopted_pr {field} must be a non-empty string")
            adopted_pr = AdoptedPr(
                number=raw_adopted["number"],
                seed_head_sha=raw_adopted["seed_head_sha"],
                head_branch=raw_adopted["head_branch"],
                base_branch=raw_adopted["base_branch"],
                observed_base_sha=raw_adopted["observed_base_sha"],
            )
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
            adopted_pr=adopted_pr,
        )
    except (KeyError, TypeError, ValueError) as error:
        raise FactError(f"invalid P config {source}: {error}") from error
    if not P_ID_RE.fullmatch(config.p_id):
        raise FactError(f"invalid P_ID in {source}")
    if not SHA_RE.fullmatch(config.seed_head):
        raise FactError(f"invalid seed HEAD in {source}")
    if config.adopted_pr is not None:
        adopted = config.adopted_pr
        if (
            not SHA_RE.fullmatch(adopted.seed_head_sha)
            or not SHA_RE.fullmatch(adopted.observed_base_sha)
            or adopted.seed_head_sha != config.seed_head
            or adopted.head_branch != config.branch
            or adopted.base_branch != config.base_ref
        ):
            raise FactError(f"adopted PR identity does not match P config in {source}")
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


def load_operator_directive(paths: PPaths) -> OperatorDirective | None:
    path = paths.root / "operator" / "directive.json"
    if not path.exists():
        return None
    value = _load_json(path)
    fields = {
        "directive_id", "text", "text_digest", "authority_plan_job_id", "parent_spec_id",
    }
    if set(value) != fields or any(
        type(value.get(key)) is not str
        for key in ("directive_id", "text", "text_digest", "authority_plan_job_id")
    ):
        raise FactError(f"invalid operator directive fact: {path}")
    parent = value["parent_spec_id"]
    if parent is not None and type(parent) is not str:
        raise FactError(f"invalid operator directive parent: {path}")
    if parent is not None and not re.fullmatch(r"spec-[0-9a-f]{24}", parent):
        raise FactError(f"invalid operator directive parent: {path}")
    text = value["text"].replace("\r\n", "\n").strip()
    if not text or text != value["text"]:
        raise FactError(f"operator directive text is not normalized: {path}")
    if not re.fullmatch(r"directive-[0-9a-f]{24}", value["directive_id"]):
        raise FactError(f"invalid operator directive ID: {path}")
    if not GPT_JOB_RE.fullmatch(value["authority_plan_job_id"]):
        raise FactError(f"invalid operator directive authority: {path}")
    if not re.fullmatch(r"[0-9a-f]{64}", value["text_digest"]):
        raise FactError(f"invalid operator directive digest: {path}")
    if operator_directive_text_digest(text) != value["text_digest"]:
        raise FactError(f"operator directive digest mismatch: {path}")
    config = load_config(paths)
    expected_id = operator_directive_id_from_authority(
        config.p_id,
        value["authority_plan_job_id"],
        value["text_digest"],
        parent_spec_id=parent,
    )
    if value["directive_id"] != expected_id:
        raise FactError(f"operator directive identity does not match its immutable content: {path}")
    return OperatorDirective(
        directive_id=value["directive_id"], text=text,
        text_digest=value["text_digest"],
        authority_plan_job_id=value["authority_plan_job_id"],
        parent_spec_id=parent,
    )


def add_operator_directive(
    paths: PPaths,
    snapshot: Snapshot,
    text: str,
    *,
    parent_spec_id: str | None = None,
) -> tuple[OperatorDirective, bool]:
    """Write one immutable directive fact, idempotently.

    The file is intentionally singular: a conflicting rewrite fails closed
    instead of creating a hidden directive timeline or mutable pointer.
    """
    normalized = text.replace("\r\n", "\n").strip()
    if not normalized:
        raise FactError("operator directive cannot be empty")
    if parent_spec_id is not None and not re.fullmatch(r"spec-[0-9a-f]{24}", parent_spec_id):
        raise FactError("operator directive parent SPEC has an invalid identity")
    if parent_spec_id is not None and not any(
        item.spec_id == parent_spec_id for item in snapshot.specs
    ):
        raise FactError("operator directive parent SPEC is absent from the fresh snapshot")
    authority = replace(snapshot, operator_directive=None)
    authority_job = plan_job_id(authority, parent_spec_id=parent_spec_id)
    directive = OperatorDirective(
        directive_id=operator_directive_id(authority, normalized, parent_spec_id=parent_spec_id),
        text=normalized,
        text_digest=operator_directive_text_digest(normalized),
        authority_plan_job_id=authority_job,
        parent_spec_id=parent_spec_id,
    )
    encoded = asdict(directive)
    existing = load_operator_directive(paths)
    if existing is not None:
        if existing != directive:
            raise FactError("conflicting immutable operator directive")
        return existing, False
    return directive, write_json_once(paths.root / "operator" / "directive.json", encoded)


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


def _validate_gpt_packet(
    packet: Mapping[str, Any], snapshot: Snapshot, action: Action
) -> None:
    if action.kind not in {ActionKind.PLAN, ActionKind.JUDGE} or not action.effect_id:
        raise FactError("current GPT packet validation requires an exact GPT action")
    operation = "PLAN_GPT" if action.kind is ActionKind.PLAN else "JUDGE_GPT"
    semantic: dict[str, Any] = {
        "packet_schema": GPT_PACKET_SCHEMA,
        "job_id": action.effect_id,
        "p_id": snapshot.p_id,
        "operation": operation,
        "charter_digest": snapshot.charter_digest,
        "repository": snapshot.expected_repository,
        "branch": snapshot.expected_branch,
        "base_ref": snapshot.base_ref,
        "head": snapshot.head,
        "base": snapshot.base,
        "parent_spec_id": action.payload.get("parent_spec_id"),
        "trigger_judge_id": action.payload.get("trigger_judge_id"),
        "planning_facts_digest": plan_facts_digest(snapshot),
    }
    if snapshot.operator_directive is not None:
        semantic["operator_directive"] = {
            "directive_id": snapshot.operator_directive.directive_id,
            "text_digest": snapshot.operator_directive.text_digest,
            "authority_plan_job_id": snapshot.operator_directive.authority_plan_job_id,
            "parent_spec_id": snapshot.operator_directive.parent_spec_id,
        }
    if action.kind is ActionKind.JUDGE:
        spec_id_value = action.payload.get("spec_id")
        spec = next(
            (item for item in snapshot.specs if item.spec_id == spec_id_value), None
        )
        if spec is None:
            raise FactError("current JUDGE packet references an absent SPEC")
        trigger = action.payload.get("trigger_judge_id")
        semantic.update({
            "spec_id": spec.spec_id,
            "spec_content_digest": stable_id("spec-text", {"text": spec.text}),
            "failed_step": action.payload.get("failed_step"),
            "evidence_id": action.payload.get("evidence_id"),
            "evidence_digest": action.payload.get("evidence_digest"),
            "trigger_judge_id": (
                trigger if trigger is not None else spec.trigger_judge_id
            ),
        })
    expected = {
        "packet_schema": GPT_PACKET_SCHEMA,
        "job_id": action.effect_id,
        "operation": operation,
        "semantic_input": semantic,
    }
    if dict(packet) != expected:
        raise FactError(f"current GPT packet causal identity mismatch: {action.effect_id}")

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
    if result is None:
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
        identity = _identity(
            config, packet_head, packet_base, "", identity.operator_directive
        )
        if plan_job_id(identity, parent_spec_id=parent_id, trigger_judge_id=trigger) != job_id:
            raise FactError(f"PLAN packet identity mismatch: {job_id}")
    else:
        parent_id = parent.spec_id if parent else None
    _validate_gpt_packet(
        packet,
        identity,
        Action(
            ActionKind.PLAN,
            effect_id=job_id,
            payload={
                "parent_spec_id": parent_id,
                "trigger_judge_id": trigger,
            },
        ),
    )
    if result.decision != "SPEC":
        return job_id, result, None
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


def _historical_directive_plan(
    paths: PPaths,
    config: PConfig,
    contract_digest: str,
    directive: OperatorDirective,
) -> tuple[GptResult, SpecFact] | None:
    """Find the accepted PLAN/SPEC that this immutable directive produced.

    The search is deliberately limited to exact durable PLAN result/packet
    identities.  It is not a history authority by itself: the matching packet
    is revalidated against the HEAD/BASE it recorded, and the strict result
    parser remains the only source of accepted GPT authority.
    """
    expected_directive = {
        "directive_id": directive.directive_id,
        "text_digest": directive.text_digest,
        "authority_plan_job_id": directive.authority_plan_job_id,
        "parent_spec_id": directive.parent_spec_id,
    }
    result_dir = paths.root / "gpt" / "results"
    matches: list[tuple[GptResult, SpecFact]] = []
    if not result_dir.exists():
        return None
    for result_path in sorted(result_dir.glob("plan-*.json")):
        job_id = result_path.stem
        if not GPT_JOB_RE.fullmatch(job_id):
            continue
        try:
            result = _load_gpt_result(paths, job_id, "PLAN_GPT")
        except FactError:
            # Unrelated malformed historical material is not part of this
            # directive's lineage. A matching packet/result is re-raised by
            # the strict validation below.
            continue
        if result is None or result.decision != "SPEC":
            continue
        packet_path = paths.root / "gpt" / "outbox" / f"{job_id}.md"
        if not packet_path.exists():
            continue
        packet = load_gpt_packet(paths, job_id)
        semantic = packet.get("semantic_input")
        if not isinstance(semantic, dict):
            continue
        if semantic.get("operator_directive") != expected_directive:
            continue
        packet_head = semantic.get("head")
        packet_base = semantic.get("base")
        if (
            not isinstance(packet_head, str)
            or not isinstance(packet_base, str)
            or not SHA_RE.fullmatch(packet_head)
            or not SHA_RE.fullmatch(packet_base)
        ):
            raise FactError(f"historical PLAN packet identity is malformed: {job_id}")
        historical_identity = _identity(
            config, packet_head, packet_base, contract_digest, directive
        )
        loaded_job, loaded_result, spec = _load_plan_spec(
            paths, config, historical_identity, None, None, job_id
        )
        if loaded_job != job_id or loaded_result is None or spec is None:
            raise FactError(f"historical directive PLAN lineage is incomplete: {job_id}")
        matches.append((loaded_result, spec))
    if len(matches) > 1:
        raise FactError("operator directive has ambiguous accepted PLAN lineage")
    return matches[0] if matches else None

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
        # A PROVE FAIL may be established by a required CI check after all
        # local mechanical commands pass.  CI evidence is validated below;
        # retain the complete local command contract in that case.
        if not config.required_ci_checks or len(value) != len(expected):
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
        if not matches:
            if status in {Observation.PASS.value, Observation.FAIL.value}:
                raise FactError(f"PROVE result lacks required CI evidence: {path}")
        elif status == Observation.PASS.value and any(
            item.get("bucket") != "pass" for item in matches
        ):
            raise FactError(f"PROVE PASS lacks required CI evidence: {path}")
    if status == Observation.FAIL.value and not local_failed and not any(
        item.get("bucket") in {"fail", "cancel"} for item in checks
    ):
        raise FactError(f"PROVE FAIL lacks a confirmed CI failure: {path}")


def _identity(
    config: PConfig,
    head: str,
    base: str,
    contract: str,
    operator_directive: OperatorDirective | None = None,
) -> Snapshot:
    return Snapshot(
        p_id=config.p_id, charter_digest=config.charter_digest,
        expected_repository=config.repository, expected_branch=config.branch,
        base_ref=config.base_ref, head=head, base=base,
        proof_contract_digest=contract,
        operator_directive=operator_directive,
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


def _current_stage(
    paths: PPaths, config: PConfig, identity: Snapshot, spec: SpecFact,
) -> tuple[tuple[WorkFact, ...], tuple[ProofFact, ...], tuple[GptResult, ...], GptResult | None]:
    """Replay the exact current WORK/PROVE/JUDGE causal chain.

    A GLOBAL JUDGE may return to WORK or PROVE any number of times.  This is
    deliberately not a repair counter or workflow state: each iteration asks
    the pure core for the one next exact identity, then reads only that
    immutable address.  Missing facts stop reconstruction as ABSENT.
    """
    recovered = _work_from_head(config, identity.head)
    recovered_current = (
        recovered
        if recovered is not None
        and recovered.spec_id == spec.spec_id
        and recovered.plan_job_id == spec.plan_job_id
        else None
    )
    work_facts: list[WorkFact] = []
    proof_facts: list[ProofFact] = []
    stage_results: list[GptResult] = []
    seen_actions: set[tuple[ActionKind, str]] = set()

    if recovered_current is not None:
        if recovered_current.trigger_judge_id is not None:
            cause = _load_gpt_result(
                paths, recovered_current.trigger_judge_id, "JUDGE_GPT"
            )
            if cause is None or cause.decision != "RETURN_WORK":
                raise FactError(
                    "recovered WORK commit lacks its exact RETURN_WORK cause"
                )
            stage_results.append(cause)
        work_facts.append(recovered_current)

    while True:
        stage = replace(
            identity,
            specs=(spec,),
            gpt_results=tuple(stage_results),
            work_facts=tuple(work_facts),
            proof_facts=tuple(proof_facts),
        )
        action = decide(stage)
        if action.effect_id is None:
            return (
                tuple(work_facts), tuple(proof_facts), tuple(stage_results), None
            )
        key = (action.kind, action.effect_id)
        if key in seen_actions:
            raise FactError(
                f"current causal reconstruction repeated {action.kind.value} "
                f"identity: {action.effect_id}"
            )
        seen_actions.add(key)

        if action.kind is ActionKind.WORK:
            work = _load_work(
                paths,
                config,
                identity,
                spec,
                trigger=action.payload.get("trigger_judge_id"),
                recovered=recovered_current,
            )
            if work is None:
                return (
                    tuple(work_facts), tuple(proof_facts), tuple(stage_results), None
                )
            work_facts.append(work)
            continue

        if action.kind is ActionKind.PROVE:
            proof = _load_proof(
                paths,
                config,
                spec,
                identity.head,
                identity.base,
                identity.proof_contract_digest,
                trigger=action.payload.get("trigger_judge_id"),
            )
            if proof is None:
                return (
                    tuple(work_facts), tuple(proof_facts), tuple(stage_results), None
                )
            proof_facts.append(proof)
            continue

        if action.kind is ActionKind.JUDGE:
            result = _load_gpt_result(paths, action.effect_id, "JUDGE_GPT")
            if result is None:
                return (
                    tuple(work_facts), tuple(proof_facts), tuple(stage_results), None
                )
            _validate_gpt_packet(load_gpt_packet(paths, action.effect_id), stage, action)
            stage_results.append(result)
            continue

        if action.kind is ActionKind.PLAN:
            trigger = action.payload.get("trigger_judge_id")
            return_plan = next(
                (item for item in reversed(stage_results) if item.job_id == trigger),
                None,
            )
            if return_plan is None or return_plan.decision != "RETURN_PLAN":
                raise FactError("PLAN reconstruction lacks its exact RETURN_PLAN cause")
            return (
                tuple(work_facts),
                tuple(proof_facts),
                tuple(stage_results),
                return_plan,
            )

        return tuple(work_facts), tuple(proof_facts), tuple(stage_results), None


def _load_current(
    paths: PPaths, config: PConfig, head: str, base: str, contract_digest: str,
    operator_directive: OperatorDirective | None = None,
) -> tuple[tuple[GptResult, ...], tuple[SpecFact, ...], frozenset[str],
           tuple[WorkFact, ...], tuple[ProofFact, ...]]:
    identity = _identity(config, head, base, contract_digest, operator_directive)
    results: list[GptResult] = []
    specs: list[SpecFact] = []
    parent: SpecFact | None = None
    trigger: str | None = None
    work: tuple[WorkFact, ...] = ()
    proof: tuple[ProofFact, ...] = ()
    seen: set[str] = set()
    if operator_directive is not None:
        expected_stored_id = operator_directive_id_from_authority(
            config.p_id,
            operator_directive.authority_plan_job_id,
            operator_directive.text_digest,
            parent_spec_id=operator_directive.parent_spec_id,
        )
        if operator_directive.directive_id != expected_stored_id:
            raise FactError("operator directive identity does not match its immutable content")
        authority = replace(identity, operator_directive=None)
        expected_authority = plan_job_id(
            authority, parent_spec_id=operator_directive.parent_spec_id
        )
        historical_plan = _historical_directive_plan(
            paths, config, contract_digest, operator_directive
        )
        if historical_plan is not None:
            historical_result, historical_spec = historical_plan
            results.append(historical_result)
            specs.append(historical_spec)
            seen.add(historical_result.job_id)
            work, proof, stage_results, return_plan = _current_stage(
                paths, config, identity, historical_spec
            )
            results.extend(stage_results)
            if return_plan is None:
                return tuple(results), tuple(specs), frozenset(), work, proof
            parent, trigger = historical_spec, return_plan.job_id
        elif operator_directive.authority_plan_job_id != expected_authority:
            # Before an accepted PLAN/SPEC lineage exists, the creation-time
            # freshness fence remains fail-closed. Only proven historical
            # lineage is allowed to survive later HEAD/BASE movement.
            raise FactError("operator directive authority does not match current planning facts")
        elif operator_directive.parent_spec_id is not None:
            # Reconstruct the historical SPEC lineage without the new
            # directive first.  A replan must not make the old root PLAN (and
            # its SPEC) disappear merely because the new directive changes
            # the next PLAN identity.
            historical = _load_current(paths, config, head, base, contract_digest, None)
            old_results, old_specs, _, _, _ = historical
            parent_spec = next(
                (item for item in old_specs if item.spec_id == operator_directive.parent_spec_id),
                None,
            )
            if parent_spec is None:
                raise FactError("operator directive parent SPEC is not current durable history")
            results.extend(old_results)
            specs.extend(old_specs)
            seen.update(item.plan_job_id for item in old_specs if item.plan_job_id)
            parent = parent_spec
    recovered = _work_from_head(config, head)
    # A recovered WORK commit for a replan is resolved by the parent lineage
    # above; using it as a root PLAN would incorrectly lose the old SPEC.
    head_plan = recovered.plan_job_id if recovered and parent is None else None
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
            packet_path = paths.root / "gpt" / "outbox" / f"{job_id}.md"
            pending = frozenset()
            if packet_path.exists():
                packet = load_gpt_packet(paths, job_id)
                _validate_gpt_packet(
                    packet,
                    replace(identity, specs=tuple(specs)),
                    Action(
                        ActionKind.PLAN,
                        effect_id=job_id,
                        payload={
                            "parent_spec_id": parent.spec_id if parent else None,
                            "trigger_judge_id": trigger,
                        },
                    ),
                )
                pending = frozenset({job_id})
            return tuple(results), tuple(specs), pending, work, proof
        results.append(result)
        if spec is None:
            return tuple(results), tuple(specs), frozenset(), work, proof
        if (
            recovered is not None
            and recovered.plan_job_id == job_id
            and recovered.spec_id != spec.spec_id
        ):
            raise FactError("recovered WORK commit Plan/SPEC identities disagree")
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

    _validate_gpt_packet(load_gpt_packet(paths, job_id), snapshot, action)

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
    operator_directive = load_operator_directive(paths)
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
            paths, config, head, base, contract, operator_directive
        )
    else:
        results, specs, pending, work, proof = (), (), frozenset(), (), ()
    head_is_in_live_base = False
    if repository_available and head != base:
        head_is_in_live_base = _run(
            ("git", "merge-base", "--is-ancestor", head, base),
            cwd=worktree,
            check=False,
        ).returncode == 0
    merge = (
        read_github_facts(config)
        if allow_merge
        or any(item.status is Observation.PASS for item in proof)
        or head_is_in_live_base
        else GitHubFacts()
    )
    if merge.state == "MERGED" and not head_is_in_live_base:
        # A PR record alone is not DONE authority while the freshly read live
        # base does not contain its exact head (remote lag or a later rewrite).
        merge = replace(merge, available=False, state="ABSENT")
    if (
        repository_available
        and merge.state == "MERGED"
        and head_is_in_live_base
        and len(merge.merge_parents) == 2
        and merge.merge_parents[1] == head
        and merge.merge_parents[0] != base
    ):
        # The live base moves to (or beyond) the merge commit after MERGE.  DONE
        # still depends on the exact pre-merge PROVE/JUDGE addresses.  The
        # immutable merge parent supplies that base without scheduler recovery
        # state or historical directory scans.
        results, specs, pending, work, proof = _load_current(
            paths, config, head, merge.merge_parents[0], contract, operator_directive
        )
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
        merge=merge,
        expected_owner_token=config.owner_token,
        proof_contract_digest=contract,
        allow_merge=allow_merge,
        operator_directive=operator_directive,
    )
    return _project_current_gpt_pending(paths, snapshot)
