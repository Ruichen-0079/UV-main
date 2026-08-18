from __future__ import annotations

from typing import Any

from agentbus.gitutil import classify_relation
from agentbus.machine import RE_REVIEW_REQUIRED


class FenceResult:
    def __init__(self, ok: bool, reason: str = "", relation: str = "") -> None:
        self.ok = ok
        self.reason = reason
        self.relation = relation

    def __bool__(self) -> bool:
        return self.ok


def fence_spec(repo: str, spec_base: str | None, current: str | None) -> FenceResult:
    if not spec_base:
        return FenceResult(False, "GPT_SPEC missing BASE_HEAD")
    if not current:
        return FenceResult(False, "current HEAD is unknown")
    relation = classify_relation(repo, spec_base, current)
    if relation in {"equal", "descendant"}:
        return FenceResult(True, "", relation)
    if relation == "behind":
        return FenceResult(
            False,
            f"current HEAD {current[:7]} is behind SPEC_BASE_HEAD {spec_base[:7]}",
            relation,
        )
    if relation == "diverged":
        return FenceResult(
            False,
            f"current HEAD {current[:7]} diverged from SPEC_BASE_HEAD {spec_base[:7]}",
            relation,
        )
    return FenceResult(
        False,
        f"cannot relate current HEAD {current[:7]} to SPEC_BASE_HEAD {spec_base[:7]}",
        relation,
    )


def fence_exact(expected: str | None, actual: str | None, *, label: str) -> FenceResult:
    if not expected:
        return FenceResult(False, f"{label} is missing")
    if not actual:
        return FenceResult(False, f"current HEAD is unknown while checking {label}")
    if expected == actual:
        return FenceResult(True, "", "equal")
    return FenceResult(
        False,
        f"{label} {expected[:7]} does not match current HEAD {actual[:7]}",
        "mismatch",
    )


def detect_external_head_change(state: dict[str, Any], current: str | None) -> FenceResult:
    last = (state.get("heads") or {}).get("last_seen")
    implemented = (state.get("heads") or {}).get("implemented")
    phase = state.get("phase")
    if not current or not last or current == last:
        return FenceResult(True, "", "equal")
    if phase in {"IMPLEMENTING", "VALIDATING"}:
        return FenceResult(True, "implementation may advance HEAD", "expected")
    if implemented and current != implemented and phase in {
        "READY_FOR_AUDIT",
        "AUDITING",
        "READY_FOR_GPT",
        "GPT_REVIEW",
        "FINAL_GATE",
    }:
        return FenceResult(
            False,
            f"HEAD moved from {last[:7]} to {current[:7]} after implementation {implemented[:7]}",
            "external",
        )
    return FenceResult(True, "HEAD changed", "changed")


def fence_failure_phase() -> str:
    return RE_REVIEW_REQUIRED
