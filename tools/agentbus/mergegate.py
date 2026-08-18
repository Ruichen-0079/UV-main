"""Independent Merge GPT gate and explicit human pass-and-merge transaction.

Product GPT review and Merge GPT review are separate authorities.
Opening a browser URL never completes a review.
No merge mutation without an explicit human authorization for the exact HEAD.
"""

from __future__ import annotations

import os
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
    unit_completed,
)
from agentbus.machine import (
    AUDITING,
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

VALID_MERGE_STATUSES = {"PASS", "HOLD", "HUMAN_DECISION"}

AUDIT_WORKTREE_PATH = re.compile(
    r"(?:[A-Za-z]:)?(?:/[^ \n\]|]+)+/audit-worktree/((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+)"
)
HOME_STATE_PATH = re.compile(
    r"(?:/home/[^ \n\]|]+/\.local/state/yuvi-agent-bus/|/tmp/[^ \n\]|]+/)[^\s\]|]+"
)


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
    heads = state.get("heads") or {}
    pub = state.get("publication") or {}
    return heads.get("implemented") or pub.get("commit") or heads.get("current")


def sha_equal(left: str | None, right: str | None) -> bool:
    a = (left or "").strip()
    b = (right or "").strip()
    if not a or not b:
        return False
    return a == b


def sanitize_display_text(text: str | None) -> str:
    """Display-only: hide AgentBus audit-worktree absolute prefixes."""
    if not text:
        return ""
    value = AUDIT_WORKTREE_PATH.sub(r"\1", str(text))
    return value


def merge_gpt_binding(state: dict[str, Any], campaign: dict[str, Any] | None) -> dict[str, Any]:
    stream = state.get("merge_gpt") if isinstance(state.get("merge_gpt"), dict) else {}
    if stream.get("url") or stream.get("display_name"):
        return stream
    camp = (campaign or {}).get("merge_gpt") if isinstance((campaign or {}).get("merge_gpt"), dict) else {}
    return camp or empty_merge_gpt()


def product_review_authority(state: dict[str, Any]) -> dict[str, Any]:
    policy = review_policy_of(state)
    review = ((state.get("envelopes") or {}).get("GPT_REVIEW") or {})
    head = unit_head(state)
    if policy == AUDIT_SUFFICIENT and state.get("review_authority") == DELEGATED_AUTHORITY:
        return {
            "ok": True,
            "kind": "DELEGATED",
            "label": "AUDIT_SUFFICIENT / delegated_by_gpt_spec",
            "detail": "GPT pre-authorized independent audit as review authority",
            "head": ((state.get("heads") or {}).get("audited") or head),
            "source_id": None,
        }
    status = (review.get("status") or "").upper()
    rec_head = review.get("head")
    if status in {"ACCEPT", "ACCEPTED", "APPROVE", "APPROVED"} and sha_equal(rec_head, head):
        return {
            "ok": True,
            "kind": "GPT_REVIEW",
            "label": f"GPT_REVIEW {status}",
            "detail": "Product GPT exact-head ACCEPT",
            "head": rec_head,
            "source_id": review.get("source_id"),
        }
    return {
        "ok": False,
        "kind": review.get("kind") or "GPT_REVIEW",
        "label": f"GPT_REVIEW {status or 'missing'}",
        "detail": "product review not valid for current HEAD",
        "head": rec_head,
        "source_id": review.get("source_id"),
        "status": status or None,
    }


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
    rec = ((state.get("envelopes") or {}).get("CODEX_AUDIT") or {})
    if (rec.get("status") or "").upper() not in {"PASS", "PASSED", "OK"}:
        return False
    return sha_equal(rec.get("head") or (rec.get("fields") or {}).get("AUDITED_HEAD"), unit_head(state))


def report_valid_exact(state: dict[str, Any]) -> bool:
    rec = ((state.get("envelopes") or {}).get("CODEX_REPORT") or {})
    if not isinstance(rec, dict) or not rec:
        return False
    status = (rec.get("status") or "").upper()
    if status not in {"READY_FOR_AUDIT", "PASS", "PASSED", "OK"}:
        return False
    fields = rec.get("fields") or {}
    return sha_equal(rec.get("head") or fields.get("IMPLEMENTED_HEAD"), unit_head(state))


def publication_pending(state: dict[str, Any]) -> bool:
    from agentbus.publish import report_is_durable

    if not state.get("pr"):
        return False
    rec = ((state.get("envelopes") or {}).get("CODEX_REPORT") or {})
    if not rec:
        return False
    return not report_is_durable(state)


def ci_projection(view: dict[str, Any] | None) -> dict[str, Any]:
    if not view:
        return {"status": "NOT_AVAILABLE", "summary": "PR view unavailable"}
    checks = view.get("statusCheckRollup")
    if not checks:
        return {"status": "NOT_AVAILABLE", "summary": "no GitHub checks"}
    states = []
    for item in checks:
        if isinstance(item, dict):
            states.append((item.get("state") or item.get("conclusion") or "").upper())
    if any(item in {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "FAIL"} for item in states):
        return {"status": "FAIL", "summary": "one or more checks failed"}
    if any(item in {"PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"} for item in states):
        return {"status": "PENDING", "summary": "checks still running"}
    if any(item in {"SUCCESS", "PASS", "NEUTRAL", "SKIPPED"} for item in states):
        return {"status": "PASS", "summary": "reported checks succeeded"}
    return {"status": "NOT_RUN", "summary": "checks present but inconclusive"}


def wait_reason_for_state(state: dict[str, Any], campaign: dict[str, Any] | None = None) -> str:
    phase = state.get("phase") or ""
    if unit_completed(phase):
        return WAIT_WAITING_FOR_PLAN
    if phase in {MERGE_PENDING, MERGE_RETRYABLE_FAILED}:
        return WAIT_MERGE_PENDING
    if phase in {IMPLEMENTING, VALIDATING}:
        return WAIT_IMPLEMENTING
    if phase in {READY_FOR_AUDIT, AUDITING}:
        return WAIT_AUDITING
    if phase == READY_FOR_GPT:
        return WAIT_WAITING_FOR_GPT
    if phase == FINAL_GATE:
        txn = state.get("merge_txn") or {}
        if _final_gate_is_durable(state) and (txn.get("status") or "") in {
            "final_gate_published",
            "merging",
            "pending",
            "retryable_failed",
        }:
            return WAIT_MERGE_PENDING
        if merge_review_required(campaign, state) and merge_review_status(state) != "PASS":
            return WAIT_WAITING_FOR_MERGE_GPT
        return WAIT_WAITING_FOR_HUMAN_MERGE
    if phase == "GPT_REVIEW":
        return WAIT_WAITING_FOR_GPT
    return phase or WAIT_IMPLEMENTING


def gpt_suggestion(state: dict[str, Any], campaign: dict[str, Any] | None = None) -> dict[str, Any]:
    """Deterministic projection. AgentBus does not invent advice."""
    phase = state.get("phase") or ""
    product = product_review_authority(state)
    merge_status = merge_review_status(state)
    audit_status = (((state.get("envelopes") or {}).get("CODEX_AUDIT") or {}).get("status") or "").upper()
    gpt_status = (((state.get("envelopes") or {}).get("GPT_REVIEW") or {}).get("status") or "").upper()

    if unit_completed(phase) or (state.get("heads") or {}).get("merged"):
        text = SUGGEST_MERGED
        predicate = "PR/unit MERGED"
    elif audit_status == "CHANGES_REQUIRED" or gpt_status == "CHANGES_REQUIRED":
        text = SUGGEST_HOLD
        predicate = "current CHANGES_REQUIRED"
    elif phase == READY_FOR_GPT and not product["ok"]:
        text = SUGGEST_WAIT_PRODUCT
        predicate = "product review missing for current HEAD"
    elif phase in {IMPLEMENTING, VALIDATING, READY_FOR_AUDIT, AUDITING} and not product["ok"]:
        text = SUGGEST_HOLD
        predicate = f"unit is {phase}; not merge-ready"
    elif phase in {FINAL_GATE, MERGE_PENDING, MERGE_RETRYABLE_FAILED} and not product["ok"]:
        text = SUGGEST_WAIT_PRODUCT
        predicate = "product review missing for current HEAD"
    elif phase in {FINAL_GATE, MERGE_PENDING, MERGE_RETRYABLE_FAILED}:
        txn = state.get("merge_txn") or {}
        if (_final_gate_is_durable(state) and
                txn.get("status") in {"final_gate_published", "pending", "retryable_failed", "merging"} and
                sha_equal(txn.get("authorized_head"), unit_head(state))):
            text = SUGGEST_GATE_PASSED
            predicate = "exact-head FINAL_GATE PASS exists; merge not complete"
        elif merge_review_required(campaign, state) and merge_status is None:
            text = SUGGEST_WAIT_MERGE
            predicate = "product authority valid; Merge GPT missing for current HEAD"
        elif merge_status == "HOLD":
            text = SUGGEST_HOLD
            predicate = "GPT_MERGE_REVIEW HOLD"
        elif merge_status == "HUMAN_DECISION":
            text = SUGGEST_HUMAN
            predicate = "GPT_MERGE_REVIEW HUMAN_DECISION"
        elif merge_status == "PASS" or not merge_review_required(campaign, state):
            text = SUGGEST_MERGE
            predicate = "exact-head GPT_MERGE_REVIEW PASS" if merge_status == "PASS" else "merge_review_mode=off"
        else:
            text = SUGGEST_WAIT_MERGE
            predicate = f"Merge GPT {merge_status}"
    else:
        text = SUGGEST_WAIT_PRODUCT
        predicate = "product review not complete"

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
            "scope": "PASS" if not (state.get("status") or {}).get("blocker") else "issue",
        },
    }


