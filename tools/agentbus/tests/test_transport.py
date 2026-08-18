from __future__ import annotations

import os

from agentbus.apply import apply_envelope
from agentbus.campaign import after_unit_merged, load_campaign
from agentbus.gitutil import porcelain_status, rev_tree
from agentbus.machine import IMPLEMENTING, MERGED, READY_FOR_AUDIT, WORKTREE_READY
from agentbus.protocol import parse_one
from agentbus.store import StreamStore
from agentbus.tests.harness import AgentbusTest
from agentbus.tests.test_campaign import continuation_text
from agentbus.transport import (
    bootstrap_message,
    classify_branch_head,
    create_zero_tree_bootstrap,
    ensure_durable_pr_transport,
    is_bootstrap_commit,
)


class TransportTests(AgentbusTest):
    def _merged(self, stream: str, campaign: str) -> StreamStore:
        self.create_stream(stream, "--pr", "40")
        store = self.store(stream)
        state = store.load()
        state["campaign_id"] = campaign
        state["phase"] = "FINAL_GATE"
        sha = self.git("rev-parse", "HEAD")
        state["heads"]["merged"] = sha
        state["heads"]["current"] = sha
        store.save(state)
        from agentbus.apply import mark_pr_merged

        mark_pr_merged(state, store, merge_sha=sha)
        store.save(state)
        return store

    def test_successor_zero_tree_bootstrap_before_impl(self) -> None:
        store = self._merged("tb-a", "tb")
        sha = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="tb", after="tb-a", nxt="tb-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        nxt = self.store("tb-b").load()
        self.assertEqual(nxt["phase"], IMPLEMENTING)
        self.assertEqual(nxt.get("pr"), 99)
        boot = (nxt.get("transport") or {}).get("bootstrap_commit")
        self.assertTrue(boot)
        self.assertEqual(rev_tree(nxt["impl_worktree"], boot), rev_tree(nxt["impl_worktree"], sha))
        self.assertNotEqual(self.git("rev-parse", "HEAD", cwd=nxt["impl_worktree"]), sha)
        self.assertNotEqual((nxt.get("heads") or {}).get("implemented"), boot)
        self.assertEqual(nxt.get("repair_cycles") or 0, 0)
        spec = ((nxt.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields") or {}
        self.assertEqual(spec.get("MATERIALIZED_BY"), "AGENTBUS")
        self.assertEqual(spec.get("REVIEW_POLICY"), "AUDIT_SUFFICIENT")

    def test_dirty_and_staged_never_enter_bootstrap(self) -> None:
        self.create_stream("dirty-a", "--create-worktree")
        store = self.store("dirty-a")
        state = store.load()
        work = state["impl_worktree"]
        self.git("checkout", "-B", "agentbus/dirty-a", cwd=work)
        base = self.git("rev-parse", "HEAD", cwd=work)
        with open(os.path.join(work, "README.md"), "a", encoding="utf-8") as handle:
            handle.write("DIRTY-PRODUCT\n")
        with open(os.path.join(work, "staged.txt"), "w", encoding="utf-8") as handle:
            handle.write("STAGED\n")
        self.git("add", "staged.txt", cwd=work)
        before = porcelain_status(work)
        with open(os.path.join(work, "README.md"), encoding="utf-8") as handle:
            dirty_before = handle.read()
        result = create_zero_tree_bootstrap(work, branch="agentbus/dirty-a", expected_head=base, stream_id="dirty-a")
        self.assertTrue(result["ok"], result)
        self.assertEqual(rev_tree(work, result["commit"]), rev_tree(work, base))
        self.assertEqual(porcelain_status(work), before)
        with open(os.path.join(work, "README.md"), encoding="utf-8") as handle:
            self.assertEqual(handle.read(), dirty_before)
        self.assertIn("DIRTY-PRODUCT", dirty_before)
        blob = self.git("cat-file", "-p", f"{result['commit']}:README.md", cwd=work)
        self.assertNotIn("DIRTY-PRODUCT", blob)
        self.assertFalse(self.git("ls-tree", "-r", "--name-only", result["commit"], cwd=work).splitlines().__contains__("staged.txt"))

    def test_cas_loses_to_real_publication(self) -> None:
        self.create_stream("cas-a", "--create-worktree")
        work = self.store("cas-a").load()["impl_worktree"]
        self.git("checkout", "-B", "agentbus/cas-a", cwd=work)
        base = self.git("rev-parse", "HEAD", cwd=work)
        self.commit_file("prod.txt", "real\n", "agentbus(cas-a): apply GPT_SPEC real", cwd=work)
        advanced = self.git("rev-parse", "HEAD", cwd=work)
        result = create_zero_tree_bootstrap(work, branch="agentbus/cas-a", expected_head=base, stream_id="cas-a")
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("cas_lost"))
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=work), advanced)

    def test_real_publication_skips_bootstrap(self) -> None:
        self.create_stream("real-a", "--create-worktree")
        store = self.store("real-a")
        state = store.load()
        work = state["impl_worktree"]
        self.git("checkout", "-B", "agentbus/real-a", cwd=work)
        base = self.git("rev-parse", "HEAD", cwd=work)
        self.commit_file("prod.txt", "impl\n", "agentbus(real-a): apply GPT_SPEC x", cwd=work)
        head = self.git("rev-parse", "HEAD", cwd=work)
        state["branch"] = "agentbus/real-a"
        state["heads"]["spec_base"] = base
        state["heads"]["current"] = head
        state["publication"] = {"status": "pushed", "commit": head}
        store.save(state)
        state = store.load()
        result = ensure_durable_pr_transport(self.ctx, store, state)
        store.save(state)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result.get("pr") or state.get("pr"), 99)
        self.assertEqual((state.get("transport") or {}).get("bootstrap_skipped_reason"), "implementation_already_published")
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=work), head)
        self.assertFalse(is_bootstrap_commit(state, head))

    def test_unknown_movement_blocks(self) -> None:
        self.create_stream("unk-a", "--create-worktree")
        store = self.store("unk-a")
        state = store.load()
        work = state["impl_worktree"]
        self.git("checkout", "-B", "agentbus/unk-a", cwd=work)
        base = self.git("rev-parse", "HEAD", cwd=work)
        self.commit_file("mystery.txt", "x\n", "totally unrelated", cwd=work)
        # same tree? mystery.txt changes tree → product_commit. Make empty commit with same tree via commit --allow-empty
        self.git("reset", "--hard", base, cwd=work)
        self.git("commit", "--allow-empty", "-m", "mystery empty", cwd=work)
        state["branch"] = "agentbus/unk-a"
        state["heads"]["spec_base"] = base
        store.save(state)
        state = store.load()
        result = ensure_durable_pr_transport(self.ctx, store, state)
        store.save(state)
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("human_required"))
        self.assertEqual(state["phase"], "BLOCKED")

    def test_repeated_tick_no_duplicate_bootstrap_or_pr(self) -> None:
        store = self._merged("once-t", "ot")
        sha = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="ot", after="once-t", nxt="once-u", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        first = self.store("once-u").load()
        boot = (first.get("transport") or {}).get("bootstrap_commit")
        ensure_durable_pr_transport(self.ctx, self.store("once-u"), self.store("once-u").load())
        again = self.store("once-u").load()
        self.assertEqual((again.get("transport") or {}).get("bootstrap_commit"), boot)
        self.assertEqual(again.get("pr"), 99)

    def test_bootstrap_not_implemented_head_or_audit(self) -> None:
        store = self._merged("bh-a", "bh")
        sha = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="bh", after="bh-a", nxt="bh-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        nxt = self.store("bh-b").load()
        boot = (nxt.get("transport") or {}).get("bootstrap_commit")
        self.assertNotEqual(nxt.get("phase"), READY_FOR_AUDIT)
        report = f"""[CODEX_REPORT]
STATUS: READY_FOR_AUDIT
STREAM: bh-b
IMPLEMENTED_HEAD: {boot}
NEXT_ACTION: AUDIT
"""
        nxt_store = self.store("bh-b")
        nxt_state = nxt_store.load()
        apply_envelope(nxt_store, nxt_state, parse_one(report), repo=nxt["impl_worktree"], current_head=boot)
        nxt_store.save(nxt_state)
        after = nxt_store.load()
        self.assertNotEqual(after.get("phase"), READY_FOR_AUDIT)
        self.assertIn("bootstrap", (after.get("status") or {}).get("blocker") or "")

    def test_retryable_pr_failure_blocks_impl(self) -> None:
        store = self._merged("rt-a", "rt")
        sha = store.load()["heads"]["merged"]
        os.environ["FAKE_GH_MODE"] = "down"
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="rt", after="rt-a", nxt="rt-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        nxt = self.store("rt-b").load()
        self.assertNotEqual(nxt.get("phase"), IMPLEMENTING)
        self.assertIn(nxt.get("phase"), {WORKTREE_READY, "BLOCKED"})
        os.environ["FAKE_GH_MODE"] = "ok"

    def test_provenance_not_browser_gpt(self) -> None:
        store = self._merged("pv-a", "pv")
        sha = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="pv", after="pv-a", nxt="pv-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        spec = ((self.store("pv-b").load().get("envelopes") or {}).get("GPT_SPEC") or {})
        self.assertEqual(spec.get("source"), "continuation")
        self.assertEqual((spec.get("fields") or {}).get("MATERIALIZED_BY"), "AGENTBUS")
        self.assertNotEqual(spec.get("source"), "github")
