"""Command-line entry point for AgentBus v2."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
from pathlib import Path
import sys
import time
from typing import Iterator, Sequence

from .core import Action, ActionKind, decide
from .effects import (
    EffectResult,
    dispatch_manual_gpt,
    execute_merge,
    run_codex_work,
    run_prove,
    submit_gpt_response,
)
from .facts import (
    FactError,
    ProofCommand,
    default_state_root,
    init_p,
    load_config,
    paths_for,
    read_snapshot,
)


def _proof_command(value: str) -> ProofCommand:
    try:
        parsed = json.loads(value)
        if set(parsed) != {"name", "argv"} or not isinstance(parsed["argv"], list):
            raise ValueError
        result = ProofCommand(str(parsed["name"]), tuple(str(item) for item in parsed["argv"]))
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(
            'proof command must be JSON: {"name":"...","argv":["..."]}'
        ) from error
    if not result.name or not result.argv:
        raise argparse.ArgumentTypeError("proof command name and argv cannot be empty")
    return result


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="agentbus-v2")
    root.add_argument("--state-root", type=Path, default=default_state_root())
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
    initialize.add_argument("--no-github-ci", action="store_true")
    initialize.add_argument("--required-ci-check", action="append", default=[])
    initialize.add_argument("--context-path", action="append", default=[])
    initialize.add_argument("--context-term", action="append", default=[])

    tick = commands.add_parser("tick", help="reread all facts and run at most one effect")
    tick.add_argument("p_id")
    tick.add_argument("--allow-merge", action="store_true")

    watch = commands.add_parser("watch", help="poll by repeated stateless ticks")
    watch.add_argument("p_id")
    watch.add_argument("--allow-merge", action="store_true")
    watch.add_argument("--interval", type=float, default=20.0)

    submit = commands.add_parser("gpt-submit", help="validate and ingest one manual GPT result")
    submit.add_argument("p_id")
    submit.add_argument("response", type=Path)

    show = commands.add_parser("show", help="show the action derived from current facts")
    show.add_argument("p_id")
    show.add_argument("--allow-merge", action="store_true")
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
        "effect_ran": result.ran,
        "outcome": result.outcome,
        "detail": result.detail,
        "path": str(result.path) if result.path else None,
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
        if action.kind in {ActionKind.PLAN, ActionKind.JUDGE}:
            result = dispatch_manual_gpt(paths, config, snapshot, action)
        elif action.kind is ActionKind.WORK:
            result = run_codex_work(paths, config, snapshot, action)
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
                require_github_ci=not args.no_github_ci,
                required_ci_checks=args.required_ci_check,
                context_paths=args.context_path,
                context_terms=args.context_term,
            )
            _print({"outcome": "P_INITIALIZED", "p_id": args.p_id, "path": str(paths.root)})
            return 0
        if args.command == "gpt-submit":
            result = submit_gpt_response(paths_for(args.state_root, args.p_id), args.response)
            _print(_result_json(result))
            return 0
        if args.command == "show":
            snapshot = read_snapshot(
                paths_for(args.state_root, args.p_id), allow_merge=args.allow_merge
            )
            _print(_action_json(decide(snapshot)))
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
            if args.interval <= 0 or args.interval > 300:
                raise FactError("watch interval must be in (0, 300] seconds")
            stalled: tuple[str | None, str] | None = None
            stalled_count = 0
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
                no_progress = (
                    result is not None
                    and not result.ran
                    and result.outcome == "WORK_ABSENT"
                    and "lease" not in result.detail.lower()
                    and "drift" not in result.detail.lower()
                )
                signature = (action.effect_id, result.outcome) if no_progress and result else None
                if signature is not None and signature == stalled:
                    stalled_count += 1
                elif signature is not None:
                    stalled, stalled_count = signature, 1
                else:
                    stalled, stalled_count = None, 0
                if stalled_count >= 3:
                    _print(
                        {
                            "action": "HUMAN",
                            "error": (
                                "no-progress fuse: identical WORK facts/effect "
                                "completed three times without a durable result"
                            ),
                            "effect_id": action.effect_id,
                        }
                    )
                    return 2
                if result and result.ran:
                    continue
                time.sleep(args.interval)
    except KeyboardInterrupt:
        return 130
    except (FactError, OSError) as error:
        _print({"action": "HUMAN", "error": str(error)})
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
