from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import Action, ActionKind, GPT_PACKET_SCHEMA, Snapshot
from tools.agentbus_v2.facts import PPaths, _project_current_gpt_pending


class JudgePendingProjectionTests(unittest.TestCase):
    def snapshot(self) -> Snapshot:
        return Snapshot(
            p_id="P-TEST",
            charter_digest="c" * 64,
            expected_repository="github.com/test/repo",
            expected_branch="agentbus/p-test",
            base_ref="main",
            head="1" * 40,
            base="1" * 40,
        )

    def write_packet(self, paths: PPaths, job_id: str, operation: str) -> None:
        packet = {
            "packet_schema": GPT_PACKET_SCHEMA,
            "job_id": job_id,
            "operation": operation,
            "semantic_input": {"job_id": job_id, "operation": operation},
        }
        target = paths.root / "gpt" / "outbox" / f"{job_id}.md"
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
            job = "judge-" + "a" * 24
            self.write_packet(paths, job, "JUDGE_GPT")
            action = Action(ActionKind.JUDGE, job)
            with patch("tools.agentbus_v2.facts.decide", return_value=action):
                projected = _project_current_gpt_pending(paths, self.snapshot())
            self.assertEqual(frozenset({job}), projected.gpt_pending)

    def test_historical_outbox_is_not_pending_authority(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = PPaths(Path(directory) / "P-TEST")
            historical = "judge-" + "b" * 24
            current = "judge-" + "c" * 24
            self.write_packet(paths, historical, "JUDGE_GPT")
            action = Action(ActionKind.JUDGE, current)
            with patch("tools.agentbus_v2.facts.decide", return_value=action):
                projected = _project_current_gpt_pending(paths, self.snapshot())
            self.assertFalse(projected.gpt_pending)

    def test_result_presence_prevents_pending_projection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = PPaths(Path(directory) / "P-TEST")
            job = "judge-" + "d" * 24
            self.write_packet(paths, job, "JUDGE_GPT")
            result = paths.root / "gpt" / "results" / f"{job}.json"
            result.parent.mkdir(parents=True, exist_ok=True)
            result.write_text("{}\n", encoding="utf-8")
            action = Action(ActionKind.JUDGE, job)
            with patch("tools.agentbus_v2.facts.decide", return_value=action):
                projected = _project_current_gpt_pending(paths, self.snapshot())
            self.assertFalse(projected.gpt_pending)


if __name__ == "__main__":
    unittest.main()
