from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import sys
import time
from typing import Iterator, Sequence

STATE_ROOT = (Path(os.environ["XDG_STATE_HOME"]).expanduser() / "yuvi-agentbus-v2" if os.environ.get("XDG_STATE_HOME") else Path.home() / ".local" / "state" / "yuvi-agentbus-v2")

from .core import Action, ActionKind, decide
from .control import route_work
from .effects import (
    EffectResult,
    dispatch_manual_gpt,
    execute_merge,
    run_prove,
    submit_gpt_response,
)
from .facts import (
    add_operator_directive,
    FactError,
    init_p,
    load_config,
    paths_for,
    read_snapshot,
)


def _proof_command(value: str) -> tuple[str, ...]:
    try:
        parsed = json.loads(value)
        if not isinstance(parsed, list):
            raise ValueError
        result = tuple(str(item) for item in parsed)
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(
            'proof command must be JSON: ["program","arg",...]'
        ) from error
    if not result:
        raise argparse.ArgumentTypeError("proof command argv cannot be empty")
    return result


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="agentbus-v2")
    root.add_argument("--state-root", type=Path, default=STATE_ROOT)
    commands = root.add_subparsers(dest="command", required=True)

    initialize = commands.add_parser("init", help="seed one immutable P_CHARTER")
    initialize.add_argument("p_id")
    initialize.add_argument("--charter", type=Path, required=True)
    initialize.add_argument("--worktree", type=Path, required=True)
    initialize.add_argument("--repository", required=True)
    initialize.add_argument("--branch", required=True)
    initialize.add_argument("--base", default="main")
    initialize.add_argument("--remote", default="origin")
    initialize.add_argument("--proof-command", action="append", type=_proof_command, default=[])
    initialize.add_argument("--required-ci-check", action="append", default=[])

    adopt = commands.add_parser(
        "adopt-pr", help="initialize a fresh P by claiming one exact existing open PR"
    )
    adopt.add_argument("p_id")
    adopt.add_argument("--charter", type=Path, required=True)
    adopt.add_argument("--worktree", type=Path, required=True)
    adopt.add_argument("--repository", required=True)
    adopt.add_argument("--pr-number", type=int, required=True)
    adopt.add_argument("--branch", required=True)
    adopt.add_argument("--base", default="main")
    adopt.add_argument("--remote", default="origin")
    adopt.add_argument("--proof-command", action="append", type=_proof_command, default=[])
    adopt.add_argument("--required-ci-check", action="append", default=[])
    adopt.add_argument("--registry", type=Path)

    tick = commands.add_parser("tick", help="reread all facts and run at most one effect")
    tick.add_argument("p_id")
    tick.add_argument("--allow-merge", action="store_true")

    watch = commands.add_parser("watch", help="poll by repeated stateless ticks")
    watch.add_argument("p_id")
    watch.add_argument("--allow-merge", action="store_true")

    schedule = commands.add_parser("schedule", help="poll all enabled registered Ps")
    schedule.add_argument("--interval", type=float, default=20.0)
    schedule.add_argument("--workers", type=int)
    schedule.add_argument("--registry", type=Path)

    web = commands.add_parser("web", help="serve the loopback operational WebUI")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=6738)
    web.add_argument("--start-scheduler", action="store_true")
    web.add_argument("--registry", type=Path)

    submit = commands.add_parser("gpt-submit", help="validate and ingest one manual GPT result")
    submit.add_argument("p_id")
    submit.add_argument("response", type=Path)

    binding = commands.add_parser(
        "set-plan-binding", help="bind one P to an exact dedicated ChatGPT PLAN conversation"
    )
    binding.add_argument("p_id")
    binding.add_argument("--url", required=True)
    binding.add_argument("--registry", type=Path)

    directive = commands.add_parser(
        "add-plan-directive", help="add one immutable operator constraint to PLAN"
    )
    directive.add_argument("p_id")
    directive.add_argument("--text", required=True)
    directive.add_argument("--replan", action="store_true")

    return root


def _action_json(action: Action) -> dict[str, object]:
    return {
        "action": action.kind.value,
        "effect_id": action.effect_id,
        "reason": action.reason,
        "payload": dict(action.payload),
    }


def _result_json(result: EffectResult) -> dict[str, object]:
    return {
        "changed": result.changed,
        "detail": result.detail,
    }


@contextmanager
def _tick_lock(lock_path: Path) -> Iterator[bool]:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def tick_once(state_root: Path, p_id: str, *, allow_merge: bool) -> tuple[Action, EffectResult | None]:
    paths = paths_for(state_root, p_id)
    with _tick_lock(paths.root / "tick.lock") as acquired:
        if not acquired:
            return Action(ActionKind.IDLE, reason="another tick holds the operational lock"), None
        config = load_config(paths)
        snapshot = read_snapshot(paths, allow_merge=allow_merge)
        action = decide(snapshot)
        result: EffectResult | None = None
        from .scheduler import load_registry

        try:
            entry = next(
                item for item in load_registry(state_root).entries if item.p_id == p_id
            )
        except (FactError, OSError, StopIteration):
            entry = None
        from .control_supervisor import drive_authorized_operations

        driven = drive_authorized_operations(
            state_root, entry, snapshot, action, allow_merge=allow_merge
        )
        if driven is not None:
            return action, driven
        if action.kind in {ActionKind.PLAN, ActionKind.JUDGE}:
            if action.kind is ActionKind.PLAN:
                if (
                    entry is not None
                    and entry.plan_conversation_url is None
                    and not entry.global_plan_fallback
                ):
                    return Action(ActionKind.IDLE, reason="AWAITING_PLAN_BINDING"), None
            result = dispatch_manual_gpt(paths, config, snapshot, action)
        elif action.kind is ActionKind.WORK:
            result = route_work(
                state_root,
                paths,
                config,
                snapshot,
                action,
                entry=entry,
                allow_merge=allow_merge,
            )
        elif action.kind is ActionKind.PROVE:
            result = run_prove(paths, config, snapshot, action)
        elif action.kind is ActionKind.MERGE:
            result = execute_merge(paths, action)
        return action, result


