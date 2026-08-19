"""Generic Product/Final GPT browser jobs.

The browser is transport only.  A job remains actionable until its exact
GitHub envelope is ingested; neither this module nor the extension records a
workflow acknowledgement.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from agentbus.campaign import infer_campaign_id, load_campaign, project_campaign
from agentbus.decision import (
    FINAL_GPT,
    FINAL_REVIEW,
    PLAN_CONTINUATION,
    PLAN_SPEC,
    PRODUCT_GPT,
    PRODUCT_REVIEW,
    browser_job_id,
    current_base_ci_evidence,
    derive_next_action,
    review_generation,
    unit_head,
)
from agentbus.paths import RepoContext
from agentbus.settings import (
    is_chatgpt_conversation_url,
    load_settings,
    resolve_final_gpt_binding,
    resolve_product_gpt_binding,
)
from agentbus.store import iter_stores


@dataclass(frozen=True)
class BrowserGPTJob:
    job_id: str
    role: str
    task: str
    conversation_url: str
    campaign: str
    stream: str
    pr: int | None
    expected_head: str
    expected_base: str
    generation: str
    prompt: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "role": self.role,
            "task": self.task,
            "conversation_url": self.conversation_url,
            "campaign": self.campaign,
            "stream": self.stream,
            "pr": self.pr,
            "expected_head": self.expected_head,
            "expected_base": self.expected_base,
            "generation": self.generation,
            "prompt": self.prompt,
        }


def _live(state: dict[str, Any]) -> dict[str, Any]:
    raw = (state.get("github") or {}).get("pr")
    return raw if isinstance(raw, dict) else {}


def _common(job: dict[str, Any]) -> str:
    return (
        f"ROLE: {job['role']}\n"
        f"JOB_ID: {job['job_id']}\n"
        f"TASK: {job['task']}\n"
        f"CAMPAIGN: {job['campaign']}\n"
        f"STREAM: {job['stream']}\n"
        f"PR: {job['pr'] if job['pr'] is not None else '(none)'}\n"
        f"EXPECTED_HEAD: {job['expected_head']}\n"
        f"EXPECTED_BASE: {job['expected_base']}\n\n"
        "GitHub PR comments and PR state are the durable cross-agent authority.\n"
        "Re-read the current GitHub PR, diff, comments, checks, HEAD, and base now.\n"
        "Old conversation context is non-authoritative and may be stale.\n"
        "Before publishing, check whether an exact-current valid envelope for this JOB_ID already exists; if it does, do not duplicate it.\n"
        "Publish the required envelope as a GitHub PR comment. A chat reply alone does not complete this job.\n"
        "Do not modify code. Do not merge from ChatGPT.\n"
    )


def _product_prompt(job: dict[str, Any], state: dict[str, Any]) -> str:
    task = job["task"]
    if task == PLAN_SPEC:
        replan = bool(job.get("replan_scope") or job.get("replan_reason"))
        replan_protocol = ""
        if replan:
            replan_protocol = [
                "This is a revision of the current blocked GPT_SPEC for the same stream and PR, not a new campaign, unit, stream, or PR.",
                "Re-read the exact current HEAD/base, current GPT_SPEC, GPT_REVIEW, CODEX_REPORT, CODEX_AUDIT, current GitHub comments, and all durable product constraints.",
                "Issue the smallest bounded replacement GPT_SPEC for the existing HEAD lineage.",
                "Do not silently combine independent Final GPT findings merely because they appeared in one review. Select one focused repair order and preserve every remaining mandatory finding as pending authority before FINAL_GATE.",
            ]
            if job.get("replan_reason") == "REPAIR_EPOCH_EXHAUSTED_REPLAN":
                final = (state.get("envelopes") or {}).get("GPT_MERGE_REVIEW") or {}
                spec = (state.get("envelopes") or {}).get("GPT_SPEC") or {}
                final_fields = final.get("fields") if isinstance(final.get("fields"), dict) else {}
                remaining_findings = final_fields.get("FINDINGS") or final.get("raw") or "(none recorded)"
                replan_protocol.extend(
                    [
                        "The current repair epoch is exhausted. This Product GPT job is the bounded replan authority; it does not reset the budget merely because Codex committed or reported.",
                        "Final GPT REPAIR authority (exact current):\n" + str(final.get("raw") or final),
                        "Remaining mandatory Final GPT findings (preserve any not selected for this focused repair):\n"
                        + str(remaining_findings),
                        "Current GPT_SPEC:\n" + str(spec.get("raw") or spec),
                        "Repair history and completed epoch diagnostics:\n"
                        + json.dumps(
                            {
                                "repair_epoch": state.get("repair_epoch") or {},
                                "repair_epochs": state.get("repair_epochs") or [],
                                "repair_history": state.get("repair_history") or [],
                                "repair_cycles": state.get("repair_cycles") or 0,
                                "max_repair_cycles": state.get("max_repair_cycles") or 2,
                            },
                            sort_keys=True,
                            indent=2,
                        ),
                        "The new spec must keep the Final GPT findings concrete, bounded, and separately traceable; do not turn an ambiguity into autonomous implementation authority.",
                    ]
                )
            replan_protocol = "\n".join(replan_protocol) + "\n\n"
        protocol = (
            replan_protocol +
            "Produce the smallest actionable product specification using the existing durable protocol:\n"
            "[GPT_SPEC]\n"
            "STATUS: ACTIONABLE\n"
            f"STREAM: {job['stream']}\n"
            f"JOB_ID: {job['job_id']}\n"
            "GOAL: <goal>\n"
            "TARGET: <target>\n"
            f"BASE_HEAD: {job['expected_head']}\n"
            "SCOPE: <bounded scope>\n"
            "OUT_OF_SCOPE: <explicit exclusions>\n"
            "ACCEPTANCE_CRITERIA: <testable criteria>\n"
            "PENDING_FINDINGS: <remaining mandatory Final GPT findings, or none>\n"
            "ARCHITECTURAL_CONSTRAINTS: <constraints>\n"
            "REQUIRED_VALIDATION: <commands/evidence>\n"
            "REVIEW_POLICY: GPT_REQUIRED | AUDIT_SUFFICIENT\n"
            "PATH_SCOPE: <bounded paths/globs>\n"
            "NEXT_ACTION: IMPL\n"
            "[/GPT_SPEC]\n"
        )
    elif task == PRODUCT_REVIEW:
        protocol = (
            "Review the exact implementation against the approved product intent and current GitHub evidence.\n"
            "Publish exactly one preferred durable envelope:\n"
            "[GPT_REVIEW]\n"
            "STATUS: ACCEPT | CHANGES_REQUIRED\n"
            f"STREAM: {job['stream']}\n"
            f"JOB_ID: {job['job_id']}\n"
            f"REVIEWED_HEAD: {job['expected_head']}\n"
            "FINDINGS:\n- <none or concrete in-scope findings>\n"
            "ACCEPTANCE: <short conclusion>\n"
            "NEXT_ACTION: FINAL_GPT | IMPL\n"
            "[/GPT_REVIEW]\n"
        )
    elif task == PLAN_CONTINUATION:
        campaign = job["campaign"]
        protocol = (
            "Re-read the existing campaign goal, durable unit history, and current GitHub PR authority.\n"
            "The predecessor is durably MERGED. Decide whether meaningful approved campaign work remains.\n"
            "Continue only when a bounded successor is justified; do not invent filler units merely to avoid COMPLETE.\n"
            "Publish exactly one preferred durable envelope on the current PR, choosing ACTIONABLE or COMPLETE:\n"
            "[GPT_CONTINUATION]\n"
            "STATUS: ACTIONABLE | COMPLETE\n"
            f"CAMPAIGN: {campaign}\n"
            f"JOB_ID: {job['job_id']}\n"
            f"AFTER_STREAM: {job['stream']}\n"
            "TRIGGER: MERGED\n"
            "For ACTIONABLE: NEXT_STREAM: <new unique stream id>\n"
            "TARGET: <target>\n"
            "BASE_ANCHOR: PREVIOUS_MERGE\n"
            "SCOPE: <bounded scope>\n"
            "OUT_OF_SCOPE: <explicit exclusions>\n"
            "ACCEPTANCE_CRITERIA: <testable criteria>\n"
            "REVIEW_POLICY: GPT_REQUIRED | AUDIT_SUFFICIENT\n"
            "PATH_SCOPE: <bounded paths/globs>\n"
            "NEXT_ACTION: CREATE_AND_IMPLEMENT\n"
            "For COMPLETE: SUMMARY: <why the campaign objective is complete>\n"
            "NEXT_ACTION: DONE\n"
            "[/GPT_CONTINUATION]\n"
        )
    else:  # pragma: no cover - callers only build canonical tasks
        raise ValueError(f"unsupported Product GPT task {task}")
    goal = str(state.get("goal") or "").strip()
    return _common(job) + (f"\nCURRENT_GOAL: {goal}\n" if goal else "") + "\n" + protocol


def _final_prompt(job: dict[str, Any], state: dict[str, Any]) -> str:
    current_ci = current_base_ci_evidence(state, _live(state))
    ci_context = (
        "\nCURRENT_BASE_CI (operational evidence; not Final GPT authority):\n"
        + json.dumps(current_ci, sort_keys=True, indent=2)
        + "\n"
        if current_ci
        else "\nCURRENT_BASE_CI: no exact current-base synthetic CI PASS/FAIL evidence is available.\n"
    )
    return _common(job) + (
        "\nAct as FINAL_GPT: independently decide merge readiness for the exact current revision.\n"
        "Inspect the PR/diff, durable GPT_SPEC and product authority, CODEX_REPORT, CODEX_AUDIT, CI/check logs, scope, blockers, and current base.\n"
        "The CURRENT_BASE_CI section below is only an exact operational validation fingerprint. Do not treat it as a Final GPT decision; verify the run identity and required checks independently.\n"
        + ci_context
        + "Use only PASS, REPAIR, WAIT, or HUMAN. REPAIR requires a concrete issue fixable inside approved scope. WAIT means external evidence must change and code must not change. HUMAN is only for a real nondeterministic decision.\n"
        "Publish exactly this durable GitHub envelope shape:\n"
        "[GPT_MERGE_REVIEW]\n"
        "STATUS: PASS | REPAIR | WAIT | HUMAN\n"
        f"STREAM: {job['stream']}\n"
        f"PR: {job['pr']}\n"
        f"JOB_ID: {job['job_id']}\n"
        f"REVIEWED_HEAD: {job['expected_head']}\n"
        f"REVIEWED_BASE: {job['expected_base']}\n"
        "SUMMARY: <short conclusion>\n"
        "FINDINGS:\n- <none or concrete findings>\n"
        "[/GPT_MERGE_REVIEW]\n"
    )


def job_for_state(
    ctx: RepoContext,
    state: dict[str, Any],
    *,
    campaign: dict[str, Any] | None = None,
) -> BrowserGPTJob | None:
    campaign = campaign if campaign is not None else load_campaign(ctx, infer_campaign_id(state))
    if state.get("phase") == "MERGED" and campaign:
        projected = project_campaign(ctx, campaign)
        active = projected.get("active_stream")
        if active and active != state.get("stream_id"):
            return None
        if projected.get("status") in {"COMPLETE", "HUMAN_REQUIRED"}:
            return None
    live = _live(state)
    decision = derive_next_action(state, campaign, live)
    if decision.action not in {PRODUCT_GPT, FINAL_GPT} or not decision.task:
        return None
    settings = load_settings(ctx)
    if decision.action == PRODUCT_GPT:
        binding = resolve_product_gpt_binding(state, campaign, settings)
    else:
        binding = resolve_final_gpt_binding(state, settings)
    url = str(binding.get("url") or "").strip()
    if not url or not is_chatgpt_conversation_url(url):
        return None
    generation = review_generation(
        state,
        campaign,
        live,
        role=decision.action,
        task=decision.task,
    )
    job_id = browser_job_id(
        state,
        campaign,
        live,
        role=decision.action,
        task=decision.task,
    )
    values: dict[str, Any] = {
        "job_id": job_id,
        "role": decision.action,
        "task": decision.task,
        "campaign": (campaign or {}).get("campaign_id") or infer_campaign_id(state),
        "stream": state.get("stream_id") or "",
        "pr": state.get("pr"),
        "expected_head": unit_head(state) or (state.get("heads") or {}).get("current") or "UNKNOWN",
        "expected_base": live.get("baseRefOid") or "UNKNOWN",
        "replan_scope": bool(decision.evidence.get("scope_blocked")),
        "replan_reason": decision.reason if decision.action == PRODUCT_GPT else "",
    }
    prompt = _product_prompt(values, state) if decision.action == PRODUCT_GPT else _final_prompt(values, state)
    return BrowserGPTJob(
        job_id=job_id,
        role=decision.action,
        task=decision.task,
        conversation_url=url,
        campaign=str(values["campaign"]),
        stream=str(values["stream"]),
        pr=state.get("pr"),
        expected_head=str(values["expected_head"]),
        expected_base=str(values["expected_base"]),
        generation=generation,
        prompt=prompt,
    )


def list_browser_jobs(ctx: RepoContext) -> list[dict[str, Any]]:
    jobs: list[BrowserGPTJob] = []
    for store in iter_stores(ctx):
        try:
            state = store.load()
            job = job_for_state(ctx, state)
            if job is not None:
                jobs.append(job)
        except Exception:  # noqa: BLE001 - one legacy stream cannot hide other jobs
            continue
    jobs.sort(key=lambda item: (item.role != PRODUCT_GPT, item.campaign, item.stream, item.job_id))
    return [item.as_dict() for item in jobs]
