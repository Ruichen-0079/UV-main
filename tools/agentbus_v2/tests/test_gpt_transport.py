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
    Observation,
    Snapshot,
    SpecFact,
    WorkFact,
    decide as core_decide,
    plan_job_id,
    work_effect_id,
)
from tools.agentbus_v2.effects import EffectResult, submit_gpt_response
from tools.agentbus_v2.facts import FactError, PPaths
from tools.agentbus_v2.gpt_transport import (
    FakeGPTAdapter,
    GPTTransport,
    lane_for_action,
    lane_for_operation,
    lane_lock,
    load_lane_config,
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


def snapshot_for(p_id: str, *, pending: str | None = None) -> Snapshot:
    return Snapshot(
        p_id=p_id,
        charter_digest="c" * 64,
        expected_repository="github.com/test/repo",
        expected_branch=f"agentbus/{p_id.lower()}",
        base_ref="main",
        head=SHA,
        base=SHA,
        gpt_pending=frozenset({pending}) if pending else frozenset(),
    )


class RecordingFake(FakeGPTAdapter):
    def __init__(self, responses=None, *, started=None):
        super().__init__(responses, started=started)
        self.calls: list[tuple[str, str, str]] = []

    def send(self, lane, job_id, operation, packet_text):
        self.calls.append((lane, job_id, operation))
        return super().send(lane, job_id, operation, packet_text)


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

    def test_enabled_browser_lanes_require_distinct_conversations_and_shared_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            config = state / "gpt_lanes.json"
            base = {
                "bridge_token": "shared",
                "plan": {
                    "enabled": True,
                    "transport": "browser",
                    "conversation_url": "https://chatgpt.com/c/same",
                },
                "judge": {
                    "enabled": True,
                    "transport": "browser",
                    "conversation_url": "https://chatgpt.com/c/same#fragment",
                },
            }
            config.write_text(json.dumps(base), encoding="utf-8")
            with self.assertRaisesRegex(FactError, "distinct conversation"):
                load_lane_config(state)
            base["judge"]["conversation_url"] = "https://chatgpt.com/c/judge"
            base["judge"]["bridge_token"] = "different"
            config.write_text(json.dumps(base), encoding="utf-8")
            with self.assertRaisesRegex(FactError, "share one bridge_token"):
                load_lane_config(state)

    def test_pending_plan_dispatches_after_decide_becomes_idle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            initial = snapshot_for("P1")
            self.assertEqual(ActionKind.PLAN, core_decide(initial).kind)
            job = plan_job_id(initial)
            write_packet(paths, job, "PLAN_GPT")
            pending = replace(initial, gpt_pending=frozenset({job}))
            self.assertEqual(ActionKind.IDLE, core_decide(pending).kind)
            fake = RecordingFake({job: response(job, "PLAN_GPT", "WAIT")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=pending,
                ):
                    self.assertTrue(
                        transport.try_dispatch("P1", Action(ActionKind.PLAN, effect_id=job)).accepted
                    )
                    self.wait_result(paths.root / "gpt" / "results" / f"{job}.json")
                self.assertEqual([("plan", job, "PLAN_GPT")], fake.calls)
            finally:
                transport.close()

    def test_pending_judge_dispatches_after_decide_becomes_idle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, plan=False)
            base = snapshot_for("P1")
            spec = SpecFact("spec-" + "1" * 24, "bounded test", plan_job_id="plan-" + "2" * 24)
            work_id = work_effect_id(base, spec)
            failed = WorkFact(
                effect_id=work_id,
                spec_id=spec.spec_id,
                input_head=SHA,
                status=Observation.FAIL,
                evidence_digest="evidence",
            )
            current = replace(base, specs=(spec,), work_facts=(failed,))
            action = core_decide(current)
            self.assertEqual(ActionKind.JUDGE, action.kind)
            assert action.effect_id is not None
            write_packet(paths, action.effect_id, "JUDGE_GPT")
            pending = replace(current, gpt_pending=frozenset({action.effect_id}))
            self.assertEqual(ActionKind.IDLE, core_decide(pending).kind)
            fake = RecordingFake(
                {action.effect_id: response(action.effect_id, "JUDGE_GPT", "WAIT")}
            )
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=pending,
                ):
                    self.assertTrue(transport.try_dispatch("P1", action).accepted)
                    self.wait_result(paths.root / "gpt" / "results" / f"{action.effect_id}.json")
                self.assertEqual([("judge", action.effect_id, "JUDGE_GPT")], fake.calls)
            finally:
                transport.close()

    def test_result_race_after_lane_wait_prevents_send(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            job = "plan-" + "6" * 24
            write_packet(paths, job, "PLAN_GPT")
            pending = snapshot_for("P1", pending=job)
            fake = RecordingFake({job: response(job, "PLAN_GPT", "WAIT")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=pending,
                ):
                    with lane_lock(root / "state", "plan") as locked:
                        self.assertTrue(locked)
                        self.assertTrue(
                            transport.try_dispatch(
                                "P1", Action(ActionKind.PLAN, effect_id=job)
                            ).accepted
                        )
                        time.sleep(0.05)
                        (paths.root / "gpt" / "results" / f"{job}.json").write_text(
                            response(job, "PLAN_GPT", "WAIT"), encoding="utf-8"
                        )
                self.wait_idle(transport)
                self.assertEqual([], fake.calls)
            finally:
                transport.close()

    def test_pending_job_drift_after_lane_wait_prevents_stale_send(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            old_job, new_job = "plan-" + "7" * 24, "plan-" + "8" * 24
            write_packet(paths, old_job, "PLAN_GPT")
            write_packet(paths, new_job, "PLAN_GPT")
            snapshots = [
                snapshot_for("P1", pending=old_job),
                snapshot_for("P1", pending=new_job),
            ]
            fake = RecordingFake({old_job: response(old_job, "PLAN_GPT", "WAIT")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})

            def reread(_paths, allow_merge=False):
                return snapshots.pop(0) if snapshots else snapshot_for("P1", pending=new_job)

            try:
                with patch("tools.agentbus_v2.gpt_transport.read_snapshot", side_effect=reread):
                    with lane_lock(root / "state", "plan") as locked:
                        self.assertTrue(locked)
                        self.assertTrue(
                            transport.try_dispatch(
                                "P1", Action(ActionKind.PLAN, effect_id=old_job)
                            ).accepted
                        )
                        time.sleep(0.05)
                self.wait_idle(transport)
                self.assertEqual([], fake.calls)
            finally:
                transport.close()

    def test_stale_outbox_without_current_pending_identity_does_not_send(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            old_job, current_job = "plan-" + "9" * 24, "plan-" + "a" * 24
            write_packet(paths, old_job, "PLAN_GPT")
            fake = RecordingFake({old_job: response(old_job, "PLAN_GPT", "WAIT")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=snapshot_for("P1", pending=current_job),
                ):
                    result = transport.try_dispatch(
                        "P1", Action(ActionKind.PLAN, effect_id=old_job)
                    )
                self.assertFalse(result.accepted)
                self.assertIn("pending", result.detail)
                self.assertEqual([], fake.calls)
            finally:
                transport.close()

    def test_packet_operation_must_match_current_lane(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            job = "plan-" + "b" * 24
            write_packet(paths, job, "JUDGE_GPT")
            fake = RecordingFake({job: response(job, "PLAN_GPT", "WAIT")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=snapshot_for("P1", pending=job),
                ):
                    result = transport.try_dispatch(
                        "P1", Action(ActionKind.PLAN, effect_id=job)
                    )
                self.assertFalse(result.accepted)
                self.assertIn("operation", result.detail)
                self.assertEqual([], fake.calls)
            finally:
                transport.close()

    def test_manual_result_race_prevents_external_send(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = setup_p(root, "P1")
            write_lane_config(root, judge=False)
            job = "plan-" + "d" * 24
            write_packet(paths, job, "PLAN_GPT")
            pending = snapshot_for("P1", pending=job)
            fake = RecordingFake({job: response(job, "PLAN_GPT", "WAIT")})
            transport = GPTTransport(root / "state", adapters={"fake": fake})
            try:
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=pending,
                ):
                    with lane_lock(root / "state", "plan") as locked:
                        self.assertTrue(locked)
                        self.assertTrue(
                            transport.try_dispatch(
                                "P1", Action(ActionKind.PLAN, effect_id=job)
                            ).accepted
                        )
                        time.sleep(0.05)
                        manual = root / "manual.json"
                        manual.write_text(
                            response(job, "PLAN_GPT", "WAIT"), encoding="utf-8"
                        )
                        self.assertTrue(submit_gpt_response(paths, manual).changed)
                self.wait_idle(transport)
                self.assertEqual([], fake.calls)
            finally:
                transport.close()

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
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=snapshot_for("P1", pending=job),
                ):
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
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=snapshot_for("P1", pending=job),
                ):
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
                    with patch(
                        "tools.agentbus_v2.gpt_transport.read_snapshot",
                        return_value=snapshot_for("P1", pending=job),
                    ):
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
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=snapshot_for("P1", pending=job),
                ):
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
                    with patch(
                        "tools.agentbus_v2.gpt_transport.read_snapshot",
                        return_value=snapshot_for("P1", pending=job),
                    ):
                        self.assertTrue(transport.try_dispatch("P1", action).accepted)
                        self.wait_idle(transport)
                self.assertFalse((paths.root / "gpt" / "results" / f"{job}.json").exists())
            finally:
                transport.close()

    def test_same_lane_jobs_are_fifo_and_both_ps_progress(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_paths, second_paths = setup_p(root, "P1"), setup_p(root, "P2")
            write_lane_config(root, judge=False)
            first_job = "plan-" + "1" * 24
            second_job = "plan-" + "2" * 24
            write_packet(first_paths, first_job, "PLAN_GPT")
            write_packet(second_paths, second_job, "PLAN_GPT")
            actions = {
                "P1": Action(ActionKind.PLAN, effect_id=first_job),
                "P2": Action(ActionKind.PLAN, effect_id=second_job),
            }
            calls: list[str] = []
            first_started = threading.Event()
            release_first = threading.Event()

            class OrderedFake(FakeGPTAdapter):
                def send(self, lane, job_id, operation, packet_text):
                    calls.append(job_id)
                    if job_id == first_job:
                        first_started.set()
                        release_first.wait(3)
                    return response(job_id, operation, "WAIT")

            transport = GPTTransport(
                root / "state", adapters={"fake": OrderedFake()}, max_workers=2
            )
            try:
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    side_effect=lambda paths, allow_merge=False: snapshot_for(
                        paths.root.name,
                        pending=actions[paths.root.name].effect_id,
                    ),
                ):
                    self.assertTrue(transport.try_dispatch("P1", actions["P1"]).accepted)
                    self.assertTrue(first_started.wait(2))
                    queued = transport.try_dispatch("P2", actions["P2"])
                    self.assertTrue(queued.accepted)
                    self.assertIn("queued", queued.detail)
                    time.sleep(0.05)
                    self.assertEqual([first_job], calls)
                    release_first.set()
                    self.wait_result(
                        first_paths.root / "gpt" / "results" / f"{first_job}.json"
                    )
                    self.wait_result(
                        second_paths.root / "gpt" / "results" / f"{second_job}.json"
                    )
                self.assertEqual([first_job, second_job], calls)
            finally:
                release_first.set()
                transport.close()

    def test_close_cancels_queued_job_and_is_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_paths, second_paths = setup_p(root, "P1"), setup_p(root, "P2")
            write_lane_config(root, judge=False)
            first_job = "plan-" + "3" * 24
            second_job = "plan-" + "4" * 24
            write_packet(first_paths, first_job, "PLAN_GPT")
            write_packet(second_paths, second_job, "PLAN_GPT")
            actions = {
                "P1": Action(ActionKind.PLAN, effect_id=first_job),
                "P2": Action(ActionKind.PLAN, effect_id=second_job),
            }
            started = threading.Event()
            release = threading.Event()
            cancelled: list[object] = []

            class BlockingFake(FakeGPTAdapter):
                def send(self, lane, job_id, operation, packet_text):
                    started.set()
                    release.wait(3)
                    return response(job_id, operation, "WAIT")

            transport = GPTTransport(root / "state", adapters={"fake": BlockingFake()})
            with patch(
                "tools.agentbus_v2.gpt_transport.read_snapshot",
                side_effect=lambda paths, allow_merge=False: snapshot_for(
                    paths.root.name,
                    pending=actions[paths.root.name].effect_id,
                ),
            ):
                self.assertTrue(transport.try_dispatch("P1", actions["P1"]).accepted)
                self.assertTrue(started.wait(2))
                self.assertTrue(
                    transport.try_dispatch(
                        "P2", actions["P2"], on_complete=cancelled.append
                    ).accepted
                )
                transport.close()
                self.assertEqual(1, len(cancelled))
                self.assertFalse(cancelled[0].accepted)
                self.assertIn("closed", cancelled[0].detail)
                refused = transport.try_dispatch("P2", actions["P2"])
                self.assertFalse(refused.accepted)
                self.assertIn("closed", refused.detail)
                release.set()
                self.wait_idle(transport)

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
                    side_effect=lambda paths, allow_merge=False: snapshot_for(
                        paths.root.name,
                        pending=actions[paths.root.name].effect_id,
                    ),
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
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    side_effect=lambda paths, allow_merge=False: snapshot_for(
                        "P1", pending=current[0].effect_id
                    ),
                ):
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
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=snapshot_for("P1", pending=job),
                ):
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
                with patch(
                    "tools.agentbus_v2.gpt_transport.read_snapshot",
                    return_value=snapshot_for("P1", pending=job),
                ):
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
