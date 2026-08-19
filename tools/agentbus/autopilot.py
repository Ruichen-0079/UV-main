"""One-step campaign autopilot piggybacking on WebUI / role watcher ticks."""

from __future__ import annotations

import os
from typing import Any

from agentbus import machine
from agentbus.apply import apply_envelope, refresh_next, set_phase
from agentbus.attention import OWNER_BROWSER_GPT, OWNER_HUMAN, campaign_attention, classify_attention
from agentbus.authority import refresh_authority
from agentbus.campaign import (
    AUTOPILOT,
    EXPLICIT_STREAM_CAMPAIGNS,
    STATUS_WAITING_FOR_PLAN,
    apply_known_obsolete,
    authority_source_needs_rescan,
    bind_explicit_campaign,
    campaign_lock,
    infer_campaign_id,
    is_obsolete,
    load_campaign,
    maybe_materialize_successor,
)
from agentbus.config import migrate_role_config
from agentbus.gitutil import is_dirty
from agentbus.lock import StreamLock
from agentbus.paths import RepoContext
from agentbus.protocol import Envelope
from agentbus.reviewpolicy import AUDIT_SUFFICIENT, evaluate_delegation, record_delegated_review, review_policy_of
from agentbus.store import StreamStore, iter_stores
from agentbus.util import utc_now


def _tick_lock(ctx: RepoContext) -> StreamLock:
    from agentbus.campaign import campaigns_dir

    os.makedirs(campaigns_dir(ctx), exist_ok=True)
    return StreamLock(os.path.join(campaigns_dir(ctx), "tick.lock"))


def gpt_gate_generation(state: dict[str, Any], campaign: dict[str, Any] | None = None) -> str:
    """Compatibility name for the canonical Browser job generation."""
    from agentbus.decision import derive_next_action, review_generation

    live = (state.get("github") or {}).get("pr")
    decision = derive_next_action(state, campaign, live if isinstance(live, dict) else None)
    if not decision.task:
        return ""
    return review_generation(
        state,
        campaign,
        live if isinstance(live, dict) else None,
        role=decision.action,
        task=decision.task,
    )


def maybe_gpt_handoff(
    store: StreamStore,
    state: dict[str, Any],
    *,
    campaign: dict[str, Any] | None = None,
    env: dict[str, str] | None = None,
    surface: str = "cli",
) -> dict[str, Any] | None:
    del env, surface
    from agentbus.browser import job_for_state

    job = job_for_state(store.ctx, state, campaign=campaign)
    if job is None:
        return None
    generation = job.generation
    gate = state.setdefault("gpt_gate", {})
    if gate.get("job_id") == job.job_id:
        return {
            "generation": generation,
            "job_id": job.job_id,
            "role": job.role,
            "task": job.task,
            "url": job.conversation_url,
            "open_once": False,
            "already": True,
        }
    gate["generation"] = generation
    gate["job_id"] = job.job_id
    gate["role"] = job.role
    gate["task"] = job.task
    gate["notified"] = True
    gate["notified_at"] = utc_now()
    gate["url"] = job.conversation_url
    store.append_event(
        "browser-job",
        {"generation": generation, "job_id": job.job_id, "role": job.role, "task": job.task},
    )
    return {
        "generation": generation,
        "job_id": job.job_id,
        "role": job.role,
        "task": job.task,
        "url": job.conversation_url,
        "open_once": False,
        "already": False,
    }


def _notify_gpt(stream_id: str, phase: str, campaign: dict[str, Any] | None) -> None:
    if os.environ.get("YUVI_AGENTBUS_NOTIFY") == "0":
        return
    from agentbus.notify import notify_custom

    if campaign and campaign.get("status") == STATUS_WAITING_FOR_PLAN:
        body = f"{stream_id} campaign {campaign.get('campaign_id')} waiting for GPT plan"
    else:
        body = f"{stream_id} waiting for Browser GPT ({phase})"
    notify_custom(stream_id, "needs GPT", body)


def migrate_roles(state: dict[str, Any], env: dict[str, str] | None = None) -> None:
    for role in ("impl", "audit"):
        cfg = (state.get("roles") or {}).get(role)
        if isinstance(cfg, dict):
            migrate_role_config(cfg, env)


