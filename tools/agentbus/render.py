from __future__ import annotations

from typing import Any

from agentbus.config import effective_role_label
from agentbus.gitutil import worktree_snapshot
from agentbus.machine import describe_next, display_state, next_actor
from agentbus.models import envelope_summary
from agentbus.protocol import KINDS
from agentbus.util import short_sha


def _display_text(value: Any) -> str:
    """Normalize display-only audit paths without touching durable state."""
    from agentbus.display import sanitize_display_text

    return sanitize_display_text(str(value or ""))


def status_row(state: dict[str, Any], *, current_head: str | None = None) -> dict[str, str]:
    heads = state.get("heads") or {}
    head = current_head or heads.get("current") or heads.get("implemented") or heads.get("spec_base")
    control = state.get("control") or "running"
    phase = display_state(state.get("phase") or "", control=control)
    impl = (state.get("status") or {}).get("impl") or "-"
    audit = (state.get("status") or {}).get("audit") or "-"
    gpt = (state.get("status") or {}).get("gpt") or "-"
    nxt = (state.get("status") or {}).get("next_action") or next_actor(state, control=control)
    pr = state.get("pr")
    return {
        "STREAM": state.get("stream_id") or "-",
        "PR": f"#{pr}" if pr else "-",
        "HEAD": short_sha(head),
        "STATE": phase,
        "IMPL": impl,
        "AUDIT": audit,
        "GPT": gpt,
        "NEXT": nxt,
    }


def format_table(rows: list[dict[str, str]], columns: list[str]) -> str:
    if not rows:
        return "No streams."
    widths = {col: len(col) for col in columns}
    for row in rows:
        for col in columns:
            widths[col] = max(widths[col], len(str(row.get(col, ""))))
    header = "  ".join(col.ljust(widths[col]) for col in columns)
    sep = "  ".join("-" * widths[col] for col in columns)
    body = ["  ".join(str(row.get(col, "")).ljust(widths[col]) for col in columns) for row in rows]
    return "\n".join([header, sep, *body])


def render_status(rows: list[dict[str, str]]) -> str:
    return format_table(rows, ["STREAM", "PR", "HEAD", "STATE", "IMPL", "AUDIT", "GPT", "NEXT"])


def render_plan(state: dict[str, Any], *, env: dict[str, str] | None = None) -> str:
    impl_snap = worktree_snapshot(state.get("impl_worktree"))
    audit_snap = worktree_snapshot(state.get("audit_worktree"))
    control = state.get("control") or "running"
    phase = state.get("phase") or "-"
    visible = display_state(phase, control=control)
    roles = state.get("roles") or {}
    status = state.get("status") or {}
    envelopes = state.get("envelopes") or {}
    github = state.get("github") or {}
    lines = [
        f"STREAM:              {state.get('stream_id')}",
        f"GOAL:                {state.get('goal') or '-'}",
        f"PR:                  {('#' + str(state['pr'])) if state.get('pr') else '(none — local inbox)'}",
        f"BRANCH:              {state.get('branch') or '-'}",
        f"IMPL WORKTREE:       {impl_snap.get('path') or '-'}",
        f"AUDIT WORKTREE:      {audit_snap.get('path') or '-'}",
        f"CURRENT HEAD:        {impl_snap.get('head') or (state.get('heads') or {}).get('current') or '-'}",
        f"PHASE:               {visible}" + (f" (underlying {phase})" if visible != phase else ""),
        f"CONTROL:             {control}",
        f"LATEST AUTHORITY:    {status.get('latest_authority') or envelope_summary(envelopes.get('GPT_REVIEW') or envelopes.get('GPT_SPEC'))}",
        f"IMPL MODEL/PROFILE:  {effective_role_label(roles.get('impl') or {}, env)}",
        f"AUDIT MODEL/PROFILE: {effective_role_label(roles.get('audit') or {}, env)}",
        f"IMPL SANDBOX:        {(roles.get('impl') or {}).get('sandbox')}",
        f"AUDIT SANDBOX:       {(roles.get('audit') or {}).get('sandbox')}",
        f"IMPLEMENTATION:      {status.get('impl')}",
        f"AUDIT:               {status.get('audit')}",
        f"REPAIR CYCLES:       {state.get('repair_cycles')}/{state.get('max_repair_cycles')}",
        f"BLOCKING ISSUE:      {_display_text(status.get('blocker')) or '-'}",
        f"NEXT ACTION:         {_display_text(describe_next(state, control=control, blocker=status.get('blocker')))}",
        f"SPEC_BASE_HEAD:      {(state.get('heads') or {}).get('spec_base') or '-'}",
        f"IMPLEMENTED_HEAD:    {(state.get('heads') or {}).get('implemented') or '-'}",
        f"AUDITED_HEAD:        {(state.get('heads') or {}).get('audited') or '-'}",
        f"REVIEWED_HEAD:       {(state.get('heads') or {}).get('reviewed') or '-'}",
        f"GITHUB:              {_github_line(github)}",
        f"IMPL DIRTY:          {impl_snap.get('dirty')}",
        f"WHY:                 {_why(state)}",
        f"WHO:                 {next_actor(state, control=control)}",
        f"HUMAN INTERVENTION:  {_intervention(state)}",
    ]
    return "\n".join(lines)


