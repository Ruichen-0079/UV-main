"""Operational BLOCK_GPT diagnosis for AgentBus v2.

This module deliberately sits beside the semantic kernel.  It observes the
result of a normal tick, derives a small typed operational observation, and
may create one exact BLOCK_GPT transport packet.  It never adds an action to
the semantic core and it never executes a proposed recovery.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from typing import Any, Mapping

from .core import Action, ActionKind, Snapshot, stable_id, decide
from .facts import FactError, PPaths, _load_json, load_config, paths_for, read_snapshot, sha256_text, write_json_once, write_text_once


BLOCK_OPERATION = "BLOCK_GPT"
BLOCK_PACKET_SCHEMA = "agentbus-v2/block-packet-v1"
BLOCK_RESULT_SCHEMA = "agentbus-v2/block-result-v1"
BLOCK_CONFIG_FILE = "block_gpt.json"
BLOCK_ID_RE = re.compile(r"^block-[0-9a-f]{24}$")
BLOCK_DECISIONS = frozenset({"RECOVER", "WAIT", "HUMAN"})
SUPPORTED_BLOCK_CODES = frozenset({
    "CODEX_RUNTIME_START_FAILED",
    "EXECUTOR_LAUNCH_FAILED",
    "LOCAL_AGENTBUS_COMPONENT_UNAVAILABLE",
})
MAX_EVIDENCE = 1200
MAX_PACKET_TEXT = 12000

BLOCK_GPT_BOOTSTRAP_PROMPT = """You are the global BLOCK_GPT for Yuvi AgentBus v2.

Diagnose operational execution blockers only.  Do not judge product
implementation correctness, modify code, or execute recovery.  Previous
conversation history is never semantic authority; every request is one
self-contained immutable BLOCK packet.

Allowed decisions are exactly RECOVER, WAIT, and HUMAN.  Use RECOVER only when
the operational root cause is clear, the proposed repair is bounded, no
tracked source or semantic authority change is required, no destructive
Git/PR/worktree authority is required, and an objective postcondition exists.
Use WAIT when observation should continue without local mutation.  Use HUMAN
whenever the cause is uncertain, source or semantic authority may need to
change, destructive/manual authority is required, or bounded recovery cannot
be proven safe.  Prefer HUMAN over speculative RECOVER.

