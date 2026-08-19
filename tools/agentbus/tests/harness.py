from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from typing import Sequence
from unittest.mock import patch

from agentbus.cli import main
from agentbus.paths import discover_repo
from agentbus.store import StreamStore
from agentbus.util import atomic_write_text


class AgentbusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.td = tempfile.TemporaryDirectory(prefix="yuvi-agentbus-test-")
        self.root = self.td.name
        self.home = os.path.join(self.root, "home")
        self.state = os.path.join(self.root, "state")
        self.repo = os.path.join(self.root, "repo")
        self.bin = os.path.join(self.root, "bin")
        os.makedirs(self.home)
        os.makedirs(self.state)
        os.makedirs(self.bin)
        self._init_repo()
        self._write_fakes()
        self.env_backup = os.environ.copy()
        os.environ["HOME"] = self.home
        os.environ["XDG_STATE_HOME"] = os.path.join(self.root, "xdg-state")
        os.environ["YUVI_AGENTBUS_STATE"] = self.state
        os.environ["YUVI_AGENTBUS_GH"] = os.path.join(self.bin, "gh")
        # The fake GitHub transport must preserve posted comments so the
        # production exact-body re-fetch path is exercised without touching
        # the real network.
        self.fake_comments = os.path.join(self.root, "fake-gh-comments.json")
        atomic_write_text(self.fake_comments, "[]")
        os.environ["FAKE_GH_COMMENTS"] = self.fake_comments
        os.environ["YUVI_AGENTBUS_CODEX"] = os.path.join(self.bin, "codex")
        os.environ["YUVI_AGENTBUS_REPO"] = self.repo
        os.environ["YUVI_AGENTBUS_PUSH"] = "0"
        os.environ["YUVI_AGENTBUS_BOOTSTRAP_PR"] = "1"
        os.environ["YUVI_AGENTBUS_OPEN_URL"] = "0"
        os.environ["YUVI_AGENTBUS_NOTIFY"] = "0"
        os.environ["YUVI_AGENTBUS_WAKE_IMPL"] = "0"
        # Automatic executor reconciliation is exercised by AgentBus ticks;
        # keep the suite's desktop surface a short-lived fake instead of
        # opening real user Konsoles.
        os.environ["YUVI_AGENTBUS_KONSOLE"] = "/bin/true"
        os.environ["PATH"] = self.bin + os.pathsep + self.env_backup.get("PATH", "")
        os.environ.pop("CODEX_HOME", None)
        self.ctx = discover_repo(self.repo)
        self.executor_launches: list[dict[str, object]] = []
        self._executor_launcher_patch = patch(
            "agentbus.konsolebind._launch_executor_process",
            side_effect=self._fake_executor_process,
        )
        self._executor_launcher_patch.start()

    def tearDown(self) -> None:
        if hasattr(self, "_executor_launcher_patch"):
            self._executor_launcher_patch.stop()
        os.environ.clear()
        os.environ.update(self.env_backup)
        self.td.cleanup()

    def _fake_executor_process(self, argv: list[str], *, env: dict[str, str]) -> SimpleNamespace:
        self.executor_launches.append({"argv": list(argv), "env": dict(env)})
        # The current test process is a deterministic live owner for pending
        # runtime facts. No child process, Konsole, DBus session, or watch loop
        # is created by the test harness.
        return SimpleNamespace(pid=os.getpid())

    def _init_repo(self) -> None:
        os.makedirs(self.repo)
        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")
        atomic_write_text(os.path.join(self.repo, "README.md"), "hello\n")
        atomic_write_text(os.path.join(self.repo, "AGENTS.md"), "test repo\n")
        self.git("add", ".")
        self.git("commit", "-m", "init")
        self.git("remote", "add", "origin", "https://github.com/example/yuvi-test.git")

    def git(self, *args: str, cwd: str | None = None) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd or self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr or result.stdout)
        return result.stdout.strip()

    def commit_file(self, rel: str, content: str, message: str, cwd: str | None = None) -> str:
        path = os.path.join(cwd or self.repo, rel)
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        atomic_write_text(path, content)
        root = cwd or self.repo
        self.git("add", rel, cwd=root)
        self.git("commit", "-m", message, cwd=root)
        return self.git("rev-parse", "HEAD", cwd=root)

    def _write_fakes(self) -> None:
        gh = r'''#!/usr/bin/env python3
import json, os, sys
mode = os.environ.get("FAKE_GH_MODE", "ok")
args = sys.argv[1:]
if args[:2] == ["pr", "create"]:
    if mode in {"down", "unauth"}:
        print("github unavailable", file=sys.stderr)
        sys.exit(1)
    print("https://github.com/example/yuvi-test/pull/99")
    sys.exit(0)
if args[:2] == ["pr", "list"]:
    if mode == "down":
        print("api down", file=sys.stderr)
        sys.exit(1)
    print("[]")
    sys.exit(0)
if args[:2] == ["pr", "merge"]:
    if os.environ.get("FAKE_GH_ALLOW_MERGE") != "1":
        print("auto-merge is forbidden in tests", file=sys.stderr)
        sys.exit(2)
    count_path = os.environ.get("FAKE_GH_MERGE_COUNT", "")
    if count_path:
        try:
            count = int(open(count_path).read() or "0")
        except Exception:
            count = 0
        open(count_path, "w").write(str(count + 1))
    comments_path = os.environ.get("FAKE_GH_COMMENTS", "")
    if os.environ.get("FAKE_GH_REQUIRE_FINAL_GATE") == "1":
        try:
            bodies = [item.get("body") or "" for item in json.loads(open(comments_path).read() or "[]")]
        except Exception:
            bodies = []
        if not any("[FINAL_GATE]" in body for body in bodies):
            print("FINAL_GATE missing before merge", file=sys.stderr)
            sys.exit(3)
    fail = os.environ.get("FAKE_GH_MERGE_FAIL", "")
    if fail == "timeout":
        print("network timeout", file=sys.stderr)
        sys.exit(1)
    if fail == "permanent":
        print("not mergeable: conflict", file=sys.stderr)
        sys.exit(1)
    state_path = os.environ.get("FAKE_GH_PR_STATE", "")
    if state_path:
        try:
            rec = json.loads(open(state_path).read() or "{}")
        except Exception:
            rec = {}
        rec["state"] = "MERGED"
        rec["mergeCommit"] = {"oid": rec.get("headRefOid") or ("m" * 40)}
        open(state_path, "w").write(json.dumps(rec))
    if fail == "timeout_after_merge":
        print("network timeout after merge", file=sys.stderr)
        sys.exit(1)
    print("MERGED")
    sys.exit(0)
if args[:2] == ["pr", "ready"]:
    if mode in {"down", "unauth"}:
        print("github unavailable", file=sys.stderr)
        sys.exit(1)
    state_path = os.environ.get("FAKE_GH_PR_STATE", "")
    rec = {}
    if state_path and os.path.isfile(state_path):
        try:
            rec = json.loads(open(state_path).read() or "{}")
        except Exception:
            rec = {}
    rec["isDraft"] = False
    if state_path:
        open(state_path, "w").write(json.dumps(rec))
    count_path = os.environ.get("FAKE_GH_READY_COUNT", "")
    if count_path:
        try:
            count = int(open(count_path).read() or "0")
        except Exception:
            count = 0
        open(count_path, "w").write(str(count + 1))
    print("PR marked ready")
    sys.exit(0)
if mode == "missing":
    sys.exit(127)
if args[:2] == ["auth", "status"]:
    if mode == "unauth":
        print("You are not logged into any GitHub hosts.", file=sys.stderr)
        sys.exit(1)
    print("Logged in")
    sys.exit(0)
if args[:2] == ["pr", "view"]:
    if mode in {"down", "unauth"}:
        print("github unavailable", file=sys.stderr)
        sys.exit(1)
    state_path = os.environ.get("FAKE_GH_PR_STATE", "")
    rec = {}
    if state_path and os.path.isfile(state_path):
        try:
            rec = json.loads(open(state_path).read() or "{}")
        except Exception:
            rec = {}
    print(json.dumps({
        "number": int(args[2]),
        "title": rec.get("title") or "Test PR",
        "headRefName": rec.get("headRefName") or "codex/test-branch",
        "headRefOid": rec.get("headRefOid") or os.environ.get("FAKE_GH_HEAD") or ("0" * 40),
        "baseRefName": rec.get("baseRefName") or "main",
        "baseRefOid": rec.get("baseRefOid") or ("b" * 40),
        "state": rec.get("state") or "OPEN",
        "isDraft": rec.get("isDraft"),
        "url": "https://github.com/example/yuvi-test/pull/" + args[2],
        "statusCheckRollup": rec.get("statusCheckRollup") or [],
        "mergeable": rec.get("mergeable", "MERGEABLE"),
        "mergeStateStatus": rec.get("mergeStateStatus") or "CLEAN",
        "mergeCommit": rec.get("mergeCommit"),
    }))
    sys.exit(0)
if args[:1] == ["api"] and any("/branches/" in str(a) for a in args):
    if mode in {"down", "unauth"}:
        print("api down", file=sys.stderr)
        sys.exit(1)
    state_path = os.environ.get("FAKE_GH_PR_STATE", "")
    rec = {}
    if state_path and os.path.isfile(state_path):
        try:
            rec = json.loads(open(state_path).read() or "{}")
        except Exception:
            rec = {}
    sha = os.environ.get("FAKE_GH_LIVE_BASE_SHA") or rec.get("liveBaseRefOid") or rec.get("baseRefOid") or ("b" * 40)
    print(json.dumps({"name": "main", "commit": {"sha": sha}}))
    sys.exit(0)
if args[:1] == ["api"] and any("comments" in str(a) for a in args):
    if mode == "down":
        print("api down", file=sys.stderr)
        sys.exit(1)
    path = os.environ.get("FAKE_GH_COMMENTS", "")
    posting = "--method" in args and "POST" in args
    if posting:
        raw = sys.stdin.read() if "--input" in args else ""
        try:
            payload = json.loads(raw or "{}")
        except Exception:
            payload = {}
        comment = {"id": 555001, "body": payload.get("body") or "", "html_url": "https://github.com/example/yuvi-test/pull/99#issuecomment-555001"}
        existing = []
        if path and os.path.isfile(path):
            try:
                existing = json.loads(open(path).read() or "[]")
            except Exception:
                existing = []
        if not isinstance(existing, list):
            existing = []
        if not any(str(item.get("id")) == "555001" for item in existing if isinstance(item, dict)):
            existing.append(comment)
        if path:
            open(path, "w").write(json.dumps(existing))
        print(json.dumps(comment))
        sys.exit(0)
    if path and os.path.isfile(path):
        sys.stdout.write(open(path).read())
    else:
        print("[]")
    sys.exit(0)
if args[:2] == ["pr", "comment"]:
    if mode == "down":
        sys.exit(1)
    posted = os.environ.get("FAKE_GH_POSTED", "")
    if posted:
        open(posted, "a").write("COMMENT\n")
    sys.exit(0)
print("unexpected", args, file=sys.stderr)
sys.exit(1)
'''
        codex = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if args[:1] == ["--version"] or "--version" in args:
    print("codex-cli 0.0.0-test")
    sys.exit(0)
