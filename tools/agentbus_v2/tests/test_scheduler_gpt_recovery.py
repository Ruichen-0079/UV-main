from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import Action, ActionKind, Snapshot
from tools.agentbus_v2.effects import EffectResult
from tools.agentbus_v2.gpt_transport import TransportResult
from tools.agentbus_v2.scheduler import ProjectEntry, ProjectRegistry, Scheduler


SHA = "1" * 40


def pending_snapshot(job_id: str) -> Snapshot:
    return Snapshot(
        p_id="P1",
        charter_digest="c" * 64,
        expected_repository="github.com/test/repo",
        expected_branch="agentbus/p1",
        base_ref="main",
        head=SHA,
        base=SHA,
        gpt_pending=frozenset({job_id}),
    )


def idle_tick(_state: Path, _p_id: str, *, allow_merge: bool):
    return Action(ActionKind.IDLE, reason="retained GPT packet already exists"), EffectResult(
        False, str(allow_merge)
    )


class RecordingTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Action, bool]] = []
        self.called = threading.Event()

    def try_dispatch(self, p_id: str, action: Action, *, allow_merge: bool = False, **_kwargs):
        self.calls.append((p_id, action, allow_merge))
        self.called.set()
        return TransportResult(True, detail="accepted")

    def close(self) -> None:
        pass


class SchedulerGPTRecoveryTests(unittest.TestCase):
    def registry(self, root: Path) -> ProjectRegistry:
        return ProjectRegistry(root / "projects.json", (ProjectEntry("P1"),))

    def test_fresh_scheduler_redispatches_retained_plan_after_idle_tick(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            registry = self.registry(root)
            job = "plan-" + "1" * 24

            # A prior scheduler process owns no durable recovery state.  Closing it
            # leaves only the exact pending GPT fact for the fresh process to reread.
            prior = Scheduler(
                state,
                registry=registry,
                tick_function=idle_tick,
                gpt_transport=RecordingTransport(),
            )
            prior.close()

            transport = RecordingTransport()
            restarted = Scheduler(
                state,
                registry=registry,
                tick_function=idle_tick,
                gpt_transport=transport,
            )
            try:
                with patch(
                    "tools.agentbus_v2.scheduler.read_snapshot",
                    return_value=pending_snapshot(job),
                ), patch(
                    "tools.agentbus_v2.scheduler.load_gpt_packet",
                    return_value={"operation": "PLAN_GPT"},
                ):
                    restarted.submit_now("P1").result(timeout=2)
                    self.assertTrue(transport.called.wait(2))

                self.assertEqual(1, len(transport.calls))
                p_id, action, allow_merge = transport.calls[0]
                self.assertEqual("P1", p_id)
                self.assertEqual(ActionKind.PLAN, action.kind)
                self.assertEqual(job, action.effect_id)
                self.assertFalse(allow_merge)
            finally:
                restarted.close()

    def test_retained_judge_pending_maps_to_judge_lane_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            job = "judge-" + "2" * 24
            transport = RecordingTransport()
            scheduler = Scheduler(
                state,
                registry=self.registry(root),
                tick_function=idle_tick,
                gpt_transport=transport,
            )
            try:
                with patch(
                    "tools.agentbus_v2.scheduler.read_snapshot",
                    return_value=pending_snapshot(job),
                ), patch(
                    "tools.agentbus_v2.scheduler.load_gpt_packet",
                    return_value={"operation": "JUDGE_GPT"},
                ):
                    scheduler.submit_now("P1").result(timeout=2)
                    self.assertTrue(transport.called.wait(2))

                self.assertEqual(ActionKind.JUDGE, transport.calls[0][1].kind)
                self.assertEqual(job, transport.calls[0][1].effect_id)
            finally:
                scheduler.close()

    def test_idle_tick_without_exact_pending_gpt_does_not_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transport = RecordingTransport()
            scheduler = Scheduler(
                root / "state",
                registry=self.registry(root),
                tick_function=idle_tick,
                gpt_transport=transport,
            )
            empty = replace(
                pending_snapshot("plan-" + "3" * 24),
                gpt_pending=frozenset(),
            )
            try:
                with patch(
                    "tools.agentbus_v2.scheduler.read_snapshot",
                    return_value=empty,
                ):
                    scheduler.submit_now("P1").result(timeout=2)
                self.assertFalse(transport.called.wait(0.05))
                self.assertEqual([], transport.calls)
            finally:
                scheduler.close()


if __name__ == "__main__":
    unittest.main()
