from __future__ import annotations

from dataclasses import asdict, replace
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools.agentbus_v2.cli import main, parser
from tools.agentbus_v2.core import ActionKind, SpecFact, decide, merge_fence_failures
from tools.agentbus_v2.facts import (
    AdoptedPr,
    FactError,
    PConfig,
    PPaths,
    canonical_repository,
    init_p,
    load_config,
    read_snapshot,
    sha256_text,
)
from tools.agentbus_v2.github import (
    OWNERSHIP_END,
    OWNERSHIP_START,
    _markers,
    adopt_existing_pr,
    ensure_owned_pr,
    read_github_facts,
    render_ownership_block,
    update_ownership_block,
)


FORBIDDEN = {
    "phase", "current_step", "current_action", "repair_count", "repair_epoch",
    "GPT_SPEC", "GPT_REVIEW", "FINAL_GATE", "campaign", "SENT",
    "browser_state", "scheduler_state",
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


class AdoptionFixture:
    repository = "github.com/acme/repo"
    branch = "legacy/existing-pr"
    base_branch = "main"
    pr_number = 7

    def __init__(self, root: Path, *, draft: bool = False) -> None:
        self.work = root / "work"
        self.remote = root / "remote.git"
        self.state = root / "state"
        self.work.mkdir()
        run(self.work, "git", "init", "-b", self.base_branch)
        run(self.work, "git", "config", "user.name", "AgentBus Test")
        run(self.work, "git", "config", "user.email", "agentbus@example.invalid")
        (self.work / "README.md").write_text("base\n", encoding="utf-8")
        run(self.work, "git", "add", "README.md")
        run(self.work, "git", "commit", "-m", "base")
        subprocess.run(
            ("git", "init", "--bare", str(self.remote)),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        run(self.work, "git", "remote", "add", "origin", str(self.remote))
        run(self.work, "git", "push", "-u", "origin", self.base_branch)
        self.base = run(self.work, "git", "rev-parse", "HEAD")
        run(self.work, "git", "switch", "-c", self.branch)
        (self.work / "legacy.txt").write_text("legacy implementation\n", encoding="utf-8")
        run(self.work, "git", "add", "legacy.txt")
        run(self.work, "git", "commit", "-m", "legacy implementation")
        run(self.work, "git", "push", "-u", "origin", self.branch)
        self.head = run(self.work, "git", "rev-parse", "HEAD")
        self.body = (
            "Legacy summary.\n\n"
            "[GPT_SPEC]\nold plan\n[/GPT_SPEC]\n"
            "[CODEX_REPORT]\nold report\n[/CODEX_REPORT]\n"
            "[GPT_REVIEW]\nold review\n[/GPT_REVIEW]\n"
            "[GPT_MERGE_REVIEW]\nold merge review\n[/GPT_MERGE_REVIEW]\n"
        )
        self.pr = {
            "number": self.pr_number,
            "state": "open",
            "draft": draft,
            "mergeable": True,
            "body": self.body,
            "head": {
                "sha": self.head,
                "ref": self.branch,
                "repo": {"full_name": "acme/repo"},
            },
            "base": {
                "sha": self.base,
                "ref": self.base_branch,
                "repo": {"full_name": "acme/repo"},
            },
            "merged_at": None,
            "merge_commit_sha": None,
        }
        self.remote_heads = {self.base_branch: self.base, self.branch: self.head}
        self.patch_calls = 0
        self.fail_patch = False
        self.unavailable = False

    @staticmethod
    def completed(argv, returncode: int = 0, stdout: str = "", stderr: str = ""):
        return subprocess.CompletedProcess(argv, returncode, stdout, stderr)

    def fake_run(self, argv, **kwargs):
        argv = tuple(argv)
        if argv[:3] == ("git", "remote", "get-url"):
            return self.completed(argv, stdout="https://github.com/acme/repo.git\n")
        if argv[:2] == ("git", "ls-remote"):
            branch = argv[-1].removeprefix("refs/heads/")
            sha = self.remote_heads.get(branch)
            if sha is None:
                return self.completed(argv, returncode=2, stderr="not found")
            return self.completed(argv, stdout=f"{sha}\trefs/heads/{branch}\n")
        if argv[:2] == ("git", "push"):
            result = REAL_RUN(argv, **kwargs)
            if result.returncode == 0:
                cwd = Path(kwargs["cwd"])
                head = REAL_RUN(("git", "rev-parse", "HEAD"), cwd=cwd).stdout.strip()
                self.remote_heads[self.branch] = head
                self.pr["head"]["sha"] = head
            return result
        if argv[:2] == ("gh", "api"):
            if self.unavailable:
                return self.completed(argv, returncode=1, stderr="missing")
            if "--method" in argv:
                if self.fail_patch:
                    return self.completed(argv, returncode=1, stderr="patch failed")
                body_arg = next(item for item in argv if item.startswith("body="))
                self.pr["body"] = body_arg.removeprefix("body=")
                self.patch_calls += 1
            return self.completed(argv, stdout=json.dumps(self.pr))
        return REAL_RUN(argv, **kwargs)

    def adopt(self, *, p_id: str = "P-ADOPT", charter: str = "Fresh v2 charter\n") -> PPaths:
        return adopt_existing_pr(
            self.state,
            p_id=p_id,
            charter_text=charter,
            worktree=self.work,
            repository=self.repository,
            pr_number=self.pr_number,
            branch=self.branch,
            base_ref=self.base_branch,
        )


from tools.agentbus_v2.facts import _run as REAL_RUN


class ExistingPrAdoptionTests(unittest.TestCase):
    def test_normal_init_fences_are_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            with self.assertRaisesRegex(FactError, "HEAD must equal"):
                init_p(
                    fixture.state,
                    p_id="P-FRESH",
                    charter_text="fresh\n",
                    worktree=fixture.work,
                    repository=str(fixture.remote),
                    branch=fixture.branch,
                )

        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            run(fixture.work, "git", "switch", fixture.base_branch)
            run(fixture.work, "git", "switch", "-c", "existing-at-base")
            run(fixture.work, "git", "push", "-u", "origin", "existing-at-base")
            with self.assertRaisesRegex(FactError, "existing remote experiment branch"):
                init_p(
                    fixture.state,
                    p_id="P-FRESH",
                    charter_text="fresh\n",
                    worktree=fixture.work,
                    repository=str(fixture.remote),
                    branch="existing-at-base",
                )

    def test_open_and_draft_same_repo_prs_are_adoptable(self) -> None:
        for draft in (False, True):
            with self.subTest(draft=draft), tempfile.TemporaryDirectory() as directory:
                fixture = AdoptionFixture(Path(directory), draft=draft)
                with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                    paths = fixture.adopt()
                    config = load_config(paths)
                    snapshot = read_snapshot(paths)
                self.assertEqual(ActionKind.PLAN, decide(snapshot).kind)
                self.assertEqual(fixture.head, config.seed_head)
                self.assertNotEqual(config.seed_head, config.adopted_pr.observed_base_sha)
                self.assertEqual(fixture.base, config.adopted_pr.observed_base_sha)
                self.assertEqual(fixture.pr_number, config.adopted_pr.number)
                self.assertEqual(1, fixture.patch_calls)

    def test_closed_merged_missing_and_number_mismatch_fail_closed(self) -> None:
        cases = (("closed", None), ("closed", "now"))
        for state, merged_at in cases:
            with (
                self.subTest(state=state, merged=bool(merged_at)),
                tempfile.TemporaryDirectory() as directory,
            ):
                fixture = AdoptionFixture(Path(directory))
                fixture.pr["state"] = state
                fixture.pr["merged_at"] = merged_at
                with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                    with self.assertRaisesRegex(FactError, "open PR"):
                        fixture.adopt()
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            fixture.unavailable = True
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaisesRegex(FactError, "unavailable"):
                    fixture.adopt()
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            fixture.pr["number"] = 8
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaisesRegex(FactError, "number mismatch"):
                    fixture.adopt()

    def test_repository_branch_base_and_fork_mismatches_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaisesRegex(FactError, "repository mismatch"):
                    adopt_existing_pr(
                        fixture.state, p_id="P-X", charter_text="x",
                        worktree=fixture.work, repository="github.com/other/repo",
                        pr_number=7, branch=fixture.branch,
                    )
        for field, value, message in (
            (("head", "ref"), "other", "head branch"),
            (("base", "ref"), "develop", "base branch"),
            (("head", "repo"), {"full_name": "fork/repo"}, "fork PR"),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                fixture = AdoptionFixture(Path(directory))
                fixture.pr[field[0]][field[1]] = value
                with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                    with self.assertRaisesRegex(FactError, message):
                        fixture.adopt()

    def test_head_remote_missing_dirty_and_nonroot_worktree_are_rejected(self) -> None:
        for mode, message in (
            ("pr_head", "local HEAD"),
            ("remote_head", "remote branch"),
            ("missing_remote", "did not resolve"),
            ("dirty", "clean dedicated worktree"),
        ):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                fixture = AdoptionFixture(Path(directory))
                if mode == "pr_head":
                    fixture.pr["head"]["sha"] = "1" * 40
                elif mode == "remote_head":
                    fixture.remote_heads[fixture.branch] = "2" * 40
                elif mode == "missing_remote":
                    del fixture.remote_heads[fixture.branch]
                else:
                    (fixture.work / "dirty.txt").write_text("dirty", encoding="utf-8")
                with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                    with self.assertRaisesRegex(FactError, message):
                        fixture.adopt()
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            child = fixture.work / "child"
            child.mkdir()
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaisesRegex(FactError, "Git root"):
                    adopt_existing_pr(
                        fixture.state, p_id="P-X", charter_text="x", worktree=child,
                        repository=fixture.repository, pr_number=7, branch=fixture.branch,
                    )

    def test_foreign_and_partial_markers_are_rejected(self) -> None:
        bodies = (
            render_ownership_block("P-OTHER", "owner-other") + "\n",
            render_ownership_block("P-ADOPT", "owner-other") + "\n",
            "AgentBus-V2-P: P-OTHER\nAgentBus-V2-Owner: owner-other\n",
            "AgentBus-V2-P: P-PARTIAL\n",
            "AgentBus-V2-Unknown: value\n",
            OWNERSHIP_START + "\nAgentBus-V2-P: P-PARTIAL\n",
            OWNERSHIP_END + "\n" + OWNERSHIP_START + "\n",
            (
                render_ownership_block("P-OTHER", "owner-other")
                + "\nAgentBus-V2-P: P-OTHER\nAgentBus-V2-Owner: owner-other\n"
            ),
        )
        for body in bodies:
            with self.subTest(body=body[:30]), tempfile.TemporaryDirectory() as directory:
                fixture = AdoptionFixture(Path(directory))
                fixture.pr["body"] = body
                with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                    with self.assertRaises(FactError):
                        fixture.adopt()

    def test_claim_is_idempotent_and_preserves_legacy_body(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            original = fixture.body
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                first = fixture.adopt()
                second = fixture.adopt()
            self.assertEqual(first.root, second.root)
            self.assertTrue(fixture.pr["body"].startswith(original))
            self.assertEqual(1, fixture.pr["body"].count(OWNERSHIP_START))
            self.assertEqual(1, fixture.pr["body"].count(OWNERSHIP_END))
            self.assertEqual(1, fixture.patch_calls)
            self.assertNotIn("spec_id", _markers(fixture.pr["body"]))

    def test_retry_after_local_facts_resumes_remote_claim(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            fixture.fail_patch = True
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaisesRegex(FactError, "did not reach GitHub"):
                    fixture.adopt()
            paths = PPaths(fixture.state / "P-ADOPT")
            self.assertTrue((paths.root / "config.json").exists())
            self.assertNotIn(OWNERSHIP_START, fixture.pr["body"])
            fixture.fail_patch = False
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                fixture.adopt()
            self.assertEqual("P-ADOPT", _markers(fixture.pr["body"])["p_id"])
            self.assertEqual(1, fixture.patch_calls)

        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            partial = fixture.state / "P-ADOPT"
            partial.mkdir(parents=True)
            (partial / "charter.md").write_text("Fresh v2 charter\n", encoding="utf-8")
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                paths = fixture.adopt()
            self.assertTrue((paths.root / "config.json").exists())
            self.assertEqual(1, fixture.patch_calls)

    def test_observed_base_is_provenance_not_runtime_authority(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                paths = fixture.adopt()
            config = load_config(paths)
            run(fixture.work, "git", "switch", fixture.base_branch)
            (fixture.work / "base-moved.txt").write_text("moved\n", encoding="utf-8")
            run(fixture.work, "git", "add", "base-moved.txt")
            run(fixture.work, "git", "commit", "-m", "move base")
            moved = run(fixture.work, "git", "rev-parse", "HEAD")
            run(fixture.work, "git", "push", "origin", fixture.base_branch)
            run(fixture.work, "git", "switch", fixture.branch)
            fixture.remote_heads[fixture.base_branch] = moved
            snapshot = read_snapshot_with_patch(fixture, paths)
            self.assertEqual(fixture.base, config.adopted_pr.observed_base_sha)
            self.assertEqual(moved, snapshot.base)

    def test_initial_claim_never_imports_a_spec_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            fixture.fail_patch = True
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaises(FactError):
                    fixture.adopt()
            config = load_config(PPaths(fixture.state / "P-ADOPT"))
            fixture.fail_patch = False
            fixture.pr["body"] = update_ownership_block(
                fixture.body, config.p_id, config.owner_token, "spec-foreign"
            )
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaisesRegex(FactError, "must not contain a SPEC"):
                    fixture.adopt()

    def test_adopted_config_restart_and_old_config_compatibility(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                paths = fixture.adopt()
            loaded = load_config(paths)
            self.assertIsInstance(loaded.adopted_pr, AdoptedPr)
            serialized = json.loads((paths.root / "config.json").read_text(encoding="utf-8"))
            self.assertEqual(set(), FORBIDDEN & set(serialized))
            self.assertEqual(
                {"number", "seed_head_sha", "head_branch", "base_branch", "observed_base_sha"},
                set(serialized["adopted_pr"]),
            )
            self.assertFalse((fixture.state / "projects.json").exists())
            self.assertFalse(any("v1" in item.name.lower() for item in paths.root.rglob("*")))

            old_paths = PPaths(fixture.state / "P-OLD")
            old_paths.root.mkdir()
            old = {key: value for key, value in asdict(loaded).items() if key != "adopted_pr"}
            old["p_id"] = "P-OLD"
            (old_paths.root / "config.json").write_text(json.dumps(old), encoding="utf-8")
            self.assertIsNone(load_config(old_paths).adopted_pr)

    def test_marker_helper_preserves_body_and_updates_only_one_block(self) -> None:
        body = "Title\r\n\r\nArbitrary bytes and [GPT_SPEC].\r\n"
        claimed = update_ownership_block(body, "P-X", "owner-x")
        self.assertTrue(claimed.startswith(body))
        with_spec = update_ownership_block(claimed, "P-X", "owner-x", "spec-123")
        self.assertTrue(with_spec.startswith(body))
        self.assertEqual(1, with_spec.count(OWNERSHIP_START))
        self.assertEqual("spec-123", _markers(with_spec)["spec_id"])
        self.assertEqual(with_spec, update_ownership_block(with_spec, "P-X", "owner-x", "spec-123"))
        legacy = (
            "Standalone\nAgentBus-V2-P: P-X\nAgentBus-V2-Spec: spec-old\n"
            "AgentBus-V2-Owner: owner-x\n"
        )
        self.assertEqual(
            {"p_id": "P-X", "spec_id": "spec-old", "owner_token": "owner-x"},
            _markers(legacy),
        )

    def test_ensure_owned_pr_updates_spec_after_normal_head_advancement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            original = fixture.body
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                paths = fixture.adopt()
                config = load_config(paths)
                (fixture.work / "repair.txt").write_text("repair\n", encoding="utf-8")
                run(fixture.work, "git", "add", "repair.txt")
                run(fixture.work, "git", "commit", "-m", "repair")
                advanced = run(fixture.work, "git", "rev-parse", "HEAD")
                spec = SpecFact("spec-" + "a" * 24, "repair")
                self.assertTrue(ensure_owned_pr(config, spec))
                facts = read_github_facts(config)
                patch_count = fixture.patch_calls
                self.assertTrue(ensure_owned_pr(config, spec))
            self.assertNotEqual(config.seed_head, advanced)
            self.assertEqual(advanced, facts.head_sha)
            self.assertEqual(spec.spec_id, facts.spec_id)
            self.assertEqual((config.p_id, config.owner_token), (facts.p_id, facts.owner_token))
            self.assertEqual(config.adopted_pr.number, facts.pr_number)
            self.assertTrue(fixture.pr["body"].startswith(original))
            self.assertEqual(1, fixture.pr["body"].count(OWNERSHIP_START))
            self.assertEqual(patch_count, fixture.patch_calls)
            snapshot = replace(
                read_snapshot_with_patch(fixture, paths),
                specs=(spec,),
                merge=facts,
            )
            self.assertEqual((), merge_fence_failures(snapshot, spec))

    def test_registered_second_claim_and_changed_config_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                paths = fixture.adopt(p_id="P-ONE")
            (fixture.state / "projects.json").write_text(
                json.dumps({"projects": [{"p_id": "P-ONE", "enabled": True}]}),
                encoding="utf-8",
            )
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaisesRegex(FactError, "remain disabled"):
                    fixture.adopt(p_id="P-ONE")
            (fixture.state / "projects.json").write_text(
                json.dumps({"projects": [{"p_id": "P-ONE", "enabled": False}]}),
                encoding="utf-8",
            )
            fixture.pr["body"] = fixture.body
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaisesRegex(FactError, "already claims this worktree"):
                    fixture.adopt(p_id="P-TWO")
                with self.assertRaises(FactError):
                    adopt_existing_pr(
                        fixture.state,
                        p_id="P-ONE",
                        charter_text="changed charter",
                        worktree=fixture.work,
                        repository=fixture.repository,
                        pr_number=fixture.pr_number,
                        branch=fixture.branch,
                    )
            self.assertTrue((paths.root / "config.json").exists())

    def test_changing_adopted_pr_identity_changes_owner_and_cannot_claim(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                paths = fixture.adopt()
                config = load_config(paths)
                assert config.adopted_pr is not None
                tampered = replace(
                    config,
                    adopted_pr=replace(config.adopted_pr, number=8),
                )
                self.assertNotEqual(config.owner_token, tampered.owner_token)
                fixture.pr["number"] = 8
                with self.assertRaisesRegex(FactError, "not owned"):
                    ensure_owned_pr(tampered, SpecFact("spec-" + "b" * 24, "x"))

    def test_conflicting_partial_state_directory_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture = AdoptionFixture(Path(directory))
            root = fixture.state / "P-ADOPT"
            root.mkdir(parents=True)
            (root / "foreign.json").write_text("{}", encoding="utf-8")
            with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
                with self.assertRaisesRegex(FactError, "conflicting facts"):
                    fixture.adopt()

    def test_cli_is_explicit_and_noninteractive(self) -> None:
        args = parser().parse_args([
            "--state-root", "/tmp/state", "adopt-pr", "P-X",
            "--charter", "/tmp/charter", "--worktree", "/tmp/work",
            "--repository", "github.com/acme/repo", "--pr-number", "7",
            "--branch", "legacy/existing-pr", "--base", "main",
        ])
        self.assertEqual("adopt-pr", args.command)
        self.assertEqual(7, args.pr_number)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            charter = root / "charter.md"
            charter.write_text("fresh charter\n", encoding="utf-8")
            adopted = PPaths(root / "state" / "P-X")
            output = io.StringIO()
            with (
                patch("tools.agentbus_v2.github.adopt_existing_pr", return_value=adopted) as call,
                redirect_stdout(output),
            ):
                result = main([
                    "--state-root", str(root / "state"), "adopt-pr", "P-X",
                    "--charter", str(charter), "--worktree", str(root / "work"),
                    "--repository", "github.com/acme/repo", "--pr-number", "7",
                    "--branch", "legacy/existing-pr",
                ])
            self.assertEqual(0, result)
            self.assertEqual("EXISTING_PR_ADOPTED", json.loads(output.getvalue())["outcome"])
            call.assert_called_once()


def read_snapshot_with_patch(fixture: AdoptionFixture, paths: PPaths):
    with patch("tools.agentbus_v2.facts._run", side_effect=fixture.fake_run):
        return read_snapshot(paths)


if __name__ == "__main__":
    unittest.main()
