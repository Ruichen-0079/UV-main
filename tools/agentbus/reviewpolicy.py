"""Per-work-unit review policy. Browser GPT must explicitly delegate."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from agentbus.util import utc_now


GPT_REQUIRED = "GPT_REQUIRED"
AUDIT_SUFFICIENT = "AUDIT_SUFFICIENT"
AUTO_GPT = "AUTO_GPT"  # reserved; not implemented (Browser GPT is not invokable)

DEFAULT_REVIEW_POLICY = GPT_REQUIRED
DELEGATED_AUTHORITY = "delegated_by_gpt_spec"

_EMPTY = {"", "-", "none", "n/a", "na", "null", "no deviations", "none blocking.", "none blocking"}
_FINDING_BLOCK = re.compile(r"\b(HIGH|MEDIUM)\b", re.IGNORECASE)
_PATH_TOKEN = re.compile(
    r"(?:(?<=\s)|^|[-*]\s*)((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]*)"
)


def normalize_review_policy(raw: str | None) -> str:
    value = (raw or "").strip().upper().replace("-", "_")
    if not value:
        return DEFAULT_REVIEW_POLICY
    if value in {GPT_REQUIRED, AUDIT_SUFFICIENT}:
        return value
    if value == AUTO_GPT:
        return GPT_REQUIRED
    return DEFAULT_REVIEW_POLICY


def review_policy_of(state: dict[str, Any]) -> str:
    explicit = (state.get("review_policy") or "").strip()
    if explicit:
        return normalize_review_policy(explicit)
    spec = ((state.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields") or {}
    if isinstance(spec, dict):
        return normalize_review_policy(spec.get("REVIEW_POLICY"))
    return DEFAULT_REVIEW_POLICY


def extract_path_tokens(text: str | None) -> list[str] | None:
    if not text or not str(text).strip():
        return None
    found: list[str] = []
    seen: set[str] = set()
    for match in _PATH_TOKEN.finditer(str(text)):
        token = match.group(1).strip().rstrip(",")
        if token and token not in seen:
            seen.add(token)
            found.append(token)
    return found or None


def path_in_scope(path: str, scopes: list[str]) -> bool:
    value = (path or "").lstrip("./")
    for raw in scopes:
        scope = raw.lstrip("./").rstrip("*")
        if not scope:
            continue
        if value == scope or value.startswith(scope.rstrip("/") + "/") or value.startswith(scope):
            return True
        if scope.endswith(value) and "/" in scope:
            return True
    return False


def _blank(text: str | None) -> bool:
    return (text or "").strip().lower() in _EMPTY


def findings_block_delegation(text: str | None) -> bool:
    return bool(_FINDING_BLOCK.search(text or ""))


def scope_deviation(state: dict[str, Any]) -> bool:
    from agentbus.publish import parse_claimed_paths
    from agentbus.scope import scope_of, validate_files_against_scope

    report = ((state.get("envelopes") or {}).get("CODEX_REPORT") or {}).get("fields") or {}
    if not isinstance(report, dict):
        return False
    changed = parse_claimed_paths(report.get("CHANGED_FILES"), ".")
    if not changed:
        return False
    scope = scope_of(state)
    if not scope:
        return False
    return not validate_files_against_scope(changed, scope).get("ok")


def repair_expanded_authority(state: dict[str, Any]) -> bool:
    """True when a repair left the originally authorized scope/architecture."""
    cycles = int(state.get("repair_cycles") or 0)
    if cycles <= 0:
        return False
    report = ((state.get("envelopes") or {}).get("CODEX_REPORT") or {}).get("fields") or {}
    if not isinstance(report, dict):
        return False
    deviations = report.get("DEVIATIONS") or ""
    if not _blank(deviations):
        return True
    if scope_deviation(state):
        return True
    architecture = (report.get("ARCHITECTURE") or report.get("ARCHITECTURAL_CHANGES") or "").strip()
    if architecture and not _blank(architecture):
        return True
    return False


@dataclass
class DelegationDecision:
    ok: bool
    reason: str
    policy: str
    review_authority: str | None = None


def evaluate_delegation(state: dict[str, Any], audit_fields: dict[str, str] | None = None) -> DelegationDecision:
    policy = review_policy_of(state)
    if policy != AUDIT_SUFFICIENT:
        return DelegationDecision(False, f"review policy is {policy}", policy)
    if repair_expanded_authority(state):
        return DelegationDecision(False, "repair expanded scope or architecture; GPT review required", policy)

    heads = state.get("heads") or {}
    implemented = heads.get("implemented")
    audited = heads.get("audited")
    current = heads.get("current")
    if not implemented or not audited:
        return DelegationDecision(False, "missing IMPLEMENTED_HEAD or AUDITED_HEAD", policy)
    if implemented != audited:
        return DelegationDecision(False, "AUDITED_HEAD != IMPLEMENTED_HEAD", policy)
    if current and current != implemented:
        return DelegationDecision(False, "PR/worktree HEAD drifted from IMPLEMENTED_HEAD", policy)

    audit = audit_fields
    if audit is None:
        rec = (state.get("envelopes") or {}).get("CODEX_AUDIT") or {}
        audit = rec.get("fields") if isinstance(rec.get("fields"), dict) else {}
    status = str((audit or {}).get("STATUS") or (state.get("status") or {}).get("audit") or "").upper()
    if status not in {"PASS", "PASSED", "OK"}:
        return DelegationDecision(False, f"audit status is {status or 'missing'}", policy)
    findings = (audit or {}).get("FINDINGS") or ""
    if findings_block_delegation(findings):
        return DelegationDecision(False, "HIGH/MEDIUM audit finding blocks delegated review", policy)
    if scope_deviation(state):
        return DelegationDecision(False, "changed paths are outside authorized scope", policy)

    report = ((state.get("envelopes") or {}).get("CODEX_REPORT") or {}).get("fields") or {}
    if isinstance(report, dict) and not _blank(report.get("DEVIATIONS")):
        return DelegationDecision(False, "unexplained implementation deviations", policy)

    pub = state.get("publication") or {}
    if pub.get("commit") and pub.get("commit") != implemented:
        return DelegationDecision(False, "owned publication SHA != IMPLEMENTED_HEAD", policy)

    return DelegationDecision(True, "independent audit PASS satisfies delegated review", policy, DELEGATED_AUTHORITY)


def record_delegated_review(store: Any, state: dict[str, Any], decision: DelegationDecision) -> dict[str, Any]:
    heads = state.get("heads") or {}
    record = {
        "kind": "GPT_REVIEW_DELEGATED",
        "status": "DELEGATED",
        "review_authority": decision.review_authority or DELEGATED_AUTHORITY,
        "policy": decision.policy,
        "head": heads.get("implemented"),
        "reason": decision.reason,
        "created_at": utc_now(),
    }
    history = state.setdefault("delegated_reviews", [])
    history.append(record)
    state["review_authority"] = record["review_authority"]
    state["status"]["gpt"] = "DELEGATED"
    state["status"]["latest_authority"] = f"GPT_REVIEW_DELEGATED:{record['review_authority']}"
    store.append_event(
        "gpt-review-delegated",
        {
            "head": record["head"],
            "policy": decision.policy,
            "review_authority": record["review_authority"],
        },
    )
    return record
