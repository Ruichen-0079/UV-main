from __future__ import annotations

import json
import os

from agentbus.apply import apply_envelope
from agentbus.attention import classify_attention
from agentbus.authority import current_generation_authority
from agentbus.generation import complete_owned_publication
from agentbus.campaign import load_campaign
from agentbus.machine import IMPLEMENTING, READY_FOR_AUDIT
from agentbus.protocol import Envelope, parse_one
from agentbus.publish import (
    apply_published_report,
    audit_is_durable,
    ensure_durable_audit,
    ensure_durable_report,
    parse_claimed_paths,
    report_is_durable,
)
from agentbus.runner import role_should_work
from agentbus.scope import (
    attach_scope,
    extract_explicit_paths,
    materialize_path_scope,
    scope_of,
    validate_files_against_scope,
)
from agentbus.store import StreamStore
from agentbus.tests.harness import AgentbusTest
from agentbus.tests.test_campaign import continuation_text
from agentbus.transport import ensure_durable_pr_transport
from agentbus.util import atomic_write_text
from agentbus.worktree import discard_rejected_scope_attempt


P7_SCOPE = """
- `packages/providers/src/types/common.ts` and `packages/providers/src/registry.ts`: preserve axes.
- `apps/server/src/routes/providers.ts`: config-only vs live.
- `apps/server/src/routes/health.ts`: zero-I/O health.
- Provider/server focused tests: cover projections.
- `packages/providers/README.md` and narrowly related diagnostics documentation.
"""

P7_FILES = [
    "apps/server/src/routes/health.ts",
    "apps/server/src/routes/providers.ts",
    "apps/server/src/server.test.ts",
    "docs/providers.md",
    "docs/providers.zh-CN.md",
    "packages/providers/README.md",
    "packages/providers/src/registry.test.ts",
    "packages/providers/src/registry.ts",
    "packages/providers/src/types/common.ts",
]

P6_SCOPE = """
Production:
- `apps/web/src/main-page.tsx`
- `apps/web/src/user-settings-client.ts`
- `apps/web/src/user-settings-state.ts`
- NEW `apps/web/src/proactive-consent.ts` for the narrow projection.

Tests:
- NEW `apps/web/src/proactive-consent.test.ts`
- `apps/web/src/user-settings-state.test.ts` only if needed.
"""

P6_FILES = [
    "apps/web/src/main-page.tsx",
    "apps/web/src/user-settings-client.ts",
    "apps/web/src/user-settings-state.ts",
    "apps/web/src/proactive-consent.test.ts",
    "apps/web/src/proactive-consent.ts",
]


