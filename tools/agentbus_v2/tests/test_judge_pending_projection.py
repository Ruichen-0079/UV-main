from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import (
    Action,
    GPT_PACKET_SCHEMA,
    Observation,
    Snapshot,
    SpecFact,
    WorkFact,
    decide,
    plan_facts_digest,
    stable_id,
    work_effect_id,
)
from tools.agentbus_v2.facts import PPaths, _project_current_gpt_pending


class JudgePendingProjectionTests(unittest.TestCase):
    def snapshot(self) -> Snapshot:
        initial = Snapshot(
            p_id="P-TEST",
            charter_digest="c" * 64,
            expected_repository="github.com/test/repo",
            expected_branch="agentbus/p-test",
            base_ref="main",
            head="1" * 40,
            base="1" * 40,
        )
        spec = SpecFact(
            "spec-" + "1" * 24,
            "Judge the exact current failure.",
            plan_job_id="plan-" + "1" * 24,
        )
        failure = WorkFact(
            work_effect_id(initial, spec),
            spec.spec_id,
            initial.head,
            Observation.FAIL,
            "exact-evidence",
        )
        return replace(initial, specs=(spec,), work_facts=(failure,))

    def write_packet(
        self, paths: PPaths, snapshot: Snapshot, action: Action
    ) -> None:
        assert action.effect_id is not None
        spec = snapshot.specs[-1]
        semantic = {
            "packet_schema": GPT_PACKET_SCHEMA,
            "job_id": action.effect_id,
            "p_id": snapshot.p_id,
            "operation": "JUDGE_GPT",
            "charter_digest": snapshot.charter_digest,
            "repository": snapshot.expected_repository,
            "branch": snapshot.expected_branch,
            "base_ref": snapshot.base_ref,
            "head": snapshot.head,
            "base": snapshot.base,
            "parent_spec_id": None,
            "trigger_judge_id": None,
            "planning_facts_digest": plan_facts_digest(snapshot),
            "spec_id": spec.spec_id,
            "spec_content_digest": stable_id("spec-text", {"text": spec.text}),
            "failed_step": action.payload["failed_step"],
            "evidence_id": action.payload["evidence_id"],
            "evidence_digest": action.payload["evidence_digest"],
        }
        packet = {
            "packet_schema": GPT_PACKET_SCHEMA,
            "job_id": action.effect_id,
            "operation": "JUDGE_GPT",
            "semantic_input": semantic,
        }
        target = paths.root / "gpt" / "outbox" / f"{action.effect_id}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            "# packet\n## SEMANTIC INPUTS\n```json\n"
            + json.dumps(packet, sort_keys=True)
            + "\n```\n",
            encoding="utf-8",
        )

    def test_exact_current_judge_outbox_projects_pending(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = PPaths(Path(directory) / "P-TEST")
            snapshot = self.snapshot()
            action = decide(snapshot)
            job = action.effect_id
            self.write_packet(paths, snapshot, action)
            with patch("tools.agentbus_v2.facts.decide", return_value=action):
                projected = _project_current_gpt_pending(paths, snapshot)
            self.assertEqual(frozenset({job}), projected.gpt_pending)

    def test_historical_outbox_is_not_pending_authority(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = PPaths(Path(directory) / "P-TEST")
            historical = "judge-" + "b" * 24
            snapshot = self.snapshot()
            action = decide(snapshot)
            current = action.effect_id
            historical_action = replace(action, effect_id=historical)
            self.write_packet(paths, snapshot, historical_action)
            with patch("tools.agentbus_v2.facts.decide", return_value=action):
                projected = _project_current_gpt_pending(paths, snapshot)
            self.assertFalse(projected.gpt_pending)

    def test_result_presence_prevents_pending_projection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = PPaths(Path(directory) / "P-TEST")
            snapshot = self.snapshot()
            action = decide(snapshot)
            job = action.effect_id
            self.write_packet(paths, snapshot, action)
            result = paths.root / "gpt" / "results" / f"{job}.json"
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_text("{}\n", encoding="utf-8")
            with patch("tools.agentbus_v2.facts.decide", return_value=action):
                projected = _project_current_gpt_pending(paths, snapshot)
            self.assertFalse(projected.gpt_pending)


if __name__ == "__main__":
    unittest.main()
