from __future__ import annotations

from typing import Any

from agentbus import machine
from agentbus.fencing import fence_exact, fence_spec
from agentbus.gitutil import is_dirty
from agentbus.paths import AgentbusError
from agentbus.authority import refresh_authority
from agentbus.protocol import Envelope, render_envelope, validate_envelope
from agentbus.store import StreamStore
from agentbus.util import utc_now


def refresh_next(state: dict[str, Any]) -> dict[str, Any]:
    from agentbus.decision import derive_next_action

    status = state.setdefault("status", {})
    campaign = state.get("campaign") if isinstance(state.get("campaign"), dict) else None
    live = (state.get("github") or {}).get("pr")
    decision = derive_next_action(state, campaign, live if isinstance(live, dict) else None)
    status["next_action"] = decision.action
    status["decision"] = decision.as_dict()
    if decision.action in {"PRODUCT_GPT", "FINAL_GPT"}:
        status["gpt"] = "WAITING"
    refresh_authority(state)
    return state


def set_phase(state: dict[str, Any], dest: str, *, reason: str) -> dict[str, Any]:
    src = state["phase"]
    if dest != src:
        if dest in machine.EXCEPTIONAL and src not in machine.EXCEPTIONAL:
            state["prior_phase"] = src
        state["phase"] = machine.transition(src, dest, reason=reason)
    refresh_next(state)
    return state


def record_envelope(store: StreamStore, state: dict[str, Any], envelope: Envelope) -> dict[str, Any]:
    errors = validate_envelope(
        envelope,
        expected_stream=state["stream_id"],
        aliases=state.get("aliases") or [],
    )
    if errors:
        raise AgentbusError("invalid envelope: " + "; ".join(errors))
    if envelope.kind == "GPT_SPEC" and envelope.status in {"ACTIONABLE", "APPROVED"}:
        # Capture the prior spec epoch before replacing the compatibility
        # envelope.  This is what makes a Product GPT replan a new bounded
        # epoch while a duplicate comment remains idempotent.
        from agentbus.repair import prepare_replan_for_new_spec

        prepare_replan_for_new_spec(state)
    rendered = render_envelope(envelope)
    envelope.raw = rendered
    path = store.write_artifact(f"{envelope.kind.lower()}.md", rendered)
    record = envelope.as_record()
    record["artifact"] = path
    state.setdefault("envelopes", {})[envelope.kind] = record
    state["status"]["latest_authority"] = authority_label(state)
    store.append_event(
        "envelope",
        {
            "envelope": envelope.kind,
            "status": envelope.status,
            "head": envelope.head,
            "source": envelope.source,
            "digest": envelope.digest[:12],
        },
    )
    return state


def authority_label(state: dict[str, Any]) -> str:
    notes = state.get("envelopes", {})
    for kind in (
        "HUMAN_NOTE",
        "FINAL_GATE",
        "GPT_MERGE_REVIEW",
        "GPT_REVIEW",
        "GPT_SPEC",
        "CODEX_AUDIT",
        "CODEX_REPORT",
    ):
        rec = notes.get(kind)
        if rec:
            return f"{kind}:{rec.get('status') or '-'}"
    return "-"


