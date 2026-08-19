from __future__ import annotations

import multiprocessing
import os
import threading
import time
from io import StringIO
from unittest.mock import patch

from agentbus.autopilot import campaign_tick
from agentbus.campaign import campaigns_dir
from agentbus.lock import StreamLock
from agentbus.runner import run_role
from agentbus.tests.harness import AgentbusTest


def _hold_lock(path: str, ready: multiprocessing.synchronize.Event, release: multiprocessing.synchronize.Event) -> None:
    lock = StreamLock(path)
    if not lock.try_acquire():
        raise RuntimeError(f"could not acquire test lock {path}")
    try:
        ready.set()
        release.wait(10)
    finally:
        lock.release()


class TickLockTests(AgentbusTest):
    def _tick_lock_path(self) -> str:
        directory = campaigns_dir(self.ctx)
        os.makedirs(directory, exist_ok=True)
        return os.path.join(directory, "tick.lock")

    def _locked_by_other_process(self) -> tuple[multiprocessing.Process, multiprocessing.synchronize.Event]:
        context = multiprocessing.get_context("fork")
        ready = context.Event()
        release = context.Event()
        process = context.Process(target=_hold_lock, args=(self._tick_lock_path(), ready, release))
        process.start()
        self.assertTrue(ready.wait(3), "test lock holder did not become ready")
        return process, release

    def _stop_lock_holder(self, process: multiprocessing.Process, release: multiprocessing.synchronize.Event) -> None:
        release.set()
        process.join(3)
        if process.is_alive():
            process.terminate()
            process.join(3)
        self.assertFalse(process.is_alive())

    def test_existing_unlocked_tick_path_is_acquirable(self) -> None:
        self.create_stream("s1")
        path = self._tick_lock_path()
        with open(path, "a", encoding="utf-8"):
            pass
        result = campaign_tick(self.ctx, stream_id="s1", force_sync=False, surface="test")
        self.assertTrue(result["ok"])
        self.assertFalse(result.get("busy"))
        self.assertFalse(result.get("coalesced"))

    def test_held_tick_lock_coalesces_immediately(self) -> None:
        self.create_stream("s1")
        process, release = self._locked_by_other_process()
        try:
            started = time.monotonic()
            result = campaign_tick(self.ctx, stream_id="s1", force_sync=True, surface="runner")
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 1.0)
            self.assertEqual(
                result,
                {
                    "ok": True,
                    "surface": "runner",
                    "busy": True,
                    "coalesced": True,
                    "reason": "campaign tick already in progress",
                    "results": [],
                    "synced": [],
                },
            )
        finally:
            self._stop_lock_holder(process, release)

    def test_runner_tick_busy_does_not_wait_or_report_error(self) -> None:
        self.create_stream("s1")
        process, release = self._locked_by_other_process()
        try:
            output = StringIO()
            started = time.monotonic()
            code = run_role(self.ctx, self.store("s1"), "impl", once=True, env=os.environ.copy(), out=output)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 1.5)
            self.assertEqual(code, 0)
            self.assertNotIn("Runner error", output.getvalue())
            self.assertNotIn("Watch loop error", output.getvalue())
        finally:
            self._stop_lock_holder(process, release)

    def test_busy_tick_never_reaches_real_executor_launcher(self) -> None:
        self.create_stream("s1")
        process, release = self._locked_by_other_process()
        try:
            with patch(
                "agentbus.konsolebind._launch_executor_process",
                side_effect=AssertionError("busy scheduler tick launched a real executor"),
            ):
                result = campaign_tick(self.ctx, stream_id="s1", surface="runner")
            self.assertTrue(result["coalesced"])
        finally:
            self._stop_lock_holder(process, release)

    def test_concurrent_ticks_coalesce_without_duplicate_stream_tick(self) -> None:
        self.create_stream("s1")
        entered = threading.Event()
        release = threading.Event()
        calls: list[str] = []
        first_result: list[dict] = []

        def slow_tick(*args, **kwargs):
            del args, kwargs
            calls.append("s1")
            entered.set()
            self.assertTrue(release.wait(3))
            return {"stream_id": "s1", "phase": "WAITING_FOR_SPEC", "notes": []}

        def run_first() -> None:
            first_result.append(campaign_tick(self.ctx, stream_id="s1", surface="runner"))

        with patch("agentbus.autopilot.tick_stream", side_effect=slow_tick):
            thread = threading.Thread(target=run_first)
            thread.start()
            self.assertTrue(entered.wait(3))
            started = time.monotonic()
            second = campaign_tick(self.ctx, stream_id="s1", surface="webui")
            elapsed = time.monotonic() - started
            release.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertLess(elapsed, 1.0)
        self.assertTrue(second["busy"])
        self.assertTrue(second["coalesced"])
        self.assertEqual(calls, ["s1"])
        self.assertEqual(len(first_result), 1)

    def test_internal_tick_error_is_not_mislabeled_busy(self) -> None:
        self.create_stream("s1")
        with patch(
            "agentbus.autopilot.list_stream_ids_safe",
            side_effect=RuntimeError("scheduler state read failed"),
        ):
            with self.assertRaisesRegex(RuntimeError, "scheduler state read failed"):
                campaign_tick(self.ctx, stream_id="s1", surface="cli")

    def test_runner_reports_real_tick_error_but_stays_alive(self) -> None:
        self.create_stream("s1")
        output = StringIO()
        with patch(
            "agentbus.autopilot.campaign_tick",
            side_effect=RuntimeError("real scheduler failure"),
        ):
            code = run_role(self.ctx, self.store("s1"), "impl", once=True, env=os.environ.copy(), out=output)
        self.assertEqual(code, 0)
        self.assertIn("Campaign tick error", output.getvalue())
        self.assertIn("real scheduler failure", output.getvalue())
