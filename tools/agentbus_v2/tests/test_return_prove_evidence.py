"""RETURN_PROVE must not rematerialize unchanged proof evidence."""

from __future__ import annotations

from dataclasses import asdict, fields, replace
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import (
    Action,
    ActionKind,
    Observation,
    Snapshot,
    WorkFact,
    decide,
    judge_job_id,
    proof_id,
    work_effect_id,
)
from tools.agentbus_v2.effects import (
    PROVE_UNCHANGED_DETAIL,
    EffectResult,
    _prior_proof_seen_by_return_prove,
    dispatch_manual_gpt,
    run_prove,
    submit_gpt_response,
)
from tools.agentbus_v2.facts import (
    PPaths,
    _proof_commands,
    load_config,
    read_snapshot,
    sha256_text,
)
from tools.agentbus_v2.github import CheckFact, GitHubFacts
from tools.agentbus_v2.scheduler import ProjectEntry
from tools.agentbus_v2.tests.test_control_supervisor import SupervisorFixture
from tools.agentbus_v2.tests.test_facts_effects import RepoFixture, config_for, run
from tools.agentbus_v2.webui import _human_status


def _commit_work(repo: RepoFixture, config, snapshot, work) -> None:
    spec = snapshot.specs[-1]
    (repo.work / "README.md").write_text("implemented\n", encoding="utf-8")
    run(repo.work, "git", "add", "README.md")
    run(
        repo.work,
        "git",
        "commit",
        "-m",
        "work\n\n"
        f"AgentBus-V2-P: {config.p_id}\n"
        f"AgentBus-V2-Spec: {spec.spec_id}\n"
        f"AgentBus-V2-Work: {work.effect_id}\n"
        f"AgentBus-V2-Input-Head: {snapshot.head}\n"
        f"AgentBus-V2-Plan: {spec.plan_job_id}\n",
    )