def apply_envelope(
    store: StreamStore,
    state: dict[str, Any],
    envelope: Envelope,
    *,
    repo: str,
    current_head: str | None,
    allow_stale: bool = False,
) -> dict[str, Any]:
    if envelope.stream:
        from agentbus.streamid import classify_envelope_stream

        relation = classify_envelope_stream(envelope.stream, state, envelope=envelope)
        if envelope.kind == "GPT_CONTINUATION":
            allowed = {
                (state.get("stream_id") or "").lower(),
                (envelope.get("AFTER_STREAM") or "").strip().lower(),
                (envelope.get("NEXT_STREAM") or "").strip().lower(),
                (envelope.get("CAMPAIGN") or "").strip().lower(),
            }
            if envelope.stream not in allowed and relation == "foreign":
                raise AgentbusError(f"foreign stream {envelope.stream}")
        else:
            if relation == "foreign":
                raise AgentbusError(f"foreign stream {envelope.stream}")
            if relation == "unknown":
                raise AgentbusError(
                    f"envelope stream {envelope.stream} does not match {state['stream_id']}"
                )
    # Top-level review submissions are durable browser jobs.  A continuation
    # review without its exact generation token is historical evidence only;
    # legacy local/issue-comment fixtures may still omit JOB_ID for backward
    # compatibility and are handled by the existing path below.
    if envelope.kind == "GPT_CONTINUATION" and envelope.surface == "review_submission" and not envelope.get("JOB_ID"):
        state.setdefault("stale_product_jobs", []).append(
            {
                "kind": envelope.kind,
                "job_id": "",
                "expected_job_id": "",
                "source_id": envelope.source_id,
                "source_key": envelope.source_key,
                "reason": "review submission continuation is missing JOB_ID",
                "ts": utc_now(),
            }
        )
        store.append_event(
            "stale-product-job-ignored",
            {"kind": envelope.kind, "job_id": "", "source": envelope.source, "source_key": envelope.source_key},
        )
        return refresh_next(state)
    if envelope.kind in {"GPT_SPEC", "GPT_REVIEW", "GPT_CONTINUATION"} and envelope.get("JOB_ID"):
        from agentbus.campaign import infer_campaign_id, load_campaign
        from agentbus.decision import (
            PLAN_CONTINUATION,
            PLAN_SPEC,
            PRODUCT_GPT,
            PRODUCT_REVIEW,
            browser_job_id,
        )

        task = {
            "GPT_SPEC": PLAN_SPEC,
            "GPT_REVIEW": PRODUCT_REVIEW,
            "GPT_CONTINUATION": PLAN_CONTINUATION,
        }[envelope.kind]
        campaign = load_campaign(store.ctx, infer_campaign_id(state, envelope))
        live = (state.get("github") or {}).get("pr")
        expected_job = browser_job_id(
            state,
            campaign,
            live if isinstance(live, dict) else None,
            role=PRODUCT_GPT,
            task=task,
        )
        if envelope.get("JOB_ID").strip() != expected_job:
            state.setdefault("stale_product_jobs", []).append(
                {
                    "kind": envelope.kind,
                    "job_id": envelope.get("JOB_ID"),
                    "expected_job_id": expected_job,
                    "source_id": envelope.source_id,
                    "source_key": envelope.source_key,
                    "ts": utc_now(),
                }
            )
            store.append_event(
                "stale-product-job-ignored",
                {"kind": envelope.kind, "job_id": envelope.get("JOB_ID"), "source": envelope.source},
            )
            return refresh_next(state)
    if envelope.kind == "GPT_CONTINUATION":
        from agentbus.campaign import apply_continuation

        return apply_continuation(store, state, envelope)

    if state.get("phase") == machine.MERGED and envelope.kind != "GPT_CONTINUATION":
        store.append_event(
            "merged-unit-envelope-ignored",
            {"envelope": envelope.kind, "source": envelope.source, "source_id": envelope.source_id},
        )
        return refresh_next(state)

    if envelope.kind == "CODEX_AUDIT":
        from agentbus.generation import note_stale_audit, should_ignore_stale_audit

        if should_ignore_stale_audit(state, envelope.head):
            note_stale_audit(state, envelope)
            store.append_event(
                "stale-audit-ignored",
                {"head": envelope.head, "status": envelope.status, "source": envelope.source},
            )
            return refresh_next(state)
    if envelope.kind == "GPT_MERGE_REVIEW":
        from agentbus.mergegate import apply_merge_review, sha_equal, unit_head

        reviewed = (envelope.fields.get("REVIEWED_HEAD") or envelope.head or "").strip()
        current = unit_head(state)
        if reviewed and current and not sha_equal(reviewed, current):
            apply_merge_review(state, envelope)
            store.append_event(
                "stale-merge-review-ignored",
                {"head": reviewed, "status": envelope.status, "source": envelope.source},
            )
            return refresh_next(state)
        expected_pr = str(state.get("pr") or "")
        reviewed_pr = str(envelope.fields.get("PR") or "").strip().lstrip("#")
        live = (state.get("github") or {}).get("pr") or {}
        current_base = str(live.get("baseRefOid") or "").strip()
        reviewed_base = str(envelope.fields.get("REVIEWED_BASE") or "").strip()
        stale_reason = None
        if expected_pr and reviewed_pr != expected_pr:
            stale_reason = "PR mismatch"
        elif current_base and not sha_equal(reviewed_base, current_base):
            stale_reason = "base mismatch"
        job_id = str(envelope.fields.get("JOB_ID") or "").strip()
        if not stale_reason and job_id:
            from agentbus.campaign import infer_campaign_id, load_campaign
            from agentbus.decision import FINAL_GPT, FINAL_REVIEW, browser_job_id

            campaign = load_campaign(store.ctx, infer_campaign_id(state))
            expected_job = browser_job_id(
                state,
                campaign,
                live,
                role=FINAL_GPT,
                task=FINAL_REVIEW,
            )
            if job_id != expected_job:
                stale_reason = "review generation mismatch"
        if stale_reason:
            state.setdefault("stale_merge_reviews", []).append(
                {
                    "head": reviewed,
                    "status": envelope.status,
                    "source_id": envelope.source_id,
                    "reason": stale_reason,
                    "ts": utc_now(),
                }
            )
            store.append_event(
                "stale-merge-review-ignored",
                {
                    "head": reviewed,
                    "status": envelope.status,
                    "source": envelope.source,
                    "reason": stale_reason,
                },
            )
            return refresh_next(state)
        if envelope.source != "github" or not str(envelope.source_id or "").strip():
            # A copied prompt or a local inbox note is not independent Merge
            # GPT authority. Preserve only bounded history/event diagnostics;
            # do not overwrite a valid GitHub review or enable a merge.
            apply_merge_review(state, envelope)
            store.append_event(
                "non_durable-merge-review-ignored",
                {"head": reviewed, "status": envelope.status, "source": envelope.source},
            )
            return refresh_next(state)
    record_envelope(store, state, envelope)
    heads = state.setdefault("heads", {})
    if current_head:
        heads["current"] = current_head
    kind = envelope.kind
    status = envelope.status
    control = state.get("control") or "running"

    if kind == "HUMAN_NOTE":
        _apply_human_note(state, envelope)
        return refresh_next(state)

    if kind == "BLOCKER":
        heads["last_seen"] = current_head
        state["status"]["blocker"] = envelope.get("REASON") or "blocked"
        state["status"]["impl"] = "BLOCKED"
        set_phase(state, machine.BLOCKED, reason="blocker envelope")
        return state

    if kind == "GPT_SPEC":
        return _apply_spec(state, envelope, repo, current_head, allow_stale=allow_stale, control=control)

    if kind == "GPT_REVIEW":
        return _apply_review(state, envelope, current_head, allow_stale=allow_stale)

    if kind == "GPT_MERGE_REVIEW":
        from agentbus.mergegate import apply_merge_review

        return apply_merge_review(state, envelope)

    if kind == "CODEX_REPORT":
        return _apply_report(state, envelope, current_head, allow_stale=allow_stale, repo=repo)

    if kind == "CODEX_AUDIT":
        return _apply_audit(state, envelope, current_head, allow_stale=allow_stale, store=store)

    if kind == "FINAL_GATE":
        return _apply_final_gate(state, envelope, current_head, allow_stale=allow_stale)

    return refresh_next(state)