if args[:2] == ["features", "list"]:
    print("collaboration_modes                  removed            false")
    print("multi_agent                          stable             false")
    sys.exit(0)
if args[:2] == ["exec", "--help"] or (len(args) >= 2 and args[0] == "exec" and "--help" in args):
    print("Usage: codex exec [OPTIONS]")
    sys.exit(0)
out = None
cwd = os.getcwd()
for i, a in enumerate(args):
    if a == "-o" and i + 1 < len(args):
        out = args[i + 1]
    if a == "--cd" and i + 1 < len(args):
        cwd = args[i + 1]
if os.environ.get("FAKE_CODEX_CRASH") == "1":
    print("codex exploded", file=sys.stderr)
    sys.exit(99)
slot = "secondary" if os.environ.get("CODEX_HOME", "").endswith(".codex-secondary") else "primary"
invocations = os.environ.get("FAKE_CODEX_INVOCATIONS", "")
if invocations:
    with open(invocations, "a") as handle:
        handle.write(slot + " " + os.environ.get("CODEX_HOME", "") + "\n")
capacity_slot = os.environ.get("FAKE_CODEX_CAPACITY_SLOT", "")
if capacity_slot in {slot, "both"}:
    dirty_file = os.environ.get("FAKE_CODEX_CAPACITY_DIRTY_FILE", "")
    if dirty_file:
        with open(os.path.join(cwd, dirty_file), "a") as handle:
            handle.write("partial-from-" + slot + "\n")
    print("You have hit your Codex usage limit; retry after 15 minutes", file=sys.stderr)
    sys.exit(91)
