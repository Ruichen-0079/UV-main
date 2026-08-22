from __future__ import annotations

from dataclasses import asdict, replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2.block_diagnosis import (
    BLOCK_OPERATION,
    BlockDiagnosisSupervisor,
    BlockResult,
    derive_operational_block,
    load_block_packet,
    parse_block_response,
    render_diagnosed_block_packet,
    set_block_config,
    submit_block_gpt_response,
    derive_diagnosed_stall_block,
)
from tools.agentbus_v2.block_recovery import (
    RecoveryRun,
    _codex_recovery_command,
    _grok_recovery_command,
    _parse_grok_json,
    _postcondition_holds,
    is_proof_as_recovery,
    recovery_id,
    run_block_recovery,
)
from tools.agentbus_v2.control import (
    CONTROL_PURPOSE_RECOVERY_ROUTE,
    CONTROL_PURPOSE_STALL_TRIAGE,
    CONTROL_PURPOSE_WORK_ROUTE,
    control_id,
    control_packet_path,
    control_result_path,
    ensure_control_request,
    load_stall_triage_context,
    set_control_config,
    submit_control_response,
)
from tools.agentbus_v2.control_supervisor import (
    STALL_THRESHOLD_SECONDS,
    ControlSupervisor,
    drive_authorized_operations,
)
from tools.agentbus_v2.core import (
    Action,
    ActionKind,
    GptResult,
    Observation,
    OperatorDirective,
    ProofFact,
    SpecFact,
    WorkFact,
    decide,
)
from tools.agentbus_v2.effects import EffectResult
from tools.agentbus_v2.facts import FactError, read_snapshot
from tools.agentbus_v2.github import GitHubFacts
from tools.agentbus_v2.readonly_diagnosis import (
    DiagnosisRun,
    _codex_diagnosis_command,
    current_diagnosis,
    diagnosis_id,
    observation_fingerprint,
    run_readonly_diagnosis,
    semantic_fact_fingerprint,
)
from tools.agentbus_v2.tests.test_control_grok import ControlFixture
from tools.agentbus_v2.core import ActionKind as CoreActionKind


class Clock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def _report(**overrides):
    value = {
        "status": "DIAGNOSED",
        "summary": "local runtime precondition is missing",
        "root_cause": "executor cannot start because a local socket is absent",
        "evidence": ["launch failed"],
        "likely_domain": "OPERATIONAL",
    }
    value.update(overrides)
    return value


def _p4_report():
    return _report(
        summary="current PR metadata base is stale versus live BASE",
        root_cause="live BASE and current synthetic integration differ; source fence is likely wrong",
        evidence=["PR identities have not converged", "pr base sha != live base"],
        likely_domain="SEMANTIC_OR_SOURCE",
    )


class SupervisorFixture:
    def __init__(self, root: Path) -> None:
        self.control = ControlFixture(root)
        self.clock = Clock()
        (self.control.state / "legacy_v1_browser_compat.json").write_text(
            json.dumps({
                "enabled": True,
                "conversations": {
                    "plan": "https://chatgpt.com/c/plan-supervisor",
                    "judge": "https://chatgpt.com/c/judge-supervisor",
                },
                "mailboxes": {"github.com/test/repo": 9},
            }),
            encoding="utf-8",
        )
        self.control.enable_control()
        set_block_config(
            self.control.state,
            conversation_url="https://chatgpt.com/c/block-supervisor",
            update_url=True,
        )
        set_block_config(self.control.state, enabled=True)
        (self.control.state / "projects.json").write_text(
            json.dumps({"projects": [{
                "p_id": self.control.config.p_id, "enabled": True, "allow_merge": False,
            }]}),
            encoding="utf-8",
        )
        self.supervisor = ControlSupervisor(
            self.control.state, clock=self.clock, threshold=STALL_THRESHOLD_SECONDS
        )
        self.snapshot = self.control.snapshot
        self.action = self.control.action
        self.entry = self.control.entry

    def observe(self, result=None, action=None, snapshot=None, **kwargs):
        return self.supervisor.observe(
            self.control.config.p_id,
            action or self.action,
            result or EffectResult(False, "PR identities have not converged"),
            entry=kwargs.get("entry", self.entry),
            snapshot=snapshot or self.snapshot,
            executor_active=kwargs.get("executor_active", False),
        )

    def stall_id(self, action=None, snapshot=None):
        action = action or self.action
        snapshot = snapshot or self.snapshot
        spec = snapshot.specs[-1] if snapshot.specs else None
        return control_id(
            purpose=CONTROL_PURPOSE_STALL_TRIAGE,
            p_id=snapshot.p_id,
            causal_effect_id=action.effect_id or "",
            spec_id=None if spec is None else spec.spec_id,
        )


class StallSupervisorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fx = SupervisorFixture(Path(self.temp.name))
        self.snapshot_patches = [
            patch("tools.agentbus_v2.control.read_snapshot", return_value=self.fx.snapshot),
            patch("tools.agentbus_v2.control.decide", return_value=self.fx.action),
            patch("tools.agentbus_v2.block_diagnosis.read_snapshot", return_value=self.fx.snapshot),
            patch("tools.agentbus_v2.block_diagnosis.decide", return_value=self.fx.action),
        ]
        for item in self.snapshot_patches:
            item.start()
            self.addCleanup(item.stop)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_below_threshold_does_not_create_stall_control(self) -> None:
        self.fx.observe()
        self.fx.clock.advance(599)
        self.fx.observe()
        self.assertEqual([], list((self.fx.control.paths.root / "control" / "outbox").glob("*")))

    def test_threshold_creates_exactly_one_stall_triage_request(self) -> None:
        self.fx.observe()
        self.fx.clock.advance(600)
        self.fx.observe()
        self.fx.observe()
        outbox = list((self.fx.control.paths.root / "control" / "outbox").glob("*.md"))
        self.assertEqual(1, len(outbox))
        self.assertEqual(self.fx.stall_id(), outbox[0].stem)
        packet = outbox[0].read_text(encoding="utf-8")
        self.assertIn("PURPOSE: STALL_TRIAGE", packet)
        self.assertIn("elapsed_is_telemetry_only", packet)

    def test_changed_true_and_effect_change_and_new_supervisor_reset_timer(self) -> None:
        self.fx.observe()
        self.fx.clock.advance(500)
        self.fx.observe(EffectResult(True, "progress"))
        self.fx.clock.advance(200)
        self.fx.observe()
        self.assertEqual([], list((self.fx.control.paths.root / "control" / "outbox").glob("*")))
        self.fx.clock.advance(600)
        self.fx.observe()
        self.assertEqual(1, len(list((self.fx.control.paths.root / "control" / "outbox").glob("*"))))
        other = Action(ActionKind.WORK, effect_id="work-" + "b" * 24, payload=self.fx.action.payload)
        fresh = ControlSupervisor(self.fx.control.state, clock=self.fx.clock, threshold=600)
        count = len(list((self.fx.control.paths.root / "control" / "outbox").glob("*")))
        fresh.observe(
            self.fx.control.config.p_id, other, EffectResult(False, "still stalled"),
            entry=self.fx.entry, snapshot=self.fx.snapshot,
        )
        self.fx.clock.advance(600)
        # different effect uses a new identity; original packet remains the one file
        self.assertGreaterEqual(len(list((self.fx.control.paths.root / "control" / "outbox").glob("*"))), count)

    def test_active_executor_disabled_and_terminal_actions_are_not_stalls(self) -> None:
        self.fx.observe()
        self.fx.clock.advance(600)
        self.fx.observe(executor_active=True)
        self.assertEqual([], list((self.fx.control.paths.root / "control" / "outbox").glob("*")))
        disabled = replace(self.fx.entry, enabled=False)
        self.fx.observe(entry=disabled)
        for kind in (ActionKind.DONE, ActionKind.HUMAN, ActionKind.MERGE_READY):
            self.fx.supervisor.observe(
                self.fx.control.config.p_id, Action(kind, effect_id="work-" + "c" * 24),
                EffectResult(False, "x"), entry=self.fx.entry, snapshot=self.fx.snapshot,
            )
            self.assertIsNone(self.fx.supervisor.stall(self.fx.control.config.p_id))

    def test_wait_and_human_do_not_launch_diagnosis_diagnose_launches_once(self) -> None:
        self.fx.observe()
        self.fx.clock.advance(600)
        self.fx.observe()
        job = self.fx.stall_id()
        for decision in ("WAIT", "HUMAN"):
            path = self.fx.control.state / f"{decision}.json"
            path.write_text(json.dumps({
                "job_id": job, "operation": "CONTROL_GPT", "decision": decision, "body": "triage",
            }), encoding="utf-8")
            submit_control_response(self.fx.control.paths, path)
            driven = drive_authorized_operations(
                self.fx.control.state, self.fx.entry, self.fx.snapshot, self.fx.action,
                diagnosis_executor=lambda *args, **kwargs: self.fail("launched"),
            )
            self.assertIsNone(driven)
            control_result_path(self.fx.control.paths, job).unlink()
        path = self.fx.control.state / "diagnose.json"
        path.write_text(json.dumps({
            "job_id": job, "operation": "CONTROL_GPT", "decision": "DIAGNOSE", "body": "probe",
        }), encoding="utf-8")
        submit_control_response(self.fx.control.paths, path)
        calls = []

        def executor(*args, **kwargs):
            calls.append(1)
            return DiagnosisRun(True, _report(), "ok")

        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", return_value=self.fx.snapshot), \
             patch("tools.agentbus_v2.readonly_diagnosis.decide", return_value=self.fx.action):
            first = drive_authorized_operations(
                self.fx.control.state, self.fx.entry, self.fx.snapshot, self.fx.action,
                diagnosis_executor=executor, stall_detail="PR identities have not converged",
            )
            second = drive_authorized_operations(
                self.fx.control.state, self.fx.entry, self.fx.snapshot, self.fx.action,
                diagnosis_executor=lambda *args, **kwargs: self.fail("rerun"),
                stall_detail="PR identities have not converged",
            )
        self.assertTrue(first.changed)
        self.assertEqual([1], calls)
        self.assertTrue(second is None or "diagnosis" not in second.detail or second.changed is False)


class DiagnosisRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fx = SupervisorFixture(Path(self.temp.name))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _accept_diagnose(self):
        with patch("tools.agentbus_v2.control.read_snapshot", return_value=self.fx.snapshot), \
             patch("tools.agentbus_v2.control.decide", return_value=self.fx.action):
            self.fx.observe()
            self.fx.clock.advance(600)
            self.fx.observe()
            job = self.fx.stall_id()
            path = self.fx.control.state / "diagnose.json"
            path.write_text(json.dumps({
                "job_id": job, "operation": "CONTROL_GPT", "decision": "DIAGNOSE", "body": "probe",
            }), encoding="utf-8")
            submit_control_response(self.fx.control.paths, path)
        return job

    def test_valid_diagnosis_is_accepted_and_absent_from_snapshot(self) -> None:
        self._accept_diagnose()
        before = decide(self.fx.snapshot)
        fingerprint = semantic_fact_fingerprint(self.fx.snapshot)
        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", return_value=self.fx.snapshot), \
             patch("tools.agentbus_v2.readonly_diagnosis.decide", return_value=self.fx.action):
            result = run_readonly_diagnosis(
                self.fx.control.state, self.fx.control.paths, self.fx.control.config,
                self.fx.snapshot, self.fx.action, detail="PR identities have not converged",
                executor=lambda *args, **kwargs: DiagnosisRun(True, _report(), "ok"),
            )
        self.assertTrue(result.changed)
        self.assertIn("accepted", result.detail)
        after = decide(self.fx.snapshot)
        self.assertEqual(before.kind, after.kind)
        self.assertEqual(before.effect_id, after.effect_id)
        self.assertEqual(fingerprint, semantic_fact_fingerprint(self.fx.snapshot))
        self.assertNotIn("diagnosis", asdict(self.fx.snapshot))

    def test_stale_effect_head_and_mutations_are_rejected(self) -> None:
        self._accept_diagnose()
        detail = "PR identities have not converged"
        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", return_value=self.fx.snapshot), \
             patch(
                 "tools.agentbus_v2.readonly_diagnosis.decide",
                 return_value=Action(ActionKind.WORK, effect_id="work-" + "d" * 24, payload=self.fx.action.payload),
             ):
            result = run_readonly_diagnosis(
                self.fx.control.state, self.fx.control.paths, self.fx.control.config,
                self.fx.snapshot, self.fx.action, detail=detail,
                executor=lambda *args, **kwargs: DiagnosisRun(True, _report(), "ok"),
            )
        self.assertIn("stale", result.detail)

        def dirty(*args, **kwargs):
            Path(self.fx.control.config.worktree, "dirty.txt").write_text("x\n")
            return DiagnosisRun(True, _report(), "ok")

        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", return_value=self.fx.snapshot), \
             patch("tools.agentbus_v2.readonly_diagnosis.decide", return_value=self.fx.action):
            result = run_readonly_diagnosis(
                self.fx.control.state, self.fx.control.paths, self.fx.control.config,
                self.fx.snapshot, self.fx.action, detail=detail + " dirty",
                executor=dirty,
            )
        self.assertIn("UNSAFE", result.detail)
        Path(self.fx.control.config.worktree, "dirty.txt").unlink(missing_ok=True)

        def branch(*args, **kwargs):
            from tools.agentbus_v2.tests.test_facts_effects import run
            run(Path(self.fx.control.config.worktree), "git", "branch", "unrelated-diag")
            return DiagnosisRun(True, _report(), "ok")

        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", return_value=self.fx.snapshot), \
             patch("tools.agentbus_v2.readonly_diagnosis.decide", return_value=self.fx.action):
            result = run_readonly_diagnosis(
                self.fx.control.state, self.fx.control.paths, self.fx.control.config,
                self.fx.snapshot, self.fx.action, detail=detail + " ref",
                executor=branch,
            )
        self.assertIn("UNSAFE", result.detail)

    def test_malformed_and_unavailable_are_operational_only(self) -> None:
        self._accept_diagnose()
        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", return_value=self.fx.snapshot), \
             patch("tools.agentbus_v2.readonly_diagnosis.decide", return_value=self.fx.action):
            result = run_readonly_diagnosis(
                self.fx.control.state, self.fx.control.paths, self.fx.control.config,
                self.fx.snapshot, self.fx.action, detail="malformed",
                executor=lambda *args, **kwargs: DiagnosisRun(True, {"bad": True}, "nope"),
            )
            self.assertTrue(result.changed)
            self.assertIn("operational failure", result.detail)
            self.assertEqual([], list((self.fx.control.paths.root / "work" / "results").glob("*")))
            result = run_readonly_diagnosis(
                self.fx.control.state, self.fx.control.paths, self.fx.control.config,
                self.fx.snapshot, self.fx.action, detail="unavailable",
                executor=lambda *args, **kwargs: DiagnosisRun(False, None, "Codex runtime unavailable"),
            )
        self.assertFalse(result.changed)
        self.assertIn("unavailable", result.detail)

    def test_existing_classifier_stays_work_only_and_diagnosed_stall_covers_all_kinds(self) -> None:
        for kind in (ActionKind.PLAN, ActionKind.PROVE, ActionKind.JUDGE, ActionKind.IDLE):
            self.assertIsNone(derive_operational_block(
                "P1", Action(kind, effect_id="work-" + "a" * 24),
                EffectResult(False, "Codex guardian could not start or own the executor"),
            ))
        work = derive_operational_block(
            "P1", Action(ActionKind.WORK, effect_id="work-" + "a" * 24),
            EffectResult(False, "Codex guardian could not start or own the executor"),
        )
        self.assertIsNotNone(work)
        self.assertEqual("CODEX_RUNTIME_START_FAILED", work.code)
        diagnosis = {
            "diagnosis_id": "diagnosis-" + "a" * 24,
            "accepted": True,
            "report": _p4_report(),
        }
        for kind in (ActionKind.PLAN, ActionKind.WORK, ActionKind.PROVE, ActionKind.JUDGE):
            action = Action(kind, effect_id=("plan-" if kind is ActionKind.PLAN else "work-" if kind is ActionKind.WORK else "prove-" if kind is ActionKind.PROVE else "judge-") + "a" * 24)
            obs = derive_diagnosed_stall_block("P1", action, diagnosis)
            self.assertEqual("DIAGNOSED_STALL", obs.code)
            packet = render_diagnosed_block_packet(self.fx.snapshot, action, obs, diagnosis)
            self.assertIn("DIAGNOSED_STALL", packet)
            self.assertIn(kind.value, packet)


class BlockHandoffAndRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fx = SupervisorFixture(Path(self.temp.name))
        self.patches = [
            patch("tools.agentbus_v2.control.read_snapshot", return_value=self.fx.snapshot),
            patch("tools.agentbus_v2.control.decide", return_value=self.fx.action),
            patch("tools.agentbus_v2.block_diagnosis.read_snapshot", return_value=self.fx.snapshot),
            patch("tools.agentbus_v2.block_diagnosis.decide", return_value=self.fx.action),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _diagnosed(self, report=None, action=None):
        action = action or self.fx.action
        result = run_readonly_diagnosis(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, action, detail="executor launch failed",
            executor=lambda *args, **kwargs: DiagnosisRun(True, report or _report(), "ok"),
        )
        self.assertTrue(result.changed)
        diagnosis = current_diagnosis(
            self.fx.control.paths, self.fx.snapshot, action, detail="executor launch failed"
        )
        obs = derive_diagnosed_stall_block(self.fx.control.config.p_id, action, diagnosis)
        packet = render_diagnosed_block_packet(self.fx.snapshot, action, obs, diagnosis)
        (self.fx.control.paths.root / "block" / "outbox").mkdir(parents=True, exist_ok=True)
        (self.fx.control.paths.root / "block" / "outbox" / f"{obs.block_id}.md").write_text(packet)
        return obs, diagnosis

    def _block_response(self, block_id, decision="RECOVER"):
        payload = {
            "block_id": block_id,
            "operation": BLOCK_OPERATION,
            "decision": decision,
            "reason": "bounded operational diagnosis",
            "recovery_instruction": "recreate the missing local runtime socket" if decision == "RECOVER" else None,
            "expected_postcondition": "executor can be launched safely" if decision == "RECOVER" else None,
            "human_action": "inspect AgentBus source" if decision == "HUMAN" else None,
        }
        path = self.fx.control.state / f"block-{decision}.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_diagnosed_work_and_prove_create_block_and_old_diagnosis_is_stale(self) -> None:
        obs, _ = self._diagnosed()
        self.assertTrue((self.fx.control.paths.root / "block" / "outbox" / f"{obs.block_id}.md").exists())
        prove = Action(ActionKind.PROVE, effect_id="prove-" + "a" * 24, payload=self.fx.action.payload)
        with patch("tools.agentbus_v2.block_diagnosis.decide", return_value=prove), \
             patch("tools.agentbus_v2.control.decide", return_value=prove):
            obs2 = derive_diagnosed_stall_block(self.fx.control.config.p_id, prove, {
                "diagnosis_id": "diagnosis-" + "b" * 24, "accepted": True, "report": _p4_report(),
            })
            packet = render_diagnosed_block_packet(self.fx.snapshot, prove, obs2, {
                "diagnosis_id": "diagnosis-" + "b" * 24, "accepted": True, "report": _p4_report(),
            })
            self.assertIn("PROVE", packet)
            self.assertNotEqual(obs.block_id, obs2.block_id)

    def test_block_wait_human_do_not_recover_recover_creates_route(self) -> None:
        obs, diagnosis = self._diagnosed()
        submit_block_gpt_response(self.fx.control.paths, self._block_response(obs.block_id, "WAIT"))
        driven = drive_authorized_operations(
            self.fx.control.state, self.fx.entry, self.fx.snapshot, self.fx.action,
            recovery_executor=lambda *args, **kwargs: self.fail("recovered"),
        )
        self.assertIsNone(driven)
        (self.fx.control.paths.root / "block" / "results" / f"{obs.block_id}.json").unlink()
        submit_block_gpt_response(self.fx.control.paths, self._block_response(obs.block_id, "HUMAN"))
        driven = drive_authorized_operations(
            self.fx.control.state, self.fx.entry, self.fx.snapshot, self.fx.action,
            recovery_executor=lambda *args, **kwargs: self.fail("recovered"),
        )
        self.assertIsNone(driven)

    def test_p4_style_prove_stall_is_human_not_recover(self) -> None:
        prove = Action(ActionKind.PROVE, effect_id="prove-" + "e" * 24, payload={"spec_id": self.fx.control.spec.spec_id})
        diagnosis = {"diagnosis_id": "diagnosis-" + "e" * 24, "accepted": True, "report": _p4_report()}
        obs = derive_diagnosed_stall_block(self.fx.control.config.p_id, prove, diagnosis)
        packet = render_diagnosed_block_packet(self.fx.snapshot, prove, obs, diagnosis)
        self.assertIn("SEMANTIC_OR_SOURCE", packet)
        self.assertIn("require HUMAN", packet)
        with patch("tools.agentbus_v2.block_diagnosis.decide", return_value=prove), \
             patch("tools.agentbus_v2.block_diagnosis.read_snapshot", return_value=self.fx.snapshot):
            (self.fx.control.paths.root / "block" / "outbox").mkdir(parents=True, exist_ok=True)
            (self.fx.control.paths.root / "block" / "outbox" / f"{obs.block_id}.md").write_text(packet)
            submit_block_gpt_response(self.fx.control.paths, self._block_response(obs.block_id, "HUMAN"))
        self.assertEqual(
            "HUMAN",
            json.loads((self.fx.control.paths.root / "block" / "results" / f"{obs.block_id}.json").read_text())["decision"],
        )

    def test_recovery_routes_share_id_and_one_shot_and_fences(self) -> None:
        obs, diagnosis = self._diagnosed()
        submit_block_gpt_response(self.fx.control.paths, self._block_response(obs.block_id, "RECOVER"))
        block = parse_block_response(
            json.loads((self.fx.control.paths.root / "block" / "results" / f"{obs.block_id}.json").read_text()),
            expected_block_id=obs.block_id,
        )
        from tools.agentbus_v2.block_recovery import block_result_digest
        rid = recovery_id(block_id=block.block_id, block_result_digest=block_result_digest(block))
        stall_job = control_id(
            purpose=CONTROL_PURPOSE_STALL_TRIAGE,
            p_id=self.fx.snapshot.p_id,
            causal_effect_id=self.fx.action.effect_id,
            spec_id=self.fx.control.spec.spec_id,
        )
        (self.fx.control.paths.root / "control" / "results").mkdir(parents=True, exist_ok=True)
        ensure_control_request(
            self.fx.control.state, self.fx.entry, expected_action=self.fx.action,
            purpose=CONTROL_PURPOSE_STALL_TRIAGE,
            context={"elapsed_seconds": 600, "elapsed_is_telemetry_only": True},
        )
        path = self.fx.control.state / "stall-diag.json"
        path.write_text(json.dumps({
            "job_id": stall_job, "operation": "CONTROL_GPT", "decision": "DIAGNOSE", "body": "probe",
        }), encoding="utf-8")
        try:
            submit_control_response(self.fx.control.paths, path)
        except Exception:
            pass
        recovery_job = control_id(
            purpose=CONTROL_PURPOSE_RECOVERY_ROUTE,
            p_id=self.fx.snapshot.p_id,
            causal_effect_id=block.block_id,
            spec_id=self.fx.control.spec.spec_id,
        )
        ensure_control_request(
            self.fx.control.state, self.fx.entry, expected_action=self.fx.action,
            purpose=CONTROL_PURPOSE_RECOVERY_ROUTE,
            context={"block_id": block.block_id, "block_result": block.as_dict()},
        )
        rec_path = self.fx.control.state / "recovery-route.json"
        rec_path.write_text(json.dumps({
            "job_id": recovery_job, "operation": "CONTROL_GPT", "decision": "CODEX", "body": "use codex",
        }), encoding="utf-8")
        submit_control_response(self.fx.control.paths, rec_path)

        def applied(*args, **kwargs):
            return RecoveryRun(True, {
                "status": "APPLIED", "summary": "recreated socket", "evidence": ["ok"],
            }, "ok", "CODEX")

        first = run_block_recovery(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, block, route="CODEX",
            diagnosis=diagnosis.get("report"), executor=applied,
        )
        second = run_block_recovery(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, block, route="GROK",
            diagnosis=diagnosis.get("report"),
            executor=lambda *args, **kwargs: self.fail("second recovery"),
        )
        self.assertTrue(first.changed)
        self.assertFalse(second.changed)
        self.assertIn(rid, first.detail + second.detail)

        def mutate(*args, **kwargs):
            Path(self.fx.control.config.worktree, "mut.txt").write_text("nope\n")
            return RecoveryRun(True, {
                "status": "APPLIED", "summary": "bad", "evidence": ["x"],
            }, "ok", "CODEX")

        (self.fx.control.paths.root / "recovery" / "results" / f"{rid}.json").unlink()
        unsafe = run_block_recovery(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, block, route="CODEX",
            executor=mutate,
        )
        self.assertIn("UNSAFE", unsafe.detail)
        Path(self.fx.control.config.worktree, "mut.txt").unlink(missing_ok=True)

    def test_unavailable_executor_does_not_consume_one_shot_or_fallback(self) -> None:
        obs, diagnosis = self._diagnosed()
        submit_block_gpt_response(self.fx.control.paths, self._block_response(obs.block_id, "RECOVER"))
        block = parse_block_response(
            json.loads((self.fx.control.paths.root / "block" / "results" / f"{obs.block_id}.json").read_text()),
            expected_block_id=obs.block_id,
        )
        result = run_block_recovery(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, block, route="GROK",
            diagnosis=diagnosis.get("report"),
            executor=lambda *args, **kwargs: RecoveryRun(False, None, "RECOVERY_GROK_UNAVAILABLE", "GROK"),
        )
        self.assertFalse(result.changed)
        self.assertIn("GROK", result.detail)
        from tools.agentbus_v2.block_recovery import block_result_digest
        rid = recovery_id(block_id=block.block_id, block_result_digest=block_result_digest(block))
        self.assertFalse((self.fx.control.paths.root / "recovery" / "results" / f"{rid}.json").exists())

    def test_semantic_invariants_and_actionkind_unchanged(self) -> None:
        before = decide(self.fx.snapshot)
        fingerprint = semantic_fact_fingerprint(self.fx.snapshot)
        (self.fx.control.paths.root / "diagnosis" / "results").mkdir(parents=True, exist_ok=True)
        (self.fx.control.paths.root / "recovery" / "results").mkdir(parents=True, exist_ok=True)
        (self.fx.control.paths.root / "diagnosis" / "results" / "diagnosis-aaaaaaaaaaaaaaaaaaaaaaaa.json").write_text("{}")
        (self.fx.control.paths.root / "recovery" / "results" / "recovery-aaaaaaaaaaaaaaaaaaaaaaaa.json").write_text("{}")
        after = decide(self.fx.snapshot)
        self.assertEqual(before.kind, after.kind)
        self.assertEqual(before.effect_id, after.effect_id)
        self.assertEqual(fingerprint, semantic_fact_fingerprint(self.fx.snapshot))
        self.assertEqual(
            ["PLAN", "WORK", "PROVE", "JUDGE", "MERGE", "MERGE_READY", "IDLE", "HUMAN", "DONE"],
            [item.value for item in CoreActionKind],
        )
        self.assertNotIn("CONTROL", [item.value for item in CoreActionKind])
        self.assertNotIn("DIAGNOSE", [item.value for item in CoreActionKind])
        self.assertNotIn("RECOVER", [item.value for item in CoreActionKind])


class OperationalRecoveryBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fx = SupervisorFixture(Path(self.temp.name))
        self.patches = [
            patch("tools.agentbus_v2.control.read_snapshot", return_value=self.fx.snapshot),
            patch("tools.agentbus_v2.control.decide", return_value=self.fx.action),
            patch("tools.agentbus_v2.block_diagnosis.read_snapshot", return_value=self.fx.snapshot),
            patch("tools.agentbus_v2.block_diagnosis.decide", return_value=self.fx.action),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _diagnosed_block(self):
        result = run_readonly_diagnosis(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, detail="executor launch failed",
            executor=lambda *args, **kwargs: DiagnosisRun(True, _report(), "ok"),
        )
        self.assertTrue(result.changed)
        diagnosis = current_diagnosis(
            self.fx.control.paths, self.fx.snapshot, self.fx.action,
            detail="executor launch failed",
        )
        obs = derive_diagnosed_stall_block(self.fx.control.config.p_id, self.fx.action, diagnosis)
        packet = render_diagnosed_block_packet(self.fx.snapshot, self.fx.action, obs, diagnosis)
        (self.fx.control.paths.root / "block" / "outbox").mkdir(parents=True, exist_ok=True)
        (self.fx.control.paths.root / "block" / "outbox" / f"{obs.block_id}.md").write_text(packet)
        return obs, diagnosis, packet

    def _submit_recover(self, block_id: str, instruction: str, postcondition: str) -> BlockResult:
        path = self.fx.control.state / "block-recover.json"
        path.write_text(json.dumps({
            "block_id": block_id,
            "operation": BLOCK_OPERATION,
            "decision": "RECOVER",
            "reason": "bounded operational diagnosis",
            "recovery_instruction": instruction,
            "expected_postcondition": postcondition,
            "human_action": None,
        }), encoding="utf-8")
        submit_block_gpt_response(self.fx.control.paths, path)
        return parse_block_response(
            json.loads((self.fx.control.paths.root / "block" / "results" / f"{block_id}.json").read_text()),
            expected_block_id=block_id,
        )

    def test_block_packet_forbids_proof_as_recovery(self) -> None:
        _, _, packet = self._diagnosed_block()
        self.assertIn("must not execute or substitute for PLAN, WORK, PROVE, or JUDGE", packet)
        self.assertIn("schemaReady=true", packet)
        self.assertNotIn("rerun a bounded external operational probe", packet)

    def test_installer_smoke_schema_ready_cannot_execute(self) -> None:
        obs, diagnosis = self._diagnosed_block()[:2]
        block = self._submit_recover(
            obs.block_id,
            "rerun installer smoke; postcondition schemaReady=true",
            "schemaReady=true",
        )
        self.assertTrue(is_proof_as_recovery(block))
        before = semantic_fact_fingerprint(self.fx.snapshot)
        result = run_block_recovery(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, block, route="CODEX",
            diagnosis=diagnosis.get("report"),
            executor=lambda *args, **kwargs: self.fail("proof recovery executed"),
        )
        self.assertTrue(result.changed)
        self.assertIn("semantic proof", result.detail)
        stored = json.loads(next((self.fx.control.paths.root / "recovery" / "results").glob("recovery-*.json")).read_text())
        self.assertEqual("INVALID", stored["operational_status"])
        self.assertFalse(stored["launched"])
        self.assertEqual(before, semantic_fact_fingerprint(self.fx.snapshot))
        self.assertEqual(self.fx.action, decide(self.fx.snapshot))

    def test_rerun_ci_until_check_passes_cannot_execute(self) -> None:
        obs, diagnosis = self._diagnosed_block()[:2]
        block = self._submit_recover(
            obs.block_id,
            "rerun CI until check passes",
            "CI becomes green",
        )
        self.assertTrue(is_proof_as_recovery(block))
        before = semantic_fact_fingerprint(self.fx.snapshot)
        result = run_block_recovery(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, block, route="CODEX",
            diagnosis=diagnosis.get("report"),
            executor=lambda *args, **kwargs: self.fail("CI recovery executed"),
        )
        self.assertTrue(result.changed)
        self.assertIn("semantic proof", result.detail)
        self.assertEqual(before, semantic_fact_fingerprint(self.fx.snapshot))

    def test_valid_operational_prerequisite_recovery_still_runs(self) -> None:
        obs, diagnosis = self._diagnosed_block()[:2]
        block = self._submit_recover(
            obs.block_id,
            "restart the dead local executor process and restore the missing runtime socket",
            "required process is running and the stale lock is gone",
        )
        self.assertFalse(is_proof_as_recovery(block))
        result = run_block_recovery(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, block, route="CODEX",
            diagnosis=diagnosis.get("report"),
            executor=lambda *args, **kwargs: RecoveryRun(True, {
                "status": "APPLIED",
                "summary": "restarted local process and recreated socket",
                "evidence": ["ok"],
            }, "ok", "CODEX"),
        )
        self.assertTrue(result.changed)
        self.assertNotIn("semantic proof", result.detail)
        stored = json.loads(next((self.fx.control.paths.root / "recovery" / "results").glob("recovery-*.json")).read_text())
        self.assertTrue(stored["launched"])
        self.assertNotEqual("INVALID", stored["operational_status"])

    def test_rejected_proof_recovery_consumes_one_shot_identity(self) -> None:
        obs, diagnosis = self._diagnosed_block()[:2]
        block = self._submit_recover(
            obs.block_id,
            "rerun installer smoke; postcondition schemaReady=true",
            "schemaReady=true",
        )
        from tools.agentbus_v2.block_recovery import block_result_digest
        rid = recovery_id(block_id=block.block_id, block_result_digest=block_result_digest(block))
        first = run_block_recovery(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, block, route="CODEX",
            diagnosis=diagnosis.get("report"),
            executor=lambda *args, **kwargs: self.fail("first launch"),
        )
        second = run_block_recovery(
            self.fx.control.state, self.fx.control.paths, self.fx.control.config,
            self.fx.snapshot, self.fx.action, block, route="GROK",
            diagnosis=diagnosis.get("report"),
            executor=lambda *args, **kwargs: self.fail("second launch"),
        )
        self.assertTrue(first.changed)
        self.assertFalse(second.changed)
        self.assertIn(rid, first.detail)
        self.assertIn(rid, second.detail)
        self.assertTrue((self.fx.control.paths.root / "recovery" / "results" / f"{rid}.json").exists())


class StallDiagnosisHandoffTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fx = SupervisorFixture(Path(self.temp.name))
        self.patches = [
            patch("tools.agentbus_v2.control.read_snapshot", return_value=self.fx.snapshot),
            patch("tools.agentbus_v2.control.decide", return_value=self.fx.action),
            patch("tools.agentbus_v2.block_diagnosis.read_snapshot", return_value=self.fx.snapshot),
            patch("tools.agentbus_v2.block_diagnosis.decide", return_value=self.fx.action),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _authorize_diagnose(self, detail: str) -> str:
        self.fx.observe(EffectResult(False, detail))
        self.fx.clock.advance(600)
        self.fx.observe(EffectResult(False, detail))
        job = self.fx.stall_id()
        path = self.fx.control.state / "diagnose.json"
        path.write_text(json.dumps({
            "job_id": job, "operation": "CONTROL_GPT", "decision": "DIAGNOSE", "body": "probe",
        }), encoding="utf-8")
        submit_control_response(self.fx.control.paths, path)
        return job

    def _drive(self, stall_detail: str = "", executor=None):
        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", return_value=self.fx.snapshot), \
             patch("tools.agentbus_v2.readonly_diagnosis.decide", return_value=self.fx.action):
            return drive_authorized_operations(
                self.fx.control.state, self.fx.entry, self.fx.snapshot, self.fx.action,
                diagnosis_executor=executor or (
                    lambda *args, **kwargs: DiagnosisRun(True, _report(), "ok")
                ),
                stall_detail=stall_detail,
            )

    def test_empty_tick_detail_cannot_diverge_from_stall_packet(self) -> None:
        detail = "PROVE evidence unchanged since RETURN_PROVE"
        job = self._authorize_diagnose(detail)
        context = load_stall_triage_context(self.fx.control.paths, job)
        self.assertIsNotNone(context)
        packet_fp = context["observation_fingerprint"]
        self.assertEqual(packet_fp, observation_fingerprint(self.fx.action, detail))
        self.assertNotEqual(packet_fp, observation_fingerprint(self.fx.action, ""))
        first = self._drive(stall_detail="")
        self.assertTrue(first.changed)
        matched = current_diagnosis(self.fx.control.paths, self.fx.snapshot, self.fx.action, detail=detail)
        empty = current_diagnosis(self.fx.control.paths, self.fx.snapshot, self.fx.action, detail="")
        self.assertIsNotNone(matched)
        self.assertTrue(matched.get("accepted"))
        self.assertEqual(packet_fp, matched["identity"]["observation_fingerprint"])
        self.assertTrue(empty is None or empty.get("diagnosis_id") != matched["diagnosis_id"])

    def test_packet_detail_is_used_and_later_tick_text_does_not_rekey(self) -> None:
        detail = "PROVE evidence unchanged since RETURN_PROVE"
        job = self._authorize_diagnose(detail)
        expected_id = diagnosis_id(
            p_id=self.fx.snapshot.p_id,
            action_kind=self.fx.action.kind.value,
            causal_effect_id=self.fx.action.effect_id or "",
            head=self.fx.snapshot.head,
            base=self.fx.snapshot.base,
            observation_fingerprint=observation_fingerprint(self.fx.action, detail),
        )
        self._drive(stall_detail="")
        other = self._drive(stall_detail="later scheduler text Y")
        self.assertTrue(other is None or other.changed is True)
        diagnosis = current_diagnosis(
            self.fx.control.paths, self.fx.snapshot, self.fx.action, detail=detail
        )
        self.assertEqual(expected_id, diagnosis["diagnosis_id"])
        self.assertEqual(
            1,
            len(list((self.fx.control.paths.root / "diagnosis" / "results").glob("diagnosis-*.json"))),
        )

    def test_accepted_diagnosis_creates_one_block_and_repeated_ticks_do_not_duplicate(self) -> None:
        detail = "PROVE evidence unchanged since RETURN_PROVE"
        self._authorize_diagnose(detail)
        first = self._drive(stall_detail="")
        self.assertIn("accepted", first.detail)
        second = self._drive(stall_detail="")
        self.assertIsNotNone(second)
        self.assertIn("BLOCK packet created", second.detail)
        blocks = list((self.fx.control.paths.root / "block" / "outbox").glob("block-*.md"))
        self.assertEqual(1, len(blocks))
        third = self._drive(stall_detail="another tick")
        self.assertTrue(third is None or "BLOCK packet created" not in (third.detail or ""))
        self.assertEqual(1, len(list((self.fx.control.paths.root / "block" / "outbox").glob("block-*.md"))))

    def test_fresh_supervisor_recovers_durable_stall_observation(self) -> None:
        detail = "PROVE evidence unchanged since RETURN_PROVE"
        self._authorize_diagnose(detail)
        self._drive(stall_detail="")
        self._drive(stall_detail="")
        block_before = list((self.fx.control.paths.root / "block" / "outbox").glob("block-*.md"))
        self.assertEqual(1, len(block_before))
        fresh = ControlSupervisor(self.fx.control.state, clock=self.fx.clock, threshold=600)
        fresh.observe(
            self.fx.control.config.p_id, self.fx.action,
            EffectResult(False, "later scheduler text Y"),
            entry=self.fx.entry, snapshot=self.fx.snapshot,
        )
        self.fx.clock.advance(600)
        fresh.observe(
            self.fx.control.config.p_id, self.fx.action,
            EffectResult(False, "later scheduler text Y"),
            entry=self.fx.entry, snapshot=self.fx.snapshot,
        )
        self.assertEqual(
            1,
            len(list((self.fx.control.paths.root / "block" / "outbox").glob("block-*.md"))),
        )
        diagnosis = current_diagnosis(
            self.fx.control.paths, self.fx.snapshot, self.fx.action, detail=detail
        )
        self.assertTrue(diagnosis.get("accepted"))
        self.assertIsNone(
            current_diagnosis(
                self.fx.control.paths, self.fx.snapshot, self.fx.action,
                detail="later scheduler text Y",
            )
        )

    def test_different_stall_effect_cannot_reuse_unrelated_diagnosis(self) -> None:
        detail = "PROVE evidence unchanged since RETURN_PROVE"
        self._authorize_diagnose(detail)
        self._drive(stall_detail="")
        other = Action(ActionKind.WORK, effect_id="work-" + "b" * 24, payload=self.fx.action.payload)
        from tools.agentbus_v2.control_supervisor import _authorized_stall_observation_detail
        self.assertIsNone(
            _authorized_stall_observation_detail(self.fx.control.paths, self.fx.snapshot, other)
        )
        self.assertIsNone(
            current_diagnosis(self.fx.control.paths, self.fx.snapshot, other, detail=detail)
        )

    def test_diagnosis_mutation_fences_remain(self) -> None:
        detail = "PROVE evidence unchanged since RETURN_PROVE"
        self._authorize_diagnose(detail)

        def dirty(*args, **kwargs):
            Path(self.fx.control.config.worktree, "mut.txt").write_text("nope\n")
            return DiagnosisRun(True, _report(), "ok")

        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", return_value=self.fx.snapshot), \
             patch("tools.agentbus_v2.readonly_diagnosis.decide", return_value=self.fx.action):
            result = drive_authorized_operations(
                self.fx.control.state, self.fx.entry, self.fx.snapshot, self.fx.action,
                diagnosis_executor=dirty, stall_detail="",
            )
        self.assertIn("UNSAFE", result.detail)
        Path(self.fx.control.config.worktree, "mut.txt").unlink(missing_ok=True)


class CodexReadonlyCommandTests(unittest.TestCase):
    def test_diagnosis_puts_approval_policy_before_exec(self) -> None:
        from pathlib import Path
        command = _codex_diagnosis_command(
            type("C", (), {"worktree": "/tmp/wt"})(),
            Path("/tmp/schema.json"),
            Path("/tmp/out.json"),
        )
        self.assertEqual(("codex", "--ask-for-approval", "never", "exec"), command[:4])
        self.assertEqual("read-only", command[command.index("--sandbox") + 1])

    def test_recovery_puts_approval_policy_before_exec(self) -> None:
        command = _codex_recovery_command(
            type("C", (), {"worktree": "/tmp/wt"})(),
            Path("/tmp/schema.json"),
            Path("/tmp/out.json"),
        )
        self.assertEqual(("codex", "--ask-for-approval", "never", "exec"), command[:4])
        self.assertEqual("workspace-write", command[command.index("--sandbox") + 1])

    def test_grok_recovery_does_not_constrain_first_output_to_schema(self) -> None:
        command = _grok_recovery_command(
            type("C", (), {"worktree": "/tmp/wt"})(),
            Path("/tmp/prompt.md"),
            "grok-4.6",
        )
        self.assertIn("--prompt-file", command)
        self.assertIn("--output-format", command)
        self.assertIn("json", command)
        self.assertIn("--always-approve", command)
        self.assertNotIn("--json-schema", command)


class RecoveryPostconditionTests(unittest.TestCase):
    def test_named_absolute_paths_are_observed_independently(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        marker = Path(temp.name) / "runtime.marker"
        action = Action(ActionKind.WORK, effect_id="work-" + "a" * 24, reason="executor launch failed")
        block = BlockResult(
            "block-" + "a" * 24,
            BLOCK_OPERATION,
            "RECOVER",
            "bounded operational diagnosis",
            f"recreate the missing runtime marker at {marker}",
            f"{marker} exists and is observable",
            None,
        )
        report = {"status": "APPLIED", "summary": "claimed write", "evidence": ["ok"]}
        self.assertFalse(_postcondition_holds(None, action, action, block, report))
        marker.write_text("ok\n", encoding="utf-8")
        self.assertTrue(_postcondition_holds(None, action, action, block, report))
        self.assertFalse(
            _postcondition_holds(
                None, action, action, block, {"status": "NOT_APPLIED", "summary": "x", "evidence": []}
            )
        )

    def test_grok_recovery_parses_json_after_prose_prefix(self) -> None:
        payload = {
            "sessionId": "ignored",
            "text": (
                "Inspecting the named marker before applying the bounded recovery."
                '{"status":"APPLIED","summary":"recreated marker","evidence":["ok"]}'
            ),
        }
        report = _parse_grok_json(json.dumps(payload))
        self.assertEqual("APPLIED", report["status"])
        self.assertEqual("recreated marker", report["summary"])


class SemanticAuthorityFingerprintTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fx = SupervisorFixture(Path(self.temp.name))
        self.snapshot = replace(
            self.fx.snapshot,
            allow_merge=True,
            merge=GitHubFacts(
                available=True, pr_number=4, check_status="PENDING",
                head_sha=self.fx.snapshot.head, base_branch="main",
            ),
        )
        self.action = self.fx.action

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _live_drift(self, snapshot):
        return replace(
            snapshot,
            repository_available=False,
            allow_merge=False,
            gpt_pending=frozenset({"plan-" + "b" * 24}),
            merge=GitHubFacts(
                available=True, pr_number=4, check_status="FAIL", mergeable=False,
                head_sha=snapshot.head, base_branch="main",
            ),
        )

    def test_fingerprint_ignores_live_observations_and_tracks_durable_facts(self) -> None:
        original = semantic_fact_fingerprint(self.snapshot)
        drifted = self._live_drift(self.snapshot)
        self.assertEqual(original, semantic_fact_fingerprint(drifted))
        self.assertEqual(original, semantic_fact_fingerprint(replace(self.snapshot, head="c" * 40, base="d" * 40)))

        spec = SpecFact("spec-" + "b" * 24, "different spec", plan_job_id=self.fx.control.spec.plan_job_id)
        self.assertNotEqual(original, semantic_fact_fingerprint(replace(self.snapshot, specs=(spec,))))
        gpt = GptResult("plan-" + "b" * 24, "PLAN_GPT", "SPEC", "other")
        self.assertNotEqual(original, semantic_fact_fingerprint(replace(self.snapshot, gpt_results=(gpt,))))
        work = WorkFact(
            "work-" + "b" * 24, self.fx.control.spec.spec_id, self.snapshot.head,
            Observation.FAIL, "e" * 64,
        )
        self.assertNotEqual(original, semantic_fact_fingerprint(replace(self.snapshot, work_facts=(work,))))
        proof = ProofFact(
            "prove-" + "b" * 24, self.fx.control.spec.spec_id, self.snapshot.head,
            self.snapshot.base, Observation.FAIL, "f" * 64, summary="failed",
        )
        self.assertNotEqual(original, semantic_fact_fingerprint(replace(self.snapshot, proof_facts=(proof,))))
        directive = OperatorDirective(
            "directive-" + "b" * 24, "do not weaken requirements", "g" * 64,
            self.fx.control.plan_id,
        )
        self.assertNotEqual(
            original,
            semantic_fact_fingerprint(replace(self.snapshot, operator_directive=directive)),
        )

    def test_operational_artifact_writes_do_not_change_fingerprint(self) -> None:
        before = semantic_fact_fingerprint(self.snapshot)
        root = self.fx.control.paths.root
        for relative in (
            "control/outbox/control-" + "a" * 24 + ".md",
            "block/outbox/block-" + "a" * 24 + ".md",
            "diagnosis/results/diagnosis-" + "a" * 24 + ".json",
            "recovery/results/recovery-" + "a" * 24 + ".json",
        ):
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}\n", encoding="utf-8")
        self.assertEqual(before, semantic_fact_fingerprint(self.snapshot))

    def _diagnose(self, after_snapshot, *, decide_action=None, executor=None, detail="live drift"):
        recorded: list[bool] = []

        def fake_read(paths, *, allow_merge=False):
            recorded.append(allow_merge)
            return after_snapshot

        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", side_effect=fake_read), \
             patch("tools.agentbus_v2.readonly_diagnosis.decide", return_value=decide_action or self.action):
            result = run_readonly_diagnosis(
                self.fx.control.state, self.fx.control.paths, self.fx.control.config,
                self.snapshot, self.action, detail=detail,
                executor=executor or (lambda *args, **kwargs: DiagnosisRun(True, _report(), "ok")),
            )
        return result, recorded

    def test_diagnosis_preserves_allow_merge_and_ignores_github_observation_drift(self) -> None:
        after = self._live_drift(self.snapshot)
        result, recorded = self._diagnose(after, detail="allow-merge diagnosis")
        self.assertEqual([True], recorded)
        self.assertTrue(result.changed)
        self.assertIn("accepted", result.detail)
        self.assertNotIn("UNSAFE", result.detail)

        stale_action = Action(ActionKind.WORK, effect_id="work-" + "d" * 24, payload=self.action.payload)
        result, _ = self._diagnose(after, decide_action=stale_action, detail="github drift stale")
        self.assertIn("stale", result.detail)
        self.assertNotIn("UNSAFE", result.detail)

    def test_diagnosis_git_and_durable_fact_mutations_are_unsafe(self) -> None:
        worktree = Path(self.fx.control.config.worktree)

        def mutate_head(*args, **kwargs):
            (worktree / "head-mut.txt").write_text("mutated\n", encoding="utf-8")
            from tools.agentbus_v2.tests.test_facts_effects import run
            run(worktree, "git", "add", "head-mut.txt")
            import subprocess
            subprocess.run(
                ("git", "commit", "-m", "head mutation"),
                cwd=worktree, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            return DiagnosisRun(True, _report(), "ok")

        result, _ = self._diagnose(self.snapshot, executor=mutate_head, detail="head mutation")
        self.assertIn("UNSAFE", result.detail)

        def mutate_ref(*args, **kwargs):
            from tools.agentbus_v2.tests.test_facts_effects import run
            run(worktree, "git", "branch", "unrelated-authority")
            return DiagnosisRun(True, _report(), "ok")

        result, _ = self._diagnose(self.snapshot, executor=mutate_ref, detail="ref mutation")
        self.assertIn("UNSAFE", result.detail)

        def mutate_tracked(*args, **kwargs):
            (worktree / "README.md").write_text("tracked dirty\n", encoding="utf-8")
            return DiagnosisRun(True, _report(), "ok")

        result, _ = self._diagnose(self.snapshot, executor=mutate_tracked, detail="tracked mutation")
        self.assertIn("UNSAFE", result.detail)
        from tools.agentbus_v2.tests.test_facts_effects import run
        run(worktree, "git", "checkout", "--", "README.md")

        mutated_facts = replace(
            self.snapshot,
            gpt_results=self.snapshot.gpt_results + (
                GptResult("judge-" + "b" * 24, "JUDGE_GPT", "HUMAN", "mutated"),
            ),
        )
        result, _ = self._diagnose(mutated_facts, detail="semantic fact mutation")
        self.assertIn("UNSAFE", result.detail)

    def _recover(self, after_snapshot, *, executor=None):
        recorded: list[bool] = []
        block = BlockResult(
            "block-" + "c" * 24, BLOCK_OPERATION, "RECOVER",
            "bounded operational diagnosis",
            "recreate the missing local runtime socket",
            "executor can be launched safely", None,
        )

        def fake_read(paths, *, allow_merge=False):
            recorded.append(allow_merge)
            return after_snapshot

        applied = RecoveryRun(
            True, {"status": "APPLIED", "summary": "recreated socket", "evidence": ["ok"]},
            "ok", "CODEX",
        )
        with patch("tools.agentbus_v2.readonly_diagnosis.read_snapshot", side_effect=fake_read), \
             patch("tools.agentbus_v2.readonly_diagnosis.decide", return_value=self.action):
            result = run_block_recovery(
                self.fx.control.state, self.fx.control.paths, self.fx.control.config,
                self.snapshot, self.action, block, route="CODEX",
                executor=executor or (lambda *args, **kwargs: applied),
            )
        return result, recorded

    def test_recovery_preserves_allow_merge_and_ignores_github_observation_drift(self) -> None:
        after = self._live_drift(self.snapshot)
        result, recorded = self._recover(after)
        self.assertEqual([True], recorded)
        self.assertTrue(result.changed)
        self.assertNotIn("UNSAFE", result.detail)


if __name__ == "__main__":
    unittest.main()
