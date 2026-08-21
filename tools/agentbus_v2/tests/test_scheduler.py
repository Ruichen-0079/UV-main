from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from tools.agentbus_v2.core import Action, ActionKind
from tools.agentbus_v2.effects import EffectResult
from tools.agentbus_v2.executor_pool import (
    ExecutorAccount,
    account_lock,
    account_lock_path,
    worktree_execution_lock,
    worktree_lock_path,
)
from tools.agentbus_v2.facts import FactError
from tools.agentbus_v2.gpt_transport import TransportResult
from tools.agentbus_v2.scheduler import (
    ProjectEntry,
    ProjectRegistry,
    Scheduler,
    load_registry,
)


SHA = "1" * 40


def make_config(state: Path, p_id: str, worktree: Path) -> None:
    root = state / p_id
    root.mkdir(parents=True, exist_ok=True)
    (root / "config.json").write_text(
        json.dumps(
            {
                "p_id": p_id,
                "worktree": str(worktree),
                "repository": "github.com/test/repo",
                "remote": "origin",
                "branch": f"agentbus/{p_id.lower()}",
                "base_ref": "main",
                "seed_head": SHA,
                "charter_digest": "c" * 64,
                "proof_commands": [],
                "required_ci_checks": [],
            }
        ),
        encoding="utf-8",
    )


def write_registry(path: Path, entries: list[dict[str, object]]) -> None:
    path.write_text(json.dumps({"projects": entries}), encoding="utf-8")


def idle_tick(_state: Path, _p_id: str, *, allow_merge: bool):
    return Action(ActionKind.IDLE, reason="test"), EffectResult(False, str(allow_merge))


