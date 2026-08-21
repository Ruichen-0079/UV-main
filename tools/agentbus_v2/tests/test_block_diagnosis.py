from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2.block_diagnosis import (
    BLOCK_OPERATION,
    BLOCK_PACKET_SCHEMA,
    BlockDiagnosisSupervisor,
    BlockGPTConfig,
    block_config_path,
    derive_operational_block,
    load_block_packet,
    parse_block_response,
    render_block_packet,
    set_block_config,
    submit_block_gpt_response,
)
from tools.agentbus_v2.core import Action, ActionKind, Snapshot
from tools.agentbus_v2.effects import EffectResult
from tools.agentbus_v2.facts import paths_for, write_text_once


SHA = "1" * 40
WORK = "work-" + "a" * 24


def response(block_id: str, decision: str = "RECOVER") -> dict[str, object]:
    return {
        "block_id": block_id,
        "operation": BLOCK_OPERATION,
        "decision": decision,
        "reason": "bounded operational diagnosis",
        "recovery_instruction": "revalidate the executor precondition" if decision == "RECOVER" else None,
        "expected_postcondition": "executor can be launched safely" if decision == "RECOVER" else None,
        "human_action": "inspect the runtime" if decision == "HUMAN" else None,
    }


class BlockDiagnosisTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        p = self.state / "P1"
        (p / "gpt").mkdir(parents=True)
        (p / "block" / "outbox").mkdir(parents=True)
        (p / "block" / "results").mkdir(parents=True)
        (p / "config.json").write_text(json.dumps({
            "p_id": "P1", "worktree": str(self.root / "wt"),
            "repository": "github.com/test/repo", "remote": "origin",
            "branch": "agentbus/p1", "base_ref": "main", "seed_head": SHA,
            "charter_digest": "c" * 64, "proof_commands": [], "required_ci_checks": [],
        }), encoding="utf-8")
        (p / "charter.md").write_text("# bounded operational test\n", encoding="utf-8")
        self.snapshot = Snapshot(
            "P1", "c" * 64, "github.com/test/repo", "agentbus/p1", "main", SHA, SHA
        )
        self.action = Action(ActionKind.WORK, effect_id=WORK)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def observation(self, detail: str = "Codex guardian could not start or own the executor"):
        return derive_operational_block(
            "P1", self.action, EffectResult(False, detail)
        )

    def test_only_concrete_executor_failures_are_eligible(self):
        self.assertIsNotNone(self.observation())
        self.assertEqual("CODEX_RUNTIME_START_FAILED", self.observation().code)
        self.assertEqual("LOCAL_AGENTBUS_COMPONENT_UNAVAILABLE", self.observation("command unavailable: codex" ).code)
        self.assertEqual("EXECUTOR_LAUNCH_FAILED", self.observation("executor=one; operational retry blocked: codex launch failed").code)
        for detail in (
            "all selected Codex attempts were operationally unavailable: one",
            "worktree execution lock is unavailable",
            "executor=one; operational retry blocked by ambiguous worktree",
            "executor=one; operational retry blocked: branch identity drifted",
            "Codex returned FAIL because the implementation is wrong",
        ):
            self.assertIsNone(self.observation(detail))

    def test_semantic_and_normal_waiting_paths_are_not_blockers(self):
        for kind in (ActionKind.PLAN, ActionKind.PROVE, ActionKind.JUDGE, ActionKind.IDLE, ActionKind.HUMAN):
            self.assertIsNone(derive_operational_block("P1", Action(kind, effect_id=WORK), EffectResult(False, "Codex guardian could not start or own the executor")))

    def test_block_identity_ignores_timestamps_but_changes_effect_or_class(self):
        first = self.observation("2026-08-21T10:00:00Z Codex exceeded the executor timeout")
        second = self.observation("2026-08-21T10:02:00Z Codex exceeded the executor timeout")
        self.assertEqual(first.block_id, second.block_id)
        changed = derive_operational_block("P1", Action(ActionKind.WORK, effect_id="work-" + "b" * 24), EffectResult(False, "Codex exceeded the executor timeout"))
        self.assertNotEqual(first.block_id, changed.block_id)
        different = self.observation("Codex guardian could not start or own the executor")
        self.assertNotEqual(first.block_id, different.block_id)

    def test_packet_is_self_contained_and_bounded(self):
        obs = self.observation()
        packet = render_block_packet(self.snapshot, self.action, obs)
        self.assertLess(len(packet.encode()), 12000)
        self.assertIn("BLOCK_ID" if False else obs.block_id, packet)
        path = paths_for(self.state, "P1")
        write_text_once(path.root / "block" / "outbox" / f"{obs.block_id}.md", packet)
        value = load_block_packet(path, obs.block_id)
        self.assertEqual(BLOCK_PACKET_SCHEMA, value["packet_schema"])
        self.assertEqual("WORK", value["current_semantic_decision"])
        self.assertEqual(obs.evidence_fingerprint, value["evidence_fingerprint"])

    def test_strict_result_schema_and_one_durable_result(self):
        obs = self.observation()
        path = paths_for(self.state, "P1")
        write_text_once(path.root / "block" / "outbox" / f"{obs.block_id}.md", render_block_packet(self.snapshot, self.action, obs))
        raw = self.root / "response.json"
        raw.write_text(json.dumps(response(obs.block_id)), encoding="utf-8")
        with patch("tools.agentbus_v2.block_diagnosis.read_snapshot", return_value=self.snapshot), \
             patch("tools.agentbus_v2.block_diagnosis.decide", return_value=self.action):
            accepted = submit_block_gpt_response(path, raw)
            duplicate = submit_block_gpt_response(path, raw)
        self.assertTrue(accepted.changed)
        self.assertFalse(duplicate.changed)
        self.assertEqual("RECOVER", json.loads((path.root / "block" / "results" / f"{obs.block_id}.json").read_text())["decision"])

    def test_wrong_identity_and_decision_schema_fail_closed(self):
        obs = self.observation()
        with self.assertRaises(Exception):
            parse_block_response(response("block-" + "f" * 24), expected_block_id=obs.block_id)
        with self.assertRaises(Exception):
            parse_block_response({**response(obs.block_id), "decision": "PASS"}, expected_block_id=obs.block_id)
        with self.assertRaises(Exception):
            parse_block_response({**response(obs.block_id), "recovery_instruction": None}, expected_block_id=obs.block_id)
        self.assertEqual("WAIT", parse_block_response(response(obs.block_id, "WAIT"), expected_block_id=obs.block_id).decision)
        self.assertEqual("HUMAN", parse_block_response(response(obs.block_id, "HUMAN"), expected_block_id=obs.block_id).decision)

    def test_default_switch_is_off_and_binding_is_validated(self):
        self.assertEqual(BlockGPTConfig(), __import__("tools.agentbus_v2.block_diagnosis", fromlist=["load_block_config"]).load_block_config(self.state))
        config = set_block_config(self.state, conversation_url="https://chatgpt.com/c/block-test", update_url=True)
        self.assertFalse(config.enabled)
        config = set_block_config(self.state, enabled=True)
        self.assertTrue(config.enabled)
        self.assertEqual(config, __import__("tools.agentbus_v2.block_diagnosis", fromlist=["load_block_config"]).load_block_config(self.state))
        with self.assertRaises(Exception):
            set_block_config(self.state, conversation_url="http://example.com/not-chatgpt", update_url=True)

    def test_supervisor_creates_packet_only_when_switch_is_on_and_never_executes(self):
        (self.state / "legacy_v1_browser_compat.json").write_text(json.dumps({
            "enabled": True,
            "conversations": {"plan": "https://chatgpt.com/c/plan", "judge": "https://chatgpt.com/c/judge"},
            "mailboxes": {"github.com/test/repo": 51},
        }), encoding="utf-8")
        (self.state / "projects.json").write_text(json.dumps({"projects": [{"p_id": "P1", "enabled": True}]}), encoding="utf-8")
        entry = type("Entry", (), {"p_id": "P1", "enabled": True, "archived": False, "allow_merge": False})()
        supervisor = BlockDiagnosisSupervisor(self.state)
        with patch("tools.agentbus_v2.block_diagnosis.read_snapshot", return_value=self.snapshot), \
             patch("tools.agentbus_v2.block_diagnosis.decide", return_value=self.action):
            obs = supervisor.observe("P1", self.action, EffectResult(False, "Codex guardian could not start or own the executor"), entry=entry)
        self.assertIsNotNone(obs)
        config = set_block_config(self.state, conversation_url="https://chatgpt.com/c/block", update_url=True)
        self.assertFalse(config.enabled)
        with patch("tools.agentbus_v2.block_diagnosis.read_snapshot", return_value=self.snapshot), \
             patch("tools.agentbus_v2.block_diagnosis.decide", return_value=self.action):
            supervisor.observe("P1", self.action, EffectResult(False, "Codex guardian could not start or own the executor"), entry=entry)
        self.assertEqual([], list((self.state / "P1" / "block" / "outbox").glob("*")))
        set_block_config(self.state, enabled=True)
        with patch("tools.agentbus_v2.block_diagnosis.read_snapshot", return_value=self.snapshot), \
             patch("tools.agentbus_v2.block_diagnosis.decide", return_value=self.action):
            supervisor.observe("P1", self.action, EffectResult(False, "Codex guardian could not start or own the executor"), entry=entry)
        self.assertEqual(1, len(list((self.state / "P1" / "block" / "outbox").glob("*"))))


if __name__ == "__main__":
    unittest.main()
