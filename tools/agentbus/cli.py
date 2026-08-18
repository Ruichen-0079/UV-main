from __future__ import annotations

import argparse
import os
import sys
from typing import Any

from agentbus.apply import apply_envelope, refresh_next, set_phase

from agentbus.doctor import doctor
from agentbus.gitutil import head_sha
from agentbus.github import pr_view, publish_body, sync_stream
from agentbus.attention import classify_attention
from agentbus.config import (
    UnsupportedExecutionMode,
    discover_models,
    discover_profiles,
    effective_role_label,
    inherited_label,
    normalize_effort,
    normalize_model,
    normalize_sandbox,
    parse_execution_mode,
    parse_model_spec,
)
from agentbus.machine import PAUSED, TransitionError, describe_next, display_state
from agentbus.paths import AgentbusError, RepoContext, discover_repo, normalize_stream_id
from agentbus.protocol import Envelope, normalize_kind, parse_one, render_envelope
from agentbus.recover import recover_stream
from agentbus.render import (
    render_brief,
    render_config,
    render_inbox_item,
    render_inspect,
    render_plan,
    render_status,
    status_row,
)
from agentbus.actions import bind_browser_gpt, unbind_browser_gpt
from agentbus.konsolebind import launch_role_konsole
from agentbus.runner import force_stop, launch_konsole, print_launch_help, refresh_stream, run_role
from agentbus.store import StreamStore, iter_stores, list_stream_ids
from agentbus.util import tail_text
from agentbus.worktree import bind_or_create_impl, cleanup_stream_worktrees


def _ctx(ns: argparse.Namespace) -> RepoContext:
    start = getattr(ns, "repo", None) or os.environ.get("YUVI_AGENTBUS_REPO")
    return discover_repo(start)


def _store(ctx: RepoContext, stream_id: str) -> StreamStore:
    return StreamStore(ctx, stream_id)


def _load_locked(store: StreamStore) -> dict[str, Any]:
    with store.lock():
        state = store.load()
        recover_stream(store, state)
        return state


