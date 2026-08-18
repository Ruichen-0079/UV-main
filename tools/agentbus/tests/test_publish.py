from __future__ import annotations

import os
import subprocess

from agentbus.apply import apply_envelope
from agentbus.gitutil import head_sha, is_dirty
from agentbus.machine import BLOCKED_FOR_REVIEW, IMPLEMENTING, READY_FOR_AUDIT, RE_REVIEW_REQUIRED
from agentbus.protocol import Envelope
from agentbus.publish import (
    consume_product_repair,
    publish_implementation,
    reset_infra_repair_budget,
    validate_publication,
)
from agentbus.paths import discover_repo
from agentbus.tests.harness import AgentbusTest
from agentbus.util import atomic_write_text


class PublishTests(AgentbusTest):
    def _linked(self, branch: str = "s1-impl") -> tuple[str, str]:
        os.environ["YUVI_AGENTBUS_PUSH"] = "1"
        primary = self.repo
        linked = os.path.join(self.root, "linked")
        self.git("worktree", "add", "-b", branch, linked, "HEAD")
        remote = os.path.join(self.root, "remote.git")
        subprocess.run(["git", "init", "--bare", remote], check=True, capture_output=True)
        self.git("remote", "remove", "origin")
        self.git("remote", "add", "origin", remote)
        self.git("push", "-u", "origin", "HEAD:main")
        self.git("push", "origin", f"{branch}:{branch}")
        self.ctx = discover_repo(self.repo)
        return primary, linked

    def test_codex_does_not_need_to_commit(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked)
        store = self.store("s1")
        state = store.load()
        baseline = head_sha(linked)
        atomic_write_text(os.path.join(linked, "feature.txt"), "from-codex\n")
        self.assertTrue(is_dirty(linked))
        self.assertEqual(head_sha(linked), baseline)
        result = publish_implementation(store, state, self.ctx, baseline_head=baseline, push=True)
        self.assertTrue(result["ok"], result)
        self.assertNotEqual(result["commit"], baseline)
        self.assertFalse(is_dirty(linked))
        self.assertEqual(head_sha(linked), result["commit"])
        shown = subprocess.check_output(["git", "-C", linked, "show", result["commit"], "--stat"], text=True)
        self.assertIn("feature.txt", shown)

    def test_ready_for_audit_refused_if_uncommitted(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked)
        store = self.store("s1")
        state = store.load()
        state["phase"] = IMPLEMENTING
        store.save(state)
        atomic_write_text(os.path.join(linked, "feature.txt"), "x\n")
        env = Envelope(
            kind="CODEX_REPORT",
            fields={
                "STATUS": "READY_FOR_AUDIT",
                "STREAM": "s1",
                "IMPLEMENTED_HEAD": head_sha(linked),
            },
        )
        apply_envelope(store, state, env, repo=linked, current_head=head_sha(linked))
        self.assertNotEqual(state["phase"], READY_FOR_AUDIT)
        self.assertEqual(state["status"]["impl"], "IMPLEMENTATION_COMPLETE_PUBLICATION_FAILED")

    def test_remote_moved_refuses_push(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked, "--branch", "s1-impl")
        store = self.store("s1")
        state = store.load()
        state["branch"] = "s1-impl"
        baseline = head_sha(linked)
        mover = os.path.join(self.root, "mover")
        subprocess.run(["git", "clone", os.path.join(self.root, "remote.git"), mover], check=True, capture_output=True)
        subprocess.run(["git", "-C", mover, "checkout", "s1-impl"], check=True, capture_output=True)
        atomic_write_text(os.path.join(mover, "remote-only.txt"), "moved\n")
        subprocess.run(["git", "-C", mover, "add", "remote-only.txt"], check=True, capture_output=True)
        subprocess.run(["git", "-C", mover, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "remote moved"], check=True, capture_output=True)
        subprocess.run(["git", "-C", mover, "push", "origin", "s1-impl"], check=True, capture_output=True)
        atomic_write_text(os.path.join(linked, "local.txt"), "mine\n")
        result = publish_implementation(store, state, self.ctx, baseline_head=baseline, push=True)
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("remote_moved") or "moved" in (result.get("reason") or ""))
        self.assertEqual(state["phase"], RE_REVIEW_REQUIRED)
        self.assertTrue(os.path.isfile(os.path.join(linked, "local.txt")))

    def test_empty_diff_is_refused(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked)
        gate = validate_publication(
            linked,
            stream_id="s1",
            expected_worktree=linked,
            baseline_head=head_sha(linked),
            repo_root=self.repo,
        )
        self.assertFalse(gate["ok"])
        self.assertIn("no file changes", gate["reason"])

    def test_dirty_at_start_refused(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked)
        store = self.store("s1")
        state = store.load()
        atomic_write_text(os.path.join(linked, "stale.txt"), "preexisting\n")
        result = publish_implementation(
            store, state, self.ctx, baseline_head=head_sha(linked), clean_at_start=False, push=False
        )
        self.assertFalse(result["ok"])
        self.assertIn("dirty", result["reason"])
        self.assertTrue(os.path.isfile(os.path.join(linked, "stale.txt")))

    def test_unexpected_path_rejected(self) -> None:
        _, linked = self._linked()
        atomic_write_text(os.path.join(linked, "ok.txt"), "a\n")
        atomic_write_text(os.path.join(linked, "nope.txt"), "b\n")
        gate = validate_publication(
            linked,
            stream_id="s1",
            expected_worktree=linked,
            baseline_head=head_sha(linked),
            repo_root=self.repo,
            expected_paths=["ok.txt"],
        )
        self.assertFalse(gate["ok"])
        self.assertIn("unexpected", gate["reason"])

    def test_publication_failure_preserves_tree(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked)
        store = self.store("s1")
        state = store.load()
        atomic_write_text(os.path.join(linked, "keep.txt"), "keep\n")
        result = publish_implementation(
            store, state, self.ctx, baseline_head="0" * 40, push=False
        )
        self.assertFalse(result["ok"])
        self.assertTrue(os.path.isfile(os.path.join(linked, "keep.txt")))
        self.assertTrue(is_dirty(linked))

    def test_retry_does_not_duplicate_commit(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked, "--branch", "s1-impl")
        store = self.store("s1")
        state = store.load()
        state["branch"] = "s1-impl"
        baseline = head_sha(linked)
        atomic_write_text(os.path.join(linked, "once.txt"), "1\n")
        first = publish_implementation(store, state, self.ctx, baseline_head=baseline, push=True)
        self.assertTrue(first["ok"], first)
        second = publish_implementation(store, state, self.ctx, baseline_head=first["commit"], push=True)
        self.assertTrue(second["ok"], second)
        self.assertEqual(first["commit"], second["commit"])
        count = subprocess.check_output(["git", "-C", linked, "rev-list", "--count", f"{baseline}..HEAD"], text=True).strip()
        self.assertEqual(count, "1")

    def test_infra_audit_does_not_burn_budget(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["heads"]["implemented"] = "a" * 40
        state["publication"] = {"commit": None}
        self.assertFalse(consume_product_repair(state, "a" * 40))
        state["publication"] = {"commit": "a" * 40}
        self.assertTrue(consume_product_repair(state, "a" * 40))
        reset_infra_repair_budget(state, reason="test")
        self.assertEqual(state["repair_cycles"], 0)
        state["phase"] = BLOCKED_FOR_REVIEW
        state["repair_cycles"] = 2
        reset_infra_repair_budget(state, reason="test")
        self.assertEqual(state["repair_cycles"], 0)

    def test_crash_after_commit_before_push_recovers(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked, "--branch", "s1-impl")
        store = self.store("s1")
        state = store.load()
        state["branch"] = "s1-impl"
        baseline = head_sha(linked)
        atomic_write_text(os.path.join(linked, "x.txt"), "x\n")
        mid = publish_implementation(store, state, self.ctx, baseline_head=baseline, push=False)
        self.assertTrue(mid["ok"])
        self.assertFalse(state["publication"].get("pushed"))
        again = publish_implementation(store, state, self.ctx, baseline_head=mid["commit"], push=True)
        self.assertTrue(again["ok"], again)
        self.assertTrue(again.get("pushed") or state["publication"].get("pushed"))
        self.assertEqual(again["commit"], mid["commit"])

    def test_crash_after_push_before_state_update_recovers(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked, "--branch", "s1-impl")
        store = self.store("s1")
        state = store.load()
        state["branch"] = "s1-impl"
        baseline = head_sha(linked)
        atomic_write_text(os.path.join(linked, "y.txt"), "y\n")
        first = publish_implementation(store, state, self.ctx, baseline_head=baseline, push=True)
        self.assertTrue(first["ok"], first)
        committed = first["commit"]
        state["publication"] = {
            "status": "failed",
            "commit": None,
            "pushed": False,
            "baseline_head": baseline,
            "files": [],
        }
        store.save(state)
        state = store.load()
        again = publish_implementation(store, state, self.ctx, baseline_head=baseline, push=True)
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["commit"], committed)
        count = subprocess.check_output(
            ["git", "-C", linked, "rev-list", "--count", f"{baseline}..HEAD"], text=True
        ).strip()
        self.assertEqual(count, "1")

    def test_duplicate_recovery_is_idempotent(self) -> None:
        from agentbus.actions import publish_existing_implementation

        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked, "--branch", "s1-impl")
        store = self.store("s1")
        state = store.load()
        state["branch"] = "s1-impl"
        store.save(state)
        atomic_write_text(os.path.join(linked, "z.txt"), "z\n")
        first = publish_existing_implementation(self.ctx, store)
        second = publish_existing_implementation(self.ctx, store)
        self.assertEqual(first["commit"], second["commit"])
        self.assertEqual(store.load()["heads"]["implemented"], first["commit"])

    def test_audit_requires_committed_head(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked)
        head = head_sha(linked)
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        out = self.ok("run", "s1", "audit", "--once")
        self.assertIn("No work", out)
        state = self.store("s1").load()
        self.assertNotEqual(state["phase"], READY_FOR_AUDIT)
        self.assertIsNone((state.get("heads") or {}).get("implemented"))

    def test_end_to_end_codex_does_not_commit(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked, "--branch", "s1-impl")
        head = head_sha(linked)
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        os.environ["FAKE_CODEX_STREAM"] = "s1"
        os.environ["FAKE_CODEX_COMMIT"] = "impl.txt"
        os.environ["YUVI_AGENTBUS_PUSH"] = "1"
        self.ok("run", "s1", "impl", "--once")
        state = self.store("s1").load()
        self.assertEqual(state["phase"], READY_FOR_AUDIT)
        self.assertNotEqual(state["heads"]["implemented"], head)
        shown = subprocess.check_output(
            ["git", "-C", linked, "show", state["heads"]["implemented"], "--stat"], text=True
        )
        self.assertIn("impl.txt", shown)
        self.assertFalse(is_dirty(linked))
        self.assertEqual(state["publication"]["status"], "pushed")
        log = subprocess.check_output(["git", "-C", linked, "log", "-1", "--format=%s"], text=True)
        self.assertTrue(log.startswith("agentbus(s1):"))
        self.assertNotIn("fake-impl", log)

    def test_no_force_push_or_auto_merge_or_global_config(self) -> None:
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        forbidden = (
            "git add -A",
            "git add --all",
            "push --force",
            "push -f",
            "gh pr merge",
            "writable_roots",
        )
        hits: list[str] = []
        for dirpath, _, files in os.walk(root):
            if "__pycache__" in dirpath or dirpath.endswith("tests"):
                continue
            for name in files:
                if not name.endswith((".py", ".js", ".md")):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8") as handle:
                    text = handle.read()
                for needle in forbidden:
                    if needle in text:
                        hits.append(f"{path}: {needle}")
        self.assertEqual(hits, [])
        from agentbus.publish import push_argv

        argv = push_argv("codex/p7-8b-settings-state-safety")
        self.assertNotIn("--force", argv)
        self.assertNotIn("-f", argv)
        self.assertEqual(argv[:3], ["git", "push", "origin"])

    def test_impl_refuses_preexisting_dirty_worktree(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked)
        atomic_write_text(os.path.join(linked, "user.txt"), "mine\n")
        head = head_sha(linked)
        self.ok("submit", "s1", "--file", self._write("spec.md", self.spec_text("s1", head)))
        result = self.agentctl("run", "s1", "impl", "--once")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dirty", (result.stdout + result.stderr).lower())
        self.assertNotEqual(self.store("s1").load()["phase"], READY_FOR_AUDIT)

    def test_infra_failure_does_not_emit_ready_for_audit(self) -> None:
        _, linked = self._linked()
        self.create_stream("s1", "--worktree", linked)
        store = self.store("s1")
        state = store.load()
        state["phase"] = IMPLEMENTING
        store.save(state)
        result = publish_implementation(store, state, self.ctx, baseline_head="0" * 40, push=False)
        self.assertFalse(result["ok"])
        self.assertNotEqual(state["phase"], READY_FOR_AUDIT)
        self.assertIsNone((state.get("heads") or {}).get("implemented"))

    def _write(self, name: str, content: str) -> str:
        path = os.path.join(self.root, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return path