class ScopeTests(AgentbusTest):
    def test_backticks_and_multi_path_bullets(self) -> None:
        found = extract_explicit_paths(P7_SCOPE)
        self.assertIn("packages/providers/src/types/common.ts", found)
        self.assertIn("packages/providers/src/registry.ts", found)
        self.assertIn("apps/server/src/routes/providers.ts", found)
        self.assertIn("apps/server/src/routes/health.ts", found)
        self.assertIn("packages/providers/README.md", found)
        self.assertNotIn("apps/**", found)
        self.assertNotIn("Initial/non-Tauri/load-failure", extract_explicit_paths(P6_SCOPE))

    def test_p7_nine_file_fixture_passes(self) -> None:
        scope = materialize_path_scope(raw_scope=P7_SCOPE, source="continuation:5325684376")
        self.assertEqual(scope["source"], "continuation:5325684376")
        check = validate_files_against_scope(P7_FILES, scope)
        self.assertTrue(check["ok"], check)
        self.assertFalse(any(item.startswith("apps/**") or item.startswith("packages/**") for item in scope["allowed_patterns"]))

    def test_unrelated_file_still_blocks(self) -> None:
        scope = materialize_path_scope(raw_scope=P7_SCOPE, source="continuation:5325684376")
        check = validate_files_against_scope(P7_FILES + ["apps/desktop/src-tauri/src/main.rs"], scope)
        self.assertFalse(check["ok"])
        self.assertIn("apps/desktop/src-tauri/src/main.rs", check["unexpected"])
        self.assertIn("authorized_exact", check["reason"])

    def test_p6_five_file_fixture_passes(self) -> None:
        scope = materialize_path_scope(raw_scope=P6_SCOPE, source="continuation:5325673540")
        check = validate_files_against_scope(P6_FILES, scope)
        self.assertTrue(check["ok"], check)

    def test_empty_materialization_is_error(self) -> None:
        scope = materialize_path_scope(raw_scope="do the remaining diagnostics work", source="continuation:1")
        check = validate_files_against_scope(["apps/foo.ts"], scope)
        self.assertFalse(check["ok"])
        self.assertEqual(check.get("error"), "SCOPE_MATERIALIZATION_ERROR")

    def test_numbered_path_scope_preserves_every_declared_path(self) -> None:
        scope = materialize_path_scope(
            raw_scope="",
            path_scope_field="Maximum ten paths:\n1. `one.ts`\n2. `two.ts`\n3. `three.ts`",
            source="spec",
        )

        self.assertEqual(scope["explicit_paths"], ["one.ts", "two.ts", "three.ts"])

    def test_scope_refreshes_when_latest_durable_spec_changes_scope(self) -> None:
        self.create_stream("scope-refresh")
        store = self.store("scope-refresh")
        state = store.load()
        state["scope"] = materialize_path_scope(
            raw_scope="only `apps/web/src/main-page.tsx`",
            source="continuation:old",
        )
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "source_id": "5337586902",
            "status": "ACTIONABLE",
            "fields": {
                "STATUS": "ACTIONABLE",
                "SOURCE_CONTINUATION_COMMENT_ID": "5337586902",
                "SCOPE": "Production: `apps/web/src/main-page.tsx` and helper `apps/web/src/proactive-turn-execution.ts`.",
                "PATH_SCOPE": "EXACT:\n- apps/web/src/main-page.tsx\n- apps/web/src/proactive-turn-execution.ts",
            },
        }

        refreshed = scope_of(state)

        self.assertEqual(refreshed["source"], "continuation:5337586902")
        self.assertIn("apps/web/src/proactive-turn-execution.ts", refreshed["explicit_paths"])
        self.assertEqual(state["scope"]["source"], "continuation:5337586902")

    def test_coder_scope_rejection_discards_only_managed_unpublished_attempt(self) -> None:
        self.create_stream("scope-discard", "--create-worktree")
        store = self.store("scope-discard")
        state = store.load()
        worktree = state["impl_worktree"]
        baseline = self.git("rev-parse", "HEAD", cwd=worktree)
        atomic_write_text(os.path.join(worktree, "README.md"), "generated attempt\n")
        atomic_write_text(os.path.join(worktree, "unapproved.ts"), "generated\n")
        state["phase"] = IMPLEMENTING
        state["heads"]["current"] = baseline
        state["scope"] = {"raw": "only `README.md`", "explicit_paths": ["README.md"], "allowed_patterns": []}
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "status": "ACTIONABLE",
            "fields": {"STATUS": "ACTIONABLE", "SCOPE": "only `README.md`"},
        }
        state["publication"] = {
            "status": "failed",
            "baseline_head": baseline,
            "commit": None,
            "reason": "scope fence rejected files\nunexpected:\n- unapproved.ts\nauthorized_exact:\n- README.md",
        }
        state["created_worktrees"]["impl"] = True
        store.save(state)
        runtime = store.load_runtime()
        runtime["impl"] = {"clean_at_start": True, "pid": None, "start_token": None}
        store.save_runtime(runtime)

        result = discard_rejected_scope_attempt(store, state, runtime_role=runtime["impl"])

        self.assertTrue(result["recovered"], result)
        self.assertEqual(self.git("status", "--porcelain", cwd=worktree), "")
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=worktree), baseline)
        with open(store.events_path, encoding="utf-8") as handle:
            self.assertTrue(any("scope-attempt-discarded" in line for line in handle))

    def test_successor_keeps_explicit_paths_and_source(self) -> None:
        self.create_stream("sc-a", "--pr", "40")
        store = self.store("sc-a")
        state = store.load()
        state["campaign_id"] = "scc"
        sha = self.git("rev-parse", "HEAD")
        state["phase"] = "FINAL_GATE"
        state["heads"]["merged"] = sha
        store.save(state)
        from agentbus.apply import mark_pr_merged

        mark_pr_merged(state, store, merge_sha=sha)
        store.save(state)
        text = continuation_text(campaign="scc", after="sc-a", nxt="sc-b", scope=P7_SCOPE)
        text = text.replace("5325684376", "")  # keep comment via apply source_id
        env = parse_one(text)
        env.source_id = "5325684376"
        state = store.load()
        apply_envelope(store, state, env, repo=self.repo, current_head=sha)
        store.save(state)
        self.assertTrue(StreamStore(self.ctx, "sc-b").exists(), load_campaign(self.ctx, "scc"))
        nxt = self.store("sc-b").load()
        scope = nxt.get("scope") or {}
        self.assertIn("packages/providers/src/types/common.ts", scope.get("explicit_paths") or [])
        self.assertTrue(str(scope.get("source") or "").endswith("5325684376"))
        spec = ((nxt.get("envelopes") or {}).get("GPT_SPEC") or {}).get("fields") or {}
        self.assertIn("PATH_SCOPE", spec)
        check = validate_files_against_scope(P7_FILES, scope)
        self.assertTrue(check["ok"], check)

    def test_semantic_changed_files_not_claimed_paths(self) -> None:
        raw = "- Provider readiness/observation lifecycle and tests\n- Config-only verification\n"
        self.assertEqual(parse_claimed_paths(raw, self.repo), [])

    def test_durable_report_exact_once_and_audit_gate(self) -> None:
        self.create_stream("rep-a", "--pr", "41", "--create-worktree")
        store = self.store("rep-a")
        state = store.load()
        head = self.git("rev-parse", "HEAD")
        comments = os.path.join(self.root, "rep-comments.json")
        with open(comments, "w", encoding="utf-8") as handle:
            json.dump([], handle)
        os.environ["FAKE_GH_COMMENTS"] = comments
        raw = f"""[CODEX_REPORT]

STATUS: READY_FOR_AUDIT

STREAM: rep-a

IMPLEMENTED_HEAD: {head}

CHANGED_FILES:
- README.md

NEXT_ACTION: AUDIT
"""
        state["envelopes"]["CODEX_REPORT"] = {
            "kind": "CODEX_REPORT",
            "status": "READY_FOR_AUDIT",
            "head": head,
            "raw": raw,
            "source": "agentbus-publish",
            "fields": {"IMPLEMENTED_HEAD": head, "STATUS": "READY_FOR_AUDIT", "STREAM": "rep-a"},
        }
        state["heads"]["implemented"] = head
        state["phase"] = READY_FOR_AUDIT
        store.save(state)
        self.assertFalse(report_is_durable(state))
        self.assertEqual(current_generation_authority(state), "CODEX_REPORT:PUBLICATION_PENDING")
        self.assertFalse(role_should_work(state, "audit"))
        first = ensure_durable_report(self.ctx, store, state)
        store.save(state)
        self.assertTrue(first.get("ok"), first)
        self.assertTrue(report_is_durable(state))
        second = ensure_durable_report(self.ctx, store, state)
        self.assertTrue(second.get("already"))
        with open(comments, encoding="utf-8") as handle:
            data = json.load(handle)
        reports = [item for item in data if "[CODEX_REPORT]" in (item.get("body") or "")]
        self.assertEqual(len(reports), 1)
        self.assertTrue(role_should_work(store.load(), "audit"))

    def test_durable_audit_is_exact_once(self) -> None:
        self.create_stream("audit-pub", "--pr", "42")
        store = self.store("audit-pub")
        state = store.load()
        head = self.git("rev-parse", "HEAD")
        comments = os.path.join(self.root, "audit-comments.json")
        with open(comments, "w", encoding="utf-8") as handle:
            json.dump([], handle)
        os.environ["FAKE_GH_COMMENTS"] = comments
        raw = (
            "[CODEX_AUDIT]\n\nSTATUS: PASS\n\nSTREAM: audit-pub\n\n"
            f"AUDITED_HEAD: {head}\n\nFINDINGS: none\n\nNEXT_ACTION: READY_FOR_GPT\n"
        )
        state["heads"].update({"current": head, "implemented": head, "audited": head})
        state["envelopes"]["CODEX_AUDIT"] = {
            "kind": "CODEX_AUDIT",
            "status": "PASS",
            "head": head,
            "raw": raw,
            "source": "local",
            "fields": {"STATUS": "PASS", "STREAM": "audit-pub", "AUDITED_HEAD": head},
        }
        self.assertFalse(audit_is_durable(state))
        first = ensure_durable_audit(self.ctx, store, state)
        self.assertTrue(first.get("ok"), first)
        second = ensure_durable_audit(self.ctx, store, state)
        self.assertTrue(second.get("already"), second)
        self.assertTrue(audit_is_durable(state))
        with open(comments, encoding="utf-8") as handle:
            rows = json.load(handle)
        self.assertEqual(sum("[CODEX_AUDIT]" in (row.get("body") or "") for row in rows), 1)

    def test_old_publication_comment_id_cannot_authorize_new_artifact(self) -> None:
        state = {"pr": 42, "publication": {"audit_comment_id": "old", "audit_comment_digest": "old"}}
        state["envelopes"] = {
            "CODEX_AUDIT": {
                "status": "PASS",
                "raw": "[CODEX_AUDIT]",
                "digest": "new",
                "source": "local",
            }
        }
        self.assertFalse(audit_is_durable(state))

    def test_pr_after_impl_retains_normalized_scope(self) -> None:
        self.create_stream("late-pr", "--create-worktree")
        store = self.store("late-pr")
        state = store.load()
        work = state["impl_worktree"]
        self.git("checkout", "-B", "agentbus/late-pr", cwd=work)
        base = self.git("rev-parse", "HEAD", cwd=work)
        self.commit_file("packages/providers/src/registry.ts", "export {}\n", "impl", cwd=work)
        head = self.git("rev-parse", "HEAD", cwd=work)
        state["pr"] = None
        state["branch"] = "agentbus/late-pr"
        state["phase"] = READY_FOR_AUDIT
        state["heads"]["spec_base"] = base
        state["heads"]["current"] = head
        state["heads"]["implemented"] = head
        state["publication"] = {"status": "pushed", "commit": head, "files": ["packages/providers/src/registry.ts"]}
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "fields": {
                "SCOPE": P7_SCOPE,
                "SOURCE_CONTINUATION_COMMENT_ID": "5325684376",
            },
        }
        attach_scope(state, materialize_path_scope(raw_scope=P7_SCOPE, source="continuation:5325684376"))
        before = list((state.get("scope") or {}).get("explicit_paths") or [])
        store.save(state)
        result = ensure_durable_pr_transport(self.ctx, store, state)
        store.save(state)
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(state.get("pr") or result.get("pr"), 99)
        scope = state.get("scope") or {}
        self.assertEqual(scope.get("source"), "continuation:5325684376")
        self.assertEqual(scope.get("explicit_paths"), before)
        self.assertIn("packages/providers/src/registry.ts", scope.get("explicit_paths") or [])
        self.assertFalse(any(item.startswith("apps/**") or item.startswith("packages/**") for item in scope.get("allowed_patterns") or []))

    def test_publication_failure_is_pending_and_agentbus(self) -> None:
        self.create_stream("pub-fail", "--pr", "41")
        store = self.store("pub-fail")
        state = store.load()
        head = self.git("rev-parse", "HEAD")
        os.environ["FAKE_GH_MODE"] = "down"
        state["envelopes"]["CODEX_REPORT"] = {
            "kind": "CODEX_REPORT",
            "status": "READY_FOR_AUDIT",
            "head": head,
            "raw": f"[CODEX_REPORT]\n\nSTATUS: READY_FOR_AUDIT\n\nSTREAM: pub-fail\n\nIMPLEMENTED_HEAD: {head}\n\nNEXT_ACTION: AUDIT\n",
            "source": "agentbus-publish",
            "fields": {"IMPLEMENTED_HEAD": head, "STATUS": "READY_FOR_AUDIT", "STREAM": "pub-fail"},
        }
        state["heads"]["implemented"] = head
        state["phase"] = READY_FOR_AUDIT
        store.save(state)
        failed = ensure_durable_report(self.ctx, store, state)
        self.assertFalse(failed.get("ok"), failed)
        self.assertFalse(report_is_durable(state))
        self.assertEqual(current_generation_authority(state), "CODEX_REPORT:PUBLICATION_PENDING")
        att = classify_attention(state)
        self.assertEqual(att["attention_owner"], "AGENTBUS")
        self.assertFalse(role_should_work(state, "audit"))

    def test_scope_rematerialize_does_not_burn_repair(self) -> None:
        self.create_stream("scope-repair")
        store = self.store("scope-repair")
        state = store.load()
        state["repair_cycles"] = 0
        state["status"]["blocker"] = "unexpected changed files: " + ", ".join(P7_FILES)
        state["publication"] = {"files": P7_FILES, "commit": "1" * 40, "status": "pushed"}
        state["envelopes"]["GPT_SPEC"] = {
            "kind": "GPT_SPEC",
            "fields": {"SCOPE": P7_SCOPE, "SOURCE_CONTINUATION_COMMENT_ID": "5325684376"},
        }
        store.save(state)
        state = store.load()
        scope_of(state)
        check = validate_files_against_scope(P7_FILES, state.get("scope"))
        self.assertTrue(check["ok"], check)
        if check.get("ok") and str((state.get("status") or {}).get("blocker") or "").startswith("unexpected changed files"):
            state["status"]["blocker"] = None
        store.save(state)
        self.assertIsNone(store.load()["status"]["blocker"])
        self.assertEqual(store.load()["repair_cycles"], 0)

    def test_apply_published_report_keeps_validation(self) -> None:
        self.create_stream("keep-val", "--create-worktree")
        store = self.store("keep-val")
        state = store.load()
        work = state["impl_worktree"]
        self.git("checkout", "-B", "agentbus/keep-val", cwd=work)
        head = self.commit_file("packages/providers/src/registry.ts", "export {}\n", "impl", cwd=work)
        state["impl_worktree"] = work
        state["phase"] = IMPLEMENTING
        state["transport"] = {"continuation_comment_id": "5325684376"}
        complete_owned_publication(state, commit=head, parent=self.git("rev-parse", "HEAD~1", cwd=work))
        env = Envelope(
            kind="CODEX_REPORT",
            fields={
                "STATUS": "READY_FOR_AUDIT",
                "STREAM": "keep-val",
                "IMPLEMENTED_HEAD": head,
                "CHANGED_FILES": "- Provider readiness/observation lifecycle and tests",
                "VALIDATION": "- Provider suite: 297 passed",
                "DEVIATIONS": "None",
                "KNOWN_RISKS": "sandbox listen EPERM",
            },
        )
        published = apply_published_report(
            store,
            state,
            commit=head,
            files=["packages/providers/src/registry.ts"],
            worktree=work,
            envelope=env,
        )
        rec = ((state.get("envelopes") or {}).get("CODEX_REPORT") or {})
        fields = rec.get("fields") or {}
        raw = rec.get("raw") or ""
        self.assertIn("297 passed", fields.get("VALIDATION") or "")
        self.assertEqual(fields.get("DEVIATIONS"), "None")
        self.assertIn("297 passed", raw)
        self.assertIn("DEVIATIONS:", raw)
        self.assertEqual(fields.get("SOURCE_CONTINUATION_COMMENT_ID"), "5325684376")
        self.assertIn("packages/providers/src/registry.ts", fields.get("CHANGED_FILES") or "")
        self.assertEqual(published.fields.get("VALIDATION"), "- Provider suite: 297 passed")