def _apply_spec(
    state: dict[str, Any],
    envelope: Envelope,
    repo: str,
    current_head: str | None,
    *,
    allow_stale: bool,
    control: str,
) -> dict[str, Any]:
    base = envelope.head
    state["heads"]["spec_base"] = base
    if envelope.get("REVIEW_POLICY"):
        from agentbus.reviewpolicy import normalize_review_policy

        state["review_policy"] = normalize_review_policy(envelope.get("REVIEW_POLICY"))
    if envelope.get("CAMPAIGN"):
        state["campaign_id"] = envelope.get("CAMPAIGN").strip().lower()
    if envelope.get("GOAL") and not state.get("goal"):
        state["goal"] = envelope.get("GOAL")
    if envelope.status not in {"ACTIONABLE", "APPROVED"}:
        state["status"]["gpt"] = envelope.status or "DRAFT"
        return refresh_next(state)
    fence = fence_spec(repo, base, current_head)
    if not fence.ok and not allow_stale:
        state["status"]["blocker"] = fence.reason
        state["status"]["gpt"] = "STALE"
        set_phase(state, machine.RE_REVIEW_REQUIRED, reason=fence.reason)
        return state
    state["status"]["gpt"] = "READY"
    state["status"]["blocker"] = None
    from agentbus.repair import start_spec_epoch

    start_spec_epoch(state, state.get("envelopes", {}).get("GPT_SPEC") or {})
    if control == "paused":
        return refresh_next(state)
    if state["phase"] in {machine.MATERIALIZING, machine.WORKTREE_READY, machine.BOOTSTRAP_PR_READY}:
        return refresh_next(state)
    if state["phase"] in {
        machine.WAITING_FOR_SPEC,
        machine.RE_REVIEW_REQUIRED,
        machine.BLOCKED,
        machine.BLOCKED_FOR_REVIEW,
        machine.READY_FOR_GPT,
        machine.GPT_REVIEW,
    }:
        set_phase(state, machine.IMPLEMENTING, reason="actionable GPT_SPEC")
        state["status"]["impl"] = "WAITING"
    elif state["phase"] == machine.IMPLEMENTING:
        state["status"]["impl"] = "WAITING"
    return refresh_next(state)


