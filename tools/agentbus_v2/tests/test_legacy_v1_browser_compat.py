from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import GPT_PACKET_SCHEMA, Snapshot
from tools.agentbus_v2.core import Action, ActionKind
from tools.agentbus_v2.effects import EffectResult
from tools.agentbus_v2.block_diagnosis import (
    derive_operational_block,
    render_block_packet,
    set_block_config,
)
from tools.agentbus_v2.legacy_v1_browser_compat import (
    ENVELOPE_END,
    ENVELOPE_START,
    LegacyV1BrowserCompat,
    MailboxComment,
    load_compat_config,
    parse_transport_envelope,
    derive_browser_delivery_id,
)
from tools.agentbus_v2.effects import GPT_PACKET_BUDGET_BYTES


SHA = "1" * 40
PLAN_JOB = "plan-" + "a" * 24
JUDGE_JOB = "judge-" + "b" * 24
REPOSITORY = "github.com/test/repo"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def packet_text(job_id: str, operation: str) -> str:
    return (
        "# packet\n## SEMANTIC INPUTS\n```json\n"
        + json.dumps(
            {
                "packet_schema": GPT_PACKET_SCHEMA,
                "job_id": job_id,
                "operation": operation,
                "semantic_input": {"job_id": job_id, "operation": operation},
            },
            separators=(",", ":"),
        )
        + "\n```\n"
    )


def envelope(job_id: str, operation: str, digest: str, raw: str) -> str:
    return (
        f"{ENVELOPE_START}\n"
        f"JOB_ID: {job_id}\n"
        f"OPERATION: {operation}\n"
        f"PACKET_SHA256: {digest}\n"
        "RAW_RESPONSE_JSON:\n"
        f"{raw}\n"
        f"{ENVELOPE_END}"
    )


