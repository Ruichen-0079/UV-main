from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import Mock, patch

from agentbus.autopilot import campaign_tick, ensure_executor_surface
from agentbus.decision import AUDIT, FINAL_GPT, HUMAN, IMPL, MERGE, PRODUCT_GPT, WAIT, WorkflowDecision
from agentbus.konsolebind import AGENTBUS_EXECUTOR_GENERATION, role_title
from agentbus.runner import impl_work_key
from agentbus.tests.harness import AgentbusTest
from agentbus.util import pid_start_token


class ExecutorSurfaceTests(AgentbusTest):
    def _decision(self, action: str) -> WorkflowDecision:
        return WorkflowDecision(action, "test decision")

    def _impl_stream(self, stream: str = "s1"):
        self.create_stream(stream, "--worktree", self.repo)
        return self.store(stream)

    def _owned_slot(self, stream: str, role: str, *, runner_pid: int, runner_token: str, generation: str):
        pid = os.getpid()
        return {
            "pid": pid,
            "dbus": f"org.kde.konsole-{pid}",
            "session": "1",
            "title": role_title(stream, role),
            "owner": "agentbus",
            "managed_by": "agentbus",
            "stream_id": stream,
            "role": role,
            "runner_stream_id": stream,
            "runner_role": role,
            "runner_generation": generation,
            "runner_pid": runner_pid,
            "runner_token": runner_token,
            "runner_start_token": runner_token,
            "runner_pending": False,
        }

    def test_impl_decision_without_runner_launches_one(self) -> None:
        store = self._impl_stream()
        with patch(
            "agentbus.konsolebind._launch_executor_process",
            return_value=SimpleNamespace(pid=41001),
        ) as popen:
            result = ensure_executor_surface(self.ctx, store, store.load(), self._decision(IMPL))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "launched")
        self.assertEqual(popen.call_count, 1)
        slot = store.load_runtime()["konsole"]["impl"]
        self.assertEqual(slot["title"], "S1 | IMPL")
        self.assertEqual(slot["runner_generation"], AGENTBUS_EXECUTOR_GENERATION)
        self.assertTrue(slot["runner_pending"])

    def test_audit_decision_without_runner_launches_one(self) -> None:
        store = self._impl_stream()
        state = store.load()
        state["heads"]["implemented"] = self.git("rev-parse", "HEAD")
        store.save(state)
        state = store.load()
        popen = Mock(return_value=SimpleNamespace(pid=41002))
        with patch("agentbus.konsolebind._launch_executor_process", popen):
            result = ensure_executor_surface(self.ctx, store, state, self._decision(AUDIT))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "launched")
        self.assertEqual(popen.call_count, 1)
        self.assertTrue(os.path.isdir(state["audit_worktree"]))
        self.assertEqual(store.load_runtime()["konsole"]["audit"]["title"], "S1 | AUDIT")

    def test_existing_live_matching_runner_is_reused(self) -> None:
        store = self._impl_stream()
        token = pid_start_token(os.getpid())
        runtime = store.load_runtime()
        runtime["konsole"]["impl"] = self._owned_slot(
            "s1",
            "impl",
            runner_pid=os.getpid(),
            runner_token=token or "current",
            generation=AGENTBUS_EXECUTOR_GENERATION,
        )
        store.save_runtime(runtime)
        with patch("agentbus.konsolebind._launch_executor_process") as popen:
            result = ensure_executor_surface(self.ctx, store, store.load(), self._decision(IMPL))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "reused")
        popen.assert_not_called()

    def test_dead_runner_is_replaced(self) -> None:
        store = self._impl_stream()
        runtime = store.load_runtime()
        runtime["konsole"]["impl"] = self._owned_slot(
            "s1", "impl", runner_pid=42002, runner_token="dead", generation=AGENTBUS_EXECUTOR_GENERATION
        )
        store.save_runtime(runtime)
        with (
            patch("agentbus.konsolebind.pid_is_alive", side_effect=lambda pid: pid == os.getpid()),
            patch("agentbus.konsolebind.os.kill") as kill,
            patch("agentbus.konsolebind._launch_executor_process", return_value=SimpleNamespace(pid=42003)) as popen,
        ):
            result = ensure_executor_surface(self.ctx, store, store.load(), self._decision(IMPL))
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "launched")
        self.assertEqual(popen.call_count, 1)
        kill.assert_called_once_with(os.getpid(), 15)

    def test_old_runner_generation_is_safely_replaced(self) -> None:
        store = self._impl_stream()
        runtime = store.load_runtime()
        runtime["konsole"]["impl"] = self._owned_slot(
            "s1", "impl", runner_pid=os.getpid(), runner_token="old", generation="agentbus-executor-v1"
        )
        store.save_runtime(runtime)
        with (
            patch("agentbus.util.pid_start_token", return_value="old"),
            patch("agentbus.konsolebind.os.kill") as kill,
            patch("agentbus.konsolebind._launch_executor_process", return_value=SimpleNamespace(pid=42004)) as popen,
        ):
            result = ensure_executor_surface(self.ctx, store, store.load(), self._decision(IMPL))
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "launched")
        self.assertEqual(popen.call_count, 1)
        self.assertEqual(
            [call.args[0] for call in kill.call_args_list if call.args[1] == 15],
            [os.getpid(), os.getpid()],
        )

    def test_unrelated_konsole_is_never_touched(self) -> None:
        store = self._impl_stream()
        pid = os.getpid()
        runtime = store.load_runtime()
        runtime["konsole"]["impl"] = {
            "pid": pid,
            "dbus": f"org.kde.konsole-{pid}",
            "title": "USER WINDOW",
            "runner_pid": pid,
            "runner_token": pid_start_token(pid),
        }
        store.save_runtime(runtime)
        with (
            patch("agentbus.konsolebind.os.kill") as kill,
            patch("agentbus.konsolebind._launch_executor_process", return_value=SimpleNamespace(pid=42005)) as popen,
        ):
            result = ensure_executor_surface(self.ctx, store, store.load(), self._decision(IMPL))
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "launched")
        popen.assert_called_once()
        kill.assert_not_called()

    def test_non_executor_actions_do_not_launch_codex_konsole(self) -> None:
        for index, action in enumerate((PRODUCT_GPT, FINAL_GPT, WAIT, MERGE, HUMAN), start=1):
            store = self._impl_stream(f"no-{index}")
            with patch("agentbus.konsolebind._launch_executor_process") as popen:
                result = ensure_executor_surface(self.ctx, store, store.load(), self._decision(action))
            self.assertTrue(result["ok"])
            self.assertFalse(result["managed"])
            popen.assert_not_called()

    def test_missing_impl_worktree_never_falls_back_to_repo_root(self) -> None:
        store = self._impl_stream()
        state = store.load()
        state["impl_worktree"] = os.path.join(self.root, "gone-worktree")
        state["created_worktrees"]["impl"] = False
        store.save(state)
        with patch("agentbus.konsolebind._launch_executor_process") as popen:
            result = ensure_executor_surface(self.ctx, store, store.load(), self._decision(IMPL))
        self.assertFalse(result["ok"])
        self.assertIn(result["condition"], {"WAIT", "HUMAN"})
        self.assertIn(self.ctx.repo_root, result["reason"])
        popen.assert_not_called()

    def test_duplicate_ticks_are_idempotent_while_runner_starts(self) -> None:
        store = self._impl_stream()
        with (
            patch("agentbus.konsolebind._launch_executor_process", return_value=SimpleNamespace(pid=42006)) as popen,
            patch("agentbus.konsolebind.pid_is_alive", return_value=True),
        ):
            first = ensure_executor_surface(self.ctx, store, store.load(), self._decision(IMPL))
            second = ensure_executor_surface(self.ctx, store, store.load(), self._decision(IMPL))
        self.assertEqual(first["status"], "launched")
        self.assertEqual(second["status"], "starting")
        self.assertEqual(popen.call_count, 1)

    def test_p6_impl_decision_is_woken_by_campaign_tick(self) -> None:
        store = self._impl_stream("p6")
        popen = Mock(return_value=SimpleNamespace(pid=42007))
        with (
            patch(
                "agentbus.decision.decision_for_stream",
                return_value=self._decision(IMPL),
            ),
            patch("agentbus.konsolebind._launch_executor_process", popen),
        ):
            result = campaign_tick(self.ctx, stream_id="p6", force_sync=False, surface="test")
        self.assertTrue(result.get("results"), result)
        item = result["results"][0]
        self.assertEqual(item["decision"]["action"], IMPL)
        self.assertEqual(item["executor"]["status"], "launched")
        self.assertEqual(popen.call_count, 1)
        self.assertEqual(store.load_runtime()["konsole"]["impl"]["title"], "P6 | IMPL")

    def test_lifecycle_uses_injected_launcher_without_real_subprocess(self) -> None:
        store = self._impl_stream("isolated")
        with patch(
            "agentbus.konsolebind.subprocess.Popen",
            side_effect=AssertionError("real Konsole launcher reached lifecycle test"),
        ) as real_launcher:
            result = ensure_executor_surface(self.ctx, store, store.load(), self._decision(IMPL))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["status"], "launched")
        real_launcher.assert_not_called()
        self.assertEqual(len(self.executor_launches), 1)
        self.assertEqual(self.executor_launches[0]["argv"][0], "/bin/true")

    def test_final_gpt_repair_token_is_a_new_impl_generation(self) -> None:
        store = self._impl_stream("p6-key")
        state = store.load()
        before = impl_work_key(state)
        state["envelopes"]["GPT_MERGE_REVIEW"] = {
            "kind": "GPT_MERGE_REVIEW",
            "status": "REPAIR",
            "source_id": "final-review-1",
        }
        after = impl_work_key(state)
        self.assertNotEqual(before, after)
        self.assertIn("final-review-1", after)