def merge_enablement(state: dict[str, Any], campaign: dict[str, Any] | None = None, *, live: dict[str, Any] | None = None) -> dict[str, Any]:
    reasons: list[str] = []
    phase = state.get("phase") or ""
    head = unit_head(state)
    if phase not in {FINAL_GATE, MERGE_PENDING, MERGE_RETRYABLE_FAILED}:
        reasons.append(f"unit is {phase or 'unknown'}, not FINAL_GATE")
    if not state.get("pr"):
        reasons.append("no PR")
    current = (state.get("heads") or {}).get("current")
    if current and head and not sha_equal(current, head):
        reasons.append("unexplained external drift from IMPLEMENTED_HEAD")
    if (state.get("status") or {}).get("blocker"):
        reasons.append("blocker present")
    if publication_pending(state):
        reasons.append("PUBLICATION_PENDING")
    if not report_valid_exact(state):
        reasons.append("CODEX_REPORT is not valid for exact HEAD")
    if not audit_pass_exact(state):
        reasons.append("CODEX_AUDIT is not PASS on exact HEAD")
    product = product_review_authority(state)
    if not product["ok"]:
        reasons.append("product review authority not valid")
    if merge_review_required(campaign, state):
        status = merge_review_status(state)
        if status != "PASS":
            reasons.append(f"Merge GPT is {status or 'pending'}, not PASS")
    if not head:
        reasons.append("IMPLEMENTED_HEAD missing")
    if live:
        if (live.get("state") or "").upper() == "MERGED":
            reasons.append("PR already MERGED")
        elif (live.get("state") or "").upper() not in {"OPEN", ""}:
            reasons.append(f"PR state is {live.get('state')}")
        live_head = live.get("headRefOid")
        if live_head and head and not sha_equal(live_head, head):
            reasons.append("PR HEAD != expected implemented HEAD")
        rec = merge_review_for_head(state, head)
        reviewed_base = ((rec or {}).get("fields") or {}).get("REVIEWED_BASE")
        live_base = live.get("baseRefOid")
        if reviewed_base and live_base and not sha_equal(reviewed_base, live_base):
            reasons.append("Merge GPT REVIEWED_BASE is stale")
        mergeable = (live.get("mergeable") or "").upper()
        merge_state = (live.get("mergeStateStatus") or "").upper()
        if mergeable and mergeable != "MERGEABLE":
            reasons.append("PR is not mergeable")
        if merge_state and merge_state != "CLEAN":
            reasons.append("PR is not mergeable")
        ci = ci_projection(live)
        if ci["status"] in {"FAIL", "PENDING"}:
            reasons.append(f"CI is {ci['status'].lower()}")
    return {
        "enabled": not reasons,
        "reasons": reasons,
        "expected_head": head,
        "pr": state.get("pr"),
        "product": product,
        "merge_review": merge_review_status(state),
        "suggestion": gpt_suggestion(state, campaign),
    }


