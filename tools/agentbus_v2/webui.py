"""Small loopback-only operational WebUI for AgentBus v2."""

from __future__ import annotations

from collections import deque
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import secrets
import tempfile
import threading
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

from .core import ActionKind, decide
from .control import (
    control_route_view,
    load_control_config,
    set_control_config,
)
from .control_supervisor import operational_view
from .block_diagnosis import (
    BLOCK_OPERATION,
    BlockGPTConfig,
    block_view,
    load_block_config,
    set_block_config,
)
from .effects import submit_gpt_response
from .executor_pool import list_executor_accounts, list_grok_executors, worktree_execution_lock
from .facts import (
    FactError,
    add_operator_directive,
    canonical_repository,
    git,
    init_p,
    load_config,
    load_operator_directive,
    paths_for,
    read_snapshot,
    sha256_text,
)
from .legacy_v1_browser_compat import (
    LegacyV1BrowserCompat,
    LegacyCompatConfig,
    load_compat_config,
    set_global_judge_conversation,
)
from .scheduler import (
    ProjectEntry,
    Scheduler,
    SchedulerEvent,
    archive_project,
    load_registry,
    pending_gpt_action,
    register_project,
    remove_project,
    set_plan_conversation_binding,
    update_project,
)


LOGGER = logging.getLogger(__name__)
DEFAULT_WEB_HOST = "127.0.0.1"
DEFAULT_WEB_PORT = 6738
MAX_REQUEST_BYTES = 1_000_000
SIGNED_V1_COMPAT_TRANSPORT = "SIGNED_V1_EXTENSION_COMPAT"
AUTO_WARNING = (
    "Automatic signed-extension transport is active for this exact job. "
    "Do not manually submit the same result unless recovering from a confirmed "
    "transport failure."
)


def _charter_summary(paths) -> str:
    try:
        charter = (paths.root / "charter.md").read_text(encoding="utf-8")
    except OSError:
        return ""
    lines = [line.strip() for line in charter.splitlines() if line.strip()]
    if not lines:
        return ""
    summary = lines[0].lstrip("# ").strip()
    return summary if len(summary) <= 180 else summary[:177] + "…"


def _worktree_observation(
    worktree: str, *, expected_branch: str | None = None,
    expected_repository: str | None = None, remote: str = "origin",
) -> tuple[bool | None, str | None]:
    try:
        root = Path(git(Path(worktree), "rev-parse", "--show-toplevel"))
        if expected_branch is not None:
            actual_branch = git(root, "branch", "--show-current")
            if actual_branch != expected_branch:
                return False, f"PR_IDENTITY_MISMATCH: branch expected {expected_branch}, found {actual_branch}"
        if expected_repository is not None:
            actual_repository = canonical_repository(git(root, "remote", "get-url", remote))
            if actual_repository != canonical_repository(expected_repository):
                return False, f"PR_IDENTITY_MISMATCH: repository expected {expected_repository}, found {actual_repository}"
        dirty = git(root, "status", "--porcelain=v1")
        return (not bool(dirty), None)
    except (FactError, OSError) as error:
        return None, str(error)


def _human_status(
    entry: ProjectEntry,
    snapshot,
    action,
    delivery,
    transport: dict[str, object] | None,
    *,
    in_flight: bool,
    worktree_clean: bool | None,
    worktree_error: str | None,
    scheduler_status: dict[str, object],
) -> dict[str, object]:
    """Pure operator projection; none of these values are durable facts."""
    if entry.archived:
        return {"status": "已归档", "status_code": "ARCHIVED", "block_reason": "任务已归档",
                "next_wait": "取消归档后再启用", "attention": False}
    if worktree_clean is False:
        if worktree_error and worktree_error.startswith("PR_IDENTITY_MISMATCH:"):
            return {"status": "安全栅栏阻止继续", "status_code": "PR_IDENTITY_MISMATCH",
                    "block_reason": worktree_error.removeprefix("PR_IDENTITY_MISMATCH: ").strip(),
                    "next_wait": "恢复准确的 PR/branch identity", "attention": True}
        return {"status": "已阻塞", "status_code": "DIRTY_WORKTREE",
                "block_reason": "工作树存在未提交修改", "next_wait": "清理工作树并重新刷新",
                "attention": True}
    if worktree_error:
        return {"status": "安全栅栏阻止继续", "status_code": "WORKTREE_UNAVAILABLE",
                "block_reason": worktree_error, "next_wait": "检查工作树", "attention": True}
    if snapshot is None:
        return {"status": "安全栅栏阻止继续", "status_code": "FACTS_ERROR",
                "block_reason": "无法读取当前 durable facts", "next_wait": "查看日志/证据",
                "attention": True}
    if not snapshot.repository_available:
        return {"status": "等待仓库可用", "status_code": "REPOSITORY_UNAVAILABLE",
                "block_reason": "无法读取当前 remote BASE / repository facts",
                "next_wait": "检查 repository 与 remote", "attention": True}
    if transport is not None and transport.get("state") == "AWAITING_PLAN_BINDING":
        return {"status": "等待 PLAN 会话绑定", "status_code": "AWAITING_PLAN_BINDING",
                "block_reason": "该 P 尚未绑定独立 PLAN conversation", "next_wait": "绑定 PLAN 会话",
                "attention": True}
    if delivery is not None and transport is not None:
        state = str(transport.get("state", ""))
        if state == "GPT_PACKET_OVERSIZE":
            size = transport.get("rendered_packet_bytes")
            budget = transport.get("packet_budget_bytes")
            return {"status": "GPT 请求过大，未发送", "status_code": state,
                    "block_reason": f"渲染 packet {size} bytes 超过预算 {budget} bytes",
                    "next_wait": "缩减传输证据后重新检查", "attention": True}
        if state in {"WAITING_FOR_BROWSER", "AUTO_QUEUED"}:
            op = str(transport.get("operation", "PLAN_GPT"))
            served = bool(transport.get("served_to_extension"))
            return {"status": f"等待 {op} 浏览器提交", "status_code": state,
                "block_reason": (
                    "扩展已获取任务，但服务器没有 Send/提交确认"
                    if served else
                    "请求已存在，尚未观察到扩展提交"
                ),
                "next_wait": "等待浏览器提交", "attention": False}
        # Older in-memory/server callers may still provide the removed
        # waiting-mailbox label.  Treat it conservatively: it is not
        # evidence of a browser Send, so project it as browser waiting.
        if state == "WAITING_FOR_MAILBOX":
            op = str(transport.get("operation", "GPT"))
            return {"status": f"等待 {op} 浏览器提交", "status_code": "WAITING_FOR_BROWSER",
                    "block_reason": "服务器没有观察到 Send/提交确认",
                    "next_wait": "等待浏览器提交", "attention": False}
        if state in {"TRANSPORT_OFFLINE", "TRANSPORT_ERROR"}:
            return {"status": "浏览器传输异常", "status_code": state,
                    "block_reason": str(transport.get("last_error") or "signed v1 extension 或 mailbox 不可用"),
                    "next_wait": "检查浏览器传输", "attention": True}
    if action.kind is ActionKind.WORK:
        if in_flight:
            return {"status": "执行器正在工作", "status_code": "WORK_RUNNING",
                    "block_reason": "", "next_wait": "等待 WORK 完成", "attention": False}
        return {"status": "等待执行器", "status_code": "WAITING_EXECUTOR",
                "block_reason": "当前尚未取得 executor", "next_wait": "等待执行器可用",
                "attention": True}
    if action.kind is ActionKind.PROVE:
        failed = next((item for item in reversed(snapshot.proof_facts)
                       if item.status.value == "FAIL"), None)
        if failed is not None:
            reason = failed.summary.strip() or "PROVE 返回 FAIL"
            return {"status": "验证失败", "status_code": "PROVE_FAILED",
                    "block_reason": reason[:500], "next_wait": "等待 JUDGE 决策", "attention": True}
        return {"status": "等待验证", "status_code": "PROVE", "block_reason": "",
                "next_wait": "执行 PROVE", "attention": False}
    if action.kind is ActionKind.HUMAN and "WAIT" in action.reason.upper():
        return {"status": "等待外部条件", "status_code": "WAIT",
                "block_reason": action.reason or "等待外部条件", "next_wait": "等待外部条件变化",
                "attention": True}
    if action.kind is ActionKind.HUMAN:
        return {"status": "需要人工处理", "status_code": "HUMAN",
                "block_reason": action.reason or "语义流程请求人工决定", "next_wait": "按要求处理后重新刷新",
                "attention": True}
    if action.kind in {ActionKind.MERGE, ActionKind.MERGE_READY} and not entry.allow_merge:
        return {"status": "已完成，等待允许合并", "status_code": "MERGE_READY",
                "block_reason": "允许合并当前关闭", "next_wait": "确认后再单独打开允许合并",
                "attention": True}
    if str(getattr(action.kind, "value", action.kind)) == "WAIT":
        return {"status": "等待外部条件", "status_code": "WAIT",
                "block_reason": action.reason or "等待外部条件", "next_wait": "等待外部条件变化",
                "attention": True}
    if action.kind is ActionKind.IDLE:
        return {"status": "等待下一次检查", "status_code": "IDLE",
                "block_reason": action.reason or "当前没有可执行 effect", "next_wait": "刷新或立即检查",
                "attention": False}
    return {"status": action.kind.value, "status_code": action.kind.value,
            "block_reason": action.reason or "", "next_wait": "等待下一步", "attention": False}


def _primary_action_for(project: dict[str, object]) -> dict[str, object] | None:
    """Derive one presentation-only primary CTA from the current projection."""
    code = str(project.get("status_code", ""))
    if code == "AWAITING_PLAN_BINDING":
        return {"key": "bind-plan", "label": "绑定 PLAN 会话", "style": "primary"}
    if code == "CONTROL_SIMPLIFY_RECOMMENDED":
        return {"key": "request-simplify-replan", "label": "请求 PLAN 简化", "style": "primary"}
    if code == "HUMAN":
        return {"key": "show-human", "label": "查看人工要求", "style": "primary"}
    if code == "MERGE_READY" and not bool(project.get("allow_merge")):
        return {"key": "allow-merge", "label": "允许合并", "style": "primary"}
    if not bool(project.get("enabled")) and not bool(project.get("archived")):
        return {"key": "enable", "label": "启用", "style": "primary"}
    return None


