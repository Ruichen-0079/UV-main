"""Final GPT compatibility views and the exact-once merge transaction.

Final GPT is independent authority, while the normal merge executor is
autonomous and still revalidates every deterministic fence.  The legacy human
entry points remain recovery controls only.
"""

from __future__ import annotations

import re
import secrets
from typing import Any

from agentbus.campaign import (
    DEFAULT_MERGE_REVIEW_MODE,
    MERGE_REVIEW_ALWAYS,
    MERGE_REVIEW_OFF,
    MERGE_REVIEW_RISK,
    WAIT_AUDITING,
    WAIT_IMPLEMENTING,
    WAIT_MERGE_PENDING,
    WAIT_WAITING_FOR_GPT,
    WAIT_WAITING_FOR_HUMAN_MERGE,
    WAIT_WAITING_FOR_MERGE_GPT,
    WAIT_WAITING_FOR_PLAN,
    apply_campaign_defaults,
    infer_campaign_id,
    load_campaign,
    save_campaign,
)
from agentbus.machine import (
    AUDITING,
    BLOCKED_FOR_REVIEW,
    FINAL_GATE,
    IMPLEMENTING,
    MERGE_PENDING,
    MERGE_RETRYABLE_FAILED,
    MERGED,
    READY_FOR_AUDIT,
    READY_FOR_GPT,
    VALIDATING,
)
from agentbus.paths import AgentbusError, RepoContext
from agentbus.protocol import Envelope, render_envelope
from agentbus.reviewpolicy import AUDIT_SUFFICIENT, DELEGATED_AUTHORITY, review_policy_of
from agentbus.store import StreamStore
from agentbus.util import utc_now


SUGGEST_HOLD = "暂缓合并"
SUGGEST_WAIT_PRODUCT = "等待产品 GPT 审阅"
SUGGEST_WAIT_MERGE = "等待合并 GPT"
SUGGEST_MERGE = "可以合并"
SUGGEST_HUMAN = "需要人工判断"
SUGGEST_GATE_PASSED = "最终审阅已通过，等待合并完成"
SUGGEST_MERGED = "已合并"

VALID_MERGE_STATUSES = {"PASS", "REPAIR", "WAIT", "HUMAN", "HOLD", "HUMAN_DECISION"}
MODE_HUMAN = "HUMAN"
MODE_AUTONOMOUS = "AUTONOMOUS"


def empty_merge_gpt() -> dict[str, Any]:
    return {"display_name": None, "url": None, "note": None, "bound_at": None}


def merge_review_mode(campaign: dict[str, Any] | None, state: dict[str, Any] | None = None) -> str:
    raw = None
    if state and state.get("merge_review_mode"):
        raw = state.get("merge_review_mode")
    elif campaign:
        raw = campaign.get("merge_review_mode")
    value = (raw or DEFAULT_MERGE_REVIEW_MODE).strip().lower()
    if value in {MERGE_REVIEW_ALWAYS, MERGE_REVIEW_RISK, MERGE_REVIEW_OFF}:
        return value
    return DEFAULT_MERGE_REVIEW_MODE


def merge_review_required(campaign: dict[str, Any] | None, state: dict[str, Any]) -> bool:
    mode = merge_review_mode(campaign, state)
    if mode == MERGE_REVIEW_OFF:
        return False
    if mode == MERGE_REVIEW_ALWAYS:
        return True
    if (state.get("status") or {}).get("audit") == "CHANGES_REQUIRED":
        return True
    if int(state.get("repair_cycles") or 0) > 0:
        return True
    findings = str((((state.get("envelopes") or {}).get("CODEX_AUDIT") or {}).get("fields") or {}).get("FINDINGS") or "")
    if re.search(r"\bHIGH\b", findings, re.IGNORECASE):
        return True
    return False


def unit_head(state: dict[str, Any]) -> str | None:
    from agentbus.decision import unit_head as canonical

    return canonical(state)


def sha_equal(left: str | None, right: str | None) -> bool:
    a = (left or "").strip()
    b = (right or "").strip()
    if not a or not b:
        return False
    return a == b


def sanitize_display_text(text: str | None) -> str:
    """Compatibility wrapper around the one shared display sanitizer."""
    from agentbus.display import sanitize_display_text as shared

    return shared(text)


def merge_gpt_binding(
    state: dict[str, Any],
    campaign: dict[str, Any] | None,
    ctx: RepoContext | None = None,
) -> dict[str, Any]:
    """Compatibility name for the normal stream override → global resolver."""
    del campaign
    from agentbus.settings import load_settings, resolve_final_gpt_binding

    settings = load_settings(ctx) if ctx is not None else None
    return resolve_final_gpt_binding(state, settings)


def product_review_authority(state: dict[str, Any]) -> dict[str, Any]:
    from agentbus.decision import product_review_authority as canonical

    result = canonical(state)
    result.setdefault(
        "detail",
        "product review authority is exact" if result.get("ok") else "product review not valid for current HEAD",
    )
    return result


def current_merge_review(state: dict[str, Any]) -> dict[str, Any] | None:
    rec = ((state.get("envelopes") or {}).get("GPT_MERGE_REVIEW") or {})
    if not isinstance(rec, dict) or not rec:
        return None
    return rec


def merge_review_is_durable(rec: dict[str, Any] | None) -> bool:
    """Merge authority exists only in a verified GitHub PR comment.

    A local inbox, prompt artifact, or a browser URL can be useful evidence,
    but none is an independent Merge GPT decision.
    """
    return bool(
        isinstance(rec, dict)
        and rec.get("source") == "github"
        and str(rec.get("source_id") or "").strip()
    )