def _github_line(github: dict[str, Any]) -> str:
    if github.get("unauthenticated"):
        return "unauthenticated"
    if github.get("unavailable"):
        return f"unavailable ({github.get('last_error') or 'error'})"
    if github.get("last_sync_at"):
        return f"ok @ {github['last_sync_at']}"
    return "not synced"


def _why(state: dict[str, Any]) -> str:
    status = state.get("status") or {}
    if status.get("blocker"):
        return _display_text(status["blocker"])
    phase = state.get("phase")
    control = state.get("control")
    if control == "paused":
        return "operator paused the stream; current atomic stage may finish"
    return describe_next(state, control=control or "running")


def _intervention(state: dict[str, Any]) -> str:
    phase = state.get("phase")
    control = state.get("control")
    if control == "paused":
        return "none unless you want to resume"
    if phase in {"READY_FOR_GPT", "WAITING_FOR_SPEC", "GPT_REVIEW"}:
        return "Browser GPT or human durable envelope"
    if phase in {"BLOCKED", "BLOCKED_FOR_REVIEW", "RE_REVIEW_REQUIRED", "RECOVERY_REQUIRED", "FINAL_GATE"}:
        return "yes"
    return "no — automation may continue"


def render_inbox_item(state: dict[str, Any]) -> str:
    pr = f"PR #{state['pr']}" if state.get("pr") else "no PR"
    status = state.get("status") or {}
    control = state.get("control") or "running"
    phase = display_state(state.get("phase") or "", control=control)
    lines = [
        f"{(state.get('stream_id') or '').upper()} / {pr}",
        f"STATE: {phase}",
        f"IMPL: {status.get('impl')}",
        f"AUDIT: {status.get('audit')}",
    ]
    if status.get("blocker"):
        lines.append(f"REASON: {_display_text(status['blocker'])}")
    lines.append(
        f"NEXT: {_display_text(describe_next(state, control=control, blocker=status.get('blocker')))}"
    )
    return _display_text("\n".join(lines))


def render_brief(state: dict[str, Any]) -> str:
    envelopes = state.get("envelopes") or {}
    lines = [
        f"STREAM: {state.get('stream_id')}",
        f"GOAL: {state.get('goal') or '-'}",
        f"PR: {state.get('pr') or '-'}",
        f"BRANCH: {state.get('branch') or '-'}",
        f"PHASE: {state.get('phase')}",
        f"CURRENT HEAD: {(state.get('heads') or {}).get('current') or '-'}",
        f"LATEST AUTHORITY: {(state.get('status') or {}).get('latest_authority') or '-'}",
        f"REPAIR CYCLES: {state.get('repair_cycles')}/{state.get('max_repair_cycles')}",
        f"BLOCKER: {_display_text((state.get('status') or {}).get('blocker')) or 'None'}",
        f"NEXT ACTION: {(state.get('status') or {}).get('next_action')}",
        "",
        "CURRENT SPEC:",
        _clip(envelopes.get("GPT_SPEC")),
        "",
        "CURRENT REVIEW:",
        _clip(envelopes.get("GPT_REVIEW")),
        "",
        "IMPLEMENTATION RESULT:",
        _clip(envelopes.get("CODEX_REPORT")),
        "",
        "AUDIT RESULT:",
        _clip(envelopes.get("CODEX_AUDIT")),
        "",
        "OPEN BLOCKERS:",
        _clip(envelopes.get("BLOCKER")) if envelopes.get("BLOCKER") else "(none)",
        "",
        "This brief is a convenience snapshot. Authoritative facts are the envelopes,",
        "PR comments, and git HEADs above. A new Browser GPT session should recover",
        "from this text plus the PR; it does not need the previous chat transcript.",
        "",
        "AUTOPILOT NOTE FOR BROWSER GPT:",
        "- Set REVIEW_POLICY explicitly on every GPT_SPEC / GPT_CONTINUATION.",
        "- Prefer REVIEW_POLICY: AUDIT_SUFFICIENT for low-risk, narrowly scoped",
        "  regression / test / hardening units so AgentBus can skip repeat GPT review.",
        "- Keep REVIEW_POLICY: GPT_REQUIRED for architecture, security, or scope-sensitive work.",
        "- If the next work unit after merge is already known, publish [GPT_CONTINUATION] now.",
        "- AgentBus will not invent a roadmap and will not auto-merge.",
        "- A bound ChatGPT URL is a pointer only; AgentBus never sends messages to it.",
    ]
    return "\n".join(lines)