def _apply_review(
    state: dict[str, Any],
    envelope: Envelope,
    current_head: str | None,
    *,
    allow_stale: bool,
) -> dict[str, Any]:
    reviewed = envelope.head
    state["heads"]["reviewed"] = reviewed
    if envelope.status in {"ACCEPT", "ACCEPTED", "APPROVE", "APPROVED"}:
        fence = fence_exact(reviewed, current_head, label="REVIEWED_HEAD")
        if not fence.ok and not allow_stale:
            state["status"]["blocker"] = fence.reason
            set_phase(state, machine.RE_REVIEW_REQUIRED, reason=fence.reason)
            return state
        state["status"]["gpt"] = "ACCEPT"
        state["status"]["blocker"] = None
        if state["phase"] in {machine.READY_FOR_GPT, machine.GPT_REVIEW, machine.RE_REVIEW_REQUIRED}:
            if state["phase"] == machine.READY_FOR_GPT:
                set_phase(state, machine.GPT_REVIEW, reason="GPT_REVIEW arrived")
            set_phase(state, machine.FINAL_GATE, reason="GPT accepted")
        return refresh_next(state)
    if envelope.status in {"CHANGES_REQUIRED", "REJECT", "REJECTED"}:
        state["status"]["gpt"] = "CHANGES_REQUIRED"
        state["status"]["impl"] = "WAITING"
        if state["phase"] == machine.READY_FOR_GPT:
            set_phase(state, machine.GPT_REVIEW, reason="GPT requested changes")
        set_phase(state, machine.IMPLEMENTING, reason="GPT_REVIEW changes required")
        return refresh_next(state)
    if state["phase"] == machine.READY_FOR_GPT:
        set_phase(state, machine.GPT_REVIEW, reason="GPT_REVIEW comment")
    state["status"]["gpt"] = envelope.status or "REVIEWING"
    return refresh_next(state)