def merge_review_for_head(state: dict[str, Any], head: str | None) -> dict[str, Any] | None:
    rec = current_merge_review(state)
    fields = (rec or {}).get("fields") or {}
    expected_pr = state.get("pr")
    reviewed_pr = str(fields.get("PR") or "").strip().lstrip("#")
    if (
        merge_review_is_durable(rec)
        and sha_equal(rec.get("head") or fields.get("REVIEWED_HEAD"), head)
        and expected_pr is not None
        and reviewed_pr == str(expected_pr)
    ):
        return rec
    return None


def merge_review_status(state: dict[str, Any]) -> str | None:
    rec = merge_review_for_head(state, unit_head(state))
    if not rec:
        return None
    return (rec.get("status") or "").upper() or None


def audit_pass_exact(state: dict[str, Any]) -> bool:
    from agentbus.decision import audit_pass_exact as canonical

    return canonical(state)


def report_valid_exact(state: dict[str, Any]) -> bool:
    from agentbus.decision import report_valid_exact as canonical

    return canonical(state)


def publication_pending(state: dict[str, Any]) -> bool:
    from agentbus.decision import publication_pending as canonical

    return canonical(state)


def ci_projection(view: dict[str, Any] | None) -> dict[str, Any]:
    from agentbus.decision import ci_snapshot

    result = ci_snapshot(view)
    return {**result, "summary": result["status"].lower().replace("_", " ")}


def wait_reason_for_state(state: dict[str, Any], campaign: dict[str, Any] | None = None) -> str:
    from agentbus.decision import AUDIT, FINAL_GPT, IMPL, NEXT, PRODUCT_GPT, derive_next_action

    live = (state.get("github") or {}).get("pr")
    decision = derive_next_action(state, campaign, live if isinstance(live, dict) else None)
    if decision.wait_reason:
        return decision.wait_reason
    return {
        IMPL: WAIT_IMPLEMENTING,
        AUDIT: WAIT_AUDITING,
        PRODUCT_GPT: WAIT_WAITING_FOR_GPT,
        FINAL_GPT: WAIT_WAITING_FOR_MERGE_GPT,
        NEXT: WAIT_WAITING_FOR_PLAN,
    }.get(decision.action, decision.action)


