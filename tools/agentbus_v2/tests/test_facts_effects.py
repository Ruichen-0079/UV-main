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
    PROOF_SCHEMA,
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
    CODEX_WORK_MODEL,
    CODEX_WORK_REASONING_EFFORT,
    _codex_work_command,
    _command_evidence,
    dispatch_manual_gpt,
    render_gpt_prompt,
    run_prove,
    submit_gpt_response,
)
from tools.agentbus_v2.facts import (
    FactError,
    PConfig,
    PPaths,
    _load_gpt_result,
    _load_proof,
    _load_work,
    _proof_commands,
    _work_from_head,
    canonical_repository,
    init_p,
    load_config,
    proof_contract_digest,
    read_snapshot,
    sha256_text,
)
from tools.agentbus_v2.github import (
    GitHubFacts,
    merge_pr,
    observe_required_checks,
    read_github_facts,
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
        p_id="P-TEST",
        worktree=str(repo.work),
        repository=canonical_repository(str(repo.remote)),
        remote="origin",
        branch="agentbus/p-test",
        base_ref="main",
        seed_head=repo.base,
        charter_digest=sha256_text(charter),
        proof_commands=(),
        required_ci_checks=(),
    )


def snapshot_for(config: PConfig) -> Snapshot:
    head = run(Path(config.worktree), "git", "rev-parse", "HEAD")
    return Snapshot(
        p_id=config.p_id,
        charter_digest=config.charter_digest,
        expected_repository=config.repository,
        expected_branch=config.branch,
        base_ref=config.base_ref,
        head=head,
        base=head,
        expected_owner_token=config.owner_token,
    )


