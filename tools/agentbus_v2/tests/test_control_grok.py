from __future__ import annotations

from dataclasses import asdict, replace
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tools.agentbus_v2.control import (
    CONTROL_OPERATION,
    ControlError,
    control_id,
    control_packet_path,
    control_result_path,
    current_control_request,
    ensure_control_request,
    parse_control_response,
    render_control_packet,
    route_work,
    set_control_config,
    submit_control_response,
)
from tools.agentbus_v2.core import (
    ActionKind,
    GptResult,
    Observation,
    SpecFact,
    decide,
    judge_job_id,
    plan_facts_digest,
    plan_job_id,
    proof_id,
    spec_id,
    work_effect_id,
)
from tools.agentbus_v2.effects import EffectResult, run_grok_work
from tools.agentbus_v2.executor_pool import (
    ExecutorPool,
    GrokExecutorAccount,
    grok_account_lock,
    worktree_execution_lock,
)
from tools.agentbus_v2.facts import FactError, PConfig, PPaths, _work_from_head
from tools.agentbus_v2.legacy_v1_browser_compat import (
    ENVELOPE_END,
    ENVELOPE_START,
    LegacyV1BrowserCompat,
    MailboxComment,
    derive_browser_delivery_id,
)
from tools.agentbus_v2.scheduler import ProjectEntry
from tools.agentbus_v2.tests.test_facts_effects import (
    RepoFixture,
    config_for,
    run,
    snapshot_for,
)
from tools.agentbus_v2.codex_guardian import GuardianResult


class ControlFixture:
    def __init__(self, root: Path) -> None:
        repo_root = root / "repo"
        repo_root.mkdir(parents=True)
        self.repo = RepoFixture(repo_root)
        self.charter = "P_ID: P-TEST\nGOAL: bounded CONTROL routing test\n"
        self.config = config_for(self.repo, self.charter)
        self.state = root / "state"
        self.paths = PPaths(self.state / self.config.p_id)
        self.paths.create_dirs()
        (self.paths.root / "charter.md").write_text(self.charter, encoding="utf-8")
        (self.paths.root / "config.json").write_text(
            json.dumps(asdict(self.config)), encoding="utf-8"
        )
        identity = snapshot_for(self.config)
        planning = plan_facts_digest(identity)
        self.plan_id = plan_job_id(identity)
        self.spec_text = "Implement one bounded mechanical change and prove it."
        self.spec = SpecFact(
            spec_id(identity.charter_digest, planning, self.spec_text),
            self.spec_text,
            plan_job_id=self.plan_id,
        )
        self.snapshot = replace(
            identity,
            specs=(self.spec,),
            gpt_results=(GptResult(self.plan_id, "PLAN_GPT", "SPEC", self.spec_text),),
        )
        self.action = decide(self.snapshot)
        if self.action.kind is not ActionKind.WORK:
            raise AssertionError(self.action)
        self.entry = ProjectEntry(self.config.p_id, enabled=True, allow_merge=False)

    def enable_control(self) -> None:
        set_control_config(
            self.state,
            conversation_url="https://chatgpt.com/c/control-test",
            update_url=True,
        )
        set_control_config(self.state, enabled=True)

    def response_file(self, job_id: str, decision: str, body: str = "bounded route") -> Path:
        path = self.state / "control-response.json"
        path.write_text(
            json.dumps({
                "job_id": job_id,
                "operation": CONTROL_OPERATION,
                "decision": decision,
                "body": body,
            }),
            encoding="utf-8",
        )
        return path


class ControlRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = ControlFixture(Path(self.temp.name))
        self.current = self.fixture.snapshot
        self.snapshot_patch = patch(
            "tools.agentbus_v2.control.read_snapshot",
            side_effect=lambda paths, allow_merge=False: self.current,
        )
        self.snapshot_patch.start()
        self.addCleanup(self.snapshot_patch.stop)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _route(self, *, entry=None):
        return route_work(
            self.fixture.state,
            self.fixture.paths,
            self.fixture.config,
            self.current,
            decide(self.current),
            entry=entry or self.fixture.entry,
        )

    def _accept(self, decision: str) -> str:
        ensured = ensure_control_request(
            self.fixture.state, self.fixture.entry, expected_action=decide(self.current)
        )
        self.assertIn("WORK awaiting CONTROL_GPT routing", ensured.detail)
        job_id = control_id(decide(self.current).effect_id or "", self.fixture.spec.spec_id)
        submit_control_response(
            self.fixture.paths,
            self.fixture.response_file(job_id, decision),
        )
        return job_id

    def test_missing_or_disabled_control_preserves_codex_dispatch(self) -> None:
        for enabled in (False, None):
            with self.subTest(enabled=enabled), patch(
                "tools.agentbus_v2.executor_pool.dispatch_work",
                return_value=EffectResult(True, "codex semantic result"),
            ) as dispatch:
                if enabled is False:
                    set_control_config(
                        self.fixture.state,
                        conversation_url="https://chatgpt.com/c/control-test",
                        update_url=True,
                    )
                result = self._route()
                self.assertTrue(result.changed)
                dispatch.assert_called_once_with(
                    self.fixture.state,
                    self.fixture.paths,
                    self.fixture.config,
                    self.current,
                    decide(self.current),
                    backend="CODEX",
                )
                dispatch.reset_mock()

    def test_enabled_current_work_creates_one_outbox_and_never_launches(self) -> None:
        self.fixture.enable_control()
        with patch("tools.agentbus_v2.executor_pool.dispatch_work") as dispatch:
            first = self._route()
            second = self._route()
        self.assertTrue(first.changed)
        self.assertFalse(second.changed)
        self.assertIn("WORK awaiting CONTROL_GPT routing", first.detail)
        self.assertEqual([], dispatch.call_args_list)
        outbox = list((self.fixture.paths.root / "control" / "outbox").glob("*.md"))
        self.assertEqual(1, len(outbox))
        expected = control_id(self.fixture.action.effect_id or "", self.fixture.spec.spec_id)
        self.assertEqual(expected, outbox[0].stem)

    def test_control_request_is_restart_stable_and_packet_is_bounded(self) -> None:
        self.fixture.enable_control()
        first = self._route()
        request = current_control_request(self.fixture.state, self.fixture.entry)
        self.assertIsNotNone(request)
        self.assertEqual(
            control_id(self.fixture.action.effect_id or "", self.fixture.spec.spec_id),
            request.control_id,
        )
        self.assertEqual(request.packet_sha256, request.packet_sha256)
        self.assertIn("CONTROL is routing only", request.packet_text)
        self.assertIn("CODEX is the ordinary default", request.packet_text)
        self.assertIn("cannot judge implementation correctness", request.packet_text)
        self.assertEqual(first.detail.split(": ", 1)[1].split(" ", 1)[0], request.control_id)

    def test_all_exact_decisions_route_only_the_same_work_effect(self) -> None:
        self.fixture.enable_control()
        for decision in ("CODEX", "GROK"):
            with self.subTest(decision=decision), patch(
                "tools.agentbus_v2.executor_pool.dispatch_work",
                return_value=EffectResult(True, decision),
            ) as dispatch:
                self._accept(decision)
                result = self._route()
                self.assertTrue(result.changed)
                self.assertEqual(decision, dispatch.call_args.kwargs["backend"])
                dispatch.reset_mock()
                control_result_path(
                    self.fixture.paths,
                    control_id(self.fixture.action.effect_id or "", self.fixture.spec.spec_id),
                ).unlink()
                control_packet_path(
                    self.fixture.paths,
                    control_id(self.fixture.action.effect_id or "", self.fixture.spec.spec_id),
                ).unlink()
        for decision, detail in (
            ("SIMPLIFY", "CONTROL_SIMPLIFY_RECOMMENDED"),
            ("WAIT", "CONTROL_WAIT"),
            ("HUMAN", "CONTROL_HUMAN"),
        ):
            with self.subTest(decision=decision), patch(
                "tools.agentbus_v2.executor_pool.dispatch_work"
            ) as dispatch:
                self._accept(decision)
                result = self._route()
                self.assertFalse(result.changed)
                self.assertIn(detail, result.detail)
                dispatch.assert_not_called()
                self.assertEqual([], list((self.fixture.paths.root / "work" / "results").glob("*.json")))
                control_result_path(
                    self.fixture.paths,
                    control_id(self.fixture.action.effect_id or "", self.fixture.spec.spec_id),
                ).unlink()
                control_packet_path(
                    self.fixture.paths,
                    control_id(self.fixture.action.effect_id or "", self.fixture.spec.spec_id),
                ).unlink()

    def test_stale_result_is_not_applicable_to_a_new_work_effect(self) -> None:
        self.fixture.enable_control()
        old_job = self._accept("CODEX")
        old_spec = self.fixture.spec
        new_spec = replace(
            old_spec,
            spec_id=spec_id(
                self.current.charter_digest,
                plan_facts_digest(self.current),
                "A different current spec.",
            ),
            text="A different current spec.",
        )
        self.current = replace(self.current, specs=(new_spec,))
        new_action = decide(self.current)
        self.assertEqual(ActionKind.WORK, new_action.kind)
        self.assertNotEqual(old_job, control_id(new_action.effect_id or "", new_spec.spec_id))
        with patch("tools.agentbus_v2.executor_pool.dispatch_work") as dispatch:
            result = self._route()
        self.assertIn("awaiting CONTROL_GPT", result.detail)
        dispatch.assert_not_called()
        self.assertTrue(control_result_path(self.fixture.paths, old_job).exists())
        self.assertTrue(
            control_packet_path(
                self.fixture.paths, control_id(new_action.effect_id or "", new_spec.spec_id)
            ).exists()
        )

    def test_tampered_control_result_and_operation_fail_closed(self) -> None:
        self.fixture.enable_control()
        ensure_control_request(self.fixture.state, self.fixture.entry)
        job_id = control_id(self.fixture.action.effect_id or "", self.fixture.spec.spec_id)
        with self.assertRaises(ControlError):
            parse_control_response(
                {"job_id": "control-" + "0" * 24, "operation": CONTROL_OPERATION,
                 "decision": "CODEX", "body": "x"},
                expected_job_id=job_id,
            )
        with self.assertRaises(ControlError):
            submit_control_response(
                self.fixture.paths,
                self.fixture.response_file("control-" + "0" * 24, "CODEX")
            )
        bad = self.fixture.state / "bad-control.json"
        bad.write_text(json.dumps({
            "job_id": job_id, "operation": "JUDGE_GPT", "decision": "CODEX", "body": "x"
        }), encoding="utf-8")
        with self.assertRaises(ControlError):
            submit_control_response(self.fixture.paths, bad)

    def test_control_binding_rejects_reserved_global_and_active_plan_urls(self) -> None:
        (self.fixture.state / "legacy_v1_browser_compat.json").write_text(
            json.dumps({
                "enabled": True,
                "conversations": {
                    "plan": "https://chatgpt.com/c/global-plan",
                    "judge": "https://chatgpt.com/c/global-judge",
                },
                "mailboxes": {"github.com/test/repo": 1},
            }),
            encoding="utf-8",
        )
        with self.assertRaises(FactError):
            set_control_config(
                self.fixture.state,
                conversation_url="https://chatgpt.com/c/global-judge",
                update_url=True,
            )
        (self.fixture.state / "projects.json").write_text(
            json.dumps({"projects": [{
                "p_id": self.fixture.config.p_id,
                "enabled": True,
                "plan_conversation_url": "https://chatgpt.com/c/dedicated-plan",
            }]}),
            encoding="utf-8",
        )
        with self.assertRaises(FactError):
            set_control_config(
                self.fixture.state,
                conversation_url="https://chatgpt.com/c/dedicated-plan",
                update_url=True,
            )

    def test_control_id_and_routes_do_not_change_semantic_identity(self) -> None:
        self.fixture.enable_control()
        before = decide(self.current)
        self.assertEqual(ActionKind.WORK, before.kind)
        with patch(
            "tools.agentbus_v2.executor_pool.dispatch_work",
            return_value=EffectResult(False, "operational"),
        ):
            self._accept("GROK")
            self._route()
        after = decide(self.current)
        self.assertEqual(before.effect_id, after.effect_id)
        self.assertEqual(before.payload, after.payload)
        self.assertEqual(
            work_effect_id(self.current, self.fixture.spec), before.effect_id
        )
        self.assertEqual(plan_job_id(self.current), self.fixture.plan_id)
        self.assertEqual(
            proof_id(self.current, self.fixture.spec),
            proof_id(self.current, self.fixture.spec),
        )
        self.assertEqual(
            judge_job_id(
                self.current,
                self.fixture.spec,
                failed_step="x",
                evidence_id="proof-" + "a" * 24,
                evidence_digest="b" * 64,
            ),
            judge_job_id(
                self.current,
                self.fixture.spec,
                failed_step="x",
                evidence_id="proof-" + "a" * 24,
                evidence_digest="b" * 64,
            ),
        )
        self.assertNotIn("control", asdict(self.current))


class ControlBrowserTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fixture = ControlFixture(self.root)
        self.fixture.config = replace(self.fixture.config, repository="github.com/test/repo")
        (self.fixture.paths.root / "config.json").write_text(
            json.dumps(asdict(self.fixture.config)), encoding="utf-8"
        )
        (self.fixture.state / "projects.json").write_text(
            json.dumps({"projects": [{"p_id": self.fixture.config.p_id, "enabled": True}]}),
            encoding="utf-8",
        )
        (self.fixture.state / "legacy_v1_browser_compat.json").write_text(
            json.dumps({
                "enabled": True,
                "conversations": {
                    "plan": "https://chatgpt.com/c/plan-control-test",
                    "judge": "https://chatgpt.com/c/judge-control-test",
                },
                "mailboxes": {"github.com/test/repo": 17},
            }),
            encoding="utf-8",
        )
        self.fixture.enable_control()
        self.current = self.fixture.snapshot
        self.control_snapshot = patch(
            "tools.agentbus_v2.control.read_snapshot",
            return_value=self.current,
        )
        self.legacy_snapshot = patch(
            "tools.agentbus_v2.legacy_v1_browser_compat.read_snapshot",
            return_value=self.current,
        )
        self.control_snapshot.start()
        self.legacy_snapshot.start()
        self.addCleanup(self.control_snapshot.stop)
        self.addCleanup(self.legacy_snapshot.stop)
        ensure_control_request(self.fixture.state, self.fixture.entry)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _compat(self, comments=()):
        return LegacyV1BrowserCompat(
            self.fixture.state,
            comment_reader=lambda repository, issue, limit: tuple(comments),
        )

    def test_control_is_signed_v1_operational_projection_with_stable_browser_alias(self) -> None:
        compat = self._compat()
        jobs = [job for job in compat.current_jobs() if job.operation == CONTROL_OPERATION]
        self.assertEqual(1, len(jobs))
        job = jobs[0]
        self.assertTrue(job.job_id.startswith("control-"))
        self.assertEqual(
            ("PRODUCT_GPT", "WORK_ROUTING"),
            (job.wire_dict()["role"], job.wire_dict()["task"]),
        )
        self.assertEqual(job.browser_delivery_id, derive_browser_delivery_id(job.job_id, job.packet_sha256))
        self.assertNotEqual(job.job_id, job.browser_delivery_id)
        self.assertIn(f"JOB_ID: {job.job_id}", job.wire_dict()["prompt"])
        self.assertIn(f"OPERATION: {CONTROL_OPERATION}", job.wire_dict()["prompt"])

    def test_duplicate_mailbox_envelopes_fail_closed_and_wrong_sha_is_ignored(self) -> None:
        compat = self._compat()
        job = [item for item in compat.current_jobs() if item.operation == CONTROL_OPERATION][0]
        raw = json.dumps({
            "job_id": job.job_id,
            "operation": CONTROL_OPERATION,
            "decision": "CODEX",
            "body": "route",
        }, separators=(",", ":"))
        body = (
            f"{ENVELOPE_START}\nJOB_ID: {job.job_id}\nOPERATION: {CONTROL_OPERATION}\n"
            f"PACKET_SHA256: {job.packet_sha256}\nRAW_RESPONSE_JSON:\n{raw}\n{ENVELOPE_END}"
        )
        duplicate = self._compat((MailboxComment("1", body), MailboxComment("2", body)))
        projected = duplicate.poll_and_project()
        self.assertIsNone(projected["jobs"][0].get("decision"))
        self.assertIn("ambiguous duplicate", str(projected["bridge"]["last_error"]))
        wrong = body.replace(job.packet_sha256, "0" * 64)
        ignored = self._compat((MailboxComment("3", wrong),))
        self.assertEqual([], ignored.poll_and_project()["bridge"]["recent_ingestion"])
        self.assertFalse(control_result_path(self.fixture.paths, job.job_id).exists())


class GrokAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.fixture = ControlFixture(Path(self.temp.name))
        self.snapshot = self.fixture.snapshot
        self.action = self.fixture.action
        self.guardian_calls: list[tuple[tuple[str, ...], dict[str, str]]] = []

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _run(self, inner, *, outer=None, guardian_code=0, mutate=None):
        outer_value = {"text": json.dumps(inner)} if outer is None else outer

        def fake_guardian(command, *, cwd, env, log_path, **kwargs):
            self.guardian_calls.append((tuple(command), dict(env)))
            if mutate is not None:
                mutate()
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text(json.dumps(outer_value), encoding="utf-8")
            return GuardianResult(guardian_code)

        with patch("tools.agentbus_v2.effects.read_snapshot", return_value=self.snapshot), patch(
            "tools.agentbus_v2.effects.run_guardian", side_effect=fake_guardian
        ):
            return run_grok_work(
                self.fixture.paths,
                self.fixture.config,
                self.snapshot,
                self.action,
                self.temp_path("grok-home"),
                model="grok-build-test",
                worktree_lock_path=self.fixture.state / "wt.lock",
                account_lock_path=self.fixture.state / "grok.lock",
            )

    def temp_path(self, name: str) -> Path:
        path = Path(self.temp.name) / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _pass_inner(self) -> dict[str, object]:
        return {
            "status": "PASS",
            "summary": "Grok completed the exact WORK.",
            "head": "placeholder",
            "evidence": ["tests"],
        }

    def _commit_exact_work(self) -> str:
        worktree = Path(self.fixture.config.worktree)
        (worktree / "grok-change.txt").write_text("implemented\n", encoding="utf-8")
        run(worktree, "git", "add", "grok-change.txt")
        message = (
            "grok exact work\n\n"
            f"AgentBus-V2-P: {self.fixture.config.p_id}\n"
            f"AgentBus-V2-Spec: {self.fixture.spec.spec_id}\n"
            f"AgentBus-V2-Work: {self.action.effect_id}\n"
            f"AgentBus-V2-Input-Head: {self.snapshot.head}\n"
            f"AgentBus-V2-Plan: {self.fixture.spec.plan_job_id}\n"
        )
        subprocess.run(
            ("git", "commit", "-m", message),
            cwd=worktree,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        return run(worktree, "git", "rev-parse", "HEAD")

    def test_grok_command_uses_verified_headless_flags_and_pass_recovery(self) -> None:
        head_holder: dict[str, str] = {}

        inner = self._pass_inner()

        def fake_guardian(command, *, cwd, env, log_path, **kwargs):
            self.guardian_calls.append((tuple(command), dict(env)))
            head = self._commit_exact_work()
            head_holder["head"] = head
            inner["head"] = head
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text(json.dumps({"sessionId": "ignored", "text": json.dumps(inner)}), encoding="utf-8")
            return GuardianResult(0)

        with patch("tools.agentbus_v2.effects.read_snapshot", return_value=self.snapshot), patch(
            "tools.agentbus_v2.effects.run_guardian", side_effect=fake_guardian
        ):
            result = run_grok_work(
                self.fixture.paths, self.fixture.config, self.snapshot, self.action,
                self.temp_path("grok-home"), model="grok-build-test",
                worktree_lock_path=self.fixture.state / "wt.lock",
                account_lock_path=self.fixture.state / "grok.lock",
            )
        self.assertTrue(result.changed)
        command, environment = self.guardian_calls[-1]
        self.assertIn("--prompt-file", command)
        self.assertIn("--always-approve", command)
        self.assertIn("--no-alt-screen", command)
        self.assertNotIn("--yolo", command)
        self.assertNotIn("--no-auto-update", command)
        self.assertEqual(str(self.temp_path("grok-home")), environment["GROK_HOME"])
        recovered = _work_from_head(self.fixture.config, head_holder["head"])
        self.assertEqual(self.action.effect_id, recovered.effect_id if recovered else None)

    def test_grok_fail_creates_only_the_existing_semantic_fail_fact(self) -> None:
        result = self._run({
            "status": "FAIL", "summary": "bounded blocker", "head": self.snapshot.head,
            "evidence": ["blocked"],
        })
        self.assertTrue(result.changed)
        work_result = json.loads(
            (self.fixture.paths.root / "work" / "results" / f"{self.action.effect_id}.json").read_text()
        )
        self.assertEqual(Observation.FAIL.value, work_result["status"])
        self.assertNotIn("executor", work_result)
        self.assertNotIn("grok", json.dumps(work_result).lower())

    def test_malformed_outer_missing_text_and_malformed_inner_are_operational_only(self) -> None:
        for outer in ({"not_text": True}, {"text": "not json"}):
            with self.subTest(outer=outer):
                result = self._run({"status": "PASS", "summary": "x", "head": "x", "evidence": []}, outer=outer)
                self.assertFalse(result.changed)
                self.assertIn("invalid Grok result", result.detail)
                self.assertFalse((self.fixture.paths.root / "work" / "results" / f"{self.action.effect_id}.json").exists())

    def test_pass_without_trailers_dirty_tree_unrelated_ref_and_fail_after_mutation_are_fenced(self) -> None:
        def generic_commit():
            worktree = Path(self.fixture.config.worktree)
            (worktree / "generic.txt").write_text("x\n", encoding="utf-8")
            run(worktree, "git", "add", "generic.txt")
            subprocess.run(("git", "commit", "-m", "generic"), cwd=worktree, check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        with self.assertRaises(FactError):
            self._run({"status": "PASS", "summary": "x", "head": "x", "evidence": []}, mutate=generic_commit)
        run(Path(self.fixture.config.worktree), "git", "reset", "--hard", self.snapshot.head)

        def dirty():
            Path(self.fixture.config.worktree, "dirty.txt").write_text("dirty\n")

        with self.assertRaises(FactError):
            self._run({"status": "FAIL", "summary": "x", "head": self.snapshot.head, "evidence": []}, mutate=dirty)
        Path(self.fixture.config.worktree, "dirty.txt").unlink(missing_ok=True)

        def unrelated_ref():
            run(Path(self.fixture.config.worktree), "git", "branch", "unrelated")

        with self.assertRaises(FactError):
            self._run({"status": "FAIL", "summary": "x", "head": self.snapshot.head, "evidence": []}, mutate=unrelated_ref)

        run(Path(self.fixture.config.worktree), "git", "branch", "-D", "unrelated")

        def mutate_fail():
            generic_commit()

        with self.assertRaises(FactError):
            self._run({"status": "FAIL", "summary": "x", "head": self.snapshot.head, "evidence": []}, mutate=mutate_fail)

    def test_grok_pool_locks_try_next_account_and_never_falls_back_to_codex(self) -> None:
        accounts = (
            GrokExecutorAccount("one", self.temp_path("one"), "grok-build"),
            GrokExecutorAccount("two", self.temp_path("two"), "grok-build-2"),
        )
        calls: list[str] = []

        def fake(*args):
            calls.append(Path(args[-1]).name)
            return EffectResult(False, "operational runtime unavailable")

        with grok_account_lock(self.fixture.state, accounts[0]) as locked:
            self.assertTrue(locked)
            result = ExecutorPool(self.fixture.state, grok_accounts=accounts).run(
                self.fixture.paths, self.fixture.config, self.snapshot, self.action,
                executor=fake, backend="GROK",
            )
        self.assertFalse(result.changed)
        self.assertEqual(["two"], calls)
        self.assertIn("Grok", result.detail)

        calls.clear()
        result = ExecutorPool(self.fixture.state, grok_accounts=()).run(
            self.fixture.paths, self.fixture.config, self.snapshot, self.action,
            executor=lambda *args: calls.append("launched") or EffectResult(True, "bad"),
            backend="GROK",
        )
        self.assertFalse(result.changed)
        self.assertEqual([], calls)
        self.assertIn("no configured Grok", result.detail)

    def test_grok_worktree_lock_busy_and_identity_drift_do_not_launch(self) -> None:
        account = GrokExecutorAccount("one", self.temp_path("one"), "grok-build")
        with worktree_execution_lock(self.fixture.state, self.fixture.config.worktree) as locked:
            self.assertTrue(locked)
            result = ExecutorPool(
                self.fixture.state, grok_accounts=(account,)
            ).run(
                self.fixture.paths, self.fixture.config, self.snapshot, self.action,
                executor=lambda *args: self.fail("Grok launched while worktree was locked"),
                backend="GROK",
            )
        self.assertFalse(result.changed)
        self.assertIn("worktree execution lock", result.detail)

        changed = replace(self.snapshot, head="f" * 40)
        with patch("tools.agentbus_v2.effects.read_snapshot", return_value=changed), patch(
            "tools.agentbus_v2.effects.run_guardian"
        ) as guardian:
            result = run_grok_work(
                self.fixture.paths, self.fixture.config, self.snapshot, self.action,
                self.temp_path("grok-home"), model="grok-build-test",
                worktree_lock_path=self.fixture.state / "wt.lock",
                account_lock_path=self.fixture.state / "grok.lock",
            )
        self.assertFalse(result.changed)
        self.assertIn("identities drifted", result.detail)
        guardian.assert_not_called()

    def test_pool_recovers_existing_semantic_fail_before_grok_launch(self) -> None:
        calls: list[str] = []
        with patch(
            "tools.agentbus_v2.executor_pool._semantic_work_state", return_value="FAIL"
        ):
            result = ExecutorPool(
                self.fixture.state,
                grok_accounts=(GrokExecutorAccount("one", self.temp_path("one"), "grok-build"),),
            ).run(
                self.fixture.paths, self.fixture.config, self.snapshot, self.action,
                executor=lambda *args: calls.append("launched") or EffectResult(True, "bad"),
                backend="GROK",
            )
        self.assertFalse(result.changed)
        self.assertEqual([], calls)
        self.assertIn("recovered WORK FAIL", result.detail)

    def test_pool_recovers_existing_semantic_work_before_grok_launch(self) -> None:
        head = self._commit_exact_work()
        self.assertIsNotNone(_work_from_head(self.fixture.config, head))
        calls: list[str] = []
        result = ExecutorPool(
            self.fixture.state,
            grok_accounts=(GrokExecutorAccount("one", self.temp_path("one"), "grok-build"),),
        ).run(
            self.fixture.paths,
            self.fixture.config,
            self.snapshot,
            self.action,
            executor=lambda *args: calls.append("launched") or EffectResult(True, "bad"),
            backend="GROK",
        )
        self.assertFalse(result.changed)
        self.assertEqual([], calls)
        self.assertIn("recovered WORK PASS", result.detail)


if __name__ == "__main__":
    unittest.main()
