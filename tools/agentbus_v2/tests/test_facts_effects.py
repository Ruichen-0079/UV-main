from __future__ import annotations

from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
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
    spec_id,
    stable_id,
    work_effect_id,
)
from tools.agentbus_v2.effects import (
    _ci_checks,
    _lease,
    dispatch_manual_gpt,
    run_prove,
    submit_gpt_response,
)
from tools.agentbus_v2.facts import (
    FactError,
    PConfig,
    PPaths,
    ProofCommand,
    _load_gpt,
    _load_proof,
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
        schema_version=1,
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
        require_github_ci=False,
        required_ci_checks=(),
        context_paths=("README.md",),
        context_terms=(),
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
            self.assertIn(f"JOB_ID: {action.effect_id}", first.path.read_text(encoding="utf-8"))

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
                    gpt_requests=first_pending,
                )
            )
            # Simulate a fresh process by loading new objects from disk.
            second_results, second_specs, second_pending = _load_gpt(paths, config)
            second = decide(
                replace(
                    snapshot,
                    gpt_results=second_results,
                    specs=second_specs,
                    gpt_requests=second_pending,
                )
            )
            self.assertEqual(ActionKind.WORK, first.kind)
            self.assertEqual(first, second)

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
            request = {
                "schema_version": 1,
                "effect_id": work_id,
                "p_id": "P-TEST",
                "spec_id": "spec-123",
                "input_head": input_head,
                "trigger_judge_id": None,
            }
            (paths.work_requests / f"{work_id}.json").write_text(
                json.dumps(request), encoding="utf-8"
            )
            fact = _work_from_head(config, paths, head)
            self.assertIsNotNone(fact)
            assert fact is not None
            self.assertEqual(work_id, fact.effect_id)
            self.assertEqual("spec-123", fact.spec_id)
            self.assertEqual(input_head, fact.input_head)
            self.assertEqual(head, fact.output_head)

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
                require_github_ci=False,
            )
            serialized = json.loads(paths.config.read_text(encoding="utf-8"))
            self.assertFalse(FORBIDDEN & set(serialized))
            self.assertEqual(FORBIDDEN & set(asdict(load_config(paths))), set())

    def test_expired_operational_lease_is_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = PPaths(Path(directory) / "P-TEST")
            paths.create_dirs()
            lease = paths.leases / "work-expired.json"
            lease.write_text(
                json.dumps(
                    {
                        "effect_id": "work-expired",
                        "expires_at": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
                    }
                ),
                encoding="utf-8",
            )
            with _lease(paths, "work-expired") as acquired:
                self.assertTrue(acquired)
            self.assertFalse(lease.exists())

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
                "effect_id": action.effect_id,
                "spec_id": spec.spec_id,
                "head": snapshot.head,
                "base": snapshot.base,
                "trigger_judge_id": None,
                "commands": [
                    {
                        "name": "git-diff-check",
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
                    return_value=(mechanical, False),
                ),
            ):
                result = run_prove(paths, config, snapshot, action)
            self.assertEqual("PROVE_FAIL", result.outcome)
            saved = json.loads(result.path.read_text(encoding="utf-8"))
            self.assertEqual("FAIL", saved["status"])
            self.assertEqual([], saved["evidence"]["github_checks"])

    def test_proof_result_identity_corruption_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            config = config_for(repo, "P_ID: P-TEST\n")
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            evidence: dict[str, object] = {}
            digest = sha256_text(json.dumps(evidence, sort_keys=True))
            effect = "prove-" + "0" * 24
            (paths.proof_results / f"{effect}.json").write_text(
                json.dumps(
                    {
                        "effect_id": effect,
                        "spec_id": "spec-invalid",
                        "head": repo.base,
                        "base": repo.base,
                        "status": "PASS",
                        "evidence_digest": digest,
                        "trigger_judge_id": None,
                        "summary": "tampered",
                        "evidence": evidence,
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(FactError, "identity"):
                _load_proof(paths, config, proof_contract_digest(config))

    def test_prior_proof_contract_result_is_stale(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            config = config_for(repo, "P_ID: P-TEST\n")
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            evidence: dict[str, object] = {}
            old_contract = proof_contract_digest(config)
            effect = stable_id(
                "prove",
                {
                    "p_id": config.p_id,
                    "spec": "spec-" + "1" * 24,
                    "head": repo.base,
                    "base": repo.base,
                    "trigger_judge": None,
                    "proof_contract": old_contract,
                },
            )
            (paths.proof_results / f"{effect}.json").write_text(
                json.dumps(
                    {
                        "effect_id": effect,
                        "spec_id": "spec-" + "1" * 24,
                        "head": repo.base,
                        "base": repo.base,
                        "status": "PASS",
                        "evidence_digest": sha256_text(
                            json.dumps(evidence, sort_keys=True)
                        ),
                        "trigger_judge_id": None,
                        "summary": "old contract",
                        "evidence": evidence,
                    }
                ),
                encoding="utf-8",
            )
            changed = replace(
                config,
                proof_commands=(ProofCommand("cargo-fmt-check", ("cargo", "fmt", "--check")),),
            )
            self.assertEqual(
                (), _load_proof(paths, changed, proof_contract_digest(changed))
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
                require_github_ci=True,
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