class SchedulerTests(unittest.TestCase):
    def registry(self, root: Path, *p_ids: str) -> ProjectRegistry:
        return ProjectRegistry(
            root / "projects.json",
            tuple(ProjectEntry(p_id, global_plan_fallback=True) for p_id in p_ids),
        )

    def start(self, scheduler: Scheduler):
        thread = threading.Thread(target=scheduler.run)
        thread.start()
        return thread

    def stop(self, scheduler: Scheduler, thread: threading.Thread) -> None:
        scheduler.stop()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())

    def test_two_ticks_overlap_and_long_work_does_not_block_other_p(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = self.registry(root, "P1", "P2")
            started = {p_id: threading.Event() for p_id in ("P1", "P2")}
            release = threading.Event()

            def tick(_state: Path, p_id: str, *, allow_merge: bool):
                started[p_id].set()
                release.wait(5)
                return Action(ActionKind.WORK, reason=p_id), EffectResult(False, "long")

            scheduler = Scheduler(
                root / "state", registry=registry, tick_function=tick,
                poll_interval=1, max_workers=2,
            )
            thread = self.start(scheduler)
            try:
                self.assertTrue(started["P1"].wait(2))
                self.assertTrue(started["P2"].wait(2))
            finally:
                release.set()
                self.stop(scheduler, thread)

    def test_same_p_is_never_submitted_twice(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entered = threading.Event()
            release = threading.Event()
            active = 0
            maximum = 0
            mutex = threading.Lock()

            def tick(_state: Path, _p_id: str, *, allow_merge: bool):
                nonlocal active, maximum
                with mutex:
                    active += 1
                    maximum = max(maximum, active)
                entered.set()
                release.wait(5)
                with mutex:
                    active -= 1
                return Action(ActionKind.IDLE), None

            scheduler = Scheduler(
                root / "state", registry=self.registry(root, "P1"),
                tick_function=tick, poll_interval=0.02, max_workers=2,
            )
            thread = self.start(scheduler)
            try:
                self.assertTrue(entered.wait(2))
                time.sleep(0.12)
                self.assertEqual(1, maximum)
            finally:
                release.set()
                self.stop(scheduler, thread)

    def test_manual_gpt_and_ci_absent_do_not_block_other_p(self) -> None:
        for kind, detail in ((ActionKind.PLAN, "MANUAL_GPT_REQUIRED"), (ActionKind.PROVE, "CI absent")):
            with self.subTest(kind=kind):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    p2_started = threading.Event()

                    def tick(_state: Path, p_id: str, *, allow_merge: bool):
                        if p_id == "P2":
                            p2_started.set()
                        return Action(kind), EffectResult(False, detail)

                    scheduler = Scheduler(
                        root / "state", registry=self.registry(root, "P1", "P2"),
                        tick_function=tick, poll_interval=1, max_workers=2,
                    )
                    thread = self.start(scheduler)
                    try:
                        self.assertTrue(p2_started.wait(2))
                    finally:
                        self.stop(scheduler, thread)

    def test_changed_tick_gets_one_immediate_retick_then_polling(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls: list[float] = []
            second = threading.Event()

            def tick(_state: Path, _p_id: str, *, allow_merge: bool):
                calls.append(time.monotonic())
                if len(calls) == 2:
                    second.set()
                return Action(ActionKind.WORK), EffectResult(len(calls) == 1, "fact")

            scheduler = Scheduler(
                root / "state", registry=self.registry(root, "P1"),
                tick_function=tick, poll_interval=1, max_workers=1,
            )
            thread = self.start(scheduler)
            try:
                self.assertTrue(second.wait(2))
                self.assertLess(calls[1] - calls[0], 0.5)
            finally:
                self.stop(scheduler, thread)

    def test_unchanged_tick_returns_to_bounded_polling(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls: list[float] = []

            def tick(_state: Path, _p_id: str, *, allow_merge: bool):
                calls.append(time.monotonic())
                return Action(ActionKind.IDLE), EffectResult(False, "absent")

            scheduler = Scheduler(
                root / "state", registry=self.registry(root, "P1"),
                tick_function=tick, poll_interval=0.2, max_workers=1,
            )
            thread = self.start(scheduler)
            try:
                time.sleep(0.06)
                self.assertEqual(1, len(calls))
            finally:
                self.stop(scheduler, thread)

    def test_disabled_then_reenabled_p_is_recomputed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            worktree = root / "worktree"
            worktree.mkdir()
            make_config(state, "P1", worktree)
            registry_file = root / "projects.json"
            write_registry(registry_file, [{"p_id": "P1", "enabled": False}])
            calls: list[str] = []

            def tick(_state: Path, p_id: str, *, allow_merge: bool):
                calls.append(p_id)
                return Action(ActionKind.IDLE), None

            scheduler = Scheduler(
                state, registry_path=registry_file, tick_function=tick,
                poll_interval=0.05, max_workers=1,
            )
            thread = self.start(scheduler)
            try:
                time.sleep(0.12)
                self.assertEqual([], calls)
                write_registry(registry_file, [{"p_id": "P1", "enabled": True}])
                deadline = time.monotonic() + 2
                while not calls and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual(["P1"], calls[:1])
            finally:
                self.stop(scheduler, thread)

    def test_initially_disabled_registered_p_gets_full_concurrency_when_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            for p_id in ("P1", "P2"):
                worktree = root / f"worktree-{p_id}"
                worktree.mkdir()
                make_config(state, p_id, worktree)
            registry_file = root / "projects.json"
            write_registry(
                registry_file,
                [
                    {"p_id": "P1", "enabled": True},
                    {"p_id": "P2", "enabled": False},
                ],
            )
            warm = threading.Event()
            concurrent_phase = threading.Event()
            entered = {p_id: threading.Event() for p_id in ("P1", "P2")}
            release = threading.Event()

            def tick(_state: Path, p_id: str, *, allow_merge: bool):
                if not concurrent_phase.is_set():
                    warm.set()
                    return Action(ActionKind.IDLE), EffectResult(False, "warm")
                entered[p_id].set()
                release.wait(3)
                return Action(ActionKind.IDLE), EffectResult(False, "concurrent")

            scheduler = Scheduler(
                state,
                registry_path=registry_file,
                tick_function=tick,
                poll_interval=5,
            )
            scheduler.run_once()
            self.assertTrue(warm.wait(2))
            deadline = time.monotonic() + 2
            while scheduler.is_in_flight("P1") and time.monotonic() < deadline:
                scheduler.run_once()
                time.sleep(0.01)
            write_registry(
                registry_file,
                [
                    {"p_id": "P1", "enabled": True},
                    {"p_id": "P2", "enabled": True},
                ],
            )
            concurrent_phase.set()
            thread = self.start(scheduler)
            try:
                self.assertTrue(entered["P1"].wait(2))
                self.assertTrue(entered["P2"].wait(2))
            finally:
                release.set()
                self.stop(scheduler, thread)

    def test_disable_during_tick_prevents_gpt_dispatch_and_immediate_retick(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            worktree = root / "worktree"
            worktree.mkdir()
            make_config(state, "P1", worktree)
            registry_file = root / "projects.json"
            write_registry(registry_file, [{"p_id": "P1", "enabled": True}])
            entered = threading.Event()
            release = threading.Event()
            calls: list[str] = []

            def tick(_state: Path, p_id: str, *, allow_merge: bool):
                calls.append(p_id)
                entered.set()
                release.wait(3)
                return (
                    Action(ActionKind.PLAN, effect_id="plan-" + "1" * 24),
                    EffectResult(True, "packet created"),
                )

            class RecordingTransport:
                def __init__(self) -> None:
                    self.calls: list[str] = []

                def try_dispatch(self, p_id, action, **kwargs):
                    self.calls.append(p_id)
                    return TransportResult(True)

                def close(self):
                    pass

            transport = RecordingTransport()
            scheduler = Scheduler(
                state,
                registry_path=registry_file,
                tick_function=tick,
                poll_interval=5,
                max_workers=1,
                gpt_transport=transport,
            )
            thread = self.start(scheduler)
            try:
                self.assertTrue(entered.wait(2))
                write_registry(registry_file, [{"p_id": "P1", "enabled": False}])
                release.set()
                deadline = time.monotonic() + 2
                while scheduler.is_in_flight("P1") and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(scheduler.is_in_flight("P1"))
                self.assertEqual(["P1"], calls)
                self.assertEqual([], transport.calls)
            finally:
                release.set()
                self.stop(scheduler, thread)

    def test_changed_gpt_completion_wakes_p_without_waiting_for_poll(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls: list[float] = []
            second = threading.Event()

            def tick(_state: Path, _p_id: str, *, allow_merge: bool):
                calls.append(time.monotonic())
                if len(calls) == 1:
                    return (
                        Action(ActionKind.PLAN, effect_id="plan-" + "2" * 24),
                        EffectResult(False, "pending"),
                    )
                second.set()
                return Action(ActionKind.IDLE), EffectResult(False, "observed result")

            class CompletingTransport:
                def __init__(self) -> None:
                    self.callback = None
                    self.dispatched = threading.Event()

                def try_dispatch(self, p_id, action, **kwargs):
                    self.callback = kwargs.get("on_complete")
                    self.dispatched.set()
                    return TransportResult(True)

                def close(self):
                    pass

            transport = CompletingTransport()
            scheduler = Scheduler(
                root / "state",
                registry=self.registry(root, "P1"),
                tick_function=tick,
                poll_interval=5,
                max_workers=1,
                gpt_transport=transport,
            )
            thread = self.start(scheduler)
            try:
                self.assertTrue(transport.dispatched.wait(2))
                self.assertIsNotNone(transport.callback)
                completed_at = time.monotonic()
                transport.callback(TransportResult(True, changed=True, detail="stored"))
                self.assertTrue(second.wait(2))
                self.assertLess(calls[1] - completed_at, 0.5)
            finally:
                self.stop(scheduler, thread)

    def test_allow_merge_is_passed_as_operational_permission(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values: list[bool] = []

            def tick(_state: Path, _p_id: str, *, allow_merge: bool):
                values.append(allow_merge)
                return Action(ActionKind.IDLE), None

            scheduler = Scheduler(
                root / "state", registry=self.registry(root, "P1"),
                tick_function=tick, poll_interval=1, max_workers=1,
            )
            thread = self.start(scheduler)
            try:
                deadline = time.monotonic() + 2
                while not values and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual([False], values[:1])
            finally:
                self.stop(scheduler, thread)

    def test_registry_rejects_duplicate_worktree_and_duplicate_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            shared = root / "shared"
            shared.mkdir()
            make_config(state, "P1", shared)
            make_config(state, "P2", shared)
            path = root / "projects.json"
            write_registry(path, [{"p_id": "P1"}, {"p_id": "P2"}])
            with self.assertRaises(FactError):
                load_registry(state, path)
            write_registry(path, [{"p_id": "P1"}, {"p_id": "P1"}])
            with self.assertRaises(FactError):
                load_registry(state, path)

    def test_restart_has_no_scheduler_recovery_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = self.registry(root, "P1")
            scheduler = Scheduler(root / "state", registry=registry, tick_function=idle_tick)
            scheduler.run_once()
            scheduler.close()
            self.assertFalse((root / "state" / "scheduler.json").exists())
            with self.assertRaisesRegex(RuntimeError, "closed"):
                scheduler.submit_now("P1")
            restarted = Scheduler(root / "state", registry=registry, tick_function=idle_tick)
            self.assertEqual([], restarted.status()["in_flight_p_ids"])
            restarted.close()

    def test_scheduler_sigkill_preserves_guardian_restart_fence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            worktree = root / "worktree"
            worktree.mkdir()
            marker = root / "child.pid"
            ready = root / "ready"
            parent_script = root / "scheduler_parent.py"
            parent_script.write_text(
                """
import os, sys
from pathlib import Path
from tools.agentbus_v2.core import Action, ActionKind
from tools.agentbus_v2.effects import EffectResult
from tools.agentbus_v2.executor_pool import ExecutorAccount, account_lock_path, worktree_lock_path
from tools.agentbus_v2.codex_guardian import run_guardian
from tools.agentbus_v2.scheduler import ProjectEntry, ProjectRegistry, Scheduler

state, worktree, marker, ready = map(Path, sys.argv[1:])
account = ExecutorAccount('primary', state / 'home')
mutator = [sys.executable, '-c',
    'from pathlib import Path; import os,sys,time; '
    'Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)', str(marker)]

def tick(_state, _p_id, *, allow_merge):
    ready.write_text('started')
    run_guardian(mutator, cwd=worktree, env=os.environ.copy(),
        log_path=state / 'codex.log', timeout=30,
        worktree_lock=worktree_lock_path(state, worktree),
        account_lock=account_lock_path(state, account))
    return Action(ActionKind.WORK), EffectResult(False, 'done')

scheduler = Scheduler(state, registry=ProjectRegistry(state / 'projects.json', (ProjectEntry('P1'),)),
    tick_function=tick, poll_interval=20, max_workers=1)
scheduler.run()
""",
                encoding="utf-8",
            )
            env = os.environ.copy()
            repo_root = str(Path(__file__).resolve().parents[3])
            env["PYTHONPATH"] = repo_root + os.pathsep + env.get("PYTHONPATH", "")
            parent = subprocess.Popen(
                [sys.executable, str(parent_script), str(state), str(worktree), str(marker), str(ready)],
                cwd=repo_root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            child_pid: int | None = None
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(marker.exists())
                child_pid = int(marker.read_text(encoding="utf-8"))
                os.kill(parent.pid, signal.SIGKILL)
                parent.wait(timeout=5)
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    with worktree_execution_lock(state, worktree) as acquired:
                        if acquired:
                            self.assertFalse(self._alive(child_pid))
                            break
                    time.sleep(0.02)
                else:
                    self.fail("scheduler restart could not acquire cleaned worktree lock")
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait(timeout=5)
                if child_pid is not None and self._alive(child_pid):
                    try:
                        os.killpg(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    @staticmethod
    def _alive(pid: int) -> bool:
        try:
            with open(f"/proc/{pid}/stat", encoding="ascii") as stream:
                return stream.read().split()[2] != "Z"
        except FileNotFoundError:
            return False


if __name__ == "__main__":
    unittest.main()
