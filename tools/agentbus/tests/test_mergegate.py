from __future__ import annotations

import json
import os

from agentbus.apply import apply_envelope
from agentbus.attention import classify_attention
from agentbus.campaign import campaign_view, load_campaign
from agentbus.machine import FINAL_GATE, IMPLEMENTING, MERGE_PENDING, MERGED, READY_FOR_AUDIT, READY_FOR_GPT
from agentbus.mergegate import (
    SUGGEST_HOLD,
    SUGGEST_HUMAN,
    SUGGEST_MERGE,
    SUGGEST_WAIT_MERGE,
    SUGGEST_WAIT_PRODUCT,
    gpt_suggestion,
    merge_enablement,
    merge_prompt_text,
    merge_review_status,
    pass_and_merge,
    retry_merge,
    sanitize_display_text,
    sha_equal,
)
from agentbus.protocol import parse_one, validate_envelope
from agentbus.reviewpolicy import DELEGATED_AUTHORITY
from agentbus.tests.harness import AgentbusTest
from agentbus.views import stream_view
from agentbus.render import render_plan


def _merge_review(stream: str, head: str, status: str = "PASS", pr: int = 44) -> str:
    return f"""[GPT_MERGE_REVIEW]

STATUS: {status}

STREAM: {stream}

PR: {pr}

REVIEWED_HEAD: {head}

REVIEWED_BASE: {'b' * 40}

SUMMARY: independent check

EVIDENCE:
- CODEX_AUDIT: ok

FINDINGS:
- HIGH: none

RECOMMENDATION: {'MERGE' if status == 'PASS' else 'DO_NOT_MERGE'}

NEXT_ACTION: {'HUMAN_MERGE' if status == 'PASS' else 'HOLD'}
"""


