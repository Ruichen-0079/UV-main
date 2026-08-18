"""Who must act next. Human attention is reserved for real human decisions."""

from __future__ import annotations

from typing import Any

from agentbus import machine


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

CATEGORY_RUNNING = "RUNNING"
CATEGORY_AUTO_WAIT = "AUTO_WAIT"
CATEGORY_NEEDS_YOU = "NEEDS_YOU"
CATEGORY_COMPLETE = "COMPLETE"


def _role_running(runtime: dict[str, Any] | None, role: str) -> bool:
    if not runtime:
        return False
    from agentbus.recover import role_process_healthy

    return role_process_healthy(runtime.get(role) or {})


def classify_attention(
    state: dict[str, Any],
    runtime: dict[str, Any] | None = None,
    campaign: dict[str, Any] | None = None,
    decision: Any | None = None,
) -> dict[str, Any]:
    """Project user attention from the canonical workflow decision."""
    from agentbus.decision import (
        AUDIT,
        DONE,
        FINAL_GPT,
        HUMAN,
        IMPL,
        MERGE,
        NEXT,
        PRODUCT_GPT,
        WAIT,
        derive_next_action,
    )

    campaign = campaign or state.get("campaign") or {}

    def result(
        owner: str,
        human: bool,
        kind: str,
        *,
        category: str,
        gpt: bool = False,
        reason: str = "",
        action: str | None = None,
    ) -> dict[str, Any]:
        return {
            "attention_owner": owner,
            "human_required": human,
            "browser_gpt_required": gpt,
            "kind": kind,
            "category": category,
            "reason": reason,
            "next_action": action,
        }

    if state.get("archived") or state.get("hidden_from_attention"):
        return result(OWNER_NONE, False, KIND_COMPLETE, category=CATEGORY_COMPLETE, reason="archived", action=DONE)

    live = (state.get("github") or {}).get("pr")
    decision = decision or derive_next_action(
        state,
        campaign if isinstance(campaign, dict) else None,
        live if isinstance(live, dict) else None,
        runtime,
    )
    action = decision.action
    if state.get("phase") == machine.MERGED and action in {PRODUCT_GPT, NEXT}:
        # The work unit is complete; continuation/planning attention belongs
        # to its campaign and Browser job, not to the archived PR unit card.
        return result(
            OWNER_NONE,
            False,
            KIND_COMPLETE,
            category=CATEGORY_COMPLETE,
            gpt=action == PRODUCT_GPT,
            reason=decision.reason,
            action=action,
        )
    if action == HUMAN:
        return result(
            OWNER_HUMAN,
            True,
            KIND_NEEDS_YOU,
            category=CATEGORY_NEEDS_YOU,
            reason=decision.reason,
            action=action,
        )
    if action == DONE:
        return result(
            OWNER_NONE,
            False,
            KIND_COMPLETE,
            category=CATEGORY_COMPLETE,
            reason=decision.reason,
            action=action,
        )
    if action in {PRODUCT_GPT, FINAL_GPT}:
        return result(
            OWNER_BROWSER_GPT,
            False,
            KIND_NEEDS_GPT,
            category=CATEGORY_AUTO_WAIT,
            gpt=True,
            reason=decision.reason,
            action=action,
        )
    if action == WAIT:
        return result(
            OWNER_AGENTBUS,
            False,
            KIND_WAITING,
            category=CATEGORY_AUTO_WAIT,
            reason=decision.reason,
            action=action,
        )
    if action == IMPL:
        kind = KIND_RUNNING if _role_running(runtime, "impl") else KIND_WAITING
        return result(
            OWNER_IMPL,
            False,
            kind,
            category=CATEGORY_RUNNING if kind == KIND_RUNNING else CATEGORY_AUTO_WAIT,
            reason=decision.reason,
            action=action,
        )
    if action == AUDIT:
        kind = KIND_RUNNING if _role_running(runtime, "audit") else KIND_WAITING
        return result(
            OWNER_AUDIT,
            False,
            kind,
            category=CATEGORY_RUNNING if kind == KIND_RUNNING else CATEGORY_AUTO_WAIT,
            reason=decision.reason,
            action=action,
        )
    if action == NEXT:
        return result(
            OWNER_NONE,
            False,
            KIND_COMPLETE,
            category=CATEGORY_COMPLETE,
            reason=decision.reason,
            action=action,
        )
    if action == MERGE:
        return result(
            OWNER_AGENTBUS,
            False,
            KIND_RUNNING,
            category=CATEGORY_RUNNING,
            reason=decision.reason,
            action=action,
        )
    return result(
        OWNER_AGENTBUS,
        False,
        KIND_WAITING,
        category=CATEGORY_AUTO_WAIT,
        reason=decision.reason,
        action=action,
    )


def human_required(state: dict[str, Any], runtime: dict[str, Any] | None = None) -> bool:
    return bool(classify_attention(state, runtime)["human_required"])


def campaign_attention(campaign: dict[str, Any] | None) -> dict[str, Any]:
    if not campaign:
        return {
            "attention_owner": OWNER_NONE,
            "human_required": False,
            "browser_gpt_required": False,
            "kind": KIND_COMPLETE,
            "category": CATEGORY_COMPLETE,
            "reason": "no campaign",
        }
    status = (campaign.get("status") or "").upper()
    if status == "HUMAN_REQUIRED":
        return {
            "attention_owner": OWNER_HUMAN,
            "human_required": True,
            "browser_gpt_required": False,
            "kind": KIND_NEEDS_YOU,
            "category": CATEGORY_NEEDS_YOU,
            "reason": campaign.get("reason") or "campaign needs a human decision",
        }
    if status == "WAITING_FOR_PLAN":
        return {
            "attention_owner": OWNER_BROWSER_GPT,
            "human_required": False,
            "browser_gpt_required": True,
            "kind": KIND_NEEDS_GPT,
            "category": CATEGORY_AUTO_WAIT,
            "reason": "campaign queue exhausted; Browser GPT must publish the next plan",
        }
    if status in {"CONTINUING", "ACTIVE"}:
        return {
            "attention_owner": OWNER_AGENTBUS,
            "human_required": False,
            "browser_gpt_required": False,
            "kind": KIND_RUNNING,
            "category": CATEGORY_RUNNING,
            "reason": campaign.get("reason") or "campaign continuing",
        }
    if status == "COMPLETE":
        return {
            "attention_owner": OWNER_NONE,
            "human_required": False,
            "browser_gpt_required": False,
            "kind": KIND_COMPLETE,
            "category": CATEGORY_COMPLETE,
            "reason": "campaign complete",
        }
    return {
        "attention_owner": OWNER_AGENTBUS,
        "human_required": False,
        "browser_gpt_required": False,
        "kind": KIND_WAITING,
        "category": CATEGORY_AUTO_WAIT,
        "reason": status or "campaign idle",
    }
