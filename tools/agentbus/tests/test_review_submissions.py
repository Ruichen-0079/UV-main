from __future__ import annotations

import json
import os

from agentbus.apply import mark_pr_merged
from agentbus.browser import job_for_state
from agentbus.campaign import bind_explicit_campaign, load_campaign
from agentbus.decision import PLAN_CONTINUATION, PRODUCT_GPT, browser_job_id
from agentbus.decision import derive_next_action
from agentbus.github import (
    ISSUE_COMMENT,
    REVIEW_SUBMISSION,
    apply_fetched_sources,
    fetch_pr_payload,
    normalize_github_sources,
)
from agentbus.machine import FINAL_GATE, MERGED
from agentbus.store import StreamStore
from agentbus.tests.harness import AgentbusTest
from agentbus.util import atomic_write_text


class ReviewSubmissionTests(AgentbusTest):
    def _merged_p7(self) -> tuple[StreamStore, dict, dict, str]:
        self.create_stream("p7-8d-dashboard-diagnostics", "--pr", "45")
        store = self.store("p7-8d-dashboard-diagnostics")
        state = store.load()
        bind_explicit_campaign(self.ctx, state, "p7")
        head = self.git("rev-parse", "HEAD")
        state["phase"] = FINAL_GATE
        state.setdefault("heads", {})["current"] = head
        state["heads"]["implemented"] = head
        store.save(state)
        state = store.load()
        mark_pr_merged(state, store, merge_sha=head)
        view = {
            "number": 45,
            "state": "MERGED",
            "headRefOid": head,
            "baseRefName": "main",
            "baseRefOid": "b" * 40,
            "mergeCommit": {"oid": head},
        }
        state = store.load()
        state.setdefault("github", {})["pr"] = view
        store.save(state)
        campaign = load_campaign(self.ctx, "p7")
        job = browser_job_id(
            state,
            campaign,
            view,
            role=PRODUCT_GPT,
            task=PLAN_CONTINUATION,
        )
        return store, state, view, job

    def _body(self, job: str, *, campaign: str = "p7", after: str = "p7-8d-dashboard-diagnostics", nxt: str = "p7-8e-settings-state-truth") -> str:
        return f"""[GPT_CONTINUATION]

STATUS: ACTIONABLE

CAMPAIGN: {campaign}

JOB_ID: {job}

AFTER_STREAM: {after}

TRIGGER: MERGED

NEXT_STREAM: {nxt}

TARGET: distinguish draft, saved, and runtime settings state

SCOPE:
- apps/desktop/src/settings

ACCEPTANCE_CRITERIA:
- state labels are truthful

NEXT_ACTION: CREATE_AND_IMPLEMENT
[/GPT_CONTINUATION]
"""

    def _review(self, review_id: str, body: str, *, created: str = "2026-08-19T06:06:39Z") -> dict:
        return {
            "surface": REVIEW_SUBMISSION,
            "source_id": review_id,
            "source_key": f"{REVIEW_SUBMISSION}:{review_id}",
            "submitted_at": created,
            "created_at": created,
            "body": body,
            "html_url": f"https://github.com/example/yuvi-test/pull/45#pullrequestreview-{review_id}",
        }

    def test_review_submission_body_is_ingested_and_materializes_once(self) -> None:
        store, state, view, job = self._merged_p7()
        source = self._review("4968923416", self._body(job), created="2026-08-19T06:06:39Z")
        notes = apply_fetched_sources(
            store,
            state,
            sources=[source],
            view=view,
            repo_root=self.repo,
            current_head=state["heads"]["current"],
            ctx=self.ctx,
        )
        state = store.load()
        rec = state["envelopes"]["GPT_CONTINUATION"]
        self.assertEqual(rec["surface"], REVIEW_SUBMISSION)
        self.assertEqual(rec["source_id"], "4968923416")
        self.assertEqual(rec["source_key"], "review_submission:4968923416")
        self.assertTrue(any("ingested GPT_CONTINUATION" in note for note in notes))
        self.assertTrue(StreamStore(self.ctx, "p7-8e-settings-state-truth").exists())
        campaign = load_campaign(self.ctx, "p7")
        rows = [row for row in campaign["queue"] if row.get("next_stream") == "p7-8e-settings-state-truth"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].get("source_key"), "review_submission:4968923416")
        self.assertEqual(store.load()["phase"], MERGED)
        self.assertIsNone(job_for_state(self.ctx, state, campaign=campaign))

        # Repeated sync of the same source is a no-op.
        apply_fetched_sources(
            store,
            store.load(),
            sources=[source],
            view=view,
            repo_root=self.repo,
            current_head=state["heads"]["current"],
            ctx=self.ctx,
        )
        campaign = load_campaign(self.ctx, "p7")
        self.assertEqual(
            len([row for row in campaign["queue"] if row.get("next_stream") == "p7-8e-settings-state-truth"]),
            1,
        )

    def test_review_submission_wrong_job_is_rejected(self) -> None:
        store, state, view, _job = self._merged_p7()
        source = self._review("bad-job", self._body("product_gpt:plan_continuation:old:bad"))
        apply_fetched_sources(
            store,
            state,
            sources=[source],
            view=view,
            repo_root=self.repo,
            current_head=state["heads"]["current"],
            ctx=self.ctx,
        )
        self.assertFalse(StreamStore(self.ctx, "p7-8e-settings-state-truth").exists())
        stale = store.load().get("stale_product_jobs") or []
        self.assertTrue(any(item.get("job_id") == "product_gpt:plan_continuation:old:bad" for item in stale))

    def test_review_submission_wrong_campaign_and_after_are_rejected(self) -> None:
        store, state, view, job = self._merged_p7()
        wrong_campaign = self._review("wrong-campaign", self._body(job, campaign="other"))
        wrong_after = self._review("wrong-after", self._body(job, after="p7-old-merged"))
        apply_fetched_sources(
            store,
            state,
            sources=[wrong_campaign, wrong_after],
            view=view,
            repo_root=self.repo,
            current_head=state["heads"]["current"],
            ctx=self.ctx,
        )
        self.assertFalse(StreamStore(self.ctx, "p7-8e-settings-state-truth").exists())
        rejected = store.load().get("rejected_github_source_keys") or []
        self.assertIn("review_submission:wrong-campaign", rejected)
        self.assertIn("review_submission:wrong-after", rejected)

    def test_empty_review_body_is_ignored(self) -> None:
        store, state, view, _job = self._merged_p7()
        source = self._review("empty", "")
        apply_fetched_sources(
            store,
            state,
            sources=[source],
            view=view,
            repo_root=self.repo,
            current_head=state["heads"]["current"],
            ctx=self.ctx,
        )
        self.assertNotIn("GPT_CONTINUATION", store.load().get("envelopes") or {})
        self.assertIn("review_submission:empty", store.load().get("seen_github_source_keys") or [])

    def test_inline_review_surface_is_not_a_durable_authority(self) -> None:
        inline = {
            "surface": "inline_review_comment",
            "id": "inline-1",
            "body": "[GPT_CONTINUATION] STATUS: ACTIONABLE [/GPT_CONTINUATION]",
        }
        self.assertEqual(normalize_github_sources([], [inline]), [])
        self.assertEqual(normalize_github_sources([inline], []), [])

    def test_same_envelope_on_issue_and_review_has_one_effect_and_review_wins_metadata(self) -> None:
        store, state, view, job = self._merged_p7()
        body = self._body(job)
        sources = normalize_github_sources(
            [{"id": "9000000000", "body": body, "created_at": "2026-08-19T06:00:00Z"}],
            [self._review("10", body, created="2026-08-19T06:06:39Z")],
        )
        apply_fetched_sources(
            store,
            state,
            sources=sources,
            view=view,
            repo_root=self.repo,
            current_head=state["heads"]["current"],
            ctx=self.ctx,
        )
        rec = store.load()["envelopes"]["GPT_CONTINUATION"]
        self.assertEqual(rec["source_key"], "review_submission:10")
        campaign = load_campaign(self.ctx, "p7")
        self.assertEqual(
            len([row for row in campaign["queue"] if row.get("next_stream") == "p7-8e-settings-state-truth"]),
            1,
        )

    def test_cross_surface_order_uses_created_at_not_numeric_ids(self) -> None:
        sources = normalize_github_sources(
            [{"id": "9999999999", "body": "issue", "created_at": "2026-08-19T06:00:00Z"}],
            [self._review("1", "review", created="2026-08-19T06:06:39Z")],
        )
        self.assertEqual([source["surface"] for source in sources], [ISSUE_COMMENT, REVIEW_SUBMISSION])
        self.assertEqual(sources[-1]["source_key"], "review_submission:1")

    def test_scope_replan_cross_surface_uses_time_not_numeric_id(self) -> None:
        head = "a" * 40
        spec_base = "b" * 40
        state = {
            "stream_id": "p7-8d-dashboard-diagnostics",
            "pr": 45,
            "phase": "BLOCKED",
            "control": "running",
            "heads": {"implemented": head, "current": head},
            "status": {"blocker": "scope insufficient"},
            "envelopes": {
                "GPT_SPEC": {
                    "kind": "GPT_SPEC",
                    "status": "ACTIONABLE",
                    "head": spec_base,
                    "source": "github",
                    "source_id": "1",
                    "surface": ISSUE_COMMENT,
                    "source_key": "issue_comment:1",
                    "created_at": "2026-08-19T06:06:39Z",
                    "fields": {"BASE_HEAD": spec_base},
                },
                "CODEX_REPORT": {
                    "kind": "CODEX_REPORT",
                    "status": "BLOCKED",
                    "head": head,
                    "source": "github",
                    "source_id": "9999",
                    "surface": REVIEW_SUBMISSION,
                    "source_key": "review_submission:9999",
                    "created_at": "2026-08-19T06:00:00Z",
                    "fields": {
                        "IMPLEMENTED_HEAD": head,
                        "BASE_HEAD": spec_base,
                        "VERDICT": "BLOCKED",
                        "BLOCKER": "approved scope is insufficient",
                    },
                },
            },
        }
        self.assertNotEqual(derive_next_action(state).action, PRODUCT_GPT)

    def test_fetch_pr_payload_includes_top_level_reviews(self) -> None:
        reviews_path = os.path.join(self.root, "reviews.json")
        atomic_write_text(
            reviews_path,
            json.dumps([self._review("4968923416", "[GPT_CONTINUATION]\nSTATUS: WAIT\n")]),
        )
        os.environ["FAKE_GH_REVIEWS"] = reviews_path
        sources, _view = fetch_pr_payload(self.repo, "https://github.com/example/yuvi-test.git", 45)
        self.assertTrue(any(source["source_key"] == "review_submission:4968923416" for source in sources))