def reconcile_durable(
    store: StreamStore,
    state: dict[str, Any],
    *,
    repo: str,
    env: dict[str, str] | None = None,
) -> list[str]:
    """Project compatibility phases from the one canonical durable decision."""
    from agentbus.decision import AUDIT, FINAL_GPT, IMPL, PRODUCT_GPT, derive_next_action

    notes: list[str] = []
    migrate_roles(state)
    apply_known_obsolete(state)
    if is_obsolete(state):
        refresh_authority(state)
        refresh_next(state)
        return ["obsolete candidate; not resumed"]

    phase = state.get("phase") or ""
    if phase == machine.RECOVERY_REQUIRED:
        blocker = str((state.get("status") or {}).get("blocker") or "")
        prior = state.get("prior_phase")
        dirty = bool(repo and is_dirty(repo))
        if not dirty and prior and "process died" in blocker and "untrusted" not in blocker.lower():
            set_phase(state, prior, reason="stale runner recovered")
            state["status"]["blocker"] = None
            notes.append(f"cleared stale crash recovery → {prior}")

    from agentbus.generation import recover_lost_publication

    recovered = recover_lost_publication(store, state, worktree=repo, env=env)
    if recovered.get("ok"):
        notes.append(
            f"recovered AgentBus publication {str(recovered.get('commit') or '')[:12]} "
            f"from exact durable CODEX_REPORT {recovered.get('report_comment_id')}"
        )

    campaign = load_campaign(store.ctx, infer_campaign_id(state))
    live = (state.get("github") or {}).get("pr")
    decision = derive_next_action(
        state,
        campaign,
        live if isinstance(live, dict) else None,
    )

    # Compatibility phases remain useful diagnostics. They follow, rather
    # than decide, the canonical action.
    phase = state.get("phase") or ""
    if decision.action == IMPL and phase != machine.IMPLEMENTING and machine.can_transition(phase, machine.IMPLEMENTING):
        set_phase(state, machine.IMPLEMENTING, reason=f"canonical decision: {decision.reason}")
        notes.append("compatibility phase projected to IMPLEMENTING")
    elif decision.action == AUDIT:
        if phase == machine.IMPLEMENTING and machine.can_transition(phase, machine.VALIDATING):
            set_phase(state, machine.VALIDATING, reason="canonical durable report")
            phase = state.get("phase") or ""
        if phase == machine.VALIDATING and machine.can_transition(phase, machine.READY_FOR_AUDIT):
            set_phase(state, machine.READY_FOR_AUDIT, reason="canonical audit action")
            notes.append("compatibility phase projected to READY_FOR_AUDIT")
    elif decision.action == PRODUCT_GPT and decision.task == "PRODUCT_REVIEW":
        if phase in {machine.READY_FOR_AUDIT, machine.AUDITING} and machine.can_transition(phase, machine.READY_FOR_GPT):
            set_phase(state, machine.READY_FOR_GPT, reason="canonical product review action")
            notes.append("compatibility phase projected to READY_FOR_GPT")
    elif decision.action == FINAL_GPT and phase != machine.FINAL_GATE:
        if review_policy_of(state) == AUDIT_SUFFICIENT:
            delegated = evaluate_delegation(state)
            if delegated.ok:
                record_delegated_review(store, state, delegated)
        if machine.can_transition(phase, machine.FINAL_GATE):
            set_phase(state, machine.FINAL_GATE, reason="canonical final review action")
            notes.append("compatibility phase projected to FINAL_GATE")

    state.setdefault("status", {})["decision"] = decision.as_dict()
    refresh_authority(state)
    refresh_next(state)
    return notes


def _executor_action(decision: Any) -> str | None:
    if isinstance(decision, str):
        return decision
    if isinstance(decision, dict):
        return str(decision.get("action") or "") or None
    return str(getattr(decision, "action", "") or "") or None


def _executor_condition(
    role: str,
    condition: str,
    reason: str,
    *,
    worktree: str | None = None,
) -> dict[str, Any]:
    return {
        "ok": False,
        "managed": True,
        "role": role,
        "status": "wait" if condition == "WAIT" else "human",
        "condition": condition,
        "reason": reason,
        "worktree": worktree,
    }