def merge_prompt_text(state: dict[str, Any], campaign: dict[str, Any] | None = None) -> str:
    head = unit_head(state) or "(unknown)"
    pr = state.get("pr") or "-"
    stream = state.get("stream_id") or "-"
    product = product_review_authority(state)
    return (
        "继续作为 Yuvi 独立 Merge Gate GPT。\n\n"
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
        "EVIDENCE:\n"
        "- PR/diff, CODEX_REPORT, CODEX_AUDIT, product authority, CI, scope, and base checked\n"
        "FINDINGS:\n"
        "- none, or concrete merge blocker\n"
        "RECOMMENDATION: MERGE\n"
        "NEXT_ACTION: HUMAN_MERGE\n"
        "[/GPT_MERGE_REVIEW]\n\n"
        "如果存在 blocker：STATUS: HOLD\n"
        "如果是风险取舍而非明确 blocker：STATUS: HUMAN_DECISION\n\n"
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
    if (state.get("phase") or "") != FINAL_GATE:
        return None
    if not merge_review_required(campaign, state):
        return None
    if merge_review_status(state) == "PASS":
        return None
    binding = merge_gpt_binding(state, campaign)
    url = (binding.get("url") or "").strip()
    generation = merge_attention_generation(state)
    gate = state.setdefault("merge_gpt_gate", {})
    write_merge_prompt(store, state, campaign)
    if gate.get("generation") == generation and gate.get("notified"):
        return {"generation": generation, "url": url or None, "open_once": False, "already": True, "role": "MERGE_GPT"}
    gate["generation"] = generation
    gate["notified"] = True
    gate["notified_at"] = utc_now()
    gate["url"] = url or None
    from agentbus.notify import notify_custom

    notify_custom(state.get("stream_id") or store.stream_id, "needs Merge GPT", "Independent merge-readiness review is required.")
    opened = False
    if url and surface != "webui" and (env or os.environ).get("YUVI_AGENTBUS_OPEN_URL") != "0":
        from agentbus.autopilot import _open_url

        opened = _open_url(url, env)
        if opened:
            gate["opened_at"] = utc_now()
    store.append_event("merge-gpt-gate", {"generation": generation, "url": bool(url), "opened": opened, "surface": surface})
    return {"generation": generation, "url": url or None, "open_once": bool(url) and not gate.get("opened_at"), "already": False, "role": "MERGE_GPT"}


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
    from agentbus.apply import refresh_next

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
) -> dict[str, Any]:
    try:
        live = live if live is not None else fetch_live_pr(ctx, state, env)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": "FINAL_GATE_STALE", "reason": f"could not fetch PR: {exc}", "retryable": True}
    gate = merge_enablement(state, campaign, live=live)
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
    comments: list[dict[str, Any]], state: dict[str, Any], head: str
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
        return comment, envelope
    return None


