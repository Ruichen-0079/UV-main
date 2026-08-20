from __future__ import annotations

from dataclasses import asdict, replace
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2.core import (
    ActionKind,
    GptResult,
    Observation,
    Snapshot,
    SpecFact,
    WorkFact,
    decide,
    plan_facts_digest,
    plan_job_id,
    proof_id,
    spec_id,
    stable_id,
    work_effect_id,
)
from tools.agentbus_v2.cli import _tick_lock
from tools.agentbus_v2.effects import (
    _ci_checks,
    dispatch_manual_gpt,
    render_gpt_prompt,
    run_prove,
    submit_gpt_response,
)
from tools.agentbus_v2.facts import (
    FactError,
    PConfig,
    PPaths,
    _load_gpt,
    _load_proof,
    _load_work,
    _proof_commands,
    _work_from_head,
    canonical_repository,
    init_p,
    load_config,
    proof_contract_digest,
    sha256_text,
)


FORBIDDEN = {
    "current_step",
    "phase",
    "current_action",
    "repair_count",
    "repair_epoch",
    "retry_phase",
    "waiting_for",
    "wait_reason",
    "ready_for_final",
    "archive_state",
    "campaign_progress",
}


def run(cwd: Path, *argv: str) -> str:
    completed = subprocess.run(
        argv,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return completed.stdout.strip()


class RepoFixture:
    def __init__(self, root: Path) -> None:
        self.work = root / "work"
        self.remote = root / "remote.git"
        self.work.mkdir()
        run(self.work, "git", "init", "-b", "main")
        run(self.work, "git", "config", "user.name", "AgentBus Test")
        run(self.work, "git", "config", "user.email", "agentbus@example.invalid")
        (self.work / "README.md").write_text("initial\n", encoding="utf-8")
        run(self.work, "git", "add", "README.md")
        run(self.work, "git", "commit", "-m", "initial")
        subprocess.run(
            ("git", "init", "--bare", str(self.remote)),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        run(self.work, "git", "remote", "add", "origin", str(self.remote))
        run(self.work, "git", "push", "-u", "origin", "main")
        self.base = run(self.work, "git", "rev-parse", "HEAD")
        run(self.work, "git", "switch", "-c", "agentbus/p-test")


def config_for(repo: RepoFixture, charter: str) -> PConfig:
    return PConfig(
        schema_version=2,
        p_id="P-TEST",
        worktree=str(repo.work),
        repository=canonical_repository(str(repo.remote)),
        remote="origin",
        branch="agentbus/p-test",
        base_ref="main",
        seed_head=repo.base,
        seed_base=repo.base,
        charter_digest=sha256_text(charter),
        owner_token="owner-test",
        proof_commands=(),
        required_ci_checks=(),
    )


def snapshot_for(config: PConfig) -> Snapshot:
    return Snapshot(
        p_id=config.p_id,
        charter_digest=config.charter_digest,
        expected_repository=config.repository,
        expected_branch=config.branch,
        base_ref=config.base_ref,
        head=config.seed_head,
        base=config.seed_base,
        expected_owner_token=config.owner_token,
    )


class FactAndEffectTests(unittest.TestCase):
    def test_duplicate_ticks_are_excluded_by_per_p_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory) / "P-TEST" / "tick.lock"
            with _tick_lock(lock_path) as first:
                self.assertTrue(first)
                with _tick_lock(lock_path) as second:
                    self.assertFalse(second)

    def test_manual_gpt_job_is_deterministic_and_response_is_strict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: deterministic test\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            paths.charter.write_text(charter, encoding="utf-8")
            paths.config.write_text(json.dumps(asdict(config)), encoding="utf-8")
            snapshot = snapshot_for(config)
            action = decide(snapshot)
            self.assertEqual(ActionKind.PLAN, action.kind)

            first = dispatch_manual_gpt(paths, config, snapshot, action)
            second = dispatch_manual_gpt(paths, config, snapshot, action)
            self.assertTrue(first.ran)
            self.assertFalse(second.ran)
            self.assertEqual(first.path, second.path)
            packet = first.path.read_text(encoding="utf-8")
            self.assertEqual(packet, render_gpt_prompt(paths, config, snapshot, action))
            self.assertIn(f"SHA256={sha256_text(packet)}", first.detail)
            self.assertIn(f"JOB_ID: {action.effect_id}", packet)
            for section in (
                "## SEMANTIC INPUTS",
                "## P_CHARTER (immutable)",
                "## CURRENT_SPEC",
                "## CURRENT-BASE DIFF",
                "## STRICT RESPONSE SCHEMA",
            ):
                self.assertIn(section, packet)
            self.assertFalse((paths.root / "gpt" / "requests").exists())
            self.assertFalse((paths.root / "gpt" / "inbox").exists())

            response = root / "response.json"
            response.write_text(
                json.dumps(
                    {
                        "job_id": action.effect_id,
                        "operation": "PLAN_GPT",
                        "decision": "SPEC",
                        "body": "Change one file and prove it.",
                    }
                ),
                encoding="utf-8",
            )
            ingested = submit_gpt_response(paths, response)
            self.assertTrue(ingested.ran)
            results, specs, pending = _load_gpt(paths, config)
            self.assertEqual(1, len(results))
            self.assertEqual(1, len(specs))
            self.assertFalse(pending)

            invalid = root / "invalid.json"
            invalid.write_text(
                json.dumps(
                    {
                        "job_id": action.effect_id,
                        "operation": "PLAN_GPT",
                        "decision": "REPLAN",
                        "body": "forbidden",
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(Exception, "not allowed"):
                submit_gpt_response(paths, invalid)

    def test_gpt_response_rejects_wrong_job_and_operation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: strict response\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            paths.charter.write_text(charter, encoding="utf-8")
            paths.config.write_text(json.dumps(asdict(config)), encoding="utf-8")
            snapshot = snapshot_for(config)
            action = decide(snapshot)
            dispatch_manual_gpt(paths, config, snapshot, action)
            for name, update, message in (
                ("wrong-job.json", {"job_id": "plan-" + "0" * 24}, "GPT packet is absent"),
                ("wrong-operation.json", {"operation": "JUDGE_GPT"}, "operation mismatch"),
            ):
                value = {
                    "job_id": action.effect_id,
                    "operation": "PLAN_GPT",
                    "decision": "SPEC",
                    "body": "bounded plan",
                    **update,
                }
                path = root / name
                path.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaisesRegex(FactError, message):
                    submit_gpt_response(paths, path)

    def test_unrelated_historical_packet_is_not_read_or_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: packet lookup\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            paths.charter.write_text(charter, encoding="utf-8")
            paths.config.write_text(json.dumps(asdict(config)), encoding="utf-8")
            snapshot = snapshot_for(config)
            action = decide(snapshot)
            dispatch_manual_gpt(paths, config, snapshot, action)
            (paths.gpt_outbox / ("plan-" + "f" * 24 + ".md")).write_text(
                "not a packet and not a current input", encoding="utf-8"
            )
            results, specs, pending = _load_gpt(paths, config)
            self.assertEqual((), results)
            self.assertEqual((), specs)
            self.assertIn(action.effect_id, pending)

    def test_restart_reloads_disk_facts_and_derives_same_effect(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: restart test\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            paths.charter.write_text(charter, encoding="utf-8")
            paths.config.write_text(json.dumps(asdict(config)), encoding="utf-8")
            snapshot = snapshot_for(config)
            plan = decide(snapshot)
            dispatch_manual_gpt(paths, config, snapshot, plan)
            response = root / "response.json"
            response.write_text(
                json.dumps(
                    {
                        "job_id": plan.effect_id,
                        "operation": "PLAN_GPT",
                        "decision": "SPEC",
                        "body": "Implement one bounded change.",
                    }
                ),
                encoding="utf-8",
            )
            submit_gpt_response(paths, response)

            first_results, first_specs, first_pending = _load_gpt(paths, config)
            first = decide(
                replace(
                    snapshot,
                    gpt_results=first_results,
                    specs=first_specs,
                    gpt_pending=first_pending,
                )
            )
            # Simulate a fresh process by loading new objects from disk.
            second_results, second_specs, second_pending = _load_gpt(paths, config)
            second = decide(
                replace(
                    snapshot,
                    gpt_results=second_results,
                    specs=second_specs,
                    gpt_pending=second_pending,
                )
            )
            self.assertEqual(ActionKind.WORK, first.kind)
            self.assertEqual(first, second)

    def test_judge_packet_is_self_contained_and_strict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: judge packet\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            paths.charter.write_text(charter, encoding="utf-8")
            paths.config.write_text(json.dumps(asdict(config)), encoding="utf-8")
            initial = snapshot_for(config)
            planning = plan_facts_digest(initial)
            plan = plan_job_id(initial)
            spec = SpecFact(
                spec_id(initial.charter_digest, planning, "Fix and prove the change"),
                plan,
                "Fix and prove the change",
                planning,
                initial.head,
                initial.base,
            )
            failure = WorkFact(
                work_effect_id(initial, spec),
                spec.spec_id,
                initial.head,
                Observation.FAIL,
                "confirmed-failure",
            )
            snapshot = replace(
                initial,
                specs=(spec,),
                gpt_results=(GptResult(plan, "PLAN_GPT", "SPEC", spec.text),),
                work_facts=(failure,),
            )
            action = decide(snapshot)
            self.assertEqual(ActionKind.JUDGE, action.kind)
            packet_result = dispatch_manual_gpt(paths, config, snapshot, action)
            packet = packet_result.path.read_text(encoding="utf-8")
            self.assertEqual(packet, render_gpt_prompt(paths, config, snapshot, action))
            self.assertIn(spec.text, packet)
            self.assertIn(initial.head, packet)
            self.assertIn(initial.base, packet)
            self.assertIn("confirmed-failure", packet)
            response = root / "judge.json"
            response.write_text(
                json.dumps(
                    {
                        "job_id": action.effect_id,
                        "operation": "JUDGE_GPT",
                        "decision": "RETURN_WORK",
                        "body": "The implementation failure is confirmed.",
                    }
                ),
                encoding="utf-8",
            )
            self.assertTrue(submit_gpt_response(paths, response).ran)
            loaded, _, _ = _load_gpt(paths, config)
            self.assertEqual("RETURN_WORK", loaded[0].decision)

    def test_work_commit_trailers_recover_pass_after_executor_crash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: crash recovery\n"
            config = config_for(repo, charter)
            input_head = run(repo.work, "git", "rev-parse", "HEAD")
            work_id = stable_id(
                "work",
                {
                    "p_id": "P-TEST",
                    "spec": "spec-123",
                    "input_head": input_head,
                    "trigger_judge": None,
                },
            )
            (repo.work / "README.md").write_text("changed\n", encoding="utf-8")
            run(repo.work, "git", "add", "README.md")
            message = """implement work

AgentBus-V2-P: P-TEST
AgentBus-V2-Spec: spec-123
AgentBus-V2-Work: %s
AgentBus-V2-Input-Head: %s
""" % (work_id, input_head)
            run(repo.work, "git", "commit", "-m", message)
            head = run(repo.work, "git", "rev-parse", "HEAD")
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            fact = _work_from_head(config, head)
            self.assertIsNotNone(fact)
            assert fact is not None
            self.assertEqual(work_id, fact.effect_id)
            self.assertEqual("spec-123", fact.spec_id)
            self.assertEqual(input_head, fact.input_head)
            self.assertEqual(head, fact.output_head)

            run(repo.work, "git", "switch", "-c", "other")
            (repo.work / "README.md").write_text("stale\n", encoding="utf-8")
            run(repo.work, "git", "add", "README.md")
            stale_message = """stale identity

AgentBus-V2-P: P-TEST
AgentBus-V2-Spec: spec-123
AgentBus-V2-Work: work-000000000000000000000000
AgentBus-V2-Input-Head: %s
""" % head
            run(repo.work, "git", "commit", "-m", stale_message)
            stale_head = run(repo.work, "git", "rev-parse", "HEAD")
            with self.assertRaisesRegex(FactError, "deterministic effect identity"):
                _work_from_head(config, stale_head)

    def test_executor_crash_before_commit_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: absent work\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            self.assertIsNone(_work_from_head(config, repo.base))
            self.assertEqual([], _load_work(paths, config))

    def test_confirmed_codex_failure_is_one_durable_work_fact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: durable work failure\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            effect = stable_id(
                "work",
                {
                    "p_id": config.p_id,
                    "spec": "spec-123",
                    "input_head": repo.base,
                    "trigger_judge": None,
                },
            )
            (paths.work_results / f"{effect}.json").write_text(
                json.dumps(
                    {
                        "effect_id": effect,
                        "spec_id": "spec-123",
                        "input_head": repo.base,
                        "status": "FAIL",
                        "evidence_digest": "failure-evidence",
                        "trigger_judge_id": None,
                    }
                ),
                encoding="utf-8",
            )
            facts = _load_work(paths, config)
            self.assertEqual(1, len(facts))
            self.assertIs(Observation.FAIL, facts[0].status)
            self.assertEqual(effect, facts[0].effect_id)

    def test_initialized_p_persists_no_workflow_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: persistence audit\n"
            paths = init_p(
                root / "state",
                p_id="P-TEST",
                charter_text=charter,
                worktree=repo.work,
                repository=str(repo.remote),
                branch="agentbus/p-test",
            )
            serialized = json.loads(paths.config.read_text(encoding="utf-8"))
            self.assertFalse(FORBIDDEN & set(serialized))
            self.assertEqual(FORBIDDEN & set(asdict(load_config(paths))), set())

    def test_local_mechanical_failure_is_durable_without_a_pr(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: local proof failure\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            initial = replace(
                snapshot_for(config),
                proof_contract_digest=proof_contract_digest(config),
            )
            planning = plan_facts_digest(initial)
            plan = plan_job_id(initial)
            spec = SpecFact(
                spec_id(initial.charter_digest, planning, "Test the change"),
                plan,
                "Test the change",
                planning,
                initial.head,
                initial.base,
            )
            implemented_head = "1" * 40
            work = WorkFact(
                work_effect_id(initial, spec),
                spec.spec_id,
                initial.head,
                Observation.PASS,
                "work-evidence",
                output_head=implemented_head,
            )
            snapshot = replace(
                initial,
                head=implemented_head,
                specs=(spec,),
                gpt_results=(GptResult(plan, "PLAN_GPT", "SPEC", spec.text),),
                work_facts=(work,),
            )
            action = decide(snapshot)
            self.assertEqual(ActionKind.PROVE, action.kind)
            mechanical = {
                "commands": [
                    {
                        "argv": ["git", "diff", "--check"],
                        "exit_code": 1,
                        "output_digest": sha256_text("failure"),
                    }
                ],
            }
            completed = subprocess.CompletedProcess(("git", "fetch"), 0, "", "")
            with (
                patch("tools.agentbus_v2.effects._run", return_value=completed),
                patch(
                    "tools.agentbus_v2.effects.read_snapshot",
                    side_effect=(snapshot, snapshot),
                ),
                patch(
                    "tools.agentbus_v2.effects._command_evidence",
                    return_value=(mechanical, Observation.FAIL),
                ),
            ):
                result = run_prove(paths, config, snapshot, action)
            self.assertEqual("PROVE_FAIL", result.outcome)
            saved = json.loads(result.path.read_text(encoding="utf-8"))
            self.assertEqual("FAIL", saved["status"])
            self.assertEqual([], saved["github_checks"])
            self.assertEqual(action.effect_id, saved["proof_id"])

    def test_proof_result_identity_corruption_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            config = config_for(repo, "P_ID: P-TEST\n")
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            spec = SpecFact(
                spec_id(config.charter_digest, "planning", "current spec"),
                "plan-" + "0" * 24,
                "current spec",
                "planning",
                repo.base,
                repo.base,
            )
            snapshot = replace(
                snapshot_for(config),
                specs=(spec,),
                proof_contract_digest=proof_contract_digest(config),
            )
            effect = proof_id(snapshot, spec)
            evidence = {
                "local_commands": [],
                "github_checks": [],
                "failed_ci_logs": {},
            }
            (paths.proof_results / f"{effect}.json").write_text(
                json.dumps(
                    {
                        "schema": "agentbus-v2/proof-v2",
                        "proof_id": effect,
                        "spec_id": "spec-invalid",
                        "head": repo.base,
                        "base": repo.base,
                        "status": "PASS",
                        "contract_digest": snapshot.proof_contract_digest,
                        "trigger_judge_id": None,
                        "summary": "tampered",
                        **evidence,
                        "evidence_digest": sha256_text(
                            json.dumps(evidence, sort_keys=True)
                        ),
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(FactError, "identity"):
                _load_proof(
                    paths, config, (spec,), (), repo.base, repo.base,
                    snapshot.proof_contract_digest,
                )

    def test_exact_proof_result_reloads_pass_and_missing_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            config = config_for(repo, "P_ID: P-TEST\n")
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            spec = SpecFact(
                spec_id(config.charter_digest, "planning", "current spec"),
                "plan-" + "0" * 24,
                "current spec",
                "planning",
                repo.base,
                repo.base,
            )
            snapshot = replace(
                snapshot_for(config),
                specs=(spec,),
                proof_contract_digest=proof_contract_digest(config),
            )
            evidence = {
                "local_commands": [
                    {
                        "argv": list(argv),
                        "exit_code": 0,
                        "output": "",
                        "output_digest": sha256_text(""),
                    }
                    for argv in _proof_commands(config, repo.base, repo.base)
                ],
                "github_checks": [],
                "failed_ci_logs": {},
            }
            proof = proof_id(snapshot, spec)
            (paths.proof_results / f"{proof}.json").write_text(
                json.dumps({
                    "schema": "agentbus-v2/proof-v2",
                    "proof_id": proof,
                    "spec_id": spec.spec_id,
                    "head": repo.base,
                    "base": repo.base,
                    "status": "PASS",
                    "trigger_judge_id": None,
                    "contract_digest": snapshot.proof_contract_digest,
                    "summary": "local proof passed",
                    **evidence,
                    "evidence_digest": sha256_text(
                        json.dumps(evidence, sort_keys=True)
                    ),
                }),
                encoding="utf-8",
            )
            loaded = _load_proof(
                paths, config, (spec,), (), repo.base, repo.base,
                snapshot.proof_contract_digest,
            )
            self.assertEqual((Observation.PASS,), tuple(item.status for item in loaded))
            (paths.proof_results / f"{proof}.json").unlink()
            self.assertEqual(
                (), _load_proof(
                    paths, config, (spec,), (), repo.base, repo.base,
                    snapshot.proof_contract_digest,
                )
            )

    def test_prior_proof_contract_result_is_stale(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            config = config_for(repo, "P_ID: P-TEST\n")
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            spec = SpecFact(
                spec_id(config.charter_digest, "planning", "current spec"),
                "plan-" + "0" * 24,
                "current spec",
                "planning",
                repo.base,
                repo.base,
            )
            snapshot = replace(
                snapshot_for(config),
                specs=(spec,),
                proof_contract_digest=proof_contract_digest(config),
            )
            effect = proof_id(snapshot, spec)
            # An old-format/corrupt result must never be opened while looking
            # up the new contract's exact proof identity.
            (paths.proof_results / f"{effect}.json").write_text(
                "not the current proof artifact", encoding="utf-8"
            )
            changed = replace(
                config,
                proof_commands=(("cargo", "fmt", "--check"),),
            )
            self.assertEqual(
                (), _load_proof(
                    paths, changed, (spec,), (), repo.base, repo.base,
                    proof_contract_digest(changed),
                )
            )

    def test_ci_requires_named_current_base_pull_request_checks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = RepoFixture(Path(directory))
            required = (
                "validate (ubuntu-latest)",
                "validate (windows-latest)",
                "desktop-windows-package",
            )
            config = replace(
                config_for(repo, "P_ID: P-TEST\n"),
                repository="github.com/acme/repo",
                required_ci_checks=required,
            )
            head, base, merge_sha = "1" * 40, "a" * 40, "f" * 40
            checks = [
                {
                    "name": name,
                    "state": "SUCCESS",
                    "bucket": "pass",
                    "workflow": "check",
                    "link": "https://github.com/acme/repo/actions/runs/99/job/1",
                }
                for name in required
            ]

            def fake_run(argv, **_kwargs):
                if argv[1:3] == ("pr", "checks"):
                    value = checks
                elif argv[1] == "api" and "/pulls/" in argv[2]:
                    value = {
                        "head": {"sha": head},
                        "base": {"sha": base},
                        "merge_commit_sha": merge_sha,
                    }
                elif argv[1:3] == ("run", "view"):
                    value = {
                        "event": "pull_request",
                        "headSha": head,
                        "status": "completed",
                        "conclusion": "success",
                        "workflowName": "check",
                        "url": "https://github.com/acme/repo/actions/runs/99",
                    }
                else:
                    value = {"parents": [{"sha": base}, {"sha": head}]}
                return subprocess.CompletedProcess(argv, 0, json.dumps(value), "")

            with patch("tools.agentbus_v2.effects._run", side_effect=fake_run):
                status, evidence, _ = _ci_checks(config, 7, head, base)
            self.assertEqual("PASS", status)
            self.assertEqual(set(required), {item["name"] for item in evidence})
            self.assertTrue(all(item["run"]["current_base_identity"] for item in evidence))

            with patch("tools.agentbus_v2.effects._run", side_effect=fake_run):
                status, _, _ = _ci_checks(
                    replace(config, required_ci_checks=required + ("missing",)),
                    7,
                    head,
                    base,
                )
            self.assertEqual("ABSENT", status)


if __name__ == "__main__":
    unittest.main()