def gpt_suggestion(state: dict[str, Any], campaign: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compatibility projection of the canonical workflow decision."""
    from agentbus.decision import DONE, FINAL_GPT, HUMAN, IMPL, MERGE, PRODUCT_GPT, WAIT, active_blocker, derive_next_action

    product = product_review_authority(state)
    live = (state.get("github") or {}).get("pr")
    decision = derive_next_action(state, campaign, live if isinstance(live, dict) else None)
    text = {
        DONE: SUGGEST_MERGED,
        MERGE: SUGGEST_MERGE,
        HUMAN: SUGGEST_HUMAN,
        PRODUCT_GPT: SUGGEST_WAIT_PRODUCT,
        FINAL_GPT: SUGGEST_WAIT_MERGE,
        IMPL: SUGGEST_HOLD,
        WAIT: SUGGEST_HOLD,
    }.get(decision.action, SUGGEST_HOLD)
    predicate = decision.reason
    merge_status = merge_review_status(state)

    rec = merge_review_for_head(state, unit_head(state))
    return {
        "text": text,
        "predicate": predicate,
        "merge_review_status": merge_status,
        "product": product,
        "sources": {
            "product_review": product.get("label"),
            "product_detail": product.get("detail"),
            "audit": (((state.get("envelopes") or {}).get("CODEX_AUDIT") or {}).get("source_id")),
            "merge_gpt": (rec or {}).get("source_id"),
            "head": unit_head(state),
            "scope": "PASS" if not active_blocker(state) else "issue",
        },
    }


def merge_enablement(state: dict[str, Any], campaign: dict[str, Any] | None = None, *, live: dict[str, Any] | None = None) -> dict[str, Any]:
    from agentbus.decision import deterministic_merge_fences

    gate = deterministic_merge_fences(state, campaign, live)
    return {
        **gate,
        "enabled": gate["ok"],
        "merge_review": gate.get("final_review"),
        "suggestion": gpt_suggestion(state, campaign),
    }


def merge_prompt_text(state: dict[str, Any], campaign: dict[str, Any] | None = None) -> str:
    head = unit_head(state) or "(unknown)"
    pr = state.get("pr") or "-"
    stream = state.get("stream_id") or "-"
    product = product_review_authority(state)
    return (
        "继续作为 Yuvi FINAL_GPT（手动恢复提示）。\n\n"
        "不要重新实现。\n"
        "不要修代码。\n"
        "不要重复 Product GPT 的规划。\n\n"
        "检查当前：\n\n"
        f"STREAM: {stream}\n"
        f"PR: #{pr}\n"
        f"EXPECTED_HEAD: {head}\n\n"
        "从 GitHub durable authority 独立读取：\n"
        "- current PR/diff\n"
        "- CODEX_REPORT\n"
        "- CODEX_AUDIT\n"
        "- GPT_REVIEW / delegated authority\n"
        "- CI/checks\n"
        "- blockers\n"
        "- scope\n"
        "- base/main state\n\n"
        "只审查 exact current HEAD 是否适合 merge。\n"
        "可以把 Product GPT / delegated review 当作 evidence，不能把它当结论。\n"
        f"当前产品审阅投影：{product.get('label')} — {product.get('detail')}\n\n"
        "如果通过，在当前 PR 发布：\n\n"
        "[GPT_MERGE_REVIEW]\n"
        "STATUS: PASS\n"
        f"STREAM: {stream}\n"
        f"PR: {pr}\n"
        f"REVIEWED_HEAD: {head}\n"
        "REVIEWED_BASE: <exact baseRefOid from current PR>\n"
        "SUMMARY: independent merge-readiness conclusion\n"
        "FINDINGS:\n"
        "- none, or concrete merge blocker\n"
        "[/GPT_MERGE_REVIEW]\n\n"
        "STATUS 只能是 PASS / REPAIR / WAIT / HUMAN。\n"
        "REPAIR 是批准范围内可修复的具体问题；WAIT 是外部证据需要变化且不要改代码；HUMAN 只用于真实决策。\n\n"
        "不要 merge。\n"
        "不要发布 FINAL_GATE。\n"
        "不要修改代码。\n"
    )


def write_merge_prompt(store: StreamStore, state: dict[str, Any], campaign: dict[str, Any] | None = None) -> str:
    text = merge_prompt_text(state, campaign)
    path = store.write_artifact("merge-gpt-prompt.md", text)
    meta = state.setdefault("merge_prompt", {})
    head = unit_head(state)
    if meta.get("head") and not sha_equal(meta.get("head"), head):
        meta["stale_head"] = meta.get("head")
    meta["head"] = head
    meta["pr"] = state.get("pr")
    meta["updated_at"] = utc_now()
    meta["path"] = path
    meta["current"] = True
    return text


def merge_attention_generation(state: dict[str, Any]) -> str:
    return f"MERGE|{state.get('phase')}|{(unit_head(state) or '')[:40]}"


def maybe_merge_gpt_handoff(
    store: StreamStore,
    state: dict[str, Any],
    *,
    campaign: dict[str, Any] | None,
    env: dict[str, str] | None = None,
    surface: str = "cli",
) -> dict[str, Any] | None:
    """Legacy caller adapter to the one generic Browser GPT job interface."""
    del env, surface
    from agentbus.browser import job_for_state
    from agentbus.decision import FINAL_GPT

    job = job_for_state(store.ctx, state, campaign=campaign)
    if job is None or job.role != FINAL_GPT:
        return None
    generation = job.generation
    gate = state.setdefault("merge_gpt_gate", {})
    if gate.get("job_id") == job.job_id:
        return {
            "generation": generation,
            "job_id": job.job_id,
            "url": job.conversation_url,
            "open_once": False,
            "already": True,
            "role": FINAL_GPT,
        }
    gate["generation"] = generation
    gate["job_id"] = job.job_id
    gate["notified"] = True
    gate["notified_at"] = utc_now()
    gate["url"] = job.conversation_url
    store.append_event(
        "browser-job",
        {"generation": generation, "job_id": job.job_id, "role": FINAL_GPT, "task": job.task},
    )
    return {
        "generation": generation,
        "job_id": job.job_id,
        "url": job.conversation_url,
        "open_once": False,
        "already": False,
        "role": FINAL_GPT,
    }


def bind_merge_gpt(
    store: StreamStore,
    *,
    display_name: str | None,
    url: str | None,
    note: str | None,
    campaign_id: str | None = None,
    ctx: RepoContext | None = None,
    bind_campaign: bool = False,
) -> dict[str, Any]:
    from agentbus.actions import validate_browser_url

    with store.lock():
        state = store.load()
        binding = state.setdefault("merge_gpt", empty_merge_gpt())
        if display_name is not None:
            binding["display_name"] = display_name.strip() or None
        if url is not None:
            binding["url"] = validate_browser_url(url) if url.strip() else None
        if note is not None:
            binding["note"] = note.strip() or None
        binding["bound_at"] = utc_now()
        store.append_event("bind-merge-gpt", {"has_url": bool(binding.get("url"))})
        store.save(state)
    if bind_campaign and ctx is not None:
        cid = campaign_id or infer_campaign_id(state)
        campaign = load_campaign(ctx, cid) or apply_campaign_defaults({"campaign_id": cid})
        camp_bind = campaign.setdefault("merge_gpt", empty_merge_gpt())
        camp_bind.update({k: binding.get(k) for k in ("display_name", "url", "note", "bound_at")})
        save_campaign(ctx, campaign)
    return state


def apply_merge_review(state: dict[str, Any], envelope: Envelope) -> dict[str, Any]:
    from agentbus.apply import refresh_next, set_phase
    from agentbus.decision import normalize_final_status

    status = envelope.status
    reviewed = (envelope.fields.get("REVIEWED_HEAD") or "").strip()
    history = state.setdefault("merge_review_history", [])
    history.append(
        {
            "status": status,
            "head": reviewed,
            "source_id": envelope.source_id,
            "ts": utc_now(),
        }
    )
    if len(history) > 40:
        del history[:-40]
    if envelope.source != "github" or not str(envelope.source_id or "").strip():
        return refresh_next(state)
    if status not in VALID_MERGE_STATUSES:
        return refresh_next(state)
    head = unit_head(state)
    if reviewed and head and not sha_equal(reviewed, head):
        state.setdefault("stale_merge_reviews", []).append(
            {"head": reviewed, "status": status, "source_id": envelope.source_id, "ts": utc_now()}
        )
        return refresh_next(state)
    pr_field = (envelope.fields.get("PR") or "").strip()
    if pr_field and state.get("pr") and str(state.get("pr")) != pr_field.lstrip("#"):
        return refresh_next(state)
    normalized = normalize_final_status(envelope.as_record())
    if normalized == "REPAIR":
        token = envelope.source_id or envelope.digest
        repair = state.setdefault("final_repair", {})
        if repair.get("consumed_review") != token:
            cycles = int(state.get("repair_cycles") or 0)
            maximum = int(state.get("max_repair_cycles") or 2)
            if cycles >= maximum:
                if state.get("phase") != BLOCKED_FOR_REVIEW:
                    set_phase(state, BLOCKED_FOR_REVIEW, reason="Final GPT repair budget exhausted")
                state.setdefault("status", {})["impl"] = "PAUSED"
                repair["exhausted_review"] = token
                repair["exhausted_at"] = utc_now()
                return refresh_next(state)
            state["repair_cycles"] = cycles + 1
            repair["consumed_review"] = token
            repair["consumed_head"] = reviewed or head
            repair["job_id"] = envelope.fields.get("JOB_ID") or None
            repair["consumed_at"] = utc_now()
        state.setdefault("status", {})["gpt"] = "REPAIR"
        state["status"]["impl"] = "WAITING"
        if state.get("phase") != IMPLEMENTING:
            set_phase(state, IMPLEMENTING, reason="GPT_MERGE_REVIEW REPAIR")
    elif normalized == "WAIT":
        state.setdefault("status", {})["gpt"] = "WAIT"
    elif normalized == "HUMAN":
        state.setdefault("status", {})["gpt"] = "HUMAN"
    elif normalized == "PASS":
        state.setdefault("status", {})["gpt"] = "PASS"
    return refresh_next(state)


def _classify_merge_error(message: str) -> str:
    text = (message or "").lower()
    retryable = ("timeout", "temporarily", "rate limit", "502", "503", "504", "connection", "eof", "unavailable", "try again", "network")
    if any(item in text for item in retryable):
        return "RETRYABLE_AGENTBUS"
    if "not mergeable" in text or "conflict" in text:
        return "HUMAN_REQUIRED"
    return "HUMAN_REQUIRED"


def fetch_live_pr(ctx: RepoContext, state: dict[str, Any], env: dict[str, str] | None = None) -> dict[str, Any]:
    from agentbus.github import pr_view

    pr = state.get("pr")
    if not pr:
        raise AgentbusError("no PR", code="NO_PR")
    repo = state.get("impl_worktree") or ctx.repo_root
    return pr_view(repo, int(pr), env=env)


def revalidate_merge(
    ctx: RepoContext,
    state: dict[str, Any],
    campaign: dict[str, Any] | None,
    *,
    env: dict[str, str] | None = None,
    live: dict[str, Any] | None = None,
    authorization_mode: str = MODE_HUMAN,
) -> dict[str, Any]:
    try:
        live = live if live is not None else fetch_live_pr(ctx, state, env)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": "FINAL_GATE_STALE", "reason": f"could not fetch PR: {exc}", "retryable": True}
    from agentbus.decision import deterministic_merge_fences

    gate = deterministic_merge_fences(
        state,
        campaign,
        live,
        require_current_job=str(authorization_mode).upper() == MODE_AUTONOMOUS,
    )
    if (live.get("state") or "").upper() == "MERGED":
        return {"ok": True, "already_merged": True, "live": live, "gate": gate}
    if not gate["enabled"]:
        return {
            "ok": False,
            "code": "FINAL_GATE_STALE",
            "reason": "当前版本或审阅状态已变化，请重新审阅。 " + "; ".join(gate["reasons"]),
            "gate": gate,
            "live": live,
        }
    return {"ok": True, "live": live, "gate": gate}


def _final_gate_is_durable(state: dict[str, Any]) -> bool:
    rec = ((state.get("envelopes") or {}).get("FINAL_GATE") or {})
    if not isinstance(rec, dict):
        return False
    fields = rec.get("fields") or {}
    return bool(
        rec.get("source") == "github"
        and str(rec.get("source_id") or "").strip()
        and (rec.get("status") or "").upper() in {"PASS", "PASSED", "OK"}
        and sha_equal(rec.get("head") or fields.get("REVIEWED_HEAD") or fields.get("FINAL_HEAD"), unit_head(state))
    )


def _existing_final_gate(
    comments: list[dict[str, Any]],
    state: dict[str, Any],
    head: str,
    *,
    mode: str | None = None,
) -> tuple[dict[str, Any], Envelope] | None:
    from agentbus.protocol import parse_comment_envelope, validate_envelope

    stream = state.get("stream_id") or ""
    for comment in comments:
        body = comment.get("body") or ""
        envelope = parse_comment_envelope(body)
        if envelope is None or envelope.kind != "FINAL_GATE":
            continue
        if validate_envelope(envelope, expected_stream=stream, aliases=state.get("aliases") or []):
            continue
        fields = envelope.fields
        final = fields.get("FINAL_HEAD") or fields.get("REVIEWED_HEAD")
        if envelope.status not in {"PASS", "PASSED", "OK"} or not sha_equal(final, head):
            continue
        if fields.get("REVIEWED_HEAD") and not sha_equal(fields.get("REVIEWED_HEAD"), head):
            continue
        if mode == MODE_AUTONOMOUS:
            review = merge_review_for_head(state, head) or {}
            if (fields.get("AUTHORIZED_BY") or "").upper() != "GPT_MERGE_REVIEW":
                continue
            if (fields.get("MODE") or "").upper() != MODE_AUTONOMOUS:
                continue
            if str(fields.get("SOURCE_COMMENT_ID") or "") != str(review.get("source_id") or ""):
                continue
        return comment, envelope
    return None


def _final_review_is_still_remote(
    comments: list[dict[str, Any]],
    state: dict[str, Any],
    campaign: dict[str, Any] | None,
    live: dict[str, Any],
) -> bool:
    """Re-read the exact Final GPT source comment before autonomous merge."""
    from agentbus.decision import final_review_for_current
    from agentbus.protocol import parse_comment_envelope, validate_envelope

    review = final_review_for_current(state, campaign, live)
    if not review or review.get("normalized_status") != "PASS":
        return False
    source_id = str(review.get("source_id") or "")
    for comment in comments:
        if str(comment.get("id") or "") != source_id:
            continue
        envelope = parse_comment_envelope(str(comment.get("body") or ""))
        if envelope is None or envelope.kind != "GPT_MERGE_REVIEW":
            return False
        envelope.source = "github"
        envelope.source_id = source_id
        if validate_envelope(
            envelope,
            expected_stream=state.get("stream_id") or "",
            aliases=state.get("aliases") or [],
        ):
            return False
        fields = envelope.fields
        return bool(
            envelope.status == "PASS"
            and sha_equal(fields.get("REVIEWED_HEAD"), unit_head(state))
            and str(fields.get("PR") or "").lstrip("#") == str(state.get("pr") or "")
            and sha_equal(fields.get("REVIEWED_BASE"), live.get("baseRefOid"))
            and str(fields.get("JOB_ID") or "") == str(((review.get("fields") or {}).get("JOB_ID") or ""))
        )
    return False


def _final_gate_envelope(
    state: dict[str, Any],
    campaign: dict[str, Any] | None,
    head: str,
    *,
    mode: str,
) -> Envelope:
    merge_rec = merge_review_for_head(state, head) or {}
    audit = ((state.get("envelopes") or {}).get("CODEX_AUDIT") or {})
    product = product_review_authority(state)
    fields = {
        "STATUS": "PASS",
        "STREAM": state["stream_id"],
        "REVIEWED_HEAD": head,
        "FINAL_HEAD": head,
        "AUTHORIZED_BY": "GPT_MERGE_REVIEW" if mode == MODE_AUTONOMOUS else "HUMAN",
        "MODE": mode,
        "SOURCE_COMMENT_ID": str(merge_rec.get("source_id") or ""),
        "DECISION": "PASS",
        "NEXT_ACTION": "MERGE",
        "BASIS": (
            f"- PRODUCT_REVIEW: {product.get('label')}\n"
            f"- MERGE_GPT_REVIEW: {merge_rec.get('source_id') or 'n/a'}\n"
            f"- AUDIT: {audit.get('source_id') or 'n/a'}"
        ),
    }
    source = "agentbus-autonomous" if mode == MODE_AUTONOMOUS else "agentbus-human-merge"
    return Envelope(kind="FINAL_GATE", fields=fields, source=source)


def pass_and_merge(
    ctx: RepoContext,
    store: StreamStore,
    *,
    expected_stream: str,
    expected_head: str | None,
    expected_pr: int | None = None,
    env: dict[str, str] | None = None,
    retry_only: bool = False,
    authorization_mode: str = MODE_HUMAN,
) -> dict[str, Any]:
    """Run the existing exact-once merge transaction under truthful authority."""
    from agentbus.apply import apply_envelope, mark_pr_merged, set_phase
    from agentbus.github import list_issue_comments, merge_pr, post_pr_comment

    mode = str(authorization_mode or MODE_HUMAN).upper()
    if mode not in {MODE_HUMAN, MODE_AUTONOMOUS}:
        raise AgentbusError(f"unsupported merge authorization mode {authorization_mode}")
    authorization_key = "autonomous_authorized" if mode == MODE_AUTONOMOUS else "human_authorized"

    with store.lock():
        state = store.load()
        if state.get("stream_id") != expected_stream:
            return {"ok": False, "code": "STREAM_MISMATCH", "reason": "stream id does not match"}
        if expected_pr is not None and int(state.get("pr") or 0) != int(expected_pr):
            return {"ok": False, "code": "PR_MISMATCH", "reason": "PR number does not belong to this stream"}
        txn = state.setdefault("merge_txn", {})
        if txn.get("status") == "merged":
            return {"ok": True, "already": True, "merged": True, "merge_commit": txn.get("merge_commit")}
        if not retry_only and state.get("phase") != FINAL_GATE:
            return {
                "ok": False,
                "code": "FINAL_GATE_STALE",
                "reason": "通过并合并 is available only at FINAL_GATE",
            }
        if retry_only and state.get("phase") not in {MERGE_PENDING, MERGE_RETRYABLE_FAILED, FINAL_GATE}:
            return {
                "ok": False,
                "code": "FINAL_GATE_STALE",
                "reason": "authorized merge is no longer pending",
            }
        campaign = load_campaign(ctx, infer_campaign_id(state))
        head = expected_head or unit_head(state)
        if not sha_equal(head, unit_head(state)):
            return {"ok": False, "code": "FINAL_GATE_STALE", "reason": "当前版本或审阅状态已变化，请重新审阅。"}
        if txn.get("status") in {"revalidating", "merging", "final_gate_publishing"}:
            return {"ok": False, "code": "MERGE_IN_PROGRESS", "reason": "a merge transaction is already running"}
        if retry_only and not txn.get(authorization_key):
            return {"ok": False, "code": "NOT_AUTHORIZED", "reason": f"retry requires prior {mode} authorization"}
        operation_id = secrets.token_hex(8)
        txn["operation_id"] = operation_id
        txn["authorized_at"] = txn.get("authorized_at") or utc_now()
        txn["authorized_head"] = head
        txn["pr"] = state.get("pr")
        txn[authorization_key] = True
        txn["authorization_mode"] = mode
        if mode == MODE_AUTONOMOUS:
            txn["human_authorized"] = False
        txn["status"] = "revalidating"
        txn["updated_at"] = utc_now()
        store.save(state)

    def stale(result: dict[str, Any]) -> dict[str, Any]:
        with store.lock():
            current = store.load()
            txn = current.setdefault("merge_txn", {})
            if txn.get("operation_id") == operation_id:
                # The click did not authorize a changed PR/head.  Keep a
                # diagnostic trail but do not claim FINAL_GATE PASS.
                txn["status"] = "stale"
                txn[authorization_key] = False
                txn["stale_reason"] = result.get("reason")
                txn["updated_at"] = utc_now()
                store.save(current)
        return result

    check = revalidate_merge(ctx, store.load(), campaign, env=env, authorization_mode=mode)
    if check.get("already_merged"):
        return _reconcile_external_merge(ctx, store, check["live"])
    if not check.get("ok"):
        return stale(check)

    state = store.load()
    head = unit_head(state)
    repo = state.get("impl_worktree") or ctx.repo_root
    pr = int(state["pr"])
    try:
        comments = list_issue_comments(repo, ctx.origin, pr, env=env)
    except Exception as exc:  # noqa: BLE001
        return stale(
            {
                "ok": False,
                "code": "FINAL_GATE_STALE",
                "reason": f"could not read PR comments: {exc}",
                "retryable": True,
            }
        )
    if mode == MODE_AUTONOMOUS and not _final_review_is_still_remote(
        comments,
        state,
        campaign,
        check.get("live") or {},
    ):
        return stale(
            {
                "ok": False,
                "code": "FINAL_REVIEW_UNVERIFIED",
                "reason": "durable GPT_MERGE_REVIEW source comment is not present and exact on GitHub",
            }
        )
    existing = _existing_final_gate(comments, state, head or "", mode=mode)
    if existing:
        verified_comment, verified_envelope = existing
        comment_id = str(verified_comment.get("id") or "")
    elif retry_only:
        return stale(
            {
                "ok": False,
                "code": "FINAL_GATE_MISSING",
                "reason": "retry found no durable FINAL_GATE; refusing to post a duplicate",
            }
        )
    else:
        # Re-read every predicate immediately before the irreversible post.
        # Rendered UI state and the first validation are only a snapshot.
        campaign = load_campaign(ctx, infer_campaign_id(store.load()))
        check = revalidate_merge(ctx, store.load(), campaign, env=env, authorization_mode=mode)
        if check.get("already_merged"):
            return _reconcile_external_merge(ctx, store, check["live"])
        if not check.get("ok"):
            return stale(check)
        with store.lock():
            state = store.load()
            txn = state.setdefault("merge_txn", {})
            if txn.get("operation_id") != operation_id or not sha_equal(unit_head(state), head):
                return {
                    "ok": False,
                    "code": "FINAL_GATE_STALE",
                    "reason": "当前版本或审阅状态已变化，请重新审阅。",
                }
            txn["status"] = "final_gate_publishing"
            txn["final_gate_post_started_at"] = utc_now()
            txn["updated_at"] = utc_now()
            env_obj = _final_gate_envelope(state, campaign, head or "", mode=mode)
            body = render_envelope(env_obj)
            store.save(state)
        try:
            post_pr_comment(repo, pr, body, env=env)
        except Exception as exc:  # noqa: BLE001
            with store.lock():
                state = store.load()
                txn = state.setdefault("merge_txn", {})
                # A failed/lost response is ambiguous.  Do not manufacture a
                # second FINAL_GATE; recovery must first find GitHub truth.
                txn["status"] = "final_gate_publish_unknown"
                txn["error"] = str(exc)[:300]
                txn["updated_at"] = utc_now()
                store.save(state)
            return {
                "ok": False,
                "code": "FINAL_GATE_PUBLISH_UNKNOWN",
                "reason": str(exc)[:300],
                "retryable": False,
            }
        try:
            comments = list_issue_comments(repo, ctx.origin, pr, env=env)
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "code": "FINAL_GATE_UNVERIFIED",
                "reason": f"could not verify FINAL_GATE: {exc}",
                "retryable": False,
            }
        existing = _existing_final_gate(comments, store.load(), head or "", mode=mode)
        if not existing:
            return {
                "ok": False,
                "code": "FINAL_GATE_UNVERIFIED",
                "reason": "FINAL_GATE PASS not visible on GitHub",
                "retryable": False,
            }
        verified_comment, verified_envelope = existing
        comment_id = str(verified_comment.get("id") or "")

    with store.lock():
        state = store.load()
        txn = state.setdefault("merge_txn", {})
        if txn.get("operation_id") != operation_id:
            return {"ok": False, "code": "MERGE_IN_PROGRESS", "reason": "merge transaction ownership changed"}
        verified_envelope.source = "github"
        verified_envelope.source_id = comment_id
        apply_envelope(store, state, verified_envelope, repo=repo, current_head=head)
        txn["final_gate_comment_id"] = comment_id
        txn["status"] = "final_gate_published"
        txn["updated_at"] = utc_now()
        if state.get("phase") == FINAL_GATE:
            set_phase(state, MERGE_PENDING, reason=f"{mode.lower()} authorized merge")
        store.save(state)

    try:
        with store.lock():
            state = store.load()
            txn = state.setdefault("merge_txn", {})
            if txn.get("operation_id") != operation_id or not _final_gate_is_durable(state):
                return {"ok": False, "code": "FINAL_GATE_STALE", "reason": "durable FINAL_GATE changed"}
            txn["status"] = "merging"
            txn["merge_requested_at"] = utc_now()
            txn["updated_at"] = utc_now()
            store.save(state)
        merged = merge_pr(repo, pr, head_sha=head, env=env)
    except Exception as exc:  # noqa: BLE001
        klass = _classify_merge_error(str(exc))
        live = None
        try:
            live = fetch_live_pr(ctx, store.load(), env)
        except Exception:  # noqa: BLE001
            live = None
        if live and (live.get("state") or "").upper() == "MERGED":
            return _reconcile_external_merge(ctx, store, live)
        with store.lock():
            state = store.load()
            txn = state.setdefault("merge_txn", {})
            txn["error"] = str(exc)[:300]
            txn["error_class"] = klass
            dest = MERGE_PENDING if klass == "RETRYABLE_AGENTBUS" else MERGE_RETRYABLE_FAILED
            txn["status"] = "pending" if dest == MERGE_PENDING else "retryable_failed"
            if state.get("phase") in {FINAL_GATE, MERGE_PENDING, MERGE_RETRYABLE_FAILED}:
                set_phase(state, dest, reason="merge request failed after FINAL_GATE")
            store.save(state)
        return {
            "ok": False,
            "code": "MERGE_PENDING" if klass == "RETRYABLE_AGENTBUS" else "MERGE_RETRYABLE_FAILED",
            "reason": str(exc)[:300],
            "retryable": klass == "RETRYABLE_AGENTBUS",
            "final_gate_comment_id": comment_id,
        }

    try:
        live = fetch_live_pr(ctx, store.load(), env)
    except Exception as exc:  # noqa: BLE001
        with store.lock():
            state = store.load()
            txn = state.setdefault("merge_txn", {})
            txn["status"] = "pending"
            txn["error"] = f"post-merge verification unavailable: {exc}"[:300]
            txn["updated_at"] = utc_now()
            if state.get("phase") != MERGED:
                set_phase(state, MERGE_PENDING, reason="merge result needs GitHub verification")
            store.save(state)
        return {"ok": False, "code": "MERGE_PENDING", "reason": "merge requested; GitHub verification unavailable", "retryable": True}
    if (live.get("state") or "").upper() != "MERGED":
        with store.lock():
            state = store.load()
            state.setdefault("merge_txn", {})["status"] = "pending"
            set_phase(state, MERGE_PENDING, reason="merge requested but PR not MERGED yet")
            store.save(state)
        return {"ok": False, "code": "MERGE_PENDING", "reason": "merge requested; PR not yet MERGED", "retryable": True}

    return _reconcile_external_merge(ctx, store, live, final_gate_comment_id=comment_id, extra=merged)


def retry_merge(
    ctx: RepoContext,
    store: StreamStore,
    *,
    expected_stream: str,
    expected_head: str | None,
    expected_pr: int | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    state = store.load()
    txn = state.get("merge_txn") or {}
    if not txn.get("human_authorized"):
        return {"ok": False, "code": "NOT_AUTHORIZED", "reason": "retry requires a prior human 通过并合并"}
    if expected_head and not sha_equal(expected_head, txn.get("authorized_head")):
        return {"ok": False, "code": "FINAL_GATE_STALE", "reason": "authorized HEAD no longer matches"}
    recovered = recover_authorized_merge(ctx, store, env=env)
    if recovered and recovered.get("merged"):
        return recovered
    if recovered and not recovered.get("ok"):
        return recovered
    state = store.load()
    txn = state.get("merge_txn") or {}
    return pass_and_merge(
        ctx,
        store,
        expected_stream=expected_stream,
        expected_head=txn.get("authorized_head") or expected_head,
        expected_pr=expected_pr,
        env=env,
        retry_only=True,
        authorization_mode=MODE_HUMAN,
    )


def autonomous_merge(
    ctx: RepoContext,
    store: StreamStore,
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Merge an exact Final GPT PASS through the existing transaction path."""
    from agentbus.settings import autonomous_merge_ready

    if not autonomous_merge_ready(ctx, env):
        return {
            "ok": False,
            "code": "AUTONOMY_NOT_ACTIVE",
            "reason": "global Final GPT / Browser Bridge activation is not ready",
            "retryable": True,
        }
    state = store.load()
    txn = state.get("merge_txn") or {}
    retry_only = bool(
        txn.get("autonomous_authorized")
        and sha_equal(txn.get("authorized_head"), unit_head(state))
        and state.get("phase") in {FINAL_GATE, MERGE_PENDING, MERGE_RETRYABLE_FAILED}
    )
    if retry_only:
        # A previous process may have died after sending the merge request.
        # Always fetch GitHub truth before issuing any retry.
        recovered = recover_authorized_merge(ctx, store, env=env)
        if recovered and (recovered.get("merged") or not recovered.get("ok")):
            return recovered
        state = store.load()
        txn = state.get("merge_txn") or {}
    return pass_and_merge(
        ctx,
        store,
        expected_stream=state.get("stream_id") or store.stream_id,
        expected_head=txn.get("authorized_head") if retry_only else unit_head(state),
        expected_pr=state.get("pr"),
        env=env,
        retry_only=retry_only,
        authorization_mode=MODE_AUTONOMOUS,
    )


def recover_authorized_merge(
    ctx: RepoContext,
    store: StreamStore,
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Recover an interrupted authorized transaction from GitHub truth.

    This routine never requests a merge.  It only adopts an existing merge or
    a verified FINAL_GATE comment, and leaves an ambiguous post as a stop.
    """
    from agentbus.github import list_issue_comments

    state = store.load()
    txn = state.get("merge_txn") or {}
    mode = str(txn.get("authorization_mode") or (MODE_AUTONOMOUS if txn.get("autonomous_authorized") else MODE_HUMAN)).upper()
    authorization_key = "autonomous_authorized" if mode == MODE_AUTONOMOUS else "human_authorized"
    if not txn.get(authorization_key):
        return None
    authorized_head = txn.get("authorized_head")
    if not sha_equal(authorized_head, unit_head(state)):
        return {
            "ok": False,
            "code": "FINAL_GATE_STALE",
            "reason": "authorized HEAD no longer matches current implementation",
        }
    try:
        live = fetch_live_pr(ctx, state, env)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": "MERGE_PENDING", "reason": f"could not fetch PR: {exc}", "retryable": True}
    if (live.get("state") or "").upper() == "MERGED":
        return _reconcile_external_merge(ctx, store, live)
    if (live.get("state") or "").upper() != "OPEN" or not sha_equal(live.get("headRefOid"), authorized_head):
        return {
            "ok": False,
            "code": "FINAL_GATE_STALE",
            "reason": "PR state or HEAD changed after merge authorization",
        }
    repo = state.get("impl_worktree") or ctx.repo_root
    try:
        comments = list_issue_comments(repo, ctx.origin, int(state["pr"]), env=env)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": "MERGE_PENDING", "reason": f"could not read PR comments: {exc}", "retryable": True}
    existing = _existing_final_gate(comments, state, authorized_head, mode=mode)
    if not existing:
        return {
            "ok": False,
            "code": "FINAL_GATE_UNVERIFIED",
            "reason": "no verified FINAL_GATE found; refusing a duplicate post",
        }
    comment, envelope = existing
    comment_id = str(comment.get("id") or "")
    from agentbus.apply import apply_envelope, set_phase

    with store.lock():
        current = store.load()
        current_txn = current.setdefault("merge_txn", {})
        if not sha_equal(current_txn.get("authorized_head"), authorized_head):
            return {"ok": False, "code": "FINAL_GATE_STALE", "reason": "authorization changed during recovery"}
        envelope.source = "github"
        envelope.source_id = comment_id
        apply_envelope(store, current, envelope, repo=repo, current_head=authorized_head)
        current_txn["final_gate_comment_id"] = comment_id
        current_txn["status"] = "pending"
        current_txn["updated_at"] = utc_now()
        if current.get("phase") == FINAL_GATE:
            set_phase(current, MERGE_PENDING, reason="recovered durable FINAL_GATE")
        store.save(current)
    return {"ok": True, "recovered": True, "pending": True, "final_gate_comment_id": comment_id}


def maybe_retry_authorized_merge(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    txn = state.get("merge_txn") or {}
    if not (txn.get("human_authorized") or txn.get("autonomous_authorized")):
        return None
    if (state.get("phase") or "") not in {MERGE_PENDING}:
        return None
    if txn.get("status") not in {"pending", "retryable_failed", "merging", "final_gate_published"}:
        return None
    if not sha_equal(txn.get("authorized_head"), unit_head(state)):
        return None
    if txn.get("autonomous_authorized"):
        return autonomous_merge(ctx, store, env=env)
    return retry_merge(
        ctx,
        store,
        expected_stream=state["stream_id"],
        expected_head=txn.get("authorized_head"),
        expected_pr=state.get("pr"),
        env=env,
    )


def _reconcile_external_merge(
    ctx: RepoContext,
    store: StreamStore,
    live: dict[str, Any],
    *,
    final_gate_comment_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from agentbus.apply import mark_pr_merged

    merge_commit = None
    raw = live.get("mergeCommit")
    if isinstance(raw, dict):
        merge_commit = raw.get("oid")
    elif isinstance(raw, str):
        merge_commit = raw
    if extra and extra.get("merge_commit"):
        merge_commit = extra.get("merge_commit")
    with store.lock():
        state = store.load()
        mark_pr_merged(state, store, merge_sha=merge_commit)
        txn = state.setdefault("merge_txn", {})
        txn["status"] = "merged"
        txn["merge_commit"] = merge_commit
        txn["merged_at"] = utc_now()
        if final_gate_comment_id:
            txn["final_gate_comment_id"] = final_gate_comment_id
        store.save(state)
    return {
        "ok": True,
        "merged": True,
        "already": bool(extra is None),
        "merge_commit": merge_commit,
        "final_gate_comment_id": (store.load().get("merge_txn") or {}).get("final_gate_comment_id"),
        "phase": MERGED,
    }


def merge_review_card(
    state: dict[str, Any],
    campaign: dict[str, Any] | None = None,
    *,
    live: dict[str, Any] | None = None,
    ctx: RepoContext | None = None,
) -> dict[str, Any]:
    product = product_review_authority(state)
    from agentbus.decision import active_blocker

    suggestion = gpt_suggestion(state, campaign)
    gate = merge_enablement(state, campaign, live=live)
    rec = merge_review_for_head(state, unit_head(state))
    findings = ""
    if rec:
        findings = sanitize_display_text(((rec.get("fields") or {}).get("FINDINGS") or rec.get("raw") or ""))
    txn = state.get("merge_txn") or {}
    retry_enabled = bool(
        (state.get("phase") or "") in {MERGE_PENDING, MERGE_RETRYABLE_FAILED}
        and txn.get("human_authorized")
        and sha_equal(txn.get("authorized_head"), unit_head(state))
        and _final_gate_is_durable(state)
    )
    # A rendered button must not stand in for the required live PR check.
    # Click-time revalidation repeats this immediately before FINAL_GATE post.
    requires_live = (state.get("phase") or "") in {FINAL_GATE, MERGE_PENDING, MERGE_RETRYABLE_FAILED}
    live_verified = not requires_live or live is not None
    disabled_reasons = list(gate["reasons"])
    if not live_verified:
        disabled_reasons.append("live PR snapshot unavailable")
    return {
        "product_label": product.get("label"),
        "product_detail": product.get("detail"),
        "merge_status": merge_review_status(state) or "pending",
        "suggestion": suggestion["text"],
        "predicate": suggestion["predicate"],
        "enabled": gate["enabled"] and live_verified,
        "retry_enabled": retry_enabled and live_verified,
        "disabled_reasons": disabled_reasons,
        "findings": findings,
        "expected_head": unit_head(state),
        "pr": state.get("pr"),
        "checks": [
            {"ok": bool(live) and sha_equal(unit_head(state), (live or {}).get("headRefOid")), "label": "HEAD exact (live)"},
            {"ok": audit_pass_exact(state), "label": "CODEX_AUDIT PASS"},
            {"ok": bool(product.get("ok")), "label": "Product review authority valid"},
            {"ok": not active_blocker(state), "label": "No blocker"},
            {"ok": bool(live) and "PR is not mergeable" not in gate["reasons"], "label": "PR mergeable (live)"},
        ],
        "sources": suggestion["sources"],
        "prompt": (state.get("merge_prompt") or {}),
        "binding": merge_gpt_binding(state, campaign, ctx),
        "wait_reason": wait_reason_for_state(state, campaign),
    }