class MergeGateTests(AgentbusTest):
    def _gate_stream(self, sid: str = "mg-a", pr: int = 44, policy: str = "AUDIT_SUFFICIENT") -> tuple:
        self.create_stream(sid, "--pr", str(pr), "--create-worktree")
        store = self.store(sid)
        state = store.load()
        head = self.git("rev-parse", "HEAD")
        state["phase"] = FINAL_GATE
        state["review_policy"] = policy
        if policy == "AUDIT_SUFFICIENT":
            state["review_authority"] = DELEGATED_AUTHORITY
        state["heads"]["implemented"] = head
        state["heads"]["current"] = head
        state["heads"]["audited"] = head
        state["envelopes"]["CODEX_AUDIT"] = {
            "kind": "CODEX_AUDIT",
            "status": "PASS",
            "head": head,
            "source": "github",
            "source_id": "1",
            "fields": {"AUDITED_HEAD": head, "STATUS": "PASS"},
        }
        state["envelopes"]["CODEX_REPORT"] = {
            "kind": "CODEX_REPORT",
            "status": "READY_FOR_AUDIT",
            "head": head,
            "source": "github",
            "source_id": "2",
            "raw": f"[CODEX_REPORT]\nSTATUS: READY_FOR_AUDIT\nSTREAM: {sid}\nIMPLEMENTED_HEAD: {head}\n",
            "fields": {"IMPLEMENTED_HEAD": head, "STATUS": "READY_FOR_AUDIT", "STREAM": sid},
        }
        store.save(state)
        return store, head

    def _apply(self, store, text, head):
        state = store.load()
        envelope = parse_one(text)
        # Only GitHub PR comments are durable Merge GPT authority.
        envelope.source = "github"
        envelope.source_id = f"merge-review-{envelope.status.lower()}"
        apply_envelope(store, state, envelope, repo=self.repo, current_head=head)
        store.save(state)
        return store.load()

    def test_campaign_phases_not_waiting_for_plan(self) -> None:
        for phase in (IMPLEMENTING, READY_FOR_AUDIT, "AUDITING", READY_FOR_GPT, FINAL_GATE, MERGE_PENDING):
            sid = f"ph-{phase.lower()}"
            self.create_stream(sid)
            store = self.store(sid)
            state = store.load()
            state["campaign_id"] = "phcamp"
            state["phase"] = phase
            store.save(state)
            from agentbus.campaign import bind_explicit_campaign

            bind_explicit_campaign(self.ctx, state, "phcamp")
            view = campaign_view(load_campaign(self.ctx, "phcamp"), self.ctx)
            self.assertEqual(view["status"], "ACTIVE", phase)
            self.assertFalse(view["unit_completed"], phase)

    def test_only_merged_empty_queue_is_waiting_for_plan(self) -> None:
        self.create_stream("done-u")
        store = self.store("done-u")
        state = store.load()
        state["campaign_id"] = "done2"
        state["phase"] = MERGED
        store.save(state)
        from agentbus.campaign import bind_explicit_campaign

        bind_explicit_campaign(self.ctx, state, "done2")
        view = campaign_view(load_campaign(self.ctx, "done2"), self.ctx)
        self.assertEqual(view["status"], "WAITING_FOR_PLAN")
        self.assertTrue(view["unit_completed"])

    def test_p6_p7_live_fixture_projection(self) -> None:
        self.create_stream("p6-e2a", "--pr", "44")
        st = self.store("p6-e2a").load()
        st["campaign_id"] = "p6"
        st["phase"] = FINAL_GATE
        self.store("p6-e2a").save(st)
        from agentbus.campaign import bind_explicit_campaign

        bind_explicit_campaign(self.ctx, st, "p6")
        p6 = campaign_view(load_campaign(self.ctx, "p6"), self.ctx)
        self.assertEqual(p6["status"], "ACTIVE")
        self.assertEqual(p6["wait_reason"], "WAITING_FOR_MERGE_GPT")
        self.assertEqual(p6["attention_owner"], "BROWSER_GPT")
        from agentbus.campaign import persist_campaign_projection, save_campaign

        campaign6 = load_campaign(self.ctx, "p6")
        persist_campaign_projection(self.ctx, campaign6)
        save_campaign(self.ctx, campaign6)
        self.assertEqual(load_campaign(self.ctx, "p6")["wait_reason"], "WAITING_FOR_MERGE_GPT")
        self.create_stream("p7-8c", "--pr", "43")
        st7 = self.store("p7-8c").load()
        st7["campaign_id"] = "p7"
        st7["phase"] = READY_FOR_GPT
        self.store("p7-8c").save(st7)
        bind_explicit_campaign(self.ctx, st7, "p7")
        p7 = campaign_view(load_campaign(self.ctx, "p7"), self.ctx)
        self.assertEqual(p7["status"], "ACTIVE")
        self.assertEqual(p7["wait_reason"], "WAITING_FOR_GPT")
        self.assertEqual(p7["attention_owner"], "BROWSER_GPT")

    def test_audit_worktree_path_display(self) -> None:
        raw = (
            "HIGH: [/home/ruichen/.local/state/yuvi-agent-bus/github.com_x/p4_2d2/"
            "audit-worktree/packages/desktop-supervisor/src/process-windows.ts:253] leak"
        )
        shown = sanitize_display_text(raw)
        self.assertIn("packages/desktop-supervisor/src/process-windows.ts", shown)
        self.assertNotIn("audit-worktree", shown)
        self.assertNotIn("/home/ruichen/", shown)

    def test_render_plan_hides_audit_worktree_prefix_in_finding(self) -> None:
        store, _ = self._gate_stream("path-a")
        state = store.load()
        state["status"]["blocker"] = (
            "HIGH: /home/ruichen/.local/state/yuvi-agent-bus/a/path-a/"
            "audit-worktree/packages/desktop-supervisor/src/process-windows.ts:253"
        )
        shown = render_plan(state)
        self.assertIn("packages/desktop-supervisor/src/process-windows.ts", shown)
        self.assertNotIn("audit-worktree/packages", shown)

    def test_parse_merge_review_statuses(self) -> None:
        head = "a" * 40
        for status in ("PASS", "HOLD", "HUMAN_DECISION"):
            env = parse_one(_merge_review("s1", head, status))
            self.assertEqual(env.kind, "GPT_MERGE_REVIEW")
            self.assertEqual(env.status, status)
            self.assertEqual(validate_envelope(env), [])

    def test_merge_review_unknown_status_fails_closed(self) -> None:
        env = parse_one(_merge_review("s1", "a" * 40, "ACCEPT"))
        errors = validate_envelope(env)
        self.assertTrue(any("STATUS" in item for item in errors))

    def test_stale_and_old_generation_ignored(self) -> None:
        store, head = self._gate_stream()
        other = "c" * 40
        state = store.load()
        stale = parse_one(_merge_review("mg-a", other, "PASS"))
        stale.source = "github"
        stale.source_id = "stale-merge-review"
        apply_envelope(store, state, stale, repo=self.repo, current_head=head)
        store.save(state)
        self.assertIsNone(merge_review_status(store.load()))
        state = store.load()
        current = parse_one(_merge_review("mg-a", head, "PASS"))
        current.source = "github"
        current.source_id = "current-merge-review"
        apply_envelope(store, state, current, repo=self.repo, current_head=head)
        store.save(state)
        self.assertEqual(merge_review_status(store.load()), "PASS")

    def test_product_or_delegated_alone_cannot_enable_merge(self) -> None:
        store, head = self._gate_stream()
        state = store.load()
        gate = merge_enablement(state, None)
        self.assertFalse(gate["enabled"])
        state["envelopes"]["GPT_REVIEW"] = {
            "kind": "GPT_REVIEW",
            "status": "ACCEPT",
            "head": head,
            "fields": {"REVIEWED_HEAD": head, "STATUS": "ACCEPT"},
        }
        store.save(state)
        self.assertFalse(merge_enablement(store.load(), None)["enabled"])

    def test_merge_gpt_pass_enables_and_hold_human_disable(self) -> None:
        store, head = self._gate_stream()
        self._apply(store, _merge_review("mg-a", head, "PASS"), head)
        self.assertTrue(merge_enablement(store.load(), None)["enabled"])
        self._apply(store, _merge_review("mg-a", head, "HOLD"), head)
        self.assertFalse(merge_enablement(store.load(), None)["enabled"])
        self._apply(store, _merge_review("mg-a", head, "HUMAN_DECISION"), head)
        self.assertFalse(merge_enablement(store.load(), None)["enabled"])

    def test_url_open_does_not_complete_review(self) -> None:
        store, head = self._gate_stream()
        state = store.load()
        state["merge_gpt"] = {"url": "https://chatgpt.com/c/merge", "display_name": "m", "bound_at": "t"}
        store.save(state)
        self.assertIsNone(merge_review_status(store.load()))
        self.assertNotEqual(gpt_suggestion(store.load(), None)["text"], SUGGEST_MERGE)

    def test_product_and_merge_urls_independent(self) -> None:
        store, _ = self._gate_stream()
        state = store.load()
        state["browser_gpt"] = {"url": "https://chatgpt.com/c/product"}
        state["merge_gpt"] = {"url": "https://chatgpt.com/c/merge"}
        store.save(state)
        view = stream_view(self.ctx, store)
        self.assertEqual(view["browser_gpt"]["url"], "https://chatgpt.com/c/product")
        self.assertEqual(view["merge_gpt"]["url"], "https://chatgpt.com/c/merge")

    def test_merge_card_requires_live_pr_snapshot(self) -> None:
        store, head = self._gate_stream("live-card", pr=46)
        self._apply(store, _merge_review("live-card", head, "PASS", pr=46), head)
        prstate = os.path.join(self.root, "live-card-pr.json")
        json.dump({"headRefOid": "d" * 40, "state": "OPEN", "mergeable": "MERGEABLE"}, open(prstate, "w"))
        os.environ["FAKE_GH_PR_STATE"] = prstate
        card = stream_view(self.ctx, store)["merge_review"]
        self.assertFalse(card["enabled"])
        self.assertIn("PR HEAD != expected implemented HEAD", card["disabled_reasons"])

    def test_suggestions(self) -> None:
        store, head = self._gate_stream()
        state = store.load()
        state["phase"] = IMPLEMENTING
        state["envelopes"]["CODEX_AUDIT"]["status"] = "CHANGES_REQUIRED"
        store.save(state)
        self.assertEqual(gpt_suggestion(store.load(), None)["text"], SUGGEST_HOLD)
        store, head = self._gate_stream("sg-b")
        state = store.load()
        state["phase"] = READY_FOR_GPT
        state["review_policy"] = "GPT_REQUIRED"
        state["review_authority"] = None
        store.save(state)
        self.assertEqual(gpt_suggestion(store.load(), None)["text"], SUGGEST_WAIT_PRODUCT)
        store, head = self._gate_stream("sg-c")
        self.assertEqual(gpt_suggestion(store.load(), None)["text"], SUGGEST_WAIT_MERGE)
        self._apply(store, _merge_review("sg-c", head, "PASS"), head)
        self.assertEqual(gpt_suggestion(store.load(), None)["text"], SUGGEST_MERGE)
        self._apply(store, _merge_review("sg-c", head, "HOLD"), head)
        self.assertEqual(gpt_suggestion(store.load(), None)["text"], SUGGEST_HOLD)
        self._apply(store, _merge_review("sg-c", head, "HUMAN_DECISION"), head)
        self.assertEqual(gpt_suggestion(store.load(), None)["text"], SUGGEST_HUMAN)

    def test_prompt_artifact_is_merge_role(self) -> None:
        store, head = self._gate_stream()
        text = merge_prompt_text(store.load(), None)
        self.assertIn("独立 Merge Gate GPT", text)
        self.assertIn(head, text)
        self.assertIn("不要 merge", text)
        self.assertNotIn("/home/", text)
        self.assertNotIn("Authorization", text)
        for field in ("REVIEWED_BASE:", "EVIDENCE:", "FINDINGS:", "RECOMMENDATION:", "NEXT_ACTION:"):
            self.assertIn(field, text)

    def test_local_merge_review_is_not_durable_authority(self) -> None:
        store, head = self._gate_stream("local-merge")
        state = store.load()
        local = parse_one(_merge_review("local-merge", head, "PASS"))
        apply_envelope(store, state, local, repo=self.repo, current_head=head)
        store.save(state)
        refreshed = store.load()
        self.assertIsNone(merge_review_status(refreshed))
        self.assertNotIn("GPT_MERGE_REVIEW", refreshed["envelopes"])
        self.assertFalse(merge_enablement(refreshed, None)["enabled"])

    def test_pass_and_merge_transaction(self) -> None:
        store, head = self._gate_stream("pm-a", pr=88)
        self._apply(store, _merge_review("pm-a", head, "PASS", pr=88), head)
        comments = os.path.join(self.root, "pm-comments.json")
        prstate = os.path.join(self.root, "pm-pr.json")
        json.dump([], open(comments, "w"))
        json.dump({"headRefOid": head, "state": "OPEN", "mergeable": "MERGEABLE"}, open(prstate, "w"))
        os.environ["FAKE_GH_COMMENTS"] = comments
        os.environ["FAKE_GH_PR_STATE"] = prstate
        os.environ["FAKE_GH_ALLOW_MERGE"] = "1"
        os.environ["FAKE_GH_HEAD"] = head
        first = pass_and_merge(self.ctx, store, expected_stream="pm-a", expected_head=head, expected_pr=88)
        self.assertTrue(first.get("ok"), first)
        self.assertTrue(first.get("merged"), first)
        self.assertEqual(store.load()["phase"], MERGED)
        bodies = [item.get("body") or "" for item in json.loads(open(comments).read())]
        self.assertEqual(sum("[FINAL_GATE]" in body for body in bodies), 1)
        second = pass_and_merge(self.ctx, store, expected_stream="pm-a", expected_head=head, expected_pr=88)
        self.assertTrue(second.get("already") or second.get("merged"))
        bodies = [item.get("body") or "" for item in json.loads(open(comments).read())]
        self.assertEqual(sum("[FINAL_GATE]" in body for body in bodies), 1)

    def test_head_drift_stale(self) -> None:
        store, head = self._gate_stream("dr-a")
        self._apply(store, _merge_review("dr-a", head, "PASS"), head)
        other = "d" * 40
        prstate = os.path.join(self.root, "dr-pr.json")
        json.dump({"headRefOid": other, "state": "OPEN", "mergeable": "MERGEABLE"}, open(prstate, "w"))
        os.environ["FAKE_GH_PR_STATE"] = prstate
        os.environ["FAKE_GH_ALLOW_MERGE"] = "1"
        os.environ["FAKE_GH_COMMENTS"] = os.path.join(self.root, "dr-comments.json")
        json.dump([], open(os.environ["FAKE_GH_COMMENTS"], "w"))
        result = pass_and_merge(self.ctx, store, expected_stream="dr-a", expected_head=head)
        self.assertFalse(result.get("ok"))
        self.assertEqual(result.get("code"), "FINAL_GATE_STALE")
        self.assertEqual(store.load()["phase"], FINAL_GATE)

    def test_merge_network_fail_then_retry_no_duplicate_gate(self) -> None:
        store, head = self._gate_stream("nf-a", pr=77)
        self._apply(store, _merge_review("nf-a", head, "PASS", pr=77), head)
        comments = os.path.join(self.root, "nf-comments.json")
        prstate = os.path.join(self.root, "nf-pr.json")
        json.dump([], open(comments, "w"))
        json.dump({"headRefOid": head, "state": "OPEN", "mergeable": "MERGEABLE"}, open(prstate, "w"))
        os.environ["FAKE_GH_COMMENTS"] = comments
        os.environ["FAKE_GH_PR_STATE"] = prstate
        os.environ["FAKE_GH_ALLOW_MERGE"] = "1"
        os.environ["FAKE_GH_MERGE_FAIL"] = "timeout"
        os.environ["FAKE_GH_HEAD"] = head
        failed = pass_and_merge(self.ctx, store, expected_stream="nf-a", expected_head=head, expected_pr=77)
        self.assertFalse(failed.get("ok"), failed)
        self.assertTrue(failed.get("retryable"), failed)
        self.assertEqual(store.load()["phase"], MERGE_PENDING)
        os.environ.pop("FAKE_GH_MERGE_FAIL", None)
        retried = retry_merge(self.ctx, store, expected_stream="nf-a", expected_head=head, expected_pr=77)
        self.assertTrue(retried.get("ok"), retried)
        bodies = [item.get("body") or "" for item in json.loads(open(comments).read())]
        self.assertEqual(sum("[FINAL_GATE]" in body for body in bodies), 1)

    def test_no_auto_merge_without_click(self) -> None:
        store, head = self._gate_stream("am-a")
        self._apply(store, _merge_review("am-a", head, "PASS"), head)
        self.assertEqual(store.load()["phase"], FINAL_GATE)
        self.assertNotEqual(store.load()["phase"], MERGED)

    def test_wrong_stream_or_pr_rejected(self) -> None:
        store, head = self._gate_stream("ws-a", pr=10)
        self._apply(store, _merge_review("ws-a", head, "PASS", pr=10), head)
        bad = pass_and_merge(self.ctx, store, expected_stream="other", expected_head=head, expected_pr=10)
        self.assertEqual(bad.get("code"), "STREAM_MISMATCH")
        bad_pr = pass_and_merge(self.ctx, store, expected_stream="ws-a", expected_head=head, expected_pr=99)
        self.assertEqual(bad_pr.get("code"), "PR_MISMATCH")

    def test_legacy_campaign_defaults(self) -> None:
        from agentbus.campaign import apply_campaign_defaults

        camp = apply_campaign_defaults({"campaign_id": "old"})
        self.assertEqual(camp["merge_review_mode"], "always")
        self.assertIn("url", camp["merge_gpt"])

    def test_legacy_stream_state_defaults_fail_closed(self) -> None:
        store, _ = self._gate_stream("legacy-merge")
        state = store.load()
        for key in ("merge_gpt", "merge_gpt_gate", "merge_txn", "merge_review_history"):
            state.pop(key, None)
        state.pop("merge_review_mode", None)
        store.save(state)
        refreshed = store.load()
        self.assertEqual(gpt_suggestion(refreshed, None)["text"], SUGGEST_WAIT_MERGE)
        self.assertFalse(merge_enablement(refreshed, None)["enabled"])

    def test_webui_pass_and_merge_json(self) -> None:
        store, head = self._gate_stream("web-a", pr=12)
        self._apply(store, _merge_review("web-a", head, "PASS", pr=12), head)
        comments = os.path.join(self.root, "web-comments.json")
        prstate = os.path.join(self.root, "web-pr.json")
        json.dump([], open(comments, "w"))
        json.dump({"headRefOid": head, "state": "OPEN", "mergeable": "MERGEABLE"}, open(prstate, "w"))
        os.environ["FAKE_GH_COMMENTS"] = comments
        os.environ["FAKE_GH_PR_STATE"] = prstate
        os.environ["FAKE_GH_ALLOW_MERGE"] = "1"
        os.environ["FAKE_GH_HEAD"] = head
        result = pass_and_merge(self.ctx, store, expected_stream="web-a", expected_head=head, expected_pr=12)
        self.assertTrue(result.get("ok"), result)
        self.assertIn("merge_commit", result or {"merge_commit": None})

    def test_negative_protocol(self) -> None:
        env = parse_one("[GPT_MERGE_REVIEW]\nSTATUS: PASS\nSTREAM: s1\n")
        self.assertTrue(validate_envelope(env))
        two = parse_one("[GPT_REVIEW]\nSTATUS: ACCEPT\nSTREAM: s1\nREVIEWED_HEAD: " + "a" * 40 + "\n")
        self.assertEqual(two.kind, "GPT_REVIEW")
        self.assertNotEqual(two.kind, "GPT_MERGE_REVIEW")

    def test_sha_equal_is_exact(self) -> None:
        self.assertTrue(sha_equal("abc", "abc"))
        self.assertFalse(sha_equal("abc", "abd"))
        self.assertFalse(sha_equal("abc", ""))
        self.assertFalse(sha_equal(None, "abc"))
