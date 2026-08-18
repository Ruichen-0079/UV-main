"""Campaign autopilot. Piggybacks on WebUI / role watchers. No hidden daemon.

A bound ChatGPT URL may be opened once per GPT gate generation.
No DOM automation, no cookies, no message injection.
"""

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
    phase = state.get("phase") or ""
    if phase == machine.MERGED and (campaign or {}).get("status") == STATUS_WAITING_FOR_PLAN:
        return f"WAITING_FOR_PLAN|{(campaign or {}).get('campaign_id')}"
    implemented = ((state.get("heads") or {}).get("implemented") or "")[:40]
    return f"{phase}|{implemented}|{review_policy_of(state)}"


def maybe_gpt_handoff(
    store: StreamStore,
    state: dict[str, Any],
    *,
    campaign: dict[str, Any] | None = None,
    env: dict[str, str] | None = None,
    surface: str = "cli",
) -> dict[str, Any] | None:
    att = classify_attention(state, campaign=campaign)
    camp_att = campaign_attention(campaign)
    if not (att.get("browser_gpt_required") or camp_att.get("browser_gpt_required")):
        return None
    url = ((state.get("browser_gpt") or {}).get("url") or "").strip()
    generation = gpt_gate_generation(state, campaign)
    gate = state.setdefault("gpt_gate", {})
    if gate.get("generation") == generation and gate.get("notified"):
        return {
            "generation": generation,
            "url": url or None,
            "open_once": False,
            "already": True,
        }
    gate["generation"] = generation
    gate["notified"] = True
    gate["notified_at"] = utc_now()
    gate["url"] = url or None
    stream_id = state.get("stream_id") or store.stream_id
    _notify_gpt(stream_id, state.get("phase") or "", campaign)
    opened = False
    if url and surface != "webui" and (env or os.environ).get("YUVI_AGENTBUS_OPEN_URL") != "0":
        opened = _open_url(url, env)
        if opened:
            gate["opened_at"] = utc_now()
    store.append_event(
        "gpt-gate",
        {"generation": generation, "url": bool(url), "opened": opened, "surface": surface},
    )
    return {
        "generation": generation,
        "url": url or None,
        "open_once": bool(url) and not gate.get("opened_at"),
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


def _open_url(url: str, env: dict[str, str] | None) -> bool:
    from agentbus.util import run_cmd, which

    opener = which("xdg-open") or which("kde-open")
    if not opener:
        return False
    result = run_cmd([opener, url], env=env, timeout=8)
    return result.returncode == 0


def migrate_roles(state: dict[str, Any], env: dict[str, str] | None = None) -> None:
    for role in ("impl", "audit"):
        cfg = (state.get("roles") or {}).get(role)
        if isinstance(cfg, dict):
            migrate_role_config(cfg, env)


def reconcile_durable(store: StreamStore, state: dict[str, Any], *, repo: str) -> list[str]:
    """Push a stream to the phase its durable envelopes already justify."""
    notes: list[str] = []
    migrate_roles(state)
    apply_known_obsolete(state)
    if is_obsolete(state):
        refresh_authority(state)
        refresh_next(state)
        return ["obsolete candidate; not resumed"]

    envelopes = state.get("envelopes") or {}
    phase = state.get("phase") or ""
    heads = state.setdefault("heads", {})
    implemented = heads.get("implemented")
    audited = heads.get("audited")
    current = heads.get("current")

    if phase == machine.RECOVERY_REQUIRED:
        blocker = str((state.get("status") or {}).get("blocker") or "")
        prior = state.get("prior_phase")
        dirty = bool(repo and is_dirty(repo))
        if dirty:
            notes.append("recovery remains human: dirty worktree")
        elif "no valid envelope" in blocker or "untrusted" in blocker.lower():
            notes.append("recovery remains human: missing/untrusted authority")
        elif prior and "process died" in blocker:
            set_phase(state, prior, reason="stale runner recovered")
            state["status"]["blocker"] = None
            notes.append(f"cleared stale crash recovery → {prior}")
            phase = state["phase"]

    spec = envelopes.get("GPT_SPEC") if isinstance(envelopes.get("GPT_SPEC"), dict) else None
    if phase == machine.WAITING_FOR_SPEC and spec and (spec.get("status") or "").upper() in {
        "ACTIONABLE",
        "APPROVED",
    }:
        raw = spec.get("raw") or ""
        if raw:
            try:
                apply_envelope(
                    store,
                    state,
                    Envelope(
                        kind="GPT_SPEC",
                        fields=spec.get("fields") or {},
                        raw=raw,
                        source="reconcile",
                    ),
                    repo=repo,
                    current_head=current,
                    allow_stale=False,
                )
                notes.append("reapplied durable GPT_SPEC")
                phase = state["phase"]
            except Exception as exc:  # noqa: BLE001
                notes.append(f"spec reapply skipped: {exc}")

    review = envelopes.get("GPT_REVIEW") if isinstance(envelopes.get("GPT_REVIEW"), dict) else None
    review_wants_repair = bool(
        review
        and (review.get("status") or "").upper() in {"CHANGES_REQUIRED", "REJECT", "REJECTED"}
        and review.get("head")
        and implemented
        and review.get("head") == implemented
    )
    audit_rec = envelopes.get("CODEX_AUDIT") if isinstance(envelopes.get("CODEX_AUDIT"), dict) else None
    audit_wants_repair = bool(
        audit_rec
        and (audit_rec.get("status") or "").upper() in {"CHANGES_REQUIRED", "FAIL", "FAILED"}
        and audit_rec.get("head")
        and implemented
        and audit_rec.get("head") == implemented
        and int(state.get("repair_cycles") or 0) > 0
    )
    review_wants_repair = review_wants_repair or audit_wants_repair

    report = envelopes.get("CODEX_REPORT") if isinstance(envelopes.get("CODEX_REPORT"), dict) else None
    if (
        not review_wants_repair
        and phase in {machine.IMPLEMENTING, machine.VALIDATING}
        and report
        and (report.get("status") or "").upper() in {"READY_FOR_AUDIT", "PASS", "PASSED"}
        and implemented
        and current
        and implemented == current
        and ((state.get("publication") or {}).get("commit") == implemented)
    ):
        if phase == machine.IMPLEMENTING:
            set_phase(state, machine.VALIDATING, reason="durable CODEX_REPORT")
        set_phase(state, machine.READY_FOR_AUDIT, reason="durable CODEX_REPORT")
        notes.append("advanced to READY_FOR_AUDIT from durable report")
        phase = state["phase"]

    audit = envelopes.get("CODEX_AUDIT") if isinstance(envelopes.get("CODEX_AUDIT"), dict) else None
    if (
        not review_wants_repair
        and phase in {machine.READY_FOR_AUDIT, machine.AUDITING}
        and audit
        and (audit.get("status") or "").upper() in {"PASS", "PASSED", "OK"}
        and audited
        and implemented
        and audited == implemented
    ):
        decision = evaluate_delegation(state, audit.get("fields") if isinstance(audit.get("fields"), dict) else None)
        if phase == machine.READY_FOR_AUDIT:
            set_phase(state, machine.AUDITING, reason="durable AUDIT result")
        if decision.ok:
            record_delegated_review(store, state, decision)
            set_phase(state, machine.FINAL_GATE, reason="AUDIT_SUFFICIENT reconcile")
            notes.append("AUDIT_SUFFICIENT delegated during reconcile")
        else:
            set_phase(state, machine.READY_FOR_GPT, reason="durable AUDIT PASS")
            notes.append("advanced to READY_FOR_GPT from durable audit")
        phase = state["phase"]

    if phase == machine.READY_FOR_GPT and review_policy_of(state) == AUDIT_SUFFICIENT:
        decision = evaluate_delegation(state)
        if decision.ok:
            record_delegated_review(store, state, decision)
            set_phase(state, machine.FINAL_GATE, reason="AUDIT_SUFFICIENT autopilot")
            notes.append("delegated review auto-advanced")

    review = envelopes.get("GPT_REVIEW") if isinstance(envelopes.get("GPT_REVIEW"), dict) else None
    if (
        phase in {machine.READY_FOR_GPT, machine.GPT_REVIEW}
        and review
        and (review.get("status") or "").upper() in {"ACCEPT", "ACCEPTED", "APPROVE", "APPROVED"}
        and review.get("head")
        and implemented
        and review.get("head") == implemented
    ):
        if phase == machine.READY_FOR_GPT:
            set_phase(state, machine.GPT_REVIEW, reason="durable GPT_REVIEW")
        set_phase(state, machine.FINAL_GATE, reason="durable GPT ACCEPT")
        notes.append("advanced to FINAL_GATE from durable GPT_REVIEW")
        phase = state["phase"]

    refresh_authority(state)
    refresh_next(state)
    return notes


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
        notes.extend(reconcile_durable(store, state, repo=impl))
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
        campaign = load_campaign(ctx, cid)
        if campaign is not None:
            from agentbus.campaign import persist_campaign_projection, save_campaign

            persist_campaign_projection(ctx, campaign)
            save_campaign(ctx, campaign)
        if (campaign or {}).get("automation_mode") == AUTOPILOT or EXPLICIT_STREAM_CAMPAIGNS.get(
            state.get("stream_id") or ""
        ) or (state.get("phase") == machine.MERGED):
            if state.get("phase") == machine.MERGED:
                maybe_materialize_successor(store, state)
                campaign = load_campaign(ctx, cid)
        handoff = None
        merge_handoff = None
        if not is_obsolete(state):
            handoff = maybe_gpt_handoff(store, state, campaign=campaign, env=env, surface=surface)
            from agentbus.mergegate import maybe_merge_gpt_handoff

            merge_handoff = maybe_merge_gpt_handoff(
                store, state, campaign=campaign, env=env, surface=surface
            )
        refresh_authority(state)
        store.save(state)
        att = classify_attention(state, campaign=campaign)
        return {
            "stream_id": state.get("stream_id"),
            "phase": state.get("phase"),
            "campaign_id": cid,
            "notes": notes,
            "attention": att,
            "handoff": handoff,
            "obsolete": is_obsolete(state),
            "latest_authority": (state.get("status") or {}).get("latest_authority"),
        }

    if locked:
        return work()
    with store.lock():
        return work()


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
    with _tick_lock(ctx):
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