class WebUIError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class WebUIState:
    """Owns only ephemeral UI/scheduler resources and registry mutations."""

    def __init__(
        self,
        state_root: Path,
        *,
        registry_path: Path | None = None,
        legacy_browser_compat: LegacyV1BrowserCompat | None = None,
    ) -> None:
        self.state_root = Path(state_root).resolve()
        self.registry_file = (
            Path(registry_path).resolve()
            if registry_path is not None
            else self.state_root / "projects.json"
        )
        self.token = secrets.token_urlsafe(24)
        self._lock = threading.RLock()
        self._lifecycle_lock = threading.Lock()
        self._events: deque[SchedulerEvent] = deque(maxlen=100)
        self._scheduler = self._new_scheduler()
        self._scheduler_thread: threading.Thread | None = None
        self.legacy_browser_compat = legacy_browser_compat or LegacyV1BrowserCompat(
            self.state_root,
            registry_path=self.registry_file,
        )

    def _new_scheduler(self) -> Scheduler:
        return Scheduler(self.state_root, registry_path=self.registry_file)

    @property
    def scheduler(self) -> Scheduler:
        with self._lock:
            return self._scheduler

    def _record_event(self, event: SchedulerEvent) -> None:
        with self._lock:
            self._events.append(event)

    def _scheduler_loop(self, scheduler: Scheduler) -> None:
        scheduler.run(on_event=self._record_event)

    def start_scheduler(self) -> bool:
        with self._lifecycle_lock:
            with self._lock:
                if self._scheduler_thread is not None and self._scheduler_thread.is_alive():
                    return False
                self._scheduler = self._new_scheduler()
                # Fail the HTTP mutation synchronously for an invalid registry;
                # do not report a scheduler that immediately dies in a thread.
                self._scheduler.status()
                thread = threading.Thread(
                    target=self._scheduler_loop,
                    args=(self._scheduler,),
                    name="agentbus-v2-scheduler",
                    daemon=True,
                )
                self._scheduler_thread = thread
                thread.start()
                return True

    def stop_scheduler(self) -> bool:
        with self._lifecycle_lock:
            with self._lock:
                scheduler = self._scheduler
                thread = self._scheduler_thread
            scheduler.stop()
            if thread is not None:
                thread.join(timeout=3)
            return thread is None or not thread.is_alive()

    def scheduler_status(self) -> dict[str, object]:
        with self._lock:
            scheduler = self._scheduler
            thread = self._scheduler_thread
        status = scheduler.status()
        status["running"] = bool(thread is not None and thread.is_alive() and status["running"])
        return status

    def registry(self):
        return load_registry(self.state_root, self.registry_file)

    def project(self, p_id: str) -> ProjectEntry:
        entry = next((item for item in self.registry().entries if item.p_id == p_id), None)
        if entry is None:
            raise WebUIError(404, f"unknown registered P: {p_id}")
        return entry

    def set_enabled(self, p_id: str, enabled: bool) -> ProjectEntry:
        current = self.project(p_id)
        if enabled and current.archived:
            raise WebUIError(409, "已归档的 P 不能启用，请先取消归档")
        result = update_project(
            self.state_root, p_id, enabled=enabled, path=self.registry_file
        )
        return next(item for item in result.entries if item.p_id == p_id)

    def set_allow_merge(self, p_id: str, allow_merge: bool) -> ProjectEntry:
        result = update_project(
            self.state_root, p_id, allow_merge=allow_merge, path=self.registry_file
        )
        return next(item for item in result.entries if item.p_id == p_id)

    def _assert_control_safe(self, entry: ProjectEntry) -> None:
        if entry.enabled:
            raise WebUIError(409, "请先暂停该 P，再执行此控制操作")
        if self.scheduler.is_in_flight(entry.p_id):
            raise WebUIError(409, "该 P 当前仍有 scheduler effect in flight")
        try:
            paths = paths_for(self.state_root, entry.p_id)
            config = load_config(paths)
            snapshot = read_snapshot(paths, allow_merge=entry.allow_merge)
            if snapshot.gpt_pending:
                raise WebUIError(409, "该 P 仍有未完成的 exact GPT effect，暂不能归档或移出")
            with worktree_execution_lock(self.state_root, config.worktree) as acquired:
                if not acquired:
                    raise WebUIError(409, "该 P 当前由 WORK executor 占用")
        except WebUIError:
            raise
        except (FactError, OSError) as error:
            raise WebUIError(409, f"无法确认该 P 安全状态：{error}") from error

    def archive_p(self, p_id: str, archived: bool = True) -> ProjectEntry:
        entry = self.project(p_id)
        if archived:
            self._assert_control_safe(entry)
        try:
            result = archive_project(
                self.state_root, p_id, archived=archived, path=self.registry_file
            )
        except FactError as error:
            raise WebUIError(409, str(error)) from error
        return next(item for item in result.entries if item.p_id == p_id)

    def remove_p(self, p_id: str) -> None:
        entry = self.project(p_id)
        self._assert_control_safe(entry)
        try:
            remove_project(self.state_root, p_id, path=self.registry_file)
        except FactError as error:
            raise WebUIError(409, str(error)) from error

    def create_p(self, payload: dict[str, object]) -> ProjectEntry:
        required = {"p_id", "charter", "repository", "base_ref", "worktree", "branch"}
        if set(payload) - required - {"remote", "proof_commands", "required_ci_checks"}:
            raise WebUIError(400, "新建任务包含未知字段")
        if any(type(payload.get(key)) is not str or not str(payload[key]).strip()
               for key in required):
            raise WebUIError(400, "P_ID、任务说明、repository、base branch、worktree、branch 均不能为空")
        proof = payload.get("proof_commands", [])
        checks = payload.get("required_ci_checks", [])
        if not isinstance(proof, list) or not isinstance(checks, list):
            raise WebUIError(400, "proof_commands 和 required_ci_checks 必须是列表")
        if any(not isinstance(command, list) or not command or
               any(type(arg) is not str for arg in command) for command in proof):
            raise WebUIError(400, "proof_commands 必须是非空 argv 列表")
        if any(type(check) is not str for check in checks):
            raise WebUIError(400, "required_ci_checks 必须是字符串列表")
        try:
            init_p(
                self.state_root,
                p_id=str(payload["p_id"]),
                charter_text=str(payload["charter"]),
                worktree=Path(str(payload["worktree"])),
                repository=str(payload["repository"]),
                branch=str(payload["branch"]),
                base_ref=str(payload["base_ref"]),
                remote=str(payload.get("remote", "origin")),
                proof_commands=tuple(tuple(str(arg) for arg in command) for command in proof),
                required_ci_checks=tuple(str(check) for check in checks),
            )
            register_project(
                self.state_root,
                ProjectEntry(str(payload["p_id"]), enabled=False, allow_merge=False),
                path=self.registry_file,
            )
        except (FactError, OSError, ValueError) as error:
            raise WebUIError(422, str(error)) from error
        return self.project(str(payload["p_id"]))

    def adopt_pr(self, payload: dict[str, object]) -> ProjectEntry:
        required = {"p_id", "charter", "repository", "pr_number", "worktree", "branch", "base_ref"}
        if set(payload) - required - {"remote", "proof_commands", "required_ci_checks"}:
            raise WebUIError(400, "接管现有 PR 包含未知字段")
        if any(type(payload.get(key)) is not str or not str(payload[key]).strip()
               for key in required - {"pr_number"}):
            raise WebUIError(400, "接管现有 PR 的文本字段均不能为空")
        if type(payload.get("pr_number")) is not int or int(payload["pr_number"]) <= 0:
            raise WebUIError(400, "pr_number 必须是正整数")
        proof = payload.get("proof_commands", [])
        checks = payload.get("required_ci_checks", [])
        if not isinstance(proof, list) or not isinstance(checks, list):
            raise WebUIError(400, "proof_commands 和 required_ci_checks 必须是列表")
        if any(not isinstance(command, list) or not command or
               any(type(arg) is not str for arg in command) for command in proof):
            raise WebUIError(400, "proof_commands 必须是非空 argv 列表")
        if any(type(check) is not str for check in checks):
            raise WebUIError(400, "required_ci_checks 必须是字符串列表")
        try:
            from .github import adopt_existing_pr

            adopt_existing_pr(
                self.state_root,
                p_id=str(payload["p_id"]),
                charter_text=str(payload["charter"]),
                worktree=Path(str(payload["worktree"])),
                repository=str(payload["repository"]),
                pr_number=int(payload["pr_number"]),
                branch=str(payload["branch"]),
                base_ref=str(payload["base_ref"]),
                remote=str(payload.get("remote", "origin")),
                proof_commands=tuple(tuple(str(arg) for arg in command) for command in proof),
                required_ci_checks=tuple(str(check) for check in checks),
                registry=self.registry_file,
            )
            # Adoption must never silently enable execution or merge.  The
            # adoption primitive owns immutable facts/PR markers; registry
            # membership is a separate explicit control-plane mutation.
            register_project(
                self.state_root,
                ProjectEntry(str(payload["p_id"]), enabled=False, allow_merge=False),
                path=self.registry_file,
            )
        except (FactError, OSError, ValueError) as error:
            raise WebUIError(422, str(error)) from error
        return self.project(str(payload["p_id"]))

    def set_plan_binding(self, p_id: str, conversation_url: str) -> ProjectEntry:
        try:
            result = set_plan_conversation_binding(
                self.state_root, p_id, conversation_url, path=self.registry_file
            )
        except FactError as error:
            raise WebUIError(422, str(error)) from error
        return next(item for item in result.entries if item.p_id == p_id)

    def set_judge_binding(self, conversation_url: str) -> LegacyCompatConfig:
        """Update only the operational global JUDGE transport binding."""
        try:
            return set_global_judge_conversation(self.state_root, conversation_url)
        except (FactError, TypeError, ValueError) as error:
            raise WebUIError(422, str(error)) from error

    def block_config(self) -> BlockGPTConfig:
        return load_block_config(self.state_root)

    def set_block_binding(self, conversation_url: str) -> BlockGPTConfig:
        try:
            return set_block_config(
                self.state_root,
                conversation_url=conversation_url,
                update_url=True,
            )
        except FactError as error:
            raise WebUIError(422, str(error)) from error

    def set_block_enabled(self, enabled: bool) -> BlockGPTConfig:
        try:
            return set_block_config(self.state_root, enabled=enabled)
        except FactError as error:
            raise WebUIError(422, str(error)) from error

    def control_config(self):
        try:
            return load_control_config(self.state_root)
        except FactError as error:
            raise WebUIError(422, str(error)) from error

    def set_control_binding(self, conversation_url: str):
        try:
            return set_control_config(
                self.state_root,
                conversation_url=conversation_url,
                update_url=True,
            )
        except FactError as error:
            raise WebUIError(422, str(error)) from error

    def set_control_enabled(self, enabled: bool):
        try:
            return set_control_config(self.state_root, enabled=enabled)
        except FactError as error:
            raise WebUIError(422, str(error)) from error

    def add_plan_directive(
        self, p_id: str, text: str, *, request_replan: bool = False
    ) -> dict[str, object]:
        entry = self.project(p_id)
        paths = paths_for(self.state_root, p_id)
        snapshot = read_snapshot(paths, allow_merge=entry.allow_merge)
        if snapshot.specs and not request_replan:
            raise WebUIError(409, "已有 CURRENT_SPEC，请使用要求重新规划")
        parent_spec_id = snapshot.specs[-1].spec_id if snapshot.specs else None
        if request_replan or snapshot.specs:
            if entry.enabled:
                raise WebUIError(409, "要求重新规划前必须先暂停该 P")
            if self.scheduler.is_in_flight(p_id):
                raise WebUIError(409, "该 P 当前仍有 scheduler effect in flight")
            try:
                with worktree_execution_lock(self.state_root, load_config(paths).worktree) as acquired:
                    if not acquired:
                        raise WebUIError(409, "该 P 当前由 WORK executor 占用")
            except WebUIError:
                raise
        try:
            directive, changed = add_operator_directive(
                paths, snapshot, text, parent_spec_id=parent_spec_id
            )
        except FactError as error:
            raise WebUIError(422, str(error)) from error
        return {
            "p_id": p_id,
            "directive_id": directive.directive_id,
            "changed": changed,
            "request_replan": request_replan,
        }

    def tick_now(self, p_id: str) -> dict[str, object]:
        entry = self.project(p_id)
        if entry.archived:
            raise WebUIError(409, "已归档的 P 不能执行 Tick")
        scheduler = self.scheduler
        if scheduler.is_in_flight(p_id):
            raise WebUIError(409, f"P is already in flight: {p_id}")
        callback: Callable[[SchedulerEvent], None] | None = None
        if not scheduler.is_running():
            callback = self._record_event
        try:
            scheduler.submit_now(p_id, on_event=callback)
        except RuntimeError as error:
            raise WebUIError(409, str(error)) from error
        return {"accepted": True, "p_id": p_id, "in_flight": True}

    def _latest_detail(self, p_id: str) -> str:
        with self._lock:
            for event in reversed(self._events):
                if event.p_id == p_id:
                    return event.error or event.detail
        return ""

    @staticmethod
    def _manual_packet(paths, action) -> dict[str, object] | None:
        if action.kind not in {ActionKind.PLAN, ActionKind.JUDGE} or not action.effect_id:
            return None
        packet = paths.root / "gpt" / "outbox" / f"{action.effect_id}.md"
        packet_sha256: str | None = None
        try:
            if packet.exists():
                packet_sha256 = sha256_text(packet.read_text(encoding="utf-8"))
        except OSError:
            pass
        operation = "PLAN_GPT" if action.kind is ActionKind.PLAN else "JUDGE_GPT"
        return {
            "operation": operation,
            "job_id": action.effect_id,
            "packet_path": str(packet),
            "packet_sha256": packet_sha256,
            "instruction": f"Return the exact JSON response for {operation} job {action.effect_id}.",
        }

    @staticmethod
    def _gpt_transport_projection(
        browser_status: dict[str, object],
        operation: str,
        job_id: str,
        manual_fallback: dict[str, object] | None,
        *,
        result_received: bool = False,
        decision: str | None = None,
    ) -> dict[str, object]:
        """Build a presentation-only GPT transport projection.

        The compatibility status is operational telemetry.  It never changes
        the semantic action or creates a durable transport state.
        """
        configured = (
            browser_status.get("configured") is True
            and browser_status.get("transport_mode") == SIGNED_V1_COMPAT_TRANSPORT
        )
        lane = "plan" if operation == "PLAN_GPT" else "judge"
        lane_status = browser_status.get(lane)
        if not isinstance(lane_status, dict):
            lane_status = {}
        extension = browser_status.get("legacy_v1_extension", "UNKNOWN")
        mailbox = browser_status.get("mailbox", "UNKNOWN")
        packet_error_rows = browser_status.get("packet_errors", [])
        if not isinstance(packet_error_rows, (list, tuple)):
            packet_error_rows = ()
        packet_error = next(
            (
                item for item in packet_error_rows
                if isinstance(item, dict) and item.get("job_id") == job_id
            ),
            None,
        )
        if result_received:
            mode = "AUTO" if configured else "MANUAL"
            transport = (
                SIGNED_V1_COMPAT_TRANSPORT if configured else "MANUAL_FALLBACK"
            )
            state = "RESULT_RECEIVED"
        elif not configured:
            mode = "MANUAL"
            transport = "MANUAL_FALLBACK"
            state = "MANUAL_FALLBACK"
        else:
            mode = "AUTO"
            transport = SIGNED_V1_COMPAT_TRANSPORT
            if packet_error is not None:
                state = "GPT_PACKET_OVERSIZE"
            elif extension != "ONLINE":
                state = "TRANSPORT_OFFLINE"
            elif mailbox == "unavailable" or browser_status.get("last_error"):
                state = "TRANSPORT_ERROR"
            elif lane_status.get("state") in {"waiting-mailbox", "waiting-browser", "pending"}:
                state = "WAITING_FOR_BROWSER"
            else:
                state = "AUTO_QUEUED"
        job_rows = browser_status.get("jobs", [])
        if not isinstance(job_rows, (list, tuple)):
            job_rows = ()
        job_telemetry = next(
            (
                item for item in job_rows
                if isinstance(item, dict) and item.get("job_id") == job_id
            ),
            None,
        )
        projection: dict[str, object] = {
            "operation": operation,
            "mode": mode,
            "transport": transport,
            "state": state,
            "job_id": job_id,
            "semantic_job_id": job_id,
            "browser_delivery_id": (
                job_telemetry.get("browser_delivery_id") if job_telemetry else None
            ),
            "extension": extension if configured else "NOT_CONFIGURED",
            "mailbox": mailbox if configured else "NOT_CONFIGURED",
            "last_poll": browser_status.get("last_poll") if configured else None,
            "last_error": browser_status.get("last_error") if configured else None,
            "manual_fallback": manual_fallback,
            "warning": AUTO_WARNING if configured and not result_received else None,
            # These are server-side observations only.  In particular,
            # served_to_extension never means that the extension clicked Send.
            "served_to_extension": bool(job_telemetry and job_telemetry.get("served_to_extension")),
            "first_server_serve": job_telemetry.get("first_server_serve") if job_telemetry else None,
            "last_server_serve": job_telemetry.get("last_server_serve") if job_telemetry else None,
        }
        if packet_error is not None:
            for key in (
                "rendered_packet_bytes", "packet_budget_bytes", "evidence_bytes",
                "evidence_truncated", "detail",
            ):
                projection[key] = packet_error.get(key)
        elif job_telemetry is not None:
            for key in (
                "rendered_packet_bytes", "packet_budget_bytes", "evidence_bytes",
                "evidence_truncated",
            ):
                if key in job_telemetry:
                    projection[key] = job_telemetry.get(key)
        if decision is not None:
            projection["decision"] = decision
        return projection

    @staticmethod
    def _awaiting_plan_binding_projection(
        operation: str, job_id: str, manual_fallback: dict[str, object] | None,
    ) -> dict[str, object]:
        return {
            "operation": operation,
            "mode": "WAITING",
            "transport": "PER_P_PLAN_BINDING",
            "state": "AWAITING_PLAN_BINDING",
            "job_id": job_id,
            "extension": "NOT_DISPATCHED",
            "mailbox": "NOT_DISPATCHED",
            "last_poll": None,
            "last_error": None,
            "manual_fallback": manual_fallback,
            "warning": "请先绑定该 P 的专用 PLAN 会话；不会使用全局 PLAN 会话。",
        }

    @staticmethod
    def _gpt_lane_projection(
        lane_status: tuple[dict[str, object], ...],
        browser_status: dict[str, object],
    ) -> tuple[dict[str, object], ...]:
        configured = (
            browser_status.get("configured") is True
            and browser_status.get("transport_mode") == SIGNED_V1_COMPAT_TRANSPORT
        )
        result: list[dict[str, object]] = []
        for row in lane_status:
            lane = str(row.get("name", ""))
            operation = "PLAN_GPT" if lane == "plan" else "JUDGE_GPT"
            lane_browser = browser_status.get(lane)
            lane_browser = lane_browser if isinstance(lane_browser, dict) else {}
            projected = dict(row)
            # Keep the internal ``transport`` field intact for diagnostics.
            # These fields describe the production projection shown to users.
            projected.update(
                {
                    "semantic_operation": operation,
                    "production_transport": (
                        SIGNED_V1_COMPAT_TRANSPORT if configured else "MANUAL_FALLBACK"
                    ),
                    "extension": browser_status.get(
                        "legacy_v1_extension", "NOT_CONFIGURED"
                    )
                    if configured
                    else "NOT_CONFIGURED",
                    "mailbox": browser_status.get("mailbox", "NOT_CONFIGURED")
                    if configured
                    else "NOT_CONFIGURED",
                    "pending_jobs": lane_browser.get("pending", 0),
                }
            )
            result.append(projected)
        return tuple(result)

    def _gpt_conversation_projection(
        self, registry, browser_status: dict[str, object] | None = None
    ) -> dict[str, object]:
        """Project operational GPT conversation ownership for the control plane."""
        try:
            compat = load_compat_config(self.state_root)
        except FactError as error:
            judge = {"bound": False, "conversation_url": None}
            compat_error: str | None = str(error)
        else:
            judge = {
                "bound": bool(compat.conversations.get("judge")),
                "conversation_url": compat.conversations.get("judge"),
            }
            compat_error = None
        try:
            block = load_block_config(self.state_root)
        except FactError as error:
            block_row = {
                "bound": False,
                "conversation_url": None,
                "auto_diagnosis_enabled": False,
            }
            block_error: str | None = str(error)
        else:
            block_row = {
                "bound": block.conversation_url is not None,
                "conversation_url": block.conversation_url,
                "auto_diagnosis_enabled": block.enabled,
            }
            block_error = None
        try:
            control = load_control_config(self.state_root)
            control_browser = (
                browser_status.get("control", {})
                if isinstance(browser_status, dict)
                else {}
            )
            control_row = {
                "enabled": control.enabled,
                "bound": control.conversation_url is not None,
                "conversation_url": control.conversation_url,
                "pending": int(control_browser.get("pending", 0)),
                "current_job_id": control_browser.get("current_job_id"),
            }
            control_error: str | None = None
        except FactError as error:
            control_row = {
                "enabled": False,
                "bound": False,
                "conversation_url": None,
                "pending": 0,
                "current_job_id": None,
            }
            control_error = str(error)
        plans = [
            {
                "p_id": entry.p_id,
                "bound": entry.plan_conversation_url is not None,
                "conversation_url": entry.plan_conversation_url,
            }
            for entry in registry.entries
            if entry.enabled and not entry.archived
        ]
        return {
            "judge": judge,
            "block": block_row,
            "control": control_row,
            "per_p_plan": plans,
            "error": compat_error or block_error or control_error,
        }

    def status(self) -> dict[str, object]:
        """Return a fresh, presentation-only operator projection."""
        registry = self.registry()
        scheduler_status = self.scheduler_status()
        gpt_transport = self.scheduler.gpt_transport
        browser_status = self.legacy_browser_compat.status()
        with self._lock:
            events = [event.as_dict() for event in self._events]
        projects: list[dict[str, object]] = []
        for entry in registry.entries:
            paths = paths_for(self.state_root, entry.p_id)
            in_flight = self.scheduler.is_in_flight(entry.p_id)
            projection: dict[str, object] = {
                "p_id": entry.p_id, "enabled": entry.enabled,
                "archived": entry.archived, "allow_merge": entry.allow_merge,
                "plan_binding": {"bound": entry.plan_conversation_url is not None,
                                  "conversation_url": entry.plan_conversation_url,
                                  "global_fallback": entry.global_plan_fallback},
                "operator_directive": None, "in_flight": in_flight,
                "action": "ERROR", "detail": self._latest_detail(entry.p_id),
                "head": None, "base": None, "spec_id": None,
                "charter_summary": _charter_summary(paths), "pr": None,
                "worktree": {"clean": None, "error": None},
                "semantic_status": "安全栅栏阻止继续", "status_code": "FACTS_ERROR",
                "block_reason": "尚未读取 durable facts", "next_wait": "刷新状态",
                "attention": True, "executor": None, "evidence": [],
                "manual_gpt": None, "gpt_transport": None,
                "operational_block": None, "block_gpt": None,
                "execution_route": None, "control": None,
            }
            try:
                directive = load_operator_directive(paths)
                if directive is not None:
                    projection["operator_directive"] = {
                        "directive_id": directive.directive_id, "text": directive.text,
                        "text_digest": directive.text_digest,
                    }
                config = load_config(paths)
                snapshot = read_snapshot(paths, allow_merge=entry.allow_merge)
                action = decide(snapshot)
                delivery = (action if action.kind in {ActionKind.PLAN, ActionKind.JUDGE}
                            else pending_gpt_action(paths, snapshot))
                projection.update({
                    "action": action.kind.value, "detail": projection["detail"] or action.reason,
                    "head": snapshot.head[:8], "base": snapshot.base[:8],
                    "spec_id": snapshot.specs[-1].spec_id if snapshot.specs else None,
                })
                clean, wt_error = _worktree_observation(
                    config.worktree, expected_branch=config.branch,
                    expected_repository=config.repository, remote=config.remote)
                projection["worktree"] = {"clean": clean, "error": wt_error}
                projection["charter_summary"] = _charter_summary(paths)
                if config.adopted_pr is not None:
                    projection["pr"] = {"number": config.adopted_pr.number,
                                         "branch": config.adopted_pr.head_branch,
                                         "base": config.adopted_pr.base_branch,
                                         "state": snapshot.merge.state if snapshot.merge.available else "UNKNOWN",
                                         "draft": snapshot.merge.draft if snapshot.merge.available else None}
                if delivery is not None:
                    packet = self._manual_packet(paths, delivery)
                    projection["manual_gpt"] = packet
                    if packet is not None:
                        packet["mode"] = gpt_transport.mode_for(delivery)
                        projection["gpt_transport"] = (
                            self._awaiting_plan_binding_projection(str(packet["operation"]), str(packet["job_id"]), packet)
                            if packet["operation"] == "PLAN_GPT" and entry.plan_conversation_url is None and not entry.global_plan_fallback
                            else self._gpt_transport_projection(browser_status, str(packet["operation"]), str(packet["job_id"]), packet)
                        )
                elif snapshot.gpt_results:
                    result = snapshot.gpt_results[-1]
                    if result.operation in {"PLAN_GPT", "JUDGE_GPT"}:
                        projection["gpt_transport"] = self._gpt_transport_projection(
                            browser_status, result.operation, result.job_id, None,
                            result_received=True, decision=result.decision)
                if (projection["gpt_transport"] is None and action.kind is ActionKind.PLAN
                        and entry.plan_conversation_url is None and not entry.global_plan_fallback):
                    projection["gpt_transport"] = self._awaiting_plan_binding_projection(
                        "PLAN_GPT", str(action.effect_id or "pending"), None)
                transport = projection["gpt_transport"]
                human = _human_status(entry, snapshot, action, delivery, transport,
                                      in_flight=in_flight, worktree_clean=clean,
                                      worktree_error=wt_error, scheduler_status=scheduler_status)
                projection.update({"semantic_status": human["status"], "status_code": human["status_code"],
                                   "block_reason": human["block_reason"], "next_wait": human["next_wait"],
                                   "attention": human["attention"],
                                   "active": bool(entry.enabled and not entry.archived)})
                stall = None
                try:
                    stall = self.scheduler.control_supervisor.stall(entry.p_id)
                except Exception:
                    stall = None
                projection["operational"] = operational_view(
                    self.state_root, entry, snapshot, action, stall=stall
                )
                if action.kind is ActionKind.WORK:
                    control = control_route_view(
                        self.state_root, entry, snapshot, action
                    )
                    route = str(control.get("route") or "CODEX")
                    route_label = {
                        "awaiting CONTROL": "awaiting CONTROL",
                        "CODEX": "CODEX",
                        "GROK": "GROK",
                        "SIMPLIFY": "SIMPLIFY recommended",
                        "WAIT": "WAIT",
                        "HUMAN": "HUMAN",
                    }.get(route, route)
                    projection["control"] = control
                    projection["execution_route"] = route_label
                    if route == "awaiting CONTROL":
                        projection.update({
                            "semantic_status": "等待 CONTROL_GPT 路由",
                            "status_code": "CONTROL_PENDING",
                            "block_reason": "WORK 尚未取得执行后端路由",
                            "next_wait": "等待 CONTROL_GPT",
                            "attention": False,
                        })
                    elif route == "SIMPLIFY":
                        projection.update({
                            "semantic_status": "建议 PLAN 简化",
                            "status_code": "CONTROL_SIMPLIFY_RECOMMENDED",
                            "block_reason": "CONTROL recommends PLAN simplification",
                            "next_wait": "由操作员显式处理 PLAN 简化",
                            "attention": True,
                        })
                    elif route == "WAIT":
                        projection.update({
                            "semantic_status": "等待执行能力",
                            "status_code": "CONTROL_WAIT",
                            "block_reason": "CONTROL_GPT recommends waiting",
                            "next_wait": "等待执行能力恢复",
                            "attention": True,
                        })
                    elif route == "HUMAN":
                        projection.update({
                            "semantic_status": "需要人工处理",
                            "status_code": "CONTROL_HUMAN",
                            "block_reason": "CONTROL_GPT cannot safely determine a route",
                            "next_wait": "人工决定执行路径",
                            "attention": True,
                        })
                    elif route == "GROK" and any(
                        marker in str(projection.get("detail", ""))
                        for marker in ("no configured Grok", "Grok attempts", "Grok guardian")
                    ):
                        projection.update({
                            "semantic_status": "GROK 执行能力不可用",
                            "status_code": "CONTROL_GROK_UNAVAILABLE",
                            "block_reason": str(projection.get("detail")),
                            "next_wait": "检查 Grok executor 配置或运行环境",
                            "attention": True,
                        })
                observation = self.scheduler.block_supervisor.observation(entry.p_id)
                diagnosis = block_view(
                    self.state_root, entry, snapshot, action, observation
                )
                if diagnosis is not None:
                    projection["operational_block"] = diagnosis["observation"]
                    projection["block_gpt"] = diagnosis
                    block_result = diagnosis.get("result")
                    if isinstance(block_result, dict):
                        decision = str(block_result.get("decision", ""))
                        projection["status_code"] = "OPERATIONAL_BLOCK"
                        projection["semantic_status"] = {
                            "RECOVER": "可自动恢复（尚未执行）",
                            "WAIT": "建议等待",
                            "HUMAN": "需要人工处理",
                        }.get(decision, "运行阻塞")
                        projection["block_reason"] = str(
                            block_result.get("reason") or diagnosis["observation"].get("summary")
                        )[:500]
                        projection["next_wait"] = (
                            "检查 BLOCK_GPT 提案；本阶段不会自动执行"
                            if decision == "RECOVER" else human["next_wait"]
                        )
                    else:
                        projection["status_code"] = "OPERATIONAL_BLOCK"
                        projection["semantic_status"] = "运行阻塞"
                        projection["block_reason"] = str(
                            diagnosis["observation"].get("summary", "运行阻塞")
                        )[:500]
                        projection["next_wait"] = (
                            "等待 BLOCK_GPT 诊断"
                            if diagnosis["request"].get("pending")
                            else "等待启用并绑定 BLOCK_GPT"
                        )
                    projection["attention"] = True
                if action.kind is ActionKind.WORK:
                    selected_route = str(projection.get("execution_route") or "CODEX")
                    if selected_route == "GROK":
                        projection["executor"] = {
                            "backend": "GROK",
                            "state": "WORKING" if in_flight else "WAITING",
                            "p_id": entry.p_id,
                            "model": "configured Grok model",
                        }
                        if in_flight:
                            projection["semantic_status"] = "GROK 正在工作"
                    elif selected_route == "CODEX":
                        projection["executor"] = {"backend": "CODEX",
                                                   "state": "WORKING" if in_flight else "WAITING",
                                                   "p_id": entry.p_id, "model": "gpt-5.6-luna",
                                                   "reasoning_effort": "max"}
                evidence: list[dict[str, object]] = []
                for item in snapshot.gpt_results[-3:]:
                    evidence.append({"kind": "GPT_RESULT", "job_id": item.job_id,
                                     "operation": item.operation, "decision": item.decision})
                for item in snapshot.work_facts[-2:]:
                    evidence.append({"kind": "WORK", "effect_id": item.effect_id,
                                     "status": item.status.value, "spec_id": item.spec_id,
                                     "output_head": item.output_head})
                for item in snapshot.proof_facts[-2:]:
                    evidence.append({"kind": "PROVE", "proof_id": item.proof_id,
                                     "status": item.status.value, "summary": item.summary[:500]})
                if transport is not None:
                    evidence.append({"kind": "TRANSPORT", "operation": transport.get("operation"),
                                     "job_id": transport.get("job_id"), "state": transport.get("state")})
                projection["evidence"] = evidence
                projection["primary_action"] = _primary_action_for(projection)
                if config.p_id != entry.p_id:
                    raise FactError("registered P/config identity mismatch")
            except (FactError, OSError) as error:
                projection.update({"detail": str(error), "block_reason": str(error),
                                   "semantic_status": "安全栅栏阻止继续", "status_code": "FACTS_ERROR",
                                   "attention": True, "active": bool(entry.enabled and not entry.archived)})
                projection["primary_action"] = _primary_action_for(projection)
            projects.append(projection)
        running = [item for item in projects if item.get("in_flight")]
        active = [item for item in projects if item.get("active")]
        paused = [item for item in projects if not item.get("enabled") and not item.get("archived")]
        archived = [item for item in projects if item.get("archived")]
        # The main inbox is for currently active production work.  Paused and
        # forensic entries remain visible in their lifecycle tab/card without
        # competing with actionable active work in the operator inbox.
        attention = [item for item in active if item.get("attention")]
        executors = list(list_executor_accounts(self.state_root))
        grok_executors = list(list_grok_executors(self.state_root))
        enabled_grok = [item for item in grok_executors if item.get("enabled") is True]
        if not grok_executors:
            grok_availability = "unconfigured"
        elif any(item.get("availability") == "configured" for item in enabled_grok):
            grok_availability = "configured"
        elif any(item.get("availability") == "busy" for item in enabled_grok):
            grok_availability = "busy"
        else:
            grok_availability = "unknown"
        working = [item["p_id"] for item in projects
                   if isinstance(item.get("executor"), dict)
                   and item["executor"].get("state") == "WORKING"]
        for item in executors:
            item["state"] = "工作中" if working else "空闲"
            item["current_p"] = working[0] if working else None
        try:
            block_config = load_block_config(self.state_root)
        except FactError as error:
            block_config = BlockGPTConfig()
            block_config_error = str(error)
        else:
            block_config_error = None
        block_pending = sum(
            1 for item in projects
            if isinstance(item.get("block_gpt"), dict)
            and isinstance(item["block_gpt"].get("request"), dict)
            and item["block_gpt"]["request"].get("pending")
        )
        return {"server": {"name": "agentbus-v2-webui", "loopback": True},
                "scheduler": scheduler_status, "executors": executors,
                "grok_executors": grok_executors,
                "grok_executor_status": {
                    "configured": bool(grok_executors),
                    "enabled_account_count": len(enabled_grok),
                    "availability": grok_availability,
                    "models": sorted({str(item["model"]) for item in enabled_grok}),
                },
                "mailbox": browser_status.get("mailbox"), "attention": attention,
                "active": active, "running": running, "paused": paused, "archived": archived,
                "gpt_lanes": self._gpt_lane_projection(gpt_transport.status(), browser_status),
                "browser_transport": browser_status, "projects": projects, "events": events,
                "gpt_conversations": self._gpt_conversation_projection(registry, browser_status),
                "block_gpt": {
                    "enabled": block_config.enabled,
                    "bound": block_config.conversation_url is not None,
                    "conversation_url": block_config.conversation_url,
                    "pending": block_pending,
                    "error": block_config_error,
                }}


