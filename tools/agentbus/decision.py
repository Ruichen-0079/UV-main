"""The single canonical answer to: what should this stream do next?"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from agentbus.util import sha256_text


PRODUCT_GPT = "PRODUCT_GPT"
IMPL = "IMPL"
AUDIT = "AUDIT"
FINAL_GPT = "FINAL_GPT"
MERGE = "MERGE"
NEXT = "NEXT"
WAIT = "WAIT"
HUMAN = "HUMAN"
DONE = "DONE"

CANONICAL_ACTIONS = (PRODUCT_GPT, IMPL, AUDIT, FINAL_GPT, MERGE, NEXT, WAIT, HUMAN, DONE)

PLAN_SPEC = "PLAN_SPEC"
PRODUCT_REVIEW = "PRODUCT_REVIEW"
PLAN_CONTINUATION = "PLAN_CONTINUATION"
FINAL_REVIEW = "FINAL_REVIEW"


@dataclass(frozen=True)
class WorkflowDecision:
    action: str
    reason: str
    task: str | None = None
    wait_reason: str | None = None
    transient: bool = False
    evidence: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "reason": self.reason,
            "task": self.task,
            "wait_reason": self.wait_reason,
            "transient": self.transient,
            "evidence": dict(self.evidence),
        }


def _decision(
    action: str,
    reason: str,
    *,
    task: str | None = None,
    wait_reason: str | None = None,
    transient: bool = False,
    **evidence: Any,
) -> WorkflowDecision:
    if action not in CANONICAL_ACTIONS:
        raise ValueError(f"non-canonical workflow action: {action}")
    return WorkflowDecision(action, reason, task, wait_reason, transient, evidence)


def unit_head(state: dict[str, Any]) -> str | None:
    heads = state.get("heads") or {}
    publication = state.get("publication") or {}
    return heads.get("implemented") or publication.get("commit") or heads.get("current")


def sha_equal(left: str | None, right: str | None) -> bool:
    return bool(left and right and str(left).strip() == str(right).strip())


def _record(state: dict[str, Any], kind: str) -> dict[str, Any]:
    raw = (state.get("envelopes") or {}).get(kind)
    return raw if isinstance(raw, dict) else {}


def _record_head(rec: dict[str, Any], *fields: str) -> str | None:
    values = rec.get("fields") if isinstance(rec.get("fields"), dict) else {}
    for value in (rec.get("head"), *(values.get(field) for field in fields)):
        text = str(value or "").strip()
        if text:
            return text
    return None


def durable_github_record(state: dict[str, Any], kind: str) -> bool:
    rec = _record(state, kind)
    if not state.get("pr"):
        return bool(rec)
    return bool(rec.get("source") == "github" and str(rec.get("source_id") or "").strip())


def report_valid_exact(state: dict[str, Any]) -> bool:
    rec = _record(state, "CODEX_REPORT")
    status = str(rec.get("status") or "").upper()
    return bool(
        status in {"READY_FOR_AUDIT", "PASS", "PASSED", "OK"}
        and sha_equal(_record_head(rec, "IMPLEMENTED_HEAD"), unit_head(state))
        and durable_github_record(state, "CODEX_REPORT")
    )


def audit_pass_exact(state: dict[str, Any]) -> bool:
    rec = _record(state, "CODEX_AUDIT")
    status = str(rec.get("status") or "").upper()
    return bool(
        status in {"PASS", "PASSED", "OK"}
        and sha_equal(_record_head(rec, "AUDITED_HEAD"), unit_head(state))
        and durable_github_record(state, "CODEX_AUDIT")
    )


def strong_current_publication_ownership(
    state: dict[str, Any],
    head: str | None = None,
) -> bool:
    """Recognize a current, pushed, structured AgentBus publication."""
    expected = str(head or unit_head(state) or "").strip()
    if not expected:
        return False
    publication = state.get("publication") if isinstance(state.get("publication"), dict) else {}
    if str(publication.get("commit") or "").strip() != expected:
        return False
    if str(publication.get("status") or "").strip().lower() != "pushed":
        return False
    if publication.get("pushed") is not True:
        return False
    if str(publication.get("remote_sha") or "").strip() != expected:
        return False
    history = publication.get("history")
    if not isinstance(history, list) or not any(
        isinstance(item, dict) and str(item.get("commit") or "").strip() == expected
        for item in history
    ):
        return False
    transport = state.get("transport") if isinstance(state.get("transport"), dict) else {}
    if transport.get("owned") is not True:
        return False
    if str(transport.get("materialized_by") or "").strip().upper() != "AGENTBUS":
        return False
    if str(transport.get("status") or "").strip().lower() != "pr_ready":
        return False
    if state.get("pr") and str(transport.get("pr") or "") != str(state.get("pr")):
        return False
    spec = _record(state, "GPT_SPEC")
    fields = spec.get("fields") if isinstance(spec.get("fields"), dict) else {}
    if str(fields.get("MATERIALIZED_BY") or "").strip().upper() != "AGENTBUS":
        return False
    continuation = str(
        fields.get("SOURCE_CONTINUATION_COMMENT_ID")
        or transport.get("continuation_comment_id")
        or ""
    ).strip()
    if not continuation:
        return False
    heads = state.get("heads") if isinstance(state.get("heads"), dict) else {}
    for key in ("current", "implemented", "last_seen"):
        value = str(heads.get(key) or "").strip()
        if value and value != expected:
            return False
    return True


_LEGACY_OWNERSHIP_BLOCKER = re.compile(
    r"CODEX_REPORT\s+([0-9a-f]{12,40})\s+is\s+not\s+an\s+AgentBus-owned\s+publication",
    re.IGNORECASE,
)


def active_blocker(state: dict[str, Any]) -> str | None:
    """Return only the blocker which applies to the current generation."""
    status = state.get("status") if isinstance(state.get("status"), dict) else {}
    raw = str(status.get("blocker") or "").strip()
    if not raw:
        return None
    meta = status.get("blocker_meta") if isinstance(status.get("blocker_meta"), dict) else {}
    kind = str(meta.get("kind") or "").strip().upper()
    scoped_head = str(meta.get("head") or "").strip()
    if kind not in {"PUBLICATION_OWNERSHIP", "PUBLICATION_NOT_OWNED", "PUBLICATION_OWNERSHIP_NOT_PROVEN"}:
        match = _LEGACY_OWNERSHIP_BLOCKER.search(raw)
        if not match:
            return raw
        scoped_head = match.group(1).strip()
    current = str(unit_head(state) or "").strip()
    if not scoped_head or not current:
        return raw
    same_head = current.lower() == scoped_head.lower() or current.lower().startswith(scoped_head.lower())
    if same_head:
        return raw
    if strong_current_publication_ownership(state, current) and report_valid_exact(state):
        return None
    return raw


def _repair_record(state: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    head = unit_head(state)
    for kind, statuses in (
        ("GPT_REVIEW", {"CHANGES_REQUIRED", "REJECT", "REJECTED"}),
        ("CODEX_AUDIT", {"CHANGES_REQUIRED", "FAIL", "FAILED"}),
    ):
        rec = _record(state, kind)
        if str(rec.get("status") or "").upper() not in statuses:
            continue
        field = "REVIEWED_HEAD" if kind == "GPT_REVIEW" else "AUDITED_HEAD"
        if sha_equal(_record_head(rec, field), head) and durable_github_record(state, kind):
            return kind, rec
    return None, {}


def _scope_insufficient_implementation(state: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    """Recognize a durable, exact-head blocked implementation generation.

    This deliberately uses the structured CODEX_REPORT verdict/blocker fields
    rather than guessing from prose.  Matching the report's BASE_HEAD to the
    current GPT_SPEC also prevents an old blocked attempt from replanning a
    newer specification on the same product HEAD.
    """
    report = _record(state, "CODEX_REPORT")
    head = unit_head(state)
    if not report or not head or not durable_github_record(state, "CODEX_REPORT"):
        return False, {}
    if not sha_equal(_record_head(report, "IMPLEMENTED_HEAD"), head):
        return False, {}
    fields = report.get("fields") if isinstance(report.get("fields"), dict) else {}
    verdict = str(fields.get("VERDICT") or report.get("status") or "").strip().upper()
    blocker = str(fields.get("BLOCKER") or "").strip()
    if verdict != "BLOCKED" or not blocker:
        return False, {}

    # A capacity/transport interruption is WAIT even if an older blocked
    # report remains in the durable record.
    interruption = state.get("codex_interruption") or {}
    if interruption.get("kind") in {"INTERRUPTED_CAPACITY", "INTERRUPTED_FAILED"}:
        return False, {}
    wait = state.get("wait")
    if isinstance(wait, dict) and wait.get("kind") in {
        "CODEX_CAPACITY",
        "CODEX_BUSY",
        "RUNNER_TEMPORARY",
        "GITHUB_TRANSIENT",
        "BROWSER_CAPACITY",
        "BROWSER_OFFLINE",
    }:
        return False, {}

    spec = _record(state, "GPT_SPEC")
    spec_base = _record_head(spec, "BASE_HEAD")
    report_base = str(fields.get("BASE_HEAD") or "").strip()
    if not spec_base or not report_base or not sha_equal(report_base, spec_base):
        return False, {}
    report_source = str(report.get("source_id") or "").strip()
    spec_source = str(spec.get("source_id") or "").strip()
    if report_source.isdigit() and spec_source.isdigit() and int(report_source) < int(spec_source):
        return False, {}
    return True, {
        "scope_blocked": True,
        "blocked_source": report.get("source_id") or report.get("digest"),
        "blocked_head": head,
        "blocked_spec_base": spec_base,
    }


def scope_failure_route(state: dict[str, Any]) -> dict[str, Any] | None:
    """Classify a failed scope fence without weakening the path fence.

    A failed publication may mean either that the frozen spec omitted a
    helper it explicitly permits semantically, or that Codex touched an
    unrelated path.  The first case can return to Product GPT for the same
    stream; the second remains an IMPL retry.  The helper case requires both
    explicit spec language and an import from an approved file, so a filename
    alone can never trigger replanning.
    """

    publication = state.get("publication") if isinstance(state.get("publication"), dict) else {}
    status = state.get("status") if isinstance(state.get("status"), dict) else {}
    reason = str(publication.get("reason") or status.get("blocker") or "").strip()
    if "scope fence rejected files" not in reason.lower():
        return None
    match = re.search(
        r"unexpected:\s*(.*?)(?:\nauthorized_exact:|\nauthorized_patterns:|\Z)",
        reason,
        flags=re.IGNORECASE | re.DOTALL,
    )
    unexpected = []
    if match:
        for line in match.group(1).splitlines():
            path = line.strip().lstrip("-* ").strip().strip("`")
            if path:
                unexpected.append(path)
    if not unexpected:
        return None

    # A long-lived runner can retain a pre-refresh materialized scope while a
    # newer durable GPT_SPEC has already authorized the reported paths.  Do
    # not discard a valid implementation in that projection race; the normal
    # publication retry will re-check the current scope under the stream lock.
    from agentbus.scope import path_allowed

    current_scope = state.get("scope") if isinstance(state.get("scope"), dict) else None
    if current_scope and all(path_allowed(path, current_scope) for path in unexpected):
        return {
            "scope_blocked": False,
            "scope_failure_kind": "STALE_SCOPE_PROJECTION",
            "scope_failure_reason": reason,
            "unexpected_paths": unexpected,
            "approved_paths": list(current_scope.get("explicit_paths") or []),
        }

    spec = _record(state, "GPT_SPEC")
    spec_fields = spec.get("fields") if isinstance(spec.get("fields"), dict) else {}
    raw_spec = str(spec_fields.get("SCOPE") or spec.get("raw") or "")
    helper_allowed = bool(
        re.search(
            r"(?:pure/)?helper\s+module\s+under\s+[`\"']?apps/web/src/.*?only\s+if\s+needed",
            raw_spec,
            flags=re.IGNORECASE | re.DOTALL,
        )
    )
    scope = state.get("scope") if isinstance(state.get("scope"), dict) else {}
    approved = [str(item).lstrip("./") for item in (scope.get("explicit_paths") or [])]
    worktree = str(state.get("impl_worktree") or "")

    def imported_by_approved_file(path: str) -> bool:
        stem = os.path.splitext(os.path.basename(path))[0]
        token = re.compile(
            rf"(?:from\s+|import\s*(?:\([^)]*\))?\s*)[\"']\.\/{re.escape(stem)}(?:\.[A-Za-z0-9_-]+)?[\"']",
            flags=re.IGNORECASE,
        )
        for approved_path in approved:
            if not worktree:
                continue
            candidate = os.path.join(worktree, approved_path)
            try:
                with open(candidate, encoding="utf-8") as handle:
                    if token.search(handle.read()):
                        return True
            except OSError:
                continue
        return False

    helper_needed = bool(
        helper_allowed
        and all(path.startswith("apps/web/src/") for path in unexpected)
        and approved
        and all(imported_by_approved_file(path) for path in unexpected)
    )
    evidence = {
        "scope_blocked": bool(helper_needed),
        "scope_failure_kind": "SPEC_INSUFFICIENT" if helper_needed else "CODER_SCOPE_VIOLATION",
        "scope_failure_reason": reason,
        "unexpected_paths": unexpected,
        "approved_paths": approved,
    }
    return evidence


def product_review_authority(state: dict[str, Any]) -> dict[str, Any]:
    from agentbus.reviewpolicy import AUDIT_SUFFICIENT, evaluate_delegation, review_policy_of

    head = unit_head(state)
    policy = review_policy_of(state)
    if policy == AUDIT_SUFFICIENT:
        delegated = evaluate_delegation(state)
        if delegated.ok and audit_pass_exact(state):
            return {
                "ok": True,
                "kind": "DELEGATED",
                "status": "PASS",
                "head": head,
                "label": "AUDIT_SUFFICIENT / delegated_by_gpt_spec",
            }
    review = _record(state, "GPT_REVIEW")
    status = str(review.get("status") or "").upper()
    valid = bool(
        status in {"ACCEPT", "ACCEPTED", "APPROVE", "APPROVED", "PASS", "PASSED"}
        and sha_equal(_record_head(review, "REVIEWED_HEAD"), head)
        and durable_github_record(state, "GPT_REVIEW")
    )
    return {
        "ok": valid,
        "kind": "GPT_REVIEW",
        "status": status or None,
        "head": _record_head(review, "REVIEWED_HEAD"),
        "label": f"GPT_REVIEW {status or 'missing'}",
        "source_id": review.get("source_id"),
    }


def normalize_final_status(record: dict[str, Any] | None) -> str | None:
    if not record:
        return None
    status = str(record.get("status") or "").strip().upper()
    if status in {"PASS", "REPAIR", "WAIT", "HUMAN"}:
        return status
    fields = record.get("fields") if isinstance(record.get("fields"), dict) else {}
    recommendation = str(fields.get("RECOMMENDATION") or "").upper()
    next_action = str(fields.get("NEXT_ACTION") or "").upper()
    legacy = f"{recommendation} {next_action}"
    if status == "HUMAN_DECISION" or "HUMAN" in legacy:
        return HUMAN
    if status == "HOLD":
        if "WAIT" in legacy or "REVIEW_AGAIN" in legacy:
            return WAIT
        if "REPAIR" in legacy or "IMPL" in legacy:
            return "REPAIR"
        # Old HOLD meant a concrete merge blocker; repair is the safe legacy
        # interpretation unless the old fields explicitly said WAIT/HUMAN.
        return "REPAIR"
    return None


def _live_pr(state: dict[str, Any], live: dict[str, Any] | None) -> dict[str, Any]:
    if isinstance(live, dict) and live:
        return live
    cached = (state.get("github") or {}).get("pr")
    return cached if isinstance(cached, dict) else {}


def ci_snapshot(live: dict[str, Any] | None) -> dict[str, Any]:
    checks = (live or {}).get("statusCheckRollup") or []
    rows: list[dict[str, str]] = []
    for item in checks:
        if not isinstance(item, dict):
            continue
        rows.append(
            {
                "name": str(item.get("name") or item.get("context") or ""),
                "status": str(item.get("status") or "").upper(),
                "conclusion": str(item.get("conclusion") or item.get("state") or "").upper(),
            }
        )
    rows.sort(key=lambda item: (item["name"], item["status"], item["conclusion"]))
    states = {item["conclusion"] or item["status"] for item in rows}
    if states & {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "FAIL"}:
        status = "FAIL"
    elif states & {"PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "REQUESTED", "WAITING"}:
        status = "PENDING"
    elif states & {"SUCCESS", "PASS", "NEUTRAL", "SKIPPED"}:
        status = "PASS"
    elif rows:
        status = "INCONCLUSIVE"
    else:
        status = "NOT_AVAILABLE"
    return {"status": status, "checks": rows}


def current_base_ci_evidence(state: dict[str, Any], live: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return only exact current-base CI evidence usable in a new review job."""
    record = state.get("current_base_ci")
    if not isinstance(record, dict):
        return {}
    current = _live_pr(state, live)
    head = str(unit_head(state) or "").strip()
    base = str(current.get("baseRefOid") or "").strip()
    pr = state.get("pr")
    if not head or not base or not pr:
        return {}
    from agentbus.ci import current_base_ci_matches

    if not current_base_ci_matches(record, pr=pr, head=head, base=base):
        return {}
    if str(record.get("status") or "").upper() not in {"PASS", "FAIL"}:
        return {}
    return {
        "generation": record.get("generation"),
        "base": record.get("base"),
        "head": record.get("head"),
        "synthetic_merge": record.get("synthetic_merge"),
        "source": record.get("source"),
        "workflow": record.get("workflow"),
        "workflow_file": record.get("workflow_file"),
        "branch": record.get("branch"),
        "run_id": record.get("run_id"),
        "status": str(record.get("status") or "").upper(),
        "result": record.get("result"),
        "checks": record.get("checks") or [],
    }


