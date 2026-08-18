from __future__ import annotations

import json
import os
import threading
import time

from agentbus.actions import request_audit_current, resolve_audit_target, set_role_model
from agentbus.github import sync_with_lease
from agentbus.machine import IMPLEMENTING, READY_FOR_AUDIT, READY_FOR_GPT, WAITING_FOR_SPEC
from agentbus.runner import (
    already_done,
    audit_work_key,
    impl_work_key,
    mark_done,
    role_should_work,
    run_role,
    waiting_banner,
)
from agentbus.tests.harness import AgentbusTest
from agentbus.views import needs_you, stream_view


class WatchTests(AgentbusTest):
    def test_impl_waiting_banner_implementing(self) -> None:
        state = {"stream_id": "p4_2d2", "phase": IMPLEMENTING, "github": {}}
        banner = waiting_banner(state, "impl", github={})
        self.assertIn("IMPLEMENTING", banner)
        self.assertIn("WAITING", banner)

    def test_impl_waiting_banner_ready_for_gpt(self) -> None:
        state = {"stream_id": "p4_2d2", "phase": READY_FOR_GPT, "github": {}}
        banner = waiting_banner(state, "impl", github={})
        self.assertIn("READY_FOR_GPT", banner)
        self.assertIn("Waiting for Browser GPT review", banner)

    def test_needs_you_skips_ready_for_audit_and_repair(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        self.assertFalse(needs_you(state))
        state["phase"] = READY_FOR_AUDIT
        store.save(state)
        self.assertFalse(needs_you(store.load()))
        state = store.load()
        state["phase"] = IMPLEMENTING
        state["repair_cycles"] = 1
        store.save(state)
        self.assertFalse(needs_you(store.load()))
        state = store.load()
        state["phase"] = READY_FOR_GPT
        store.save(state)
        self.assertFalse(needs_you(store.load()))
        from agentbus.machine import FINAL_GATE

        state = store.load()
        state["phase"] = FINAL_GATE
        store.save(state)
        self.assertFalse(needs_you(store.load()))

    def test_effort_max_ultra_and_independent_roles(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        set_role_model(store, "impl", model="gpt-5.6-terra", effort="max")
        set_role_model(store, "audit", model="gpt-5.6-sol", effort="none", execution_mode="standard")
        state = store.load()
        self.assertEqual(state["roles"]["impl"]["effort"], "max")
        self.assertEqual(state["roles"]["audit"]["effort"], "none")
        view = stream_view(self.ctx, store)
        self.assertEqual(view["impl"]["effective"]["effort"], "max")
        self.assertEqual(view["audit"]["effective"]["effort"], "none")
        self.assertEqual(view["impl"]["effective"]["effort_source"], "stream override")
        self.assertNotEqual(view["impl"]["model"], view["audit"]["model"])

    def test_new_report_digest_wakes_audit(self) -> None:
        from agentbus.runner import already_done, audit_work_key, mark_done

        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_AUDIT
        state["heads"]["implemented"] = "a" * 40
        state["repair_cycles"] = 1
        state["envelopes"]["CODEX_REPORT"] = {"digest": "old"}
        store.save(state)
        mark_done(store, "audit", audit_work_key(store.load()))
        state = store.load()
        state["envelopes"]["CODEX_REPORT"] = {"digest": "new"}
        store.save(state)
        self.assertFalse(already_done(store.load_runtime(), "audit", audit_work_key(store.load())))

    def test_completed_impl_not_rerun(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = IMPLEMENTING
        store.save(state)
        key = impl_work_key(state)
        mark_done(store, "impl", key)
        self.assertTrue(already_done(store.load_runtime(), "impl", key))
        self.assertTrue(role_should_work(store.load(), "impl"))

    def test_audit_current_sha_fence(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["heads"]["implemented"] = head
        state["heads"]["current"] = head
        state["phase"] = READY_FOR_GPT
        store.save(state)
        preview = resolve_audit_target(store.load())
        self.assertTrue(preview["ok"])
        self.assertEqual(preview["target"], head)
        self.assertEqual(preview["source"], "IMPLEMENTED_HEAD")
        request_audit_current(store, expected_target=head)
        state = store.load()
        self.assertEqual(state["phase"], READY_FOR_AUDIT)
        self.assertEqual(state["audit_request"]["target"], head)
        self.assertTrue(role_should_work(state, "audit"))
        self.assertIn("req", audit_work_key(state))

    def test_audit_current_refuses_mismatched_head(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["heads"]["implemented"] = "a" * 40
        state["heads"]["current"] = "b" * 40
        store.save(state)
        preview = resolve_audit_target(store.load())
        self.assertFalse(preview["ok"])

    def test_github_lease_and_duplicate_comment(self) -> None:
        os.environ["YUVI_AGENTBUS_SYNC_INTERVAL"] = "30"
        self.create_stream("s1", "--pr", "24")
        store = self.store("s1")
        comments = os.path.join(self.root, "comments.json")
        head = self.git("rev-parse", "HEAD")
        payload = [
            {
                "id": 1,
                "body": (
                    "[GPT_SPEC]\nSTATUS: ACTIONABLE\nSTREAM: s1\n"
                    f"BASE_HEAD: {head}\nSCOPE: x\nACCEPTANCE_CRITERIA: y\n"
                ),
            }
        ]
        with open(comments, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.environ["FAKE_GH_COMMENTS"] = comments
        state = store.load()
        notes1 = sync_with_lease(
            store, state, repo_root=self.repo, origin=self.ctx.origin, current_head=head, force=True
        )
        store.save(state)
        self.assertTrue(any("GPT_SPEC" in n for n in notes1))
        state = store.load()
        notes2 = sync_with_lease(
            store, state, repo_root=self.repo, origin=self.ctx.origin, current_head=head, force=True
        )
        self.assertEqual(notes2, [])
        self.assertEqual(store.load()["seen_comment_ids"].count("1"), 1)

    def test_github_outage_does_not_kill_watch(self) -> None:
        os.environ["YUVI_AGENTBUS_POLL"] = "0.05"
        os.environ["FAKE_GH_MODE"] = "down"
        self.create_stream("s1", "--pr", "24")
        store = self.store("s1")
        errors: list[str] = []

        def run() -> None:
            try:
                run_role(self.ctx, store, "impl", once=True, env=os.environ.copy())
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))

        thread = threading.Thread(target=run)
        thread.start()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(store.load()["phase"], WAITING_FOR_SPEC)

    def test_watch_stays_after_no_work(self) -> None:
        os.environ["YUVI_AGENTBUS_POLL"] = "0.05"
        self.create_stream("s1")
        store = self.store("s1")
        start = time.time()
        run_role(self.ctx, store, "audit", once=True)
        self.assertLess(time.time() - start, 2)
        self.assertEqual(store.load()["phase"], WAITING_FOR_SPEC)