kind = os.environ.get("FAKE_CODEX_KIND", "CODEX_REPORT")
status = os.environ.get("FAKE_CODEX_STATUS", "READY_FOR_AUDIT")
head = os.popen(f"git -C {cwd} rev-parse HEAD").read().strip()
stream = os.environ.get("FAKE_CODEX_STREAM", "p7-9a")
if kind == "CODEX_REPORT":
    body = f"""[{kind}]

STATUS: {status}

STREAM: {stream}

IMPLEMENTED_HEAD: {head}

CHANGED_FILES: README.md

VALIDATION: ok

DEVIATIONS: None

KNOWN_RISKS: None

NEXT_ACTION: AUDIT
"""
    extra = os.environ.get("FAKE_CODEX_COMMIT")
    if extra:
        mode = "a" if os.path.exists(os.path.join(cwd, extra)) else "w"
        with open(os.path.join(cwd, extra), mode) as handle:
            handle.write("continued-by-" + slot + "\n")
        # Codex must not commit. AgentBus publishes on the host.
        body = f"""[{kind}]

STATUS: {status}

STREAM: {stream}

IMPLEMENTED_HEAD: {head}

CHANGED_FILES: {extra}

VALIDATION: ok

DEVIATIONS: None

KNOWN_RISKS: None

NEXT_ACTION: AUDIT
"""
elif kind == "CODEX_AUDIT":
    body = f"""[{kind}]

STATUS: {status}

STREAM: {stream}

AUDITED_HEAD: {head}

FINDINGS: {os.environ.get("FAKE_CODEX_FINDINGS", "None blocking.")}

RESIDUAL_RISKS: None

NEXT_ACTION: READY_FOR_GPT
"""
else:
    body = f"[{kind}]\n\nSTATUS: {status}\n\nSTREAM: {stream}\n"
