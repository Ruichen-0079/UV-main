from __future__ import annotations

import json
import os

from agentbus.autopilot import ensure_pr_reviewable
from agentbus.browser import job_for_state
from agentbus.decision import (
    FINAL_GPT,
    FINAL_REVIEW,
    active_blocker,
    browser_job_id,
    deterministic_merge_fences,
    final_review_for_current,
    review_generation,
)
from agentbus.models import empty_state
from agentbus.protocol import Envelope, render_envelope
from agentbus.tests.harness import AgentbusTest
from agentbus.views import stream_view


class ControlPlaneResidueTests(AgentbusTest):
    def _write_text(self, path: str, value: str) -> None:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(value)

    def _read_text(self, path: str) -> str:
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def _ready_fixture(self, stream: str = "s1") -> tuple[dict, dict, str, str]:
        self.create_stream(stream)
        store = self.store(stream)
        state = store.load()
        head = "a" * 40
        base = "b" * 40
        state.update({"pr": 46, "branch": f"agentbus/{stream}", "phase": "FINAL_GATE"})
        state["heads"].update(
            {
                "current": head,
                "implemented": head,
                "last_seen": head,
                "audited": head,
                "reviewed": head,
                "spec_base": base,
            }
        )
        state["transport"] = {
            "owned": True,
            "materialized_by": "AGENTBUS",
            "status": "pr_ready",
            "pr": 46,
            "base_sha": base,
            "continuation_comment_id": "5330000001",
        }
        state["publication"] = {
            "status": "pushed",
            "pushed": True,
            "commit": head,
            "remote_sha": head,
            "baseline_head": base,
            "history": [{"generation": 1, "commit": head, "parent": base}],
            "files": [],
        }
        state["envelopes"] = {
            "GPT_SPEC": self._record(
                "GPT_SPEC",
                stream,
                head,
                "5330000001",
                "ACTIONABLE",
                {
                    "BASE_HEAD": base,
                    "SCOPE": "README.md",
                    "MATERIALIZED_BY": "AGENTBUS",
                    "SOURCE_CONTINUATION_COMMENT_ID": "5330000001",
                },
            ),
            "CODEX_REPORT": self._record(
                "CODEX_REPORT",
                stream,
                head,
                "5330000002",
                "READY_FOR_AUDIT",
                {"IMPLEMENTED_HEAD": head},
            ),
            "CODEX_AUDIT": self._record(
                "CODEX_AUDIT",
                stream,
                head,
                "5330000003",
                "PASS",
                {"AUDITED_HEAD": head},
            ),
            "GPT_REVIEW": self._record(
                "GPT_REVIEW",
                stream,
                head,
                "5330000004",
                "ACCEPT",
                {"REVIEWED_HEAD": head},
            ),
        }
        live = {
            "number": 46,
            "headRefName": f"agentbus/{stream}",
            "headRefOid": head,
            "baseRefOid": base,
            "state": "OPEN",
            "isDraft": True,
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [],
        }
        state["github"]["pr"] = dict(live)
        store.save(state)
        pr_state = os.path.join(self.root, f"{stream}-pr.json")
        with open(pr_state, "w", encoding="utf-8") as handle:
            json.dump(live, handle)
        os.environ["FAKE_GH_PR_STATE"] = pr_state
        os.environ["FAKE_GH_HEAD"] = head
        return state, live, head, base

    def _record(self, kind: str, stream: str, head: str, source_id: str, status: str, fields: dict) -> dict:
        all_fields = {"STATUS": status, "STREAM": stream, **fields}
        envelope = Envelope(kind=kind, fields=all_fields, source="github", source_id=source_id)
        envelope.raw = render_envelope(envelope)
        return envelope.as_record()

    def test_owned_draft_is_made_ready_and_second_reconcile_is_idempotent(self) -> None:
        state, live, head, base = self._ready_fixture()
        store = self.store("s1")
        count = os.path.join(self.root, "ready-count")
        self._write_text(count, "0")
        os.environ["FAKE_GH_READY_COUNT"] = count

        before_generation = review_generation(state, None, live, role=FINAL_GPT, task=FINAL_REVIEW)
        result = ensure_pr_reviewable(self.ctx, store, state, env=dict(os.environ))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["head"], head)
        self.assertEqual(result["base"], base)
        self.assertFalse(result["pr"]["isDraft"])
        self.assertEqual(self._read_text(count), "1")

        after_live = result["pr"]
        after_generation = review_generation(state, None, after_live, role=FINAL_GPT, task=FINAL_REVIEW)
        self.assertNotEqual(before_generation, after_generation)
        second = ensure_pr_reviewable(self.ctx, store, state, env=dict(os.environ))
        self.assertEqual(second["status"], "already-ready")
        self.assertEqual(self._read_text(count), "1")

    def test_old_final_wait_is_stale_after_ready_evidence_changes(self) -> None:
        state, live, head, _ = self._ready_fixture("wait-s1")
        state["final_gpt"] = {"url": "https://chatgpt.com/c/final", "display_name": "Final"}
        old_job = browser_job_id(state, None, live, role=FINAL_GPT, task=FINAL_REVIEW)
        state["envelopes"]["GPT_MERGE_REVIEW"] = self._record(
            "GPT_MERGE_REVIEW",
            state["stream_id"],
            head,
            "5330000005",
            "WAIT",
            {
                "PR": "46",
                "JOB_ID": old_job,
                "REVIEWED_HEAD": head,
                "REVIEWED_BASE": live["baseRefOid"],
            },
        )
        result = ensure_pr_reviewable(self.ctx, self.store("wait-s1"), state, env=dict(os.environ))
        self.assertEqual(result["status"], "ready")
        self.assertIsNone(final_review_for_current(state, None, result["pr"]))
        job = job_for_state(self.ctx, state)
        self.assertIsNotNone(job)
        self.assertEqual(job.task, FINAL_REVIEW)
        self.assertNotEqual(job.job_id, old_job)

    def test_non_owned_or_incomplete_pr_is_never_made_ready(self) -> None:
        state, _, _, _ = self._ready_fixture("fence-s1")
        store = self.store("fence-s1")
        count = os.path.join(self.root, "fence-count")
        self._write_text(count, "0")
        os.environ["FAKE_GH_READY_COUNT"] = count

        state["transport"]["owned"] = False
        self.assertEqual(ensure_pr_reviewable(self.ctx, store, state, env=dict(os.environ))["status"], "not-eligible")
        self.assertEqual(self._read_text(count), "0")
        state["transport"]["owned"] = True
        state["envelopes"].pop("CODEX_AUDIT")
        self.assertEqual(ensure_pr_reviewable(self.ctx, store, state, env=dict(os.environ))["status"], "not-eligible")
        self.assertEqual(self._read_text(count), "0")
        state["envelopes"]["CODEX_AUDIT"] = self._record(
            "CODEX_AUDIT", "fence-s1", "a" * 40, "5330000003", "PASS", {"AUDITED_HEAD": "a" * 40}
        )
        state["status"]["blocker"] = "current ownership conflict"
        self.assertEqual(ensure_pr_reviewable(self.ctx, store, state, env=dict(os.environ))["status"], "not-eligible")
        self.assertEqual(self._read_text(count), "0")

    def test_current_and_stale_ownership_blockers_are_scoped(self) -> None:
        state, _, head, _ = self._ready_fixture("block-s1")
        old = "1" * 40
        state["status"]["blocker"] = f"CODEX_REPORT {head[:12]} is not an AgentBus-owned publication"
        self.assertEqual(active_blocker(state), state["status"]["blocker"])

        state["status"]["blocker"] = f"CODEX_REPORT {old[:12]} is not an AgentBus-owned publication"
        self.assertIsNone(active_blocker(state))
        self.assertIn(old[:12], state["status"]["blocker"])

        state["status"]["blocker_meta"] = {
            "kind": "PUBLICATION_OWNERSHIP",
            "head": old,
            "generation": 1,
            "reason": state["status"]["blocker"],
        }
        self.assertIsNone(active_blocker(state))
        self.store("block-s1").save(state)
        self.assertIsNone(stream_view(self.ctx, self.store("block-s1"), env=dict(os.environ))["blocker"])

        state["publication"]["remote_sha"] = None
        self.assertEqual(active_blocker(state), state["status"]["blocker"])

    def test_unrelated_blocker_remains_a_merge_fence_and_history_is_untouched(self) -> None:
        state, live, _, _ = self._ready_fixture("block-s2")
        state["status"]["blocker"] = "manual decision required"
        before_history = list(state["publication"]["history"])
        gate = deterministic_merge_fences(state, live=live)
        self.assertIn("blocker present", gate["reasons"])
        self.assertEqual(state["publication"]["history"], before_history)