def _apply_report(
    state: dict[str, Any],
    envelope: Envelope,
    current_head: str | None,
    *,
    allow_stale: bool,
    repo: str | None = None,
) -> dict[str, Any]:
    implemented = envelope.head
    from agentbus.transport import is_bootstrap_commit

    if implemented and is_bootstrap_commit(state, implemented):
        state["status"]["impl"] = "FAIL"
        state["status"]["blocker"] = "bootstrap commit is not IMPLEMENTED_HEAD"
        return refresh_next(state)
    if envelope.status in {"BLOCKED", "FAILED"}:
        state["heads"]["implemented"] = implemented
        state["heads"]["last_seen"] = implemented or current_head
        state["status"]["impl"] = "FAIL"
        state["status"]["blocker"] = envelope.get("DEVIATIONS") or envelope.status
        set_phase(state, machine.BLOCKED, reason="CODEX_REPORT blocked")
        return state
    ready = envelope.status in {"READY_FOR_AUDIT", "PASS", "PASSED"}
    if ready and repo and is_dirty(repo):
        from agentbus.publish import mark_publication_failed

        mark_publication_failed(
            state,
            "CODEX_REPORT claimed READY_FOR_AUDIT but the worktree is uncommitted",
        )
        return state
    from agentbus.generation import is_prior_generation_head, report_is_owned

    if ready and implemented and not report_is_owned(state, implemented) and not allow_stale:
        state["status"]["impl"] = "FAIL"
        state["status"]["blocker"] = (
            f"CODEX_REPORT {implemented[:12]} is not an AgentBus-owned publication"
        )
        set_phase(state, machine.RE_REVIEW_REQUIRED, reason="untrusted implementation SHA")
        return state
    fence = fence_exact(implemented, current_head or implemented, label="IMPLEMENTED_HEAD")
    if current_head and not fence.ok and not allow_stale:
        state["status"]["impl"] = "FAIL"
        state["status"]["blocker"] = fence.reason
        set_phase(state, machine.RECOVERY_REQUIRED, reason=fence.reason)
        return state
    if ready and current_head and implemented != current_head:
        from agentbus.publish import mark_publication_failed

        mark_publication_failed(
            state,
            "IMPLEMENTED_HEAD does not match worktree HEAD; refusing READY_FOR_AUDIT",
        )
        return state
    heads = state.setdefault("heads", {})
    previous_audited = heads.get("audited")
    if previous_audited and implemented and previous_audited != implemented:
        if is_prior_generation_head(state, previous_audited) or report_is_owned(state, implemented):
            heads["prior_audited"] = previous_audited
            heads["audited"] = None
    heads["implemented"] = implemented
    heads["last_seen"] = implemented or current_head
    pub = state.setdefault("publication", {})
    if not pub.get("commit"):
        pub["commit"] = implemented
        pub["status"] = pub.get("status") or "committed"
    state["status"]["impl"] = "PASS"
    state["status"]["audit"] = "WAITING"
    state["spec_epoch_pending_implementation"] = False
    if state["phase"] in {
        machine.IMPLEMENTING,
        machine.VALIDATING,
        machine.RECOVERY_REQUIRED,
        machine.BLOCKED_FOR_REVIEW,
        machine.RE_REVIEW_REQUIRED,
        machine.AUDITING,
    }:
        if state["phase"] == machine.IMPLEMENTING:
            set_phase(state, machine.VALIDATING, reason="CODEX_REPORT received")
        if state["phase"] != machine.READY_FOR_AUDIT:
            set_phase(state, machine.READY_FOR_AUDIT, reason="published implementation")
    return refresh_next(state)