class LegacyV1BrowserCompatTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.worktree = self.root / "worktree"
        self.worktree.mkdir(parents=True)
        write_json(
            self.state / "P1" / "config.json",
            {
                "p_id": "P1",
                "worktree": str(self.worktree),
                "repository": REPOSITORY,
                "remote": "origin",
                "branch": "agentbus/p1",
                "base_ref": "main",
                "seed_head": SHA,
                "charter_digest": "c" * 64,
                "proof_commands": [],
                "required_ci_checks": [],
            },
        )
        write_json(
            self.state / "projects.json",
            {"projects": [{
                "p_id": "P1", "enabled": True, "allow_merge": False,
                "global_plan_fallback": True,
            }]},
        )
        write_json(
            self.state / "legacy_v1_browser_compat.json",
            {
                "enabled": True,
                "conversations": {
                    "plan": "https://chatgpt.com/c/plan-test",
                    "judge": "https://chatgpt.com/c/judge-test",
                },
                "mailboxes": {REPOSITORY: 17},
            },
        )
        self.snapshot = Snapshot(
            p_id="P1",
            charter_digest="c" * 64,
            expected_repository=REPOSITORY,
            expected_branch="agentbus/p1",
            base_ref="main",
            head=SHA,
            base=SHA,
            gpt_pending=frozenset({PLAN_JOB}),
        )
        self.comments: tuple[MailboxComment, ...] = ()
        self.reader_calls: list[tuple[str, int, int]] = []

        def reader(repository: str, issue: int, limit: int):
            self.reader_calls.append((repository, issue, limit))
            return self.comments

        self.compat = LegacyV1BrowserCompat(
            self.state, comment_reader=reader, clock=lambda: 1000.0
        )
        self.snapshot_patch = patch(
            "tools.agentbus_v2.legacy_v1_browser_compat.read_snapshot",
            side_effect=self._snapshot,
        )
        self.snapshot_patch.start()
        self.addCleanup(self.snapshot_patch.stop)
        self._write_packet(PLAN_JOB, "PLAN_GPT")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _snapshot(self, paths, *, allow_merge: bool = False):
        pending = self.snapshot.gpt_pending
        for job_id in tuple(pending):
            if (paths.root / "gpt" / "results" / f"{job_id}.json").exists():
                pending = frozenset()
        return replace(self.snapshot, gpt_pending=pending, allow_merge=allow_merge)

    def _write_packet(self, job_id: str, operation: str) -> Path:
        path = self.state / "P1" / "gpt" / "outbox" / f"{job_id}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(packet_text(job_id, operation), encoding="utf-8")
        return path

    def _valid_response(self, job_id: str = PLAN_JOB, operation: str = "PLAN_GPT") -> str:
        return json.dumps(
            {
                "job_id": job_id,
                "operation": operation,
                "decision": "SPEC" if operation == "PLAN_GPT" else "RETURN_PROVE",
                "body": "bounded result",
            },
            separators=(",", ":"),
        )

    def test_plan_wire_shape_is_exact_legacy_projection(self) -> None:
        payload = self.compat.poll_and_project()
        self.assertEqual(1, len(payload["jobs"]))
        job = payload["jobs"][0]
        self.assertEqual(
            {
                "job_id", "role", "task", "conversation_url", "campaign",
                "stream", "pr", "expected_head", "expected_base", "generation", "prompt",
                "semantic_job_id", "browser_delivery_id",
            },
            set(job),
        )
        self.assertEqual(PLAN_JOB, job["semantic_job_id"])
        self.assertEqual(job["job_id"], job["browser_delivery_id"])
        self.assertNotEqual(PLAN_JOB, job["job_id"])
        self.assertEqual("PRODUCT_GPT", job["role"])
        self.assertEqual("PLAN_SPEC", job["task"])
        self.assertIn(packet_text(PLAN_JOB, "PLAN_GPT").rstrip(), job["prompt"])
        self.assertIn("RAW_RESPONSE_JSON", job["prompt"])
        self.assertIn(f"JOB_ID: {PLAN_JOB}", job["prompt"])
        self.assertIn(f"BROWSER_DELIVERY_ID: {job['job_id']}", job["prompt"])
        self.assertLessEqual(len(job["prompt"].encode("utf-8")), GPT_PACKET_BUDGET_BYTES)
        self.assertNotIn("campaign state", job["prompt"].lower())

    def test_oversized_packet_is_fail_closed_before_browser_projection(self) -> None:
        packet_path = self.state / "P1" / "gpt" / "outbox" / f"{PLAN_JOB}.md"
        packet_path.write_text(packet_path.read_text(encoding="utf-8") + ("\nlarge evidence\n" * 30_000), encoding="utf-8")
        self.assertEqual((), self.compat.current_jobs())
        status = self.compat.status()
        self.assertEqual([], status["jobs"])
        self.assertEqual(1, len(status["packet_errors"]))
        error = status["packet_errors"][0]
        self.assertEqual(PLAN_JOB, error["job_id"])
        self.assertEqual("GPT_PACKET_OVERSIZE", error["code"])
        self.assertGreater(error["rendered_packet_bytes"], error["packet_budget_bytes"])

    def test_judge_projection_uses_final_transport_role_only(self) -> None:
        self._write_packet(JUDGE_JOB, "JUDGE_GPT")
        self.snapshot = replace(self.snapshot, gpt_pending=frozenset({JUDGE_JOB}))
        payload = self.compat.poll_and_project()
        job = payload["jobs"][0]
        self.assertEqual(("FINAL_GPT", "FINAL_REVIEW"), (job["role"], job["task"]))
        self.assertEqual("https://chatgpt.com/c/judge-test", job["conversation_url"])

    def test_block_packet_uses_same_wire_and_strict_ingestion_path(self) -> None:
        work_id = "work-" + "c" * 24
        action = Action(ActionKind.WORK, effect_id=work_id)
        observation = derive_operational_block(
            "P1", action, EffectResult(False, "Codex exceeded the executor timeout")
        )
        set_block_config(
            self.state,
            conversation_url="https://chatgpt.com/c/block-test",
            update_url=True,
        )
        set_block_config(self.state, enabled=True)
        packet = render_block_packet(self.snapshot, action, observation)
        path = self.state / "P1" / "block" / "outbox" / f"{observation.block_id}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(packet, encoding="utf-8")
        with patch(
            "tools.agentbus_v2.legacy_v1_browser_compat.read_snapshot",
            return_value=replace(self.snapshot, gpt_pending=frozenset()),
        ), patch(
            "tools.agentbus_v2.block_diagnosis.read_snapshot",
            return_value=replace(self.snapshot, gpt_pending=frozenset()),
        ), patch(
            "tools.agentbus_v2.block_diagnosis.decide",
            return_value=action,
        ):
            jobs = self.compat.current_jobs()
            self.assertEqual(1, len(jobs))
            job = jobs[0]
            self.assertEqual("BLOCK_GPT", job.operation)
            self.assertEqual("FINAL_GPT", job.wire_dict()["role"])
            raw = json.dumps({
                "block_id": observation.block_id,
                "operation": "BLOCK_GPT",
                "decision": "WAIT",
                "reason": "observe again",
                "recovery_instruction": None,
                "expected_postcondition": None,
                "human_action": None,
            }, separators=(",", ":"))
            self.comments = (MailboxComment("99", envelope(
                observation.block_id, "BLOCK_GPT", job.packet_sha256, raw
            )),)
            payload = self.compat.poll_and_project()
        self.assertEqual([], payload["jobs"])
        result = self.state / "P1" / "block" / "results" / f"{observation.block_id}.json"
        self.assertTrue(result.exists())
        self.assertEqual("WAIT", json.loads(result.read_text())["decision"])

    def test_only_enabled_exact_current_pending_is_projected(self) -> None:
        self.snapshot = replace(self.snapshot, gpt_pending=frozenset())
        self.assertEqual([], self.compat.poll_and_project()["jobs"])
        self.snapshot = replace(self.snapshot, gpt_pending=frozenset({PLAN_JOB}))
        write_json(
            self.state / "projects.json",
            {"projects": [{"p_id": "P1", "enabled": False, "allow_merge": False}]},
        )
        self.assertEqual([], self.compat.poll_and_project()["jobs"])

    def test_result_present_job_disappears_and_stale_outbox_is_not_authority(self) -> None:
        write_json(
            self.state / "P1" / "gpt" / "results" / f"{PLAN_JOB}.json",
            json.loads(self._valid_response()),
        )
        self.assertTrue((self.state / "P1" / "gpt" / "outbox" / f"{PLAN_JOB}.md").exists())
        self.assertEqual([], self.compat.poll_and_project()["jobs"])

    def test_duplicate_poll_and_restart_reconstruct_same_identity(self) -> None:
        first = self.compat.poll_and_project()["jobs"]
        second = self.compat.poll_and_project()["jobs"]
        restarted = LegacyV1BrowserCompat(
            self.state, comment_reader=lambda *_: (), clock=lambda: 1000.0
        ).poll_and_project()["jobs"]
        self.assertEqual(first, second)
        self.assertEqual(first, restarted)
        self.assertNotEqual(PLAN_JOB, first[0]["job_id"])
        self.assertEqual(PLAN_JOB, first[0]["semantic_job_id"])
        self.assertEqual(
            derive_browser_delivery_id(PLAN_JOB, self.compat.current_jobs()[0].packet_sha256),
            first[0]["job_id"],
        )

    def test_delivery_id_binds_semantic_job_and_packet_digest_only(self) -> None:
        job = self.compat.current_jobs()[0]
        same = derive_browser_delivery_id(job.job_id, job.packet_sha256)
        changed = derive_browser_delivery_id(job.job_id, "f" * 64)
        other_job = derive_browser_delivery_id("plan-" + "c" * 24, job.packet_sha256)
        self.assertEqual(job.browser_delivery_id, same)
        self.assertNotEqual(same, changed)
        self.assertNotEqual(same, other_job)
        self.assertEqual(job.job_id, PLAN_JOB)

    def test_delivery_id_has_no_mailbox_or_semantic_authority(self) -> None:
        job = self.compat.current_jobs()[0]
        body = envelope(job.job_id, job.operation, job.packet_sha256, self._valid_response())
        self.comments = (MailboxComment("1", body),)
        payload = self.compat.poll_and_project()
        self.assertEqual([], payload["jobs"])
        result = self.state / "P1" / "gpt" / "results" / f"{PLAN_JOB}.json"
        self.assertTrue(result.exists())
        self.assertEqual(PLAN_JOB, json.loads(result.read_text())["job_id"])

    def test_exact_mailbox_payload_traverses_strict_ingestion_then_disappears(self) -> None:
        job = self.compat.current_jobs()[0]
        self.comments = (
            MailboxComment(
                "1",
                envelope(job.job_id, job.operation, job.packet_sha256, self._valid_response()),
            ),
        )
        result_path = self.state / "P1" / "gpt" / "results" / f"{PLAN_JOB}.json"
        with patch(
            "tools.agentbus_v2.legacy_v1_browser_compat.submit_gpt_response",
            wraps=__import__("tools.agentbus_v2.effects", fromlist=["submit_gpt_response"]).submit_gpt_response,
        ) as submit:
            payload = self.compat.poll_and_project()
        submit.assert_called_once()
        self.assertTrue(result_path.exists())
        self.assertEqual([], payload["jobs"])
        stored = json.loads(result_path.read_text(encoding="utf-8"))
        self.assertEqual("SPEC", stored["decision"])
        self.assertTrue(payload["bridge"]["recent_ingestion"][0]["changed"])

    def test_wrong_identity_comments_are_ignored(self) -> None:
        job = self.compat.current_jobs()[0]
        cases = (
            envelope("plan-" + "f" * 24, job.operation, job.packet_sha256, self._valid_response()),
            envelope(job.job_id, "JUDGE_GPT", job.packet_sha256, self._valid_response()),
            envelope(job.job_id, job.operation, "0" * 64, self._valid_response()),
        )
        for index, body in enumerate(cases):
            with self.subTest(index=index):
                self.comments = (MailboxComment(str(index), body),)
                self.assertEqual(1, len(self.compat.poll_and_project()["jobs"]))
                self.assertFalse(
                    (self.state / "P1" / "gpt" / "results" / f"{PLAN_JOB}.json").exists()
                )

    def test_stale_mailbox_comment_cannot_resurrect_absent_job(self) -> None:
        job = self.compat.current_jobs()[0]
        self.comments = (
            MailboxComment(
                "1", envelope(job.job_id, job.operation, job.packet_sha256, self._valid_response())
            ),
        )
        self.snapshot = replace(self.snapshot, gpt_pending=frozenset())
        self.assertEqual([], self.compat.poll_and_project()["jobs"])
        self.assertFalse(
            (self.state / "P1" / "gpt" / "results" / f"{PLAN_JOB}.json").exists()
        )

    def test_malformed_result_is_rejected_by_strict_ingestion(self) -> None:
        job = self.compat.current_jobs()[0]
        self.comments = (
            MailboxComment("1", envelope(job.job_id, job.operation, job.packet_sha256, "{bad")),
        )
        payload = self.compat.poll_and_project()
        self.assertEqual(1, len(payload["jobs"]))
        self.assertIn("invalid JSON fact", payload["bridge"]["last_error"])
        self.assertFalse(
            (self.state / "P1" / "gpt" / "results" / f"{PLAN_JOB}.json").exists()
        )

    def test_ambiguous_duplicate_exact_results_fail_closed(self) -> None:
        job = self.compat.current_jobs()[0]
        body = envelope(job.job_id, job.operation, job.packet_sha256, self._valid_response())
        self.comments = (MailboxComment("1", body), MailboxComment("2", body))
        payload = self.compat.poll_and_project()
        self.assertEqual(1, len(payload["jobs"]))
        self.assertIn("ambiguous duplicate", payload["bridge"]["last_error"])
        self.assertFalse(
            (self.state / "P1" / "gpt" / "results" / f"{PLAN_JOB}.json").exists()
        )

    def test_comment_itself_never_becomes_snapshot_authority(self) -> None:
        job = self.compat.current_jobs()[0]
        invalid = json.dumps(
            {
                "job_id": job.job_id,
                "operation": job.operation,
                "decision": "PASS",
                "body": "a mailbox comment cannot choose an invalid PLAN result",
            },
            separators=(",", ":"),
        )
        self.comments = (
            MailboxComment(
                "1",
                envelope(
                    job.job_id,
                    job.operation,
                    job.packet_sha256,
                    invalid,
                ),
            ),
        )
        payload = self.compat.poll_and_project()
        self.assertEqual(1, len(payload["jobs"]))
        self.assertIn("decision is not allowed", payload["bridge"]["last_error"])
        self.assertFalse(
            (self.state / "P1" / "gpt" / "results" / f"{PLAN_JOB}.json").exists()
        )

    def test_stale_extension_local_records_have_no_server_input(self) -> None:
        # The wire request has no client scheduler body or v1 state import;
        # absent v2 pending facts therefore cannot be resurrected by a stale
        # browser.storage.local record.
        self.snapshot = replace(self.snapshot, gpt_pending=frozenset())
        payload = self.compat.poll_and_project()
        self.assertEqual([], payload["jobs"])
        self.assertNotIn("jobs", load_compat_config(self.state).__dict__)

    def test_status_is_ephemeral_operational_projection(self) -> None:
        before = self.compat.status()
        self.assertEqual("OFFLINE", before["legacy_v1_extension"])
        self.assertEqual("waiting-browser", before["plan"]["state"])
        self.assertFalse(before["plan"]["served_to_extension"])
        self.compat.poll_and_project()
        after = self.compat.status()
        self.assertEqual("ONLINE", after["legacy_v1_extension"])
        self.assertEqual("SIGNED_V1_EXTENSION_COMPAT", after["transport_mode"])
        self.assertEqual("waiting-browser", after["plan"]["state"])
        self.assertTrue(after["plan"]["served_to_extension"])
        self.assertEqual(1, len(after["jobs"]))
        self.assertTrue(after["jobs"][0]["served_to_extension"])
        self.assertEqual(PLAN_JOB, after["jobs"][0]["semantic_job_id"])
        self.assertEqual(
            derive_browser_delivery_id(PLAN_JOB, self.compat.current_jobs()[0].packet_sha256),
            after["jobs"][0]["browser_delivery_id"],
        )
        self.assertIsNotNone(after["jobs"][0]["first_server_serve"])
        self.assertIsNotNone(after["jobs"][0]["last_server_serve"])
        self.assertEqual([], after["recent_ingestion"])
        self.assertFalse((self.state / "browser_state.json").exists())
        self.assertFalse((self.state / "scheduler_recovery.json").exists())

    def test_server_serve_and_mailbox_availability_never_claim_submission(self) -> None:
        self.assertEqual("waiting-browser", self.compat.status()["plan"]["state"])
        self.assertEqual("configured", self.compat.status()["mailbox"])
        self.compat.poll_and_project()
        status = self.compat.status()
        self.assertEqual("waiting-browser", status["plan"]["state"])
        self.assertTrue(status["plan"]["served_to_extension"])
        self.assertNotIn("waiting-mailbox", {status["plan"]["state"]})
        self.assertFalse((self.state / "P1" / "gpt" / "results" / f"{PLAN_JOB}.json").exists())

    @unittest.skipUnless(shutil.which("node"), "node is required for signed-extension fixture")
    def test_signed_extension_done_tombstone_blocks_same_job_reappearance(self) -> None:
        """Document the installed signed-v1 extension's local DONE fence.

        This is intentionally a read-only fixture: the extension source is not
        changed and browser.storage.local is not touched.  It proves that an
        exact job can be served, marked submitted, disappear, and later
        reappear without being selected again by the existing client.
        """
        extension = Path(__file__).parents[2] / "agentbus" / "browser_extension" / "background.js"
        fixture = self.root / "signed_extension_tombstone_fixture.cjs"
        fixture.write_text(textwrap.dedent(f"""
            const fs = require("fs");
            const vm = require("vm");
            const source = fs.readFileSync({json.dumps(str(extension))}, "utf8");
            const sandboxModule = {{exports: {{}}}};
            const context = {{module: sandboxModule, exports: sandboxModule.exports, console, setInterval: () => {{}}}};
            vm.runInNewContext(source, context, {{filename: {json.dumps(str(extension))}}});
            const extension = sandboxModule.exports;
            const job = {{
              job_id: "{PLAN_JOB}", role: "PRODUCT_GPT", task: "PLAN_SPEC",
              conversation_url: "https://chatgpt.com/c/plan-test", prompt: "packet"
            }};
            let serverJobs = [job];
            let sendCount = 0;
            const storage = {{jobs: {{}}, lastSubmitAt: 0, bridgeStatus: "ONLINE"}};
            context.browser = {{
              storage: {{local: {{
                get: async () => ({{...storage}}),
                set: async (value) => Object.assign(storage, value)
              }}}},
              tabs: {{
                query: async () => [{{id: 1, url: job.conversation_url, status: "complete"}}],
                get: async () => ({{id: 1, url: job.conversation_url, status: "complete"}}),
                sendMessage: async () => {{ sendCount += 1; return {{code: "SUBMITTED_CONFIRMED", evidence: {{}}}}; }},
                create: async () => ({{id: 1, url: job.conversation_url, status: "complete"}})
              }}
            }};
            context.fetch = async () => ({{ok: true, json: async () => ({{jobs: serverJobs}})}});
            (async () => {{
              await extension.tick();
              serverJobs = [];
              await extension.tick();
              if (storage.jobs["{PLAN_JOB}"].state !== "DONE") throw new Error("missing DONE tombstone");
              serverJobs = [job];
              await extension.tick();
              if (sendCount !== 1) throw new Error("same job was unexpectedly requeued");
              console.log("signed-v1 tombstone reproduction PASS");
            }})().catch(error => {{ console.error(error); process.exitCode = 1; }});
        """), encoding="utf-8")
        completed = subprocess.run(
            ["node", str(fixture)], capture_output=True, text=True, timeout=10, check=False
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertIn("signed-v1 tombstone reproduction PASS", completed.stdout)

    @unittest.skipUnless(shutil.which("node"), "node is required for signed-extension fixture")
    def test_fresh_delivery_id_requeues_same_semantic_job_after_tombstone(self) -> None:
        """An unmodified extension queues a new delivery alias after DONE."""
        extension = Path(__file__).parents[2] / "agentbus" / "browser_extension" / "background.js"
        fixture = self.root / "signed_extension_delivery_fixture.cjs"
        semantic = PLAN_JOB
        old_delivery = "browser-delivery-old-aaaaaaaaaaaaaaaa"
        new_delivery = "browser-delivery-new-bbbbbbbbbbbbbbbb"
        fixture.write_text(textwrap.dedent(f"""
            const fs = require("fs");
            const vm = require("vm");
            const source = fs.readFileSync({json.dumps(str(extension))}, "utf8");
            const sandboxModule = {{exports: {{}}}};
            const context = {{module: sandboxModule, exports: sandboxModule.exports, console, setInterval: () => {{}}}};
            vm.runInNewContext(source, context, {{filename: {json.dumps(str(extension))}}});
            const extension = sandboxModule.exports;
            const makeJob = (delivery) => ({{
              job_id: delivery, semantic_job_id: "{semantic}", role: "PRODUCT_GPT",
              task: "PLAN_SPEC", conversation_url: "https://chatgpt.com/c/plan-test",
              prompt: "JOB_ID: {semantic}\\nBROWSER_DELIVERY_ID: " + delivery
            }});
            let serverJobs = [makeJob("{old_delivery}")];
            let sendCount = 0;
            const storage = {{jobs: {{}}, lastSubmitAt: 0, bridgeStatus: "ONLINE"}};
            context.browser = {{
              storage: {{local: {{
                get: async () => ({{...storage}}),
                set: async (value) => Object.assign(storage, value)
              }}}},
              tabs: {{
                query: async () => [{{id: 1, url: "https://chatgpt.com/c/plan-test", status: "complete"}}],
                get: async () => ({{id: 1, url: "https://chatgpt.com/c/plan-test", status: "complete"}}),
                sendMessage: async (tab, message) => {{
                  if (!message.prompt.includes(message.job_id)) throw new Error("delivery id absent from prompt");
                  sendCount += 1; return {{code: "SUBMITTED_CONFIRMED", evidence: {{}}}};
                }},
                create: async () => ({{id: 1, url: "https://chatgpt.com/c/plan-test", status: "complete"}})
              }}
            }};
            context.fetch = async () => ({{ok: true, json: async () => ({{jobs: serverJobs}})}});
            (async () => {{
              await extension.tick();
              serverJobs = [];
              await extension.tick();
              if (storage.jobs["{old_delivery}"].state !== "DONE") throw new Error("missing old DONE tombstone");
              storage.lastSubmitAt = 0;
              serverJobs = [makeJob("{new_delivery}")];
              await extension.tick();
              if (sendCount !== 2) throw new Error("fresh delivery was not submitted once");
              await extension.tick();
              if (sendCount !== 2) throw new Error("delivery rotated or duplicated");
              console.log("fresh delivery tombstone recovery PASS");
            }})().catch(error => {{ console.error(error); process.exitCode = 1; }});
        """), encoding="utf-8")
        completed = subprocess.run(
            ["node", str(fixture)], capture_output=True, text=True, timeout=10, check=False
        )
        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertIn("fresh delivery tombstone recovery PASS", completed.stdout)

    def test_parser_rejects_outside_text_and_multiple_envelopes(self) -> None:
        job = self.compat.current_jobs()[0]
        body = envelope(job.job_id, job.operation, job.packet_sha256, self._valid_response())
        parsed = parse_transport_envelope(body)
        self.assertEqual(self._valid_response(), parsed.raw_response_json)
        with self.assertRaisesRegex(Exception, "out-of-envelope"):
            parse_transport_envelope("prose\n" + body)
        with self.assertRaisesRegex(Exception, "exactly one"):
            parse_transport_envelope(body + "\n" + body)

    def test_parser_accepts_exact_same_line_raw_json_without_rewriting_it(self) -> None:
        job = self.compat.current_jobs()[0]
        raw = self._valid_response()
        body = envelope(job.job_id, job.operation, job.packet_sha256, raw).replace(
            "RAW_RESPONSE_JSON:\n", "RAW_RESPONSE_JSON: ", 1
        )
        parsed = parse_transport_envelope(body)
        self.assertEqual(raw, parsed.raw_response_json)
        with self.assertRaisesRegex(Exception, "exact transport delimiter"):
            parse_transport_envelope(body.replace("RAW_RESPONSE_JSON: ", "RAW_RESPONSE_JSON:  ", 1))


if __name__ == "__main__":
    unittest.main()
