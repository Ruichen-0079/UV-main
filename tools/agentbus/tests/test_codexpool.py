from __future__ import annotations

import os

from agentbus.codexpool import (
    CAPACITY_WAIT,
    FAILED,
    RETRYABLE_TRANSIENT,
    SLOT_PRIMARY,
    SLOT_SECONDARY,
    SUCCESS,
    acquire_slot,
    classify_invocation,
    mark_capacity,
    pool_status,
    release_slot,
)
from agentbus.machine import IMPLEMENTING
from agentbus.protocol import Envelope, render_envelope
from agentbus.runner import build_prompt
from agentbus.tests.harness import AgentbusTest


class CodexPoolTests(AgentbusTest):
    def prepared_impl(self, stream: str) -> tuple:
        self.create_stream(stream, "--create-worktree")
        store = self.store(stream)
        head = self.git("rev-parse", "HEAD", cwd=store.load()["impl_worktree"])
        self.ok("submit", stream, "--file", self._write(f"{stream}-spec.md", self.spec_text(stream, head)))
        state = store.load()
        state["repair_cycles"] = 1
        store.save(state)
        os.environ["FAKE_CODEX_STREAM"] = stream
        return store, head

    def _write(self, name: str, text: str) -> str:
        path = os.path.join(self.root, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def _install_final_review(
        self,
        state: dict,
        head: str,
        *,
        status: str = "REPAIR",
        source_id: str = "5331069366",
        reviewed_head: str | None = None,
    ) -> None:
        base = "b" * 40
        state["pr"] = 44
        state["heads"]["current"] = head
        state["heads"]["implemented"] = head
        state["publication"]["commit"] = head
        state["github"]["pr"] = {
            "number": 44,
            "headRefOid": head,
            "baseRefOid": base,
            "state": "OPEN",
        }
        reviewed = reviewed_head or head
        envelope = Envelope(
            kind="GPT_MERGE_REVIEW",
            fields={
                "STATUS": status,
                "STREAM": state["stream_id"],
                "PR": "44",
                "REVIEWED_HEAD": reviewed,
                "REVIEWED_BASE": base,
                "FINDINGS": "value.revision\nvalue.changedSections\nvalue.restartServices",
            },
            source="github",
            source_id=source_id,
        )
        envelope.raw = render_envelope(envelope)
        state["envelopes"]["GPT_MERGE_REVIEW"] = envelope.as_record()

    def test_current_final_repair_and_findings_are_in_impl_prompt(self) -> None:
        store, head = self.prepared_impl("prompt-repair")
        state = store.load()
        self._install_final_review(state, head)
        prompt = build_prompt(state, "impl", os.path.join(self.repo, ".ai", "HANDOFF_PROTOCOL.md"))
        self.assertIn("Latest FINAL_GPT repair authority:", prompt)
        self.assertIn("5331069366", prompt)
        self.assertIn("value.revision", prompt)
        self.assertIn("value.changedSections", prompt)
        self.assertIn("value.restartServices", prompt)
        self.assertIn("does not authorize scope expansion", prompt)
        self.assertIn("emit BLOCKED rather than READY_FOR_AUDIT", prompt)

    def test_stale_or_non_repair_final_review_is_not_impl_authority(self) -> None:
        store, head = self.prepared_impl("prompt-fences")
        for status in ("PASS", "WAIT", "HUMAN"):
            state = store.load()
            self._install_final_review(state, head, status=status, source_id=f"{status}-1")
            prompt = build_prompt(state, "impl", os.path.join(self.repo, ".ai", "HANDOFF_PROTOCOL.md"))
            self.assertNotIn("Latest FINAL_GPT repair authority:", prompt, status)
        state = store.load()
        self._install_final_review(state, head, reviewed_head="c" * 40, source_id="stale-1")
        prompt = build_prompt(state, "impl", os.path.join(self.repo, ".ai", "HANDOFF_PROTOCOL.md"))
        self.assertNotIn("Latest FINAL_GPT repair authority:", prompt)

    def test_historical_noop_marker_is_requeued_without_consuming_repair_cycle(self) -> None:
        store, head = self.prepared_impl("repair-requeue")
        state = store.load()
        self._install_final_review(state, head)
        state["final_repair"] = {"consumed_review": "5331069366"}
        state["repair_cycles"] = 1
        state["publication"].update({"status": "pushed", "commit": head, "pushed": True})
        report = Envelope(
            kind="CODEX_REPORT",
            fields={
                "STATUS": "READY_FOR_AUDIT",
                "STREAM": state["stream_id"],
                "IMPLEMENTED_HEAD": head,
            },
            source="github",
            source_id="old-report",
        )
        report.raw = render_envelope(report)
        state["envelopes"]["CODEX_REPORT"] = report.as_record()
        from agentbus.runner import impl_work_key, requeue_noop_repair_generation

        key = impl_work_key(state)
        runtime = store.load_runtime()
        runtime.setdefault("last_done_key", {})["impl"] = key
        store.save_runtime(runtime)
        store.save(state)
        before = state["repair_cycles"]
        self.assertTrue(requeue_noop_repair_generation(store, store.load()))
        self.assertFalse((store.load_runtime().get("last_done_key") or {}).get("impl"))
        self.assertEqual(store.load()["repair_cycles"], before)

    def test_noop_repair_retries_other_slot_without_done_or_audit(self) -> None:
        store, head = self.prepared_impl("repair-noop")
        state = store.load()
        self._install_final_review(state, head)
        state["final_repair"] = {"consumed_review": "5331069366"}
        state["phase"] = IMPLEMENTING
        state["repair_cycles"] = 1
        state["publication"].update({"status": "pushed", "commit": head, "pushed": True})
        store.save(state)
        invocations = os.path.join(self.root, "repair-noop-invocations.txt")
        os.environ.update(
            {
                "FAKE_GH_HEAD": head,
                "FAKE_CODEX_STREAM": "repair-noop",
                "FAKE_CODEX_KIND": "CODEX_REPORT",
                "FAKE_CODEX_STATUS": "READY_FOR_AUDIT",
                "FAKE_CODEX_INVOCATIONS": invocations,
            }
        )
        result = self.agentctl("run", "repair-noop", "impl", "--once")
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        with open(invocations, encoding="utf-8") as handle:
            self.assertEqual([line.split()[0] for line in handle], ["primary", "secondary"])
        final = store.load()
        self.assertEqual(final["repair_cycles"], 1)
        self.assertEqual(final["phase"], IMPLEMENTING)
        self.assertNotIn("impl", store.load_runtime().get("last_done_key") or {})
        self.assertTrue((final.get("codex_interruption") or {}).get("no_op_repair"))
        self.assertFalse(any(item["argv"][-1] == "audit" for item in self.executor_launches))

    def test_primary_then_secondary_then_wait(self) -> None:
        primary = acquire_slot(self.ctx, stream="a", role="impl")
        self.assertTrue(primary["ok"])
        self.assertEqual(primary["slot"], SLOT_PRIMARY)
        self.assertEqual(primary["codex_home"], os.path.join(self.home, ".codex"))

        secondary = acquire_slot(self.ctx, stream="b", role="audit")
        self.assertTrue(secondary["ok"])
        self.assertEqual(secondary["slot"], SLOT_SECONDARY)
        self.assertEqual(secondary["codex_home"], os.path.join(self.home, ".codex-secondary"))
        waiting = acquire_slot(self.ctx, stream="c", role="impl")
        self.assertFalse(waiting["ok"])
        self.assertTrue(waiting["wait"])
        release_slot(self.ctx, SLOT_PRIMARY)
        release_slot(self.ctx, SLOT_SECONDARY)

    def test_capacity_moves_to_secondary_and_both_capacity_wait(self) -> None:
        primary = acquire_slot(self.ctx, stream="a", role="impl")
        mark_capacity(self.ctx, primary["slot"], "usage limit reached; retry after 15 minutes")
        secondary = acquire_slot(self.ctx, stream="a", role="impl")
        self.assertEqual(secondary["slot"], SLOT_SECONDARY)
        mark_capacity(self.ctx, secondary["slot"], "weekly usage limit")
        waiting = acquire_slot(self.ctx, stream="a", role="impl")
        self.assertFalse(waiting["ok"])
        status = pool_status(self.ctx)
        self.assertFalse(status["available"])
        self.assertEqual({slot["status"] for slot in status["slots"].values()}, {"COOLDOWN"})

    def test_capacity_classifier_is_conservative(self) -> None:
        self.assertEqual(classify_invocation(0, "anything"), SUCCESS)
        self.assertEqual(classify_invocation(1, "You have hit your Codex usage limit"), CAPACITY_WAIT)
        self.assertEqual(
            classify_invocation(1, '{"rate_limit_reached_type":"primary","resets_at":1787221090}'),
            CAPACITY_WAIT,
        )
        self.assertEqual(classify_invocation(1, "network error: connection reset"), RETRYABLE_TRANSIENT)
        self.assertEqual(classify_invocation(1, "tests failed"), FAILED)

    def test_dirty_capacity_takeover_preserves_and_continues_same_generation(self) -> None:
        store, _ = self.prepared_impl("pool-dirty")
        invocations = os.path.join(self.root, "pool-dirty-invocations.txt")
        os.environ.update(
            {
                "FAKE_CODEX_KIND": "CODEX_REPORT",
                "FAKE_CODEX_STATUS": "READY_FOR_AUDIT",
                "FAKE_CODEX_CAPACITY_SLOT": "primary",
                "FAKE_CODEX_CAPACITY_DIRTY_FILE": "impl.txt",
                "FAKE_CODEX_COMMIT": "impl.txt",
                "FAKE_CODEX_INVOCATIONS": invocations,
            }
        )
        result = self.agentctl("run", "pool-dirty", "impl", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = store.load()
        self.assertEqual(state["repair_cycles"], 1)
        self.assertIn("CODEX_REPORT", state["envelopes"])
        self.assertIsNone(state.get("codex_interruption"))
        with open(invocations, encoding="utf-8") as handle:
            calls = handle.read().splitlines()
        self.assertEqual([line.split()[0] for line in calls], ["primary", "secondary"])
        self.assertTrue(calls[1].endswith("/.codex-secondary"))
        with open(os.path.join(state["impl_worktree"], "impl.txt"), encoding="utf-8") as handle:
            content = handle.read()
        self.assertIn("partial-from-primary", content)
        self.assertIn("continued-by-secondary", content)

    def test_both_capacity_preserve_dirty_work_and_wait_without_repair_increment(self) -> None:
        store, _ = self.prepared_impl("pool-wait")
        os.environ.update(
            {
                "FAKE_CODEX_KIND": "CODEX_REPORT",
                "FAKE_CODEX_CAPACITY_SLOT": "both",
                "FAKE_CODEX_CAPACITY_DIRTY_FILE": "partial.txt",
            }
        )
        result = self.agentctl("run", "pool-wait", "impl", "--once")
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        state = store.load()
        self.assertEqual(state["phase"], IMPLEMENTING)
        self.assertEqual(state["repair_cycles"], 1)
        self.assertEqual((state.get("wait") or {}).get("kind"), "CODEX_CAPACITY")
        self.assertEqual((state.get("codex_interruption") or {}).get("kind"), "INTERRUPTED_CAPACITY")
        self.assertTrue(os.path.isfile(os.path.join(state["impl_worktree"], "partial.txt")))
        self.assertFalse(pool_status(self.ctx)["available"])

    def test_complete_report_survives_capacity_exit_without_secondary_rerun(self) -> None:
        store, _ = self.prepared_impl("pool-report")
        invocations = os.path.join(self.root, "pool-report-invocations.txt")
        os.environ.update(
            {
                "FAKE_CODEX_KIND": "CODEX_REPORT",
                "FAKE_CODEX_STATUS": "READY_FOR_AUDIT",
                "FAKE_CODEX_COMMIT": "done.txt",
                "FAKE_CODEX_EXIT_CAPACITY_AFTER_MESSAGE": "1",
                "FAKE_CODEX_INVOCATIONS": invocations,
            }
        )
        result = self.agentctl("run", "pool-report", "impl", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = store.load()
        self.assertIn("CODEX_REPORT", state["envelopes"])
        self.assertEqual(state["repair_cycles"], 1)
        with open(invocations, encoding="utf-8") as handle:
            self.assertEqual([line.split()[0] for line in handle], ["primary"])
        self.assertEqual(pool_status(self.ctx)["slots"]["primary"]["status"], "COOLDOWN")

    def test_complete_audit_survives_capacity_exit(self) -> None:
        store, _ = self.prepared_impl("pool-audit")
        os.environ.update(
            {
                "FAKE_CODEX_KIND": "CODEX_REPORT",
                "FAKE_CODEX_STATUS": "READY_FOR_AUDIT",
                "FAKE_CODEX_COMMIT": "done.txt",
            }
        )
        self.assertEqual(self.agentctl("run", "pool-audit", "impl", "--once").returncode, 0)
        os.environ["FAKE_CODEX_KIND"] = "CODEX_AUDIT"
        os.environ["FAKE_CODEX_STATUS"] = "PASS"
        os.environ["FAKE_CODEX_EXIT_CAPACITY_AFTER_MESSAGE"] = "1"
        result = self.agentctl("run", "pool-audit", "audit", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        state = store.load()
        self.assertEqual(state["envelopes"]["CODEX_AUDIT"]["status"], "PASS")
        self.assertEqual(state["repair_cycles"], 1)

    def test_takeover_prompt_only_for_explicit_same_generation_capacity_marker(self) -> None:
        store, _ = self.prepared_impl("pool-prompt")
        state = store.load()
        protocol = os.path.join(self.repo, ".ai", "HANDOFF_PROTOCOL.md")
        plain = build_prompt(state, "impl", protocol)
        self.assertNotIn("Previous IMPL invocation stopped because Codex capacity", plain)
        from agentbus.runner import impl_work_key

        state["codex_interruption"] = {
            "kind": "INTERRUPTED_FAILED",
            "role": "impl",
            "work_key": impl_work_key(state),
        }
        failed = build_prompt(state, "impl", protocol)
        self.assertNotIn("Previous IMPL invocation stopped because Codex capacity", failed)
        state["codex_interruption"]["kind"] = "INTERRUPTED_CAPACITY"
        capacity = build_prompt(state, "impl", protocol)
        self.assertIn("Previous IMPL invocation stopped because Codex capacity", capacity)

    def test_profile_only_present_in_primary_is_not_fabricated_in_secondary(self) -> None:
        primary_home = os.path.join(self.home, ".codex")
        os.makedirs(primary_home, exist_ok=True)
        with open(os.path.join(primary_home, "primary-only.config.toml"), "w", encoding="utf-8") as handle:
            handle.write('model = "gpt-5.6-sol"\n')
        first = acquire_slot(self.ctx, stream="profile-a", role="impl", profile="primary-only")
        self.assertTrue(first["ok"])
        self.assertEqual(first["slot"], "primary")
        mark_capacity(self.ctx, "primary", "usage limit reached")
        blocked = acquire_slot(self.ctx, stream="profile-a", role="impl", profile="primary-only")
        self.assertFalse(blocked["ok"])
        self.assertIn("secondary", blocked["incompatible"])

    def test_incomplete_audit_capacity_fails_over_exact_head(self) -> None:
        store, _ = self.prepared_impl("pool-audit-failover")
        os.environ.update(
            {
                "FAKE_CODEX_KIND": "CODEX_REPORT",
                "FAKE_CODEX_STATUS": "READY_FOR_AUDIT",
                "FAKE_CODEX_COMMIT": "done.txt",
            }
        )
        self.assertEqual(self.agentctl("run", "pool-audit-failover", "impl", "--once").returncode, 0)
        invocations = os.path.join(self.root, "pool-audit-failover-invocations.txt")
        os.environ.update(
            {
                "FAKE_CODEX_KIND": "CODEX_AUDIT",
                "FAKE_CODEX_STATUS": "PASS",
                "FAKE_CODEX_CAPACITY_SLOT": "primary",
                "FAKE_CODEX_INVOCATIONS": invocations,
            }
        )
        result = self.agentctl("run", "pool-audit-failover", "audit", "--once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with open(invocations, encoding="utf-8") as handle:
            self.assertEqual([line.split()[0] for line in handle], ["primary", "secondary"])
        state = store.load()
        self.assertEqual(state["envelopes"]["CODEX_AUDIT"]["head"], state["heads"]["implemented"])
