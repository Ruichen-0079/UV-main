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
from .effects import submit_gpt_response
from .executor_pool import list_executor_accounts, worktree_execution_lock
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
from .legacy_v1_browser_compat import LegacyV1BrowserCompat
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
        if state in {"WAITING_FOR_BROWSER", "AUTO_QUEUED"}:
            op = str(transport.get("operation", "PLAN_GPT"))
            return {"status": f"等待 {op} GPT", "status_code": state,
                    "block_reason": "请求已存在，结果尚未成为 durable authority",
                    "next_wait": "等待浏览器传输", "attention": False}
        if state == "WAITING_FOR_MAILBOX":
            op = str(transport.get("operation", "GPT"))
            return {"status": f"等待 {op} 结果", "status_code": state,
                    "block_reason": "浏览器已处理，等待 mailbox 结果", "next_wait": "等待 mailbox",
                    "attention": False}
        if state in {"TRANSPORT_OFFLINE", "TRANSPORT_ERROR"}:
            return {"status": "浏览器传输异常", "status_code": state,
                    "block_reason": str(transport.get("last_error") or "signed v1 extension 或 mailbox 不可用"),
                    "next_wait": "检查浏览器传输", "attention": True}
    if action.kind is ActionKind.WORK:
        if in_flight:
            return {"status": "Luna 正在工作", "status_code": "WORK_RUNNING",
                    "block_reason": "", "next_wait": "等待 WORK 完成", "attention": False}
        return {"status": "等待执行器", "status_code": "WAITING_EXECUTOR",
                "block_reason": "当前尚未取得 Luna executor", "next_wait": "等待执行器可用",
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
            if extension != "ONLINE":
                state = "TRANSPORT_OFFLINE"
            elif mailbox == "unavailable" or browser_status.get("last_error"):
                state = "TRANSPORT_ERROR"
            elif lane_status.get("state") == "waiting-mailbox":
                state = "WAITING_FOR_MAILBOX"
            elif lane_status.get("state") == "pending":
                state = "WAITING_FOR_BROWSER"
            else:
                state = "AUTO_QUEUED"
        projection: dict[str, object] = {
            "operation": operation,
            "mode": mode,
            "transport": transport,
            "state": state,
            "job_id": job_id,
            "extension": extension if configured else "NOT_CONFIGURED",
            "mailbox": mailbox if configured else "NOT_CONFIGURED",
            "last_poll": browser_status.get("last_poll") if configured else None,
            "last_error": browser_status.get("last_error") if configured else None,
            "manual_fallback": manual_fallback,
            "warning": AUTO_WARNING if configured and not result_received else None,
        }
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
                                   "attention": human["attention"]})
                if action.kind is ActionKind.WORK:
                    projection["executor"] = {"state": "WORKING" if in_flight else "WAITING",
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
                if config.p_id != entry.p_id:
                    raise FactError("registered P/config identity mismatch")
            except (FactError, OSError) as error:
                projection.update({"detail": str(error), "block_reason": str(error),
                                   "semantic_status": "安全栅栏阻止继续", "status_code": "FACTS_ERROR",
                                   "attention": True})
            projects.append(projection)
        attention = [item for item in projects if item.get("attention")]
        running = [item for item in projects if item.get("in_flight")]
        paused = [item for item in projects if not item.get("enabled") and not item.get("archived")]
        archived = [item for item in projects if item.get("archived")]
        executors = list(list_executor_accounts(self.state_root))
        working = [item["p_id"] for item in projects
                   if isinstance(item.get("executor"), dict)
                   and item["executor"].get("state") == "WORKING"]
        for item in executors:
            item["state"] = "工作中" if working else "空闲"
            item["current_p"] = working[0] if working else None
        return {"server": {"name": "agentbus-v2-webui", "loopback": True},
                "scheduler": scheduler_status, "executors": executors,
                "mailbox": browser_status.get("mailbox"), "attention": attention,
                "running": running, "paused": paused, "archived": archived,
                "gpt_lanes": self._gpt_lane_projection(gpt_transport.status(), browser_status),
                "browser_transport": browser_status, "projects": projects, "events": events}


INDEX_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentBus v2 控制面</title><style>
:root{font:14px system-ui,sans-serif;color:#e8edf2;background:#171a1e}body{margin:20px;max-width:1500px}button{margin:2px;padding:6px 10px;background:#29313a;color:#e8edf2;border:1px solid #56616d;border-radius:4px}button:hover{background:#35414d}input,textarea{box-sizing:border-box;width:100%;background:#0f1114;color:#e8edf2;border:1px solid #56616d;border-radius:3px;padding:5px}textarea{min-height:90px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #30363d;padding:9px;text-align:left;vertical-align:top}.card{border:1px solid #30363d;border-radius:5px;padding:12px;margin:10px 0;background:#1b2026}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:10px}.muted{color:#9da9b5}.ok{color:#8ed081}.warn{color:#ffd166}.err{color:#ff7b72}.attention{border-left:3px solid #ffd166;padding-left:8px}.events{max-height:220px;overflow:auto;white-space:pre-wrap;font:12px ui-monospace,monospace}details{margin-top:8px}summary{cursor:pointer;color:#d2dae2}.transport{line-height:1.5}label{display:block;margin-top:6px}.formgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
</style></head><body><h1>AgentBus v2</h1>
<div id="toolbar"><button onclick="refresh()">刷新</button><button onclick="showForm('create')">新建任务</button><button onclick="showForm('adopt')">接管现有 PR</button><button onclick="scheduler('start')">启动调度器</button><button onclick="scheduler('stop')">停止调度器</button><button onclick="tickExplain()">立即检查 / Tick now</button><span id="summary" class="muted"></span></div><div id="error"></div>
<div id="forms"></div><section class="card"><h2>系统状态</h2><div id="system" class="grid"></div></section>
<section class="card"><h2>需要处理</h2><div id="attention"></div></section><section class="card"><h2>运行中</h2><div id="running"></div></section><section class="card"><h2>已暂停</h2><div id="paused"></div></section><section class="card"><h2>已归档</h2><div id="archived"></div></section>
<section class="card"><h2>任务</h2><div id="projects"></div></section><details class="card"><summary>高级 / 原始诊断</summary><h3>执行器</h3><pre id="executors" class="muted"></pre><h3>GPT lanes</h3><pre id="gpt-lanes" class="muted"></pre><h3>浏览器传输</h3><pre id="browser-transport" class="muted"></pre><h3>最近事件</h3><div id="events" class="events"></div></details><script>
const TOKEN=__TOKEN__;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function request(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-AgentBus-Token':TOKEN},body:JSON.stringify(body??{})});let v;try{v=await r.json()}catch{throw Error('HTTP '+r.status+'（非 JSON）')}if(!r.ok)throw Error(v.error||('HTTP '+r.status));return v}
async function scheduler(op){try{await request('/api/scheduler/'+op,{});await refresh()}catch(e){showError(e)}}
async function project(p,op,body){try{await request('/api/project/'+encodeURIComponent(p)+'/'+op,body);await refresh()}catch(e){showError(e)}}
async function submit(p){const box=document.getElementById('gpt-'+CSS.escape(p));try{const v=JSON.parse(box.value);await request('/api/project/'+encodeURIComponent(p)+'/gpt-submit',v);box.value='';await refresh()}catch(e){showError(e)}}
function copyText(v){navigator.clipboard?.writeText(v)} function showError(e){document.getElementById('error').textContent=String(e);setTimeout(()=>document.getElementById('error').textContent='',5000)}
function copyValue(v){return `decodeURIComponent('${encodeURIComponent(v??'').replaceAll("'","%27")}')`} function shortUrl(v){if(!v)return '';return v.length>52?v.slice(0,24)+'…'+v.slice(-20):v}
async function bindPlan(p){const current=p.plan_binding?.conversation_url||'';const url=prompt('PLAN 会话 URL（https://chatgpt.com/c/...）',current);if(url===null)return;if(!url.trim())return showError('PLAN 会话 URL 不能为空');await project(p.p_id,'plan-binding',{conversation_url:url.trim()})}
async function setDirective(p,replan){const pending=Boolean(p.gpt_transport?.job_id&&p.gpt_transport?.state!=='RESULT_RECEIVED');if((replan||pending)&&!confirm((replan?'该 P 必须先暂停。':'当前 PLAN 请求仍在传输。')+'应用新约束会产生新的 exact PLAN 请求，旧请求即使稍后返回也不会成为当前结果。继续？'))return;const current=p.operator_directive?.text||'';const text=prompt(replan?'人工 PLAN 约束（要求重新规划）':'人工 PLAN 约束',current);if(text===null)return;if(!text.trim())return showError('人工 PLAN 约束不能为空');await project(p.p_id,'plan-directive',{directive:text,request_replan:replan})}
function renderPlanControls(p){const b=p.plan_binding||{};const bound=b.bound?`<span class="ok">已绑定</span> <code>${esc(shortUrl(b.conversation_url))}</code>`:'<span class="warn">未绑定</span>';const d=p.operator_directive?`<div class="muted">当前约束：${esc(p.operator_directive.text)}</div>`:'<div class="muted">当前约束：无</div>';const replan=Boolean(p.spec_id);return `<div><b>PLAN 会话</b>：${bound}</div><button onclick="bindPlan(${copyValue(p.p_id)})">${b.bound?'修改 PLAN 会话':'绑定 PLAN 会话'}</button>${d}<button onclick="setDirective(${copyValue(p.p_id)},${replan})">${replan?'要求重新规划':'添加约束'}</button>`}
function manualFallback(p,g){const m=g.manual_fallback;if(!m)return '';return `<details class="manual-fallback"><summary>高级：手工 GPT 回退（Advanced manual GPT fallback）</summary><p class="warn">自动传输可用时，不要为同一 exact job 重复提交。</p><button onclick="copyText(${copyValue(m.packet_path)})">复制 packet 路径</button><button onclick="copyText(${copyValue(m.instruction)})">复制 instruction</button><br><code>${esc(m.packet_sha256||'packet 尚未生成')}</code><textarea id="gpt-${esc(p.p_id)}" placeholder="粘贴 exact GPT JSON"></textarea><button onclick="submit('${esc(p.p_id)}')">提交 exact JSON</button></details>`}
function renderGpt(p){const g=p.gpt_transport;if(!g)return '—';const result=g.state==='RESULT_RECEIVED'?`<br><span class="muted">Decision: ${esc(g.decision||'accepted')}</span>`:'';const warning=g.mode==='AUTO'&&g.manual_fallback?`<p class="warn">${esc(g.warning)}</p>`:'';return `<div class="transport"><b>${esc(g.operation)} · ${g.mode==='AUTO'?'自动':esc(g.mode)}</b><br>Transport: <strong>${esc(g.transport)}</strong><br>状态：<strong>${esc(g.state)}</strong><br>Job: <code>${esc(g.job_id)}</code>${result}<br>Extension: ${esc(g.extension)}<br>Mailbox: ${esc(g.mailbox)}${g.last_poll?`<br>Last poll: ${esc(g.last_poll)}`:''}${g.last_error?`<br><span class="err">Error: ${esc(g.last_error)}</span>`:''}${warning}${manualFallback(p,g)}</div>`}
function statusCard(p){const cls=p.attention?'attention':'';const pr=p.pr?`<br>PR #${esc(p.pr.number)} · ${esc(p.pr.state||'UNKNOWN')}${p.pr.draft?' · DRAFT':''}`:'';const executor=p.executor?`<br>执行器：${esc(p.executor.state)} ${esc(p.executor.model||'')}`:'';return `<div class="card ${cls}"><strong>${esc(p.p_id)}</strong> <span class="muted">${esc(p.charter_summary||'')}</span><br>启用状态：${p.enabled?'已启用':'已暂停'} · ${p.archived?'已归档':'active'} · merge：${p.allow_merge?'允许合并':'禁止合并'}${pr}<br>当前状态：<strong>${esc(p.semantic_status)}</strong><br>语义动作：<code>${esc(p.action)}</code> · HEAD <code>${esc(p.head||'—')}</code> · SPEC <code>${esc(p.spec_id||'—')}</code><br>阻塞原因：${esc(p.block_reason||'无')}<br>下一步等待：${esc(p.next_wait||'—')}${executor}<br>工作树：${p.worktree?.clean===true?'clean':p.worktree?.clean===false?'dirty':'未知'}<br>${renderPlanControls(p)}${renderGpt(p)}<details><summary>日志 / 证据</summary><pre class="events">${esc(JSON.stringify(p.evidence||[],null,2))}</pre></details><div><button onclick="project(${copyValue(p.p_id)},'enabled',{enabled:${!p.enabled}})">${p.enabled?'暂停':'启用'}</button><button onclick="project(${copyValue(p.p_id)},'allow-merge',{allow_merge:${!p.allow_merge}})">${p.allow_merge?'关闭允许合并':'允许合并'}</button><button onclick="project(${copyValue(p.p_id)},'tick',{})">立即检查 / Tick now</button>${p.archived?`<button onclick="project(${copyValue(p.p_id)},'unarchive',{})">取消归档</button>`:`<button onclick="project(${copyValue(p.p_id)},'archive',{})">归档</button>`}<button onclick="removeProject(${copyValue(p.p_id)})">移出任务列表</button></div></div>`}
function renderList(id,rows){document.getElementById(id).innerHTML=(rows||[]).length?rows.map(statusCard).join(''):'<span class="muted">无</span>'}
function renderLanes(rows){return (rows||[]).map(l=>`${l.semantic_operation||l.name} · production transport: ${l.production_transport||l.transport||'UNKNOWN'}\nextension: ${l.extension||'UNKNOWN'} · mailbox: ${l.mailbox||'UNKNOWN'} · pending jobs: ${l.pending_jobs??l.queued??0}`).join('\n\n')}
function renderBrowserTransport(b){return [`浏览器传输：${b.transport_mode||'UNKNOWN'}`,`Extension：${b.legacy_v1_extension||'UNKNOWN'}`,`Last poll：${b.last_poll||'—'}`,`Mailbox：${b.mailbox||'UNKNOWN'}`,`Pending PLAN：${b.plan?.pending??0}`,`Pending JUDGE：${b.judge?.pending??0}`].join('\n')}
function renderSystem(v){const s=v.scheduler||{},b=v.browser_transport||{};document.getElementById('system').innerHTML=`<div>调度器：<strong>${s.running?'运行中':'已停止'}</strong><br>启用 P：${(s.enabled_p_ids||[]).length} · in-flight：${(s.in_flight_p_ids||[]).length}</div><div>浏览器传输：<strong>${b.legacy_v1_extension||'UNKNOWN'}</strong><br>signed v1 extension · last poll：${b.last_poll||'—'}</div><div>GitHub mailbox：<strong>${v.mailbox==='available'?'可用':(v.mailbox||'未知')}</strong><br>PLAN pending：${b.plan?.pending??0} · JUDGE pending：${b.judge?.pending??0}</div><div>执行器：${(v.executors||[]).map(x=>`${esc(x.name)} ${esc(x.state||'未知')}${x.current_p?` · ${esc(x.current_p)}`:''}`).join('<br>')}</div>`}
function showForm(kind){const adopt=kind==='adopt';document.getElementById('forms').innerHTML=`<section class="card"><h2>${adopt?'接管现有 PR':'新建任务'}</h2><p class="muted">${adopt?'只继承 PR / branch / HEAD identity，不继承旧 AgentBus 语义历史。':'使用现有 v2 init 校验；创建后默认暂停，不自动发送 PLAN。'}</p><div class="formgrid"><label>P_ID<input id="f-pid"></label><label>repository<input id="f-repo" value="github.com/"></label>${adopt?'<label>PR number<input id="f-pr" type="number"></label>':''}<label>worktree<input id="f-wt"></label><label>branch<input id="f-branch"></label><label>base branch<input id="f-base" value="main"></label></div><label>任务说明 / charter<textarea id="f-charter"></textarea></label><button onclick="createOrAdopt('${kind}')">确认</button><button onclick="document.getElementById('forms').innerHTML=''">取消</button></section>`}
async function createOrAdopt(kind){const v={p_id:document.getElementById('f-pid').value,charter:document.getElementById('f-charter').value,repository:document.getElementById('f-repo').value,worktree:document.getElementById('f-wt').value,branch:document.getElementById('f-branch').value,base_ref:document.getElementById('f-base').value};if(kind==='adopt')v.pr_number=Number(document.getElementById('f-pr').value);try{await request('/api/projects/'+(kind==='adopt'?'adopt':'create'),v);document.getElementById('forms').innerHTML='';await refresh()}catch(e){showError(e)}}
async function removeProject(p){if(confirm('只移出控制列表，保留 durable facts、PR、branch 和 worktree。继续？'))await project(p,'remove',{})}
function tickExplain(){if(confirm('重新读取当前事实，并执行最多一个合法 effect。继续？')){const p=prompt('输入要检查的 P_ID');if(p)project(p,'tick',{})}}
function render(v){const s=v.scheduler||{};document.getElementById('summary').textContent=`调度器：${s.running?'运行中':'已停止'} · 启用 ${(s.enabled_p_ids||[]).length} · in-flight ${(s.in_flight_p_ids||[]).length}`;renderSystem(v);renderList('attention',v.attention);renderList('running',v.running);renderList('paused',v.paused);renderList('archived',v.archived);renderList('projects',v.projects);document.getElementById('executors').textContent=JSON.stringify(v.executors||[],null,2);document.getElementById('gpt-lanes').textContent=renderLanes(v.gpt_lanes);document.getElementById('browser-transport').textContent=renderBrowserTransport(v.browser_transport||{});document.getElementById('events').textContent=(v.events||[]).slice().reverse().map(e=>JSON.stringify(e)).join('\n')}
async function refresh(){try{const r=await fetch('/api/status');if(!r.ok)throw Error('HTTP '+r.status);render(await r.json())}catch(e){showError('服务不可用或状态读取失败：'+e)}}refresh();setInterval(refresh,1500);
</script></body></html>"""


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
