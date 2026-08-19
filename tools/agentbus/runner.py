from __future__ import annotations

import os
import signal
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, TextIO

from agentbus.apply import apply_envelope, refresh_next, set_phase
from agentbus.config import build_codex_argv, effective_role_label
from agentbus.fencing import fence_spec
from agentbus.gitutil import head_sha, is_dirty
from agentbus.github import sync_interval, sync_with_lease
from agentbus.inbox import process_inbox
from agentbus.machine import (
    AUDITING,
    IMPLEMENTING,
    READY_FOR_AUDIT,
    READY_FOR_GPT,
    RECOVERY_REQUIRED,
    RE_REVIEW_REQUIRED,
    VALIDATING,
    WAITING_FOR_SPEC,
)
from agentbus.paths import AgentbusError, RepoContext
from agentbus.protocol import extract_first_envelope
from agentbus.recover import recover_stream, role_process_healthy
from agentbus.render import render_banner
from agentbus.store import StreamStore
from agentbus.util import append_text, atomic_write_text, pid_start_token, utc_now
from agentbus.worktree import ensure_audit_worktree


GITHUB_SYNC_SECONDS = 20


def _codex_bin(env: dict[str, str] | None) -> str:
    if env and env.get("YUVI_AGENTBUS_CODEX"):
        return env["YUVI_AGENTBUS_CODEX"]
    return os.environ.get("YUVI_AGENTBUS_CODEX") or "codex"


def refresh_stream(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
    *,
    env: dict[str, str] | None = None,
    sync_github: bool = True,
    force_sync: bool = False,
    reprocess_ids: set[str] | None = None,
) -> list[str]:
    notes = recover_stream(store, state)
    impl = state.get("impl_worktree") or ctx.repo_root
    current = head_sha(impl)
    if current:
        state.setdefault("heads", {})["current"] = current
    notes.extend(process_inbox(store, state, repo=impl, current_head=current))
    if sync_github:
        notes.extend(
            sync_with_lease(
                store,
                state,
                repo_root=ctx.repo_root,
                origin=ctx.origin,
                current_head=current,
                env=env,
                force=force_sync or bool(reprocess_ids),
                ctx=ctx,
                reprocess_ids=reprocess_ids,
            )
        )
    refresh_next(state)
    return notes


def maybe_validate(store: StreamStore, state: dict[str, Any]) -> None:
    if state["phase"] != VALIDATING:
        return
    impl = state.get("impl_worktree")
    current = head_sha(impl) if impl else None
    implemented = (state.get("heads") or {}).get("implemented")
    published = (state.get("publication") or {}).get("commit")
    if impl and is_dirty(impl):
        from agentbus.publish import mark_publication_failed

        mark_publication_failed(state, "uncommitted implementation cannot become READY_FOR_AUDIT")
        set_phase(state, IMPLEMENTING, reason="publication required")
        return
    if not published or not implemented or implemented != current or published != current:
        from agentbus.publish import mark_publication_failed

        mark_publication_failed(state, "READY_FOR_AUDIT requires a committed IMPLEMENTED_HEAD")
        if state["phase"] == VALIDATING:
            set_phase(state, IMPLEMENTING, reason="publication required")
        return
    set_phase(state, READY_FOR_AUDIT, reason="local validation")
    state["status"]["audit"] = "WAITING"


def role_should_work(state: dict[str, Any], role: str) -> bool:
    if state.get("archived") or state.get("hidden_from_attention"):
        return False
    if state.get("control") == "paused":
        return False
    if state.get("control") == "step" and not state.get("step_armed"):
        return False
    from agentbus.decision import AUDIT, IMPL, derive_next_action

    campaign = state.get("campaign") if isinstance(state.get("campaign"), dict) else None
    live = (state.get("github") or {}).get("pr")
    actor = derive_next_action(
        state,
        campaign,
        live if isinstance(live, dict) else None,
    ).action
    if role == "impl":
        return actor == IMPL
    if role == "audit":
        from agentbus.publish import report_is_durable

        rec = ((state.get("envelopes") or {}).get("CODEX_REPORT") or {})
        if state.get("pr") and rec and not report_is_durable(state):
            if (state.get("audit_request") or {}).get("status") != "pending":
                return False
        request = state.get("audit_request") or {}
        if request.get("status") == "pending":
            return True
        return actor == AUDIT
    return False


def impl_work_key(state: dict[str, Any]) -> str:
    spec = (state.get("envelopes") or {}).get("GPT_SPEC") or {}
    review = (state.get("envelopes") or {}).get("GPT_REVIEW") or {}
    final_review = (state.get("envelopes") or {}).get("GPT_MERGE_REVIEW") or {}
    return "|".join(
        [
            str(spec.get("digest") or spec.get("head") or ""),
            str(review.get("digest") or review.get("status") or ""),
            str(final_review.get("digest") or final_review.get("source_id") or final_review.get("status") or ""),
            str(state.get("repair_cycles") or 0),
        ]
    )


