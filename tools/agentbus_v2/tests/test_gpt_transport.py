from __future__ import annotations

import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from dataclasses import replace

from tools.agentbus_v2.core import (
    Action,
    ActionKind,
    GPT_PACKET_SCHEMA,
    GptResult,
    Snapshot,
    SpecFact,
    decide as core_decide,
)
from tools.agentbus_v2.effects import EffectResult, submit_gpt_response
from tools.agentbus_v2.facts import FactError, PPaths
from tools.agentbus_v2.gpt_transport import (
    FakeGPTAdapter,
    GPTTransport,
    lane_for_action,
    lane_for_operation,
    lane_lock,
)
from tools.agentbus_v2.scheduler import ProjectEntry, ProjectRegistry, Scheduler


SHA = "1" * 40


def setup_p(root: Path, p_id: str) -> PPaths:
    paths = PPaths(root / "state" / p_id)
    paths.create_dirs()
    (paths.root / "charter.md").write_text("test charter\n", encoding="utf-8")
    (paths.root / "config.json").write_text(
        json.dumps(
            {
                "p_id": p_id,
                "worktree": str(root / f"worktree-{p_id}"),
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
    return paths


def write_lane_config(root: Path, *, plan: bool = True, judge: bool = True) -> None:
    (root / "state" / "gpt_lanes.json").write_text(
        json.dumps(
            {
                "plan": {"enabled": plan, "transport": "fake"},
                "judge": {"enabled": judge, "transport": "fake"},
            }
        ),
        encoding="utf-8",
    )


def write_packet(paths: PPaths, job_id: str, operation: str) -> None:
    packet = {
        "packet_schema": GPT_PACKET_SCHEMA,
        "job_id": job_id,
        "operation": operation,
        "semantic_input": {"job_id": job_id, "operation": operation},
    }
    (paths.root / "gpt" / "outbox" / f"{job_id}.md").write_text(
        "# packet\n## SEMANTIC INPUTS\n```json\n"
        + json.dumps(packet)
        + "\n```\n",
        encoding="utf-8",
    )


def response(job_id: str, operation: str, decision: str, body: str = "bounded") -> str:
    return json.dumps(
        {
            "job_id": job_id,
            "operation": operation,
            "decision": decision,
            "body": body,
        }
    )


def snapshot_for(p_id: str) -> Snapshot:
    return Snapshot(
        p_id=p_id,
        charter_digest="c" * 64,
        expected_repository="github.com/test/repo",
        expected_branch=f"agentbus/{p_id.lower()}",
        base_ref="main",
        head=SHA,
        base=SHA,
    )


class GPTTransportTests(unittest.TestCase):
    def wait_idle(self, transport: GPTTransport, timeout: float = 3) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not any(item.get("busy") for item in transport.status() if "busy" in item):
                return
            time.sleep(0.01)
        self.fail("GPT transport remained in flight")

    def wait_result(self, path: Path, timeout: float = 3) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if path.exists():
                return
            time.sleep(0.01)
        self.fail(f"missing GPT result: {path}")

    def test_operation_mapping_is_fixed(self) -> None:
        self.assertEqual("plan", lane_for_operation("PLAN_GPT"))
        self.assertEqual("judge", lane_for_operation("JUDGE_GPT"))
        self.assertEqual("plan", lane_for_action(Action(ActionKind.PLAN)))
        self.assertEqual("judge", lane_for_action(Action(ActionKind.JUDGE)))
        self.assertIsNone(lane_for_action(Action(ActionKind.WORK)))

    def test_plan_auto_roundtrip_uses_existing_ingestion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            job = "plan-" + "a" * 24
            write_packet(paths, job, "PLAN_GPT")
            action = Action(ActionKind.PLAN, effect_id=job)
            fake = FakeGPTAdapter({job: response(job, "PLAN_GPT", "SPEC", "make the change")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with patch("tools.agentbus_v2.gpt_transport.read_snapshot", return_value=snapshot_for("P1")), \
                        patch("tools.agentbus_v2.gpt_transport.decide", return_value=action):
                    dispatched = transport.try_dispatch("P1", action)
                    self.assertTrue(dispatched.accepted)
                    self.wait_result(paths.root / "gpt" / "results" / f"{job}.json")
                loaded = json.loads(
                    (paths.root / "gpt" / "results" / f"{job}.json").read_text(encoding="utf-8")
                )
                self.assertEqual("SPEC", loaded["decision"])
                spec = SpecFact("spec-" + "a" * 24, loaded["body"], plan_job_id=job)
                next_action = core_decide(
                    replace(
                        snapshot_for("P1"),
                        specs=(spec,),
                        gpt_results=(GptResult(job, "PLAN_GPT", "SPEC", loaded["body"]),),
                    )
                )
                self.assertEqual(ActionKind.WORK, next_action.kind)
            finally:
                transport.close()

    def test_judge_auto_roundtrip_preserves_return_work_for_kernel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, plan=False)
            job = "judge-" + "b" * 24
            write_packet(paths, job, "JUDGE_GPT")
            action = Action(ActionKind.JUDGE, effect_id=job)
            fake = FakeGPTAdapter({job: response(job, "JUDGE_GPT", "RETURN_WORK", "redo work")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with patch("tools.agentbus_v2.gpt_transport.read_snapshot", return_value=snapshot_for("P1")), \
                        patch("tools.agentbus_v2.gpt_transport.decide", return_value=action):
                    self.assertTrue(transport.try_dispatch("P1", action).accepted)
                    result_path = paths.root / "gpt" / "results" / f"{job}.json"
                    self.wait_result(result_path)
                self.assertEqual("RETURN_WORK", json.loads(result_path.read_text())["decision"])
            finally:
                transport.close()

    def test_disabled_lane_keeps_manual_packet_available(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, plan=False, judge=False)
            job = "plan-" + "c" * 24
            write_packet(paths, job, "PLAN_GPT")
            transport = GPTTransport(root / "state", adapters={"fake": FakeGPTAdapter()})
            try:
                result = transport.try_dispatch("P1", Action(ActionKind.PLAN, effect_id=job))
                self.assertFalse(result.accepted)
                self.assertIn("manual", result.detail)
                self.assertTrue((paths.root / "gpt" / "outbox" / f"{job}.md").exists())
            finally:
                transport.close()

    def test_transport_failures_do_not_persist_semantic_results(self) -> None:
        failures: list[object] = [TimeoutError("timeout"), RuntimeError("crash"), "not-json"]
        for index, failure in enumerate(failures):
            with self.subTest(failure=repr(failure)), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                paths = setup_p(root, "P1")
                write_lane_config(root, judge=False)
                job = f"plan-{index:024x}"
                write_packet(paths, job, "PLAN_GPT")
                fake = FakeGPTAdapter({job: failure})  # type: ignore[arg-type]
                transport = GPTTransport(root / "state", adapters={"fake": fake})
                try:
                    action = Action(ActionKind.PLAN, effect_id=job)
                    with patch("tools.agentbus_v2.gpt_transport.read_snapshot", return_value=snapshot_for("P1")), \
                            patch("tools.agentbus_v2.gpt_transport.decide", return_value=action):
                        self.assertTrue(transport.try_dispatch("P1", action).accepted)
                        self.wait_idle(transport)
                    self.assertFalse((paths.root / "gpt" / "results" / f"{job}.json").exists())
                finally:
                    transport.close()

    def test_wrong_job_response_is_rejected_by_existing_ingestion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            job = "plan-" + "d" * 24
            write_packet(paths, job, "PLAN_GPT")
            fake = FakeGPTAdapter({job: response("plan-" + "e" * 24, "PLAN_GPT", "SPEC")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                action = Action(ActionKind.PLAN, effect_id=job)
                with patch("tools.agentbus_v2.gpt_transport.read_snapshot", return_value=snapshot_for("P1")), \
                        patch("tools.agentbus_v2.gpt_transport.decide", return_value=action):
                    self.assertTrue(transport.try_dispatch("P1", action).accepted)
                    self.wait_idle(transport)
                self.assertFalse((paths.root / "gpt" / "results" / f"{job}.json").exists())
            finally:
                transport.close()

    def test_same_lane_double_use_is_prevented_by_real_flock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            job = "plan-" + "f" * 24
            write_packet(paths, job, "PLAN_GPT")
            action = Action(ActionKind.PLAN, effect_id=job)
            fake = FakeGPTAdapter({job: response(job, "PLAN_GPT", "WAIT")}, delay=0.1)
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with lane_lock(root / "state", "plan") as locked:
                    self.assertTrue(locked)
                    with patch("tools.agentbus_v2.gpt_transport.read_snapshot", return_value=snapshot_for("P1")), \
                            patch("tools.agentbus_v2.gpt_transport.decide", return_value=action):
                        self.assertTrue(transport.try_dispatch("P1", action).accepted)
                        self.wait_idle(transport)
                self.assertFalse((paths.root / "gpt" / "results" / f"{job}.json").exists())
            finally:
                transport.close()

    def test_plan_and_judge_lanes_run_concurrently(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            p1, p2 = setup_p(root, "P1"), setup_p(root, "P2")
            write_lane_config(root)
            plan_job, judge_job = "plan-" + "1" * 24, "judge-" + "2" * 24
            write_packet(p1, plan_job, "PLAN_GPT")
            write_packet(p2, judge_job, "JUDGE_GPT")
            actions = {
                "P1": Action(ActionKind.PLAN, effect_id=plan_job),
                "P2": Action(ActionKind.JUDGE, effect_id=judge_job),
            }
            entered: set[str] = set()
            entered_lock = threading.Lock()
            both = threading.Event()
            release = threading.Event()

            class BlockingFake(FakeGPTAdapter):
                def send(self, lane, job_id, operation, packet_text):
                    with entered_lock:
                        entered.add(job_id)
                        if len(entered) == 2:
                            both.set()
                    release.wait(3)
                    return response(job_id, operation, "SPEC" if operation == "PLAN_GPT" else "RETURN_WORK")

            transport = GPTTransport(
                root / "state",
                adapters={"fake": BlockingFake()},
            )
            try:
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    side_effect=lambda paths, allow_merge=False: snapshot_for(paths.root.name),
                ), patch(
                    "tools.agentbus_v2.gpt_transport.decide",
                    side_effect=lambda snapshot: actions[snapshot.p_id],
                ):
                    self.assertTrue(transport.try_dispatch("P1", actions["P1"]).accepted)
                    self.assertTrue(transport.try_dispatch("P2", actions["P2"]).accepted)
                    self.assertTrue(both.wait(2))
                    release.set()
                    self.wait_result(p1.root / "gpt" / "results" / f"{plan_job}.json")
                    self.wait_result(p2.root / "gpt" / "results" / f"{judge_job}.json")
            finally:
                release.set()
                transport.close()

    def test_late_response_is_harmless_to_new_current_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            old_job, new_job = "plan-" + "3" * 24, "plan-" + "4" * 24
            write_packet(paths, old_job, "PLAN_GPT")
            write_packet(paths, new_job, "PLAN_GPT")
            old_action = Action(ActionKind.PLAN, effect_id=old_job)
            new_action = Action(ActionKind.PLAN, effect_id=new_job)
            started = threading.Event()
            release = threading.Event()

            class LateFake(FakeGPTAdapter):
                def send(self, lane, job_id, operation, packet_text):
                    started.set()
                    release.wait(3)
                    return response(job_id, operation, "SPEC", "old")

            current = [old_action]
            transport = GPTTransport(root / "state", adapters={"fake": LateFake()})
            try:
                with patch("tools.agentbus_v2.gpt_transport.read_snapshot", return_value=snapshot_for("P1")), \
                        patch("tools.agentbus_v2.gpt_transport.decide", side_effect=lambda _snapshot: current[0]):
                    self.assertTrue(transport.try_dispatch("P1", old_action).accepted)
                    self.assertTrue(started.wait(2))
                    current[0] = new_action
                    release.set()
                    self.wait_result(paths.root / "gpt" / "results" / f"{old_job}.json")
                self.assertFalse((paths.root / "gpt" / "results" / f"{new_job}.json").exists())
            finally:
                release.set()
                transport.close()

    def test_restart_has_no_transport_recovery_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            job = "plan-" + "7" * 24
            write_packet(paths, job, "PLAN_GPT")
            action = Action(ActionKind.PLAN, effect_id=job)
            started = threading.Event()
            release = threading.Event()

            class CrashedFake(FakeGPTAdapter):
                def send(self, lane, job_id, operation, packet_text):
                    started.set()
                    release.wait(3)
                    raise RuntimeError("simulated transport process death")

            first = GPTTransport(root / "state", adapters={"fake": CrashedFake()})
            try:
                with patch("tools.agentbus_v2.gpt_transport.read_snapshot", return_value=snapshot_for("P1")), \
                        patch("tools.agentbus_v2.gpt_transport.decide", return_value=action):
                    self.assertTrue(first.try_dispatch("P1", action).accepted)
                    self.assertTrue(started.wait(2))
                    first.close()
                    second = GPTTransport(
                        root / "state",
                        adapters={"fake": FakeGPTAdapter({job: response(job, "PLAN_GPT", "WAIT")})},
                    )
                    try:
                        # The first worker still owns the lane until it exits;
                        # no persisted SENT/RECOVERY state is consulted.
                        self.assertTrue(second.try_dispatch("P1", action).accepted)
                        self.wait_idle(second)
                        self.assertFalse((paths.root / "gpt" / "results" / f"{job}.json").exists())
                    finally:
                        second.close()
            finally:
                release.set()
                first.close()

    def test_duplicate_response_is_idempotent_and_conflict_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            job = "plan-" + "5" * 24
            write_packet(paths, job, "PLAN_GPT")
            action = Action(ActionKind.PLAN, effect_id=job)
            fake = FakeGPTAdapter({job: response(job, "PLAN_GPT", "WAIT")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with patch("tools.agentbus_v2.gpt_transport.read_snapshot", return_value=snapshot_for("P1")), \
                        patch("tools.agentbus_v2.gpt_transport.decide", return_value=action):
                    self.assertTrue(transport.try_dispatch("P1", action).accepted)
                    result_path = paths.root / "gpt" / "results" / f"{job}.json"
                    self.wait_result(result_path)
                duplicate = root / "duplicate.json"
                duplicate.write_text(response(job, "PLAN_GPT", "WAIT"), encoding="utf-8")
                self.assertFalse(submit_gpt_response(paths, duplicate).changed)
                conflict = root / "conflict.json"
                conflict.write_text(response(job, "PLAN_GPT", "HUMAN", "different"), encoding="utf-8")
                with self.assertRaises(FactError):
                    submit_gpt_response(paths, conflict)
            finally:
                transport.close()

    def test_scheduler_dispatches_gpt_without_blocking_unrelated_p(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            p1, p2 = setup_p(root, "P1"), setup_p(root, "P2")
            write_lane_config(root, judge=False)
            job = "plan-" + "6" * 24
            write_packet(p1, job, "PLAN_GPT")
            actions = {"P1": Action(ActionKind.PLAN, effect_id=job), "P2": Action(ActionKind.PROVE)}
            p2_seen = threading.Event()
            release = threading.Event()

            class WaitingFake(FakeGPTAdapter):
                def send(self, lane, job_id, operation, packet_text):
                    release.wait(3)
                    return response(job_id, operation, "WAIT")

            transport = GPTTransport(root / "state", adapters={"fake": WaitingFake()})
            registry = ProjectRegistry(
                root / "state" / "projects.json",
                (ProjectEntry("P1"), ProjectEntry("P2")),
            )

            def tick(_state, p_id, *, allow_merge):
                if p_id == "P2":
                    p2_seen.set()
                return actions[p_id], EffectResult(False, "waiting")

            scheduler = Scheduler(
                root / "state",
                registry=registry,
                tick_function=tick,
                poll_interval=0.05,
                max_workers=2,
                gpt_transport=transport,
            )
            thread = threading.Thread(target=scheduler.run, daemon=True)
            thread.start()
            try:
                self.assertTrue(p2_seen.wait(2))
            finally:
                release.set()
                scheduler.stop()
                thread.join(timeout=3)
                scheduler.close()


if __name__ == "__main__":
    unittest.main()
