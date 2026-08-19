from __future__ import annotations

from unittest.mock import patch

from agentbus.apply import apply_envelope, mark_pr_merged
from agentbus.browser import list_browser_jobs
from agentbus.campaign import (
    backfill_archived_units,
    campaign_view,
    load_campaign,
    project_campaign,
)
from agentbus.decision import PLAN_CONTINUATION, PRODUCT_GPT, WAIT, browser_job_id, derive_next_action
from agentbus.machine import FINAL_GATE, MERGED
from agentbus.protocol import parse_one
from agentbus.store import StreamStore
from agentbus.tests.harness import AgentbusTest
from agentbus.tests.test_campaign import continuation_text
from agentbus.settings import set_global_binding


class CampaignLifecycleTests(AgentbusTest):
    def _merged(self, stream: str, campaign: str, *, pr: int = 50) -> StreamStore:
        self.create_stream(stream, "--pr", str(pr))
        store = self.store(stream)
        state = store.load()
        state["campaign_id"] = campaign
        state["phase"] = FINAL_GATE
        head = self.git("rev-parse", "HEAD")
        state["heads"].update({"current": head, "implemented": head})
        state["github"]["pr"] = {
            "number": pr,
            "state": "MERGED",
            "headRefOid": head,
            "baseRefOid": "b" * 40,
            "mergeCommit": {"oid": head},
        }
        store.save(state)
        mark_pr_merged(state, store, merge_sha=head)
        return store

    def _complete(self, store: StreamStore, *, job: str, source_id: str = "review-1") -> None:
        state = store.load()
        body = f"""[GPT_CONTINUATION]
STATUS: COMPLETE
CAMPAIGN: {state['campaign_id']}
JOB_ID: {job}
AFTER_STREAM: {state['stream_id']}
TRIGGER: MERGED
SUMMARY: the campaign objective is complete
NEXT_ACTION: DONE
[/GPT_CONTINUATION]
"""
        envelope = parse_one(body)
        envelope.source = "github"
        envelope.source_id = source_id
        envelope.surface = "review_submission"
        envelope.source_key = f"review_submission:{source_id}"
        apply_envelope(store, state, envelope, repo=self.repo, current_head=state["heads"]["current"])

    def test_final_gate_open_does_not_plan_or_archive(self) -> None:
        self.create_stream("open-u", "--pr", "51")
        store = self.store("open-u")
        state = store.load()
        state["campaign_id"] = "open-c"
        state["phase"] = FINAL_GATE
        state["github"]["pr"] = {"number": 51, "state": "OPEN", "headRefOid": state["heads"]["current"]}
        store.save(state)
        decision = derive_next_action(state, live=state["github"]["pr"])
        self.assertNotEqual(decision.task, PLAN_CONTINUATION)
        self.assertFalse(store.load().get("archived"))

    def test_closed_unmerged_does_not_start_continuation(self) -> None:
        self.create_stream("closed-u", "--pr", "52")
        store = self.store("closed-u")
        state = store.load()
        state["campaign_id"] = "closed-c"
        state["phase"] = FINAL_GATE
        state["github"]["pr"] = {"number": 52, "state": "CLOSED", "merged": False}
        store.save(state)
        self.assertNotEqual(derive_next_action(state, live=state["github"]["pr"]).task, PLAN_CONTINUATION)

    def test_local_merged_phase_without_github_confirmation_waits(self) -> None:
        self.create_stream("unconfirmed-u", "--pr", "53")
        store = self.store("unconfirmed-u")
        state = store.load()
        state["campaign_id"] = "unconfirmed-c"
        state["phase"] = MERGED
        head = state["heads"]["current"]
        state["heads"]["merged"] = head
        state.pop("merge_confirmed_at", None)
        state.setdefault("github", {}).pop("pr", None)
        store.save(state)
        decision = derive_next_action(state)
        self.assertEqual(decision.action, WAIT)
        self.assertEqual(decision.wait_reason, "MERGE_PENDING")

    def test_durable_merge_archives_unit_but_not_campaign(self) -> None:
        store = self._merged("done-u", "done-c")
        state = store.load()
        campaign = load_campaign(self.ctx, "done-c")
        self.assertEqual(state["phase"], MERGED)
        self.assertTrue(state.get("archived"))
        self.assertTrue(state.get("hidden_from_attention"))
        self.assertEqual(campaign.get("status"), "WAITING_FOR_PLAN")
        self.assertFalse(campaign.get("archived"))
        view = campaign_view(campaign, self.ctx)
        self.assertIsNone(view.get("active_unit"))
        self.assertEqual(view.get("last_completed_unit"), "done-u")

    def test_actionable_continuation_archives_predecessor_and_keeps_campaign_active(self) -> None:
        store = self._merged("old-u", "chain-c")
        head = store.load()["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="chain-c", after="old-u", nxt="new-u", scope="README.md")),
            repo=self.repo,
            current_head=head,
        )
        self.assertTrue(store.load().get("archived"))
        campaign = load_campaign(self.ctx, "chain-c")
        self.assertEqual(campaign.get("status"), "ACTIVE")
        self.assertEqual(campaign.get("active_stream"), "new-u")
        self.assertTrue(StreamStore(self.ctx, "new-u").exists())

    def test_queue_empty_never_completes_and_browser_anchor_remains(self) -> None:
        set_global_binding(self.ctx, "PRODUCT_GPT", url="https://chatgpt.com/c/product")
        store = self._merged("plan-u", "plan-c")
        jobs = [job for job in list_browser_jobs(self.ctx) if job["stream"] == "plan-u"]
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["task"], PLAN_CONTINUATION)
        campaign = load_campaign(self.ctx, "plan-c")
        self.assertEqual(campaign.get("status"), "WAITING_FOR_PLAN")
        self.assertFalse(campaign.get("archived"))

    def test_waiting_projection_cannot_report_archived_saved_flag(self) -> None:
        store = self._merged("waiting-view-u", "waiting-view-c")
        campaign = load_campaign(self.ctx, "waiting-view-c")
        campaign["archived"] = True
        campaign["hidden_from_attention"] = True
        view = campaign_view(campaign, self.ctx)
        self.assertEqual(view.get("status"), "WAITING_FOR_PLAN")
        self.assertFalse(view.get("archived"))
        self.assertFalse(view.get("hidden_from_attention"))

    def test_archived_nonterminal_unit_blocks_campaign_completion(self) -> None:
        terminal = self._merged("terminal-u", "unsafe-complete-c")
        self.create_stream("bad-archived-u", "--pr", "54")
        bad = self.store("bad-archived-u")
        bad_state = bad.load()
        bad_state["campaign_id"] = "unsafe-complete-c"
        bad_state["phase"] = "IMPLEMENTING"
        bad_state["archived"] = True
        bad_state["hidden_from_attention"] = True
        bad.save(bad_state)
        campaign = load_campaign(self.ctx, "unsafe-complete-c")
        campaign["completion"] = "COMPLETE"
        campaign["completion_authority"] = {
            "source": "github",
            "source_id": "complete-unsafe",
            "job_id": "plan-job",
            "campaign": "unsafe-complete-c",
            "after_stream": "terminal-u",
            "trigger": "MERGED",
        }
        self.assertNotEqual(project_campaign(self.ctx, campaign).get("status"), "COMPLETE")

    def test_explicit_complete_authority_archives_campaign(self) -> None:
        store = self._merged("complete-u", "complete-c")
        state = store.load()
        campaign = load_campaign(self.ctx, "complete-c")
        job = browser_job_id(
            state,
            campaign,
            state["github"]["pr"],
            role=PRODUCT_GPT,
            task=PLAN_CONTINUATION,
        )
        self._complete(store, job=job)
        campaign = load_campaign(self.ctx, "complete-c")
        self.assertEqual(campaign.get("status"), "COMPLETE")
        self.assertTrue(campaign.get("archived"))
        self.assertEqual(campaign.get("completion"), "COMPLETE")
        self.assertEqual(campaign["completion_authority"]["source_id"], "review-1")
        self.assertIsNone(next((job for job in list_browser_jobs(self.ctx) if job["stream"] == "complete-u"), None))

    def test_wrong_complete_generation_is_rejected(self) -> None:
        store = self._merged("stale-u", "stale-c")
        state = store.load()
        body = """[GPT_CONTINUATION]
STATUS: COMPLETE
CAMPAIGN: stale-c
JOB_ID: old-generation
AFTER_STREAM: stale-u
TRIGGER: MERGED
SUMMARY: done
NEXT_ACTION: DONE
[/GPT_CONTINUATION]
"""
        envelope = parse_one(body)
        envelope.source = "github"
        envelope.source_id = "review-stale"
        envelope.surface = "issue_comment"
        apply_envelope(store, state, envelope, repo=self.repo, current_head=state["heads"]["current"])
        self.assertFalse(load_campaign(self.ctx, "stale-c").get("archived"))

    def test_complete_from_old_anchor_cannot_terminate_active_successor(self) -> None:
        store = self._merged("old-anchor-u", "active-successor-c")
        state = store.load()
        campaign = load_campaign(self.ctx, "active-successor-c")
        old_job = browser_job_id(
            state,
            campaign,
            state["github"]["pr"],
            role=PRODUCT_GPT,
            task=PLAN_CONTINUATION,
        )
        head = state["heads"]["merged"]
        apply_envelope(
            store,
            store.load(),
            parse_one(continuation_text(campaign="active-successor-c", after="old-anchor-u", nxt="active-successor-u", scope="README.md")),
            repo=self.repo,
            current_head=head,
        )
        complete = parse_one(
            f"""[GPT_CONTINUATION]
STATUS: COMPLETE
CAMPAIGN: active-successor-c
JOB_ID: {old_job}
AFTER_STREAM: old-anchor-u
TRIGGER: MERGED
SUMMARY: stale completion
NEXT_ACTION: DONE
[/GPT_CONTINUATION]
"""
        )
        complete.source = "github"
        complete.source_id = "stale-complete"
        complete.surface = "review_submission"
        complete.source_key = "review_submission:stale-complete"
        apply_envelope(store, store.load(), complete, repo=self.repo, current_head=head)
        self.assertNotEqual(load_campaign(self.ctx, "active-successor-c").get("status"), "COMPLETE")

    def test_historical_backfill_is_idempotent_and_does_not_create_successor(self) -> None:
        store = self._merged("history-u", "history-c")
        # The live merge path already archived it; emulate an old row by
        # clearing only the archive projection, never the merge authority.
        state = store.load()
        state["archived"] = False
        state["hidden_from_attention"] = False
        store.save(state)
        self.assertEqual(backfill_archived_units(self.ctx, "history-c"), ["history-u"])
        self.assertEqual(backfill_archived_units(self.ctx, "history-c"), [])
        self.assertTrue(store.load().get("archived"))
        self.assertFalse(any(name.startswith("history-") and name != "history-u" for name in self._state_ids()))

    def _state_ids(self) -> list[str]:
        import os

        return os.listdir(self.ctx.repo_state)

    def test_archive_cleanup_uses_owned_executor_fence_only(self) -> None:
        # mark_pr_merged invokes the existing cleanup seam; no new executor
        # implementation is required for lifecycle archive.
        with patch("agentbus.autopilot._cleanup_unneeded_executor_surfaces") as cleanup:
            store = self._merged("cleanup-u", "cleanup-c")
            state = store.load()
            self.assertTrue(cleanup.called)
