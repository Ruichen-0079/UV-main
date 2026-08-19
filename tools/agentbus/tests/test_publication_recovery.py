from __future__ import annotations

import json
import os

from agentbus.autopilot import campaign_tick, ensure_executor_surface
from agentbus.decision import AUDIT, derive_next_action
from agentbus.generation import recover_lost_publication
from agentbus.machine import RE_REVIEW_REQUIRED, READY_FOR_AUDIT
from agentbus.protocol import Envelope, render_envelope
from agentbus.publish import empty_publication, _report_body_for_github
from agentbus.scope import materialize_path_scope
from agentbus.tests.harness import AgentbusTest
from agentbus.util import atomic_write_text


class PublicationRecoveryTests(AgentbusTest):
    authority = "5331154097"
    report_comment_id = "5331296601"

    def _fixture(
        self,
        stream: str = "recover",
        *,
        event: bool = True,
        event_stream: str | None = None,
        event_parent: str | None = None,
        event_authority: str | None = None,
        event_files: list[str] | None = None,
        report_files: list[str] | None = None,
    ) -> tuple[object, dict[str, object], str, str, str]:
        linked = os.path.join(self.root, f"{stream}-impl")
        self.git("worktree", "add", "-b", f"agentbus/{stream}", linked, "HEAD")
        self.create_stream(stream, "--pr", "45", "--worktree", linked)
        store = self.store(stream)
        state = store.load()
        parent = self.git("rev-parse", "HEAD", cwd=linked)
        atomic_write_text(os.path.join(linked, "feature.txt"), "recovered\n")
        self.git("add", "feature.txt", cwd=linked)
        self.git("commit", "-m", "external-looking commit", cwd=linked)
        candidate = self.git("rev-parse", "HEAD", cwd=linked)
        files = report_files or ["feature.txt"]
        event_paths = event_files or ["feature.txt"]

        spec_fields = {
            "STATUS": "ACTIONABLE",
            "STREAM": stream,
            "BASE_HEAD": parent,
            "SCOPE": "- feature.txt",
            "PATH_SCOPE": "EXACT:\n- feature.txt",
            "ACCEPTANCE_CRITERIA": "tests pass",
            "SOURCE_CONTINUATION_COMMENT_ID": self.authority,
        }
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "status": "ACTIONABLE",
            "stream": stream,
            "head": parent,
            "source": "continuation",
            "source_id": self.authority,
            "digest": "spec-digest",
            "fields": spec_fields,
            "raw": "[GPT_SPEC]\n\nSTATUS: ACTIONABLE\n",
        }
        state["scope"] = materialize_path_scope(
            raw_scope=spec_fields["SCOPE"],
            path_scope_field=spec_fields["PATH_SCOPE"],
            source=f"continuation:{self.authority}",
        )
        state["transport"] = {
            "owned": True,
            "kind": "zero_tree_transport",
            "bootstrap_commit": parent,
            "commit_sha": parent,
            "continuation_comment_id": self.authority,
            "status": "pr_ready",
        }
        state["heads"]["current"] = candidate
        state["heads"]["last_seen"] = candidate
        state["phase"] = RE_REVIEW_REQUIRED
        state["status"]["blocker"] = f"CODEX_REPORT {candidate[:12]} is not an AgentBus-owned publication"
        report = Envelope(
            kind="CODEX_REPORT",
            fields={
                "STATUS": "READY_FOR_AUDIT",
                "STREAM": stream,
                "IMPLEMENTED_HEAD": candidate,
                "CHANGED_FILES": "\n".join(f"- {path}" for path in files),
                "VALIDATION": "ok",
                "DEVIATIONS": "None",
                "SOURCE_CONTINUATION_COMMENT_ID": self.authority,
                "NEXT_ACTION": "AUDIT",
            },
            source="github",
            source_id=self.report_comment_id,
        )
        report.raw = render_envelope(report)
        state["envelopes"]["CODEX_REPORT"] = report.as_record()
        state["seen_comment_ids"] = [self.report_comment_id]
        state["publication"] = empty_publication()
        if event:
            store.append_event(
                "publish-commit",
                {
                    "stream": event_stream or stream,
                    "parent": event_parent or parent,
                    "commit": candidate,
                    "files": event_paths,
                    "authority": event_authority or self.authority,
                    "message": "agentbus publication evidence",
                },
            )
        store.save(state)
        os.environ["FAKE_GH_HEAD"] = candidate
        body = _report_body_for_github(state)
        atomic_write_text(self.fake_comments, json.dumps([{"id": self.report_comment_id, "body": body}]))
        return store, state, linked, parent, candidate

    def _recover(self, **kwargs):
        store, state, linked, parent, candidate = self._fixture(**kwargs)
        result = recover_lost_publication(store, state, worktree=linked)
        return result, store, state, linked, parent, candidate

    def _event_lines(self, store) -> list[str]:
        with open(store.events_path, encoding="utf-8") as handle:
            return handle.readlines()

    def test_exact_evidence_reconstructs_ownership_and_audit(self) -> None:
        result, store, state, linked, parent, candidate = self._recover(stream="success")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["commit"], candidate)
        self.assertEqual(result["parent"], parent)
        self.assertEqual(result["report_comment_id"], self.report_comment_id)
        self.assertEqual(state["publication"]["commit"], candidate)
        self.assertEqual(state["publication"]["remote_sha"], candidate)
        self.assertEqual(state["envelopes"]["CODEX_REPORT"]["source_id"], self.report_comment_id)
        self.assertEqual(state["phase"], READY_FOR_AUDIT)
        decision = derive_next_action(state, None, {"headRefOid": candidate})
        self.assertEqual(decision.action, AUDIT, decision)
        self.assertEqual(state["repair_cycles"], 0)

        executor = ensure_executor_surface(self.ctx, store, state, decision)
        self.assertTrue(executor["ok"], executor)
        self.assertEqual(executor["role"], "audit")
        self.assertEqual(executor["status"], "launched")
        self.assertEqual(len(self.executor_launches), 1)
        self.assertEqual(self.executor_launches[0]["argv"][-2:], ["audit", "--watch"])

    def test_campaign_tick_recovers_p7_shape_without_impl_invocation(self) -> None:
        store, state, linked, parent, candidate = self._fixture(stream="tick")
        result = campaign_tick(self.ctx, stream_id="tick", force_sync=True, surface="test")
        item = result["results"][0]
        self.assertEqual(item["decision"]["action"], AUDIT, item)
        self.assertEqual(item["executor"]["role"], "audit")
        self.assertEqual(item["executor"]["status"], "launched")
        self.assertEqual(store.load()["publication"]["commit"], candidate)
        self.assertEqual(len(store.load()["publication"]["history"]), 1)
        self.assertEqual(self.executor_launches[0]["argv"][-2:], ["audit", "--watch"])

    def test_duplicate_recovery_is_idempotent_and_reuses_exact_report(self) -> None:
        result, store, state, linked, parent, candidate = self._recover(stream="duplicate")
        self.assertTrue(result["ok"], result)
        store.save(state)
        first = store.load()
        history = list(first["publication"]["history"])
        recovered_events = [line for line in self._event_lines(store) if "publication-recovered" in line]
        second = store.load()
        result2 = recover_lost_publication(store, second, worktree=linked)
        self.assertTrue(result2["ok"], result2)
        self.assertEqual(second["publication"]["history"], history)
        recovered_events_after = [line for line in self._event_lines(store) if "publication-recovered" in line]
        self.assertEqual(len(recovered_events_after), len(recovered_events))
        self.assertEqual(second["envelopes"]["CODEX_REPORT"]["source_id"], self.report_comment_id)
        self.assertEqual(second["repair_cycles"], 0)

    def test_same_head_old_report_body_is_not_adopted(self) -> None:
        store, state, linked, parent, candidate = self._fixture(stream="report-fence")
        with open(self.fake_comments, encoding="utf-8") as handle:
            current = json.load(handle)[0]
        old = dict(current)
        old["id"] = "5327117770"
        old["body"] = current["body"].replace("feature.txt", "old-feature.txt")
        atomic_write_text(self.fake_comments, json.dumps([old, current]))
        result = recover_lost_publication(store, state, worktree=linked)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["report_comment_id"], self.report_comment_id)

    def test_missing_or_spoofed_event_fails_closed(self) -> None:
        result, store, state, linked, parent, candidate = self._recover(stream="no-event", event=False)
        self.assertFalse(result["ok"], result)
        self.assertIsNone(state["publication"].get("commit"))

        result, store, state, linked, parent, candidate = self._recover(
            stream="wrong-stream", event_stream="other-stream"
        )
        self.assertFalse(result["ok"], result)
        self.assertIsNone(state["publication"].get("commit"))

    def test_event_parent_authority_bootstrap_and_drift_fences(self) -> None:
        for stream, kwargs in (
            ("wrong-parent", {"event_parent": "a" * 40}),
            ("wrong-authority", {"event_authority": "9999999999"}),
            ("wrong-files", {"event_files": ["other.txt"]}),
            ("wrong-report-files", {"report_files": ["other.txt"]}),
        ):
            result, store, state, linked, parent, candidate = self._recover(stream=stream, **kwargs)
            self.assertFalse(result["ok"], (stream, result))
            self.assertIsNone(state["publication"].get("commit"))

        store, state, linked, parent, candidate = self._fixture(stream="bootstrap")
        state["transport"]["bootstrap_commit"] = candidate
        store.save(state)
        result = recover_lost_publication(store, state, worktree=linked)
        self.assertFalse(result["ok"], result)

        store, state, linked, parent, candidate = self._fixture(stream="remote-drift")
        os.environ["FAKE_GH_HEAD"] = "b" * 40
        result = recover_lost_publication(store, state, worktree=linked)
        self.assertFalse(result["ok"], result)

        store, state, linked, parent, candidate = self._fixture(stream="state-drift")
        state["heads"]["implemented"] = "c" * 40
        store.save(state)
        result = recover_lost_publication(store, state, worktree=linked)
        self.assertFalse(result["ok"], result)

    def test_worktree_and_report_head_fences_fail_closed(self) -> None:
        result, store, state, linked, parent, candidate = self._recover(stream="dirty")
        atomic_write_text(os.path.join(linked, "dirty.txt"), "do not recover\n")
        result = recover_lost_publication(store, state, worktree=linked)
        self.assertFalse(result["ok"], result)

        result, store, state, linked, parent, candidate = self._recover(stream="report-head")
        state["envelopes"]["CODEX_REPORT"]["fields"]["IMPLEMENTED_HEAD"] = "d" * 40
        store.save(state)
        result = recover_lost_publication(store, state, worktree=linked)
        self.assertFalse(result["ok"], result)