def _final_gate_envelope(state: dict[str, Any], campaign: dict[str, Any] | None, head: str) -> Envelope:
    merge_rec = merge_review_for_head(state, head) or {}
    audit = ((state.get("envelopes") or {}).get("CODEX_AUDIT") or {})
    product = product_review_authority(state)
    fields = {
        "STATUS": "PASS",
        "STREAM": state["stream_id"],
        "REVIEWED_HEAD": head,
        "FINAL_HEAD": head,
        "DECISION": "PASS",
        "NEXT_ACTION": "MERGE",
        "BASIS": (
            f"- PRODUCT_REVIEW: {product.get('label')}\n"
            f"- MERGE_GPT_REVIEW: {merge_rec.get('source_id') or 'n/a'}\n"
            f"- AUDIT: {audit.get('source_id') or 'n/a'}"
        ),
    }
    return Envelope(kind="FINAL_GATE", fields=fields, source="agentbus-human-merge")


def pass_and_merge(
    ctx: RepoContext,
    store: StreamStore,
    *,
    expected_stream: str,
    expected_head: str | None,
    expected_pr: int | None = None,
    env: dict[str, str] | None = None,
    retry_only: bool = False,
) -> dict[str, Any]:
    """Explicit human merge authorization. Never auto-called from Merge GPT ingest."""
    from agentbus.apply import apply_envelope, mark_pr_merged, set_phase
    from agentbus.github import list_issue_comments, merge_pr, post_pr_comment

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
        if retry_only and not txn.get("human_authorized"):
            return {"ok": False, "code": "NOT_AUTHORIZED", "reason": "retry requires a prior human 通过并合并"}
        operation_id = secrets.token_hex(8)
        txn["operation_id"] = operation_id
        txn["authorized_at"] = txn.get("authorized_at") or utc_now()
        txn["authorized_head"] = head
        txn["pr"] = state.get("pr")
        txn["human_authorized"] = True
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
                txn["human_authorized"] = False
                txn["stale_reason"] = result.get("reason")
                txn["updated_at"] = utc_now()
                store.save(current)
        return result

    check = revalidate_merge(ctx, store.load(), campaign, env=env)
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
    existing = _existing_final_gate(comments, state, head or "")
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
        check = revalidate_merge(ctx, store.load(), campaign, env=env)
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
            env_obj = _final_gate_envelope(state, campaign, head or "")
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
        existing = _existing_final_gate(comments, store.load(), head or "")
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
            set_phase(state, MERGE_PENDING, reason="human authorized merge")
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
    )


