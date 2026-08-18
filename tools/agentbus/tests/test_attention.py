from __future__ import annotations

from agentbus.apply import apply_envelope, mark_pr_merged, set_phase
from agentbus.attention import classify_attention
from agentbus.machine import (
    BLOCKED_FOR_REVIEW,
    FINAL_GATE,
    IMPLEMENTING,
    MERGED,
    READY_FOR_AUDIT,
    READY_FOR_GPT,
    RE_REVIEW_REQUIRED,
    WAITING_FOR_SPEC,
)
from agentbus.protocol import parse_one
from agentbus.tests.harness import AgentbusTest
from agentbus.tests.test_campaign import continuation_text
from agentbus.views import needs_you


class AttentionTests(AgentbusTest):
    def test_ready_for_audit_not_human_required(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_AUDIT
        store.save(state)
        att = classify_attention(store.load())
        self.assertFalse(att["human_required"])
        self.assertEqual(att["attention_owner"], "AUDIT")
        self.assertFalse(needs_you(store.load()))

    def test_bounded_changes_required_not_human_required(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = IMPLEMENTING
        state["repair_cycles"] = 1
        state["max_repair_cycles"] = 2
        state["status"]["audit"] = "CHANGES_REQUIRED"
        store.save(state)
        att = classify_attention(store.load())
        self.assertFalse(att["human_required"])
        self.assertEqual(att["attention_owner"], "IMPL")

    def test_merged_with_continuation_not_human_required(self) -> None:
        self.create_stream("m-a")
        store = self.store("m-a")
        state = store.load()
        state["campaign_id"] = "m"
        state["phase"] = FINAL_GATE
        sha = self.git("rev-parse", "HEAD")
        state["heads"]["current"] = sha
        store.save(state)
        state = store.load()
        apply_envelope(
            store,
            state,
            parse_one(continuation_text(campaign="m", after="m-a", nxt="m-b", scope="README.md")),
            repo=self.repo,
            current_head=sha,
        )
        store.save(state)
        state = store.load()
        mark_pr_merged(state, store, merge_sha=sha)
        store.save(state)
        att = classify_attention(store.load())
        self.assertEqual(store.load()["phase"], MERGED)
        self.assertFalse(att["human_required"])
        self.assertEqual(att["kind"], "complete")

    def test_repair_budget_exhausted_human_required(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = BLOCKED_FOR_REVIEW
        state["repair_cycles"] = 2
        store.save(state)
        att = classify_attention(store.load())
        self.assertTrue(att["human_required"])
        self.assertEqual(att["attention_owner"], "HUMAN")
        self.assertTrue(needs_you(store.load()))

    def test_unknown_external_head_human_required(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        set_phase(state, RE_REVIEW_REQUIRED, reason="unknown external HEAD")
        store.save(state)
        att = classify_attention(store.load())
        self.assertTrue(att["human_required"])
        self.assertEqual(att["kind"], "needs_you")

    def test_gpt_required_ready_for_gpt_is_browser_gpt(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_GPT
        state["review_policy"] = "GPT_REQUIRED"
        store.save(state)
        att = classify_attention(store.load())
        self.assertFalse(att["human_required"])
        self.assertTrue(att["browser_gpt_required"])
        self.assertEqual(att["kind"], "needs_gpt")
        self.assertEqual(att["attention_owner"], "BROWSER_GPT")
        self.assertFalse(needs_you(store.load()))

    def test_audit_sufficient_pass_no_browser_gpt_gate(self) -> None:
        self.create_stream("s1")
        store = self.store("s1")
        state = store.load()
        state["phase"] = READY_FOR_GPT
        state["review_policy"] = "AUDIT_SUFFICIENT"
        store.save(state)
        att = classify_attention(store.load())
        self.assertFalse(att["browser_gpt_required"])
        self.assertFalse(att["human_required"])

    def test_campaign_queue_exhausted_needs_gpt_plan(self) -> None:
        self.create_stream("plan-a")
        store = self.store("plan-a")
        state = store.load()
        state["campaign_id"] = "plan"
        state["phase"] = FINAL_GATE
        sha = self.git("rev-parse", "HEAD")
        state["heads"]["current"] = sha
        store.save(state)
        state = store.load()
        mark_pr_merged(state, store, merge_sha=sha)
        store.save(state)
        from agentbus.campaign import load_campaign
        from agentbus.attention import campaign_attention

        campaign = load_campaign(self.ctx, "plan")
        att = campaign_attention(campaign)
        self.assertEqual(campaign["status"], "WAITING_FOR_PLAN")
        self.assertTrue(att["browser_gpt_required"])
        self.assertFalse(att["human_required"])
        self.assertEqual(store.load()["phase"], MERGED)
        self.assertEqual(classify_attention(store.load())["kind"], "complete")
        self.assertEqual(classify_attention(store.load())["attention_owner"], "NONE")
        # stream itself is complete; plan attention is on the campaign
        self.assertEqual(store.load()["phase"], MERGED)