def current_base_ci_wait(state: dict[str, Any], live: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Return a WAIT fence while exact current-base CI is not settled."""
    current = _live_pr(state, live)
    from agentbus.ci import current_base_ci_record, current_base_ci_required, current_base_ci_matches

    if not current_base_ci_required(state, current):
        return None
    record = current_base_ci_record(state)
    head = str(unit_head(state) or "").strip()
    base = str(current.get("baseRefOid") or "").strip()
    if current_base_ci_matches(record, pr=state.get("pr"), head=head, base=base) and str(
        record.get("status") or ""
    ).upper() in {"PASS", "FAIL"}:
        return None
    status = str(record.get("status") or "WAIT").upper()
    reason = str(record.get("last_error") or "current-base synthetic CI is not complete")
    if status == "FAIL":
        return None
    return {
        "reason": reason,
        "status": status,
        "generation": record.get("generation"),
        "run_id": record.get("run_id"),
    }


def review_generation_evidence(
    state: dict[str, Any],
    campaign: dict[str, Any] | None = None,
    live: dict[str, Any] | None = None,
    *,
    role: str,
    task: str,
) -> dict[str, Any]:
    pr = _live_pr(state, live)
    report = _record(state, "CODEX_REPORT")
    audit = _record(state, "CODEX_AUDIT")
    product = _record(state, "GPT_REVIEW")
    spec = _record(state, "GPT_SPEC")
    scope = state.get("scope") or ((_record(state, "GPT_SPEC").get("fields") or {}).get("SCOPE"))
    continuation = _record(state, "GPT_CONTINUATION")
    return {
        "role": role,
        "task": task,
        "campaign": (campaign or {}).get("campaign_id") or state.get("campaign_id"),
        "stream": state.get("stream_id"),
        "pr": state.get("pr"),
        "head": unit_head(state),
        "base": pr.get("baseRefOid"),
        "pr_head": pr.get("headRefOid"),
        "pr_state": pr.get("state"),
        "pr_draft": pr.get("isDraft", pr.get("draft")),
        "mergeable": pr.get("mergeable"),
        "merge_state": pr.get("mergeStateStatus"),
        "report": [report.get("digest"), report.get("source_id"), report.get("status"), report.get("head")],
        "audit": [audit.get("digest"), audit.get("source_id"), audit.get("status"), audit.get("head")],
        "product": [product.get("digest"), product.get("source_id"), product.get("status"), product.get("head")],
        "spec": [spec.get("digest"), spec.get("source_id"), spec.get("status"), spec.get("head")],
        "review_authority": state.get("review_authority"),
        "ci": ci_snapshot(pr),
        "current_base_ci": current_base_ci_evidence(state, pr),
        "blocker": active_blocker(state),
        "scope": sha256_text(str(scope or "")),
        "publication_generation": (state.get("publication") or {}).get("generation"),
        "repair_cycles": state.get("repair_cycles") or 0,
        "continuation": [continuation.get("digest"), continuation.get("source_id"), continuation.get("status")],
        "queue": [
            [item.get("id"), item.get("status"), item.get("next_stream"), item.get("after_stream")]
            for item in ((campaign or {}).get("queue") or [])
            if isinstance(item, dict)
        ],
    }


def review_generation(
    state: dict[str, Any],
    campaign: dict[str, Any] | None = None,
    live: dict[str, Any] | None = None,
    *,
    role: str,
    task: str,
) -> str:
    evidence = review_generation_evidence(state, campaign, live, role=role, task=task)
    canonical = json.dumps(evidence, sort_keys=True, separators=(",", ":"), default=str)
    return sha256_text(canonical)


def browser_job_id(
    state: dict[str, Any],
    campaign: dict[str, Any] | None,
    live: dict[str, Any] | None,
    *,
    role: str,
    task: str,
) -> str:
    generation = review_generation(state, campaign, live, role=role, task=task)
    stream = str(state.get("stream_id") or "unknown")
    head = str(unit_head(state) or "no-head")[:12]
    return f"{role.lower()}:{task.lower()}:{stream}:{head}:{generation[:20]}"


def final_review_for_current(
    state: dict[str, Any],
    campaign: dict[str, Any] | None = None,
    live: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    rec = _record(state, "GPT_MERGE_REVIEW")
    if not rec or rec.get("source") != "github" or not str(rec.get("source_id") or "").strip():
        return None
    fields = rec.get("fields") if isinstance(rec.get("fields"), dict) else {}
    stream = str(fields.get("STREAM") or rec.get("stream") or "").strip().lower()
    accepted = {str(state.get("stream_id") or "").lower(), *(str(item).lower() for item in (state.get("aliases") or []))}
    if not stream or stream not in accepted:
        return None
    reviewed_pr = str(fields.get("PR") or "").strip().lstrip("#")
    if not reviewed_pr or reviewed_pr != str(state.get("pr") or ""):
        return None
    head = unit_head(state)
    if not sha_equal(_record_head(rec, "REVIEWED_HEAD"), head):
        return None
    current_live = _live_pr(state, live)
    base = str(current_live.get("baseRefOid") or "").strip()
    reviewed_base = str(fields.get("REVIEWED_BASE") or "").strip()
    if not base or not sha_equal(reviewed_base, base):
        return None
    job_id = str(fields.get("JOB_ID") or "").strip()
    if job_id:
        expected = browser_job_id(
            state,
            campaign,
            current_live,
            role=FINAL_GPT,
            task=FINAL_REVIEW,
        )
        consumed_repair = state.get("final_repair") or {}
        accepted_repair_job = bool(
            normalize_final_status(rec) == "REPAIR"
            and str(consumed_repair.get("consumed_review") or "")
            == str(rec.get("source_id") or rec.get("digest") or "")
            and str(consumed_repair.get("job_id") or "") == job_id
        )
        if job_id != expected and not accepted_repair_job:
            return None
    normalized = normalize_final_status(rec)
    if normalized is None:
        return None
    result = dict(rec)
    result["normalized_status"] = normalized
    result["legacy_status"] = str(rec.get("status") or "").upper()
    return result


def publication_pending(state: dict[str, Any]) -> bool:
    return bool(state.get("pr") and _record(state, "CODEX_REPORT") and not durable_github_record(state, "CODEX_REPORT"))


def deterministic_merge_fences(
    state: dict[str, Any],
    campaign: dict[str, Any] | None = None,
    live: dict[str, Any] | None = None,
    *,
    require_current_job: bool = False,
) -> dict[str, Any]:
    reasons: list[str] = []
    transient: list[str] = []
    head = unit_head(state)
    current_live = _live_pr(state, live)
    if not state.get("pr"):
        reasons.append("no PR")
    if not head:
        reasons.append("IMPLEMENTED_HEAD missing")
    current = (state.get("heads") or {}).get("current")
    if current and head and not sha_equal(current, head):
        reasons.append("unexplained external drift from IMPLEMENTED_HEAD")
    if publication_pending(state):
        reasons.append("PUBLICATION_PENDING")
        transient.append("PUBLICATION_PENDING")
    if not report_valid_exact(state):
        reasons.append("CODEX_REPORT is not durable and exact")
    if not audit_pass_exact(state):
        reasons.append("CODEX_AUDIT is not durable PASS on exact HEAD")
    product = product_review_authority(state)
    if not product.get("ok"):
        reasons.append("product review authority is not valid for exact HEAD")
    current_ci_required = False
    current_ci = current_base_ci_evidence(state, current_live)
    try:
        from agentbus.ci import current_base_ci_matches, current_base_ci_record, current_base_ci_required

        current_ci_required = current_base_ci_required(state, current_live)
        record = current_base_ci_record(state)
        exact_current_ci = current_ci_required and current_base_ci_matches(
            record,
            pr=state.get("pr"),
            head=str(head or ""),
            base=str(current_live.get("baseRefOid") or ""),
        )
        if current_ci_required and (not exact_current_ci or str(record.get("status") or "").upper() != "PASS"):
            reasons.append("current-base synthetic CI is not exact PASS")
            if str(record.get("status") or "").upper() not in {"FAIL", "PASS"}:
                transient.append("CI_REVALIDATION")
    except Exception:  # noqa: BLE001 — malformed operational evidence fails closed
        if current_ci_required:
            reasons.append("current-base synthetic CI evidence could not be verified")
            transient.append("CI_REVALIDATION")
    final = final_review_for_current(state, campaign, current_live)
    if not final or final.get("normalized_status") != "PASS":
        reasons.append("GPT_MERGE_REVIEW is not durable PASS for current evidence")
    elif require_current_job and not str(((final.get("fields") or {}).get("JOB_ID") or "")).strip():
        reasons.append("GPT_MERGE_REVIEW predates the current Browser job generation")
    blocker = active_blocker(state)
    if blocker:
        reasons.append("blocker present")
    try:
        from agentbus.scope import validate_files_against_scope

        files = (state.get("publication") or {}).get("files") or []
        scope = state.get("scope")
        if files and scope and not validate_files_against_scope(files, scope).get("ok"):
            reasons.append("published files exceed current scope")
    except Exception:  # noqa: BLE001 - a malformed scope fails closed below only when explicit
        if state.get("scope"):
            reasons.append("scope could not be validated")
    if campaign:
        current_stream = campaign.get("current_stream") or campaign.get("active_stream")
        if current_stream and current_stream != state.get("stream_id"):
            reasons.append("campaign current unit is another stream")
    if not current_live:
        reasons.append("live PR snapshot unavailable")
        transient.append("GITHUB_TRANSIENT")
    else:
        pr_state = str(current_live.get("state") or "").upper()
        if pr_state == "MERGED":
            reasons.append("PR already MERGED")
        elif pr_state != "OPEN":
            reasons.append(f"PR state is {pr_state or 'unknown'}")
        if head and not sha_equal(current_live.get("headRefOid"), head):
            reasons.append("PR HEAD != IMPLEMENTED_HEAD")
        if final:
            reviewed_base = ((final.get("fields") or {}).get("REVIEWED_BASE"))
            if not sha_equal(reviewed_base, current_live.get("baseRefOid")):
                reasons.append("Final GPT REVIEWED_BASE is stale")
        mergeable = str(current_live.get("mergeable") or "").upper()
        merge_state = str(current_live.get("mergeStateStatus") or "").upper()
        if mergeable and mergeable != "MERGEABLE":
            reasons.append("PR is not mergeable")
        if merge_state and merge_state not in {"CLEAN", "HAS_HOOKS"}:
            reasons.append(f"PR merge state is {merge_state}")
        ci = ci_snapshot(current_live)
        # The PR rollup may still describe an older synthetic merge. Once the
        # exact current B+H generation passes, that stale rollup is not used as
        # a substitute, nor is it allowed to veto the exact generation.
        if current_ci_required and current_ci.get("status") == "PASS":
            ci = {"status": "PASS", "checks": current_ci.get("checks") or []}
        if ci["status"] in {"FAIL", "PENDING"}:
            reasons.append(f"CI is {ci['status'].lower()}")
            transient.append(f"CI_{ci['status']}")
    return {
        "ok": not reasons,
        "enabled": not reasons,
        "reasons": reasons,
        "transient_reasons": transient,
        "expected_head": head,
        "pr": state.get("pr"),
        "product": product,
        "final_review": (final or {}).get("normalized_status"),
        "live": current_live,
    }


def _has_actionable_continuation(state: dict[str, Any], campaign: dict[str, Any] | None) -> bool:
    if not campaign:
        return bool((state.get("continuation") or {}).get("created_stream"))
    stream = str(state.get("stream_id") or "").lower()
    aliases = {stream, *(str(item).lower() for item in (state.get("aliases") or []))}
    active = campaign.get("current_stream") or campaign.get("active_stream")
    if active and str(active).lower() not in aliases:
        return True
    for item in campaign.get("queue") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("after_stream") or "").lower() not in aliases:
            continue
        if str(item.get("trigger") or "MERGED").upper() != "MERGED":
            continue
        if item.get("status") in {"queued", "consumed"}:
            return True
    return False


def _campaign_ambiguity(campaign: dict[str, Any] | None) -> str | None:
    for item in (campaign or {}).get("queue") or []:
        if isinstance(item, dict) and item.get("status") == "conflict":
            return (campaign or {}).get("reason") or "conflicting durable continuations"
    if (campaign or {}).get("continuation_error"):
        return str((campaign or {}).get("continuation_error"))
    return None


def _active_wait(state: dict[str, Any]) -> dict[str, Any] | None:
    wait = state.get("wait")
    if not isinstance(wait, dict) or not wait.get("kind"):
        return None
    until = wait.get("until") or wait.get("next_probe_at")
    if not until:
        return wait
    try:
        deadline = datetime.strptime(str(until), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return wait
    return wait if datetime.now(timezone.utc) < deadline else None


def _externalize(decision: WorkflowDecision, state: dict[str, Any], external: dict[str, Any] | None) -> WorkflowDecision:
    external = external or {}
    if decision.action in {PRODUCT_GPT, FINAL_GPT, MERGE, NEXT} and (state.get("github") or {}).get("unavailable"):
        return _decision(WAIT, "GitHub is temporarily unavailable", wait_reason="GITHUB_TRANSIENT", transient=True)
    if decision.action in {PRODUCT_GPT, FINAL_GPT}:
        if external.get("browser_configured") is False:
            return _decision(WAIT, "Browser GPT binding is not configured", wait_reason="WAIT_BROWSER_CONFIG", transient=True)
        if external.get("browser_online") is False:
            return _decision(WAIT, "Firefox Browser Bridge is offline", wait_reason="WAIT_BROWSER", transient=True)
    if decision.action in {IMPL, AUDIT} and external.get("codex_available") is False:
        return _decision(WAIT, "both Codex slots are busy or cooling down", wait_reason="CODEX_CAPACITY", transient=True)
    if decision.action in {MERGE, NEXT} and (state.get("github") or {}).get("unavailable"):
        return _decision(WAIT, "GitHub is temporarily unavailable", wait_reason="GITHUB_TRANSIENT", transient=True)
    if decision.action == MERGE and external.get("autonomous_merge_ready") is False:
        return _decision(WAIT, "autonomous merge activation prerequisites are not ready", wait_reason="AUTONOMY_NOT_ACTIVE", transient=True)
    return decision


def derive_next_action(
    state: dict[str, Any],
    campaign: dict[str, Any] | None = None,
    live: dict[str, Any] | None = None,
    runtime: dict[str, Any] | None = None,
    external: dict[str, Any] | None = None,
) -> WorkflowDecision:
    """Derive one canonical action from durable facts and current projections.

    Compatibility ``phase`` is diagnostic input only.  It can identify an
    exceptional condition, but it cannot advance stale/missing SHA-fenced
    authority.
    """
    del runtime  # operational liveness changes display, not workflow authority
    phase = str(state.get("phase") or "")
    control = str(state.get("control") or "running")
    head = unit_head(state)

    if state.get("archived") or state.get("hidden_from_attention"):
        # Archive/tombstone rows remain durable continuation anchors.  They do
        # not resume ordinary work, but a newly discovered exact continuation
        # may still materialize its successor exactly once.
        if (state.get("heads") or {}).get("merged") and _has_actionable_continuation(state, campaign):
            return _externalize(
                _decision(NEXT, "archived merged unit has an actionable durable continuation"),
                state,
                external,
            )
        return _decision(DONE, "work unit is archived")
    if control == "paused":
        return _decision(WAIT, "operator paused this stream", wait_reason="PAUSED")

    ambiguity = _campaign_ambiguity(campaign)
    if ambiguity:
        return _decision(HUMAN, ambiguity, ambiguity="campaign")
    if phase == "BLOCKED_FOR_REVIEW":
        return _decision(HUMAN, "repair budget exhausted")
    if phase == "RE_REVIEW_REQUIRED":
        raw_blocker = str((state.get("status") or {}).get("blocker") or "").strip()
        if not raw_blocker or active_blocker(state):
            return _decision(HUMAN, "unexplained external mutation or stale SHA authority")
    if phase in {"BLOCKED", "RECOVERY_REQUIRED"}:
        wait = _active_wait(state)
        if wait:
            return _decision(WAIT, str(wait.get("reason") or wait.get("kind")), wait_reason=str(wait.get("kind")), transient=True)
        scope_failure = scope_failure_route(state)
        if scope_failure and scope_failure.get("scope_failure_kind") == "SPEC_INSUFFICIENT":
            return _externalize(
                _decision(
                    PRODUCT_GPT,
                    "implementation proved the materialized scope is insufficient for an explicitly permitted helper",
                    task=PLAN_SPEC,
                    **scope_failure,
                ),
                state,
                external,
            )
        scope_blocked, evidence = _scope_insufficient_implementation(state)
        if scope_blocked:
            return _externalize(
                _decision(
                    PRODUCT_GPT,
                    "implementation proved the approved spec/scope is insufficient",
                    task=PLAN_SPEC,
                    **evidence,
                ),
                state,
                external,
            )
        return _decision(HUMAN, str((state.get("status") or {}).get("blocker") or "recovery requires a decision"))

    if phase == "MERGED" or (state.get("heads") or {}).get("merged"):
        if _has_actionable_continuation(state, campaign):
            return _externalize(_decision(NEXT, "durable continuation or successor is actionable"), state, external)
        if str((campaign or {}).get("completion") or "").upper() == "COMPLETE":
            return _decision(DONE, "campaign explicitly complete")
        return _externalize(
            _decision(PRODUCT_GPT, "merged unit needs a continuation plan", task=PLAN_CONTINUATION),
            state,
            external,
        )

    wait = _active_wait(state)
    if wait:
        return _decision(
            WAIT,
            str(wait.get("reason") or wait.get("kind")),
            wait_reason=str(wait.get("kind")),
            transient=True,
        )

    current_live = _live_pr(state, live)
    scope_failure = scope_failure_route(state)
    if scope_failure and scope_failure.get("scope_failure_kind") == "SPEC_INSUFFICIENT":
        return _externalize(
            _decision(
                PRODUCT_GPT,
                "implementation proved the materialized scope is insufficient for an explicitly permitted helper",
                task=PLAN_SPEC,
                **scope_failure,
            ),
            state,
            external,
        )
    current_ci_wait = current_base_ci_wait(state, current_live)
    if current_ci_wait:
        return _decision(
            WAIT,
            str(current_ci_wait.get("reason") or "current-base synthetic CI is not complete"),
            wait_reason="CI_REVALIDATION",
            transient=True,
            current_base_ci=current_ci_wait,
        )
    final = final_review_for_current(state, campaign, current_live)
    final_status = (final or {}).get("normalized_status")
    if final_status == "REPAIR":
        cycles = int(state.get("repair_cycles") or 0)
        maximum = int(state.get("max_repair_cycles") or 2)
        review_token = str(final.get("source_id") or final.get("digest") or "")
        consumed = str((state.get("final_repair") or {}).get("consumed_review") or "") == review_token
        if cycles >= maximum and not consumed:
            return _decision(HUMAN, "Final GPT requested repair after repair budget was exhausted")
        return _externalize(
            _decision(IMPL, "Final GPT requested an in-scope repair", final_review_id=final.get("source_id")),
            state,
            external,
        )
    if final_status == HUMAN:
        return _decision(HUMAN, "Final GPT identified a genuine human decision", final_review_id=final.get("source_id"))
    if final_status == WAIT:
        return _decision(
            WAIT,
            "Final GPT requested unchanged external evidence to settle",
            wait_reason="FINAL_GPT_WAIT",
            transient=True,
            final_review_id=final.get("source_id"),
        )
    if final_status == "PASS":
        gate = deterministic_merge_fences(state, campaign, current_live, require_current_job=True)
        if gate["ok"]:
            return _externalize(_decision(MERGE, "Final GPT PASS and every deterministic fence is current", gate=gate), state, external)
        return _decision(
            WAIT,
            "; ".join(gate["reasons"]),
            wait_reason=(gate["transient_reasons"] or ["MERGE_FENCE_WAIT"])[0],
            transient=bool(gate["transient_reasons"]),
            gate=gate,
        )

    txn = state.get("merge_txn") or {}
    if (
        phase in {"MERGE_PENDING", "MERGE_RETRYABLE_FAILED"}
        and (txn.get("autonomous_authorized") or txn.get("human_authorized"))
        and sha_equal(txn.get("authorized_head"), head)
    ):
        return _externalize(_decision(MERGE, "recover or retry the already-fenced merge transaction"), state, external)

    scope_blocked, evidence = _scope_insufficient_implementation(state)
    if scope_blocked:
        return _externalize(
            _decision(
                PRODUCT_GPT,
                "implementation proved the approved spec/scope is insufficient",
                task=PLAN_SPEC,
                **evidence,
            ),
            state,
            external,
        )

    repair_kind, repair = _repair_record(state)
    if repair_kind:
        return _externalize(
            _decision(IMPL, f"{repair_kind} requires repair", repair_source=repair.get("source_id")),
            state,
            external,
        )

    # Compatibility-only migration for old/manual states that contain no
    # durable envelopes at all. Once any durable fact exists, phase cannot
    # override it and every branch below is SHA-fenced.
    if not (state.get("envelopes") or {}):
        if phase in {"IMPLEMENTING", "VALIDATING"}:
            return _externalize(_decision(IMPL, "legacy empty state is already assigned to IMPL"), state, external)
        if phase in {"READY_FOR_AUDIT", "AUDITING"}:
            return _externalize(_decision(AUDIT, "legacy empty state is already assigned to AUDIT"), state, external)
        if phase == "READY_FOR_GPT" and str(state.get("review_policy") or "").upper() == "AUDIT_SUFFICIENT":
            return _decision(WAIT, "legacy delegated-review phase has no durable audit evidence", wait_reason="AUTHORITY_MIGRATION")

    # A durable implementation supersedes compatibility/spec projections.
    # This ordering also lets recovered legacy streams continue from an exact
    # published report without pretending an old phase is authority.
    if report_valid_exact(state):
        if not audit_pass_exact(state):
            audit_rec = _record(state, "CODEX_AUDIT")
            if audit_rec and sha_equal(_record_head(audit_rec, "AUDITED_HEAD"), head):
                status = str(audit_rec.get("status") or "").upper()
                if status in {"CHANGES_REQUIRED", "FAIL", "FAILED"}:
                    return _externalize(_decision(IMPL, "exact-head audit requires repair"), state, external)
            return _externalize(_decision(AUDIT, "implementation is exact and durable; audit is missing or stale"), state, external)

        product = product_review_authority(state)
        if not product.get("ok"):
            return _externalize(
                _decision(PRODUCT_GPT, "product review is required and missing or stale", task=PRODUCT_REVIEW),
                state,
                external,
            )
        if ci_snapshot(current_live).get("status") == "PENDING":
            return _decision(
                WAIT,
                "required CI evidence is still pending",
                wait_reason="CI_PENDING",
                transient=True,
            )
        return _externalize(
            _decision(FINAL_GPT, "product and audit prerequisites are exact and current", task=FINAL_REVIEW),
            state,
            external,
        )

    if publication_pending(state):
        return _decision(WAIT, "CODEX_REPORT publication is pending", wait_reason="PUBLICATION_PENDING", transient=True)

    spec = _record(state, "GPT_SPEC")
    spec_status = str(spec.get("status") or "").upper()
    if not spec or spec_status not in {"ACTIONABLE", "APPROVED"}:
        if phase in {"MATERIALIZING", "WORKTREE_READY", "BOOTSTRAP_PR_READY"}:
            return _decision(WAIT, "AgentBus is establishing durable PR transport", wait_reason="PR_TRANSPORT", transient=True)
        return _externalize(_decision(PRODUCT_GPT, "no actionable GPT_SPEC exists", task=PLAN_SPEC), state, external)

    return _externalize(_decision(IMPL, "actionable spec has no exact durable implementation"), state, external)


def decision_for_stream(
    ctx: Any,
    state: dict[str, Any],
    campaign: dict[str, Any] | None = None,
    live: dict[str, Any] | None = None,
    runtime: dict[str, Any] | None = None,
    *,
    env: dict[str, str] | None = None,
) -> WorkflowDecision:
    """Context-aware canonical decision including operational availability."""
    raw = derive_next_action(state, campaign, live, runtime)
    external: dict[str, Any] = {}
    if raw.action in {PRODUCT_GPT, FINAL_GPT}:
        from agentbus.settings import (
            browser_bridge_status,
            is_chatgpt_conversation_url,
            load_settings,
            resolve_final_gpt_binding,
            resolve_product_gpt_binding,
        )

        settings = load_settings(ctx)
        binding = (
            resolve_product_gpt_binding(state, campaign, settings)
            if raw.action == PRODUCT_GPT
            else resolve_final_gpt_binding(state, settings)
        )
        external["browser_configured"] = is_chatgpt_conversation_url(binding.get("url"))
        external["browser_online"] = browser_bridge_status(ctx).get("online")
    if raw.action in {IMPL, AUDIT}:
        from agentbus.codexpool import pool_status

        external["codex_available"] = bool(pool_status(ctx, env).get("available"))
    if raw.action == MERGE:
        from agentbus.settings import autonomous_merge_ready

        external["autonomous_merge_ready"] = autonomous_merge_ready(ctx, env)
    return derive_next_action(state, campaign, live, runtime, external)
