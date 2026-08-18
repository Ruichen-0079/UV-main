from __future__ import annotations

import os

from agentbus.apply import apply_envelope
from agentbus.generation import complete_owned_publication, reconcile_owned_repair
from agentbus.machine import (
    IMPLEMENTING,
    READY_FOR_AUDIT,
    READY_FOR_GPT,
    RE_REVIEW_REQUIRED,
    WAITING_FOR_SPEC,
)
from agentbus.protocol import parse_one
from agentbus.recover import recover_stream
from agentbus.tests.harness import AgentbusTest
from agentbus.util import atomic_write_text


class GenerationTests(AgentbusTest):
    def _head(self, cwd: str | None = None) -> str:
        return self.git("rev-parse", "HEAD", cwd=cwd)

    def _report(self, stream: str, sha: str) -> None:
        text = f"""[CODEX_REPORT]
STATUS: READY_FOR_AUDIT
STREAM: {stream}
IMPLEMENTED_HEAD: {sha}
CHANGED_FILES: x
NEXT_ACTION: AUDIT
"""
        store = self.store(stream)
        state = store.load()
        if state["phase"] in {WAITING_FOR_SPEC}:
            state["phase"] = IMPLEMENTING
        apply_envelope(store, state, parse_one(text), repo=state.get("impl_worktree") or self.repo, current_head=sha)
        store.save(state)

    def _audit(self, stream: str, sha: str, status: str) -> None:
        text = f"""[CODEX_AUDIT]
STATUS: {status}
STREAM: {stream}
AUDITED_HEAD: {sha}
FINDINGS: test
NEXT_ACTION: READY_FOR_GPT
"""
        store = self.store(stream)
        state = store.load()
        apply_envelope(
            store,
            state,
            parse_one(text),
            repo=state.get("impl_worktree") or self.repo,
            current_head=sha,
        )
        store.save(state)

    def _publish_owned(self, stream: str, rel: str) -> str:
        cwd = self.store(stream).load()["impl_worktree"] or self.repo
        parent = self._head(cwd)
        self.commit_file(rel, "owned\n", f"agentbus({stream}): apply GPT_SPEC test", cwd=cwd)
        sha = self._head(cwd)
        store = self.store(stream)
        state = store.load()
        complete_owned_publication(state, commit=sha, parent=parent)
        state["publication"]["status"] = "pushed"
        state["publication"]["remote_sha"] = sha
        state["publication"]["pushed"] = True
        store.save(state)
        return sha

    def test_audit_pass_same_head_ready_for_gpt(self) -> None:
        self.create_stream("s1")
        h1 = self._publish_owned("s1", "a.txt")
        self._report("s1", h1)
        self._audit("s1", h1, "PASS")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], READY_FOR_GPT)
        self.assertEqual(state["heads"]["audited"], h1)
        self.assertEqual(state["heads"]["implemented"], h1)

    def test_owned_repair_does_not_re_review(self) -> None:
        self.create_stream("s1")
        h1 = self._publish_owned("s1", "a.txt")
        self._report("s1", h1)
        self._audit("s1", h1, "CHANGES_REQUIRED")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], IMPLEMENTING)
        self.assertEqual(state["repair_cycles"], 1)
        h2 = self._publish_owned("s1", "b.txt")
        self.assertNotEqual(h1, h2)
        self._report("s1", h2)
        state = self.store("s1").load()
        self.assertEqual(state["phase"], READY_FOR_AUDIT)
        self.assertEqual(state["heads"]["implemented"], h2)
        self.assertEqual(state["heads"]["prior_audited"], h1)
        self.assertIsNone(state["heads"]["audited"])
        self.assertEqual(state["repair_cycles"], 1)
        # stale H1 audit must not poison
        self._audit("s1", h1, "CHANGES_REQUIRED")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], READY_FOR_AUDIT)
        self.assertEqual(state["heads"]["implemented"], h2)
        self.assertNotEqual(state["phase"], RE_REVIEW_REQUIRED)
        self.assertTrue(state.get("audit_history"))

    def test_new_audit_pass_and_changes_on_h2(self) -> None:
        self.create_stream("s1")
        h1 = self._publish_owned("s1", "a.txt")
        self._report("s1", h1)
        self._audit("s1", h1, "CHANGES_REQUIRED")
        h2 = self._publish_owned("s1", "b.txt")
        self._report("s1", h2)
        self._audit("s1", h2, "PASS")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], READY_FOR_GPT)
        self.assertEqual(state["heads"]["audited"], h2)
        self.assertEqual(state["repair_cycles"], 1)
        # reset to repair again
        state["phase"] = READY_FOR_AUDIT
        state["status"]["audit"] = "WAITING"
        self.store("s1").save(state)
        self._audit("s1", h2, "CHANGES_REQUIRED")
        state = self.store("s1").load()
        self.assertEqual(state["repair_cycles"], 2)

    def test_unknown_and_human_descendant_drift(self) -> None:
        self.create_stream("s1", "--create-worktree")
        impl = self.store("s1").load()["impl_worktree"]
        h1 = self._publish_owned("s1", "a.txt")
        self._report("s1", h1)
        self.assertEqual(self.store("s1").load()["phase"], READY_FOR_AUDIT)
        self.commit_file("sneak.md", "nope\n", "human push", cwd=impl)
        recover_stream(self.store("s1"), self.store("s1").load())
        # recover_stream saves runtime but we need to persist phase
        store = self.store("s1")
        state = store.load()
        notes = recover_stream(store, state)
        store.save(state)
        self.assertEqual(state["phase"], RE_REVIEW_REQUIRED, notes)

    def test_report_without_owned_publication_untrusted(self) -> None:
        self.create_stream("s1")
        fake = "ab" * 20
        text = f"""[CODEX_REPORT]
STATUS: READY_FOR_AUDIT
STREAM: s1
IMPLEMENTED_HEAD: {fake}
NEXT_ACTION: AUDIT
"""
        store = self.store("s1")
        state = store.load()
        state["phase"] = IMPLEMENTING
        apply_envelope(store, state, parse_one(text), repo=self.repo, current_head=fake)
        self.assertEqual(state["phase"], RE_REVIEW_REQUIRED)

    def test_reconcile_owned_repair_live_shape(self) -> None:
        self.create_stream("s1")
        h1 = self._publish_owned("s1", "a.txt")
        self._report("s1", h1)
        self._audit("s1", h1, "CHANGES_REQUIRED")
        h2 = self._publish_owned("s1", "b.txt")
        store = self.store("s1")
        state = store.load()
        state["phase"] = RE_REVIEW_REQUIRED
        state["status"]["blocker"] = f"AUDITED_HEAD vs IMPLEMENTED_HEAD {h1[:7]} does not match current HEAD {h2[:7]}"
        state["heads"]["audited"] = h1
        state["heads"]["implemented"] = h2
        state["heads"]["current"] = h2
        notes = reconcile_owned_repair(state)
        store.save(state)
        self.assertEqual(state["phase"], READY_FOR_AUDIT, notes)
        self.assertIsNone(state["status"]["blocker"])
        self.assertEqual(state["heads"]["prior_audited"], h1)
        self.assertIsNone(state["heads"]["audited"])
        self.assertEqual(state["repair_cycles"], 1)