def _impl_executor_worktree(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
) -> tuple[str | None, dict[str, Any] | None, list[str]]:
    """Resolve IMPL's explicit worktree without ever falling back to repo root."""

    notes: list[str] = []
    candidate = state.get("impl_worktree")
    if candidate:
        candidate = os.path.abspath(str(candidate))
        if os.path.isdir(candidate):
            return candidate, None, notes
        created = bool((state.get("created_worktrees") or {}).get("impl"))
        if not created:
            return None, _executor_condition(
                "impl",
                "HUMAN",
                f"implementation worktree is missing: {candidate}; refusing to use {ctx.repo_root}",
                worktree=candidate,
            ), notes
        try:
            from agentbus.worktree import bind_or_create_impl

            notes.extend(
                bind_or_create_impl(
                    store,
                    state,
                    repo_root=ctx.repo_root,
                    requested=candidate,
                    create=True,
                    start_point=(state.get("heads") or {}).get("current")
                    or (state.get("heads") or {}).get("implemented"),
                )
            )
        except Exception as exc:  # noqa: BLE001 — surface a precise recovery condition
            return None, _executor_condition(
                "impl",
                "WAIT",
                f"AgentBus could not reconstruct managed implementation worktree {candidate}: {exc}",
                worktree=candidate,
            ), notes
        resolved = state.get("impl_worktree")
        if resolved and os.path.isdir(str(resolved)):
            return os.path.abspath(str(resolved)), None, notes
        return None, _executor_condition(
            "impl",
            "WAIT",
            f"managed implementation worktree was not materialized at {candidate}",
            worktree=candidate,
        ), notes

    # A durable branch may still have a safe, already-materialized worktree.
    # Do not bind the primary checkout when looking for it.
    branch = state.get("branch")
    if branch:
        from agentbus.gitutil import find_worktree_for_branch

        found = find_worktree_for_branch(ctx.repo_root, str(branch))
        raw_found_path = (found or {}).get("path")
        found_path = os.path.abspath(str(raw_found_path)) if raw_found_path else ""
        if found_path and found_path != os.path.abspath(ctx.repo_root) and os.path.isdir(found_path):
            state["impl_worktree"] = found_path
            state.setdefault("created_worktrees", {})["impl"] = False
            notes.append(f"bound existing implementation worktree for {branch}: {found_path}")
            return found_path, None, notes

    created = bool((state.get("created_worktrees") or {}).get("impl"))
    if created:
        prior_path = state.get("impl_worktree")
        prior_created = bool((state.get("created_worktrees") or {}).get("impl"))
        try:
            from agentbus.worktree import bind_or_create_impl

            notes.extend(
                bind_or_create_impl(
                    store,
                    state,
                    repo_root=ctx.repo_root,
                    requested=None,
                    create=True,
                    start_point=(state.get("heads") or {}).get("current")
                    or (state.get("heads") or {}).get("implemented"),
                )
            )
        except Exception as exc:  # noqa: BLE001 — surface a precise recovery condition
            state["impl_worktree"] = prior_path
            state.setdefault("created_worktrees", {})["impl"] = prior_created
            return None, _executor_condition(
                "impl",
                "WAIT",
                f"AgentBus could not rematerialize the managed implementation worktree: {exc}",
            ), notes
        resolved = state.get("impl_worktree")
        if resolved and os.path.isdir(str(resolved)):
            resolved_abs = os.path.abspath(str(resolved))
            if resolved_abs != os.path.abspath(ctx.repo_root):
                return resolved_abs, None, notes
        state["impl_worktree"] = prior_path
        state.setdefault("created_worktrees", {})["impl"] = prior_created
        return None, _executor_condition(
            "impl",
            "WAIT",
            "managed implementation worktree recovery did not produce a safe non-root checkout",
        ), notes

    return None, _executor_condition(
        "impl",
        "HUMAN",
        "stream has no usable implementation worktree; bind or create one explicitly; refusing to use the current repo root",
    ), notes


