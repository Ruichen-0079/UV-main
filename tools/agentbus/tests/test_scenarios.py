from __future__ import annotations

import os

from agentbus.machine import (
    BLOCKED_FOR_REVIEW,
    IMPLEMENTING,
    PAUSED,
    READY_FOR_AUDIT,
    READY_FOR_GPT,
    RECOVERY_REQUIRED,
    RE_REVIEW_REQUIRED,
    WAITING_FOR_SPEC,
)
from agentbus.protocol import parse_one
from agentbus.tests.harness import AgentbusTest


class ScenarioTests(AgentbusTest):
    def test_impl_refuses_missing_worktree(self) -> None:
        result = self.agentctl("create", "s1", "--goal", "no tree")
        self.assertEqual(result.returncode, 0)
        head = self.git("rev-parse", "HEAD")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        result = self.agentctl("run", "s1", "impl", "--once")
        self.assertEqual(result.returncode, 2)
        self.assertIn("no impl worktree", (result.stderr or "") + (result.stdout or ""))

    def test_two_streams_isolated(self) -> None:
        self.create_stream("p7-9a", "--goal", "A")
        self.create_stream("p7-9b", "--goal", "B")
        self.ok("set-model", "p7-9a", "impl", "gpt-5.6-terra", "--effort", "high")
        self.ok("set-model", "p7-9a", "audit", "gpt-5.6-sol", "--effort", "high")
        self.ok("set-model", "p7-9b", "impl", "gpt-5.6-luna", "--effort", "max")
        self.ok("set-model", "p7-9b", "audit", "gpt-5.6-terra", "--effort", "high")
        a = self.store("p7-9a").load()
        b = self.store("p7-9b").load()
        self.assertEqual(a["roles"]["impl"]["model"], "gpt-5.6-terra")
        self.assertEqual(a["roles"]["audit"]["model"], "gpt-5.6-sol")
        self.assertEqual(b["roles"]["impl"]["model"], "gpt-5.6-luna")
        self.assertEqual(b["roles"]["audit"]["effort"], "high")
        self.assertNotEqual(self.store("p7-9a").path, self.store("p7-9b").path)
        status = self.ok("status")
        self.assertIn("p7-9a", status)
        self.assertIn("p7-9b", status)

    def test_model_change_while_paused(self) -> None:
        self.create_stream("p7-9a")
        self.ok("pause", "p7-9a")
        self.ok("set-model", "p7-9a", "impl", "gpt-5.6-sol", "--effort", "xhigh")
        state = self.store("p7-9a").load()
        self.assertEqual(state["control"], "paused")
        self.assertEqual(state["roles"]["impl"]["model"], "gpt-5.6-sol")
        self.assertEqual(state["roles"]["impl"]["effort"], "xhigh")
        self.ok("resume", "p7-9a")
        self.assertEqual(self.store("p7-9a").load()["control"], "running")

    def test_spec_survives_without_gpt(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream("s1", "--goal", "keep going")
        spec = self.spec_text("s1", head)
        result = self.agentctl("submit", "s1", "--file", self._write("spec.md", spec))
        self.assertEqual(result.returncode, 0)
        state = self.store("s1").load()
        self.assertEqual(state["phase"], IMPLEMENTING)
        # Browser GPT A is gone. Local durable spec remains.
        self.assertIn("GPT_SPEC", state["envelopes"])
        brief = self.ok("brief", "s1")
        self.assertIn("CURRENT SPEC:", brief)
        self.assertIn("BASE_HEAD:", brief)
        self.assertIn(head, brief)

    def test_new_gpt_recovers_from_brief(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream("s1", "--pr", "24", "--goal", "recover me")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        os.environ["FAKE_CODEX_STREAM"] = "s1"
        os.environ["FAKE_CODEX_KIND"] = "CODEX_REPORT"
        os.environ["FAKE_CODEX_COMMIT"] = "impl.txt"
        self.ok("run", "s1", "impl", "--once")
        os.environ["FAKE_CODEX_KIND"] = "CODEX_AUDIT"
        os.environ["FAKE_CODEX_STATUS"] = "PASS"
        self.ok("run", "s1", "audit", "--once")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], READY_FOR_GPT)
        brief = self.ok("brief", "s1")
        for needle in (
            "STREAM: s1",
            "GOAL:",
            "IMPLEMENTATION RESULT:",
            "AUDIT RESULT:",
            "NEXT ACTION:",
            "previous chat",
        ):
            self.assertIn(needle, brief)
        inbox = self.ok("inbox")
        self.assertIn("S1", inbox.upper())
        self.assertIn("READY_FOR_GPT", inbox)

    def test_stale_spec_head(self) -> None:
        first = self.git("rev-parse", "HEAD")
        self.create_stream("s1")
        self.commit_file("other.md", "x\n", "diverge")
        # Craft a fake SHA that is not in the repo
        stale = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        result = self.agentctl("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", stale)))
        self.assertEqual(result.returncode, 0)
        state = self.store("s1").load()
        self.assertEqual(state["phase"], RE_REVIEW_REQUIRED)
        self.assertNotEqual(first, "")

    def test_external_head_change(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream( "s1", "--create-worktree")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        os.environ["FAKE_CODEX_STREAM"] = "s1"
        os.environ["FAKE_CODEX_COMMIT"] = "impl.txt"
        self.ok("run", "s1", "impl", "--once")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], READY_FOR_AUDIT)
        impl = state["impl_worktree"]
        self.commit_file("sneak.md", "external\n", "external change", cwd=impl)
        self.ok("doctor")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], RE_REVIEW_REQUIRED)

    def test_impl_crash(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream( "s1")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        os.environ["FAKE_CODEX_CRASH"] = "1"
        os.environ["FAKE_CODEX_STREAM"] = "s1"
        result = self.agentctl("run", "s1", "impl", "--once")
        self.assertNotEqual(result.returncode, 0)
        state = self.store("s1").load()
        self.assertEqual(state["phase"], IMPLEMENTING)
        self.assertEqual((state.get("wait") or {}).get("kind"), "RUNNER_TEMPORARY")

    def test_audit_crash(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream( "s1")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        os.environ["FAKE_CODEX_STREAM"] = "s1"
        os.environ["FAKE_CODEX_COMMIT"] = "impl.txt"
        self.ok("run", "s1", "impl", "--once")
        os.environ["FAKE_CODEX_CRASH"] = "1"
        result = self.agentctl("run", "s1", "audit", "--once")
        self.assertNotEqual(result.returncode, 0)
        state = self.store("s1").load()
        self.assertEqual(state["phase"], "AUDITING")
        self.assertEqual((state.get("wait") or {}).get("kind"), "RUNNER_TEMPORARY")

    def test_audit_changes_required_and_max_cycles(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream( "s1")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        os.environ["FAKE_CODEX_STREAM"] = "s1"
        os.environ["FAKE_CODEX_COMMIT"] = "impl.txt"
        self.ok("run", "s1", "impl", "--once")
        os.environ.pop("FAKE_CODEX_COMMIT", None)
        os.environ["FAKE_CODEX_KIND"] = "CODEX_AUDIT"
        os.environ["FAKE_CODEX_STATUS"] = "CHANGES_REQUIRED"
        os.environ["FAKE_CODEX_FINDINGS"] = "bug in foo"
        self.ok("run", "s1", "audit", "--once")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], IMPLEMENTING)
        self.assertEqual(state["repair_cycles"], 1)
        # second cycle
        os.environ["FAKE_CODEX_KIND"] = "CODEX_REPORT"
        os.environ["FAKE_CODEX_STATUS"] = "READY_FOR_AUDIT"
        os.environ["FAKE_CODEX_COMMIT"] = "impl2.txt"
        os.environ.pop("FAKE_CODEX_CRASH", None)
        self.ok("run", "s1", "impl", "--once")
        os.environ.pop("FAKE_CODEX_COMMIT", None)
        os.environ["FAKE_CODEX_KIND"] = "CODEX_AUDIT"
        os.environ["FAKE_CODEX_STATUS"] = "CHANGES_REQUIRED"
        self.ok("run", "s1", "audit", "--once")
        state = self.store("s1").load()
        self.assertEqual(state["repair_cycles"], 2)
        self.assertEqual(state["phase"], IMPLEMENTING)
        os.environ["FAKE_CODEX_KIND"] = "CODEX_REPORT"
        os.environ["FAKE_CODEX_COMMIT"] = "impl3.txt"
        self.ok("run", "s1", "impl", "--once")
        os.environ.pop("FAKE_CODEX_COMMIT", None)
        os.environ["FAKE_CODEX_KIND"] = "CODEX_AUDIT"
        os.environ["FAKE_CODEX_STATUS"] = "CHANGES_REQUIRED"
        self.ok("run", "s1", "audit", "--once")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], BLOCKED_FOR_REVIEW)
        inbox = self.ok("inbox")
        self.assertIn("BLOCKED_FOR_REVIEW", inbox)

    def test_pause_resume_step(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream( "s1")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        self.ok("pause", "s1")
        state = self.store("s1").load()
        self.assertEqual(state["control"], "paused")
        os.environ["FAKE_CODEX_STREAM"] = "s1"
        os.environ["FAKE_CODEX_COMMIT"] = "impl.txt"
        # paused runner should not invoke
        out = self.ok("run", "s1", "impl", "--once")
        self.assertIn("No work", out)
        self.assertEqual(self.store("s1").load()["phase"], IMPLEMENTING)
        self.ok("resume", "s1")
        self.ok("step", "s1")
        self.assertEqual(self.store("s1").load()["phase"], READY_FOR_AUDIT)

    def test_github_unavailable_and_unauth(self) -> None:
        self.create_stream( "s1", "--pr", "24")
        os.environ["FAKE_GH_MODE"] = "down"
        out = self.ok("sync", "s1")
        self.assertIn("unavailable", out.lower() + self.store("s1").load()["github"]["last_error"].lower())
        os.environ["FAKE_GH_MODE"] = "unauth"
        self.ok("sync", "s1")
        self.assertTrue(self.store("s1").load()["github"]["unauthenticated"])
        # local inbox still works
        head = self.git("rev-parse", "HEAD")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        self.assertEqual(self.store("s1").load()["phase"], IMPLEMENTING)

    def test_no_active_pr(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream( "local-only", "--goal", "no pr")
        self.ok("submit", "local-only", "--file", self._write("spec.md", self.spec_text("local-only", head)))
        plan = self.ok("plan", "local-only")
        self.assertIn("local inbox", plan)
        self.assertEqual(self.store("local-only").load()["pr"], None)

    def test_dirty_worktree_reported(self) -> None:
        self.create_stream( "s1", "--create-worktree")
        state = self.store("s1").load()
        impl = state["impl_worktree"]
        with open(os.path.join(impl, "dirty.txt"), "w", encoding="utf-8") as handle:
            handle.write("dirt\n")
        code, _ = __import__("agentbus.doctor", fromlist=["doctor"]).doctor(self.ctx)
        self.assertIn("dirty", self.ok("doctor").lower())
        self.assertIsInstance(code, int)

    def test_audit_isolation(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream( "s1", "--create-worktree")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        os.environ["FAKE_CODEX_STREAM"] = "s1"
        os.environ["FAKE_CODEX_COMMIT"] = "impl.txt"
        self.ok("run", "s1", "impl", "--once")
        os.environ.pop("FAKE_CODEX_COMMIT", None)
        os.environ["FAKE_CODEX_KIND"] = "CODEX_AUDIT"
        os.environ["FAKE_CODEX_STATUS"] = "PASS"
        self.ok("run", "s1", "audit", "--once")
        state = self.store("s1").load()
        self.assertNotEqual(state["impl_worktree"], state["audit_worktree"])
        self.assertTrue(os.path.isdir(state["audit_worktree"]))
        self.assertEqual(state["roles"]["audit"]["sandbox"], "read-only")
        self.assertEqual(state["roles"]["impl"]["sandbox"], "workspace-write")

    def test_stale_pid_recovery(self) -> None:
        self.create_stream( "s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = IMPLEMENTING
        store.save(state)
        runtime = store.load_runtime()
        runtime["impl"]["pid"] = 999999
        runtime["impl"]["start_token"] = "nope"
        store.save_runtime(runtime)
        self.ok("doctor")
        state = store.load()
        self.assertEqual(state["phase"], RECOVERY_REQUIRED)
        self.assertIsNone(store.load_runtime()["impl"]["pid"])

    def test_status_and_plan_are_deterministic(self) -> None:
        self.create_stream( "a1")
        self.create_stream( "b1")
        first = self.ok("status")
        second = self.ok("status")
        self.assertEqual(first, second)
        self.assertNotIn("Invoking Codex", first)
        plan = self.ok("plan")
        self.assertIn("IMPL MODEL/PROFILE", plan)
        self.assertIn("AUDIT MODEL/PROFILE", plan)

    def test_gpt_accept_to_final_gate_no_merge(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream( "s1")
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        os.environ["FAKE_CODEX_STREAM"] = "s1"
        os.environ["FAKE_CODEX_COMMIT"] = "impl.txt"
        self.ok("run", "s1", "impl", "--once")
        os.environ.pop("FAKE_CODEX_COMMIT", None)
        os.environ["FAKE_CODEX_KIND"] = "CODEX_AUDIT"
        os.environ["FAKE_CODEX_STATUS"] = "PASS"
        self.ok("run", "s1", "audit", "--once")
        implemented = self.store("s1").load()["heads"]["implemented"]
        review = f"""[GPT_REVIEW]
STATUS: ACCEPT
STREAM: s1
REVIEWED_HEAD: {implemented}
NEXT_ACTION: FINAL_GATE
"""
        self.ok("submit", "s1", "--file", self._write("review.md", review))
        state = self.store("s1").load()
        self.assertEqual(state["phase"], "FINAL_GATE")

    def test_parse_helper_used(self) -> None:
        env = parse_one(self.spec_text("z", "abc"))
        self.assertEqual(env.kind, "GPT_SPEC")

    def _write(self, name: str, content: str) -> str:
        path = os.path.join(self.root, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return path
