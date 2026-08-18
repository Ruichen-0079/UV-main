from __future__ import annotations

from typing import Iterable


WAITING_FOR_SPEC = "WAITING_FOR_SPEC"
MATERIALIZING = "MATERIALIZING"
WORKTREE_READY = "WORKTREE_READY"
BOOTSTRAP_PR_READY = "BOOTSTRAP_PR_READY"
IMPLEMENTING = "IMPLEMENTING"
VALIDATING = "VALIDATING"
READY_FOR_AUDIT = "READY_FOR_AUDIT"
AUDITING = "AUDITING"
READY_FOR_GPT = "READY_FOR_GPT"
GPT_REVIEW = "GPT_REVIEW"
FINAL_GATE = "FINAL_GATE"
MERGE_PENDING = "MERGE_PENDING"
MERGE_RETRYABLE_FAILED = "MERGE_RETRYABLE_FAILED"
MERGED = "MERGED"
BLOCKED = "BLOCKED"
PAUSED = "PAUSED"
RECOVERY_REQUIRED = "RECOVERY_REQUIRED"
BLOCKED_FOR_REVIEW = "BLOCKED_FOR_REVIEW"
RE_REVIEW_REQUIRED = "RE_REVIEW_REQUIRED"

PHASES = (
    WAITING_FOR_SPEC,
    MATERIALIZING,
    WORKTREE_READY,
    BOOTSTRAP_PR_READY,
    IMPLEMENTING,
    VALIDATING,
    READY_FOR_AUDIT,
    AUDITING,
    READY_FOR_GPT,
    GPT_REVIEW,
    FINAL_GATE,
    MERGE_PENDING,
    MERGE_RETRYABLE_FAILED,
    MERGED,
    BLOCKED,
    PAUSED,
    RECOVERY_REQUIRED,
    BLOCKED_FOR_REVIEW,
    RE_REVIEW_REQUIRED,
)

EXCEPTIONAL = {
    BLOCKED,
    PAUSED,
    RECOVERY_REQUIRED,
    BLOCKED_FOR_REVIEW,
    RE_REVIEW_REQUIRED,
}

# True human decisions only. Browser GPT wait is not a human gate.
HUMAN_GATES = {
    FINAL_GATE,
    BLOCKED,
    BLOCKED_FOR_REVIEW,
    RE_REVIEW_REQUIRED,
    RECOVERY_REQUIRED,
}

BROWSER_GPT_GATES = {
    WAITING_FOR_SPEC,
    READY_FOR_GPT,
    GPT_REVIEW,
}