def _audit_executor_worktree(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
) -> tuple[str | None, dict[str, Any] | None, list[str]]:
    notes: list[str] = []
    request = state.get("audit_request") or {}
    implemented = request.get("target") if request.get("status") == "pending" else None
    implemented = implemented or (state.get("heads") or {}).get("implemented")
    if not implemented:
        return None, _executor_condition(
            "audit",
            "HUMAN",
            "cannot activate AUDIT without an exact IMPLEMENTED_HEAD",
        ), notes
    try:
        from agentbus.worktree import ensure_audit_worktree

        worktree = ensure_audit_worktree(
            store,
            state,
            repo_root=ctx.repo_root,
            implemented_head=str(implemented),
        )
    except Exception as exc:  # noqa: BLE001 — surface a precise recovery condition
        return None, _executor_condition(
            "audit",
            "WAIT",
            f"AgentBus could not ensure the audit worktree at the implemented HEAD: {exc}",
            worktree=state.get("audit_worktree"),
        ), notes
    if not worktree or not os.path.isdir(worktree):
        return None, _executor_condition(
            "audit",
            "WAIT",
            f"audit worktree was not materialized: {worktree or '(none)' }",
            worktree=worktree,
        ), notes
    return os.path.abspath(worktree), None, notes


def ensure_executor_surface(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
    decision: Any,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Reconcile the local executor surface for the already-derived action.

    This is intentionally operational: it does not derive, replace, or
    reinterpret workflow authority.  Closing a stale role surface changes only
    runtime ownership facts, never the durable stream phase or control state.
    """

    from agentbus.decision import AUDIT, IMPL

    action = _executor_action(decision)
    if action not in {IMPL, AUDIT}:
        return {
            "ok": True,
            "managed": False,
            "status": "not-required",
            "reason": f"canonical action {action or '-'} does not require a Codex executor",
        }

    role = "impl" if action == IMPL else "audit"
    if role == "impl":
        worktree, failure, notes = _impl_executor_worktree(ctx, store, state)
    else:
        worktree, failure, notes = _audit_executor_worktree(ctx, store, state)
    if failure:
        failure["notes"] = notes
        return failure

    try:
        from agentbus.konsolebind import ensure_role_konsole

        result = ensure_role_konsole(
            store,
            str(state.get("stream_id") or store.stream_id),
            role,
            str(worktree),
            env=env,
        )
    except Exception as exc:  # noqa: BLE001 — a missing desktop surface must not stop the workflow tick
        result = {
            "ok": False,
            "managed": True,
            "role": role,
            "status": "wait",
            "condition": "WAIT",
            "reason": f"could not reconcile {role.upper()} executor surface: {exc}",
        }
    result.setdefault("managed", True)
    result.setdefault("role", role)
    result.setdefault("worktree", worktree)
    result.setdefault("notes", notes)
    if result.get("status") in {"launched", "reused", "starting"}:
        result["notes"] = notes + [
            f"{role.upper()} executor {result['status']} without changing durable workflow authority"
        ]
    return result


def ensure_pr_reviewable(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
    *,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Make an AgentBus-owned draft PR reviewable at the final boundary.

    This is an operational ref transition only.  It is fenced by current
    durable evidence and verifies the live PR again after the gh mutation,
    so it cannot change HEAD/base or make an arbitrary user PR ready.
    """
    from agentbus.decision import (
        active_blocker,
        audit_pass_exact,
        ci_snapshot,
        product_review_authority,
        report_valid_exact,
        strong_current_publication_ownership,
        unit_head,
    )
    from agentbus.github import mark_pr_ready, pr_view
    from agentbus.scope import scope_of, validate_files_against_scope

    def refused(reason: str) -> dict[str, Any]:
        return {"ok": True, "status": "not-eligible", "mutated": False, "reason": reason}

    pr = state.get("pr")
    if not pr:
        return refused("no durable PR")
    head = str(unit_head(state) or "").strip()
    if not head or not strong_current_publication_ownership(state, head):
        return refused("current publication is not strongly AgentBus-owned")
    if not report_valid_exact(state):
        return refused("exact durable CODEX_REPORT is missing")
    if not audit_pass_exact(state):
        return refused("exact durable CODEX_AUDIT PASS is missing")
    if not product_review_authority(state).get("ok"):
        return refused("product review authority is missing or stale")
    if active_blocker(state):
        return refused("current blocker is active")

    heads = state.get("heads") if isinstance(state.get("heads"), dict) else {}
    for key in ("current", "implemented", "last_seen"):
        value = str(heads.get(key) or "").strip()
        if value and value != head:
            return refused(f"conflicting {key} HEAD")
    files = (state.get("publication") or {}).get("files") or []
    scope = scope_of(state)
    if not scope or not (scope.get("explicit_paths") or scope.get("allowed_patterns")):
        return refused("current scope is not materialized")
    if files and not validate_files_against_scope(files, scope).get("ok"):
        return refused("published files are outside the current scope")

    try:
        live = pr_view(ctx.repo_root, int(pr), env=env)
    except Exception as exc:  # noqa: BLE001 — no mutation without a live fence
        return refused(f"could not fetch live PR for ready transition: {exc}")
    state.setdefault("github", {})["pr"] = dict(live)
    if str(live.get("state") or "").upper() != "OPEN":
        return refused(f"PR state is {live.get('state') or 'unknown'}")
    if str(live.get("headRefOid") or "").strip() != head:
        return refused("PR HEAD is not the exact implementation HEAD")
    branch = str(state.get("branch") or "").strip()
    if branch and str(live.get("headRefName") or "").strip() != branch:
        return refused("PR branch is not the expected AgentBus branch")
    spec = (state.get("envelopes") or {}).get("GPT_SPEC") or {}
    spec_fields = spec.get("fields") if isinstance(spec.get("fields"), dict) else {}
    expected_base = str(
        (state.get("transport") or {}).get("base_sha")
        or spec_fields.get("BASE_HEAD")
        or (heads.get("spec_base") or "")
    ).strip()
    base = str(live.get("baseRefOid") or "").strip()
    if not expected_base or base != expected_base:
        return refused("PR base is not the expected durable base")
    ci = ci_snapshot(live)
    if ci.get("status") in {"FAIL", "PENDING"}:
        return refused(f"required CI evidence is {str(ci.get('status')).lower()}")

    draft = live.get("isDraft", live.get("draft"))
    if draft is None:
        return refused("live PR draft status is unavailable")
    if not bool(draft):
        return {
            "ok": True,
            "status": "already-ready",
            "mutated": False,
            "pr": dict(live),
            "head": head,
            "base": base,
        }

    before_head = str(live.get("headRefOid") or "").strip()
    before_base = str(live.get("baseRefOid") or "").strip()
    try:
        mark_pr_ready(ctx.repo_root, int(pr), env=env)
    except Exception as exc:  # noqa: BLE001 — verify response-loss before retrying
        try:
            verified = pr_view(ctx.repo_root, int(pr), env=env)
        except Exception:
            return refused(f"could not verify ready transition: {exc}")
        if not (
            not bool(verified.get("isDraft", verified.get("draft")))
            and str(verified.get("headRefOid") or "").strip() == before_head
            and str(verified.get("baseRefOid") or "").strip() == before_base
        ):
            return refused(f"ready transition failed: {exc}")
        live = verified
    else:
        try:
            live = pr_view(ctx.repo_root, int(pr), env=env)
        except Exception as exc:  # noqa: BLE001 — accept only after verification
            return refused(f"could not verify ready transition: {exc}")

    if bool(live.get("isDraft", live.get("draft"))):
        return refused("PR remains draft after ready transition")
    if str(live.get("headRefOid") or "").strip() != before_head:
        return refused("ready transition changed PR HEAD")
    if str(live.get("baseRefOid") or "").strip() != before_base:
        return refused("ready transition changed PR base")
    state.setdefault("github", {})["pr"] = dict(live)
    store.append_event(
        "pr-ready",
        {"pr": int(pr), "head": before_head, "base": before_base, "ownership": "AgentBus"},
    )
    return {
        "ok": True,
        "status": "ready",
        "mutated": True,
        "pr": dict(live),
        "head": before_head,
        "base": before_base,
    }


def tick_stream(
    ctx: RepoContext,
    store: StreamStore,
    *,
    env: dict[str, str] | None = None,
    sync_github: bool = True,
    force_sync: bool = False,
    surface: str = "cli",
    locked: bool = False,
) -> dict[str, Any]:
    from agentbus.runner import refresh_stream

    def work() -> dict[str, Any]:
        state = store.load()
        cid = infer_campaign_id(state)
        state["campaign_id"] = cid
        campaign = load_campaign(ctx, cid)
        rescan = force_sync or authority_source_needs_rescan(state, campaign)
        notes = refresh_stream(
            ctx,
            store,
            state,
            env=env,
            sync_github=sync_github,
            force_sync=rescan,
        )
        impl = state.get("impl_worktree") or ctx.repo_root
        notes.extend(reconcile_durable(store, state, repo=impl, env=env))
        pub = state.get("publication") or {}
        need_transport = state.get("phase") in {machine.WORKTREE_READY, machine.MATERIALIZING} or (
            (state.get("transport") or {}).get("status") in {"push_failed", "pr_failed"}
        ) or (
            not state.get("pr")
            and pub.get("status") == "pushed"
            and pub.get("commit")
            and state.get("phase") not in {machine.MERGED, machine.WAITING_FOR_SPEC}
        )
        if need_transport:
            from agentbus.transport import ensure_durable_pr_transport

            retry = ensure_durable_pr_transport(ctx, store, state, wake_impl=state.get("phase") in {machine.WORKTREE_READY, machine.MATERIALIZING})
            if retry.get("reason"):
                notes.append(f"transport: {retry.get('reason')}")
            elif retry.get("pr"):
                notes.append(f"transport PR #{retry.get('pr')}")
        from agentbus.scope import scope_of, validate_files_against_scope

        scope_of(state)
        pub_files = ((state.get("publication") or {}).get("files") or [])
        if pub_files:
            check = validate_files_against_scope(pub_files, state.get("scope"))
            blocker = str((state.get("status") or {}).get("blocker") or "")
            if check.get("ok") and blocker.startswith("unexpected changed files"):
                state["status"]["blocker"] = None
                notes.append("cleared false scope blocker after rematerialized PATH_SCOPE")
        if state.get("pr") and ((state.get("envelopes") or {}).get("CODEX_REPORT")):
            from agentbus.publish import ensure_durable_report, report_is_durable

            if not report_is_durable(state):
                durable = ensure_durable_report(ctx, store, state, env=env)
                if durable.get("comment_id"):
                    notes.append(f"durable CODEX_REPORT comment {durable.get('comment_id')}")
                elif durable.get("reason"):
                    notes.append(f"durable report: {durable.get('reason')}")
        if state.get("pr") and ((state.get("envelopes") or {}).get("CODEX_AUDIT")):
            from agentbus.publish import audit_is_durable, ensure_durable_audit

            if not audit_is_durable(state):
                durable = ensure_durable_audit(ctx, store, state, env=env)
                if durable.get("comment_id"):
                    notes.append(f"durable CODEX_AUDIT comment {durable.get('comment_id')}")
                elif durable.get("reason"):
                    notes.append(f"durable audit: {durable.get('reason')}")
        ready = ensure_pr_reviewable(ctx, store, state, env=env)
        if ready.get("status") == "ready":
            notes.append(f"marked AgentBus-owned PR #{state.get('pr')} ready for review")
        elif ready.get("status") == "already-ready":
            notes.append(f"AgentBus-owned PR #{state.get('pr')} is already ready for review")
        campaign = load_campaign(ctx, cid)
        if campaign is not None:
            from agentbus.campaign import persist_campaign_projection, save_campaign

            persist_campaign_projection(ctx, campaign)
            save_campaign(ctx, campaign)
        if (campaign or {}).get("automation_mode") == AUTOPILOT or EXPLICIT_STREAM_CAMPAIGNS.get(
            state.get("stream_id") or ""
        ) or (state.get("phase") == machine.MERGED):
            from agentbus.decision import NEXT, derive_next_action

            live = (state.get("github") or {}).get("pr")
            raw_decision = derive_next_action(
                state,
                campaign,
                live if isinstance(live, dict) else None,
            )
            if raw_decision.action == NEXT:
                maybe_materialize_successor(store, state)
                campaign = load_campaign(ctx, cid)
        handoff = None
        if not is_obsolete(state):
            handoff = maybe_gpt_handoff(store, state, campaign=campaign, env=env, surface=surface)
        from agentbus.decision import decision_for_stream

        live = (state.get("github") or {}).get("pr")
        decision = decision_for_stream(
            ctx,
            state,
            campaign,
            live if isinstance(live, dict) else None,
            env=env,
        )
        state.setdefault("status", {})["next_action"] = decision.action
        state["status"]["decision"] = decision.as_dict()
        refresh_authority(state)
        executor = ensure_executor_surface(ctx, store, state, decision, env=env)
        for note in executor.get("notes") or []:
            notes.append(f"executor: {note}")
        if not executor.get("ok"):
            condition = executor.get("condition") or "WAIT"
            notes.append(f"executor {condition}: {executor.get('reason')}")
        store.save(state)
        att = classify_attention(state, campaign=campaign, decision=decision)
        return {
            "stream_id": state.get("stream_id"),
            "phase": state.get("phase"),
            "campaign_id": cid,
            "notes": notes,
            "attention": att,
            "handoff": handoff,
            "decision": decision.as_dict(),
            "executor": executor,
            "dispatch_merge": decision.action == "MERGE",
            "obsolete": is_obsolete(state),
            "latest_authority": (state.get("status") or {}).get("latest_authority"),
        }

    if locked:
        return work()
    with store.lock():
        result = work()
    if result.pop("dispatch_merge", False):
        from agentbus.mergegate import autonomous_merge

        merged = autonomous_merge(ctx, store, env=env)
        result["merge"] = merged
        result["phase"] = store.load().get("phase")
    return result


def campaign_tick(
    ctx: RepoContext,
    *,
    stream_id: str | None = None,
    env: dict[str, str] | None = None,
    force_sync: bool = False,
    surface: str = "cli",
) -> dict[str, Any]:
    """Idempotent, lock-safe, single-repo-tick-fenced.

    When syncing all streams, newly created continuation units are ticked
    in the same pass so “立即同步” does not miss the next work unit.
    """
    results: list[dict[str, Any]] = []
    tick_lock = _tick_lock(ctx)
    if not tick_lock.try_acquire():
        return {
            "ok": True,
            "surface": surface,
            "busy": True,
            "coalesced": True,
            "reason": "campaign tick already in progress",
            "results": [],
            "synced": [],
        }
    try:
        existing = set(list_stream_ids_safe(ctx))
        if stream_id:
            pending = [stream_id]
        else:
            pending = list(existing)
        seen: set[str] = set()
        while pending:
            current = pending.pop(0)
            if current in seen:
                continue
            seen.add(current)
            store = StreamStore(ctx, current)
            if not store.exists():
                continue
            try:
                results.append(
                    tick_stream(
                        ctx,
                        store,
                        env=env,
                        sync_github=True,
                        force_sync=force_sync,
                        surface=surface,
                    )
                )
            except Exception as exc:  # noqa: BLE001 — one stream must not abort the rest
                results.append(
                    {
                        "stream_id": current,
                        "phase": None,
                        "notes": [f"tick failed: {exc}"],
                        "error": str(exc),
                    }
                )
            for sid in list_stream_ids_safe(ctx):
                if sid in seen:
                    continue
                if stream_id and sid in existing:
                    continue
                pending.append(sid)
    finally:
        tick_lock.release()
    return {"ok": True, "surface": surface, "results": results, "synced": [item.get("stream_id") for item in results]}


def list_stream_ids_safe(ctx: RepoContext) -> list[str]:
    from agentbus.store import list_stream_ids

    return list_stream_ids(ctx)


def enable_known_campaigns(ctx: RepoContext) -> list[str]:
    notes: list[str] = []
    with campaign_lock(ctx):
        for store in iter_stores(ctx):
            if not store.exists():
                continue
            with store.lock():
                state = store.load()
                apply_known_obsolete(state)
                mapped = EXPLICIT_STREAM_CAMPAIGNS.get(state.get("stream_id") or "")
                if mapped and not is_obsolete(state):
                    bind_explicit_campaign(ctx, state, mapped, automation_mode=AUTOPILOT)
                    notes.append(f"{state['stream_id']} → campaign {mapped} autopilot")
                store.save(state)
    return notes