def final_repair_authority(state: dict[str, Any], campaign: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Return the exact-current Final GPT repair authority, if any."""

    from agentbus.decision import final_review_for_current

    github = state.get("github") if isinstance(state.get("github"), dict) else {}
    live = github.get("pr") if isinstance(github.get("pr"), dict) else {}
    review = final_review_for_current(state, campaign or {}, live)
    if review and review.get("normalized_status") == "REPAIR":
        return review
    return None


def repair_authority_head(review: dict[str, Any] | None) -> str | None:
    if not review:
        return None
    fields = review.get("fields") if isinstance(review.get("fields"), dict) else {}
    head = review.get("head") or fields.get("REVIEWED_HEAD")
    return str(head).strip() if head else None


def requeue_noop_repair_generation(
    store: StreamStore,
    state: dict[str, Any],
    campaign: dict[str, Any] | None = None,
) -> bool:
    """Forget only a historical completion marker for a repair no-op.

    Older AgentBus versions could mark a READY_FOR_AUDIT/no-change result as
    done while the durable Final GPT authority still required a change at the
    same head.  This narrowly recovers that marker without changing workflow
    authority or consuming another repair cycle.
    """

    if campaign is None:
        from agentbus.campaign import infer_campaign_id, load_campaign

        campaign = load_campaign(store.ctx, infer_campaign_id(state))
    runtime = store.load_runtime()
    key = impl_work_key(state)
    if runtime.get("last_done_key", {}).get("impl") != key:
        return False

    review = final_repair_authority(state, campaign)
    repair_head = repair_authority_head(review)
    if not review or not repair_head:
        return False

    final_repair = state.get("final_repair") if isinstance(state.get("final_repair"), dict) else {}
    if final_repair.get("consumed_review") != review.get("source_id"):
        return False

    heads = state.get("heads") if isinstance(state.get("heads"), dict) else {}
    publication = state.get("publication") if isinstance(state.get("publication"), dict) else {}
    report = (state.get("envelopes") or {}).get("CODEX_REPORT")
    report_fields = (
        report.get("fields")
        if isinstance(report, dict) and isinstance(report.get("fields"), dict)
        else {}
    )
    current_head = heads.get("current") or heads.get("implemented") or publication.get("commit")
    report_head = report_fields.get("IMPLEMENTED_HEAD")
    if not (
        current_head == repair_head
        and publication.get("commit") == repair_head
        and report_head == repair_head
    ):
        return False

    runtime.setdefault("last_done_key", {}).pop("impl", None)
    store.save_runtime(runtime)
    store.append_event(
        "repair-noop-requeued",
        {"work_key": key, "repair_head": repair_head, "review_source_id": review.get("source_id")},
    )
    return True


def audit_work_key(state: dict[str, Any]) -> str:
    request = state.get("audit_request") or {}
    if request.get("status") == "pending":
        return f"req|{request.get('id')}|{request.get('target')}"
    report = (state.get("envelopes") or {}).get("CODEX_REPORT") or {}
    return "|".join(
        [
            "auto",
            str((state.get("heads") or {}).get("implemented") or ""),
            str(report.get("digest") or ""),
            str(state.get("repair_cycles") or 0),
        ]
    )


def already_done(runtime: dict[str, Any], role: str, key: str) -> bool:
    done = (runtime.get("last_done_key") or {}).get(role)
    return bool(key) and done == key


def mark_done(store: StreamStore, role: str, key: str) -> None:
    runtime = store.load_runtime()
    runtime.setdefault("last_done_key", {})[role] = key
    store.save_runtime(runtime)


def register_runner(store: StreamStore, role: str) -> None:
    from agentbus.konsolebind import AGENTBUS_EXECUTOR_GENERATION

    # Registration is the hand-off point from the Konsole process to the
    # watch runner.  Serialize it with executor reconciliation so a runner
    # that is being replaced cannot overwrite a newer slot.
    with store.lock():
        runtime = store.load_runtime()
        slot = runtime.setdefault("konsole", {}).setdefault(role, {})
        launch_token = os.environ.get("YUVI_AGENTBUS_EXECUTOR_TOKEN")
        recorded_launch_token = slot.get("runner_launch_token")
        if recorded_launch_token and launch_token and recorded_launch_token != launch_token:
            return
        slot["runner_pid"] = os.getpid()
        slot["runner_token"] = pid_start_token(os.getpid())
        slot["runner_start_token"] = slot["runner_token"]
        slot["runner_generation"] = AGENTBUS_EXECUTOR_GENERATION
        slot["executor_generation"] = AGENTBUS_EXECUTOR_GENERATION
        slot["runner_stream_id"] = store.stream_id
        slot["runner_role"] = role
        slot["runner_pending"] = False
        slot["runner_pending_since"] = None
        slot["owner"] = slot.get("owner") or "agentbus"
        slot["managed_by"] = slot.get("managed_by") or "agentbus"
        store.save_runtime(runtime)


def waiting_banner(state: dict[str, Any], role: str, *, github: dict[str, Any] | None) -> str:
    from agentbus.display import sanitize_display_text

    phase = state.get("phase")
    if role == "impl":
        if phase in {READY_FOR_AUDIT, AUDITING}:
            why = "Nothing to implement.\nWaiting for audit to finish."
        elif phase == READY_FOR_GPT:
            why = "Nothing to implement.\nWaiting for Browser GPT review."
        else:
            why = "Waiting for:\n- GPT_SPEC\n- GPT_REVIEW / CHANGES_REQUIRED\n- CODEX_AUDIT requiring changes"
        title = "WAITING"
    else:
        if phase in {IMPLEMENTING, VALIDATING}:
            title = "WAITING_FOR_IMPLEMENTATION"
            why = "No auditable implementation yet.\nIMPL: running"
        elif phase == WAITING_FOR_SPEC:
            title = "WAITING_FOR_IMPLEMENTATION"
            why = "No auditable implementation yet."
        else:
            title = "WAITING"
            why = "Waiting for the next valid implementation or Audit Current request."
    gh = github or state.get("github") or {}
    if gh.get("unavailable"):
        gh_line = f"GitHub: DEGRADED\nLast successful sync: {gh.get('last_sync_at') or '-'}\nError: {gh.get('last_error') or 'unavailable'}"
    else:
        gh_line = f"GitHub: connected\nLast sync: {gh.get('last_sync_at') or 'never'}"
    return sanitize_display_text(
        f"\n{str(state.get('stream_id') or '').upper()} | {role.upper()}\n"
        f"STATE\n{title}\n\n"
        f"Current stream phase:\n{phase}\n\n"
        f"{why}\n\n"
        f"{gh_line}\n",
        roots=tuple(
            str(item)
            for item in (state.get("audit_worktree"), state.get("impl_worktree"))
            if item
        ),
    )


def build_prompt(
    state: dict[str, Any],
    role: str,
    protocol_path: str,
    campaign: dict[str, Any] | None = None,
) -> str:
    envelopes = state.get("envelopes") or {}
    spec = (envelopes.get("GPT_SPEC") or {}).get("raw") or "(none)"
    review = (envelopes.get("GPT_REVIEW") or {}).get("raw") or "(none)"
    report = (envelopes.get("CODEX_REPORT") or {}).get("raw") or "(none)"
    audit = (envelopes.get("CODEX_AUDIT") or {}).get("raw") or "(none)"
    note = (envelopes.get("HUMAN_NOTE") or {}).get("raw") or "(none)"
    if role == "impl":
        duties = """You are the IMPL agent for this stream.
Implement only the approved scope from the latest applicable GPT_SPEC / GPT_REVIEW / HUMAN override.
Do not silently rewrite architecture, weaken acceptance criteria, hide test failures, expand unrelated scope, or pretend an audit passed.
Do not ask the human to copy output between windows.
Do NOT git add, git commit, or git push. Leave file changes uncommitted.
AgentBus publishes Git outside the sandbox after you finish.
Write a [CODEX_REPORT] envelope as your final message. IMPLEMENTED_HEAD may be the pre-change HEAD; AgentBus will replace it after commit.
If the spec BASE_HEAD is stale versus current HEAD, stop and emit [BLOCKER] instead of guessing.
"""
        required = "[CODEX_REPORT]"
    else:
        duties = """You are the independent AUDIT agent for this stream.
Inspect the implementation against the authoritative spec/review. Do not modify implementation files.
Do not silently repair the implementation. You may run read-only or isolated validation.
Publish a [CODEX_AUDIT] envelope as your final message.
If AUDITED_HEAD would not match IMPLEMENTED_HEAD, stop and emit [BLOCKER].
"""
        required = "[CODEX_AUDIT]"
    final_repair = final_repair_authority(state, campaign) if role == "impl" else None
    repair_context = ""
    if final_repair:
        repair_context = f"""
Latest FINAL_GPT repair authority:
Source comment: {final_repair.get("source_id") or "(unknown)"}
{final_repair.get("raw") or "(none)"}

FINAL_GPT REPAIR DUTIES:
- GPT_MERGE_REVIEW REPAIR is implementation authority only for the concrete repair findings already inside approved scope.
- It does not authorize scope expansion.
- It does not supersede unrelated GPT_SPEC constraints.
- Implement the concrete Final GPT findings before emitting READY_FOR_AUDIT.
- If the repair cannot be completed honestly inside approved scope, emit BLOCKED rather than READY_FOR_AUDIT.
"""
    scope_context = ""
    if role == "impl":
        from agentbus.decision import scope_failure_route

        scope_failure = scope_failure_route(state)
        if scope_failure and scope_failure.get("scope_failure_kind") == "CODER_SCOPE_VIOLATION":
            unexpected = ", ".join(str(item) for item in (scope_failure.get("unexpected_paths") or []))
            approved = ", ".join(str(item) for item in (scope_failure.get("approved_paths") or [])) or "the materialized scope"
            scope_context = f"""
Previous publication attempt was rejected by the AgentBus scope fence.
Rejected paths: {unexpected or '(recorded scope violation)'}
Approved paths: {approved}
This is an IMPL retry, not permission to expand scope. Do not modify the rejected paths or any other unapproved file. Continue the same generation only within the approved scope; if the approved scope cannot satisfy the authority, emit BLOCKED rather than pretending the result is publishable.
"""
    takeover = ""
    interruption = state.get("codex_interruption") or {}
    if (
        role == "impl"
        and interruption.get("kind") == "INTERRUPTED_CAPACITY"
        and interruption.get("work_key") == impl_work_key(state)
    ):
        takeover = """
Previous IMPL invocation stopped because Codex capacity was exhausted.
The existing worktree may contain partial uncommitted work.
Inspect and continue it. Do not restart blindly. Do not discard correct existing changes.
This is the same implementation generation; publish one complete CODEX_REPORT only when finished.
"""
    return f"""Yuvi agent-bus role assignment.

STREAM: {state.get("stream_id")}
ROLE: {role.upper()}
PR: {state.get("pr") or "(none)"}
PHASE: {state.get("phase")}
CURRENT HEAD: {(state.get("heads") or {}).get("current") or "-"}
SPEC_BASE_HEAD: {(state.get("heads") or {}).get("spec_base") or "-"}
IMPLEMENTED_HEAD: {(state.get("heads") or {}).get("implemented") or "-"}
PROTOCOL FILE: {protocol_path}

{duties}
{takeover}
{repair_context}
{scope_context}

Read AGENTS.md and {protocol_path} if present.

Latest HUMAN_NOTE:
{note}

Latest GPT_SPEC:
{spec}

Latest GPT_REVIEW:
{review}

Latest CODEX_REPORT:
{report}

Latest CODEX_AUDIT:
{audit}

Your final message MUST contain a {required} envelope using the protocol fields.
"""


def reject_noop_repair(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
    *,
    slot_name: str,
    workdir: str,
    work_key: str,
    output: str,
    env: dict[str, str] | None,
    out: TextIO,
) -> int:
    """Reject READY_FOR_AUDIT when a required repair did not advance HEAD."""

    from agentbus.codexpool import mark_failure, pool_status

    reason = "Final GPT REPAIR produced READY_FOR_AUDIT without advancing the reviewed HEAD"
    failure = mark_failure(ctx, slot_name, output, env=env)
    status = pool_status(ctx, env)
    state["status"]["impl"] = "INTERRUPTED_FAILED"
    state["codex_interruption"] = {
        "kind": "INTERRUPTED_FAILED",
        "role": "impl",
        "slot": slot_name,
        "work_key": work_key,
        "dirty": False,
        "head": head_sha(workdir),
        "no_op_repair": True,
        "reason": reason,
        "at": utc_now(),
    }
    if status.get("available"):
        refresh_next(state)
        store.save(state)
        out.write(f"Git publication: rejected no-op repair ({reason}); retrying same generation.\n")
        return 75

    slots = list((status.get("slots") or {}).values())
    deadlines = [str(item.get("next_probe_at")) for item in slots if item.get("next_probe_at")]
    state["wait"] = {
        "kind": "RUNNER_TEMPORARY",
        "reason": "both Codex slots produced no-change Final GPT repairs; waiting before reprobe",
        "until": min(deadlines) if deadlines else failure.get("next_probe_at"),
        "set_at": utc_now(),
    }
    refresh_next(state)
    store.save(state)
    out.write("Both Codex slots produced no-change repairs; waiting before bounded reprobe.\n")
    return 75


def invoke_codex(
    ctx: RepoContext,
    store: StreamStore,
    state: dict[str, Any],
    role: str,
    *,
    env: dict[str, str] | None = None,
    out: TextIO,
) -> int:
    from agentbus.codexpool import acquire_slot, pool_status, release_slot

    role_cfg = (state.get("roles") or {}).get(role) or {}
    capacity_takeover = False
    if role == "audit":
        request = state.get("audit_request") or {}
        implemented = request.get("target") if request.get("status") == "pending" else None
        implemented = implemented or (state.get("heads") or {}).get("implemented")
        if not implemented:
            raise AgentbusError("cannot start AUDIT without IMPLEMENTED_HEAD")
        workdir = ensure_audit_worktree(
            store, state, repo_root=ctx.repo_root, implemented_head=implemented
        )
        if state["phase"] == READY_FOR_AUDIT:
            set_phase(state, AUDITING, reason="audit runner start")
    else:
        workdir = state.get("impl_worktree")
        if not workdir:
            raise AgentbusError(
                "stream has no impl worktree; bind one with "
                "`agentctl create ... --worktree PATH` or `--create-worktree`. "
                "Refusing to use the current checkout."
            )
        if not os.path.isdir(workdir):
            raise AgentbusError(f"impl worktree missing: {workdir}")
        interruption = state.get("codex_interruption") or {}
        capacity_takeover = bool(
            is_dirty(workdir)
            and interruption.get("kind") == "INTERRUPTED_CAPACITY"
            and interruption.get("role") == "impl"
            and interruption.get("work_key") == impl_work_key(state)
        )
        if is_dirty(workdir) and not capacity_takeover:
            raise AgentbusError(
                "impl worktree is dirty; refusing to start Codex. "
                "Publish existing changes with `agentctl publish STREAM --recover`."
            )
        spec = (state.get("envelopes") or {}).get("GPT_SPEC")
        current = head_sha(workdir)
        if spec and spec.get("head"):
            fence = fence_spec(workdir, spec.get("head"), current)
            if not fence.ok:
                from agentbus.machine import RE_REVIEW_REQUIRED

                state["status"]["blocker"] = fence.reason
                set_phase(state, RE_REVIEW_REQUIRED, reason=fence.reason)
                store.save(state)
                out.write(f"SHA fence blocked IMPL: {fence.reason}\n")
                return 2
        if state["phase"] != IMPLEMENTING:
            set_phase(state, IMPLEMENTING, reason="impl runner start")
        runtime = store.load_runtime()
        runtime.setdefault(role, {})
        previous = runtime.get(role) or {}
        if capacity_takeover:
            runtime[role]["baseline_head"] = previous.get("baseline_head") or current or head_sha(workdir)
            runtime[role]["clean_at_start"] = previous.get("clean_at_start", False)
        else:
            runtime[role]["baseline_head"] = current or head_sha(workdir)
            runtime[role]["clean_at_start"] = not is_dirty(workdir)
        runtime[role]["capacity_takeover"] = capacity_takeover
        store.save_runtime(runtime)

    acquired = acquire_slot(
        ctx,
        stream=state.get("stream_id") or store.stream_id,
        role=role,
        profile=role_cfg.get("profile"),
        env=env,
    )
    if not acquired.get("ok"):
        status = pool_status(ctx, env)
        deadlines = [
            str(slot.get("next_probe_at"))
            for slot in (status.get("slots") or {}).values()
            if slot.get("next_probe_at")
        ]
        until = min(deadlines) if deadlines else (
            datetime.now(timezone.utc) + timedelta(seconds=30)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        state["wait"] = {
            "kind": "CODEX_CAPACITY" if any(
                slot == "COOLDOWN" for slot in (acquired.get("statuses") or {}).values()
            ) else "CODEX_BUSY",
            "reason": acquired.get("reason"),
            "until": until,
            "set_at": utc_now(),
        }
        refresh_next(state)
        store.save(state)
        out.write(f"CodexPool WAIT: {acquired.get('reason')}\n")
        return 75
    slot_name = str(acquired["slot"])
    invocation_env = acquired["env"]
    if (state.get("wait") or {}).get("kind") in {"CODEX_CAPACITY", "CODEX_BUSY", "RUNNER_TEMPORARY"}:
        state.pop("wait", None)

    from agentbus.campaign import infer_campaign_id, load_campaign

    campaign = load_campaign(ctx, infer_campaign_id(state))
    final_repair = final_repair_authority(state, campaign) if role == "impl" else None
    protocol_path = os.path.join(ctx.repo_root, ".ai", "HANDOFF_PROTOCOL.md")
    if not os.path.isfile(protocol_path):
        # Runner may execute from another worktree of the same repo.
        here = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".ai", "HANDOFF_PROTOCOL.md"))
        if os.path.isfile(here):
            protocol_path = here
    prompt = build_prompt(state, role, protocol_path, campaign=campaign)
    last_message = store.artifact_path(f"{role}.last-message.md")
    atomic_write_text(last_message, "")
    argv = build_codex_argv(
        role_cfg=role_cfg,
        workdir=workdir,
        prompt=prompt,
        last_message_path=last_message,
        env=invocation_env,
    )
    argv[0] = _codex_bin(invocation_env)
    log_path = store.log_path(role)
    append_text(
        log_path,
        f"\n===== {utc_now()} start {role} slot={slot_name} model={effective_role_label(role_cfg, invocation_env)} cwd={workdir} =====\n"
        f"cmd: {' '.join(argv[:12])} ...\n",
    )
    store.append_event(
        "invoke",
        {
            "role": role,
            "phase_before": state["phase"],
            "head_before": head_sha(workdir),
            "model": role_cfg.get("model"),
            "effort": role_cfg.get("effort"),
            "profile": role_cfg.get("profile"),
            "sandbox": role_cfg.get("sandbox"),
            "codex_slot": slot_name,
        },
    )
    out.write(f"\nInvoking Codex ({role}) on {slot_name} with {effective_role_label(role_cfg, invocation_env)}\n")
    out.write(f"workdir: {workdir}\n")
    out.flush()
    runtime = store.load_runtime()
    previous_slot = dict(runtime.get(role) or {})
    try:
        proc = subprocess.Popen(
            argv,
            cwd=workdir,
            env=invocation_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except Exception:
        release_slot(ctx, slot_name, env=env)
        raise
    runtime[role] = {
        "pid": proc.pid,
        "start_token": pid_start_token(proc.pid),
        "started_at": utc_now(),
        "cmd": argv,
        "attempt_id": utc_now(),
        "last_exit": None,
        "baseline_head": previous_slot.get("baseline_head"),
        "clean_at_start": previous_slot.get("clean_at_start"),
        "capacity_takeover": previous_slot.get("capacity_takeover", False),
        "codex_slot": slot_name,
    }
    store.save_runtime(runtime)
    store.save(state)
    assert proc.stdout is not None
    output_lines: list[str] = []
    for line in proc.stdout:
        output_lines.append(line)
        out.write(line)
        append_text(log_path, line.rstrip("\n"))
    code = proc.wait()
    runtime = store.load_runtime()
    runtime[role]["last_exit"] = code
    runtime[role]["pid"] = None
    runtime[role]["start_token"] = None
    store.save_runtime(runtime)
    append_text(log_path, f"===== {utc_now()} exit {code} =====")
    store.append_event(
        "invoke_done",
        {
            "role": role,
            "exit": code,
            "head_after": head_sha(workdir),
            "phase_after": state["phase"],
        },
    )

    text = ""
    if os.path.isfile(last_message):
        with open(last_message, encoding="utf-8") as handle:
            text = handle.read()
    kinds = ("CODEX_REPORT", "BLOCKER") if role == "impl" else ("CODEX_AUDIT", "BLOCKER")
    combined_output = "".join(output_lines)
    envelope = extract_first_envelope(text, kinds) or extract_first_envelope(combined_output, kinds)
    from agentbus.codexpool import (
        CAPACITY_WAIT,
        RETRYABLE_TRANSIENT,
        classify_invocation,
        mark_capacity,
        mark_failure,
    )

    classification = classify_invocation(code, combined_output + "\n" + text)
    if classification == CAPACITY_WAIT:
        mark_capacity(ctx, slot_name, combined_output + "\n" + text, env=env)
    elif envelope is not None:
        release_slot(ctx, slot_name, success=True, env=env)
    elif classification == RETRYABLE_TRANSIENT:
        release_slot(ctx, slot_name, env=env)
    # FAILED/no-artifact keeps the reservation until mark_failure atomically
    # converts this exact slot to COOLDOWN below. Releasing first would let a
    # concurrent runner acquire it in the gap.
    if envelope is None:
        if classification == CAPACITY_WAIT:
            status = pool_status(ctx, env)
            dirty = bool(role == "impl" and is_dirty(workdir))
            state["status"][role] = "INTERRUPTED_CAPACITY"
            state["codex_interruption"] = {
                "kind": "INTERRUPTED_CAPACITY",
                "role": role,
                "slot": slot_name,
                "work_key": impl_work_key(state) if role == "impl" else audit_work_key(state),
                "dirty": dirty,
                "head": head_sha(workdir),
                "at": utc_now(),
            }
            if not status.get("available"):
                deadlines = [
                    str(slot.get("next_probe_at"))
                    for slot in (status.get("slots") or {}).values()
                    if slot.get("next_probe_at")
                ]
                state["wait"] = {
                    "kind": "CODEX_CAPACITY",
                    "reason": "both Codex accounts are cooling down",
                    "until": min(deadlines) if deadlines else None,
                    "set_at": utc_now(),
                }
            refresh_next(state)
            store.save(state)
            out.write(
                f"Codex {slot_name} capacity exhausted; preserved "
                f"{'dirty' if dirty else 'clean'} worktree for same-generation failover.\n"
            )
            return 75
        if classification == RETRYABLE_TRANSIENT:
            state["status"][role] = "WAITING"
            state["wait"] = {
                "kind": "RUNNER_TEMPORARY",
                "reason": f"{role} invocation hit a transient transport error",
                "until": (datetime.now(timezone.utc) + timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "set_at": utc_now(),
            }
            refresh_next(state)
            store.save(state)
            out.write("Codex invocation hit a transient error; waiting before retry.\n")
            return 75
        dirty = bool(role == "impl" and is_dirty(workdir))
        failure = mark_failure(ctx, slot_name, combined_output + "\n" + text, env=env)
        if dirty:
            state["status"][role] = "CRASHED"
            state["status"]["blocker"] = (
                f"{role} produced no valid envelope and left a dirty worktree (exit {code}); "
                "non-capacity account takeover is intentionally disabled"
            )
            set_phase(state, RECOVERY_REQUIRED, reason="ambiguous dirty role failure")
            store.save(state)
            out.write(state["status"]["blocker"] + "\n")
            return code or 1
        status = pool_status(ctx, env)
        state["status"][role] = "INTERRUPTED_FAILED"
        state["codex_interruption"] = {
            "kind": "INTERRUPTED_FAILED",
            "role": role,
            "slot": slot_name,
            "work_key": impl_work_key(state) if role == "impl" else audit_work_key(state),
            "dirty": False,
            "head": head_sha(workdir),
            "at": utc_now(),
        }
        if status.get("available"):
            refresh_next(state)
            store.save(state)
            out.write(f"Codex {slot_name} failed without an artifact; retrying the same clean generation on the other slot.\n")
            return 75
        slots = list((status.get("slots") or {}).values())
        permanently_unusable = bool(slots) and all(int(item.get("failure_count") or 0) >= 3 for item in slots)
        if permanently_unusable:
            state["status"][role] = "CRASHED"
            state["status"]["blocker"] = "both Codex accounts repeatedly failed for a non-capacity reason"
            set_phase(state, RECOVERY_REQUIRED, reason="Codex pool permanently unusable")
            store.save(state)
            out.write(state["status"]["blocker"] + "\n")
            return code or 1
        deadlines = [str(item.get("next_probe_at")) for item in slots if item.get("next_probe_at")]
        state["wait"] = {
            "kind": "RUNNER_TEMPORARY",
            "reason": "both Codex accounts failed without artifacts; waiting for a bounded reprobe",
            "until": min(deadlines) if deadlines else failure.get("next_probe_at"),
            "set_at": utc_now(),
        }
        refresh_next(state)
        store.save(state)
        out.write("Both Codex slots are cooling down after non-capacity failures; waiting before reprobe.\n")
        return 75

    current = head_sha(workdir)
    if role == "impl" and envelope.kind == "CODEX_REPORT":
        from agentbus.publish import (
            apply_published_report,
            mark_publication_failed,
            parse_claimed_paths,
            publish_implementation,
        )

        runtime = store.load_runtime()
        baseline = (runtime.get("impl") or {}).get("baseline_head") or current
        claimed = parse_claimed_paths(
            envelope.get("CHANGED_FILES") or envelope.get("FILES_CHANGED"),
            workdir,
        )
        out.write("\nCodex implementation complete.\nPublishing implementation...\n")
        published = publish_implementation(
            store,
            state,
            ctx,
            baseline_head=baseline,
            expected_paths=claimed or None,
            clean_at_start=(runtime.get("impl") or {}).get("clean_at_start"),
            capacity_takeover=bool((runtime.get("impl") or {}).get("capacity_takeover")),
            push=True,
            out_write=out.write,
            required_repair_head=repair_authority_head(final_repair),
        )
        if published.get("no_op_repair"):
            return reject_noop_repair(
                ctx,
                store,
                state,
                slot_name=slot_name,
                workdir=workdir,
                work_key=impl_work_key(state),
                output=combined_output + "\n" + text,
                env=env,
                out=out,
            )
        if not published.get("ok"):
            mark_publication_failed(
                state,
                published.get("reason") or "publication failed",
                remote_moved=bool(published.get("remote_moved")),
            )
            store.save(state)
            out.write(f"Git publication: FAILED\nReason: {published.get('reason')}\n")
            out.write("Not AUDIT-ready.\n")
            return 0 if code == 0 else code
        envelope = apply_published_report(
            store,
            state,
            commit=published["commit"],
            files=published.get("files") or [],
            worktree=workdir,
            envelope=envelope,
        )
        current = published["commit"]
        out.write(f"READY_FOR_AUDIT\nIMPLEMENTED_HEAD: {current}\n")
    else:
        apply_envelope(store, state, envelope, repo=workdir, current_head=current)
    if envelope.kind == "CODEX_REPORT":
        from agentbus.publish import ensure_durable_report

        durable = ensure_durable_report(ctx, store, state, env=env)
        if not durable.get("ok"):
            out.write(f"CODEX_REPORT durable publish: {durable.get('reason')}\n")
        else:
            out.write(f"CODEX_REPORT published to PR #{state.get('pr')} comment {durable.get('comment_id')}\n")
    elif envelope.kind == "CODEX_AUDIT":
        from agentbus.publish import ensure_durable_audit

        durable = ensure_durable_audit(ctx, store, state, env=env)
        if not durable.get("ok"):
            out.write(f"CODEX_AUDIT durable publish: {durable.get('reason')}\n")
        elif state.get("pr"):
            out.write(f"CODEX_AUDIT published to PR #{state.get('pr')} comment {durable.get('comment_id')}\n")
        refresh_next(state)
    maybe_validate(store, state)
    state.pop("codex_interruption", None)
    if (state.get("wait") or {}).get("kind") in {"CODEX_CAPACITY", "CODEX_BUSY", "RUNNER_TEMPORARY"}:
        state.pop("wait", None)
    if state.get("control") == "step":
        state["step_armed"] = False
    store.save(state)
    out.write(f"\nRecorded {envelope.kind} STATUS={envelope.status}\n")
    out.write(f"STATE now {state['phase']} NEXT {state['status'].get('next_action')}\n")
    # A complete, validated role envelope is useful even when the CLI's final
    # exit reports capacity exhaustion. The exhausted slot remains cooling.
    return 0


def poll_seconds(env: dict[str, str] | None = None) -> float:
    raw = (env or os.environ).get("YUVI_AGENTBUS_POLL")
    if not raw:
        return 2.0
    try:
        return max(0.05, float(raw))
    except ValueError:
        return 2.0


def run_role(
    ctx: RepoContext,
    store: StreamStore,
    role: str,
    *,
    once: bool = False,
    env: dict[str, str] | None = None,
    out: TextIO | None = None,
) -> int:
    import time

    from agentbus.notify import maybe_notify_transition

    out = out or sys.stdout
    register_runner(store, role)
    last_github = 0.0
    interval = sync_interval(env)
    once_failovers = 0
    while True:
        try:
            with store.lock():
                state = store.load()
                before = state.get("phase")
                do_github = bool(state.get("pr")) and (time.time() - last_github >= interval)
                notes = refresh_stream(
                    ctx,
                    store,
                    state,
                    env=env,
                    sync_github=do_github,
                )
                if do_github:
                    last_github = time.time()
                maybe_validate(store, state)
                pub = state.get("publication") or {}
                if (
                    role == "impl"
                    and pub.get("status") == "failed"
                    and state.get("phase") != RE_REVIEW_REQUIRED
                ):
                    from agentbus.gitutil import is_dirty as _dirty
                    from agentbus.github import publish_body as _publish_body
                    from agentbus.publish import apply_published_report, publish_implementation

                    impl_dir = state.get("impl_worktree")
                    pending = bool(pub.get("commit") and not pub.get("pushed"))
                    if impl_dir and (_dirty(impl_dir) or pending):
                        out.write("Retrying Git publication of existing implementation...\n")
                        published = publish_implementation(
                            store,
                            state,
                            ctx,
                            baseline_head=pub.get("baseline_head")
                            or (state.get("heads") or {}).get("current"),
                            push=True,
                            out_write=out.write,
                            lock_held=True,
                        )
                        if published.get("ok"):
                            apply_published_report(
                                store,
                                state,
                                commit=published["commit"],
                                files=published.get("files") or [],
                                worktree=impl_dir,
                                envelope=None,
                            )
                            rec = (state.get("envelopes") or {}).get("CODEX_REPORT") or {}
                            if state.get("pr") and rec.get("raw"):
                                _publish_body(state, rec["raw"], repo_root=ctx.repo_root, env=env)
                runtime = store.load_runtime()
                maybe_notify_transition(runtime, state.get("stream_id") or store.stream_id, state.get("phase") or "")
                store.save_runtime(runtime)
                store.save(state)
            try:
                from agentbus.autopilot import campaign_tick

                # Scheduler contention is a normal coalesced result.  Keep
                # the role watch moving without waiting or emitting noise.
                campaign_tick(ctx, env=env, surface="runner")
            except Exception as exc:  # noqa: BLE001 — role watch stays alive, real errors remain visible
                out.write(f"\nCampaign tick error (continuing role watch): {exc}\n")
                out.flush()
            out.write("\n" + render_banner(state, role, env=env) + "\n")
            for note in notes:
                out.write(f"- {note}\n")
            if before != state.get("phase"):
                out.write(f"Phase: {before} → {state.get('phase')}\n")
            out.flush()

            runtime = store.load_runtime()
            if role == "impl":
                latest = store.load()
                if requeue_noop_repair_generation(store, latest):
                    state = latest
                    runtime = store.load_runtime()
                    out.write(
                        "Re-queued the current Final GPT REPAIR generation after a historical no-op.\n"
                    )
            key = impl_work_key(state) if role == "impl" else audit_work_key(state)
            if role_should_work(state, role) and not already_done(runtime, role, key):
                request = state.get("audit_request") or {}
                if role == "audit" and request.get("status") == "pending":
                    out.write(
                        f"\nAudit Current\nTarget:\n{request.get('target')}\nSource:\n{request.get('source')}\n"
                    )
                elif role == "impl":
                    spec = (state.get("envelopes") or {}).get("GPT_SPEC") or {}
                    out.write(
                        "\nNew implementation authority detected.\n"
                        f"Source: GPT_SPEC\nAuthority HEAD: {spec.get('head')}\n"
                    )
                else:
                    out.write(
                        "\nNew implementation detected.\n"
                        f"IMPLEMENTED_HEAD: {(state.get('heads') or {}).get('implemented')}\n"
                    )
                out.flush()
                try:
                    with store.lock():
                        state = store.load()
                        if not role_should_work(state, role):
                            continue
                        key = impl_work_key(state) if role == "impl" else audit_work_key(state)
                    code = invoke_codex(ctx, store, state, role, env=env, out=out)
                    if code == 0:
                        mark_done(store, role, key)
                        if role == "audit":
                            with store.lock():
                                state = store.load()
                                req = state.get("audit_request")
                                if req and req.get("status") == "pending":
                                    req["status"] = "done"
                                    store.save(state)
                    runtime = store.load_runtime()
                    maybe_notify_transition(runtime, store.stream_id, store.load().get("phase") or "")
                    store.save_runtime(runtime)
                    if once and code == 75 and once_failovers < 1:
                        latest = store.load()
                        interruption = latest.get("codex_interruption") or {}
                        if interruption.get("kind") in {"INTERRUPTED_CAPACITY", "INTERRUPTED_FAILED"}:
                            from agentbus.codexpool import pool_status

                            if pool_status(ctx, env).get("available"):
                                once_failovers += 1
                                out.write("Trying the remaining CodexPool slot for the same generation.\n")
                                continue
                    if once or state.get("control") == "step":
                        return code
                    continue
                except Exception as exc:  # noqa: BLE001 — watch runner must stay alive
                    out.write(f"\nRunner error (staying alive): {exc}\n")
                    out.flush()
                    if once:
                        return 2
                    continue

            if once:
                out.write("No work for this role right now.\n")
                return 0
            out.write(waiting_banner(state, role, github=state.get("github")))
            out.flush()
            time.sleep(poll_seconds(env))
            with store.lock():
                state = store.load()
                impl = state.get("impl_worktree") or ctx.repo_root
                process_inbox(store, state, repo=impl, current_head=head_sha(impl))
                recover_stream(store, state)
                store.save(state)
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001
            out.write(f"\nWatch loop error (staying alive): {exc}\n")
            out.flush()
            time.sleep(max(poll_seconds(env), 2.0))


def force_stop(store: StreamStore, role: str | None = None) -> list[str]:
    notes: list[str] = []
    runtime = store.load_runtime()
    roles = [role] if role else ["impl", "audit"]
    for name in roles:
        slot = runtime.get(name) or {}
        pid = slot.get("pid")
        if not pid:
            continue
        if not role_process_healthy(slot):
            slot["pid"] = None
            notes.append(f"{name}: stale pid {pid} cleared")
            continue
        try:
            os.kill(int(pid), signal.SIGTERM)
            notes.append(f"{name}: sent SIGTERM to {pid}")
        except OSError as exc:
            notes.append(f"{name}: could not signal {pid}: {exc}")
    store.save_runtime(runtime)
    return notes


def launch_konsole(agentctl: str, stream_id: str, role: str, workdir: str) -> None:
    from agentbus.konsolebind import konsole_bin, role_title

    title = role_title(stream_id, role)
    argv = [
        konsole_bin(),
        "--separate",
        "--workdir",
        workdir,
        "-p",
        f"tabtitle={title}",
        "-p",
        f"LocalTabTitleFormat={title}",
        "-e",
        agentctl,
        "run",
        stream_id,
        role,
    ]
    subprocess.Popen(argv, start_new_session=True)


def print_launch_help(agentctl: str, stream_id: str, state: dict[str, Any]) -> str:
    impl_dir = state.get("impl_worktree") or "."
    audit_dir = state.get("audit_worktree") or impl_dir
    return "\n".join(
        [
            "Open two visible terminals (Konsole or otherwise):",
            "",
            f"  IMPL:  {agentctl} run {stream_id} impl",
            f"         (cwd suggestion: {impl_dir})",
            f"  AUDIT: {agentctl} run {stream_id} audit",
            f"         (cwd suggestion: {audit_dir})",
            "",
            "Optional Konsole launch:",
            f"  {agentctl} start {stream_id} --konsole",
            "",
            "Manual launch remains fully supported. GUI automation is not required.",
        ]
    )
