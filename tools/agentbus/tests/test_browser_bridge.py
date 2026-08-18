from __future__ import annotations

import json
import os

from agentbus.browser import BrowserGPTJob, job_for_state
from agentbus.campaign import bind_explicit_campaign, empty_campaign, load_campaign, save_campaign
from agentbus.decision import FINAL_GPT, FINAL_REVIEW, PLAN_SPEC, PRODUCT_GPT
from agentbus.models import empty_state
from agentbus.settings import (
    load_settings,
    migrate_gpt_bindings,
    resolve_final_gpt_binding,
    resolve_product_gpt_binding,
    set_global_binding,
)
from agentbus.tests.harness import AgentbusTest


class BrowserBridgeTests(AgentbusTest):
    def final_ready_state(self, stream: str = "browser-final") -> dict:
        head = "a" * 40
        state = empty_state(stream)
        state["pr"] = 44
        state["phase"] = "FINAL_GATE"
        state["review_policy"] = "GPT_REQUIRED"
        state["heads"].update({"current": head, "implemented": head, "audited": head})
        state["publication"].update({"status": "pushed", "commit": head, "report_comment_id": "11"})
        state["envelopes"].update(
            {
                "CODEX_REPORT": {
                    "kind": "CODEX_REPORT",
                    "status": "READY_FOR_AUDIT",
                    "head": head,
                    "source": "github",
                    "source_id": "11",
                    "digest": "report",
                    "fields": {"STATUS": "READY_FOR_AUDIT", "STREAM": stream, "IMPLEMENTED_HEAD": head},
                },
                "CODEX_AUDIT": {
                    "kind": "CODEX_AUDIT",
                    "status": "PASS",
                    "head": head,
                    "source": "github",
                    "source_id": "12",
                    "digest": "audit",
                    "fields": {"STATUS": "PASS", "STREAM": stream, "AUDITED_HEAD": head, "FINDINGS": "none"},
                },
                "GPT_REVIEW": {
                    "kind": "GPT_REVIEW",
                    "status": "ACCEPT",
                    "head": head,
                    "source": "github",
                    "source_id": "13",
                    "digest": "product",
                    "fields": {"STATUS": "ACCEPT", "STREAM": stream, "REVIEWED_HEAD": head},
                },
            }
        )
        state["github"]["pr"] = {
            "number": 44,
            "headRefOid": head,
            "baseRefOid": "b" * 40,
            "state": "OPEN",
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [],
        }
        return state

    def test_product_binding_precedence_and_dynamic_successor_inheritance(self) -> None:
        settings = {"product_gpt": {"url": "https://chatgpt.com/c/global"}}
        campaign = empty_campaign("bind-camp")
        campaign["product_gpt"] = {"url": "https://chatgpt.com/c/campaign"}
        state = empty_state("bind-a")
        state["browser_gpt"] = {"url": "https://chatgpt.com/c/stream"}
        self.assertEqual(resolve_product_gpt_binding(state, campaign, settings)["source"], "stream")
        state["browser_gpt"] = {}
        self.assertEqual(resolve_product_gpt_binding(state, campaign, settings)["url"], "https://chatgpt.com/c/campaign")
        campaign["product_gpt"] = {}
        self.assertEqual(resolve_product_gpt_binding(state, campaign, settings)["url"], "https://chatgpt.com/c/global")

        predecessor = empty_state("bind-old")
        predecessor["browser_gpt"] = {"url": "https://chatgpt.com/c/old-override"}
        successor = empty_state("bind-next")
        campaign["product_gpt"] = {"url": "https://chatgpt.com/c/campaign"}
        inherited = resolve_product_gpt_binding(successor, campaign, settings)
        self.assertEqual(inherited["source"], "campaign")
        self.assertEqual(inherited["url"], "https://chatgpt.com/c/campaign")
        self.assertNotEqual(inherited["url"], predecessor["browser_gpt"]["url"])

    def test_unambiguous_product_and_final_legacy_binding_migration(self) -> None:
        self.create_stream("legacy-a")
        store = self.store("legacy-a")
        state = store.load()
        state["campaign_id"] = "legacy-camp"
        state["browser_gpt"] = {"url": "https://chatgpt.com/c/product-legacy", "display_name": "Product"}
        state["merge_gpt"] = {"url": "https://chatgpt.com/c/final-legacy", "display_name": "Final"}
        store.save(state)
        bind_explicit_campaign(self.ctx, state, "legacy-camp")

        migrated = migrate_gpt_bindings(self.ctx)
        campaign = load_campaign(self.ctx, "legacy-camp")
        self.assertEqual(campaign["product_gpt"]["url"], "https://chatgpt.com/c/product-legacy")
        self.assertEqual(migrated["settings"]["final_gpt"]["url"], "https://chatgpt.com/c/final-legacy")

        successor = empty_state("legacy-next")
        self.assertEqual(
            resolve_product_gpt_binding(successor, campaign, migrated["settings"])["url"],
            "https://chatgpt.com/c/product-legacy",
        )

    def test_conflicting_legacy_bindings_are_not_guessed(self) -> None:
        for sid, product, final in (
            ("conflict-a", "https://chatgpt.com/c/product-a", "https://chatgpt.com/c/final-a"),
            ("conflict-b", "https://chatgpt.com/c/product-b", "https://chatgpt.com/c/final-b"),
        ):
            self.create_stream(sid)
            store = self.store(sid)
            state = store.load()
            state["campaign_id"] = "conflict-camp"
            state["browser_gpt"] = {"url": product}
            state["merge_gpt"] = {"url": final}
            store.save(state)
            bind_explicit_campaign(self.ctx, state, "conflict-camp")
        migrated = migrate_gpt_bindings(self.ctx)
        campaign = load_campaign(self.ctx, "conflict-camp")
        self.assertIsNone(campaign["product_gpt"]["url"])
        self.assertIsNone(migrated["settings"]["final_gpt"]["url"])
        kinds = {item["kind"] for item in migrated["ambiguities"]}
        self.assertEqual(kinds, {"PRODUCT_GPT", "FINAL_GPT"})

    def test_final_binding_is_stream_override_then_global_not_legacy_merge_gpt(self) -> None:
        settings = {"final_gpt": {"url": "https://chatgpt.com/c/global-final"}}
        state = empty_state("final-bind")
        state["merge_gpt"] = {"url": "https://chatgpt.com/c/legacy-per-stream"}
        self.assertEqual(resolve_final_gpt_binding(state, settings)["url"], "https://chatgpt.com/c/global-final")
        state["final_gpt"] = {"url": "https://chatgpt.com/c/explicit-final"}
        self.assertEqual(resolve_final_gpt_binding(state, settings)["url"], "https://chatgpt.com/c/explicit-final")

    def test_generic_product_and_final_jobs_are_stable_and_self_contained(self) -> None:
        set_global_binding(self.ctx, "PRODUCT_GPT", url="https://chatgpt.com/c/product")
        set_global_binding(self.ctx, "FINAL_GPT", url="https://chatgpt.com/c/final")

        product_state = empty_state("product-job")
        product = job_for_state(self.ctx, product_state)
        self.assertIsInstance(product, BrowserGPTJob)
        self.assertEqual((product.role, product.task), (PRODUCT_GPT, PLAN_SPEC))

        final_state = self.final_ready_state()
        final = job_for_state(self.ctx, final_state)
        again = job_for_state(self.ctx, final_state)
        self.assertIsInstance(final, BrowserGPTJob)
        self.assertEqual((final.role, final.task), (FINAL_GPT, FINAL_REVIEW))
        self.assertEqual(final.job_id, again.job_id)
        self.assertEqual(final.generation, again.generation)
        for needle in (
            "ROLE: FINAL_GPT",
            "JOB_ID:",
            "CAMPAIGN:",
            "STREAM:",
            "PR: 44",
            "EXPECTED_HEAD:",
            "EXPECTED_BASE:",
            "durable cross-agent authority",
            "Old conversation context is non-authoritative",
            "Do not modify code",
            "Do not merge from ChatGPT",
            "STATUS: PASS | REPAIR | WAIT | HUMAN",
        ):
            self.assertIn(needle, final.prompt)

        final_state["github"]["pr"]["statusCheckRollup"] = [
            {"name": "required", "status": "COMPLETED", "conclusion": "FAILURE"}
        ]
        changed = job_for_state(self.ctx, final_state)
        self.assertIsNotNone(changed)
        self.assertNotEqual(changed.job_id, final.job_id)
        self.assertNotEqual(changed.generation, final.generation)

    def test_p7_product_review_job_uses_inherited_campaign_binding(self) -> None:
        state = self.final_ready_state("p7-8c")
        state["envelopes"].pop("GPT_REVIEW")
        campaign = empty_campaign("p7")
        campaign["product_gpt"] = {"url": "https://chatgpt.com/c/p7-product"}
        job = job_for_state(self.ctx, state, campaign=campaign)
        self.assertIsNotNone(job)
        self.assertEqual((job.role, job.task), ("PRODUCT_GPT", "PRODUCT_REVIEW"))
        self.assertEqual(job.conversation_url, "https://chatgpt.com/c/p7-product")
        self.assertIn("[GPT_REVIEW]", job.prompt)

    def test_only_current_merged_unit_requests_continuation_plan(self) -> None:
        set_global_binding(self.ctx, "PRODUCT_GPT", url="https://chatgpt.com/c/product")
        campaign = empty_campaign("history")
        campaign["current_stream"] = "history-new"
        campaign["units"] = [
            {"stream_id": "history-old", "status": "MERGED"},
            {"stream_id": "history-new", "status": "MERGED"},
        ]
        save_campaign(self.ctx, campaign)
        for stream in ("history-old", "history-new"):
            self.create_stream(stream)
            store = self.store(stream)
            state = store.load()
            state["campaign_id"] = "history"
            state["phase"] = "MERGED"
            state["heads"]["merged"] = state["heads"]["current"]
            store.save(state)
        self.assertIsNone(job_for_state(self.ctx, self.store("history-old").load()))
        current = job_for_state(self.ctx, self.store("history-new").load())
        self.assertIsNotNone(current)
        self.assertEqual(current.task, "PLAN_CONTINUATION")

    def test_extension_has_bounded_permissions_and_no_focus_or_answer_scraping(self) -> None:
        root = os.path.join(os.path.dirname(__file__), "..", "browser_extension")
        with open(os.path.join(root, "manifest.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
        self.assertEqual(
            set(manifest["permissions"]),
            {"storage", "tabs", "https://chatgpt.com/*", "http://127.0.0.1:6738/*"},
        )
        sources = []
        for name in ("background.js", "content.js"):
            with open(os.path.join(root, name), encoding="utf-8") as handle:
                sources.append(handle.read())
        js = "\n".join(sources)
        for forbidden in (
            "tabs.update",
            "windows.update",
            "active: true",
            "focused: true",
            "xdotool",
            "ydotool",
            "window.focus",
            "assistant-response",
            "copyAnswer",
            "extractAnswer",
        ):
            self.assertNotIn(forbidden, js)
        self.assertIn("active: false", js)
        self.assertIn("WAITING_FOR_GITHUB", js)
        self.assertIn("fetch(JOBS_URL", js)
        self.assertNotIn('method: "POST"', js)

    def test_display_sanitizer_preserves_urls(self) -> None:
        from agentbus.display import sanitize_display_text

        url = "https://github.com/example/repo/blob/main/packages/core/src/x.ts"
        self.assertEqual(sanitize_display_text(url), url)
        leaked = "/home/u/.local/state/audit-worktree/packages/core/src/x.ts:7"
        self.assertEqual(sanitize_display_text(leaked), "packages/core/src/x.ts:7")
        arbitrary = "/state/streams/p4/audit-worktree/src/process.ts:9"
        self.assertEqual(sanitize_display_text(arbitrary), "src/process.ts:9")
        root = "/state/streams/p4/audit-worktree"
        self.assertEqual(
            sanitize_display_text(f"finding: {root}/lib/x.py", roots=(root,)),
            "finding: lib/x.py",
        )