print("fake-codex running")
if out:
    open(out, "w").write(body)
if os.environ.get("FAKE_CODEX_EXIT_CAPACITY_AFTER_MESSAGE") == "1":
    print("You have hit your Codex usage limit; retry after 15 minutes", file=sys.stderr)
    sys.exit(91)
sys.exit(0)
'''
        konsole = r'''#!/usr/bin/env python3
# The AgentBus test harness must not open a real desktop window.
import sys
sys.exit(0)
'''
        for name, body in (("gh", gh), ("codex", codex), ("konsole", konsole)):
            path = os.path.join(self.bin, name)
            atomic_write_text(path, body)
            os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)

    def agentctl(self, *args: str) -> subprocess.CompletedProcess[str]:
        argv = list(args)
        if "--repo" not in argv:
            argv = ["--repo", self.repo, *argv]
        code = 0
        from io import StringIO
        from contextlib import redirect_stdout, redirect_stderr

        stdout = StringIO()
        stderr = StringIO()
        try:
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = main(argv)
        except SystemExit as exc:
            code = int(exc.code or 0)
        result = subprocess.CompletedProcess(argv, code, stdout.getvalue(), stderr.getvalue())
        return result

    def ok(self, *args: str) -> str:
        result = self.agentctl(*args)
        if result.returncode != 0:
            self.fail(f"agentctl {args} failed ({result.returncode}): {result.stderr}\n{result.stdout}")
        return result.stdout

    def store(self, stream: str) -> StreamStore:
        return StreamStore(self.ctx, stream)

    def create_stream(self, stream: str, *args: str) -> str:
        extra = list(args)
        if "--worktree" not in extra and "--create-worktree" not in extra:
            extra.extend(["--worktree", self.repo])
        return self.ok("create", stream, *extra)

    def spec_text(self, stream: str, head: str, status: str = "ACTIONABLE") -> str:
        return f"""[GPT_SPEC]

STATUS: {status}

STREAM: {stream}

GOAL: test goal

TARGET: README.md

BASE_HEAD: {head}

SCOPE:
- change a file

OUT_OF_SCOPE:
- rewrite the product

ACCEPTANCE_CRITERIA:
- tests pass

ARCHITECTURAL_CONSTRAINTS:
- none

REQUIRED_VALIDATION:
- none

NEXT_ACTION:
IMPL
"""
