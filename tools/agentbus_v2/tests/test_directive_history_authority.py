from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import ActionKind, decide, work_identity_id
from tools.agentbus_v2.effects import dispatch_manual_gpt, submit_gpt_response
from tools.agentbus_v2.facts import (
    FactError,
    add_operator_directive,
    canonical_repository,
    load_config,
    load_operator_directive,
    paths_for,
    read_snapshot,
    sha256_text,
)
from tools.agentbus_v2.github import GitHubFacts


def run(cwd: Path, *argv: str) -> str:
    completed = subprocess.run(
        argv, cwd=cwd, text=True, capture_output=True, check=True
    )
    return completed.stdout.strip()


class DirectiveHistoryAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.remote = self.root / "remote.git"
        self.state = self.root / "state"
        self.work.mkdir()
        run(self.work, "git", "init", "-b", "main")
        run(self.work, "git", "config", "user.name", "AgentBus Test")
        run(self.work, "git", "config", "user.email", "agentbus@example.invalid")
        (self.work / "README.md").write_text("initial\n", encoding="utf-8")
        run(self.work, "git", "add", "README.md")
        run(self.work, "git", "commit", "-m", "initial")
        run(self.root, "git", "init", "--bare", str(self.remote))
        run(self.work, "git", "remote", "add", "origin", str(self.remote))
        run(self.work, "git", "push", "-u", "origin", "main")
        self.base0 = run(self.work, "git", "rev-parse", "HEAD")
        run(self.work, "git", "switch", "-c", "agentbus/p-test")
        self.p_id = "P-TEST"
        self.charter = "P_ID: P-TEST\nGOAL: directive history\n"
        self.paths = paths_for(self.state, self.p_id)
        self.paths.create_dirs()
        config = {
            "p_id": self.p_id,
            "worktree": str(self.work),
            "repository": canonical_repository(str(self.remote)),
            "remote": "origin",
            "branch": "agentbus/p-test",
            "base_ref": "main",
            "seed_head": self.base0,
            "charter_digest": sha256_text(self.charter),
            "proof_commands": [],
            "required_ci_checks": [],
        }
        (self.paths.root / "config.json").write_text(json.dumps(config), encoding="utf-8")
        (self.paths.root / "charter.md").write_text(self.charter, encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _accept_directive_plan(self):
        initial = read_snapshot(self.paths)
        directive, changed = add_operator_directive(
            self.paths, initial, "Only keep the bounded repair."
        )
        self.assertTrue(changed)
        planning = read_snapshot(self.paths)
        action = decide(planning)
        self.assertEqual(ActionKind.PLAN, action.kind)
        config = load_config(self.paths)
        dispatch_manual_gpt(self.paths, config, planning, action)
        response = self.root / "plan-response.json"
        response.write_text(json.dumps({
            "job_id": action.effect_id,
            "operation": "PLAN_GPT",
            "decision": "SPEC",
            "body": "CURRENT_SPEC: bounded historical directive test",
        }), encoding="utf-8")
        self.assertTrue(submit_gpt_response(self.paths, response).changed)
        accepted = read_snapshot(self.paths)
        self.assertEqual(action.effect_id, accepted.specs[0].plan_job_id)
        return directive, accepted, config

    def _advance_base(self) -> str:
        run(self.work, "git", "switch", "main")
        (self.work / "README.md").write_text("base advanced\n", encoding="utf-8")
        run(self.work, "git", "add", "README.md")
        run(self.work, "git", "commit", "-m", "advance base")
        base1 = run(self.work, "git", "rev-parse", "HEAD")
        run(self.work, "git", "push", "origin", "main")
        run(self.work, "git", "switch", "agentbus/p-test")
        return base1

    def test_accepted_directive_survives_base_drift_without_new_plan(self) -> None:
        directive, accepted, _ = self._accept_directive_plan()
        spec_id = accepted.specs[0].spec_id
        plan_id = accepted.specs[0].plan_job_id
        base1 = self._advance_base()
        with patch("tools.agentbus_v2.github.read_github_facts", return_value=GitHubFacts()):
            current = read_snapshot(self.paths)
        self.assertEqual(base1, current.base)
        self.assertEqual(directive, current.operator_directive)
        self.assertEqual(spec_id, current.specs[0].spec_id)
        self.assertEqual(plan_id, current.specs[0].plan_job_id)
        self.assertNotEqual(ActionKind.PLAN, decide(current).kind)
        self.assertEqual(ActionKind.WORK, decide(current).kind)

    def test_accepted_directive_survives_head_drift_and_recovers_work(self) -> None:
        directive, accepted, config = self._accept_directive_plan()
        spec = accepted.specs[0]
        input_head = accepted.head
        work_id = work_identity_id(self.p_id, spec.spec_id, input_head)
        (self.work / "implementation.txt").write_text("implemented\n", encoding="utf-8")
        run(self.work, "git", "add", "implementation.txt")
        message = (
            "bounded implementation\n\n"
            f"AgentBus-V2-P: {self.p_id}\n"
            f"AgentBus-V2-Spec: {spec.spec_id}\n"
            f"AgentBus-V2-Work: {work_id}\n"
            f"AgentBus-V2-Input-Head: {input_head}\n"
            f"AgentBus-V2-Plan: {spec.plan_job_id}\n"
        )
        run(self.work, "git", "commit", "-m", message)
        head1 = run(self.work, "git", "rev-parse", "HEAD")
        current = read_snapshot(self.paths)
        self.assertEqual(head1, current.head)
        self.assertEqual(directive, current.operator_directive)
        self.assertEqual(spec.spec_id, current.specs[0].spec_id)
        self.assertEqual(work_id, current.work_facts[0].effect_id)
        self.assertEqual(ActionKind.PROVE, decide(current).kind)

    def test_pending_directive_stale_after_drift_remains_fail_closed(self) -> None:
        initial = read_snapshot(self.paths)
        directive, _ = add_operator_directive(
            self.paths, initial, "Only keep the bounded repair."
        )
        self.assertEqual(directive, load_operator_directive(self.paths))
        self._advance_base()
        with self.assertRaisesRegex(FactError, "authority does not match"):
            read_snapshot(self.paths)

    def test_directive_intrinsic_tamper_is_rejected_after_history_exists(self) -> None:
        self._accept_directive_plan()
        path = self.paths.root / "operator" / "directive.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        value["directive_id"] = "directive-" + "0" * 24
        path.write_text(json.dumps(value), encoding="utf-8")
        with self.assertRaisesRegex(FactError, "directive identity"):
            read_snapshot(self.paths)


if __name__ == "__main__":
    unittest.main()
