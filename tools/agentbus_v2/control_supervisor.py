"""Memory-only stall observation and operational CONTROL orchestration.

A scheduler restart resets the in-memory timer.  CONTROL, diagnosis, BLOCK,
and recovery remain outside the semantic kernel.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import threading
import time
from typing import Any, Mapping

from .block_diagnosis import (
    BlockResult,
    _load_block_result,
    block_packet_dir,
    block_result_dir,
    derive_diagnosed_stall_block,
    load_block_config,
    load_block_packet,
    render_diagnosed_block_packet,
)
from .block_recovery import current_recovery, run_block_recovery
from .control import (
    CONTROL_PURPOSE_RECOVERY_ROUTE,
    CONTROL_PURPOSE_STALL_TRIAGE,
    CONTROL_PURPOSE_WORK_ROUTE,
    STALL_ELIGIBLE_KINDS,
    ControlResult,
    current_control_request,
    ensure_control_request,
    load_control_config,
    load_control_result,
)
from .core import Action, ActionKind, Snapshot, decide
from .effects import EffectResult
from .facts import FactError, load_config, paths_for, read_snapshot, write_text_once
from .readonly_diagnosis import (
    current_diagnosis,
    observation_fingerprint,
    run_readonly_diagnosis,
    semantic_fact_fingerprint,
)


STALL_THRESHOLD_SECONDS = 600.0
_CONTROL_TRANSPORT_WAITS = (
    "WORK awaiting CONTROL_GPT routing",
    "stall awaiting CONTROL_GPT triage",
    "recovery awaiting CONTROL_GPT route",
    "CONTROL_WAIT",
    "CONTROL_HUMAN",
    "CONTROL_SIMPLIFY_RECOMMENDED",
)


@dataclass
class StallMemory:
    p_id: str
    action_kind: str
    effect_id: str
    semantic_fingerprint: str
    started: float
    last_detail: str


class ControlSupervisor:
    """Memory-only observer that may create CONTROL/BLOCK operational packets."""

    def __init__(
        self,
        state_root,
        *,
        registry_path=None,
        clock=time.monotonic,
        threshold: float = STALL_THRESHOLD_SECONDS,
    ) -> None:
        self.state_root = __import__("pathlib").Path(state_root).resolve()
        self.registry_path = (
            __import__("pathlib").Path(registry_path).resolve() if registry_path else None
        )
        self.clock = clock
        self.threshold = float(threshold)
        self._stalls: dict[str, StallMemory] = {}
        self._recent: dict[str, deque[dict[str, object]]] = {}
        self._lock = threading.RLock()

    def stall(self, p_id: str) -> StallMemory | None:
        with self._lock:
            return self._stalls.get(p_id)

    def recent_events(self, p_id: str, limit: int = 8) -> tuple[dict[str, object], ...]:
        with self._lock:
            items = self._recent.get(p_id)
            if not items:
                return ()
            return tuple(list(items)[-limit:])

    def observe(
        self,
        p_id: str,
        action: Action | None,
        result: object | None = None,
        error: str | None = None,
        *,
        entry: Any | None = None,
        snapshot: Snapshot | None = None,
        executor_active: bool = False,
    ) -> StallMemory | None:
        detail = error if error else str(getattr(result, "detail", "") or "")
        changed = bool(getattr(result, "changed", False))
        with self._lock:
            events = self._recent.setdefault(p_id, deque(maxlen=8))
            events.append({
                "action": None if action is None else action.kind.value,
                "effect_id": None if action is None else action.effect_id,
                "changed": changed,
                "detail": detail[:300],
            })
        if (
            entry is None
            or not getattr(entry, "enabled", True)
            or getattr(entry, "archived", False)
            or action is None
            or action.kind not in STALL_ELIGIBLE_KINDS
            or not action.effect_id
            or changed
            or executor_active
        ):
            with self._lock:
                self._stalls.pop(p_id, None)
            return None
        fingerprint = ""
        if snapshot is not None:
            fingerprint = semantic_fact_fingerprint(snapshot)
        with self._lock:
            current = self._stalls.get(p_id)
            if (
                current is None
                or current.action_kind != action.kind.value
                or current.effect_id != action.effect_id
                or current.semantic_fingerprint != fingerprint
            ):
                current = StallMemory(
                    p_id, action.kind.value, action.effect_id, fingerprint,
                    self.clock(), detail,
                )
                self._stalls[p_id] = current
            else:
                current.last_detail = detail
        elapsed = self.clock() - current.started
        if elapsed < self.threshold:
            return current
        self._maybe_escalate(p_id, action, result, entry, snapshot, current, elapsed)
        return current

    def _maybe_escalate(
        self,
        p_id: str,
        action: Action,
        result: object | None,
        entry: Any,
        snapshot: Snapshot | None,
        memory: StallMemory,
        elapsed: float,
    ) -> None:
        config = load_control_config(self.state_root)
        if not config.enabled or config.conversation_url is None:
            return
        detail = memory.last_detail
        if any(marker in detail for marker in _CONTROL_TRANSPORT_WAITS):
            return
        work_pending = current_control_request(
            self.state_root, entry, purpose=CONTROL_PURPOSE_WORK_ROUTE
        )
        if work_pending is not None:
            return
        stall_pending = current_control_request(
            self.state_root, entry, purpose=CONTROL_PURPOSE_STALL_TRIAGE
        )
        if stall_pending is not None:
            return
        if snapshot is None:
            paths = paths_for(self.state_root, p_id)
            snapshot = read_snapshot(paths, allow_merge=bool(getattr(entry, "allow_merge", False)))
            action = decide(snapshot)
            if action.kind not in STALL_ELIGIBLE_KINDS or action.effect_id != memory.effect_id:
                return
        paths = paths_for(self.state_root, p_id)
        stall_job = _stall_job_id(snapshot, action)
        if stall_job is not None and load_control_result(paths, stall_job) is not None:
            self._after_stall_result(p_id, entry, snapshot, action, load_control_result(paths, stall_job), memory, elapsed)
            return
        if _current_block(paths, snapshot, action) is not None:
            return
        if any((block_result_dir(paths) / f"{path.stem}.json").exists() is False
               for path in block_packet_dir(paths).glob("block-*.md")):
            return
        context = _stall_context(
            snapshot, action, memory, elapsed,
            recent=self.recent_events(p_id),
            diagnosis=current_diagnosis(paths, snapshot, action, detail=memory.last_detail),
        )
        ensure_control_request(
            self.state_root, entry, expected_action=action,
            allow_merge=bool(getattr(entry, "allow_merge", False)),
            purpose=CONTROL_PURPOSE_STALL_TRIAGE,
            context=context,
        )

    def _after_stall_result(
        self,
        p_id: str,
        entry: Any,
        snapshot: Snapshot,
        action: Action,
        result: ControlResult | None,
        memory: StallMemory,
        elapsed: float,
    ) -> None:
        if result is None or result.decision != "DIAGNOSE":
            return
        paths = paths_for(self.state_root, p_id)
        diagnosis = current_diagnosis(paths, snapshot, action, detail=memory.last_detail)
        if diagnosis is None or not diagnosis.get("accepted") or not diagnosis.get("report"):
            return
        block_config = load_block_config(self.state_root)
        if not block_config.enabled or block_config.conversation_url is None:
            return
        block = _current_block(paths, snapshot, action)
        if block is None:
            if any(
                not (block_result_dir(paths) / f"{path.stem}.json").exists()
                for path in block_packet_dir(paths).glob("block-*.md")
            ):
                return
            observation = derive_diagnosed_stall_block(p_id, action, diagnosis)
            packet = render_diagnosed_block_packet(snapshot, action, observation, diagnosis)
            write_text_once(block_packet_dir(paths) / f"{observation.block_id}.md", packet)
            return
        if block.decision != "RECOVER":
            return
        if current_control_request(
            self.state_root, entry, purpose=CONTROL_PURPOSE_RECOVERY_ROUTE,
            context={"block_id": block.block_id},
        ) is not None:
            return
        recovery = current_recovery(paths, block)
        if recovery is not None:
            return
        ensure_control_request(
            self.state_root, entry, expected_action=action,
            allow_merge=bool(getattr(entry, "allow_merge", False)),
            purpose=CONTROL_PURPOSE_RECOVERY_ROUTE,
            context=_recovery_context(block, diagnosis, snapshot, action),
        )


def _stall_job_id(snapshot: Snapshot, action: Action) -> str | None:
    from .control import control_id, current_spec

    if not action.effect_id:
        return None
    spec = None
    if action.payload.get("spec_id"):
        spec = next((item for item in snapshot.specs if item.spec_id == action.payload.get("spec_id")), None)
    elif snapshot.specs:
        spec = current_spec(snapshot)
    return control_id(
        purpose=CONTROL_PURPOSE_STALL_TRIAGE,
        p_id=snapshot.p_id,
        causal_effect_id=action.effect_id,
        spec_id=None if spec is None else spec.spec_id,
    )


def _recovery_job_id(snapshot: Snapshot, action: Action, block_id: str) -> str | None:
    from .control import control_id, current_spec

    spec = None
    if action.payload.get("spec_id"):
        spec = next((item for item in snapshot.specs if item.spec_id == action.payload.get("spec_id")), None)
    elif snapshot.specs:
        spec = current_spec(snapshot)
    return control_id(
        purpose=CONTROL_PURPOSE_RECOVERY_ROUTE,
        p_id=snapshot.p_id,
        causal_effect_id=block_id,
        spec_id=None if spec is None else spec.spec_id,
    )


def _stall_context(
    snapshot: Snapshot,
    action: Action,
    memory: StallMemory,
    elapsed: float,
    *,
    recent: tuple[dict[str, object], ...],
    diagnosis: Mapping[str, Any] | None,
) -> dict[str, object]:
    merge = snapshot.merge
    return {
        "elapsed_seconds": int(elapsed),
        "elapsed_is_telemetry_only": True,
        "result_detail": memory.last_detail[:500],
        "executor_active": False,
        "recent_scheduler_events": list(recent),
        "ci_summary": {
            "check_status": merge.check_status if merge.available else None,
            "pr_number": merge.pr_number if merge.available else None,
            "pr_base_sha": merge.pr_base_sha if merge.available else None,
        },
        "diagnosis_exists": bool(diagnosis and diagnosis.get("accepted")),
        "observation_fingerprint": observation_fingerprint(action, memory.last_detail),
    }


def _recovery_context(
    block: BlockResult,
    diagnosis: Mapping[str, Any] | None,
    snapshot: Snapshot,
    action: Action,
) -> dict[str, object]:
    return {
        "block_id": block.block_id,
        "block_result": block.as_dict(),
        "diagnosis": None if diagnosis is None else dict(diagnosis.get("report") or {}),
        "current_action_kind": action.kind.value,
        "current_effect_id": action.effect_id,
        "head": snapshot.head,
        "base": snapshot.base,
    }


def _current_block(paths, snapshot: Snapshot, action: Action) -> BlockResult | None:
    for path in sorted(block_packet_dir(paths).glob("block-*.md")):
        try:
            packet = load_block_packet(paths, path.stem)
        except (FactError, OSError):
            continue
        if packet.get("causal_effect_id") != action.effect_id:
            continue
        source = packet.get("block_source") or "WORK_RUNTIME"
        if source == "DIAGNOSED_STALL":
            if packet.get("causal_action_kind") != action.kind.value:
                continue
        elif action.kind is not ActionKind.WORK:
            continue
        result = _load_block_result(paths, path.stem)
        if result is not None:
            return result
    return None


def drive_authorized_operations(
    state_root,
    entry: Any,
    snapshot: Snapshot,
    action: Action,
    *,
    allow_merge: bool = False,
    diagnosis_executor=None,
    recovery_executor=None,
    stall_detail: str = "",
) -> EffectResult | None:
    """Run at most one authorized diagnosis or recovery on the P worker.

    Packet creation stays in the memory-only supervisor.  This function never
    waits for Web GPT and does not change semantic identity.
    """
    if entry is None or not getattr(entry, "enabled", True) or getattr(entry, "archived", False):
        return None
    if action.kind not in STALL_ELIGIBLE_KINDS or not action.effect_id:
        return None
    control = load_control_config(state_root)
    if not control.enabled or control.conversation_url is None:
        return None
    paths = paths_for(state_root, entry.p_id)
    config = load_config(paths)
    stall_job = _stall_job_id(snapshot, action)
    stall_result = load_control_result(paths, stall_job) if stall_job else None
    if stall_result is not None and stall_result.decision == "DIAGNOSE":
        existing = current_diagnosis(paths, snapshot, action, detail=stall_detail)
        if existing is None:
            return run_readonly_diagnosis(
                state_root, paths, config, snapshot, action,
                detail=stall_detail, executor=diagnosis_executor,
            )
        if existing.get("accepted") and existing.get("report"):
            block = _current_block(paths, snapshot, action)
            if block is not None and block.decision == "RECOVER":
                recovery_job = _recovery_job_id(snapshot, action, block.block_id)
                recovery_result = load_control_result(paths, recovery_job) if recovery_job else None
                if recovery_result is None:
                    return None
                if recovery_result.decision in {"WAIT", "HUMAN"}:
                    return None
                if recovery_result.decision not in {"CODEX", "GROK"}:
                    return None
                if current_recovery(paths, block) is not None:
                    return None
                return run_block_recovery(
                    state_root, paths, config, snapshot, action, block,
                    route=recovery_result.decision,
                    diagnosis=existing.get("report"),
                    executor=recovery_executor,
                )
    return None


def operational_view(
    state_root,
    entry: Any,
    snapshot: Snapshot,
    action: Action,
    *,
    stall: StallMemory | None = None,
    clock=time.monotonic,
) -> dict[str, object]:
    """Read-only projection.  Status GET must not launch Codex or Grok."""
    try:
        paths = paths_for(state_root, getattr(entry, "p_id", snapshot.p_id))
    except FactError:
        return {
            "label": None, "stall_age_seconds": None, "stall_control_id": None,
            "stall_decision": None, "diagnosis_id": None, "diagnosis_status": None,
            "block_id": None, "block_decision": None, "recovery_route": None,
            "recovery_id": None, "recovery_status": None,
        }
    try:
        return _operational_view_body(
            state_root, entry, snapshot, action, paths, stall=stall, clock=clock
        )
    except (FactError, OSError):
        return {
            "label": None, "stall_age_seconds": None, "stall_control_id": None,
            "stall_decision": None, "diagnosis_id": None, "diagnosis_status": None,
            "block_id": None, "block_decision": None, "recovery_route": None,
            "recovery_id": None, "recovery_status": None,
        }


def _operational_view_body(
    state_root,
    entry: Any,
    snapshot: Snapshot,
    action: Action,
    paths,
    *,
    stall: StallMemory | None,
    clock,
) -> dict[str, object]:
    elapsed = None if stall is None else max(0, int(clock() - stall.started))
    stall_job = _stall_job_id(snapshot, action) if action.kind in STALL_ELIGIBLE_KINDS else None
    stall_result = load_control_result(paths, stall_job) if stall_job else None
    diagnosis = current_diagnosis(
        paths, snapshot, action, detail="" if stall is None else stall.last_detail,
    )
    block = _current_block(paths, snapshot, action)
    recovery = current_recovery(paths, block) if block is not None else None
    recovery_job = (
        _recovery_job_id(snapshot, action, block.block_id) if block is not None else None
    )
    recovery_route = load_control_result(paths, recovery_job) if recovery_job else None
    label = None
    if action.kind in {ActionKind.DONE, ActionKind.HUMAN, ActionKind.MERGE_READY}:
        label = None
    elif recovery is not None:
        label = f"operational recovery: {recovery.get('route') or ''} {recovery.get('operational_status') or ''}".strip()
    elif recovery_route is not None:
        label = f"CONTROL recovery route {recovery_route.decision}"
    elif block is not None:
        label = f"BLOCK_GPT {block.decision}"
    elif diagnosis is not None and diagnosis.get("operational_status") == "ACCEPTED":
        label = "read-only diagnosis complete"
    elif stall_result is not None and stall_result.decision == "DIAGNOSE":
        label = "read-only diagnosis running"
    elif stall_result is not None:
        label = f"CONTROL stall triage {stall_result.decision}"
    elif stall_job and (paths.root / "control" / "outbox" / f"{stall_job}.md").exists():
        label = "CONTROL stall triage pending"
    elif elapsed is not None and elapsed >= 60:
        minutes = elapsed // 60
        label = f"no progress {minutes}m"
    return {
        "label": label,
        "stall_age_seconds": elapsed,
        "stall_control_id": stall_job,
        "stall_decision": None if stall_result is None else stall_result.decision,
        "diagnosis_id": None if diagnosis is None else diagnosis.get("diagnosis_id"),
        "diagnosis_status": None if diagnosis is None else diagnosis.get("operational_status"),
        "block_id": None if block is None else block.block_id,
        "block_decision": None if block is None else block.decision,
        "recovery_route": None if recovery_route is None else recovery_route.decision,
        "recovery_id": None if recovery is None else recovery.get("recovery_id"),
        "recovery_status": None if recovery is None else recovery.get("operational_status"),
    }