Return exactly the requested machine-readable JSON object and no Markdown or
prose.  A RECOVER response is a proposal only; AgentBus v2 will not execute it
in this phase.
"""


@dataclass(frozen=True)
class BlockGPTConfig:
    enabled: bool = False
    conversation_url: str | None = None


@dataclass(frozen=True)
class OperationalBlockObservation:
    p_id: str
    causal_effect_id: str
    code: str
    summary: str
    evidence_fingerprint: str
    evidence: str
    auto_diagnosable: bool = True

    @property
    def block_id(self) -> str:
        return stable_id(
            "block",
            {
                "p_id": self.p_id,
                "causal_effect_id": self.causal_effect_id,
                "code": self.code,
                "evidence_fingerprint": self.evidence_fingerprint,
            },
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "block_id": self.block_id,
            "p_id": self.p_id,
            "causal_effect_id": self.causal_effect_id,
            "code": self.code,
            "summary": self.summary,
            "evidence_fingerprint": self.evidence_fingerprint,
            "evidence": self.evidence,
            "auto_diagnosable": self.auto_diagnosable,
        }


@dataclass(frozen=True)
class BlockResult:
    block_id: str
    operation: str
    decision: str
    reason: str
    recovery_instruction: str | None
    expected_postcondition: str | None
    human_action: str | None

    def as_dict(self) -> dict[str, object]:
        return {
            "block_id": self.block_id,
            "operation": self.operation,
            "decision": self.decision,
            "reason": self.reason,
            "recovery_instruction": self.recovery_instruction,
            "expected_postcondition": self.expected_postcondition,
            "human_action": self.human_action,
        }


@dataclass(frozen=True)
class BlockRequest:
    p_id: str
    allow_merge: bool
    paths: PPaths
    repository: str
    block_id: str
    operation: str
    packet_text: str
    packet_sha256: str
    conversation_url: str
    head: str
    base: str
    mailbox_issue: int


def block_config_path(state_root: Path) -> Path:
    return Path(state_root).resolve() / BLOCK_CONFIG_FILE


def _validate_url(value: object) -> str:
    if type(value) is not str or not value.strip():
        raise FactError("BLOCK_GPT conversation URL must be a non-empty string")
    from .browser_transport import canonical_conversation_url

    try:
        canonical = canonical_conversation_url(value)
    except RuntimeError as error:
        raise FactError(str(error)) from error
    if not canonical.startswith("https://chatgpt.com/c/"):
        raise FactError("BLOCK_GPT conversation URL must be an https://chatgpt.com/c/... URL")
    return canonical


def load_block_config(state_root: Path, path: Path | None = None) -> BlockGPTConfig:
    source = Path(path).resolve() if path is not None else block_config_path(state_root)
    if not source.exists():
        return BlockGPTConfig()
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or set(value) != {"enabled", "conversation_url"}:
            raise TypeError("keys must be exactly enabled and conversation_url")
        if type(value["enabled"]) is not bool:
            raise TypeError("enabled must be boolean")
        url_value = value["conversation_url"]
        url = None if url_value is None else _validate_url(url_value)
        return BlockGPTConfig(value["enabled"], url)
    except (OSError, json.JSONDecodeError, TypeError, ValueError, FactError) as error:
        raise FactError(f"invalid BLOCK_GPT config {source}: {error}") from error


def _atomic_config_write(source: Path, config: BlockGPTConfig) -> None:
    source.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {"conversation_url": config.conversation_url, "enabled": config.enabled},
        indent=2,
        sort_keys=True,
        ensure_ascii=False,
    ) + "\n"
    fd, name = tempfile.mkstemp(prefix=f".{source.name}.", suffix=".tmp", dir=source.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, source)
    finally:
        temporary.unlink(missing_ok=True)


def _check_binding_collisions(state_root: Path, conversation_url: str) -> None:
    from .legacy_v1_browser_compat import load_compat_config
    from .scheduler import load_registry

    compat = (
        load_compat_config(state_root)
        if (Path(state_root).resolve() / "legacy_v1_browser_compat.json").exists()
        else None
    )
    if compat is not None and compat.conversations.get("judge") == conversation_url:
        raise FactError("BLOCK_GPT conversation must differ from the global JUDGE URL")
    registry = (
        load_registry(state_root)
        if (Path(state_root).resolve() / "projects.json").exists()
        else None
    )
    if registry is None:
        return
    for entry in registry.enabled:
        if entry.plan_conversation_url == conversation_url:
            raise FactError(
                f"BLOCK_GPT conversation is already bound to active PLAN P {entry.p_id}"
            )


def set_block_config(
    state_root: Path,
    *,
    enabled: bool | None = None,
    conversation_url: str | None | object = None,
    update_url: bool = False,
    path: Path | None = None,
) -> BlockGPTConfig:
    """Update only operational BLOCK_GPT controls, atomically and idempotently."""
    if enabled is None and not update_url:
        raise FactError("BLOCK_GPT config update requires enabled or conversation_url")
    source = Path(path).resolve() if path is not None else block_config_path(state_root)
    current = load_block_config(state_root, source)
    next_url = current.conversation_url
    if update_url:
        next_url = None if conversation_url is None else _validate_url(conversation_url)
        if next_url is not None:
            _check_binding_collisions(state_root, next_url)
    next_config = BlockGPTConfig(
        current.enabled if enabled is None else enabled,
        next_url,
    )
    if next_config != current:
        _atomic_config_write(source, next_config)
    return next_config


def _redact_evidence(text: str) -> str:
    value = str(text or "")
    value = re.sub(r"(?i)(token|secret|api[_-]?key|authorization)(\s*[:=]\s*)\S+", r"\1=<redacted>", value)
    value = re.sub(r"(?i)bearer\s+\S+", "Bearer <redacted>", value)
    value = re.sub(r"\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?\b", "<timestamp>", value)
    value = re.sub(
        r"\b(?:timestamp|time|at|after|elapsed)(?:\s*[:=]\s*|\s+)\d+(?:\.\d+)?(?:ms|s)?\b",
        "<timestamp>", value, flags=re.I,
    )
    value = re.sub(r"\b(?:pid|process)[=: ]+\d+\b", "pid=<redacted>", value, flags=re.I)
    value = " ".join(value.split())
    return value[:MAX_EVIDENCE]


def _classify_detail(detail: str) -> tuple[str, str] | None:
    normalized = _redact_evidence(detail)
    lower = normalized.lower()
    if not normalized:
        return None
    if any(
        phrase in lower
        for phrase in (
            "codex guardian could not start or own the executor",
            "codex exited without a durable result",
            "codex exceeded the executor timeout",
        )
    ):
        return ("CODEX_RUNTIME_START_FAILED", "Codex runtime could not start or complete its bounded launch")
    if "command unavailable:" in lower:
        return ("LOCAL_AGENTBUS_COMPONENT_UNAVAILABLE", "A required local runtime component is unavailable")
    if "operational retry blocked:" in lower and not any(
        phrase in lower for phrase in (
            "lock is unavailable", "account lock", "no configured codex account",
            "ambiguous worktree", "identities drifted", "branch", "pr identity",
        )
    ):
        return ("EXECUTOR_LAUNCH_FAILED", "Executor launch was blocked by a concrete operational failure")
    return None


def derive_operational_block(
    p_id: str,
    action: Action | None,
    result: object | None = None,
    error: str | None = None,
) -> OperationalBlockObservation | None:
    """Derive an eligible observation from one completed normal tick only."""
    if action is None or action.kind is not ActionKind.WORK or not action.effect_id:
        return None
    detail = error if error else str(getattr(result, "detail", "") or "")
    classified = _classify_detail(detail)
    if classified is None:
        return None
    code, summary = classified
    evidence = _redact_evidence(detail)
    fingerprint = hashlib.sha256(evidence.encode("utf-8")).hexdigest()
    return OperationalBlockObservation(
        p_id=p_id,
        causal_effect_id=action.effect_id,
        code=code,
        summary=summary,
        evidence_fingerprint=fingerprint,
        evidence=evidence,
    )


def block_packet_dir(paths: PPaths) -> Path:
    return paths.root / "block" / "outbox"


def block_result_dir(paths: PPaths) -> Path:
    return paths.root / "block" / "results"


def render_block_packet(
    snapshot: Snapshot,
    action: Action,
    observation: OperationalBlockObservation,
) -> str:
    if action.kind is not ActionKind.WORK or action.effect_id != observation.causal_effect_id:
        raise FactError("BLOCK packet requires the exact current WORK effect")
    spec = snapshot.specs[-1] if snapshot.specs else None
    merge = snapshot.merge
    semantic: dict[str, object] = {
        "packet_schema": BLOCK_PACKET_SCHEMA,
        "block_id": observation.block_id,
        "operation": BLOCK_OPERATION,
        "p_id": snapshot.p_id,
        "causal_effect_id": observation.causal_effect_id,
        "current_semantic_decision": action.kind.value,
        "charter_digest": snapshot.charter_digest,
        "repository": snapshot.expected_repository,
        "branch": snapshot.expected_branch,
        "base_ref": snapshot.base_ref,
        "head": snapshot.head,
        "base": snapshot.base,
        "spec_id": spec.spec_id if spec else None,
        "plan_job_id": spec.plan_job_id if spec else None,
        "work_effect_id": action.effect_id,
        "prove_id": snapshot.proof_facts[-1].proof_id if snapshot.proof_facts else None,
        "judge_job_id": next(
            (item.job_id for item in reversed(snapshot.gpt_results)
             if item.operation == "JUDGE_GPT"),
            None,
        ),
        "operator_directive_id": (
            snapshot.operator_directive.directive_id
            if snapshot.operator_directive else None
        ),
        "pr_number": merge.pr_number if merge.available else None,
        "blocker_code": observation.code,
        "blocker_summary": observation.summary,
        "evidence_fingerprint": observation.evidence_fingerprint,
    }
    # Keep the human-readable packet bounded.  The semantic JSON above is the
    # only identity-bearing portion; the remaining material is diagnostic
    # context and is never interpreted as authority.
    context = {
        "runtime_observations": {"executor_effect": observation.causal_effect_id},
        "bounded_log_evidence": observation.evidence,
        "available_recovery_capabilities": [
            "observe the local executor/runtime precondition",
            "revalidate the exact worktree and executor ownership fences",
        ],
    }
    if spec is not None:
        context["current_spec"] = spec.text[:4000]
    if snapshot.operator_directive is not None:
        context["operator_directive"] = snapshot.operator_directive.text[:2000]
    text = (
        "# AgentBus v2 BLOCK_GPT packet\n\n"
        "This packet diagnoses one operational execution blocker.  It is not a\n"
        "request to modify code or execute recovery.\n\n"
        "## BLOCK SEMANTIC INPUTS\n```json\n"
        + json.dumps(semantic, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        + "\n```\n\n## BOUNDED OPERATIONAL CONTEXT\n```json\n"
        + json.dumps(context, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        + "\n```\n\n"
        "Return exactly one JSON object with keys block_id, operation, decision,\n"
        "reason, recovery_instruction, expected_postcondition, and human_action.\n"
        "Allowed decisions are RECOVER, WAIT, HUMAN. RECOVER is a proposal only;\n"
        "no recovery will be executed in this phase.\n"
    )
    if len(text.encode("utf-8")) > MAX_PACKET_TEXT:
        raise FactError("BLOCK_GPT packet exceeds bounded size")
    return text


def _packet_json(packet_text: str) -> dict[str, Any]:
    marker = "## BLOCK SEMANTIC INPUTS\n```json\n"
    if marker not in packet_text:
        raise FactError("BLOCK packet lacks semantic inputs")
    body = packet_text.split(marker, 1)[1].split("\n```", 1)[0]
    try:
        value = json.loads(body)
    except json.JSONDecodeError as error:
        raise FactError("BLOCK packet semantic inputs are invalid JSON") from error
    if not isinstance(value, dict):
        raise FactError("BLOCK packet semantic inputs must be an object")
    return value


def load_block_packet(paths: PPaths, block_id: str) -> dict[str, Any]:
    if not BLOCK_ID_RE.fullmatch(block_id):
        raise FactError(f"invalid BLOCK_GPT block_id: {block_id}")
    path = block_packet_dir(paths) / f"{block_id}.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise FactError(f"cannot read BLOCK_GPT packet {path}: {error}") from error
    value = _packet_json(text)
    if value.get("packet_schema") != BLOCK_PACKET_SCHEMA or value.get("block_id") != block_id:
        raise FactError(f"BLOCK packet identity mismatch: {block_id}")
    if value.get("operation") != BLOCK_OPERATION:
        raise FactError(f"BLOCK packet operation mismatch: {block_id}")
    expected = stable_id(
        "block",
        {
            "p_id": value.get("p_id"),
            "causal_effect_id": value.get("causal_effect_id"),
            "code": value.get("blocker_code"),
            "evidence_fingerprint": value.get("evidence_fingerprint"),
        },
    )
    if expected != block_id:
        raise FactError(f"BLOCK packet deterministic identity mismatch: {block_id}")
    return value


def _load_block_result(paths: PPaths, block_id: str) -> BlockResult | None:
    path = block_result_dir(paths) / f"{block_id}.json"
    if not path.exists():
        return None
    value = _load_json(path)
    return parse_block_response(value, expected_block_id=block_id)


def parse_block_response(
    value: Mapping[str, Any], *, expected_block_id: str
) -> BlockResult:
    required = {
        "block_id", "operation", "decision", "reason", "recovery_instruction",
        "expected_postcondition", "human_action",
    }
    if set(value) != required:
        raise FactError("BLOCK_GPT response keys are not exact")
    if value.get("block_id") != expected_block_id or not BLOCK_ID_RE.fullmatch(str(expected_block_id)):
        raise FactError("BLOCK_GPT response block_id is stale or mismatched")
    if value.get("operation") != BLOCK_OPERATION:
        raise FactError("BLOCK_GPT response operation is not BLOCK_GPT")
    decision = value.get("decision")
    if decision not in BLOCK_DECISIONS:
        raise FactError("BLOCK_GPT response decision is unsupported")
    reason = value.get("reason")
    if type(reason) is not str or not reason.strip() or len(reason) > 4000:
        raise FactError("BLOCK_GPT response reason is invalid")
    recovery = value.get("recovery_instruction")
    postcondition = value.get("expected_postcondition")
    human = value.get("human_action")
    for name, item in (("recovery_instruction", recovery), ("expected_postcondition", postcondition), ("human_action", human)):
        if item is not None and (type(item) is not str or not item.strip() or len(item) > 4000):
            raise FactError(f"BLOCK_GPT response {name} is invalid")
    if decision == "RECOVER":
        if not isinstance(recovery, str) or not recovery.strip() or not isinstance(postcondition, str) or not postcondition.strip():
            raise FactError("RECOVER requires recovery_instruction and expected_postcondition")
        if human is not None:
            raise FactError("RECOVER cannot include human_action")
    elif decision == "WAIT":
        if recovery is not None or postcondition is not None or human is not None:
            raise FactError("WAIT cannot propose recovery or human action")
    else:
        if not isinstance(human, str) or not human.strip() or recovery is not None or postcondition is not None:
            raise FactError("HUMAN requires human_action and no recovery proposal")
    return BlockResult(expected_block_id, BLOCK_OPERATION, decision, reason.strip(), recovery, postcondition, human)


def submit_block_gpt_response(paths: PPaths, response_path: Path) -> object:
    from .effects import EffectResult

    all_packets = sorted(block_packet_dir(paths).glob("block-*.md"))
    candidates = sorted(
        path for path in all_packets
        if not (block_result_dir(paths) / f"{path.stem}.json").exists()
    )
    if not candidates:
        # An already accepted exact result is idempotent.  It is the only
        # exception to the current-packet requirement and cannot be replaced
        # by a different immutable payload.
        result_paths = sorted(block_result_dir(paths).glob("block-*.json"))
        if len(result_paths) == 1:
            existing = _load_json(result_paths[0])
            expected = parse_block_response(existing, expected_block_id=result_paths[0].stem)
            incoming = parse_block_response(_load_json(Path(response_path)), expected_block_id=expected.block_id)
            if incoming.as_dict() != expected.as_dict():
                raise FactError(f"conflicting immutable BLOCK_GPT result: {result_paths[0]}")
            from .effects import EffectResult
            return EffectResult(False, f"BLOCK_GPT result already accepted: {expected.block_id}")
    if len(candidates) != 1:
        raise FactError("BLOCK_GPT response requires exactly one current packet")
    packet_text = candidates[0].read_text(encoding="utf-8")
    packet = _packet_json(packet_text)
    block_id = str(packet.get("block_id", ""))
    if not BLOCK_ID_RE.fullmatch(block_id):
        raise FactError("BLOCK packet has invalid block_id")
    packet = load_block_packet(paths, block_id)
    snapshot = read_snapshot(paths)
    action = decide(snapshot)
    if action.kind is not ActionKind.WORK or action.effect_id != packet.get("causal_effect_id"):
        raise FactError("BLOCK_GPT response is no longer current for this WORK effect")
    try:
        value = _load_json(Path(response_path))
    except FactError:
        raise
    result = parse_block_response(value, expected_block_id=block_id)
    result_path = block_result_dir(paths) / f"{block_id}.json"
    changed = write_json_once(result_path, result.as_dict())
    return EffectResult(changed, f"BLOCK_GPT result {'accepted' if changed else 'already accepted'}: {block_id}")


def _packet_request(paths: PPaths, entry: Any, config: BlockGPTConfig) -> BlockRequest | None:
    if config.conversation_url is None:
        return None
    snapshot = read_snapshot(paths, allow_merge=entry.allow_merge)
    action = decide(snapshot)
    if action.kind is not ActionKind.WORK or not action.effect_id:
        return None
    candidates: list[tuple[Path, dict[str, Any], str]] = []
    for path in sorted(block_packet_dir(paths).glob("block-*.md")):
        try:
            text = path.read_text(encoding="utf-8")
            value = _packet_json(text)
            if (
                value.get("p_id") == entry.p_id
                and value.get("operation") == BLOCK_OPERATION
                and value.get("causal_effect_id") == action.effect_id
                and value.get("block_id") == path.stem
                and not (block_result_dir(paths) / f"{path.stem}.json").exists()
                and stable_id(
                    "block",
                    {
                        "p_id": value.get("p_id"),
                        "causal_effect_id": value.get("causal_effect_id"),
                        "code": value.get("blocker_code"),
                        "evidence_fingerprint": value.get("evidence_fingerprint"),
                    },
                ) == value.get("block_id")
            ):
                candidates.append((path, value, text))
        except (FactError, OSError):
            continue
    if len(candidates) != 1:
        return None
    path, value, text = candidates[0]
    p_config = load_config(paths)
    from .legacy_v1_browser_compat import load_compat_config

    compat = load_compat_config(paths.root.parent)
    issue = compat.mailboxes.get(p_config.repository)
    if issue is None:
        raise FactError(f"mailbox is not configured for {p_config.repository}")
    return BlockRequest(
        entry.p_id,
        entry.allow_merge,
        paths,
        p_config.repository,
        str(value["block_id"]),
        BLOCK_OPERATION,
        text,
        sha256_text(text),
        config.conversation_url,
        snapshot.head,
        snapshot.base,
        issue,
    )


def current_block_request(state_root: Path, entry: Any) -> BlockRequest | None:
    config = load_block_config(state_root)
    if config.conversation_url is None:
        return None
    return _packet_request(paths_for(state_root, entry.p_id), entry, config)


class BlockDiagnosisSupervisor:
    """Memory-only observer and idempotent BLOCK packet creator."""

    def __init__(self, state_root: Path, *, registry_path: Path | None = None) -> None:
        self.state_root = Path(state_root).resolve()
        self.registry_path = Path(registry_path).resolve() if registry_path else None
        self._observations: dict[str, OperationalBlockObservation] = {}
        self._lock = threading.RLock()

    def observation(self, p_id: str) -> OperationalBlockObservation | None:
        with self._lock:
            return self._observations.get(p_id)

    def observe(
        self,
        p_id: str,
        action: Action | None,
        result: object | None = None,
        error: str | None = None,
        *,
        entry: Any | None = None,
    ) -> OperationalBlockObservation | None:
        observation = derive_operational_block(p_id, action, result, error)
        if observation is None:
            with self._lock:
                self._observations.pop(p_id, None)
            return None
        with self._lock:
            self._observations[p_id] = observation
        if entry is None:
            from .scheduler import load_registry

            registry = load_registry(self.state_root, self.registry_path)
            entry = next((item for item in registry.entries if item.p_id == p_id), None)
        if entry is None or not entry.enabled or entry.archived:
            return observation
        config = load_block_config(self.state_root)
        if not config.enabled or config.conversation_url is None:
            return observation
        paths = paths_for(self.state_root, p_id)
        snapshot = read_snapshot(paths, allow_merge=entry.allow_merge)
        current = decide(snapshot)
        if current.kind is not ActionKind.WORK or current.effect_id != observation.causal_effect_id:
            return observation
        packet = render_block_packet(snapshot, current, observation)
        write_text_once(block_packet_dir(paths) / f"{observation.block_id}.md", packet)
        return observation


def block_view(
    state_root: Path,
    entry: Any,
    snapshot: Snapshot,
    action: Action,
    observation: OperationalBlockObservation | None = None,
) -> dict[str, object] | None:
    if action.kind is not ActionKind.WORK or not action.effect_id:
        return None
    if observation is None:
        packet_paths = sorted(block_packet_dir(paths_for(state_root, entry.p_id)).glob("block-*.md"))
        for path in packet_paths:
            try:
                value = load_block_packet(paths_for(state_root, entry.p_id), path.stem)
                if value.get("p_id") == entry.p_id and value.get("causal_effect_id") == action.effect_id:
                    observation = OperationalBlockObservation(
                        entry.p_id, action.effect_id, str(value["blocker_code"]),
                        str(value["blocker_summary"]), str(value["evidence_fingerprint"]),
                        "packet evidence",
                    )
                    break
            except (FactError, OSError, KeyError):
                continue
    if observation is None:
        return None
    paths = paths_for(state_root, entry.p_id)
    packet_path = block_packet_dir(paths) / f"{observation.block_id}.md"
    result_path = block_result_dir(paths) / f"{observation.block_id}.json"
    result = _load_block_result(paths, observation.block_id) if result_path.exists() else None
    packet = packet_path.exists()
    return {
        "observation": observation.as_dict(),
        "request": {
            "block_id": observation.block_id,
            "operation": BLOCK_OPERATION,
            "pending": packet and result is None,
        },
        "result": result.as_dict() if result is not None else None,
    }