def recover_authorized_merge(
    ctx: RepoContext,
    store: StreamStore,
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Recover an interrupted human-authorized transaction from GitHub truth.

    This routine never requests a merge.  It only adopts an existing merge or
    a verified FINAL_GATE comment, and leaves an ambiguous post as a stop.
    """
    from agentbus.github import list_issue_comments

    state = store.load()
    txn = state.get("merge_txn") or {}
    if not txn.get("human_authorized"):
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
            "reason": "PR state or HEAD changed after human authorization",
        }
    repo = state.get("impl_worktree") or ctx.repo_root
    try:
        comments = list_issue_comments(repo, ctx.origin, int(state["pr"]), env=env)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": "MERGE_PENDING", "reason": f"could not read PR comments: {exc}", "retryable": True}
    existing = _existing_final_gate(comments, state, authorized_head)
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
    if not txn.get("human_authorized"):
        return None
    if (state.get("phase") or "") not in {MERGE_PENDING}:
        return None
    if txn.get("status") not in {"pending", "retryable_failed", "merging", "final_gate_published"}:
        return None
    if not sha_equal(txn.get("authorized_head"), unit_head(state)):
        return None
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


def merge_review_card(state: dict[str, Any], campaign: dict[str, Any] | None = None, *, live: dict[str, Any] | None = None) -> dict[str, Any]:
    product = product_review_authority(state)
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
            {"ok": not (state.get("status") or {}).get("blocker"), "label": "No blocker"},
            {"ok": bool(live) and "PR is not mergeable" not in gate["reasons"], "label": "PR mergeable (live)"},
        ],
        "sources": suggestion["sources"],
        "prompt": (state.get("merge_prompt") or {}),
        "binding": merge_gpt_binding(state, campaign),
        "wait_reason": wait_reason_for_state(state, campaign),
    }
