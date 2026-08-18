"""Who must act next. Human attention is reserved for real human decisions."""

from __future__ import annotations

from typing import Any

from agentbus import machine
from agentbus.reviewpolicy import AUDIT_SUFFICIENT, review_policy_of


OWNER_NONE = "NONE"
OWNER_AGENTBUS = "AGENTBUS"
OWNER_IMPL = "IMPL"
OWNER_AUDIT = "AUDIT"
OWNER_BROWSER_GPT = "BROWSER_GPT"
OWNER_HUMAN = "HUMAN"

KIND_RUNNING = "running"
KIND_WAITING = "waiting"
KIND_NEEDS_GPT = "needs_gpt"
KIND_NEEDS_YOU = "needs_you"
KIND_BLOCKED = "blocked"
KIND_PAUSED = "paused"
KIND_COMPLETE = "complete"


def _pub_retryable(state: dict[str, Any]) -> bool:
    pub = state.get("publication") or {}
    if pub.get("status") != "failed":
        return False
    failures = int(state.get("infra_publication_failures") or 0)
    return failures < 3


def _role_running(runtime: dict[str, Any] | None, role: str) -> bool:
    if not runtime:
        return False
    from agentbus.recover import role_process_healthy

    return role_process_healthy(runtime.get(role) or {})


def _continuation_supplies_spec(state: dict[str, Any]) -> bool:
    rec = (state.get("envelopes") or {}).get("GPT_CONTINUATION") or {}
    if not isinstance(rec, dict):
        return False
    fields = rec.get("fields") if isinstance(rec.get("fields"), dict) else {}
    if (fields.get("STATUS") or rec.get("status") or "").upper() != "ACTIONABLE":
        return False
    next_stream = (fields.get("NEXT_STREAM") or "").strip().lower()
    return bool(next_stream) and next_stream == (state.get("stream_id") or "").lower()