def _apply_audit(
    state: dict[str, Any],
    envelope: Envelope,
    current_head: str | None,
    *,
    allow_stale: bool,
    store: StreamStore | None = None,
) -> dict[str, Any]:
    audited = envelope.head
    implemented = state.get("heads", {}).get("implemented")
    if implemented and audited and audited != implemented:
        from agentbus.generation import is_owned_head, is_prior_generation_head

        if is_owned_head(state, implemented) and is_prior_generation_head(state, audited):
            state.setdefault("heads", {})["prior_audited"] = audited
            return refresh_next(state)
    state["heads"]["audited"] = audited
    head_for_check = current_head or implemented
    fence = fence_exact(audited, head_for_check, label="AUDITED_HEAD")
    if implemented and audited and audited != implemented:
        fence = fence_exact(audited, implemented, label="AUDITED_HEAD vs IMPLEMENTED_HEAD")
    if not fence.ok and not allow_stale:
        state["status"]["audit"] = "FAIL"
        state["status"]["blocker"] = fence.reason
        set_phase(state, machine.RE_REVIEW_REQUIRED, reason=fence.reason)
        return state
    if envelope.status in {"PASS", "PASSED", "OK"}:
        state["status"]["audit"] = "PASS"
        state["status"]["gpt"] = "WAITING"
        state["status"]["blocker"] = None
        if state["phase"] == machine.READY_FOR_AUDIT:
            set_phase(state, machine.AUDITING, reason="audit result")
        from agentbus.reviewpolicy import evaluate_delegation, record_delegated_review

        decision = evaluate_delegation(state, envelope.fields)
        if decision.ok and store is not None:
            record_delegated_review(store, state, decision)
            set_phase(state, machine.FINAL_GATE, reason="AUDIT_SUFFICIENT delegated review")
            return refresh_next(state)
        set_phase(state, machine.READY_FOR_GPT, reason="audit PASS")
        return refresh_next(state)
    if envelope.status in {"CHANGES_REQUIRED", "FAIL", "FAILED"}:
        state["status"]["audit"] = "CHANGES_REQUIRED"
        findings = envelope.get("FINDINGS") or "audit requested changes"
        state["status"]["blocker"] = findings.splitlines()[0][:160]
        if state["phase"] == machine.READY_FOR_AUDIT:
            set_phase(state, machine.AUDITING, reason="audit result")
        from agentbus.publish import consume_product_repair

        if consume_product_repair(state, audited):
            max_cycles = int(state.get("max_repair_cycles") or 2)
            cycles = int(state.get("repair_cycles") or 0)
            if cycles >= max_cycles:
                set_phase(state, machine.BLOCKED_FOR_REVIEW, reason="repair cycle limit")
                state["status"]["impl"] = "PAUSED"
                return refresh_next(state)
            state["repair_cycles"] = cycles + 1
            from agentbus.repair import note_repair_attempt

            note_repair_attempt(
                state,
                kind="CODEX_AUDIT",
                authority=envelope.source_id or envelope.digest,
                head=audited,
                cycle=state["repair_cycles"],
            )
            state.setdefault("publication", {})["last_product_audit_head"] = audited
        state["status"]["impl"] = "WAITING"
        set_phase(state, machine.IMPLEMENTING, reason="audit CHANGES_REQUIRED")
        return refresh_next(state)
    state["status"]["audit"] = envelope.status or "DONE"
    return refresh_next(state)


def _apply_final_gate(
    state: dict[str, Any],
    envelope: Envelope,
    current_head: str | None,
    *,
    allow_stale: bool,
) -> dict[str, Any]:
    if state["phase"] == machine.MERGED:
        return refresh_next(state)
    if envelope.status in {"APPROVED", "ACCEPT", "ACCEPTED", "PASS", "PASSED", "OK"}:
        label = "FINAL_HEAD" if envelope.fields.get("FINAL_HEAD") else "REVIEWED_HEAD"
        fence = fence_exact(envelope.head, current_head or envelope.head, label=label)
        if current_head and not fence.ok and not allow_stale:
            state["status"]["blocker"] = fence.reason
            set_phase(state, machine.RE_REVIEW_REQUIRED, reason=fence.reason)
            return state
        state["status"]["gpt"] = "ACCEPT"
        if state["phase"] == machine.READY_FOR_GPT:
            set_phase(state, machine.GPT_REVIEW, reason="final gate")
        if state["phase"] != machine.FINAL_GATE:
            set_phase(state, machine.FINAL_GATE, reason="FINAL_GATE approved")
        return refresh_next(state)
    if envelope.status in {"REJECTED", "CHANGES_REQUIRED"}:
        set_phase(state, machine.IMPLEMENTING, reason="FINAL_GATE rejected")
        return refresh_next(state)
    return refresh_next(state)