def cmd_doctor(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    code, text = doctor(ctx)
    sys.stdout.write(text)
    return code


def cmd_list(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    ids = list_stream_ids(ctx)
    if not ids:
        print("No streams.")
        return 0
    for stream_id in ids:
        store = _store(ctx, stream_id)
        state = store.load()
        print(f"{stream_id}\t{display_state(state['phase'], control=state.get('control') or 'running')}\tPR {state.get('pr') or '-'}")
    return 0


def _collect_rows(ctx: RepoContext) -> list[dict[str, str]]:
    rows = []
    for store in iter_stores(ctx):
        with store.lock(exclusive=False):
            state = store.load()
        impl = state.get("impl_worktree")
        head = head_sha(impl) if impl else None
        rows.append(status_row(state, current_head=head))
    return rows


def cmd_status(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    if getattr(ns, "refresh", False):
        for store in iter_stores(ctx):
            with store.lock():
                state = store.load()
                refresh_stream(ctx, store, state, sync_github=True)
                store.save(state)
    print(render_status(_collect_rows(ctx)))
    return 0


def cmd_plan(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    targets = [normalize_stream_id(ns.stream)] if ns.stream else list_stream_ids(ctx)
    if not targets:
        print("No streams.")
        return 0
    blocks = []
    for stream_id in targets:
        store = _store(ctx, stream_id)
        with store.lock(exclusive=False):
            state = store.load()
        blocks.append(render_plan(state))
    print("\n\n".join(blocks))
    return 0


def cmd_inbox(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    items = []
    for store in iter_stores(ctx):
        with store.lock(exclusive=False):
            state = store.load()
        control = state.get("control") or "running"
        phase = state.get("phase")
        if control == "paused":
            continue
        att = classify_attention(state)
        if att["human_required"] or att["browser_gpt_required"]:
            items.append((att, render_inbox_item(state)))
    if not items:
        print("ATTENTION\n\n(none)")
        return 0
    human = [text for att, text in items if att["human_required"]]
    gpt = [text for att, text in items if att["browser_gpt_required"] and not att["human_required"]]
    blocks = []
    if human:
        blocks.append("HUMAN ATTENTION\n\n" + "\n\n".join(human))
    if gpt:
        blocks.append("BROWSER GPT ATTENTION\n\n" + "\n\n".join(gpt))
    print("\n\n".join(blocks))
    return 0


def cmd_brief(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    print(render_brief(store.load()))
    return 0


def cmd_create(ns: argparse.Namespace) -> int:
    from agentbus.streamid import assert_no_create_collision, ensure_stream_aliases

    ctx = _ctx(ns)
    stream_id = normalize_stream_id(ns.stream)
    store = _store(ctx, stream_id)
    if store.exists():
        raise AgentbusError(f"stream {stream_id} already exists")
    assert_no_create_collision(ctx, stream_id)
    goal = ns.goal
    branch = ns.branch
    pr = ns.pr
    if pr:
        try:
            view = pr_view(ctx.repo_root, int(pr))
            branch = branch or view.get("headRefName")
            goal = goal or view.get("title")
        except AgentbusError as exc:
            print(f"warning: could not load PR #{pr}: {exc}", file=sys.stderr)
    state = store.initialize(goal=goal or "", pr=pr, branch=branch)
    notes = ensure_stream_aliases(ctx, state)
    notes.extend(
        bind_or_create_impl(
            store,
            state,
            repo_root=ctx.repo_root,
            requested=ns.worktree,
            create=bool(ns.create_worktree),
        )
    )
    refresh_next(state)
    store.save(state)
    print(f"created stream {stream_id}")
    if pr:
        print(f"PR: #{pr}")
    if branch:
        print(f"branch: {branch}")
    for note in notes:
        print(note)
    print()
    print(render_config(state))
    print()
    print("Next:")
    print(f"  ./scripts/agentctl config {stream_id}")
    print(f"  ./scripts/agentctl start {stream_id}")
    return 0


def cmd_start(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        state["control"] = "running"
        state["step_armed"] = False
        refresh_stream(ctx, store, state, sync_github=True)
        store.save(state)
    agentctl = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "agentctl"))
    if ns.konsole:
        impl_dir = state.get("impl_worktree") or ctx.repo_root
        try:
            launch_konsole(agentctl, state["stream_id"], "impl", impl_dir)
            launch_konsole(agentctl, state["stream_id"], "audit", impl_dir)
            print("Launched two Konsole windows.")
        except OSError as exc:
            print(f"could not launch Konsole: {exc}", file=sys.stderr)
            print(print_launch_help(agentctl, state["stream_id"], state))
            return 1
    print(print_launch_help(agentctl, state["stream_id"], state))
    return 0


def cmd_pause(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        state["control"] = "paused"
        store.append_event("pause", {"phase": state["phase"]})
        refresh_next(state)
        store.save(state)
    print(f"{state['stream_id']} paused (underlying phase {state['phase']}).")
    print("Pause prevents the next logical stage from starting.")
    print("A currently running Codex invocation is left to finish unless you force-stop.")
    return 0


def cmd_resume(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        if state["phase"] == PAUSED and state.get("prior_phase"):
            set_phase(state, state["prior_phase"], reason="resume")
        state["control"] = "running"
        store.append_event("resume", {"phase": state["phase"]})
        refresh_next(state)
        store.save(state)
    print(f"{state['stream_id']} resumed at {state['phase']}.")
    return 0


def cmd_step(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        state["control"] = "step"
        state["step_armed"] = True
        refresh_stream(ctx, store, state, sync_github=True)
        store.save(state)
    actor = (state.get("status") or {}).get("next_action") or ""
    role = "impl" if actor == "IMPL" else "audit" if actor == "AUDIT" else None
    if role:
        return run_role(ctx, store, role, once=True)
    print(f"No Codex step to run. Phase={state['phase']} next={describe_next(state['phase'], control=state.get('control') or 'running')}")
    return 0


def cmd_run(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    if not store.exists():
        raise AgentbusError(f"unknown stream {ns.stream}")
    return run_role(ctx, store, ns.role, once=bool(ns.once))


def cmd_logs(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    which = ns.which or "impl"
    if which == "events":
        path = store.events_path
    else:
        path = store.log_path(which)
    text = tail_text(path, ns.lines)
    if not text:
        print(f"(no log yet: {path})")
        return 0
    print(text, end="" if text.endswith("\n") else "\n")
    return 0


def cmd_inspect(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock(exclusive=False):
        state = store.load()
        runtime = store.load_runtime()
    print(render_inspect(state, runtime))
    print(f"\nSTATE FILE: {store.state_path}")
    print(f"EVENTS:     {store.events_path}")
    print(f"IMPL LOG:   {store.impl_log()}")
    print(f"AUDIT LOG:  {store.audit_log()}")
    return 0


def cmd_config(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        if ns.show or not sys.stdin.isatty():
            store.save(state)
            print(render_config(state))
            print()
            print("Discovered Codex models:")
            for item in discover_models():
                print(f"  {item['slug']}")
            profiles = discover_profiles()
            print("Discovered Codex profiles:")
            print("  " + (", ".join(profiles) if profiles else "(none)"))
            print(f"Global inherit: {inherited_label()}")
            return 0
        print(render_config(state))
        print()
        print("Press Enter to keep a value. Empty model/effort/profile means inherit global Codex defaults.")
        _prompt_role(state, "impl")
        _prompt_role(state, "audit")
        store.append_event("config", {"impl": state["roles"]["impl"], "audit": state["roles"]["audit"]})
        store.save(state)
    print()
    print(render_config(state))
    return 0


def _prompt_role(state: dict[str, Any], role: str) -> None:
    cfg = state["roles"][role]
    print(f"\n{role.upper()}")
    model = input(f"  model [{cfg.get('model') or 'inherit'}]: ").strip()
    effort = input(f"  effort [{cfg.get('effort') or 'inherit'}]: ").strip()
    profile = input(f"  profile [{cfg.get('profile') or '-'}]: ").strip()
    sandbox = input(f"  sandbox [{cfg.get('sandbox')}]: ").strip()
    if model.lower() in {"inherit", "-"}:
        cfg["model"] = None
    elif model:
        cfg["model"] = normalize_model(model)
    if effort.lower() in {"inherit", "-"}:
        cfg["effort"] = None
    elif effort:
        cfg["effort"] = normalize_effort(effort)
    if profile.lower() in {"inherit", "-", "none"}:
        cfg["profile"] = None
    elif profile:
        cfg["profile"] = profile
    if sandbox:
        cfg["sandbox"] = normalize_sandbox(sandbox)


def cmd_set_model(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    spec = parse_model_spec(ns.model)
    with store.lock():
        state = store.load()
        cfg = state["roles"][ns.role]
        cfg["model"] = spec["model"]
        if spec["effort"]:
            cfg["effort"] = spec["effort"]
        if ns.effort:
            cfg["effort"] = normalize_effort(ns.effort)
        store.append_event("set-model", {"role": ns.role, "model": cfg["model"], "effort": cfg["effort"]})
        store.save(state)
    print(f"{state['stream_id']} {ns.role}: {effective_role_label(cfg)}")
    return 0


def cmd_set_profile(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        value = None if ns.profile in {"-", "none", "inherit"} else ns.profile
        state["roles"][ns.role]["profile"] = value
        store.append_event("set-profile", {"role": ns.role, "profile": value})
        store.save(state)
    print(f"{state['stream_id']} {ns.role} profile={value or 'inherit'}")
    return 0


def cmd_set_effort(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        value = None if ns.effort in {"-", "inherit"} else normalize_effort(ns.effort)
        state["roles"][ns.role]["effort"] = value
        store.append_event("set-effort", {"role": ns.role, "effort": value})
        store.save(state)
    print(f"{state['stream_id']} {ns.role} effort={value or 'inherit'}")
    return 0


def cmd_set_execution_mode(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    try:
        value = None if ns.mode in {"-", "inherit"} else parse_execution_mode(ns.mode)
    except UnsupportedExecutionMode as exc:
        print(f"UNSUPPORTED_EXECUTION_MODE\n{exc}")
        return 2
    with store.lock():
        state = store.load()
        state["roles"][ns.role]["execution_mode"] = value
        store.append_event("set-execution-mode", {"role": ns.role, "execution_mode": value or "standard"})
        store.save(state)
    print(f"{state['stream_id']} {ns.role} execution_mode={value or 'standard'}")
    return 0


def cmd_campaign(ns: argparse.Namespace) -> int:
    from agentbus.autopilot import campaign_tick, enable_known_campaigns
    from agentbus.campaign import bind_explicit_campaign

    ctx = _ctx(ns)
    action = ns.campaign_action
    if action == "tick":
        result = campaign_tick(
            ctx,
            stream_id=getattr(ns, "stream", None),
            env=os.environ,
            force_sync=True,
            surface="cli",
        )
        for item in result.get("results") or []:
            print(
                f"{item.get('stream_id')}\t{item.get('phase')}\t"
                f"{(item.get('attention') or {}).get('attention_owner')}\t"
                f"{item.get('latest_authority')}"
            )
            for note in item.get("notes") or []:
                print(f"  - {note}")
        return 0
    if action == "enable":
        notes = enable_known_campaigns(ctx)
        print("\n".join(notes) or "no explicit campaigns")
        return 0
    if action == "map":
        store = _store(ctx, ns.stream)
        with store.lock():
            state = store.load()
            bind_explicit_campaign(ctx, state, ns.campaign, automation_mode="autopilot")
            store.save(state)
        print(f"{state['stream_id']} campaign={ns.campaign} automation=autopilot")
        return 0
    print("unknown campaign action")
    return 2


def cmd_set_sandbox(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        state["roles"][ns.role]["sandbox"] = normalize_sandbox(ns.sandbox)
        store.save(state)
    print(f"{state['stream_id']} {ns.role} sandbox={ns.sandbox}")
    return 0


def cmd_submit(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    if ns.file and ns.file != "-":
        with open(ns.file, encoding="utf-8") as handle:
            text = handle.read()
    else:
        text = sys.stdin.read()
    if ns.kind:
        if not text.lstrip().startswith("["):
            text = f"[{normalize_kind(ns.kind)}]\n\n{text}"
    envelope = parse_one(text)
    if not envelope.stream:
        envelope.fields["STREAM"] = normalize_stream_id(ns.stream)
    with store.lock():
        state = store.load()
        impl = state.get("impl_worktree") or ctx.repo_root
        current = head_sha(impl)
        apply_envelope(store, state, envelope, repo=impl, current_head=current, allow_stale=ns.allow_stale)
        rendered = render_envelope(envelope)
        if ns.publish and state.get("pr"):
            if not publish_body(state, rendered, repo_root=ctx.repo_root):
                print("warning: GitHub publish failed; envelope is stored locally", file=sys.stderr)
        store.save(state)
    print(f"accepted {envelope.kind} STATUS={envelope.status} HEAD={envelope.head or '-'}")
    print(f"phase: {state['phase']} next: {state['status'].get('next_action')}")
    return 0


def utc_stamp() -> str:
    from agentbus.util import utc_now

    return utc_now().replace(":", "").replace("-", "")


def cmd_sync(ns: argparse.Namespace) -> int:
    from agentbus.autopilot import campaign_tick

    ctx = _ctx(ns)
    flag = getattr(ns, "reprocess_rejected", None)
    if flag and ns.stream:
        store = _store(ctx, ns.stream)
        with store.lock():
            state = store.load()
            if flag == "*":
                reprocess = {str(item) for item in (state.get("rejected_comment_ids") or [])}
            else:
                reprocess = {str(flag)}
            notes = refresh_stream(
                ctx,
                store,
                state,
                sync_github=True,
                force_sync=True,
                reprocess_ids=reprocess,
            )
            store.save(state)
        print(f"{ns.stream}: {state['phase']}")
        for note in notes:
            print(f"  {note}")
    result = campaign_tick(ctx, env=os.environ, force_sync=True, surface="cli")
    if not result.get("results"):
        print("No streams.")
        return 0
    for item in result["results"]:
        print(f"{item.get('stream_id')}: {item.get('phase')}")
        for note in item.get("notes") or []:
            print(f"  {note}")
    return 0


def cmd_force_stop(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        notes = force_stop(store, ns.role)
        state = store.load()
        recover_stream(store, state)
        store.save(state)
    if not notes:
        print("No owned process to stop.")
    else:
        print("\n".join(notes))
    return 0


def cmd_delete(ns: argparse.Namespace) -> int:
    from agentbus.actions import delete_stream

    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    result = delete_stream(ctx, store, delete_worktrees=not ns.keep_worktrees)
    verb = "archived" if result.get("archived") else "deleted"
    print(f"{verb} {result['stream_id']} ({result['reason']})  # delete is deprecated; use archive/purge")
    for note in result.get("notes") or []:
        print(f"  {note}")
    return 0


def cmd_archive(ns: argparse.Namespace) -> int:
    from agentbus.actions import archive_stream

    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    result = archive_stream(ctx, store)
    print(f"archived {result['stream_id']}; campaign/PR/continuation anchor preserved")
    return 0


def cmd_unarchive(ns: argparse.Namespace) -> int:
    from agentbus.actions import unarchive_stream

    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    result = unarchive_stream(ctx, store)
    print(f"unarchived {result['stream_id']}")
    return 0


def cmd_purge(ns: argparse.Namespace) -> int:
    from agentbus.actions import purge_stream

    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    result = purge_stream(ctx, store, delete_worktrees=bool(ns.delete_worktrees))
    print(f"purged {result['stream_id']} ({result['reason']})")
    for note in result.get("notes") or []:
        print(f"  {note}")
    return 0


def cmd_close(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        notes = cleanup_stream_worktrees(store, state, repo_root=ctx.repo_root, delete=ns.delete_worktrees)
        state["control"] = "paused"
        store.save(state)
    print(f"closed control for {store.stream_id} (state files kept at {store.path})")
    for note in notes:
        print(note)
    return 0


def cmd_ack(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    with store.lock():
        state = store.load()
        state["status"]["blocker"] = None
        if ns.to:
            set_phase(state, ns.to.upper(), reason="human ack")
        store.append_event("ack", {"to": ns.to})
        refresh_next(state)
        store.save(state)
    print(f"{store.stream_id} acknowledged; phase {state['phase']}")
    return 0


def cmd_web(ns: argparse.Namespace) -> int:
    from agentbus.launcher import run_web
    from agentbus.web import DEFAULT_HOST, DEFAULT_PORT

    ctx = _ctx(ns)
    return run_web(
        ctx,
        host=ns.host or DEFAULT_HOST,
        port=int(ns.port or DEFAULT_PORT),
        open_browser_tab=not ns.no_open if ns.open or ns.no_open else True,
        foreground=bool(ns.foreground),
        install_desktop=bool(ns.install_desktop) or not ns.no_desktop,
    )


def cmd_bind_gpt(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    bind_browser_gpt(store, display_name=ns.name, url=ns.url, note=ns.note)
    print("Browser GPT binding updated. Workflow phase unchanged.")
    return 0


def cmd_unbind_gpt(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    unbind_browser_gpt(store)
    print("Browser GPT binding cleared. Stream remains healthy.")
    return 0


def cmd_workspace(ns: argparse.Namespace) -> int:
    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    state = store.load()
    impl = state.get("impl_worktree")
    audit = state.get("audit_worktree") or impl
    for role, directory in (("impl", impl), ("audit", audit)):
        if not directory:
            continue
        info = launch_role_konsole(store, state["stream_id"], role, directory, reuse=True)
        print(f"{role}: {'reused' if info.get('reused') else 'opened'} {info.get('title')}")
    gpt = (state.get("browser_gpt") or {}).get("url")
    if gpt:
        print(f"Browser GPT: {gpt}")
        if ns.open_gpt:
            from agentbus.launcher import open_browser

            open_browser(gpt)
    print("Role terminals stay bound. Closing them does not delete the stream.")
    return 0


def cmd_publish(ns: argparse.Namespace) -> int:
    from agentbus.actions import publish_existing_implementation

    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    result = publish_existing_implementation(
        ctx, store, reset_infra_budget=bool(ns.recover), recovery=bool(ns.recover)
    )
    print(f"published {result.get('commit')} files={result.get('files')}")
    return 0


def cmd_audit_current(ns: argparse.Namespace) -> int:
    from agentbus.actions import request_audit_current, resolve_audit_target

    ctx = _ctx(ns)
    store = _store(ctx, ns.stream)
    state = store.load()
    preview = resolve_audit_target(state)
    print(f"Target: {preview.get('target')}")
    print(f"Source: {preview.get('source')}")
    print(preview.get("reason"))
    if not preview.get("ok"):
        return 2
    if not ns.yes:
        print("Re-run with --yes to enqueue Audit Current for the existing AUDIT runner.")
        return 0
    result = request_audit_current(store, expected_target=preview.get("target"))
    print(f"enqueued {result['target']} — existing AUDIT watch runner will pick it up")
    return 0


def cmd_note(ns: argparse.Namespace) -> int:
    ns.kind = "HUMAN_NOTE"
    ns.publish = False
    ns.no_inbox = True
    ns.allow_stale = True
    if not ns.file:
        text = ns.message or ""
        if not text:
            raise AgentbusError("provide --message or --file")
        envelope = Envelope(
            kind="HUMAN_NOTE",
            fields={
                "STATUS": ns.status or "INFO",
                "STREAM": normalize_stream_id(ns.stream),
                "COMMAND": ns.command or "",
                "REASON": text,
            },
        )
        ctx = _ctx(ns)
        store = _store(ctx, ns.stream)
        with store.lock():
            state = store.load()
            apply_envelope(
                store,
                state,
                envelope,
                repo=state.get("impl_worktree") or ctx.repo_root,
                current_head=head_sha(state.get("impl_worktree") or ctx.repo_root),
                allow_stale=True,
            )
            store.save(state)
        print(f"recorded HUMAN_NOTE; phase {state['phase']}")
        return 0
    return cmd_submit(ns)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agentctl",
        description="Yuvi human-visible multi-agent orchestration. Deterministic. No runtime Grok dependency.",
    )
    parser.add_argument("--repo", help="repository path (default: current git checkout)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("doctor", help="check local tools and stream health")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("list", help="list streams")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("status", help="fast global dashboard")
    p.add_argument("--refresh", action="store_true")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("plan", help="human planning surface")
    p.add_argument("stream", nargs="?")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("inbox", help="streams needing human/GPT attention")
    p.set_defaults(func=cmd_inbox)

    p = sub.add_parser("brief", help="compact recovery brief for a new GPT session")
    p.add_argument("stream")
    p.set_defaults(func=cmd_brief)

    p = sub.add_parser("create", help="create a stream")
    p.add_argument("stream")
    p.add_argument("--pr", type=int)
    p.add_argument("--branch")
    p.add_argument("--goal")
    p.add_argument("--worktree")
    p.add_argument("--create-worktree", action="store_true")
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("start", help="unpause and print or launch role terminals")
    p.add_argument("stream")
    p.add_argument("--konsole", action="store_true")
    p.set_defaults(func=cmd_start)

    p = sub.add_parser("pause", help="prevent the next stage from starting")
    p.add_argument("stream")
    p.set_defaults(func=cmd_pause)

    p = sub.add_parser("resume", help="allow the next stage")
    p.add_argument("stream")
    p.set_defaults(func=cmd_resume)

    p = sub.add_parser("step", help="run one authorized stage")
    p.add_argument("stream")
    p.set_defaults(func=cmd_step)

    p = sub.add_parser("run", help="foreground IMPL or AUDIT runner")
    p.add_argument("stream")
    p.add_argument("role", choices=["impl", "audit"])
    p.add_argument("--once", action="store_true", help="run at most one Codex invocation then exit")
    p.add_argument("--watch", action="store_true", help="stay alive and wait for work (default if --once is not set)")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("logs", help="tail stream logs")
    p.add_argument("stream")
    p.add_argument("which", nargs="?", choices=["impl", "audit", "events"])
    p.add_argument("-n", "--lines", type=int, default=80)
    p.set_defaults(func=cmd_logs)

    p = sub.add_parser("inspect", help="raw-but-readable stream dump")
    p.add_argument("stream")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("config", help="show or edit per-stream Codex role settings")
    p.add_argument("stream")
    p.add_argument("--show", action="store_true")
    p.set_defaults(func=cmd_config)

    p = sub.add_parser("set-model", help="set IMPL or AUDIT model without touching global Codex config")
    p.add_argument("stream")
    p.add_argument("role", choices=["impl", "audit"])
    p.add_argument("model")
    p.add_argument("--effort")
    p.set_defaults(func=cmd_set_model)

    p = sub.add_parser("set-profile", help="set a Codex --profile for one role")
    p.add_argument("stream")
    p.add_argument("role", choices=["impl", "audit"])
    p.add_argument("profile")
    p.set_defaults(func=cmd_set_profile)

    p = sub.add_parser("set-effort", help="set model reasoning effort (not Codex Ultra)")
    p.add_argument("stream")
    p.add_argument("role", choices=["impl", "audit"])
    p.add_argument("effort", help="inherit|none|low|medium|high|xhigh|max")
    p.set_defaults(func=cmd_set_effort)

    p = sub.add_parser("set-execution-mode", help="set Codex execution mode (standard|ultra)")
    p.add_argument("stream")
    p.add_argument("role", choices=["impl", "audit"])
    p.add_argument("mode", help="standard|ultra")
    p.set_defaults(func=cmd_set_execution_mode)

    p = sub.add_parser("set-sandbox", help="set Codex sandbox for one role")
    p.add_argument("stream")
    p.add_argument("role", choices=["impl", "audit"])
    p.add_argument("sandbox")
    p.set_defaults(func=cmd_set_sandbox)

    p = sub.add_parser("submit", help="ingest a durable envelope from a file or stdin")
    p.add_argument("stream")
    p.add_argument("--kind")
    p.add_argument("--file")
    p.add_argument("--publish", action="store_true", help="also post to the PR when one exists")
    p.add_argument("--no-inbox", action="store_true")
    p.add_argument("--allow-stale", action="store_true")
    p.set_defaults(func=cmd_submit)

    p = sub.add_parser("sync", help="pull GitHub comments and local inbox")
    p.add_argument("stream", nargs="?")
    p.add_argument(
        "--reprocess-rejected",
        nargs="?",
        const="*",
        help="reprocess one rejected comment id, or all if omitted",
    )
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("force-stop", help="SIGTERM only the owned role process")
    p.add_argument("stream")
    p.add_argument("role", nargs="?", choices=["impl", "audit"])
    p.set_defaults(func=cmd_force_stop)

    p = sub.add_parser("close", help="pause a stream and optionally remove worktrees we created")
    p.add_argument("stream")
    p.add_argument("--delete-worktrees", action="store_true")
    p.set_defaults(func=cmd_close)

    p = sub.add_parser("delete", help="deprecated: archives MERGED/obsolete units (does not purge campaign history)")
    p.add_argument("stream")
    p.add_argument("--keep-worktrees", action="store_true", help="keep AgentBus-created worktrees")
    p.set_defaults(func=cmd_delete)

    p = sub.add_parser("archive", help="hide a MERGED/obsolete unit while keeping campaign/PR/continuation anchors")
    p.add_argument("stream")
    p.set_defaults(func=cmd_archive)

    p = sub.add_parser("unarchive", help="restore an archived unit to the default list")
    p.add_argument("stream")
    p.set_defaults(func=cmd_unarchive)

    p = sub.add_parser("purge", help="permanently remove an owned abandoned local draft only")
    p.add_argument("stream")
    p.add_argument("--delete-worktrees", action="store_true")
    p.set_defaults(func=cmd_purge)

    p = sub.add_parser("ack", help="acknowledge a blocker and optionally set phase")
    p.add_argument("stream")
    p.add_argument("--to")
    p.set_defaults(func=cmd_ack)

    p = sub.add_parser("web", help="start or open the localhost WebUI")
    p.add_argument("--open", action="store_true", help="open the browser (default)")
    p.add_argument("--no-open", action="store_true", help="do not open a browser tab")
    p.add_argument("--port", type=int)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--foreground", action="store_true", help="run the server in this terminal")
    p.add_argument("--install-desktop", action="store_true")
    p.add_argument("--no-desktop", action="store_true", help="do not write a user desktop entry")
    p.set_defaults(func=cmd_web)

    p = sub.add_parser("bind-gpt", help="store a convenience Browser GPT URL/label")
    p.add_argument("stream")
    p.add_argument("--name")
    p.add_argument("--url")
    p.add_argument("--note")
    p.set_defaults(func=cmd_bind_gpt)

    p = sub.add_parser("unbind-gpt", help="clear Browser GPT binding without touching workflow state")
    p.add_argument("stream")
    p.set_defaults(func=cmd_unbind_gpt)

    p = sub.add_parser("workspace", help="open IMPL + AUDIT Konsoles (and print GPT URL)")
    p.add_argument("stream")
    p.add_argument("--open-gpt", action="store_true")
    p.set_defaults(func=cmd_workspace)

    p = sub.add_parser("publish", help="commit/push an existing uncommitted IMPL result")
    p.add_argument("stream")
    p.add_argument("--recover", action="store_true", help="reset infra-burned repair cycles and publish")
    p.set_defaults(func=cmd_publish)

    p = sub.add_parser("audit-current", help="enqueue an independent audit of the exact IMPLEMENTED_HEAD")
    p.add_argument("stream")
    p.add_argument("--yes", action="store_true")
    p.set_defaults(func=cmd_audit_current)

    p = sub.add_parser("note", help="record a HUMAN_NOTE")
    p.add_argument("stream")
    p.add_argument("--message")
    p.add_argument("--file")
    p.add_argument("--command")
    p.add_argument("--status")
    p.set_defaults(func=cmd_note)

    p = sub.add_parser("campaign", help="campaign autopilot: tick / enable / map")
    p.add_argument("campaign_action", choices=["tick", "enable", "map"])
    p.add_argument("stream", nargs="?")
    p.add_argument("campaign", nargs="?")
    p.set_defaults(func=cmd_campaign)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    ns = parser.parse_args(argv)
    try:
        return int(ns.func(ns) or 0)
    except BrokenPipeError:
        return 0
    except AgentbusError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except TransitionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