def _print(value: object) -> None:
    print(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False))


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "init":
            paths = init_p(
                args.state_root,
                p_id=args.p_id,
                charter_text=args.charter.read_text(encoding="utf-8"),
                worktree=args.worktree,
                repository=args.repository,
                branch=args.branch,
                base_ref=args.base,
                remote=args.remote,
                proof_commands=args.proof_command,
                required_ci_checks=args.required_ci_check,
            )
            _print({"outcome": "P_INITIALIZED", "p_id": args.p_id, "path": str(paths.root)})
            return 0
        if args.command == "adopt-pr":
            from .github import adopt_existing_pr

            paths = adopt_existing_pr(
                args.state_root,
                p_id=args.p_id,
                charter_text=args.charter.read_text(encoding="utf-8"),
                worktree=args.worktree,
                repository=args.repository,
                pr_number=args.pr_number,
                branch=args.branch,
                base_ref=args.base,
                remote=args.remote,
                proof_commands=args.proof_command,
                required_ci_checks=args.required_ci_check,
                registry=args.registry,
            )
            _print({
                "outcome": "EXISTING_PR_ADOPTED",
                "p_id": args.p_id,
                "pr_number": args.pr_number,
                "path": str(paths.root),
            })
            return 0
        if args.command == "gpt-submit":
            result = submit_gpt_response(paths_for(args.state_root, args.p_id), args.response)
            _print(_result_json(result))
            return 0
        if args.command == "set-plan-binding":
            from .scheduler import set_plan_conversation_binding

            registry = set_plan_conversation_binding(
                args.state_root, args.p_id, args.url, path=args.registry
            )
            _print({
                "outcome": "PLAN_BINDING_SET",
                "p_id": args.p_id,
                "plan_conversation_url": next(
                    item.plan_conversation_url
                    for item in registry.entries if item.p_id == args.p_id
                ),
            })
            return 0
        if args.command == "add-plan-directive":
            paths = paths_for(args.state_root, args.p_id)
            snapshot = read_snapshot(paths)
            if args.replan and not snapshot.specs:
                raise FactError("request-replan requires an existing CURRENT_SPEC")
            parent = snapshot.specs[-1].spec_id if args.replan and snapshot.specs else None
            if args.replan:
                from .scheduler import load_registry
                from .executor_pool import worktree_execution_lock

                entry = next(item for item in load_registry(args.state_root).entries if item.p_id == args.p_id)
                if entry.enabled:
                    raise FactError("request-replan requires a disabled P")
                with worktree_execution_lock(args.state_root, load_config(paths).worktree) as acquired:
                    if not acquired:
                        raise FactError("request-replan is blocked by an active WORK executor")
            directive, changed = add_operator_directive(
                paths, snapshot, args.text, parent_spec_id=parent
            )
            _print({
                "outcome": "PLAN_DIRECTIVE_ADDED" if changed else "PLAN_DIRECTIVE_PRESENT",
                "p_id": args.p_id,
                "directive_id": directive.directive_id,
                "changed": changed,
            })
            return 0
        if args.command == "tick":
            action, result = tick_once(
                args.state_root, args.p_id, allow_merge=args.allow_merge
            )
            output = _action_json(action)
            if result:
                output["effect"] = _result_json(result)
            _print(output)
            return 0
        if args.command == "watch":
            while True:
                action, result = tick_once(
                    args.state_root, args.p_id, allow_merge=args.allow_merge
                )
                output = _action_json(action)
                if result:
                    output["effect"] = _result_json(result)
                _print(output)
                if action.kind in {ActionKind.HUMAN, ActionKind.MERGE_READY, ActionKind.DONE}:
                    return 0
                if result and result.changed:
                    continue
                time.sleep(20.0)
        if args.command == "schedule":
            from .scheduler import Scheduler

            scheduler = Scheduler(
                args.state_root,
                registry_path=args.registry,
                poll_interval=args.interval,
                max_workers=args.workers,
            )
            seen_manual: set[tuple[str, str, str]] = set()

            def emit(event) -> None:
                key = (event.p_id, event.action, event.detail)
                if event.action in {ActionKind.PLAN.value, ActionKind.JUDGE.value} and not event.changed:
                    if key in seen_manual:
                        return
                    seen_manual.add(key)
                _print(event.as_dict())

            scheduler.run(on_event=emit)
            return 0
        if args.command == "web":
            from .webui import WebUIState, make_server

            state = WebUIState(args.state_root, registry_path=args.registry)
            if args.start_scheduler:
                state.start_scheduler()
            server = make_server(state, host=args.host, port=args.port)
            bound_host, bound_port = server.server_address[:2]
            print(
                f"AgentBus v2 WebUI listening on http://{bound_host}:{bound_port}/",
                flush=True,
            )
            try:
                server.serve_forever()
            finally:
                server.server_close()
                state.stop_scheduler()
            return 0
    except KeyboardInterrupt:
        return 130
    except (FactError, OSError) as error:
        _print({"error": str(error)})
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