def _apply_human_note(state: dict[str, Any], envelope: Envelope) -> None:
    command = (envelope.get("COMMAND") or "").strip().upper()
    status = envelope.status
    if status == "OVERRIDE" or command in {"FORCE_IMPL", "IMPLEMENT"}:
        state["status"]["blocker"] = None
        state["control"] = "running"
        set_phase(state, machine.IMPLEMENTING, reason="human override")
        state["status"]["impl"] = "WAITING"
    elif command == "FORCE_AUDIT":
        state["control"] = "running"
        set_phase(state, machine.READY_FOR_AUDIT, reason="human override")
    elif command == "ACKNOWLEDGE":
        state["status"]["blocker"] = None
    elif command == "PAUSE":
        state["control"] = "paused"
    elif command == "RESUME":
        state["control"] = "running"
    if envelope.get("REASON"):
        state["status"]["latest_authority"] = f"HUMAN_NOTE:{status or command or 'INFO'}"


def mark_pr_merged(
    state: dict[str, Any],
    store: StreamStore | None = None,
    *,
    merge_sha: str | None = None,
) -> dict[str, Any]:
    if state["phase"] != machine.MERGED:
        if state["phase"] != machine.FINAL_GATE:
            if machine.can_transition(state["phase"], machine.FINAL_GATE):
                set_phase(state, machine.FINAL_GATE, reason="PR merged")
        if machine.can_transition(state["phase"], machine.MERGED):
            set_phase(state, machine.MERGED, reason="PR merged")
        else:
            state["prior_phase"] = state["phase"]
            state["phase"] = machine.MERGED
    if merge_sha:
        state.setdefault("heads", {})["merged"] = merge_sha
    elif not (state.get("heads") or {}).get("merged"):
        state.setdefault("heads", {})["merged"] = (state.get("heads") or {}).get("current")
    txn = state.get("merge_txn")
    if isinstance(txn, dict) and (txn.get("human_authorized") or txn.get("autonomous_authorized")):
        # GitHub's merged state is authoritative after a crash anywhere in
        # the local transaction.  Preserve the exact commit when available.
        txn["status"] = "merged"
        txn["merge_commit"] = state.get("heads", {}).get("merged")
        txn["merged_at"] = utc_now()
    # This function is called only at the durable merge edge (or by explicit
    # compatibility callers that already assert that edge).  Keep a local
    # fencing marker so a stale cached OPEN projection from an earlier poll
    # cannot undo that exact completion event.
    state["merge_confirmed_at"] = state.get("merge_confirmed_at") or utc_now()
    if store is not None:
        from agentbus.campaign import after_unit_merged

        # Campaign projection discovers stream state from disk.  Persist the
        # terminal phase before it projects or materializes a continuation so
        # it cannot mistake this just-merged unit for an active FINAL_GATE.
        # This also makes the remote-MERGED result crash recoverable before
        # successor work begins.
        store.save(state)
        after_unit_merged(store, state, merge_sha=state.get("heads", {}).get("merged"))
    return refresh_next(state)


def touch_seen_comment(state: dict[str, Any], comment_id: str) -> None:
    seen = state.setdefault("seen_comment_ids", [])
    if comment_id not in seen:
        seen.append(comment_id)
        if len(seen) > 400:
            del seen[:-400]


def ingest_text(
    store: StreamStore,
    state: dict[str, Any],
    text: str,
    *,
    repo: str,
    current_head: str | None,
    source: str,
    source_id: str = "",
    allow_stale: bool = False,
    surface: str = "",
    source_key: str = "",
    created_at: str = "",
    updated_at: str = "",
    author: str = "",
    url: str = "",
) -> list[Envelope]:
    from agentbus.protocol import parse_envelopes

    applied: list[Envelope] = []
    for envelope in parse_envelopes(text):
        envelope.source = source
        envelope.source_id = source_id
        envelope.surface = surface
        envelope.source_key = source_key
        envelope.updated_at = updated_at
        envelope.author = author
        envelope.url = url
        # Parsed envelopes have a local default timestamp.  A durable GitHub
        # source timestamp is authoritative when one was supplied.
        envelope.created_at = created_at or envelope.created_at or utc_now()
        apply_envelope(
            store,
            state,
            envelope,
            repo=repo,
            current_head=current_head,
            allow_stale=allow_stale,
        )
        applied.append(envelope)
    return applied