def _plan_and_work(root: Path, charter: str, *, config=None):
    repo = RepoFixture(root)
    config = config or config_for(repo, charter)
    paths = PPaths(root / "state" / config.p_id)
    paths.create_dirs()
    (paths.root / "charter.md").write_text(charter, encoding="utf-8")
    (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")
    initial = read_snapshot(paths)
    plan = decide(initial)
    dispatch_manual_gpt(paths, config, initial, plan)
    response = root / "plan.json"
    response.write_text(json.dumps({
        "job_id": plan.effect_id,
        "operation": "PLAN_GPT",
        "decision": "SPEC",
        "body": "Implement once, then follow RETURN_PROVE exactly.",
    }), encoding="utf-8")
    submit_gpt_response(paths, response)
    before = read_snapshot(paths)
    work = decide(before)
    _commit_work(repo, config, before, work)
    return repo, config, paths, load_config(paths)


def _submit_return_prove(root: Path, paths, config, snapshot, judge, *, decision="RETURN_PROVE"):
    dispatch_manual_gpt(paths, config, snapshot, judge)
    response = root / f"{decision}-{judge.effect_id}.json"
    response.write_text(json.dumps({
        "job_id": judge.effect_id,
        "operation": "JUDGE_GPT",
        "decision": decision,
        "body": f"{decision} for the current proof.",
    }), encoding="utf-8")
    submit_gpt_response(paths, response)
    return judge.effect_id


def _failing_ci(config, snapshot, spec, *, run_id="20", log="Windows workflow failed"):
    merge = GitHubFacts(
        pr_number=20,
        state="OPEN",
        draft=False,
        mergeable=True,
        head_sha=snapshot.head,
        live_base=snapshot.base,
        pr_base_sha=snapshot.base,
        head_branch=config.branch,
        base_branch=config.base_ref,
        p_id=config.p_id,
        spec_id=spec.spec_id,
        owner_token=config.owner_token,
        check_status="FAIL",
    )
    check = CheckFact(
        name="validate (windows-latest)",
        state="FAILURE",
        bucket="fail",
        workflow="validate",
        link=f"https://github.com/acme/repo/actions/runs/{run_id}/job/1",
        run_id=run_id,
        head_sha=snapshot.head,
        synthetic_merge_sha="c" * 40,
        synthetic_parents=(snapshot.base, snapshot.head),
        pr_head_sha=snapshot.head,
        pr_base_sha=snapshot.base,
        current_integration=True,
    )
    observed = replace(
        merge,
        check_status="FAIL",
        checks=(check,),
        failed_ci_logs=((run_id, log),),
    )
    return merge, observed


class ReturnProveEvidenceTests(unittest.TestCase):
    def test_same_fail_evidence_does_not_write_a_new_proof(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, config = _plan_and_work(
                root, "P_ID: P-TEST\nGOAL: unchanged RETURN_PROVE evidence\n"
            )
            (repo.work / "untracked-proof-failure.txt").write_text("fail\n", encoding="utf-8")
            current = read_snapshot(paths)
            first = decide(current)
            self.assertTrue(run_prove(paths, config, current, first).changed)
            failed = read_snapshot(paths)
            judge = decide(failed)
            self.assertEqual(ActionKind.JUDGE, judge.kind)
            _submit_return_prove(root, paths, config, failed, judge)
            retried = read_snapshot(paths)
            second = decide(retried)
            self.assertEqual(ActionKind.PROVE, second.kind)
            self.assertNotEqual(first.effect_id, second.effect_id)
            result = run_prove(paths, config, retried, second)
            self.assertFalse(result.changed)
            self.assertEqual(PROVE_UNCHANGED_DETAIL, result.detail)
            self.assertFalse(
                (paths.root / "prove" / "results" / f"{second.effect_id}.json").exists()
            )
            self.assertEqual(ActionKind.PROVE, decide(read_snapshot(paths)).kind)
            self.assertEqual(second.effect_id, decide(read_snapshot(paths)).effect_id)

    def test_repeated_ticks_do_not_create_proof_or_judge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, config = _plan_and_work(
                root, "P_ID: P-TEST\nGOAL: repeated unchanged ticks\n"
            )
            (repo.work / "untracked-proof-failure.txt").write_text("fail\n", encoding="utf-8")
            current = read_snapshot(paths)
            first = decide(current)
            run_prove(paths, config, current, first)
            failed = read_snapshot(paths)
            judge = decide(failed)
            _submit_return_prove(root, paths, config, failed, judge)
            outbox_before = list((paths.root / "gpt" / "outbox").glob("judge-*.md"))
            for _ in range(3):
                live = read_snapshot(paths)
                action = decide(live)
                self.assertEqual(ActionKind.PROVE, action.kind)
                self.assertFalse(run_prove(paths, config, live, action).changed)
            live = read_snapshot(paths)
            self.assertEqual(1, len(live.proof_facts))
            self.assertEqual(ActionKind.PROVE, decide(live).kind)
            self.assertEqual(outbox_before, list((paths.root / "gpt" / "outbox").glob("judge-*.md")))
            self.assertFalse(any(
                path.name.startswith("judge-") and path.stem != judge.effect_id
                for path in (paths.root / "gpt" / "results").glob("judge-*.json")
            ))

    def test_new_proof_id_from_trigger_only_is_still_deduped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, config = _plan_and_work(
                root, "P_ID: P-TEST\nGOAL: trigger-only proof id change\n"
            )
            (repo.work / "untracked-proof-failure.txt").write_text("fail\n", encoding="utf-8")
            current = read_snapshot(paths)
            first = decide(current)
            run_prove(paths, config, current, first)
            failed = read_snapshot(paths)
            judge = decide(failed)
            _submit_return_prove(root, paths, config, failed, judge)
            retried = read_snapshot(paths)
            second = decide(retried)
            expected = proof_id(retried, retried.specs[-1], trigger_judge_id=judge.effect_id)
            self.assertEqual(expected, second.effect_id)
            self.assertNotEqual(first.effect_id, second.effect_id)
            self.assertFalse(run_prove(paths, config, retried, second).changed)

    def test_changed_evidence_digest_materializes_a_new_proof(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, config = _plan_and_work(
                root, "P_ID: P-TEST\nGOAL: changed evidence digest\n"
            )
            (repo.work / "untracked-proof-failure.txt").write_text("fail\n", encoding="utf-8")
            current = read_snapshot(paths)
            first = decide(current)
            run_prove(paths, config, current, first)
            failed = read_snapshot(paths)
            judge = decide(failed)
            _submit_return_prove(root, paths, config, failed, judge)
            (repo.work / "second-untracked.txt").write_text("other failure\n", encoding="utf-8")
            retried = read_snapshot(paths)
            second = decide(retried)
            result = run_prove(paths, config, retried, second)
            self.assertTrue(result.changed)
            self.assertTrue(
                (paths.root / "prove" / "results" / f"{second.effect_id}.json").exists()
            )
            live = read_snapshot(paths)
            self.assertEqual(2, len(live.proof_facts))
            self.assertEqual(ActionKind.JUDGE, decide(live).kind)
            self.assertNotEqual(judge.effect_id, decide(live).effect_id)

    def test_fail_to_pass_materializes_a_new_proof(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, config = _plan_and_work(
                root, "P_ID: P-TEST\nGOAL: fail then pass\n"
            )
            marker = repo.work / "untracked-proof-failure.txt"
            marker.write_text("fail\n", encoding="utf-8")
            current = read_snapshot(paths)
            first = decide(current)
            run_prove(paths, config, current, first)
            failed = read_snapshot(paths)
            judge = decide(failed)
            _submit_return_prove(root, paths, config, failed, judge)
            marker.unlink()
            retried = read_snapshot(paths)
            second = decide(retried)
            merge = GitHubFacts(
                pr_number=7, state="OPEN", draft=False, mergeable=True,
                head_sha=retried.head, live_base=retried.base, pr_base_sha=retried.base,
                head_branch=config.branch, base_branch=config.base_ref,
                p_id=config.p_id, spec_id=retried.specs[-1].spec_id,
                owner_token=config.owner_token,
            )
            with (
                patch("tools.agentbus_v2.effects.ensure_owned_pr", return_value=True),
                patch("tools.agentbus_v2.effects.read_github_facts", return_value=merge),
            ):
                result = run_prove(paths, config, retried, second)
            self.assertTrue(result.changed)
            saved = json.loads(
                (paths.root / "prove" / "results" / f"{second.effect_id}.json").read_text()
            )
            self.assertEqual("PASS", saved["status"])
            with patch("tools.agentbus_v2.github.read_github_facts", return_value=GitHubFacts()):
                self.assertEqual(ActionKind.JUDGE, decide(read_snapshot(paths)).kind)

    def test_one_shot_external_marker_fail_then_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / "compat-judge-prove-once.marker"
            script = root / "once.py"
            script.write_text(
                "from pathlib import Path\n"
                "import sys\n"
                "p = Path(sys.argv[1])\n"
                "if p.exists():\n"
                "    raise SystemExit(0)\n"
                "p.write_text('once\\n')\n"
                "raise SystemExit(1)\n",
                encoding="utf-8",
            )
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: one-shot external marker\n"
            config = replace(
                config_for(repo, charter),
                proof_commands=((sys.executable, str(script), str(marker)),),
            )
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")
            initial = read_snapshot(paths)
            plan = decide(initial)
            dispatch_manual_gpt(paths, config, initial, plan)
            (root / "plan.json").write_text(json.dumps({
                "job_id": plan.effect_id,
                "operation": "PLAN_GPT",
                "decision": "SPEC",
                "body": "Create the one-shot marker during the first proof.",
            }), encoding="utf-8")
            submit_gpt_response(paths, root / "plan.json")
            before = read_snapshot(paths)
            work = decide(before)
            _commit_work(repo, config, before, work)
            current = read_snapshot(paths)
            first = decide(current)
            self.assertTrue(run_prove(paths, config, current, first).changed)
            self.assertTrue(marker.exists())
            failed = read_snapshot(paths)
            self.assertEqual("FAIL", failed.proof_facts[-1].status.value)
            judge = decide(failed)
            _submit_return_prove(root, paths, config, failed, judge)
            retried = read_snapshot(paths)
            second = decide(retried)
            merge = GitHubFacts(
                pr_number=7, state="OPEN", draft=False, mergeable=True,
                head_sha=retried.head, live_base=retried.base, pr_base_sha=retried.base,
                head_branch=config.branch, base_branch=config.base_ref,
                p_id=config.p_id, spec_id=retried.specs[-1].spec_id,
                owner_token=config.owner_token,
            )
            with (
                patch("tools.agentbus_v2.effects.ensure_owned_pr", return_value=True),
                patch("tools.agentbus_v2.effects.read_github_facts", return_value=merge),
            ):
                result = run_prove(paths, config, retried, second)
            self.assertTrue(result.changed)
            saved = json.loads(
                (paths.root / "prove" / "results" / f"{second.effect_id}.json").read_text()
            )
            self.assertEqual("PASS", saved["status"])
            with patch("tools.agentbus_v2.github.read_github_facts", return_value=GitHubFacts()):
                self.assertEqual(ActionKind.JUDGE, decide(read_snapshot(paths)).kind)

    def test_unrelated_return_prove_cannot_suppress(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, config = _plan_and_work(
                root, "P_ID: P-TEST\nGOAL: unrelated judge\n"
            )
            (repo.work / "untracked-proof-failure.txt").write_text("fail\n", encoding="utf-8")
            current = read_snapshot(paths)
            first = decide(current)
            run_prove(paths, config, current, first)
            failed = read_snapshot(paths)
            judge = decide(failed)
            _submit_return_prove(root, paths, config, failed, judge)
            retried = read_snapshot(paths)
            second = decide(retried)
            packet = paths.root / "gpt" / "outbox" / f"{judge.effect_id}.md"
            text = packet.read_text(encoding="utf-8")
            packet.write_text(text.replace(failed.specs[-1].spec_id, "spec-" + "b" * 24), encoding="utf-8")
            prior = _prior_proof_seen_by_return_prove(
                paths, config, retried, retried.specs[-1], second,
            )
            self.assertIsNone(prior)
            with patch("tools.agentbus_v2.effects.read_snapshot", return_value=retried):
                result = run_prove(paths, config, retried, second)
            self.assertTrue(result.changed)
            self.assertTrue(
                (paths.root / "prove" / "results" / f"{second.effect_id}.json").exists()
            )

    def test_return_work_plan_and_pass_cannot_dedupe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, config = _plan_and_work(
                root, "P_ID: P-TEST\nGOAL: non RETURN_PROVE judges\n"
            )
            (repo.work / "untracked-proof-failure.txt").write_text("fail\n", encoding="utf-8")
            current = read_snapshot(paths)
            first = decide(current)
            run_prove(paths, config, current, first)
            failed = read_snapshot(paths)
            judge = decide(failed)
            for decision in ("RETURN_WORK", "RETURN_PLAN", "PASS"):
                with self.subTest(decision=decision):
                    _submit_return_prove(root, paths, config, failed, judge, decision=decision)
                    live = read_snapshot(paths)
                    action = Action(
                        ActionKind.PROVE,
                        effect_id=first.effect_id,
                        payload=dict(first.payload, trigger_judge_id=judge.effect_id),
                    )
                    self.assertIsNone(
                        _prior_proof_seen_by_return_prove(
                            paths, config, live, live.specs[-1], action,
                        )
                    )
                    (paths.root / "gpt" / "results" / f"{judge.effect_id}.json").unlink()

    def test_missing_or_corrupt_trigger_packet_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, config = _plan_and_work(
                root, "P_ID: P-TEST\nGOAL: corrupt trigger packet\n"
            )
            (repo.work / "untracked-proof-failure.txt").write_text("fail\n", encoding="utf-8")
            current = read_snapshot(paths)
            first = decide(current)
            run_prove(paths, config, current, first)
            failed = read_snapshot(paths)
            judge = decide(failed)
            _submit_return_prove(root, paths, config, failed, judge)
            retried = read_snapshot(paths)
            second = decide(retried)
            packet = paths.root / "gpt" / "outbox" / f"{judge.effect_id}.md"
            packet.write_text("not a semantic packet\n", encoding="utf-8")
            self.assertIsNone(
                _prior_proof_seen_by_return_prove(
                    paths, config, retried, retried.specs[-1], second,
                )
            )
            packet.unlink()
            self.assertIsNone(
                _prior_proof_seen_by_return_prove(
                    paths, config, retried, retried.specs[-1], second,
                )
            )
            with patch("tools.agentbus_v2.effects.read_snapshot", return_value=retried):
                result = run_prove(paths, config, retried, second)
            self.assertTrue(result.changed)

    def test_p4_style_same_failed_github_workflow_does_not_loop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            charter = "P_ID: P-TEST\nGOAL: P4-style unchanged CI\n"
            repo = RepoFixture(root)
            config = replace(
                config_for(repo, charter),
                required_ci_checks=("validate (windows-latest)",),
            )
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")
            initial = read_snapshot(paths)
            plan = decide(initial)
            dispatch_manual_gpt(paths, config, initial, plan)
            (root / "plan.json").write_text(json.dumps({
                "job_id": plan.effect_id, "operation": "PLAN_GPT",
                "decision": "SPEC", "body": "Keep HEAD and BASE fixed.",
            }), encoding="utf-8")
            submit_gpt_response(paths, root / "plan.json")
            before = read_snapshot(paths)
            work = decide(before)
            _commit_work(repo, config, before, work)
            current = read_snapshot(paths)
            first = decide(current)
            spec = current.specs[-1]
            merge, observed = _failing_ci(config, current, spec)
            local = {
                "commands": [
                    {
                        "argv": list(command),
                        "exit_code": 0,
                        "output": "",
                        "output_digest": sha256_text(""),
                    }
                    for command in _proof_commands(config, current.base, current.head)
                ]
            }
            completed = subprocess.CompletedProcess(("git", "fetch"), 0, "", "")

            def _prove_once(snapshot, action, observed_merge):
                with (
                    patch("tools.agentbus_v2.effects._run", return_value=completed),
                    patch(
                        "tools.agentbus_v2.effects._command_evidence",
                        return_value=(local, Observation.PASS),
                    ),
                    patch("tools.agentbus_v2.effects.ensure_owned_pr", return_value=True),
                    patch("tools.agentbus_v2.effects.read_github_facts", return_value=merge),
                    patch(
                        "tools.agentbus_v2.effects.observe_required_checks",
                        return_value=observed_merge,
                    ),
                ):
                    return run_prove(paths, config, snapshot, action)

            self.assertTrue(_prove_once(current, first, observed).changed)
            failed = read_snapshot(paths)
            judge = decide(failed)
            self.assertEqual("PROVE_MECHANICAL", judge.payload["failed_step"])
            _submit_return_prove(root, paths, config, failed, judge)
            retried = read_snapshot(paths)
            second = decide(retried)
            self.assertEqual(ActionKind.PROVE, second.kind)
            result = _prove_once(retried, second, observed)
            self.assertFalse(result.changed)
            self.assertEqual(PROVE_UNCHANGED_DETAIL, result.detail)
            live = read_snapshot(paths)
            self.assertEqual(1, len(live.proof_facts))
            self.assertEqual(ActionKind.PROVE, decide(live).kind)
            self.assertEqual(1, len(list((paths.root / "gpt" / "results").glob("judge-*.json"))))
            other = replace(
                observed,
                failed_ci_logs=(("21", "Windows workflow failed again"),),
                checks=(replace(observed.checks[0], run_id="21"),),
            )
            changed = _prove_once(retried, second, other)
            self.assertTrue(changed.changed)
            self.assertEqual(ActionKind.JUDGE, decide(read_snapshot(paths)).kind)

    def test_stall_supervisor_observes_unchanged_prove_detail(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        fx = SupervisorFixture(Path(temp.name))
        work = WorkFact(
            work_effect_id(fx.snapshot, fx.control.spec),
            fx.control.spec.spec_id,
            fx.snapshot.head,
            Observation.PASS,
            "e" * 64,
            output_head=fx.snapshot.head,
        )
        prove_snapshot = replace(fx.snapshot, work_facts=(work,))
        prove = decide(prove_snapshot)
        self.assertEqual(ActionKind.PROVE, prove.kind)
        patches = [
            patch("tools.agentbus_v2.control.read_snapshot", return_value=prove_snapshot),
            patch("tools.agentbus_v2.control.decide", return_value=prove),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        fx.observe(EffectResult(False, PROVE_UNCHANGED_DETAIL), action=prove, snapshot=prove_snapshot)
        fx.clock.advance(599)
        fx.observe(EffectResult(False, PROVE_UNCHANGED_DETAIL), action=prove, snapshot=prove_snapshot)
        self.assertEqual([], list((fx.control.paths.root / "control" / "outbox").glob("*")))
        self.assertEqual(PROVE_UNCHANGED_DETAIL, fx.supervisor.stall(fx.control.config.p_id).last_detail)
        fx.clock.advance(1)
        fx.observe(EffectResult(False, PROVE_UNCHANGED_DETAIL), action=prove, snapshot=prove_snapshot)
        outbox = list((fx.control.paths.root / "control" / "outbox").glob("*.md"))
        self.assertEqual(1, len(outbox))
        self.assertEqual(fx.stall_id(action=prove, snapshot=prove_snapshot), outbox[0].stem)
        self.assertIn("PURPOSE: STALL_TRIAGE", outbox[0].read_text(encoding="utf-8"))

    def test_identities_and_actionkind_are_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, config, paths, config = _plan_and_work(
                root, "P_ID: P-TEST\nGOAL: identity freeze\n"
            )
            (repo.work / "untracked-proof-failure.txt").write_text("fail\n", encoding="utf-8")
            current = read_snapshot(paths)
            first = decide(current)
            without_trigger = proof_id(current, current.specs[-1])
            self.assertEqual(without_trigger, first.effect_id)
            run_prove(paths, config, current, first)
            failed = read_snapshot(paths)
            judge = decide(failed)
            mechanical = judge_job_id(
                failed, failed.specs[-1],
                failed_step="PROVE_MECHANICAL",
                evidence_id=first.effect_id,
                evidence_digest=failed.proof_facts[0].evidence_digest,
            )
            self.assertEqual(mechanical, judge.effect_id)
            _submit_return_prove(root, paths, config, failed, judge)
            retried = read_snapshot(paths)
            second = decide(retried)
            self.assertEqual(
                proof_id(retried, retried.specs[-1], trigger_judge_id=judge.effect_id),
                second.effect_id,
            )
            self.assertNotEqual(first.effect_id, second.effect_id)
        self.assertEqual(
            ["PLAN", "WORK", "PROVE", "JUDGE", "MERGE", "MERGE_READY", "IDLE", "HUMAN", "DONE"],
            [item.value for item in ActionKind],
        )
        self.assertEqual(
            [
                "p_id", "charter_digest", "expected_repository", "expected_branch",
                "base_ref", "head", "base", "repository_available", "specs",
                "gpt_results", "gpt_pending", "work_facts", "proof_facts", "merge",
                "expected_owner_token", "proof_contract_digest", "allow_merge",
                "operator_directive",
            ],
            [item.name for item in fields(Snapshot)],
        )

    def test_webui_shows_waiting_for_new_prove_evidence_not_judge(self) -> None:
        status = _human_status(
            ProjectEntry("P-TEST", enabled=True),
            type("S", (), {"proof_facts": (type("P", (), {"status": type("O", (), {"value": "FAIL"})(), "summary": "old"})(),), "repository_available": True})(),
            Action(ActionKind.PROVE, effect_id="prove-" + "e" * 24),
            None,
            None,
            in_flight=False,
            worktree_clean=True,
            worktree_error=None,
            scheduler_status={},
            latest_detail=PROVE_UNCHANGED_DETAIL,
        )
        self.assertEqual("PROVE", status["status_code"])
        self.assertEqual("等待新的 PROVE 证据", status["status"])
        self.assertNotIn("JUDGE", status["next_wait"])
        idle = _human_status(
            ProjectEntry("P-TEST", enabled=True),
            type("S", (), {"proof_facts": (type("P", (), {"status": type("O", (), {"value": "FAIL"})(), "summary": "old"})(),), "repository_available": True})(),
            Action(ActionKind.PROVE, effect_id="prove-" + "e" * 24),
            None,
            None,
            in_flight=False,
            worktree_clean=True,
            worktree_error=None,
            scheduler_status={},
        )
        self.assertEqual("PROVE", idle["status_code"])
        self.assertEqual("等待验证", idle["status"])
        self.assertNotIn("JUDGE", idle["next_wait"])