def _clip(record: dict[str, Any] | None) -> str:
    if not record:
        return "(none)"
    raw = (record.get("raw") or "").strip()
    if raw:
        return _display_text(raw)
    return _display_text(envelope_summary(record))


def render_inspect(state: dict[str, Any], runtime: dict[str, Any]) -> str:
    lines = [render_plan(state), "", "RUNTIME:", _pretty(runtime), "", "ENVELOPES:"]
    for kind in KINDS:
        rec = (state.get("envelopes") or {}).get(kind)
        lines.append(f"- {kind}: {envelope_summary(rec)}")
    return "\n".join(lines)


def _pretty(payload: Any) -> str:
    import json

    return json.dumps(payload, indent=2, sort_keys=True)


def render_banner(state: dict[str, Any], role: str, *, env: dict[str, str] | None = None) -> str:
    roles = state.get("roles") or {}
    cfg = roles.get(role) or {}
    heads = state.get("heads") or {}
    lines = [
        "YUVI AGENT BUS",
        "",
        f"STREAM   {state.get('stream_id')}",
        f"ROLE     {role.upper()}",
        f"PR       {('#' + str(state['pr'])) if state.get('pr') else '-'}",
        f"MODEL    {effective_role_label(cfg, env)}",
        f"SANDBOX  {cfg.get('sandbox')}",
        f"WORKTREE {state.get(f'{role}_worktree') or state.get('impl_worktree')}",
        f"HEAD     {heads.get('current') or '-'}",
        f"STATE    {display_state(state.get('phase') or '', control=state.get('control') or 'running')}",
        f"AUTHORITY {(state.get('status') or {}).get('latest_authority') or '-'}",
        f"ACTION   {(state.get('status') or {}).get('next_action') or '-'}",
        f"RESULT   {(state.get('status') or {}).get(role) or '-'}",
    ]
    return _display_text("\n".join(lines))


def render_config(state: dict[str, Any], env: dict[str, str] | None = None) -> str:
    roles = state.get("roles") or {}
    lines = [
        f"{state.get('stream_id')}",
        "",
        "IMPL",
        f"  model:    {(roles.get('impl') or {}).get('model') or 'inherit'}",
        f"  effort:   {(roles.get('impl') or {}).get('effort') or 'inherit'}",
        f"  profile:  {(roles.get('impl') or {}).get('profile') or '-'}",
        f"  sandbox:  {(roles.get('impl') or {}).get('sandbox')}",
        f"  effective:{effective_role_label(roles.get('impl') or {}, env)}",
        "",
        "AUDIT",
        f"  model:    {(roles.get('audit') or {}).get('model') or 'inherit'}",
        f"  effort:   {(roles.get('audit') or {}).get('effort') or 'inherit'}",
        f"  profile:  {(roles.get('audit') or {}).get('profile') or '-'}",
        f"  sandbox:  {(roles.get('audit') or {}).get('sandbox')}",
        f"  effective:{effective_role_label(roles.get('audit') or {}, env)}",
        "",
        "Changing these settings writes only this stream's state.json.",
        "It does not modify ~/.codex/config.toml.",
    ]
    return "\n".join(lines)