def classify_attention(
    state: dict[str, Any],
    runtime: dict[str, Any] | None = None,
    campaign: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return attention_owner / human_required / kind for one work unit."""
    control = state.get("control") or "running"
    phase = state.get("phase") or ""
    campaign = campaign or state.get("campaign") or {}

    def result(owner: str, human: bool, kind: str, *, gpt: bool = False, reason: str = "") -> dict[str, Any]:
        return {
            "attention_owner": owner,
            "human_required": human,
            "browser_gpt_required": gpt,
            "kind": kind,
            "reason": reason,
        }

    if state.get("archived") or state.get("hidden_from_attention"):
        return result(OWNER_NONE, False, KIND_COMPLETE, reason="archived")

    if phase == machine.MERGED:
        return result(OWNER_NONE, False, KIND_COMPLETE, reason="work unit complete")

    if control == "paused":
        return result(OWNER_NONE, False, KIND_PAUSED, reason="paused")

    if phase == machine.RECOVERY_REQUIRED:
        return result(OWNER_HUMAN, True, KIND_NEEDS_YOU, reason="recovery cannot be assumed")
    if phase == machine.BLOCKED:
        return result(OWNER_HUMAN, True, KIND_BLOCKED, reason="blocked")
    if phase == machine.BLOCKED_FOR_REVIEW:
        return result(OWNER_HUMAN, True, KIND_NEEDS_YOU, reason="repair budget exhausted")
    if phase == machine.RE_REVIEW_REQUIRED:
        return result(OWNER_HUMAN, True, KIND_NEEDS_YOU, reason="external HEAD or SHA fence needs a decision")
    if phase == machine.MERGE_PENDING:
        return result(OWNER_AGENTBUS, False, KIND_WAITING, reason="authorized merge pending")
    if phase == machine.MERGE_RETRYABLE_FAILED:
        return result(OWNER_HUMAN, True, KIND_NEEDS_YOU, reason="merge failed; retry or inspect")
    if phase == machine.FINAL_GATE:
        from agentbus.campaign import load_campaign, infer_campaign_id
        from agentbus.mergegate import merge_review_required, merge_review_status, merge_gpt_binding

        campaign = campaign if isinstance(campaign, dict) and campaign.get("campaign_id") else None
        if campaign is None and state.get("campaign_id"):
            campaign = state.get("campaign") if isinstance(state.get("campaign"), dict) else None
        if merge_review_required(campaign, state) and merge_review_status(state) != "PASS":
            binding = merge_gpt_binding(state, campaign)
            return result(
                OWNER_BROWSER_GPT,
                False,
                KIND_NEEDS_GPT,
                gpt=True,
                reason="WAITING_FOR_MERGE_GPT",
            )
        return result(OWNER_HUMAN, True, KIND_NEEDS_YOU, reason="WAITING_FOR_HUMAN_MERGE")

    if _pub_retryable(state):
        return result(OWNER_AGENTBUS, False, KIND_WAITING, reason="publication retry")

    if phase in {machine.MATERIALIZING, machine.WORKTREE_READY, machine.BOOTSTRAP_PR_READY}:
        return result(OWNER_AGENTBUS, False, KIND_WAITING, reason="establishing durable PR transport")

    if phase in {machine.IMPLEMENTING, machine.VALIDATING}:
        kind = KIND_RUNNING if _role_running(runtime, "impl") else KIND_WAITING
        return result(OWNER_IMPL, False, kind, reason="implementation in progress")

    if phase in {machine.READY_FOR_AUDIT, machine.AUDITING}:
        from agentbus.publish import report_is_durable

        rec = ((state.get("envelopes") or {}).get("CODEX_REPORT") or {})
        if state.get("pr") and rec and not report_is_durable(state):
            return result(OWNER_AGENTBUS, False, KIND_WAITING, reason="CODEX_REPORT publication pending")
        kind = KIND_RUNNING if _role_running(runtime, "audit") else KIND_WAITING
        return result(OWNER_AUDIT, False, kind, reason="independent audit")

    if phase == machine.READY_FOR_GPT:
        if review_policy_of(state) == AUDIT_SUFFICIENT:
            return result(OWNER_AGENTBUS, False, KIND_WAITING, reason="delegated review should auto-advance")
        return result(OWNER_BROWSER_GPT, False, KIND_NEEDS_GPT, gpt=True, reason="GPT_REQUIRED review")

    if phase == machine.GPT_REVIEW:
        return result(OWNER_BROWSER_GPT, False, KIND_NEEDS_GPT, gpt=True, reason="Browser GPT review in progress")

    if phase == machine.WAITING_FOR_SPEC:
        if _continuation_supplies_spec(state):
            return result(OWNER_AGENTBUS, False, KIND_WAITING, reason="continuation already supplies the next unit")
        return result(OWNER_BROWSER_GPT, False, KIND_NEEDS_GPT, gpt=True, reason="waiting for GPT_SPEC")

    if _role_running(runtime, "impl") or _role_running(runtime, "audit"):
        return result(OWNER_AGENTBUS, False, KIND_RUNNING, reason="agent running")
    return result(OWNER_AGENTBUS, False, KIND_WAITING, reason="waiting for an agent")


def human_required(state: dict[str, Any], runtime: dict[str, Any] | None = None) -> bool:
    return bool(classify_attention(state, runtime)["human_required"])


def campaign_attention(campaign: dict[str, Any] | None) -> dict[str, Any]:
    if not campaign:
        return {
            "attention_owner": OWNER_NONE,
            "human_required": False,
            "browser_gpt_required": False,
            "kind": KIND_COMPLETE,
            "reason": "no campaign",
        }
    status = (campaign.get("status") or "").upper()
    if status == "HUMAN_REQUIRED":
        return {
            "attention_owner": OWNER_HUMAN,
            "human_required": True,
            "browser_gpt_required": False,
            "kind": KIND_NEEDS_YOU,
            "reason": campaign.get("reason") or "campaign needs a human decision",
        }
    if status == "WAITING_FOR_PLAN":
        return {
            "attention_owner": OWNER_BROWSER_GPT,
            "human_required": False,
            "browser_gpt_required": True,
            "kind": KIND_NEEDS_GPT,
            "reason": "campaign queue exhausted; Browser GPT must publish the next plan",
        }
    if status in {"CONTINUING", "ACTIVE"}:
        return {
            "attention_owner": OWNER_AGENTBUS,
            "human_required": False,
            "browser_gpt_required": False,
            "kind": KIND_RUNNING,
            "reason": campaign.get("reason") or "campaign continuing",
        }
    if status == "COMPLETE":
        return {
            "attention_owner": OWNER_NONE,
            "human_required": False,
            "browser_gpt_required": False,
            "kind": KIND_COMPLETE,
            "reason": "campaign complete",
        }
    return {
        "attention_owner": OWNER_AGENTBUS,
        "human_required": False,
        "browser_gpt_required": False,
        "kind": KIND_WAITING,
        "reason": status or "campaign idle",
    }
