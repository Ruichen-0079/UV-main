from __future__ import annotations

import json
import os

from agentbus.github import apply_fetched_comments, unreject_comment
from agentbus.apply import apply_envelope
from agentbus.machine import FINAL_GATE, IMPLEMENTING, READY_FOR_AUDIT, READY_FOR_GPT, WAITING_FOR_SPEC
from agentbus.protocol import parse_one
from agentbus.streamid import claimed_ids, classify_envelope_stream, ensure_stream_aliases, separator_twin
from agentbus.tests.harness import AgentbusTest
from agentbus.util import atomic_write_text, utc_now


class StreamSyncTests(AgentbusTest):
    def _comments(self, rows: list[dict]) -> None:
        path = os.path.join(self.root, "comments.json")
        atomic_write_text(path, json.dumps(rows))
        os.environ["FAKE_GH_COMMENTS"] = path

    def _spec(self, stream: str, head: str, extra: str = "") -> str:
        return f"""[GPT_SPEC]

STATUS: ACTIONABLE

STREAM: {stream}

BASE_HEAD: {head}

SCOPE:
- feature.txt

ACCEPTANCE_CRITERIA:
- exists

NEXT_ACTION: IMPL
{extra}
"""

    def test_canonical_exact_match(self) -> None:
        self.create_stream("p4_2d2")
        state = self.store("p4_2d2").load()
        self.assertEqual(classify_envelope_stream("p4_2d2", state), "self")

    def test_separator_alias_p4_hyphen(self) -> None:
        self.create_stream("p4_2d2")
        store = self.store("p4_2d2")
        state = store.load()
        ensure_stream_aliases(self.ctx, state)
        store.save(state)
        self.assertEqual(separator_twin("p4_2d2"), "p4-2d2")
        self.assertIn("p4-2d2", state["aliases"])
        self.assertEqual(classify_envelope_stream("p4-2d2", state), "self")

    def test_alias_collision_detection(self) -> None:
        self.create_stream("foo_bar")
        result = self.agentctl("create", "foo-bar")
        self.assertNotEqual(result.returncode, 0)
        text = (result.stderr or "") + (result.stdout or "")
        self.assertTrue("collides" in text or "alias" in text, text)

    def test_foreign_stream_ignored(self) -> None:
        self.create_stream("p4_2d2", "--pr", "20")
        self.create_stream("other-stream")
        store = self.store("p4_2d2")
        state = store.load()
        ensure_stream_aliases(self.ctx, state)
        head = self.git("rev-parse", "HEAD")
        comments = [
            {"id": "1", "body": self._spec("other-stream", head)},
        ]
        notes = apply_fetched_comments(
            store,
            state,
            comments=comments,
            view={"number": 20},
            repo_root=self.repo,
            current_head=head,
            ctx=self.ctx,
        )
        self.assertTrue(any("ignored foreign" in note for note in notes))
        self.assertEqual(state["phase"], WAITING_FOR_SPEC)
        self.assertIn("1", state["seen_comment_ids"])
        self.assertNotIn("1", state.get("rejected_comment_ids") or [])
        self.assertEqual(state["repair_cycles"], 0)

    def test_one_bad_comment_does_not_abort_later_good(self) -> None:
        self.create_stream("p4_2d2", "--pr", "20")
        store = self.store("p4_2d2")
        state = store.load()
        ensure_stream_aliases(self.ctx, state)
        head = self.git("rev-parse", "HEAD")
        comments = [
            {"id": "bad", "body": self._spec("totally-else", head)},
            {"id": "good", "body": self._spec("p4-2d2", head)},
        ]
        notes = apply_fetched_comments(
            store,
            state,
            comments=comments,
            view={"number": 20},
            repo_root=self.repo,
            current_head=head,
            ctx=self.ctx,
        )
        self.assertTrue(any("rejected comment bad" in note for note in notes))
        self.assertTrue(any("ingested GPT_SPEC from comment good" in note for note in notes))
        self.assertEqual(state["phase"], IMPLEMENTING)
        self.assertIn("bad", state["rejected_comment_ids"])
        self.assertIn("good", state["seen_comment_ids"])
        self.assertIsNotNone(state["github"]["last_sync_at"])
        self.assertEqual(state["repair_cycles"], 0)

    def test_malformed_stream_rejects_only_that_comment(self) -> None:
        self.create_stream("s1", "--pr", "20")
        store = self.store("s1")
        state = store.load()
        head = self.git("rev-parse", "HEAD")
        comments = [
            {
                "id": "miss",
                "body": "[GPT_SPEC]\n\nSTATUS: ACTIONABLE\n\nBASE_HEAD: "
                + head
                + "\n\nSCOPE:\n- x\n\nACCEPTANCE_CRITERIA:\n- y\n",
            },
            {"id": "ok", "body": self._spec("s1", head)},
        ]
        apply_fetched_comments(
            store,
            state,
            comments=comments,
            view={"number": 20},
            repo_root=self.repo,
            current_head=head,
            ctx=self.ctx,
        )
        self.assertIn("miss", state["rejected_comment_ids"])
        self.assertEqual(state["phase"], IMPLEMENTING)

    def test_rejected_not_retried(self) -> None:
        self.create_stream("s1", "--pr", "20")
        store = self.store("s1")
        state = store.load()
        head = self.git("rev-parse", "HEAD")
        comments = [{"id": "bad", "body": self._spec("nope", head)}]
        apply_fetched_comments(
            store, state, comments=comments, view={}, repo_root=self.repo, current_head=head, ctx=self.ctx
        )
        first = list(state["rejected_comment_ids"])
        apply_fetched_comments(
            store, state, comments=comments, view={}, repo_root=self.repo, current_head=head, ctx=self.ctx
        )
        self.assertEqual(state["rejected_comment_ids"], first)
        self.assertEqual(sum(1 for item in state["rejected_comments"] if item["comment_id"] == "bad"), 1)

    def test_reprocess_rejected(self) -> None:
        self.create_stream("p4_2d2", "--pr", "20")
        store = self.store("p4_2d2")
        state = store.load()
        state["aliases"] = []
        store.save(state)
        head = self.git("rev-parse", "HEAD")
        comments = [{"id": "5324522371", "body": self._spec("p4-2d2", head)}]
        apply_fetched_comments(
            store, state, comments=comments, view={}, repo_root=self.repo, current_head=head, ctx=None
        )
        # without aliases and without ctx auto-attach, p4-2d2 is unknown
        if state["phase"] != IMPLEMENTING:
            self.assertIn("5324522371", state.get("rejected_comment_ids") or [])
            ensure_stream_aliases(self.ctx, state)
            apply_fetched_comments(
                store,
                state,
                comments=comments,
                view={},
                repo_root=self.repo,
                current_head=head,
                ctx=self.ctx,
                reprocess_ids={"5324522371"},
            )
        self.assertEqual(state["phase"], IMPLEMENTING)
        self.assertNotIn("5324522371", state.get("rejected_comment_ids") or [])
        statuses = [item.get("status") for item in state.get("rejected_comments") or [] if item.get("comment_id") == "5324522371"]
        self.assertTrue(not statuses or statuses[-1] == "recovered")

    def test_duplicate_comment_idempotent(self) -> None:
        self.create_stream("s1", "--pr", "20")
        store = self.store("s1")
        state = store.load()
        head = self.git("rev-parse", "HEAD")
        comments = [{"id": "9", "body": self._spec("s1", head)}]
        apply_fetched_comments(
            store, state, comments=comments, view={}, repo_root=self.repo, current_head=head, ctx=self.ctx
        )
        phase = state["phase"]
        apply_fetched_comments(
            store, state, comments=comments, view={}, repo_root=self.repo, current_head=head, ctx=self.ctx
        )
        self.assertEqual(state["phase"], phase)
        self.assertEqual(state["seen_comment_ids"].count("9"), 1)

    def test_last_sync_advances_with_rejects(self) -> None:
        self.create_stream("s1", "--pr", "20")
        store = self.store("s1")
        state = store.load()
        head = self.git("rev-parse", "HEAD")
        apply_fetched_comments(
            store,
            state,
            comments=[{"id": "z", "body": self._spec("nope", head)}],
            view={},
            repo_root=self.repo,
            current_head=head,
            ctx=self.ctx,
        )
        self.assertTrue(state["github"]["last_sync_at"])
        self.assertLessEqual(state["github"]["last_sync_at"], utc_now())

    def test_infra_reject_does_not_burn_repair(self) -> None:
        self.create_stream("s1", "--pr", "20")
        store = self.store("s1")
        state = store.load()
        state["repair_cycles"] = 0
        head = self.git("rev-parse", "HEAD")
        apply_fetched_comments(
            store,
            state,
            comments=[{"id": "z", "body": self._spec("nope", head)}],
            view={},
            repo_root=self.repo,
            current_head=head,
            ctx=self.ctx,
        )
        self.assertEqual(state["repair_cycles"], 0)

    def test_dirty_recovery_does_not_invoke_codex(self) -> None:
        os.environ["YUVI_AGENTBUS_PUSH"] = "1"
        remote = os.path.join(self.root, "remote.git")
        self.git("branch", "s1-impl")
        import subprocess

        subprocess.run(["git", "init", "--bare", remote], check=True, capture_output=True)
        self.git("remote", "remove", "origin")
        self.git("remote", "add", "origin", remote)
        self.git("push", "-u", "origin", "HEAD:main")
        self.git("push", "origin", "s1-impl:s1-impl")
        self.git("checkout", "s1-impl")
        from agentbus.paths import discover_repo

        self.ctx = discover_repo(self.repo)
        self.create_stream("s1", "--worktree", self.repo, "--branch", "s1-impl")
        store = self.store("s1")
        state = store.load()
        state["branch"] = "s1-impl"
        state["phase"] = IMPLEMENTING
        store.save(state)
        atomic_write_text(os.path.join(self.repo, "feature.txt"), "ok\n")
        os.environ["FAKE_CODEX_CRASH"] = "1"
        from agentbus.actions import publish_existing_implementation

        result = publish_existing_implementation(self.ctx, store, recovery=True)
        self.assertTrue(result.get("commit"), result)
        self.assertEqual(self.store("s1").load()["phase"], READY_FOR_AUDIT)
        rec = self.store("s1").load()["envelopes"]["CODEX_REPORT"]
        self.assertIn("without Codex redo", rec.get("fields", {}).get("RECOVERY") or rec.get("raw") or "")

    def test_final_gate_pass_uses_final_head(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream("s1", "--worktree", self.repo)
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_GPT
        state["heads"]["implemented"] = head
        state["heads"]["current"] = head
        store.save(state)
        env = parse_one(
            f"[FINAL_GATE]\nSTATUS: PASS\nSTREAM: s1\nFINAL_HEAD: {head}\nDECISION: PASS\n"
        )
        apply_envelope(store, state, env, repo=self.repo, current_head=head)
        self.assertEqual(state["phase"], FINAL_GATE)
        self.assertEqual(state["envelopes"]["FINAL_GATE"]["status"], "PASS")

    def test_final_gate_after_pr_merged_is_not_fatal(self) -> None:
        head = self.git("rev-parse", "HEAD")
        self.create_stream("s1", "--pr", "20", "--worktree", self.repo)
        store = self.store("s1")
        state = store.load()
        state["phase"] = FINAL_GATE
        state["heads"]["current"] = head
        store.save(state)
        comments = [
            {
                "id": "fg",
                "body": f"[FINAL_GATE]\nSTATUS: PASS\nSTREAM: s1\nFINAL_HEAD: {head}\n",
            }
        ]
        notes = apply_fetched_comments(
            store,
            state,
            comments=comments,
            view={"number": 20, "state": "MERGED"},
            repo_root=self.repo,
            current_head=head,
            ctx=self.ctx,
        )
        self.assertTrue(any("ingested FINAL_GATE" in note for note in notes))
        self.assertTrue(any("PR is merged" in note for note in notes))
        self.assertEqual(state["phase"], "MERGED")
        self.assertNotIn("fg", state.get("rejected_comment_ids") or [])

    def test_claimed_ids_include_aliases(self) -> None:
        self.create_stream("p4_2d2")
        claimed = claimed_ids(self.ctx)
        self.assertIn("p4_2d2", claimed)
        self.assertIn("p4-2d2", claimed)