LEGAL_TRANSITIONS: dict[str, set[str]] = {
    WAITING_FOR_SPEC: {
        MATERIALIZING,
        WORKTREE_READY,
        BOOTSTRAP_PR_READY,
        IMPLEMENTING,
        PAUSED,
        BLOCKED,
        RE_REVIEW_REQUIRED,
        RECOVERY_REQUIRED,
    },
    MATERIALIZING: {
        WORKTREE_READY,
        BOOTSTRAP_PR_READY,
        IMPLEMENTING,
        BLOCKED,
        PAUSED,
        RECOVERY_REQUIRED,
    },
    WORKTREE_READY: {
        BOOTSTRAP_PR_READY,
        IMPLEMENTING,
        BLOCKED,
        PAUSED,
        RECOVERY_REQUIRED,
        WORKTREE_READY,
    },
    BOOTSTRAP_PR_READY: {
        IMPLEMENTING,
        WORKTREE_READY,
        BLOCKED,
        PAUSED,
        RECOVERY_REQUIRED,
    },
    IMPLEMENTING: {
        VALIDATING,
        IMPLEMENTING,
        PAUSED,
        BLOCKED,
        RECOVERY_REQUIRED,
        RE_REVIEW_REQUIRED,
        FINAL_GATE,
        READY_FOR_GPT,
    },
    VALIDATING: {
        READY_FOR_AUDIT,
        IMPLEMENTING,
        BLOCKED,
        RECOVERY_REQUIRED,
        PAUSED,
        RE_REVIEW_REQUIRED,
        FINAL_GATE,
    },
    READY_FOR_AUDIT: {
        AUDITING,
        PAUSED,
        BLOCKED,
        RECOVERY_REQUIRED,
        RE_REVIEW_REQUIRED,
        IMPLEMENTING,
        FINAL_GATE,
    },
    AUDITING: {
        READY_FOR_GPT,
        IMPLEMENTING,
        BLOCKED_FOR_REVIEW,
        RECOVERY_REQUIRED,
        PAUSED,
        BLOCKED,
        RE_REVIEW_REQUIRED,
        AUDITING,
        FINAL_GATE,
    },
    READY_FOR_GPT: {
        GPT_REVIEW,
        PAUSED,
        BLOCKED,
        RE_REVIEW_REQUIRED,
        IMPLEMENTING,
        FINAL_GATE,
        READY_FOR_AUDIT,
        AUDITING,
    },
    GPT_REVIEW: {
        FINAL_GATE,
        IMPLEMENTING,
        BLOCKED,
        PAUSED,
        RE_REVIEW_REQUIRED,
        READY_FOR_GPT,
        READY_FOR_AUDIT,
    },
    FINAL_GATE: {
        MERGED,
        MERGE_PENDING,
        MERGE_RETRYABLE_FAILED,
        IMPLEMENTING,
        PAUSED,
        BLOCKED,
        GPT_REVIEW,
        READY_FOR_GPT,
    },
    MERGE_PENDING: {
        MERGED,
        MERGE_RETRYABLE_FAILED,
        FINAL_GATE,
        PAUSED,
        BLOCKED,
        RE_REVIEW_REQUIRED,
    },
    MERGE_RETRYABLE_FAILED: {
        MERGE_PENDING,
        MERGED,
        FINAL_GATE,
        PAUSED,
        BLOCKED,
        RE_REVIEW_REQUIRED,
    },
    MERGED: set(),
    BLOCKED: {
        WAITING_FOR_SPEC,
        MATERIALIZING,
        WORKTREE_READY,
        BOOTSTRAP_PR_READY,
        IMPLEMENTING,
        READY_FOR_AUDIT,
        AUDITING,
        READY_FOR_GPT,
        GPT_REVIEW,
        FINAL_GATE,
        MERGE_PENDING,
        MERGE_RETRYABLE_FAILED,
        PAUSED,
        RECOVERY_REQUIRED,
        RE_REVIEW_REQUIRED,
        BLOCKED_FOR_REVIEW,
    },
    PAUSED: {
        WAITING_FOR_SPEC,
        MATERIALIZING,
        WORKTREE_READY,
        BOOTSTRAP_PR_READY,
        IMPLEMENTING,
        VALIDATING,
        READY_FOR_AUDIT,
        AUDITING,
        READY_FOR_GPT,
        GPT_REVIEW,
        FINAL_GATE,
        MERGE_PENDING,
        MERGE_RETRYABLE_FAILED,
        BLOCKED,
        RECOVERY_REQUIRED,
        BLOCKED_FOR_REVIEW,
        RE_REVIEW_REQUIRED,
    },
    RECOVERY_REQUIRED: {
        WORKTREE_READY,
        IMPLEMENTING,
        AUDITING,
        READY_FOR_AUDIT,
        WAITING_FOR_SPEC,
        PAUSED,
        BLOCKED,
        VALIDATING,
        READY_FOR_GPT,
    },
    BLOCKED_FOR_REVIEW: {
        IMPLEMENTING,
        GPT_REVIEW,
        READY_FOR_GPT,
        PAUSED,
        BLOCKED,
        WAITING_FOR_SPEC,
    },
    RE_REVIEW_REQUIRED: {
        WAITING_FOR_SPEC,
        GPT_REVIEW,
        IMPLEMENTING,
        PAUSED,
        BLOCKED,
        READY_FOR_GPT,
        READY_FOR_AUDIT,
        AUDITING,
        VALIDATING,
    },
}


class TransitionError(ValueError):
    pass