POLISHED_INDEX_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentBus v2 控制面</title><style>
/* tokens */
:root{--bg:#111417;--surface-1:#171b20;--surface-2:#1c2127;--surface-hover:#222831;--border:#2b323a;--border-strong:#3a444f;--text:#e5e9ef;--text-secondary:#aab4bf;--text-muted:#7f8a96;--accent:#5c9ded;--accent-hover:#70aaf0;--success:#62b982;--warning:#d8a657;--danger:#d96767;--code-bg:#0d1013;color-scheme:dark;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
/* base */
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);overflow-x:hidden}button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}.muted{color:var(--text-muted)}.secondary-text{color:var(--text-secondary)}.technical,code,pre{font-family:ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",monospace;font-size:12px}.technical{overflow-wrap:anywhere}.danger-text{color:var(--danger)}.warning-text{color:var(--warning)}.success-text{color:var(--success)}
/* layout */
.shell{max-width:1240px;margin:0 auto;padding:22px 24px 40px}.section{margin-top:24px}.section-title{display:flex;align-items:baseline;gap:10px;margin:0 0 10px;font-size:16px;font-weight:650;letter-spacing:.01em}.empty{padding:8px 0;color:var(--text-muted)}
/* header */
.header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:18px;border-bottom:1px solid var(--border)}.brand{font-size:23px;font-weight:650;letter-spacing:-.02em}.header-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.health{font-size:12px;color:var(--text-secondary);white-space:nowrap;margin-top:5px}.health .dot{margin-right:5px}
/* toolbar and buttons */
.button{border:1px solid var(--border-strong);border-radius:4px;padding:6px 10px;background:var(--surface-2);color:var(--text);line-height:1.25}.button:hover{background:var(--surface-hover);border-color:var(--accent)}.button.primary{background:var(--accent);border-color:var(--accent);color:#0d131a;font-weight:600}.button.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}.button.ghost{background:transparent;border-color:transparent;color:var(--text-secondary)}.button.ghost:hover{background:var(--surface-hover);border-color:var(--border)}.button.danger{color:var(--danger);border-color:rgba(217,103,103,.55);background:transparent}.button.danger:hover{background:rgba(217,103,103,.12);border-color:var(--danger)}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}.toolbar .spacer{flex:1}
/* system strip */
.system-strip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border:1px solid var(--border);background:var(--surface-1);border-radius:5px;overflow:hidden}.health-cell{min-height:58px;padding:10px 12px;border-right:1px solid var(--border)}.health-cell:last-child{border-right:0}.health-label{display:block;color:var(--text-muted);font-size:12px}.health-value{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:13px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--text-muted);flex:0 0 auto}.dot.ok{background:var(--success)}.dot.warn{background:var(--warning)}.dot.err{background:var(--danger)}.health-cell button{margin-left:6px;padding:3px 7px;font-size:12px}
/* GPT conversation ownership */
.gpt-conversations{border:1px solid var(--border);border-radius:5px;background:var(--surface-1);overflow:hidden}.gpt-group-label{padding:7px 12px;color:var(--text-muted);font-size:12px;background:var(--surface-2);border-bottom:1px solid var(--border)}.gpt-row{display:grid;grid-template-columns:150px 110px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:44px;padding:7px 12px;border-bottom:1px solid var(--border)}.gpt-row:last-child{border-bottom:0}.gpt-role{font-weight:600;color:var(--text-secondary)}.gpt-state{font-size:12px}.gpt-url{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gpt-row .button{justify-self:end}.gpt-editor-row{display:block;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--surface-2)}
/* attention */
.attention-inbox{border-top:1px solid var(--border);background:var(--surface-1)}.attention-row{display:flex;align-items:center;gap:10px;min-height:58px;padding:9px 12px;border-bottom:1px solid var(--border)}.attention-row:last-child{border-bottom:0}.attention-row .severity{color:var(--warning);font-size:15px}.attention-id{min-width:190px;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:12px}.attention-reason{color:var(--text-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attention-row .button{flex:0 0 auto}
/* tabs */
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:12px}.tab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--text-muted);padding:7px 12px 8px;border-radius:0}.tab:hover{color:var(--text)}.tab.selected{color:var(--text);border-bottom-color:var(--accent);background:var(--surface-1)}.tab-count{font-size:12px;color:var(--text-muted);margin-left:4px}
/* task cards */
.task-list{display:grid;gap:9px}.task-card{border:1px solid var(--border);border-radius:5px;background:var(--surface-1);padding:14px 16px}.task-card.highlight{outline:2px solid var(--accent);outline-offset:2px}.task-top{display:flex;align-items:center;justify-content:space-between;gap:16px}.task-id{min-width:0;max-width:78%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;font-size:13px}.task-title{margin-top:3px;color:var(--text-secondary);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status-badge{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;padding:2px 7px;border-radius:4px;border:1px solid var(--border-strong);font-size:12px;color:var(--text-secondary);background:var(--surface-2)}.status-badge.blue{color:var(--accent);border-color:rgba(92,157,237,.45);background:rgba(92,157,237,.09)}.status-badge.amber{color:var(--warning);border-color:rgba(216,166,87,.45);background:rgba(216,166,87,.09)}.status-badge.red{color:var(--danger);border-color:rgba(217,103,103,.45);background:rgba(217,103,103,.09)}.status-badge.green{color:var(--success);border-color:rgba(98,185,130,.45);background:rgba(98,185,130,.09)}.status-badge.gray{color:var(--text-muted)}.blocker{display:flex;align-items:flex-start;gap:6px;margin-top:10px;color:var(--warning);font-size:13px;max-width:820px;overflow:hidden}.blocker .blocker-text{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.next-wait{margin-top:4px;color:var(--text-muted);font-size:12px}.meta-row{display:flex;flex-wrap:wrap;gap:0 13px;margin-top:11px;color:var(--text-secondary);font-size:12px}.meta-item{white-space:nowrap}.meta-item+.meta-item:before{content:"·";color:var(--text-muted);margin-right:13px}.task-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}.task-actions .spacer{flex:1}.more-menu{position:relative}.more-menu>summary{list-style:none;display:block}.more-menu>summary::-webkit-details-marker{display:none}.more-menu[open]>summary{background:var(--surface-hover);border-color:var(--border-strong)}.more-content{position:absolute;right:0;z-index:10;min-width:180px;margin-top:4px;padding:5px;border:1px solid var(--border-strong);border-radius:4px;background:var(--surface-2)}.more-content .button{display:block;width:100%;text-align:left;border-color:transparent;background:transparent}.more-content .button:hover{background:var(--surface-hover)}
/* details */
.task-details{margin-top:12px;border-top:1px solid var(--border);padding-top:7px}.task-details>summary{cursor:pointer;color:var(--text-secondary);font-size:12px}.details-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px}.detail-group{min-width:0}.detail-group h4{margin:0 0 5px;color:var(--text-secondary);font-size:12px;font-weight:650}.detail-row{display:grid;grid-template-columns:118px minmax(0,1fr);gap:8px;padding:2px 0;color:var(--text-muted);font-size:12px}.detail-row>span:last-child{color:var(--text-secondary);overflow-wrap:anywhere}.nested-details{margin-top:9px}.nested-details>summary{cursor:pointer;color:var(--text-muted);font-size:12px}.console{max-height:260px;overflow:auto;margin:7px 0 0;padding:9px;background:var(--code-bg);border:1px solid var(--border);border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere}.human-reason{margin-top:8px;padding:10px;border-left:3px solid var(--warning);background:rgba(216,166,87,.08);color:var(--text-secondary)}
/* forms */
.form-panel{margin-top:14px;padding:14px 16px;border:1px solid var(--border-strong);border-radius:5px;background:var(--surface-1)}.form-panel h2{margin:0 0 4px;font-size:16px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin-top:10px}.form-field{display:block;color:var(--text-secondary);font-size:12px}.form-field input,.form-field textarea{display:block;margin-top:4px;width:100%;padding:6px 8px;color:var(--text);background:var(--code-bg);border:1px solid var(--border-strong);border-radius:4px}.form-field textarea{min-height:100px;resize:vertical}.form-field.wide{grid-column:1/-1}.inline-editor{margin-top:8px;padding:9px;border:1px solid var(--border-strong);border-radius:4px;background:var(--surface-2)}.inline-editor label{display:block;color:var(--text-secondary);font-size:12px}.inline-editor input,.inline-editor textarea{display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--code-bg);color:var(--text);border:1px solid var(--border-strong);border-radius:4px}.inline-editor textarea{min-height:100px;resize:vertical}.inline-error{margin-top:4px;color:var(--danger);font-size:12px}.manual-fallback{margin-top:8px}.manual-fallback textarea{display:block;width:100%;min-height:90px;margin:7px 0;padding:6px;background:var(--code-bg);color:var(--text);border:1px solid var(--border-strong);border-radius:4px}.manual-fallback code{overflow-wrap:anywhere}
/* console/debug */
.advanced{margin-top:24px;border-top:1px solid var(--border);padding-top:8px}.advanced>summary{cursor:pointer;color:var(--text-secondary);font-size:13px}.advanced-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px}.advanced-box{min-width:0}.advanced-box h3{margin:0 0 5px;font-size:12px;color:var(--text-secondary)}.advanced-box pre{max-height:220px;overflow:auto;margin:0;padding:9px;background:var(--code-bg);border:1px solid var(--border);border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere}.block-panel{margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-radius:4px;background:var(--surface-1)}.block-panel .detail-row{max-width:620px}
/* toast */
.toast{min-height:0;margin-top:10px;padding:0;border-radius:4px;color:var(--text-secondary)}.toast.visible{padding:8px 10px;border:1px solid rgba(217,103,103,.6);background:rgba(217,103,103,.1);color:var(--danger)}
/* responsive */
@media(max-width:900px){.shell{padding:18px 16px 32px}.system-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.health-cell:nth-child(3){border-right:0}.health-cell:nth-child(-n+3){border-bottom:1px solid var(--border)}.health-cell:nth-child(4){border-right:1px solid var(--border)}}
@media(max-width:760px){.shell{padding:14px 14px 28px}.header{display:block}.header-actions{justify-content:flex-start;margin-top:10px}.system-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.health-cell{border-right:0!important;border-bottom:1px solid var(--border)}.health-cell:nth-last-child(-n+2){border-bottom:0}.details-grid,.advanced-grid,.form-grid{grid-template-columns:1fr}.task-top{align-items:flex-start}.task-id{max-width:62%}.attention-id{min-width:0;max-width:36%}.meta-row{gap:4px 10px}.meta-item+.meta-item:before{margin-right:10px}.task-actions .spacer{display:none}.more-content{right:auto;left:0}.gpt-row{grid-template-columns:1fr auto;gap:4px 10px}.gpt-row .gpt-url{grid-column:1/-1;grid-row:2}.gpt-row .button{grid-column:2;grid-row:1}}
</style></head><body><main class="shell">
<header class="header"><div><div class="brand">AgentBus v2</div><div class="toolbar"><button class="button primary" onclick="showForm('create')">+ 新建任务</button><button class="button secondary" onclick="showForm('adopt')">接管现有 PR</button></div></div><div class="header-actions"><div id="health" class="health"><span class="dot"></span>检查中</div><button class="button secondary" onclick="refresh()">刷新</button></div></header>
<div id="toast" class="toast" role="status" aria-live="polite"></div><div id="forms"></div>
<section class="section" aria-labelledby="system-title"><h2 id="system-title" class="section-title">系统状态</h2><div id="system-strip" class="system-strip"></div></section>
<section class="section" aria-labelledby="gpt-conversations-title"><h2 id="gpt-conversations-title" class="section-title">GPT 会话</h2><div id="gpt-conversations" class="gpt-conversations"></div></section>
<section class="section" aria-labelledby="attention-title"><h2 id="attention-title" class="section-title">需要处理 <span id="attention-count" class="tab-count"></span></h2><div id="attention" class="attention-inbox"></div></section>
<section class="section" aria-labelledby="tasks-title"><h2 id="tasks-title" class="section-title">任务</h2><div id="tabs" class="tabs" role="tablist" aria-label="任务生命周期"></div><div id="task-list" class="task-list"></div></section>
<details class="advanced"><summary>高级诊断</summary><section class="block-panel"><h3>BLOCK_GPT</h3><div id="block-gpt-controls"></div></section><div class="advanced-grid"><div class="advanced-box"><h3>Executors</h3><pre id="executors"></pre></div><div class="advanced-box"><h3>GPT lanes</h3><pre id="gpt-lanes"></pre></div><div class="advanced-box"><h3>Browser transport</h3><pre id="browser-transport"></pre></div><div class="advanced-box"><h3>Recent scheduler events</h3><pre id="events"></pre></div></div></details>
</main><script>
/* state and API */
const TOKEN=__TOKEN__;const ui={tab:'active',editingPlan:null,editingDirective:null,replan:null,editingBlock:false,editingJudge:false,editingControl:false,form:null,errors:{},current:null,drafts:{judgeUrl:null,blockUrl:null,controlUrl:null,planUrls:{},directives:{},form:{}},openDetails:new Set(),advancedOpen:false};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr=s=>esc(s).replace(/`/g,'&#96;');
const copyValue=v=>`decodeURIComponent('${encodeURIComponent(v??'').replaceAll("'","%27")}')`;
const copyProject=p=>`JSON.parse(decodeURIComponent('${encodeURIComponent(JSON.stringify(p))}'))`;
const shortUrl=v=>!v?'':(v.length>52?v.slice(0,24)+'…'+v.slice(-20):v);
async function request(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-AgentBus-Token':TOKEN},body:JSON.stringify(body??{})});let v;try{v=await r.json()}catch{throw Error('HTTP '+r.status+'（非 JSON）')}if(!r.ok)throw Error(v.error||('HTTP '+r.status));return v}
function showToast(message,kind='error'){const el=document.getElementById('toast');el.textContent=String(message||'');el.className='toast'+(message?' visible':'');if(message)setTimeout(()=>{if(el.textContent===String(message)){el.textContent='';el.className='toast'}},5000)}
function captureViewState(){ui.openDetails=new Set(Array.from(document.querySelectorAll('.task-details[open]')).map(x=>x.dataset.pId).filter(Boolean));const advanced=document.querySelector('.advanced');if(advanced)ui.advancedOpen=advanced.open}
function restoreViewState(){document.querySelectorAll('.task-details[data-p-id]').forEach(x=>{x.open=ui.openDetails.has(x.dataset.pId)});const advanced=document.querySelector('.advanced');if(advanced)advanced.open=ui.advancedOpen}
function editableFocused(){const active=document.activeElement;return Boolean(active&&/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))}
function interactionActive(){return Boolean(ui.form||ui.editingJudge||ui.editingBlock||ui.editingControl||ui.editingPlan!==null||ui.editingDirective!==null||ui.replan!==null||editableFocused()||document.querySelector('.task-details[open]')||document.querySelector('.advanced[open]'))}
async function fetchStatus({forceRender=false}={}){const r=await fetch('/api/status');if(!r.ok)throw Error('HTTP '+r.status);const latest=await r.json();ui.current=latest;if(forceRender||!interactionActive())render(latest);document.getElementById('last-refresh')?.replaceChildren(new Date().toLocaleTimeString());return latest}
async function refresh(forceRender=false){try{await fetchStatus({forceRender})}catch(e){showToast('状态读取失败：'+e)}}
async function autoRefresh(){try{await fetchStatus()}catch(e){showToast('状态读取失败：'+e)}}
async function scheduler(op){try{await request('/api/scheduler/'+op,{});await refresh(true)}catch(e){showToast(e)}}
function focusBlockEditor(){requestAnimationFrame(()=>{document.getElementById('gpt-conversations')?.scrollIntoView({behavior:'smooth',block:'center'});document.getElementById('block-url')?.focus()})}
function toggleBlockEditor(){if(ui.editingBlock){ui.editingBlock=false;ui.drafts.blockUrl=null;delete ui.errors.block}else{ui.editingBlock=true;ui.drafts.blockUrl=ui.drafts.blockUrl??(ui.current?.gpt_conversations?.block?.conversation_url||'')}render(ui.current);if(ui.editingBlock)focusBlockEditor()}
function toggleJudgeEditor(){if(ui.editingJudge){ui.editingJudge=false;ui.drafts.judgeUrl=null;delete ui.errors.judge}else{ui.editingJudge=true;ui.drafts.judgeUrl=ui.drafts.judgeUrl??(ui.current?.gpt_conversations?.judge?.conversation_url||'')}render(ui.current);if(ui.editingJudge)requestAnimationFrame(()=>document.getElementById('judge-url')?.focus())}
function toggleControlEditor(){if(ui.editingControl){ui.editingControl=false;ui.drafts.controlUrl=null;delete ui.errors.control}else{ui.editingControl=true;ui.drafts.controlUrl=ui.drafts.controlUrl??(ui.current?.gpt_conversations?.control?.conversation_url||'')}render(ui.current);if(ui.editingControl)requestAnimationFrame(()=>document.getElementById('control-url')?.focus())}
async function saveControlBinding(){const input=document.getElementById('control-url'),value=(input?.value||'').trim();ui.drafts.controlUrl=input?.value||'';if(!/^https:\/\/chatgpt\.com\/c\/[^\s/]+$/.test(value)){ui.errors.control='请输入 https://chatgpt.com/c/... 会话 URL';render(ui.current);requestAnimationFrame(()=>document.getElementById('control-url')?.focus());return}try{await request('/api/gpt-conversations/control',{conversation_url:value});ui.editingControl=false;ui.drafts.controlUrl=null;delete ui.errors.control;await refresh(true)}catch(e){ui.errors.control=String(e);render(ui.current);requestAnimationFrame(()=>document.getElementById('control-url')?.focus())}}
async function setControlEnabled(enabled){try{await request('/api/control-gpt/enabled',{enabled:Boolean(enabled)});await refresh(true)}catch(e){showToast(e)}}
async function saveJudgeBinding(){const input=document.getElementById('judge-url'),value=(input?.value||'').trim();ui.drafts.judgeUrl=input?.value||'';if(!/^https:\/\/chatgpt\.com\/c\/[^\s/]+$/.test(value)){ui.errors.judge='请输入 https://chatgpt.com/c/... 会话 URL';render(ui.current);requestAnimationFrame(()=>document.getElementById('judge-url')?.focus());return}try{await request('/api/gpt-conversations/judge',{conversation_url:value});ui.editingJudge=false;ui.drafts.judgeUrl=null;delete ui.errors.judge;await refresh(true)}catch(e){ui.errors.judge=String(e);render(ui.current);requestAnimationFrame(()=>document.getElementById('judge-url')?.focus())}}
async function saveBlockBinding(){const input=document.getElementById('block-url'),value=(input?.value||'').trim();ui.drafts.blockUrl=input?.value||'';if(!/^https:\/\/chatgpt\.com\/c\/[^\s/]+$/.test(value)){ui.errors.block='请输入 https://chatgpt.com/c/... 会话 URL';render(ui.current);requestAnimationFrame(()=>document.getElementById('block-url')?.focus());return}try{await request('/api/block-gpt/binding',{conversation_url:value});ui.editingBlock=false;ui.drafts.blockUrl=null;delete ui.errors.block;await refresh(true)}catch(e){ui.errors.block=String(e);render(ui.current);requestAnimationFrame(()=>document.getElementById('block-url')?.focus())}}
async function setBlockEnabled(enabled){try{await request('/api/block-gpt/enabled',{enabled:Boolean(enabled)});await refresh(true)}catch(e){showToast(e)}}
async function project(p,op,body){try{await request('/api/project/'+encodeURIComponent(p)+'/'+op,body);await refresh(true)}catch(e){showToast(e)}}
async function submit(p){const box=document.getElementById('gpt-'+CSS.escape(p));try{const v=JSON.parse(box.value);await request('/api/project/'+encodeURIComponent(p)+'/gpt-submit',v);box.value='';await refresh(true)}catch(e){showToast(e)}}
function setTab(tab){ui.tab=tab;render(ui.current)}
function projectId(value){return typeof value==='string'?value:value?.p_id}
function projectFor(value){const id=projectId(value);return (ui.current?.projects||[]).find(x=>x.p_id===id)||null}
function focusTask(p){const item=(ui.current?.projects||[]).find(x=>x.p_id===p);if(!item)return;ui.tab=item.archived?'archived':item.active?'active':'paused';render(ui.current);requestAnimationFrame(()=>{const el=document.getElementById('task-card-'+encodeURIComponent(p));if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('highlight');setTimeout(()=>el.classList.remove('highlight'),1200)}})}
function showHuman(value){const p=projectFor(value);if(!p)return;const p_id=p.p_id;ui.tab=p.active?'active':p.archived?'archived':'paused';render(ui.current);requestAnimationFrame(()=>{const card=document.getElementById('task-card-'+encodeURIComponent(p_id));card?.scrollIntoView({behavior:'smooth',block:'center'});const details=card?.querySelector('.task-details');if(details)details.open=true;const reason=card?.querySelector('.human-reason');if(reason){reason.classList.add('highlight');reason.focus?.()}})}
function confirmMerge(p_id){if(!confirm('该操作将允许 AgentBus 在所有现有 deterministic merge fences 通过后执行合并。\n是否继续？'))return;project(p_id,'allow-merge',{allow_merge:true})}
function togglePlanEditor(value){const p_id=projectId(value),p=projectFor(p_id);if(!p)return;if(ui.editingPlan===p_id){ui.editingPlan=null;delete ui.drafts.planUrls[p_id];delete ui.errors['plan-'+p_id]}else{ui.editingPlan=p_id;ui.editingDirective=null;ui.drafts.planUrls[p_id]=ui.drafts.planUrls[p_id]??(p.plan_binding?.conversation_url||'')}render(ui.current);requestAnimationFrame(()=>document.getElementById('plan-url-'+encodeURIComponent(p_id))?.focus())}
async function savePlan(value){const p_id=projectId(value),p=projectFor(p_id);if(!p)return;const id=encodeURIComponent(p_id),input=document.getElementById('plan-url-'+id),valueText=(input?.value||'').trim();ui.drafts.planUrls[p_id]=input?.value||'';if(!/^https:\/\/chatgpt\.com\/c\/[^\s/]+/.test(valueText)){ui.errors['plan-'+p_id]='请输入 https://chatgpt.com/c/... 会话 URL';render(ui.current);requestAnimationFrame(()=>document.getElementById('plan-url-'+id)?.focus());return}try{await request('/api/project/'+encodeURIComponent(p_id)+'/plan-binding',{conversation_url:valueText});ui.editingPlan=null;delete ui.drafts.planUrls[p_id];delete ui.errors['plan-'+p_id];await refresh(true)}catch(e){ui.errors['plan-'+p_id]=String(e);render(ui.current);requestAnimationFrame(()=>document.getElementById('plan-url-'+id)?.focus())}}
function toggleDirectiveEditor(value){const p_id=projectId(value),p=projectFor(p_id);if(!p)return;if(ui.editingDirective===p_id){ui.editingDirective=null;delete ui.drafts.directives[p_id];delete ui.errors['directive-'+p_id]}else{ui.editingDirective=p_id;ui.editingPlan=null;ui.drafts.directives[p_id]=ui.drafts.directives[p_id]??(p.operator_directive?.text||'')}render(ui.current);requestAnimationFrame(()=>document.getElementById('directive-'+encodeURIComponent(p_id))?.focus())}
async function saveDirective(value,replan){const p_id=projectId(value),p=projectFor(p_id);if(!p)return;const input=document.getElementById('directive-'+encodeURIComponent(p_id)),valueText=(input?.value||'').trim();ui.drafts.directives[p_id]=input?.value||'';if(!valueText){ui.errors['directive-'+p_id]='人工 PLAN 约束不能为空';render(ui.current);requestAnimationFrame(()=>document.getElementById('directive-'+encodeURIComponent(p_id))?.focus());return}if(replan&&!confirm('该 P 必须先暂停。应用新约束会产生新的 exact PLAN 请求，旧请求即使稍后返回也不会成为当前结果。继续？'))return;try{await request('/api/project/'+encodeURIComponent(p_id)+'/plan-directive',{directive:valueText,request_replan:replan});ui.editingDirective=null;delete ui.drafts.directives[p_id];delete ui.errors['directive-'+p_id];await refresh(true)}catch(e){ui.errors['directive-'+p_id]=String(e);render(ui.current);requestAnimationFrame(()=>document.getElementById('directive-'+encodeURIComponent(p_id))?.focus())}}
function showForm(kind){ui.form=kind;ui.drafts.form={};render(ui.current||{projects:[],scheduler:{},browser_transport:{},executors:[]});document.getElementById('form-pid')?.focus()}
function closeForm(){ui.form=null;ui.drafts.form={};render(ui.current)}
async function createOrAdopt(kind){const get=id=>document.getElementById(id)?.value||'';['f-pid','f-charter','f-repo','f-wt','f-branch','f-base','f-pr'].forEach(draftFormField);const body={p_id:get('f-pid'),charter:get('f-charter'),repository:get('f-repo'),worktree:get('f-wt'),branch:get('f-branch'),base_ref:get('f-base')};if(kind==='adopt')body.pr_number=Number(get('f-pr'));try{await request('/api/projects/'+(kind==='adopt'?'adopt':'create'),body);ui.form=null;ui.drafts.form={};await refresh(true)}catch(e){showToast(e)}}
async function removeProject(p_id){if(confirm('只移出控制列表，保留 durable facts、PR、branch 和 worktree。继续？'))await project(p_id,'remove',{})}
function tickProject(p_id){project(p_id,'tick',{})}
/* presentation helpers */
function statusLabel(p){const map={AWAITING_PLAN_BINDING:'等待 PLAN',GPT_PACKET_OVERSIZE:'GPT 请求过大，未发送',TRANSPORT_OFFLINE:'传输离线',TRANSPORT_ERROR:'传输异常',WORK_RUNNING:'执行器工作中',WAITING_EXECUTOR:'等待执行器',CONTROL_PENDING:'等待 CONTROL',CONTROL_SIMPLIFY_RECOMMENDED:'建议 PLAN 简化',CONTROL_WAIT:'等待执行能力',CONTROL_HUMAN:'需要人工处理',CONTROL_GROK_UNAVAILABLE:'GROK 不可用',PROVE:'等待 PROVE',PROVE_FAILED:'验证失败',HUMAN:'需要人工',WAIT:'等待外部条件',MERGE_READY:'待允许合并',DIRTY_WORKTREE:'阻塞',PR_IDENTITY_MISMATCH:'安全栅栏',OPERATIONAL_BLOCK:'运行阻塞',ARCHIVED:'已归档',IDLE:'等待检查'};if(!p.enabled&&!p.archived)return '已暂停';if(p.status_code==='WAITING_FOR_BROWSER'||p.status_code==='AUTO_QUEUED'||p.status_code==='WAITING_FOR_MAILBOX'){const op=p.gpt_transport?.operation||'PLAN_GPT';return `等待 ${op} 浏览器提交`}return map[p.status_code]||p.semantic_status||p.action}
function statusClass(p){const c=p.status_code||'';if(['HUMAN','CONTROL_HUMAN','CONTROL_GROK_UNAVAILABLE','PROVE_FAILED','GPT_PACKET_OVERSIZE','TRANSPORT_ERROR','TRANSPORT_OFFLINE','DIRTY_WORKTREE','PR_IDENTITY_MISMATCH','OPERATIONAL_BLOCK'].includes(c))return'red';if(['AWAITING_PLAN_BINDING','CONTROL_PENDING','CONTROL_SIMPLIFY_RECOMMENDED','CONTROL_WAIT','WAITING_FOR_MAILBOX','WAITING_EXECUTOR','MERGE_READY','WAIT'].includes(c))return'amber';if(['WORK_RUNNING','PROVE','WAITING_FOR_BROWSER','AUTO_QUEUED'].includes(c))return'blue';if(['ARCHIVED'].includes(c)||!p.enabled)return'gray';return'green'}
function prMeta(p){const parts=[];if(p.pr?.number)parts.push('PR #'+p.pr.number);if(p.head)parts.push('HEAD '+p.head);if(p.worktree?.clean===true)parts.push('工作树 clean');else if(p.worktree?.clean===false)parts.push('工作树 dirty');if(p.plan_binding?.bound)parts.push('PLAN 已绑定');return parts.map((x,i)=>`<span class="meta-item">${esc(x)}</span>`).join('')}
function blockerLine(p){const show=p.attention&&p.block_reason&&p.status_code!=='IDLE';if(!show)return'';return `<div class="blocker" title="${attr(p.block_reason)}"><span>⚠</span><span class="blocker-text">${esc(p.block_reason)}</span></div>${p.next_wait&&p.status_code!=='AWAITING_PLAN_BINDING'?`<div class="next-wait">下一步：${esc(p.next_wait)}</div>`:''}`}
function primaryButton(p){const a=p.primary_action;if(!a)return'';const fn=a.key==='bind-plan'?`togglePlanEditor(${copyProject(p)})`:a.key==='show-human'?`showHuman(${copyProject(p)})`:a.key==='allow-merge'?`confirmMerge(${copyProject(p)})`:a.key==='request-simplify-replan'?`startSimplifyReplan(${copyProject(p)})`:`project(${copyValue(p.p_id)},'enabled',{enabled:true})`;return `<button class="button primary" onclick="${fn}">${esc(a.label)}</button>`}
function startSimplifyReplan(p){if(!p.enabled){ui.drafts.directives[p.p_id]='CONTROL_GPT recommended SIMPLIFY. Produce a smaller mechanical PLAN expression of the same requirements. Do not weaken acceptance criteria.';startReplan(p);return}if(!confirm('请求 PLAN 简化会打开人工 PLAN 约束编辑器。P 必须先暂停才能应用 replan。继续打开编辑器？'))return;startReplan(p)}
function planBinding(p){const b=p.plan_binding||{},id=encodeURIComponent(p.p_id),editing=ui.editingPlan===p.p_id,draft=ui.drafts.planUrls[p.p_id]??(b.conversation_url||'');let html=`<div class="detail-row"><span>PLAN 会话</span><span>${b.bound?`<span class="technical">${esc(b.conversation_url)}</span> <button class="button ghost" onclick="togglePlanEditor(${copyProject(p)})">修改</button>`:'未绑定'} </span></div>`;if(editing){html+=`<div class="inline-editor"><label for="plan-url-${id}">PLAN 会话 URL</label><input id="plan-url-${id}" value="${attr(draft)}" placeholder="https://chatgpt.com/c/..." autocomplete="off" oninput="ui.drafts.planUrls[${copyValue(p.p_id)}]=this.value"><div class="inline-error">${esc(ui.errors['plan-'+p.p_id]||'')}</div><div class="task-actions"><span class="spacer"></span><button class="button secondary" onclick="togglePlanEditor(${copyProject(p)})">取消</button><button class="button primary" onclick="savePlan(${copyProject(p)})">保存</button></div></div>`}return html}
function directiveBlock(p){const d=p.operator_directive,id=encodeURIComponent(p.p_id),editing=ui.editingDirective===p.p_id;let html=`<div class="detail-row"><span>人工 PLAN 约束</span><span>${d?esc(d.text):'无'} ${!editing?`<button class="button ghost" onclick="toggleDirectiveEditor(${copyProject(p)})">${d?'修改':'添加约束'}</button>`:''}</span></div>`;if(editing){html+=`<div class="inline-editor"><label for="directive-${id}">人工 PLAN 约束</label><textarea id="directive-${id}" placeholder="例如：\n只修复当前 migrationsDir/path 问题。\n不要重构 packaging 或 PostgreSQL ownership。\n如果最小修复不可行，返回 HUMAN。">${esc(d?.text||'')}</textarea><div class="inline-error">${esc(ui.errors['directive-'+p.p_id]||'')}</div><div class="task-actions"><span class="spacer"></span><button class="button secondary" onclick="toggleDirectiveEditor(${copyProject(p)})">取消</button><button class="button primary" onclick="saveDirective(${copyProject(p)},false)">保存约束</button></div></div>`}return html}
function directiveBlock(p){const d=p.operator_directive,id=encodeURIComponent(p.p_id),editing=ui.editingDirective===p.p_id,draft=ui.drafts.directives[p.p_id]??(d?.text||'');let html=`<div class="detail-row"><span>人工 PLAN 约束</span><span>${d?esc(d.text):'无'} ${!editing?`<button class="button ghost" onclick="toggleDirectiveEditor(${copyProject(p)})">${d?'修改':'添加约束'}</button>`:''}</span></div>`;if(editing){html+=`<div class="inline-editor"><label for="directive-${id}">人工 PLAN 约束</label><textarea id="directive-${id}" oninput="ui.drafts.directives[${copyValue(p.p_id)}]=this.value">${esc(draft)}</textarea><div class="inline-error">${esc(ui.errors['directive-'+p.p_id]||'')}</div><div class="task-actions"><span class="spacer"></span><button class="button secondary" onclick="toggleDirectiveEditor(${copyProject(p)})">取消</button><button class="button primary" onclick="saveDirective(${copyProject(p)},false)">保存约束</button></div></div>`}return html}
function replanMarkup(p){if(!p.spec_id||p.enabled||p.archived||p.in_flight||ui.editingDirective===p.p_id)return'';return `<button class="button secondary" onclick="startReplan(${copyProject(p)})">要求重新规划</button>`}
const baseDirectiveBlock=directiveBlock;
directiveBlock=function(p){return baseDirectiveBlock(p)+replanMarkup(p)};
function startReplan(p){ui.replan=p.p_id;ui.editingDirective=p.p_id;ui.editingPlan=null;render(ui.current);requestAnimationFrame(()=>document.getElementById('directive-'+encodeURIComponent(p.p_id))?.focus())}
const baseToggleDirectiveEditor=toggleDirectiveEditor;
toggleDirectiveEditor=function(value){const id=projectId(value);if(ui.editingDirective===id)ui.replan=null;baseToggleDirectiveEditor(value)};
const baseSaveDirective=saveDirective;
saveDirective=async function(p,replan){const useReplan=Boolean(replan||ui.replan===p.p_id);await baseSaveDirective(p,useReplan);if(useReplan&&!ui.errors['directive-'+p.p_id])ui.replan=null};
function gptDetails(p){const g=p.gpt_transport;if(!g)return'';const result=g.state==='RESULT_RECEIVED'?`<div class="detail-row"><span>Decision</span><span>${esc(g.decision||'accepted')}</span></div>`:'';const served=g.served_to_extension?'<div class="detail-row"><span>服务端证据</span><span>扩展已获取任务（无 Send 确认）</span></div>':'';const size=g.rendered_packet_bytes!=null?`<div class="detail-row"><span>Packet</span><span class="technical">${esc(g.rendered_packet_bytes)} / ${esc(g.packet_budget_bytes)} bytes</span></div><div class="detail-row"><span>Evidence</span><span>${g.evidence_truncated?'已裁剪':'完整'}</span></div>`:'';const oversize=g.state==='GPT_PACKET_OVERSIZE'&&g.detail?`<div class="detail-row"><span>诊断</span><span class="danger-text">${esc(g.detail)}</span></div>`:'';const delivery=g.browser_delivery_id?`<div class="detail-row"><span>Browser delivery</span><span class="technical">${esc(g.browser_delivery_id)}</span></div>`:'';return `<div class="detail-group"><h4>GPT transport</h4><div class="detail-row"><span>GPT 操作</span><span class="technical">${esc(g.operation)}</span></div><div class="detail-row"><span>模式</span><span>${g.mode==='AUTO'?'自动':esc(g.mode)}</span></div><div class="detail-row"><span>传输</span><span class="technical">${esc(g.transport)}</span></div><div class="detail-row"><span>状态</span><span>${esc(g.state)}</span></div><div class="detail-row"><span>Semantic job</span><span class="technical">${esc(g.semantic_job_id||g.job_id)}</span></div>${delivery}${size}${oversize}<div class="detail-row"><span>Extension</span><span>${esc(g.extension)}</span></div><div class="detail-row"><span>Mailbox</span><span>${esc(g.mailbox)}</span></div>${served}${g.first_server_serve?`<div class="detail-row"><span>首次服务</span><span class="technical">${esc(g.first_server_serve)}</span></div>`:''}${g.last_server_serve?`<div class="detail-row"><span>最近服务</span><span class="technical">${esc(g.last_server_serve)}</span></div>`:''}${g.last_poll?`<div class="detail-row"><span>Last poll</span><span>${esc(g.last_poll)}</span></div>`:''}${g.last_error?`<div class="detail-row"><span>Last error</span><span class="danger-text">${esc(g.last_error)}</span></div>`:''}${result}${manualFallback(p,g)}</div>`}
function blockDetails(p){const b=p.block_gpt,o=p.operational_block;if(!b&&!o)return'';const obs=o||b?.observation||{},r=b?.result;if(!r)return `<div class="detail-group"><h4>运行阻塞</h4><div class="detail-row"><span>代码</span><span class="technical">${esc(obs.code||'UNKNOWN')}</span></div><div class="detail-row"><span>摘要</span><span>${esc(obs.summary||'运行阻塞')}</span></div><div class="warning-text">自动诊断：${b?.request?.pending?'等待 BLOCK_GPT':'BLOCK_GPT 未绑定或未启用'}</div></div>`;const d=r.decision;return `<div class="detail-group"><h4>BLOCK_GPT 判断</h4><div class="detail-row"><span>Decision</span><span class="technical">${esc(d)}</span></div><div class="detail-row"><span>原因</span><span>${esc(r.reason||'')}</span></div>${d==='RECOVER'?`<div class="detail-row"><span>建议恢复操作</span><span>${esc(r.recovery_instruction||'')}</span></div><div class="detail-row"><span>预期恢复后条件</span><span>${esc(r.expected_postcondition||'')}</span></div><div class="warning-text">可自动恢复（尚未执行）</div>`:''}${d==='WAIT'?'<div class="warning-text">建议等待</div>':''}${d==='HUMAN'?`<div class="human-reason">需要人工处理<br>${esc(r.human_action||'')}</div>`:''}</div>`}
function manualFallback(p,g){const m=g.manual_fallback;if(!m)return'';return `<details class="manual-fallback"><summary>高级手工 GPT 回退（Advanced manual GPT fallback）</summary><p class="warning-text">自动传输可用时，不要为同一 exact job 重复提交。</p><button class="button ghost" onclick="navigator.clipboard?.writeText(${copyValue(m.packet_path)})">复制 packet 路径</button> <button class="button ghost" onclick="navigator.clipboard?.writeText(${copyValue(m.instruction)})">复制 instruction</button><div class="technical">${esc(m.packet_sha256||'packet 尚未生成')}</div><textarea id="gpt-${esc(p.p_id)}" placeholder="粘贴 exact GPT JSON"></textarea><button class="button secondary" onclick="submit('${esc(p.p_id)}')">提交 exact JSON</button></details>`}
function evidenceDetails(p){return `<details class="nested-details"><summary>日志 / 证据</summary><pre class="console">${esc(JSON.stringify(p.evidence||[],null,2))}</pre></details>`}
function detailsPanel(p){const d=p.operator_directive,action=p.action;return `<details class="task-details" data-p-id="${attr(p.p_id)}"><summary>详情</summary><div class="details-grid"><div class="detail-group"><h4>当前任务</h4><div class="detail-row"><span>语义动作</span><span class="technical">${esc(action)}</span></div><div class="detail-row"><span>状态</span><span>${esc(p.semantic_status)}</span></div>${p.charter_summary?`<div class="detail-row"><span>Charter</span><span>${esc(p.charter_summary)}</span></div>`:''}${p.status_code==='HUMAN'?`<div tabindex="-1" class="human-reason"><strong>需要人工决定</strong><br>${esc(p.block_reason)}</div>`:''}</div><div class="detail-group"><h4>Git / PR</h4>${p.pr?`<div class="detail-row"><span>PR</span><span>#${esc(p.pr.number)} · ${esc(p.pr.state||'UNKNOWN')}${p.pr.draft?' · DRAFT':''}</span></div>`:''}<div class="detail-row"><span>HEAD</span><span class="technical">${esc(p.head||'—')}</span></div><div class="detail-row"><span>BASE</span><span class="technical">${esc(p.base||'—')}</span></div>${p.pr?.branch?`<div class="detail-row"><span>branch</span><span class="technical">${esc(p.pr.branch)}</span></div>`:''}<div class="detail-row"><span>worktree</span><span>${p.worktree?.clean===true?'clean':p.worktree?.clean===false?'dirty':'未知'}</span></div></div><div class="detail-group"><h4>PLAN</h4>${planBinding(p)}${directiveBlock(p)}<div class="detail-row"><span>CURRENT_SPEC</span><span class="technical">${esc(p.spec_id||'—')}</span></div></div>${gptDetails(p)}${blockDetails(p)}${p.executor?`<div class="detail-group"><h4>Executor</h4><div class="detail-row"><span>状态</span><span>${esc(p.executor.state)}</span></div><div class="detail-row"><span>model</span><span class="technical">${esc(p.executor.model||'gpt-5.6-luna')}</span></div><div class="detail-row"><span>reasoning</span><span class="technical">${esc(p.executor.reasoning_effort||'max')}</span></div></div>`:''}</div>${evidenceDetails(p)}<details class="nested-details"><summary>高级操作</summary><div class="task-actions"><button class="button secondary" onclick="tickProject(${copyProject(p)})">立即检查 / Tick now</button><span class="muted">重新读取事实并执行最多一个合法 effect。</span>${p.allow_merge?`<span class="warning-text">允许合并：ON</span><button class="button danger" onclick="project(${copyValue(p.p_id)},'allow-merge',{allow_merge:false})">关闭允许合并</button>`:''}${p.archived?`<button class="button secondary" onclick="project(${copyValue(p.p_id)},'unarchive',{})">取消归档</button>`:`<button class="button secondary" onclick="project(${copyValue(p.p_id)},'archive',{})">归档</button>`}<button class="button danger" onclick="removeProject(${copyProject(p)})">移出任务列表</button></div></details></details>`}
const baseDetailsPanel=detailsPanel;
detailsPanel=function(p){let html=baseDetailsPanel(p);if(p.execution_route)html=html.replace('<div class="detail-row"><span>状态</span>',`<div class="detail-row"><span>Execution route</span><span class="technical">${esc(p.execution_route)}</span></div><div class="detail-row"><span>状态</span>`);const o=p.operational||{};if(o.label||o.stall_control_id||o.diagnosis_id||o.block_id||o.recovery_id){const rows=[o.label?`<div class="detail-row"><span>Operational</span><span>${esc(o.label)}</span></div>`:'',o.stall_age_seconds!=null?`<div class="detail-row"><span>Stall age</span><span class="technical">${esc(o.stall_age_seconds)}s</span></div>`:'',o.stall_control_id?`<div class="detail-row"><span>Stall CONTROL</span><span class="technical">${esc(o.stall_control_id)}</span></div>`:'',o.diagnosis_id?`<div class="detail-row"><span>Diagnosis</span><span class="technical">${esc(o.diagnosis_id)} · ${esc(o.diagnosis_status||'')}</span></div>`:'',o.block_id?`<div class="detail-row"><span>BLOCK</span><span class="technical">${esc(o.block_id)} · ${esc(o.block_decision||'')}</span></div>`:'',o.recovery_id||o.recovery_route?`<div class="detail-row"><span>Recovery</span><span class="technical">${esc(o.recovery_route||'')} ${esc(o.recovery_id||'')} ${esc(o.recovery_status||'')}</span></div>`:''].join('');html=html.replace('<div class="detail-row"><span>语义动作</span>',`${rows}<div class="detail-row"><span>语义动作</span>`)}return html};
function taskCard(p){const id=encodeURIComponent(p.p_id),status=statusLabel(p),cls=statusClass(p),secondary=p.enabled&&!p.archived?`<button class="button secondary" onclick="project(${copyValue(p.p_id)},'enabled',{enabled:false})">暂停</button>`:'';const operational=p.operational?.label?`<div class="muted">${esc(p.operational.label)}</div>`:'';return `<article id="task-card-${id}" class="task-card"><div class="task-top"><div class="task-id" title="${attr(p.p_id)}">${esc(p.p_id)}</div><span class="status-badge ${cls}"><span class="dot ${cls==='green'?'ok':cls==='amber'?'warn':cls==='red'?'err':''}"></span>${esc(status)}</span></div><div class="task-title">${esc(p.charter_summary||'未提供任务摘要')}</div>${operational}${blockerLine(p)}<div class="meta-row">${prMeta(p)}</div><div class="task-actions">${primaryButton(p)}<span class="spacer"></span>${secondary}<details class="more-menu"><summary class="button ghost">···</summary><div class="more-content"><button class="button" onclick="tickProject(${copyProject(p)})">立即检查</button>${p.archived?`<button class="button" onclick="project(${copyValue(p.p_id)},'unarchive',{})">取消归档</button>`:`<button class="button" onclick="project(${copyValue(p.p_id)},'archive',{})">归档</button>`}<button class="button danger" onclick="removeProject(${copyProject(p)})">移出任务列表</button></div></details></div>${detailsPanel(p)}</article>`}
function attentionRow(p){return `<div class="attention-row"><span class="severity">⚠</span><span class="attention-id" title="${attr(p.p_id)}">${esc(p.p_id)}</span><span class="attention-reason">${esc(p.block_reason||p.semantic_status)}</span><button class="button secondary" onclick="focusTask(${copyValue(p.p_id)})">处理</button></div>`}
/* forms */
function formDraftValue(id,fallback=''){return attr(Object.prototype.hasOwnProperty.call(ui.drafts.form,id)?ui.drafts.form[id]:fallback)}
function draftFormField(id){ui.drafts.form[id]=document.getElementById(id)?.value||''}
function formPanel(kind){const adopt=kind==='adopt';return `<section class="form-panel"><h2>${adopt?'接管现有 PR':'新建任务'}</h2><p class="secondary-text">${adopt?'只继承 PR / branch / HEAD identity，不继承旧 AgentBus 语义历史。':'使用现有 v2 init 校验；创建后默认暂停，不自动发送 PLAN。'}</p><div class="form-grid"><label class="form-field">P_ID<input id="f-pid" value="${formDraftValue('f-pid')}" autocomplete="off" oninput="draftFormField('f-pid')"></label><label class="form-field">repository<input id="f-repo" value="${formDraftValue('f-repo','github.com/')}" oninput="draftFormField('f-repo')"></label>${adopt?`<label class="form-field">PR number<input id="f-pr" type="number" value="${formDraftValue('f-pr')}" oninput="draftFormField('f-pr')"></label>`:''}<label class="form-field">worktree<input id="f-wt" value="${formDraftValue('f-wt')}" oninput="draftFormField('f-wt')"></label><label class="form-field">branch<input id="f-branch" value="${formDraftValue('f-branch')}" oninput="draftFormField('f-branch')"></label><label class="form-field">base branch<input id="f-base" value="${formDraftValue('f-base','main')}" oninput="draftFormField('f-base')"></label><label class="form-field wide">任务说明 / charter<textarea id="f-charter" oninput="draftFormField('f-charter')">${formDraftValue('f-charter')}</textarea></label></div><div class="task-actions"><span class="spacer"></span><button class="button secondary" onclick="closeForm()">取消</button><button class="button primary" onclick="createOrAdopt('${kind}')">${adopt?'接管现有 PR':'创建任务'}</button></div></section>`}
function renderForm(){document.getElementById('forms').innerHTML=ui.form?formPanel(ui.form):''}
/* global render */
function openPlanBinding(value){const p=projectFor(value);if(!p)return;ui.tab=p.archived?'archived':p.active?'active':'paused';ui.editingPlan=p.p_id;ui.editingDirective=null;render(ui.current);requestAnimationFrame(()=>{const card=document.getElementById('task-card-'+encodeURIComponent(p.p_id));if(card){card.scrollIntoView({behavior:'smooth',block:'center'});card.classList.add('highlight');setTimeout(()=>card.classList.remove('highlight'),1200);const details=card.querySelector('.task-details');if(details)details.open=true}document.getElementById('plan-url-'+encodeURIComponent(p.p_id))?.focus()})}
/* canonical GPT conversation editors; Advanced only projects read-only controls */
function conversationEditor(kind,row){const judge=kind==='judge',id=judge?'judge-url':'block-url',label=judge?'JUDGE 会话 URL':'BLOCK 会话 URL',draft=judge?(ui.drafts.judgeUrl??(row.conversation_url||'')):(ui.drafts.blockUrl??(row.conversation_url||'')),error=judge?ui.errors.judge:ui.errors.block,oninput=judge?'ui.drafts.judgeUrl=this.value':'ui.drafts.blockUrl=this.value',cancel=judge?'toggleJudgeEditor()':'toggleBlockEditor()',save=judge?'saveJudgeBinding()':'saveBlockBinding()';return `<div class="gpt-editor-row"><div class="inline-editor"><label for="${id}">${label}</label><input id="${id}" value="${attr(draft)}" placeholder="https://chatgpt.com/c/..." autocomplete="off" oninput="${oninput}"><div class="inline-error">${esc(error||'')}</div><div class="task-actions"><span class="spacer"></span><button class="button secondary" onclick="${cancel}">取消</button><button class="button primary" onclick="${save}">保存</button></div></div></div>`}
function controlEditor(row){const draft=ui.drafts.controlUrl??(row.conversation_url||'');return `<div class="gpt-editor-row"><div class="inline-editor"><label for="control-url">CONTROL 会话 URL</label><input id="control-url" value="${attr(draft)}" placeholder="https://chatgpt.com/c/..." autocomplete="off" oninput="ui.drafts.controlUrl=this.value"><div class="inline-error">${esc(ui.errors.control||'')}</div><div class="task-actions"><span class="spacer"></span><button class="button secondary" onclick="toggleControlEditor()">取消</button><button class="button primary" onclick="saveControlBinding()">保存</button></div></div></div>`}
function renderConversations(v){const el=document.getElementById('gpt-conversations');if(!el)return;const c=v.gpt_conversations||{},judge=c.judge||{},block=c.block||{},control=c.control||{},status=row=>row.bound?'<span class="success-text"><span class="dot ok"></span>已绑定</span>':'<span class="muted"><span class="dot"></span>未绑定</span>',url=row=>row.bound?`<span class="technical gpt-url" title="${attr(row.conversation_url)}">${esc(shortUrl(row.conversation_url))}</span>`:'<span class="muted">—</span>',button=(label,handler)=>`<button class="button ghost" onclick="${handler}">${label}</button>`,controlState=control.enabled?'启用':'停用',controlPending=control.pending?` · pending ${esc(control.pending)}`:'',controlJob=control.current_job_id?` · ${esc(control.current_job_id)}`:'';let html=`<div class="gpt-row"><span class="gpt-role">JUDGE</span><span class="gpt-state">${status(judge)}</span>${url(judge)}${button(judge.bound?'修改':'绑定','toggleJudgeEditor()')}</div>`;if(ui.editingJudge)html+=conversationEditor('judge',judge);html+=`<div class="gpt-row"><span class="gpt-role">BLOCK</span><span class="gpt-state">${status(block)}</span>${url(block)}${button(block.bound?'修改':'绑定','toggleBlockEditor()')}</div>`;if(ui.editingBlock)html+=conversationEditor('block',block);html+=`<div class="gpt-row"><span class="gpt-role">CONTROL</span><span class="gpt-state">${status(control)} · ${controlState}${controlPending}${controlJob}</span>${url(control)}${button(control.bound?'修改':'绑定','toggleControlEditor()')}<button class="button ghost" onclick="setControlEnabled(${!control.enabled})">${control.enabled?'停用':'启用'}</button></div>`;if(ui.editingControl)html+=controlEditor(control);html+='<div class="gpt-group-label">P 专用 PLAN</div>';const plans=(c.per_p_plan||[]).filter(row=>(ui.current?.projects||[]).some(p=>p.p_id===row.p_id));if(plans.length)html+=plans.map(row=>`<div class="gpt-row"><span class="gpt-role technical" title="${attr(row.p_id)}">${esc(row.p_id)}</span><span class="gpt-state">${status(row)}</span>${url(row)}${button(row.bound?'修改':'绑定',`openPlanBinding(${copyValue(row.p_id)})`)}</div>`).join('');else html+='<div class="gpt-row"><span class="muted">暂无 active P</span></div>';if(c.error)html+=`<div class="gpt-editor-row warning-text">${esc(c.error)}</div>`;el.innerHTML=html}
function renderBlockPanel(v){const b=v.block_gpt||{},el=document.getElementById('block-gpt-controls');if(!el)return;const bound=b.bound?'已绑定':'未绑定',warning=b.enabled&&!b.bound?'<div class="warning-text">BLOCK_GPT 未绑定；不会使用 PLAN/JUDGE 会话。</div>':'';el.innerHTML=`<div class="detail-row"><span>会话</span><span>${bound} <button class="button ghost" onclick="toggleBlockEditor()">${b.bound?'修改':'配置会话'}</button></span></div><div class="detail-row"><span>自动诊断运行阻塞</span><span><span class="${b.enabled?'success-text':'muted'}">${b.enabled?'ON':'OFF'}</span><button class="button ${b.enabled?'secondary':'primary'}" onclick="setBlockEnabled(${!b.enabled})">${b.enabled?'关闭':'启用'}</button></span></div>${warning}`}
function renderSystem(v){const s=v.scheduler||{},b=v.browser_transport||{},executors=v.executors||[],working=executors.filter(x=>x.state==='工作中').length,total=executors.filter(x=>x.enabled).length,mailboxReady=b.mailbox==='available'||b.mailbox==='configured';const health=document.getElementById('health');const attention=(v.attention||[]).length;health.innerHTML=`<span class="dot ${attention?'warn':'ok'}"></span>${attention?'需要处理 '+attention:'系统正常'}`;document.getElementById('system-strip').innerHTML=`<div class="health-cell"><span class="health-label">调度器</span><span class="health-value"><span class="dot ${s.running?'ok':'warn'}"></span>${s.running?'运行中':'已停止'}<button class="button ghost" onclick="scheduler('${s.running?'stop':'start'}')">${s.running?'停止':'启动'}</button></span></div><div class="health-cell"><span class="health-label">浏览器</span><span class="health-value"><span class="dot ${b.legacy_v1_extension==='ONLINE'?'ok':'err'}"></span>${b.legacy_v1_extension==='ONLINE'?'在线':'离线'}</span></div><div class="health-cell"><span class="health-label">Mailbox</span><span class="health-value"><span class="dot ${mailboxReady?'ok':'err'}"></span>${mailboxReady?'可用':'不可用'}</span></div><div class="health-cell"><span class="health-label">Luna</span><span class="health-value">${working} / ${total} 工作中</span></div><div class="health-cell"><span class="health-label">PLAN</span><span class="health-value">${b.plan?.pending??0}</span></div><div class="health-cell"><span class="health-label">JUDGE</span><span class="health-value">${b.judge?.pending??0}</span></div>`;document.getElementById('executors').textContent=JSON.stringify(executors,null,2);document.getElementById('gpt-lanes').textContent=(v.gpt_lanes||[]).map(l=>`${l.semantic_operation||l.name} · ${l.production_transport||l.transport||'UNKNOWN'}\nextension: ${l.extension||'UNKNOWN'} · mailbox: ${l.mailbox||'UNKNOWN'} · pending: ${l.pending_jobs??0}`).join('\n\n');document.getElementById('browser-transport').textContent=JSON.stringify(b,null,2);document.getElementById('events').textContent=(v.events||[]).slice().reverse().map(e=>JSON.stringify(e)).join('\n');renderBlockPanel(v)}
const baseRenderSystem=renderSystem;
renderSystem=function(v){baseRenderSystem(v);const el=document.getElementById('executors');if(el)el.textContent=JSON.stringify({codex:v.executors||[],grok:v.grok_executors||[]},null,2)};
function renderTabs(v){const rows={active:v.active||[],paused:v.paused||[],archived:v.archived||[]};document.getElementById('tabs').innerHTML=[['active','进行中'],['paused','已暂停'],['archived','已归档']].map(([key,label])=>`<button role="tab" aria-selected="${ui.tab===key}" class="tab ${ui.tab===key?'selected':''}" onclick="setTab('${key}')">${label}<span class="tab-count">${rows[key].length}</span></button>`).join('');const list=rows[ui.tab]||[];document.getElementById('task-list').innerHTML=list.length?list.map(taskCard).join(''):`<div class="empty">${ui.tab==='archived'?'暂无已归档任务':ui.tab==='paused'?'暂无已暂停任务':'暂无进行中的任务'}</div>`}
function render(v){captureViewState();ui.current=v;renderForm();document.getElementById('attention-count').textContent='('+((v.attention||[]).length)+')';document.getElementById('attention').innerHTML=(v.attention||[]).length?(v.attention||[]).map(attentionRow).join(''):'<div class="empty">当前没有需要人工处理的任务。</div>';renderTabs(v);renderConversations(v);renderSystem(v);restoreViewState()}
refresh();setInterval(autoRefresh,1500);
</script></body></html>"""


INDEX_HTML = POLISHED_INDEX_HTML


def render_index(token: str) -> bytes:
    return INDEX_HTML.replace("__TOKEN__", json.dumps(token)).encode("utf-8")


class WebUIHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, state: WebUIState):
        self.state = state
        super().__init__(address, WebUIRequestHandler)


class WebUIRequestHandler(BaseHTTPRequestHandler):
    server: WebUIHTTPServer

    def log_message(self, fmt: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.address_string(), fmt % args)

    def _write(self, status: int, payload: object, *, content_type: str = "application/json") -> None:
        if content_type == "application/json":
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        else:
            data = payload if isinstance(payload, bytes) else str(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, detail: str) -> None:
        self._write(status, {"error": detail})

    def _json_body(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise WebUIError(400, "Content-Type must be application/json")
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            raise WebUIError(400, "JSON body is required")
        try:
            length = int(length_text)
        except ValueError as error:
            raise WebUIError(400, "invalid Content-Length") from error
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise WebUIError(400, "request body is too large")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise WebUIError(400, "malformed JSON body") from error
        if not isinstance(value, dict):
            raise WebUIError(400, "JSON body must be an object")
        return value

    def _require_token(self) -> None:
        if self.headers.get("X-AgentBus-Token") != self.server.state.token:
            raise WebUIError(403, "missing or invalid mutation token")

    @staticmethod
    def _exact(value: dict[str, Any], keys: set[str]) -> None:
        if set(value) != keys:
            raise WebUIError(400, f"request keys must be exactly {sorted(keys)}")

    def do_GET(self) -> None:
        try:
            path = urlsplit(self.path).path
            if path == "/":
                self._write(200, render_index(self.server.state.token), content_type="text/html")
                return
            if path == "/api/status":
                self._write(200, self.server.state.status())
                return
            if path == "/api/browser/jobs":
                self._write(200, self.server.state.legacy_browser_compat.poll_and_project())
                return
            raise WebUIError(404, "not found")
        except WebUIError as error:
            self._error(error.status, error.detail)
        except Exception:
            LOGGER.exception("GET %s failed", self.path)
            self._error(500, "internal server error")

    def do_POST(self) -> None:
        try:
            self._require_token()
            body = self._json_body()
            parts = [unquote(item) for item in urlsplit(self.path).path.split("/") if item]
            if parts == ["api", "scheduler", "start"]:
                self._exact(body, set())
                self._write(200, {"started": self.server.state.start_scheduler()})
                return
            if parts == ["api", "scheduler", "stop"]:
                self._exact(body, set())
                self._write(200, {"stopped": self.server.state.stop_scheduler()})
                return
            if parts == ["api", "block-gpt", "binding"]:
                self._exact(body, {"conversation_url"})
                if type(body["conversation_url"]) is not str:
                    raise WebUIError(400, "conversation_url must be a string")
                config = self.server.state.set_block_binding(body["conversation_url"])
                self._write(200, {
                    "bound": config.conversation_url is not None,
                    "conversation_url": config.conversation_url,
                })
                return
            if parts == ["api", "gpt-conversations", "judge"]:
                self._exact(body, {"conversation_url"})
                if type(body["conversation_url"]) is not str:
                    raise WebUIError(400, "conversation_url must be a string")
                config = self.server.state.set_judge_binding(body["conversation_url"])
                self._write(200, {
                    "bound": True,
                    "conversation_url": config.conversations["judge"],
                })
                return
            if parts == ["api", "gpt-conversations", "control"]:
                self._exact(body, {"conversation_url"})
                if type(body["conversation_url"]) is not str:
                    raise WebUIError(400, "conversation_url must be a string")
                config = self.server.state.set_control_binding(body["conversation_url"])
                self._write(200, {
                    "enabled": config.enabled,
                    "bound": config.conversation_url is not None,
                    "conversation_url": config.conversation_url,
                })
                return
            if parts == ["api", "block-gpt", "enabled"]:
                self._exact(body, {"enabled"})
                if type(body["enabled"]) is not bool:
                    raise WebUIError(400, "enabled must be boolean")
                config = self.server.state.set_block_enabled(body["enabled"])
                self._write(200, {"enabled": config.enabled, "bound": config.conversation_url is not None})
                return
            if parts == ["api", "control-gpt", "enabled"]:
                self._exact(body, {"enabled"})
                if type(body["enabled"]) is not bool:
                    raise WebUIError(400, "enabled must be boolean")
                config = self.server.state.set_control_enabled(body["enabled"])
                self._write(200, {
                    "enabled": config.enabled,
                    "bound": config.conversation_url is not None,
                })
                return
            if parts == ["api", "projects", "create"]:
                entry = self.server.state.create_p(body)
                self._write(201, {"p_id": entry.p_id, "enabled": entry.enabled,
                                  "archived": entry.archived})
                return
            if parts == ["api", "projects", "adopt"]:
                entry = self.server.state.adopt_pr(body)
                self._write(201, {"p_id": entry.p_id, "enabled": entry.enabled,
                                  "archived": entry.archived})
                return
            if len(parts) == 4 and parts[:2] == ["api", "project"]:
                p_id, operation = parts[2], parts[3]
                self.server.state.project(p_id)
                if operation == "enabled":
                    self._exact(body, {"enabled"})
                    if type(body["enabled"]) is not bool:
                        raise WebUIError(400, "enabled must be boolean")
                    entry = self.server.state.set_enabled(p_id, body["enabled"])
                    self._write(200, {"p_id": entry.p_id, "enabled": entry.enabled})
                    return
                if operation == "allow-merge":
                    self._exact(body, {"allow_merge"})
                    if type(body["allow_merge"]) is not bool:
                        raise WebUIError(400, "allow_merge must be boolean")
                    entry = self.server.state.set_allow_merge(p_id, body["allow_merge"])
                    self._write(200, {"p_id": entry.p_id, "allow_merge": entry.allow_merge})
                    return
                if operation in {"archive", "unarchive"}:
                    self._exact(body, set())
                    entry = self.server.state.archive_p(p_id, archived=operation == "archive")
                    self._write(200, {"p_id": entry.p_id, "archived": entry.archived,
                                      "enabled": entry.enabled})
                    return
                if operation == "remove":
                    self._exact(body, set())
                    self.server.state.remove_p(p_id)
                    self._write(200, {"p_id": p_id, "removed": True})
                    return
                if operation == "plan-binding":
                    self._exact(body, {"conversation_url"})
                    if type(body["conversation_url"]) is not str:
                        raise WebUIError(400, "conversation_url must be a string")
                    entry = self.server.state.set_plan_binding(p_id, body["conversation_url"])
                    self._write(200, {
                        "p_id": entry.p_id,
                        "plan_conversation_url": entry.plan_conversation_url,
                    })
                    return
                if operation == "plan-directive":
                    self._exact(body, {"directive", "request_replan"})
                    if type(body["directive"]) is not str or type(body["request_replan"]) is not bool:
                        raise WebUIError(400, "directive must be string and request_replan boolean")
                    self._write(200, self.server.state.add_plan_directive(
                        p_id, body["directive"], request_replan=body["request_replan"]
                    ))
                    return
                if operation == "tick":
                    self._exact(body, set())
                    self._write(202, self.server.state.tick_now(p_id))
                    return
                if operation == "gpt-submit":
                    self._submit_gpt(p_id, body)
                    return
            raise WebUIError(404, "not found")
        except WebUIError as error:
            self._error(error.status, error.detail)
        except FactError as error:
            self._error(422, str(error))
        except (OSError, ValueError) as error:
            self._error(400, str(error))
        except Exception:
            LOGGER.exception("POST %s failed", self.path)
            self._error(500, "internal server error")

    def _submit_gpt(self, p_id: str, body: dict[str, Any]) -> None:
        state = self.server.state
        paths = paths_for(state.state_root, p_id)
        state.project(p_id)
        fd, name = tempfile.mkstemp(prefix=".webui-gpt-", suffix=".json", dir=state.state_root)
        temporary = Path(name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(body, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            result = submit_gpt_response(paths, temporary)
        finally:
            temporary.unlink(missing_ok=True)
        tick_submitted = False
        try:
            state.tick_now(p_id)
            tick_submitted = True
        except WebUIError as error:
            if error.status != 409:
                raise
        self._write(
            200,
            {
                "stored": result.changed,
                "detail": result.detail,
                "tick_submitted": tick_submitted,
            },
        )


def make_server(
    state: WebUIState,
    *,
    host: str = DEFAULT_WEB_HOST,
    port: int = DEFAULT_WEB_PORT,
) -> WebUIHTTPServer:
    if host != DEFAULT_WEB_HOST:
        raise ValueError("webui must bind the IPv4 loopback address")
    if port < 0 or port > 65535:
        raise ValueError("webui port must be between 0 and 65535")
    return WebUIHTTPServer((host, port), state)
