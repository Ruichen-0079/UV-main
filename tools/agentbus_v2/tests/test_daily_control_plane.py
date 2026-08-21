from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2 import webui
from tools.agentbus_v2.core import Action, ActionKind, Snapshot
from tools.agentbus_v2.effects import EffectResult
from tools.agentbus_v2.scheduler import (
    ProjectEntry,
    archive_project,
    load_registry,
    register_project,
    remove_project,
)


SHA = "1" * 40


def config(root: Path, p_id: str, worktree: Path) -> None:
    p = root / p_id
    p.mkdir(parents=True, exist_ok=True)
    (p / "config.json").write_text(json.dumps({
        "p_id": p_id, "worktree": str(worktree),
        "repository": "github.com/test/repo", "remote": "origin",
        "branch": "agentbus/" + p_id.lower(), "base_ref": "main",
        "seed_head": SHA, "charter_digest": "c" * 64,
        "proof_commands": [], "required_ci_checks": [],
    }), encoding="utf-8")
    (p / "charter.md").write_text("# bounded task\n", encoding="utf-8")


class DailyControlPlaneTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.state = root / "state"
        self.state.mkdir()
        self.worktree = root / "worktree"
        self.worktree.mkdir()
        config(self.state, "P1", self.worktree)
        (self.state / "projects.json").write_text(json.dumps({"projects": [
            {"p_id": "P1", "enabled": False, "allow_merge": False}
        ]}), encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def snapshot(self, **changes):
        value = Snapshot("P1", "c" * 64, "github.com/test/repo", "agentbus/p1",
                         "main", SHA, SHA)
        return replace(value, **changes)

    def test_archive_is_operational_and_semantic_facts_remain(self):
        before = (self.state / "P1" / "config.json").read_text()
        result = archive_project(self.state, "P1")
        self.assertTrue(result.entries[0].archived)
        self.assertFalse(result.entries[0].enabled)
        self.assertEqual(before, (self.state / "P1" / "config.json").read_text())
        self.assertEqual((), load_registry(self.state).enabled)
        result = archive_project(self.state, "P1", archived=False)
        self.assertFalse(result.entries[0].archived)
        self.assertFalse(result.entries[0].enabled)

    def test_register_new_project_defaults_disabled_and_remove_keeps_facts(self):
        root = self.state / "P2"
        root.mkdir()
        config(self.state, "P2", self.worktree.parent / "worktree2")
        register_project(self.state, ProjectEntry("P2", enabled=False))
        self.assertFalse(next(p for p in load_registry(self.state).entries if p.p_id == "P2").enabled)
        remove_project(self.state, "P2")
        self.assertTrue((self.state / "P2" / "config.json").exists())

    def test_status_projection_unbound_plan_is_attention_without_mutating_facts(self):
        state = webui.WebUIState(self.state)
        snap = self.snapshot(gpt_pending=frozenset({"plan-" + "a" * 24}))
        action = Action(ActionKind.PLAN, effect_id="plan-" + "a" * 24, reason="need PLAN")
        with patch.object(webui, "read_snapshot", return_value=snap), \
                patch.object(webui, "decide", return_value=action), \
                patch.object(webui, "_worktree_observation", return_value=(True, None)):
            value = state.status()
        row = value["projects"][0]
        self.assertEqual("AWAITING_PLAN_BINDING", row["status_code"])
        self.assertEqual("等待 PLAN 会话绑定", row["semantic_status"])
        self.assertTrue(row["attention"])
        self.assertFalse(row["active"])
        self.assertEqual("bind-plan", row["primary_action"]["key"])
        state.stop_scheduler()

    def test_status_projection_work_running_and_executor_binding(self):
        state = webui.WebUIState(self.state)
        action = Action(ActionKind.WORK, effect_id="work-" + "a" * 24)
        with patch.object(webui, "read_snapshot", return_value=self.snapshot()), \
                patch.object(webui, "decide", return_value=action), \
                patch.object(webui, "_worktree_observation", return_value=(True, None)), \
                patch.object(state.scheduler, "is_in_flight", return_value=True):
            row = state.status()["projects"][0]
        self.assertEqual("WORK_RUNNING", row["status_code"])
        self.assertEqual("gpt-5.6-luna", row["executor"]["model"])
        self.assertEqual("max", row["executor"]["reasoning_effort"])
        state.stop_scheduler()

    def test_status_projection_prove_fail_human_and_merge_fence(self):
        state = webui.WebUIState(self.state)
        failed = Action(ActionKind.PROVE, reason="proof")
        with patch.object(webui, "read_snapshot", return_value=self.snapshot()), \
                patch.object(webui, "decide", return_value=failed), \
                patch.object(webui, "_worktree_observation", return_value=(True, None)):
            row = state.status()["projects"][0]
        self.assertEqual("PROVE", row["action"])
        self.assertEqual("PROVE", row["status_code"])
        state.stop_scheduler()

    def test_refresh_is_read_only_and_html_is_chinese(self):
        state = webui.WebUIState(self.state)
        with patch.object(state.scheduler, "run_once") as tick:
            value = state.status()
        tick.assert_not_called()
        html = webui.render_index(state.token).decode()
        for text in ("刷新", "新建任务", "接管现有 PR", "需要处理", "运行中",
                     "已暂停", "已归档", "立即检查 / Tick now", "日志 / 证据"):
            self.assertIn(text, html)
        self.assertIn('class="manual-fallback"', html)
        self.assertNotIn('class="manual-fallback" open', html)
        self.assertNotIn("prompt(", html)
        self.assertIn("task-list", html)
        self.assertIn("attention-row", html)
        self.assertIn("要求重新规划", html)
        self.assertIn("@media(max-width:760px)", html)
        self.assertEqual(1, len(value["projects"]))
        state.stop_scheduler()

    def test_lifecycle_grouping_is_enabled_not_inflight(self):
        root = self.state
        config(root, "P2", self.worktree.parent / "worktree2")
        (root / "projects.json").write_text(json.dumps({"projects": [
            {"p_id": "P1", "enabled": True},
            {"p_id": "P2", "enabled": False},
        ]}), encoding="utf-8")
        state = webui.WebUIState(root)
        snap = self.snapshot()
        with patch.object(webui, "read_snapshot", return_value=snap), \
                patch.object(webui, "decide", return_value=Action(ActionKind.IDLE)), \
                patch.object(webui, "_worktree_observation", return_value=(True, None)), \
                patch.object(state.scheduler, "is_in_flight", return_value=False):
            value = state.status()
        self.assertEqual({"P1"}, {p["p_id"] for p in value["active"]})
        self.assertEqual({"P2"}, {p["p_id"] for p in value["paused"]})
        self.assertEqual([], value["running"])
        state.stop_scheduler()

    def test_attention_is_not_a_second_full_card_renderer(self):
        html = webui.render_index("test-token").decode()
        self.assertIn("function attentionRow", html)
        self.assertIn("function taskCard", html)
        self.assertIn("map(attentionRow)", html)
        self.assertIn("list.map(taskCard)", html)

    def test_archived_entry_cannot_be_enabled_through_webui(self):
        state = webui.WebUIState(self.state)
        archive_project(self.state, "P1")
        with self.assertRaises(webui.WebUIError):
            state.set_enabled("P1", True)
        state.stop_scheduler()

    def test_attention_is_projection_only(self):
        state = webui.WebUIState(self.state)
        with patch.object(webui, "read_snapshot", side_effect=RuntimeError("not used")):
            # status catches durable fact errors; runtime exceptions are not
            # silently converted into a persisted blocker.
            with self.assertRaises(RuntimeError):
                state.status()
        self.assertFalse((self.state / "P1" / "block_reason.json").exists())
        state.stop_scheduler()


if __name__ == "__main__":
    unittest.main()