def assert_phase(phase: str) -> str:
    if phase not in PHASES:
        raise TransitionError(f"unknown phase: {phase}")
    return phase


def can_transition(src: str, dest: str) -> bool:
    if src == dest:
        return True
    return dest in LEGAL_TRANSITIONS.get(src, set())


def transition(src: str, dest: str, *, reason: str = "") -> str:
    assert_phase(src)
    assert_phase(dest)
    if not can_transition(src, dest):
        suffix = f" ({reason})" if reason else ""
        raise TransitionError(f"illegal transition {src} -> {dest}{suffix}")
    return dest


def next_actor(phase: str, *, control: str = "running") -> str:
    if control == "paused":
        return "HUMAN"
    mapping = {
        WAITING_FOR_SPEC: "GPT",
        MATERIALIZING: "AGENTBUS",
        WORKTREE_READY: "AGENTBUS",
        BOOTSTRAP_PR_READY: "AGENTBUS",
        IMPLEMENTING: "IMPL",
        VALIDATING: "IMPL",
        READY_FOR_AUDIT: "AUDIT",
        AUDITING: "AUDIT",
        READY_FOR_GPT: "GPT",
        GPT_REVIEW: "GPT",
        FINAL_GATE: "HUMAN",
        MERGE_PENDING: "AGENTBUS",
        MERGE_RETRYABLE_FAILED: "HUMAN",
        MERGED: "-",
        BLOCKED: "HUMAN",
        PAUSED: "HUMAN",
        RECOVERY_REQUIRED: "HUMAN",
        BLOCKED_FOR_REVIEW: "GPT",
        RE_REVIEW_REQUIRED: "GPT",
    }
    return mapping.get(phase, "HUMAN")


def needs_human(phase: str, *, control: str = "running") -> bool:
    if control == "paused":
        return False
    return phase in HUMAN_GATES


def repair_limit_reached(repair_cycles: int, max_repair_cycles: int) -> bool:
    return repair_cycles >= max_repair_cycles


def display_state(phase: str, *, control: str = "running") -> str:
    if control == "paused" and phase != MERGED:
        return PAUSED
    return phase


def describe_next(phase: str, *, control: str = "running", blocker: str | None = None) -> str:
    if control == "paused":
        return "paused; resume to continue"
    if blocker:
        return blocker
    labels = {
        WAITING_FOR_SPEC: "Browser GPT: publish GPT_SPEC or a durable GPT_CONTINUATION",
        MATERIALIZING: "AgentBus: create successor worktree",
        WORKTREE_READY: "AgentBus: establish durable PR transport before IMPL",
        BOOTSTRAP_PR_READY: "AgentBus: durable PR ready; start IMPL",
        IMPLEMENTING: "IMPL: implement approved scope",
        VALIDATING: "IMPL: record validation and hand off",
        READY_FOR_AUDIT: "AUDIT: inspect implemented HEAD",
        AUDITING: "AUDIT: publish CODEX_AUDIT",
        READY_FOR_GPT: "Browser GPT: review PR and publish GPT_REVIEW (URL is not invokable)",
        GPT_REVIEW: "Browser GPT: accept or request changes",
        FINAL_GATE: "Human: 通过并合并 only after independent Merge GPT PASS; never auto-merged",
        MERGE_PENDING: "AgentBus: retry authorized merge of the exact reviewed HEAD",
        MERGE_RETRYABLE_FAILED: "Merge did not complete; retry the same authorized HEAD or inspect the error",
        MERGED: "work unit complete; campaign may continue",
        BLOCKED: "Human/GPT decision required",
        PAUSED: "paused",
        RECOVERY_REQUIRED: "Human: inspect crash/dirty state, then resume or step",
        BLOCKED_FOR_REVIEW: "Repair cycle limit reached; GPT/human must re-authorize",
        RE_REVIEW_REQUIRED: "Instruction SHA is stale; GPT/human must re-issue",
    }
    return labels.get(phase, phase)


def allowed_from(phase: str) -> Iterable[str]:
    return sorted(LEGAL_TRANSITIONS.get(phase, set()))