class FactAndEffectTests(unittest.TestCase):
    def test_codex_work_command_explicitly_binds_model_and_reasoning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            config = config_for(repo, "P_ID: P-TEST\n")
            common_git = root / "common.git"
            schema = root / "schema.json"
            response = root / "response.json"

            command = _codex_work_command(config, common_git, schema, response)

            self.assertEqual("gpt-5.6-luna", CODEX_WORK_MODEL)
            self.assertEqual("max", CODEX_WORK_REASONING_EFFORT)
            model_index = command.index("--model")
            effort_index = command.index("--config")
            self.assertEqual(
                ("--model", "gpt-5.6-luna"),
                command[model_index:model_index + 2],
            )
            self.assertEqual(
                ("--config", 'model_reasoning_effort="max"'),
                command[effort_index:effort_index + 2],
            )

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
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")
            snapshot = snapshot_for(config)
            action = decide(snapshot)
            self.assertEqual(ActionKind.PLAN, action.kind)

            first = dispatch_manual_gpt(paths, config, snapshot, action)
            second = dispatch_manual_gpt(paths, config, snapshot, action)
            self.assertTrue(first.changed)
            self.assertFalse(second.changed)
            packet_path = paths.root / "gpt" / "outbox" / f"{action.effect_id}.md"
            packet = packet_path.read_text(encoding="utf-8")
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
            self.assertTrue(ingested.changed)
            loaded = read_snapshot(paths)
            results, specs, pending = loaded.gpt_results, loaded.specs, loaded.gpt_pending
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
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")
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
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")
            snapshot = snapshot_for(config)
            action = decide(snapshot)
            dispatch_manual_gpt(paths, config, snapshot, action)
            (paths.root / "gpt" / "outbox" / ("plan-" + "f" * 24 + ".md")).write_text(
                "not a packet and not a current input", encoding="utf-8"
            )
            loaded = read_snapshot(paths)
            results, specs, pending = loaded.gpt_results, loaded.specs, loaded.gpt_pending
            self.assertEqual((), results)
            self.assertEqual((), specs)
            self.assertIn(action.effect_id, pending)

    def test_current_loader_follows_exact_return_plan_lineage_without_history_scan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            config = config_for(repo, "P_ID: P-TEST\nGOAL: causal lookup\n")
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text("P_ID: P-TEST\nGOAL: causal lookup\n", encoding="utf-8")
            (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")

            root_plan = decide(snapshot_for(config))
            dispatch_manual_gpt(paths, config, snapshot_for(config), root_plan)
            response = root / "root-plan.json"
            response.write_text(json.dumps({
                "job_id": root_plan.effect_id,
                "operation": "PLAN_GPT",
                "decision": "SPEC",
                "body": "First exact plan",
            }), encoding="utf-8")
            submit_gpt_response(paths, response)
            current = read_snapshot(paths)
            first = current.specs[-1]
            work = decide(current)
            self.assertEqual(ActionKind.WORK, work.kind)

            failure = {
                "effect_id": work.effect_id,
                "spec_id": first.spec_id,
                "input_head": current.head,
                "status": "FAIL",
                "evidence_digest": "first-work-failure",
                "trigger_judge_id": None,
            }
            (paths.root / "work" / "results" / f"{work.effect_id}.json").write_text(
                json.dumps(failure), encoding="utf-8"
            )
            judged = decide(read_snapshot(paths))
            self.assertEqual(ActionKind.JUDGE, judged.kind)
            dispatch_manual_gpt(paths, config, read_snapshot(paths), judged)
            judge_response = root / "return-plan.json"
            judge_response.write_text(json.dumps({
                "job_id": judged.effect_id,
                "operation": "JUDGE_GPT",
                "decision": "RETURN_PLAN",
                "body": "The first plan was wrong",
            }), encoding="utf-8")
            submit_gpt_response(paths, judge_response)

            successor_pending = decide(read_snapshot(paths))
            self.assertEqual(ActionKind.PLAN, successor_pending.kind)
            dispatch_manual_gpt(paths, config, read_snapshot(paths), successor_pending)
            successor_response = root / "successor-plan.json"
            successor_response.write_text(json.dumps({
                "job_id": successor_pending.effect_id,
                "operation": "PLAN_GPT",
                "decision": "SPEC",
                "body": "Second exact plan",
            }), encoding="utf-8")
            submit_gpt_response(paths, successor_response)
            before_noise = decide(read_snapshot(paths))

            stale = (
                paths.root / "gpt" / "results" / ("judge-" + "e" * 24 + ".json"),
                paths.root / "work" / "results" / ("work-" + "e" * 24 + ".json"),
                paths.root / "prove" / "results" / ("prove-" + "e" * 24 + ".json"),
                paths.root / "gpt" / "outbox" / ("plan-" + "d" * 24 + ".md"),
            )
            for path in stale:
                path.write_text("historical noise", encoding="utf-8")
            stale[0].touch()
            with patch.object(Path, "glob", side_effect=AssertionError("history scan")):
                final = read_snapshot(paths)
            action = decide(final)
            self.assertEqual(before_noise, action)
            self.assertEqual(ActionKind.WORK, action.kind)
            self.assertEqual("Second exact plan", final.specs[-1].text)
            self.assertEqual(final.specs[-1].spec_id, action.payload["spec_id"])

    def test_fresh_snapshot_replays_multiple_return_work_rounds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: repeated causal work retries\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(
                json.dumps(asdict(config)), encoding="utf-8"
            )

            initial = read_snapshot(paths)
            plan = decide(initial)
            dispatch_manual_gpt(paths, config, initial, plan)
            plan_response = root / "plan.json"
            plan_response.write_text(json.dumps({
                "job_id": plan.effect_id,
                "operation": "PLAN_GPT",
                "decision": "SPEC",
                "body": "Keep retrying WORK only when GLOBAL JUDGE directs it.",
            }), encoding="utf-8")
            submit_gpt_response(paths, plan_response)

            prior_judge: str | None = None
            for attempt in range(3):
                current = read_snapshot(paths)
                work = decide(current)
                self.assertEqual(ActionKind.WORK, work.kind)
                self.assertEqual(prior_judge, work.payload.get("trigger_judge_id"))
                spec = current.specs[-1]
                (paths.root / "work" / "results" / f"{work.effect_id}.json").write_text(
                    json.dumps({
                        "effect_id": work.effect_id,
                        "spec_id": spec.spec_id,
                        "input_head": current.head,
                        "status": "FAIL",
                        "evidence_digest": f"work-failure-{attempt}",
                        "trigger_judge_id": prior_judge,
                    }),
                    encoding="utf-8",
                )

                failed = read_snapshot(paths)
                judge = decide(failed)
                self.assertEqual(ActionKind.JUDGE, judge.kind)
                self.assertEqual(prior_judge, judge.payload.get("trigger_judge_id"))
                if attempt == 2:
                    self.assertEqual(3, len(failed.work_facts))
                    self.assertEqual(3, len({item.effect_id for item in failed.work_facts}))
                    break

                dispatch_manual_gpt(paths, config, failed, judge)
                judge_response = root / f"judge-{attempt}.json"
                judge_response.write_text(json.dumps({
                    "job_id": judge.effect_id,
                    "operation": "JUDGE_GPT",
                    "decision": "RETURN_WORK",
                    "body": f"Correct the confirmed WORK failure {attempt}.",
                }), encoding="utf-8")
                submit_gpt_response(paths, judge_response)
                prior_judge = judge.effect_id

    def test_fresh_snapshot_replays_multiple_return_prove_rounds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: repeated causal proof retries\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(
                json.dumps(asdict(config)), encoding="utf-8"
            )

            initial = read_snapshot(paths)
            plan = decide(initial)
            dispatch_manual_gpt(paths, config, initial, plan)
            plan_response = root / "plan.json"
            plan_response.write_text(json.dumps({
                "job_id": plan.effect_id,
                "operation": "PLAN_GPT",
                "decision": "SPEC",
                "body": "Implement once, then follow every RETURN_PROVE exactly.",
            }), encoding="utf-8")
            submit_gpt_response(paths, plan_response)

            before_work = read_snapshot(paths)
            work = decide(before_work)
            spec = before_work.specs[-1]
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
                f"AgentBus-V2-Input-Head: {before_work.head}\n"
                f"AgentBus-V2-Plan: {spec.plan_job_id}\n",
            )
            (repo.work / "untracked-proof-failure.txt").write_text(
                "force deterministic local proof failure\n", encoding="utf-8"
            )

            prior_judge: str | None = None
            for attempt in range(3):
                current = read_snapshot(paths)
                prove = decide(current)
                self.assertEqual(ActionKind.PROVE, prove.kind)
                self.assertEqual(prior_judge, prove.payload.get("trigger_judge_id"))
                self.assertTrue(run_prove(paths, config, current, prove).changed)

                failed = read_snapshot(paths)
                judge = decide(failed)
                self.assertEqual(ActionKind.JUDGE, judge.kind)
                self.assertEqual(prior_judge, judge.payload.get("trigger_judge_id"))
                if attempt == 2:
                    self.assertEqual(3, len(failed.proof_facts))
                    self.assertEqual(3, len({item.proof_id for item in failed.proof_facts}))
                    break

                dispatch_manual_gpt(paths, config, failed, judge)
                judge_response = root / f"prove-judge-{attempt}.json"
                judge_response.write_text(json.dumps({
                    "job_id": judge.effect_id,
                    "operation": "JUDGE_GPT",
                    "decision": "RETURN_PROVE",
                    "body": f"Repeat proof with correction {attempt}.",
                }), encoding="utf-8")
                submit_gpt_response(paths, judge_response)
                prior_judge = judge.effect_id

    def test_recovered_retry_commit_requires_its_exact_return_work_cause(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: causal retry commit recovery\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(
                json.dumps(asdict(config)), encoding="utf-8"
            )
            initial = read_snapshot(paths)
            plan = decide(initial)
            dispatch_manual_gpt(paths, config, initial, plan)
            plan_response = root / "plan.json"
            plan_response.write_text(json.dumps({
                "job_id": plan.effect_id,
                "operation": "PLAN_GPT",
                "decision": "SPEC",
                "body": "Implement a causally fenced retry.",
            }), encoding="utf-8")
            submit_gpt_response(paths, plan_response)

            before = read_snapshot(paths)
            first_work = decide(before)
            spec = before.specs[-1]
            (paths.root / "work" / "results" / f"{first_work.effect_id}.json").write_text(
                json.dumps({
                    "effect_id": first_work.effect_id,
                    "spec_id": spec.spec_id,
                    "input_head": before.head,
                    "status": "FAIL",
                    "evidence_digest": "confirmed-first-failure",
                    "trigger_judge_id": None,
                }),
                encoding="utf-8",
            )
            failed = read_snapshot(paths)
            judge = decide(failed)
            dispatch_manual_gpt(paths, config, failed, judge)
            judge_response = root / "judge.json"
            judge_response.write_text(json.dumps({
                "job_id": judge.effect_id,
                "operation": "JUDGE_GPT",
                "decision": "RETURN_WORK",
                "body": "Retry WORK with the correction.",
            }), encoding="utf-8")
            submit_gpt_response(paths, judge_response)

            retry_snapshot = read_snapshot(paths)
            retry = decide(retry_snapshot)
            self.assertEqual(ActionKind.WORK, retry.kind)
            (repo.work / "README.md").write_text("retry implemented\n", encoding="utf-8")
            run(repo.work, "git", "add", "README.md")
            run(
                repo.work,
                "git",
                "commit",
                "-m",
                "retry work\n\n"
                f"AgentBus-V2-P: {config.p_id}\n"
                f"AgentBus-V2-Spec: {spec.spec_id}\n"
                f"AgentBus-V2-Work: {retry.effect_id}\n"
                f"AgentBus-V2-Input-Head: {retry_snapshot.head}\n"
                f"AgentBus-V2-Plan: {spec.plan_job_id}\n"
                f"AgentBus-V2-Trigger: {judge.effect_id}\n",
            )
            self.assertEqual(ActionKind.PROVE, decide(read_snapshot(paths)).kind)

            result_path = paths.root / "gpt" / "results" / f"{judge.effect_id}.json"
            corrupted = json.loads(result_path.read_text(encoding="utf-8"))
            corrupted["decision"] = "RETURN_PROVE"
            result_path.write_text(json.dumps(corrupted), encoding="utf-8")
            with self.assertRaisesRegex(FactError, "exact RETURN_WORK cause"):
                read_snapshot(paths)

    def test_current_plan_pending_rejects_wrong_packet_operation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: strict current pending packet\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(
                json.dumps(asdict(config)), encoding="utf-8"
            )
            snapshot = read_snapshot(paths)
            action = decide(snapshot)
            dispatch_manual_gpt(paths, config, snapshot, action)
            packet_path = paths.root / "gpt" / "outbox" / f"{action.effect_id}.md"
            packet_text = packet_path.read_text(encoding="utf-8")
            packet_text = packet_text.replace(
                '"operation":"PLAN_GPT"', '"operation":"JUDGE_GPT"'
            )
            packet_path.write_text(packet_text, encoding="utf-8")
            with self.assertRaisesRegex(FactError, "causal identity mismatch"):
                read_snapshot(paths)

    def test_restart_reloads_disk_facts_and_derives_same_effect(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: restart test\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")
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

            loaded = read_snapshot(paths)
            first_results, first_specs, first_pending = loaded.gpt_results, loaded.specs, loaded.gpt_pending
            first = decide(
                replace(
                    snapshot,
                    gpt_results=first_results,
                    specs=first_specs,
                    gpt_pending=first_pending,
                )
            )
            # Simulate a fresh process by loading new objects from disk.
            loaded = read_snapshot(paths)
            second_results, second_specs, second_pending = loaded.gpt_results, loaded.specs, loaded.gpt_pending
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

    def test_merge_response_loss_reloads_exact_premerge_proof_and_judge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: durable DONE reconstruction\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(
                json.dumps(asdict(config)), encoding="utf-8"
            )

            initial = read_snapshot(paths)
            plan = decide(initial)
            dispatch_manual_gpt(paths, config, initial, plan)
            plan_response = root / "plan.json"
            plan_response.write_text(json.dumps({
                "job_id": plan.effect_id,
                "operation": "PLAN_GPT",
                "decision": "SPEC",
                "body": "Implement and retain exact pre-merge evidence.",
            }), encoding="utf-8")
            submit_gpt_response(paths, plan_response)
            before_work = read_snapshot(paths)
            work = decide(before_work)
            spec = before_work.specs[-1]
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
                f"AgentBus-V2-Input-Head: {before_work.head}\n"
                f"AgentBus-V2-Plan: {spec.plan_job_id}\n",
            )
            premerge = read_snapshot(paths)
            prove = decide(premerge)
            self.assertEqual(ActionKind.PROVE, prove.kind)
            mechanical, mechanical_status = _command_evidence(config, premerge)
            self.assertEqual(Observation.PASS, mechanical_status)
            assert mechanical is not None
            evidence = {
                "local_commands": mechanical["commands"],
                "github_checks": [],
                "failed_ci_logs": {},
            }
            (paths.root / "prove" / "results" / f"{prove.effect_id}.json").write_text(
                json.dumps({
                    "schema": PROOF_SCHEMA,
                    "proof_id": prove.effect_id,
                    "spec_id": spec.spec_id,
                    "head": premerge.head,
                    "base": premerge.base,
                    "status": "PASS",
                    "trigger_judge_id": None,
                    "contract_digest": premerge.proof_contract_digest,
                    "summary": "mechanical evidence passed",
                    "local_commands": evidence["local_commands"],
                    "github_checks": [],
                    "failed_ci_logs": {},
                    "evidence_digest": sha256_text(
                        json.dumps(evidence, sort_keys=True)
                    ),
                }),
                encoding="utf-8",
            )
            with patch(
                "tools.agentbus_v2.github.read_github_facts",
                return_value=GitHubFacts(),
            ):
                proved = read_snapshot(paths)
            judge = decide(proved)
            self.assertEqual(ActionKind.JUDGE, judge.kind)
            dispatch_manual_gpt(paths, config, proved, judge)
            judge_response = root / "judge.json"
            judge_response.write_text(json.dumps({
                "job_id": judge.effect_id,
                "operation": "JUDGE_GPT",
                "decision": "PASS",
                "body": "The exact proof satisfies the specification.",
            }), encoding="utf-8")
            submit_gpt_response(paths, judge_response)

            work_head = run(repo.work, "git", "rev-parse", "HEAD")
            premature = GitHubFacts(
                pr_number=7,
                state="MERGED",
                head_sha=work_head,
                live_base=repo.base,
                pr_base_sha=repo.base,
                head_branch=config.branch,
                base_branch=config.base_ref,
                p_id=config.p_id,
                spec_id=spec.spec_id,
                owner_token=config.owner_token,
                merge_commit_sha="f" * 40,
                merge_parents=(repo.base, work_head),
            )
            with patch(
                "tools.agentbus_v2.github.read_github_facts",
                return_value=premature,
            ):
                not_integrated = read_snapshot(paths, allow_merge=True)
            self.assertEqual("ABSENT", not_integrated.merge.state)
            self.assertNotEqual(ActionKind.DONE, decide(not_integrated).kind)

            run(repo.work, "git", "switch", "main")
            run(repo.work, "git", "merge", "--no-ff", "agentbus/p-test", "-m", "merge work")
            merge_head = run(repo.work, "git", "rev-parse", "HEAD")
            run(repo.work, "git", "push", "origin", "main")
            run(repo.work, "git", "switch", "agentbus/p-test")
            merged = GitHubFacts(
                pr_number=7,
                state="MERGED",
                head_sha=work_head,
                live_base=merge_head,
                pr_base_sha=repo.base,
                head_branch=config.branch,
                base_branch=config.base_ref,
                p_id=config.p_id,
                spec_id=spec.spec_id,
                owner_token=config.owner_token,
                merge_commit_sha=merge_head,
                merge_parents=(repo.base, work_head),
            )
            with patch(
                "tools.agentbus_v2.github.read_github_facts",
                return_value=merged,
            ) as github_read:
                restarted = read_snapshot(paths, allow_merge=False)
            self.assertTrue(github_read.called)
            self.assertEqual(merge_head, restarted.base)
            self.assertEqual(repo.base, restarted.proof_facts[-1].base)
            self.assertEqual(ActionKind.DONE, decide(restarted).kind)

    def test_judge_packet_is_self_contained_and_strict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: judge packet\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")
            initial = snapshot_for(config)
            planning = plan_facts_digest(initial)
            plan = plan_job_id(initial)
            spec = SpecFact(
                spec_id(initial.charter_digest, planning, "Fix and prove the change"),
                "Fix and prove the change",
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
            packet = (paths.root / "gpt" / "outbox" / f"{action.effect_id}.md").read_text(
                encoding="utf-8"
            )
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
            self.assertTrue(submit_gpt_response(paths, response).changed)
            loaded = _load_gpt_result(paths, action.effect_id, "JUDGE_GPT")
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertEqual("RETURN_WORK", loaded.decision)

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
AgentBus-V2-Plan: plan-%s
""" % (work_id, input_head, "0" * 24)
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
AgentBus-V2-Plan: plan-%s
""" % (head, "0" * 24)
            run(repo.work, "git", "commit", "-m", stale_message)
            stale_head = run(repo.work, "git", "rev-parse", "HEAD")
            with self.assertRaisesRegex(FactError, "deterministic effect identity"):
                _work_from_head(config, stale_head)

    def test_fresh_snapshot_recovers_spec_from_work_plan_trailer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: restart after work\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / config.p_id)
            paths.create_dirs()
            (paths.root / "charter.md").write_text(charter, encoding="utf-8")
            (paths.root / "config.json").write_text(json.dumps(asdict(config)), encoding="utf-8")
            plan = decide(read_snapshot(paths))
            dispatch_manual_gpt(paths, config, read_snapshot(paths), plan)
            response = root / "plan.json"
            response.write_text(json.dumps({
                "job_id": plan.effect_id, "operation": "PLAN_GPT",
                "decision": "SPEC", "body": "Implement the restart proof",
            }), encoding="utf-8")
            submit_gpt_response(paths, response)
            before = read_snapshot(paths)
            work = decide(before)
            spec = before.specs[-1]
            (repo.work / "README.md").write_text("implemented\n", encoding="utf-8")
            run(repo.work, "git", "add", "README.md")
            run(repo.work, "git", "commit", "-m", f"work\n\n"
                f"AgentBus-V2-P: {config.p_id}\n"
                f"AgentBus-V2-Spec: {spec.spec_id}\n"
                f"AgentBus-V2-Work: {work.effect_id}\n"
                f"AgentBus-V2-Input-Head: {before.head}\n"
                f"AgentBus-V2-Plan: {spec.plan_job_id}\n")
            after = read_snapshot(paths)
            self.assertEqual(ActionKind.PROVE, decide(after).kind)
            self.assertEqual(Observation.PASS, after.work_facts[0].status)

    def test_executor_crash_before_commit_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            charter = "P_ID: P-TEST\nGOAL: absent work\n"
            config = config_for(repo, charter)
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            self.assertIsNone(_work_from_head(config, repo.base))
            identity = snapshot_for(config)
            spec = SpecFact("spec-123", "current")
            self.assertIsNone(_load_work(paths, config, identity, spec))

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
            (paths.root / "work" / "results" / f"{effect}.json").write_text(
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
            identity = snapshot_for(config)
            spec = SpecFact("spec-123", "current")
            fact = _load_work(paths, config, identity, spec)
            self.assertIsNotNone(fact)
            assert fact is not None
            self.assertIs(Observation.FAIL, fact.status)
            self.assertEqual(effect, fact.effect_id)

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
            serialized = json.loads((paths.root / "config.json").read_text(encoding="utf-8"))
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
                "Test the change",
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
            self.assertTrue(result.changed)
            saved = json.loads(
                (paths.root / "prove" / "results" / f"{action.effect_id}.json").read_text()
            )
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
                "current spec",
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
            (paths.root / "prove" / "results" / f"{effect}.json").write_text(
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
                _load_proof(paths, config, spec, repo.base, repo.base,
                            snapshot.proof_contract_digest)

    def test_exact_proof_result_reloads_pass_and_missing_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = RepoFixture(root)
            config = config_for(repo, "P_ID: P-TEST\n")
            paths = PPaths(root / "state" / "P-TEST")
            paths.create_dirs()
            spec = SpecFact(
                spec_id(config.charter_digest, "planning", "current spec"),
                "current spec",
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
            (paths.root / "prove" / "results" / f"{proof}.json").write_text(
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
                paths, config, spec, repo.base, repo.base,
                snapshot.proof_contract_digest,
            )
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertIs(Observation.PASS, loaded.status)
            (paths.root / "prove" / "results" / f"{proof}.json").unlink()
            self.assertEqual(
                None, _load_proof(
                    paths, config, spec, repo.base, repo.base,
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
                "current spec",
            )
            snapshot = replace(
                snapshot_for(config),
                specs=(spec,),
                proof_contract_digest=proof_contract_digest(config),
            )
            effect = proof_id(snapshot, spec)
            # An old-format/corrupt result must never be opened while looking
            # up the new contract's exact proof identity.
            (paths.root / "prove" / "results" / f"{effect}.json").write_text(
                "not the current proof artifact", encoding="utf-8"
            )
            changed = replace(
                config,
                proof_commands=(("cargo", "fmt", "--check"),),
            )
            self.assertEqual(
                None, _load_proof(
                    paths, changed, spec, repo.base, repo.base,
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
            synthetic_parents = [base, head]
            run_head_sha = head
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
                        "headSha": run_head_sha,
                        "status": "completed",
                        "conclusion": "success",
                        "workflowName": "check",
                        "url": "https://github.com/acme/repo/actions/runs/99",
                    }
                else:
                    value = {"parents": [{"sha": value} for value in synthetic_parents]}
                return subprocess.CompletedProcess(argv, 0, json.dumps(value), "")

            with patch("tools.agentbus_v2.facts._run", side_effect=fake_run):
                observed = observe_required_checks(
                    config, GitHubFacts(pr_number=7), head, base
                )
            self.assertEqual("PASS", observed.check_status)
            evidence = [asdict(item) for item in observed.checks]
            self.assertEqual(set(required), {item["name"] for item in evidence})
            self.assertTrue(all(item["current_integration"] for item in evidence))

            with patch("tools.agentbus_v2.facts._run", side_effect=fake_run):
                observed = observe_required_checks(
                    replace(config, required_ci_checks=required + ("missing",)),
                    GitHubFacts(pr_number=7), head, base,
                )
            self.assertEqual("MISSING", observed.check_status)

            synthetic_parents[:] = [base, "e" * 40]
            with patch("tools.agentbus_v2.facts._run", side_effect=fake_run):
                observed = observe_required_checks(config, GitHubFacts(pr_number=7), head, base)
            self.assertEqual("MISSING", observed.check_status)

            synthetic_parents[:] = [base, head]
            run_head_sha = merge_sha
            with patch("tools.agentbus_v2.facts._run", side_effect=fake_run):
                observed = observe_required_checks(config, GitHubFacts(pr_number=7), head, base)
            self.assertEqual("MISSING", observed.check_status)

    def test_github_snapshot_is_one_normalized_owned_pr_fact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = RepoFixture(Path(directory))
            config = replace(
                config_for(repo, "P_ID: P-TEST\n"),
                repository="github.com/acme/repo",
            )
            head, base = "1" * 40, "a" * 40

            def fake_run(argv, **_kwargs):
                if argv[:2] == ("git", "ls-remote"):
                    return subprocess.CompletedProcess(argv, 0, f"{base}\trefs/heads/main\n", "")
                self.assertEqual(("gh", "pr", "list"), tuple(argv[:3]))
                value = [{
                    "number": 7,
                    "state": "OPEN",
                    "isDraft": False,
                    "mergeable": "MERGEABLE",
                    "headRefName": config.branch,
                    "headRefOid": head,
                    "baseRefName": config.base_ref,
                    "baseRefOid": base,
                    "body": (
                        "AgentBus-V2-P: P-TEST\n"
                        "AgentBus-V2-Spec: spec-7\n"
                        f"AgentBus-V2-Owner: {config.owner_token}\n"
                    ),
                    "mergedAt": None,
                    "mergeCommit": None,
                }]
                return subprocess.CompletedProcess(argv, 0, json.dumps(value), "")

            with patch("tools.agentbus_v2.facts._run", side_effect=fake_run):
                facts = read_github_facts(config)
            self.assertEqual(7, facts.pr_number)
            self.assertEqual(head, facts.head_sha)
            self.assertEqual(base, facts.live_base)
            self.assertEqual(base, facts.pr_base_sha)
            self.assertEqual(config.branch, facts.head_branch)
            self.assertEqual(config.base_ref, facts.base_branch)
            self.assertEqual(("P-TEST", "spec-7", config.owner_token),
                             (facts.p_id, facts.spec_id, facts.owner_token))

    def test_merge_adapter_keeps_exact_head_argument(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = RepoFixture(Path(directory))
            config = replace(config_for(repo, "P_ID: P-TEST\n"),
                             repository="github.com/acme/repo")
            seen = []

            def runner(argv, **_kwargs):
                seen.append(tuple(argv))
                return subprocess.CompletedProcess(argv, 0, "", "")

            merge_pr(config, 7, "1" * 40, command_runner=runner)
            self.assertEqual(1, len(seen))
            self.assertIn("--match-head-commit", seen[0])
            self.assertEqual("1" * 40, seen[0][seen[0].index("--match-head-commit") + 1])


if __name__ == "__main__":
    unittest.main()
