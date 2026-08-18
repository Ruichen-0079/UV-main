"""Localhost-only WebUI over the existing AgentBus core."""

from __future__ import annotations

import json
import os
import posixpath
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from agentbus import views
from agentbus.actions import (
    archive_stream,
    arm_step,
    bind_browser_gpt,
    create_stream,
    delete_stream,
    pause_stream,
    purge_stream,
    request_audit_current,
    resolve_audit_target,
    resume_stream,
    set_role_model,
    unarchive_stream,
    unbind_browser_gpt,
)
from agentbus.github import pr_web_url
from agentbus.konsolebind import focus_role_konsole, launch_role_konsole
from agentbus.machine import next_actor
from agentbus.paths import AgentbusError, RepoContext, normalize_stream_id
from agentbus.runner import refresh_stream
from agentbus.store import StreamStore
from agentbus.util import sha256_text, tail_text


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 6738
STATIC_DIR = os.path.join(os.path.dirname(__file__), "webui")
STATIC_NAMES = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "icon.svg": "image/svg+xml",
}


class WebContext:
    def __init__(self, repo: RepoContext, env: dict[str, str] | None = None) -> None:
        self.repo = repo
        self.env = env
        self.last_tick = 0.0


def _json_bytes(payload: Any, status: int = 200) -> tuple[int, str, bytes]:
    body = json.dumps(payload, default=str).encode("utf-8")
    return status, "application/json; charset=utf-8", body


class AgentBusHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], webctx: WebContext) -> None:
        super().__init__(address, handler)
        self.webctx = webctx


class AgentBusHandler(BaseHTTPRequestHandler):
    server_version = "YuviAgentBus/1"
    server: AgentBusHTTPServer

    @property
    def ctx(self) -> WebContext:
        return self.server.webctx

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _send(self, status: int, content_type: str, body: bytes, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra:
            for key, value in extra.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        if length > 1_000_000:
            raise AgentbusError("request too large")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise AgentbusError("JSON object required")
        return data

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlparse(origin)
        return parsed.hostname in {"127.0.0.1", "localhost"}

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = posixpath.normpath(parsed.path)
        try:
            if path in {"/", "/index.html"}:
                return self._static("index.html")
            if path.lstrip("/") in STATIC_NAMES:
                return self._static(path.lstrip("/"))
            if path == "/api/health":
                return self._send(*_json_bytes(self._health()))
            if path == "/api/browser/jobs":
                self._maybe_tick()
                from agentbus.browser import list_browser_jobs
                from agentbus.settings import browser_bridge_status, note_browser_poll

                note_browser_poll(self.ctx.repo)
                return self._send(
                    *_json_bytes(
                        {
                            "jobs": list_browser_jobs(self.ctx.repo),
                            "bridge": browser_bridge_status(self.ctx.repo),
                            "authority": "GitHub PR comments and PR state",
                        }
                    )
                )
            if path == "/api/settings":
                from agentbus.settings import browser_bridge_status, load_settings

                return self._send(
                    *_json_bytes(
                        {
                            "settings": load_settings(self.ctx.repo),
                            "browser_bridge": browser_bridge_status(self.ctx.repo),
                        }
                    )
                )
            if path == "/api/overview":
                self._maybe_tick()
                qs = parse_qs(parsed.query)
                include_archived = (qs.get("include_archived") or ["0"])[0] in {"1", "true", "yes"}
                return self._send(*_json_bytes(views.overview(self.ctx.repo, self.ctx.env, include_archived=include_archived)))
            if path == "/api/models":
                return self._send(*_json_bytes(views.catalog(self.ctx.env)))
            if path == "/api/live":
                return self._sse()
            if path == "/api/streams":
                return self._send(*_json_bytes({"streams": views.list_stream_views(self.ctx.repo, self.ctx.env)}))
            if path.startswith("/api/streams/"):
                return self._get_stream(path, parsed.query)
        except AgentbusError as exc:
            payload = {"ok": False, "error": str(exc)}
            if getattr(exc, "code", None):
                payload["code"] = exc.code
            return self._send(*_json_bytes(payload, 400))
        except FileNotFoundError:
            return self._send(*_json_bytes({"ok": False, "error": "not found"}, 404))
        except Exception as exc:  # noqa: BLE001
            return self._send(*_json_bytes({"ok": False, "error": f"internal error: {type(exc).__name__}: {exc}"[:400]}, 500))
        self._send(*_json_bytes({"ok": False, "error": "not found"}, 404))

    def do_POST(self) -> None:
        if not self._origin_ok():
            return self._send(*_json_bytes({"error": "refusing non-localhost Origin"}, 403))
        parsed = urlparse(self.path)
        path = posixpath.normpath(parsed.path)
        try:
            payload = self._read_json()
            if path == "/api/settings/gpt":
                from agentbus.settings import set_global_binding

                settings = set_global_binding(
                    self.ctx.repo,
                    str(payload.get("role") or ""),
                    display_name=payload.get("display_name"),
                    url=payload.get("url"),
                    note=payload.get("note"),
                )
                return self._send(*_json_bytes({"ok": True, "settings": settings}))
            if path == "/api/campaign/tick" or path == "/api/sync":
                from agentbus.autopilot import campaign_tick

                result = campaign_tick(self.ctx.repo, env=self.ctx.env, force_sync=True, surface="webui")
                return self._send(*_json_bytes({"ok": True, **result}))
            if path == "/api/streams":
                return self._create(payload)
            if path.startswith("/api/streams/"):
                return self._mutate(path, payload)
        except AgentbusError as exc:
            payload = {"ok": False, "error": str(exc)}
            if getattr(exc, "code", None):
                payload["code"] = exc.code
            return self._send(*_json_bytes(payload, 400))
        except json.JSONDecodeError:
            return self._send(*_json_bytes({"ok": False, "error": "invalid JSON"}, 400))
        except Exception as exc:  # noqa: BLE001
            return self._send(
                *_json_bytes(
                    {
                        "ok": False,
                        "error": "Sync failed" if path.endswith("/sync") else "request failed",
                        "detail": f"{type(exc).__name__}: {exc}"[:400],
                    },
                    502,
                )
            )
        self._send(*_json_bytes({"ok": False, "error": "not found"}, 404))

    def _static(self, name: str) -> None:
        if name not in STATIC_NAMES:
            return self._send(*_json_bytes({"error": "not found"}, 404))
        path = os.path.join(STATIC_DIR, name)
        if not os.path.isfile(path):
            return self._send(*_json_bytes({"error": "ui asset missing"}, 404))
        with open(path, "rb") as handle:
            body = handle.read()
        self._send(200, STATIC_NAMES[name], body)

    def _maybe_tick(self) -> None:
        now = time.time()
        if now - self.ctx.last_tick < 8:
            return
        self.ctx.last_tick = now
        try:
            from agentbus.autopilot import campaign_tick

            campaign_tick(self.ctx.repo, env=self.ctx.env, surface="webui")
        except Exception:
            return

    def _health(self) -> dict[str, Any]:
        from agentbus.settings import browser_bridge_status

        return {
            "ok": True,
            "service": "yuvi-agentbus",
            "host": DEFAULT_HOST,
            "repo_id": self.ctx.repo.repo_id,
            "repo_root": self.ctx.repo.repo_root,
            "browser_bridge": browser_bridge_status(self.ctx.repo),
        }

    def _store(self, stream_id: str) -> StreamStore:
        store = StreamStore(self.ctx.repo, normalize_stream_id(stream_id))
        if not store.exists():
            raise AgentbusError(f"unknown stream {stream_id}")
        return store

    def _get_stream(self, path: str, query: str) -> None:
        parts = [item for item in path.split("/") if item]
        # api streams <id> [logs|events]
        if len(parts) < 3:
            raise AgentbusError("missing stream id")
        stream_id = parts[2]
        store = self._store(stream_id)
        qs = parse_qs(query)
        if len(parts) == 3:
            return self._send(*_json_bytes(views.stream_view(self.ctx.repo, store, env=self.ctx.env, recover=True)))
        if parts[3] == "events":
            limit = int((qs.get("limit") or ["80"])[0])
            return self._send(*_json_bytes({"events": views.event_rows(store, limit=min(limit, 300))}))
        if parts[3] == "audit-current":
            state = store.load()
            resolved = resolve_audit_target(state)
            return self._send(*_json_bytes(resolved))
        if parts[3] == "merge-prompt":
            from agentbus.campaign import infer_campaign_id, load_campaign
            from agentbus.mergegate import merge_prompt_text, unit_head

            state = store.load()
            campaign = load_campaign(self.ctx.repo, infer_campaign_id(state))
            text = merge_prompt_text(state, campaign)
            return self._send(*_json_bytes({"ok": True, "text": text, "head": unit_head(state)}))
        if parts[3] == "logs":
            from agentbus.display import sanitize_display_text

            kind = (qs.get("kind") or ["impl"])[0]
            if kind not in {"impl", "audit", "events"}:
                raise AgentbusError("kind must be impl, audit, or events")
            lines = int((qs.get("lines") or ["200"])[0])
            path_log = store.events_path if kind == "events" else store.log_path(kind)
            state = store.load()
            return self._send(
                *_json_bytes(
                    {
                        "kind": kind,
                        "path": os.path.basename(path_log),
                        "text": sanitize_display_text(
                            tail_text(path_log, min(lines, 2000)),
                            roots=tuple(
                                str(item)
                                for item in (state.get("audit_worktree"), state.get("impl_worktree"))
                                if item
                            ),
                        ),
                    }
                )
            )
        raise AgentbusError("unknown stream resource")

    def _create(self, payload: dict[str, Any]) -> None:
        state, notes = create_stream(
            self.ctx.repo,
            str(payload.get("stream") or payload.get("stream_id") or ""),
            pr=int(payload["pr"]) if payload.get("pr") not in (None, "") else None,
            branch=payload.get("branch") or None,
            goal=payload.get("goal") or None,
            worktree=payload.get("worktree") or None,
            create_worktree=bool(payload.get("create_worktree")),
            impl_model=payload.get("impl_model") or None,
            impl_effort=payload.get("impl_effort") or None,
            audit_model=payload.get("audit_model") or None,
            audit_effort=payload.get("audit_effort") or None,
            browser_name=payload.get("browser_name") or None,
            browser_url=payload.get("browser_url") or None,
            browser_note=payload.get("browser_note") or None,
        )
        store = StreamStore(self.ctx.repo, state["stream_id"])
        view = views.stream_view(self.ctx.repo, store, env=self.ctx.env)
        return self._send(*_json_bytes({"ok": True, "notes": notes, "stream": view}, 201))

    def _mutate(self, path: str, payload: dict[str, Any]) -> None:
        parts = [item for item in path.split("/") if item]
        if len(parts) < 4:
            raise AgentbusError("missing action")
        stream_id = parts[2]
        action = parts[3]
        store = self._store(stream_id)
        if action == "pause":
            pause_stream(store)
        elif action == "resume":
            resume_stream(store)
        elif action == "step":
            return self._step(store, stream_id)
        elif action == "sync":
            try:
                from agentbus.autopilot import campaign_tick

                result = campaign_tick(
                    self.ctx.repo, env=self.ctx.env, force_sync=True, surface="webui"
                )
                view = views.stream_view(self.ctx.repo, store, env=self.ctx.env)
                notes: list[str] = []
                for item in result.get("results") or []:
                    notes.extend(item.get("notes") or [])
                    notes.append(f"{item.get('stream_id')}: {item.get('phase')}")
                return self._send(
                    *_json_bytes(
                        {
                            "ok": True,
                            "notes": notes,
                            "synced": result.get("synced") or [],
                            "stream": view,
                            "results": result.get("results") or [],
                        }
                    )
                )
            except Exception as exc:  # noqa: BLE001
                return self._send(
                    *_json_bytes(
                        {
                            "ok": False,
                            "error": "Sync failed",
                            "detail": f"{type(exc).__name__}: {exc}"[:400],
                        },
                        502,
                    )
                )
        elif action == "delete":
            result = delete_stream(
                self.ctx.repo,
                store,
                delete_worktrees=bool(payload.get("delete_worktrees", True)),
            )
            return self._send(*_json_bytes(result))
        elif action == "archive":
            result = archive_stream(self.ctx.repo, store)
            return self._send(*_json_bytes({**result, "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env)}))
        elif action == "unarchive":
            result = unarchive_stream(self.ctx.repo, store)
            return self._send(*_json_bytes({**result, "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env)}))
        elif action == "purge":
            if not payload.get("confirm"):
                raise AgentbusError("purge requires confirm=true")
            result = purge_stream(
                self.ctx.repo,
                store,
                delete_worktrees=bool(payload.get("delete_worktrees", False)),
            )
            return self._send(*_json_bytes(result))
        elif action == "publish":
            from agentbus.actions import publish_existing_implementation

            result = publish_existing_implementation(
                self.ctx.repo, store, reset_infra_budget=bool(payload.get("recover"))
            )
            return self._send(
                *_json_bytes(
                    {
                        "ok": True,
                        "commit": result.get("commit"),
                        "files": result.get("files"),
                        "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env),
                    }
                )
            )
        elif action == "audit-current":
            result = request_audit_current(
                store,
                expected_target=payload.get("target"),
                allow_pr_head=bool(payload.get("allow_pr_head")),
                pr_head=payload.get("pr_head"),
            )
            return self._send(*_json_bytes({"ok": True, **result, "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env)}))
        elif action == "model":
            set_role_model(
                store,
                str(payload.get("role") or ""),
                model=payload.get("model"),
                effort=payload.get("effort"),
                profile=payload.get("profile"),
                inherit_model=bool(payload.get("inherit_model")),
                inherit_effort=bool(payload.get("inherit_effort")),
                inherit_profile=bool(payload.get("inherit_profile")),
                execution_mode=payload.get("execution_mode"),
                inherit_execution_mode=bool(payload.get("inherit_execution_mode")),
            )
        elif action == "bind-gpt":
            bind_browser_gpt(
                store,
                display_name=payload.get("display_name"),
                url=payload.get("url"),
                note=payload.get("note"),
            )
        elif action == "unbind-gpt":
            unbind_browser_gpt(store)
        elif action == "bind-merge-gpt":
            from agentbus.mergegate import bind_merge_gpt

            bind_merge_gpt(
                store,
                display_name=payload.get("display_name"),
                url=payload.get("url"),
                note=payload.get("note"),
                ctx=self.ctx.repo,
                bind_campaign=bool(payload.get("campaign")),
            )
        elif action == "pass-and-merge":
            from agentbus.mergegate import pass_and_merge

            result = pass_and_merge(
                self.ctx.repo,
                store,
                expected_stream=stream_id,
                expected_head=payload.get("expected_head"),
                expected_pr=int(payload["pr"]) if payload.get("pr") not in (None, "") else None,
                env=self.ctx.env,
            )
            status = 200 if result.get("ok") else 409
            return self._send(
                *_json_bytes(
                    {**result, "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env)},
                    status,
                )
            )
        elif action == "retry-merge":
            from agentbus.mergegate import retry_merge

            result = retry_merge(
                self.ctx.repo,
                store,
                expected_stream=stream_id,
                expected_head=payload.get("expected_head"),
                expected_pr=int(payload["pr"]) if payload.get("pr") not in (None, "") else None,
                env=self.ctx.env,
            )
            status = 200 if result.get("ok") else 409
            return self._send(
                *_json_bytes(
                    {**result, "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env)},
                    status,
                )
            )
        elif action == "open-merge-gpt":
            from agentbus.campaign import infer_campaign_id, load_campaign
            from agentbus.mergegate import merge_gpt_binding, write_merge_prompt

            state = store.load()
            campaign = load_campaign(self.ctx.repo, infer_campaign_id(state))
            write_merge_prompt(store, state, campaign)
            store.save(state)
            binding = merge_gpt_binding(state, campaign, self.ctx.repo)
            return self._send(
                *_json_bytes(
                    {
                        "ok": True,
                        "url": binding.get("url"),
                        "review_complete": False,
                        "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env),
                    }
                )
            )
        elif action == "open-terminal":
            return self._open_terminal(store, stream_id, str(payload.get("role") or ""))
        elif action == "focus-terminal":
            result = focus_role_konsole(store, stream_id, str(payload.get("role") or ""), env=self.ctx.env)
            return self._send(*_json_bytes(result, 200 if result.get("ok") else 409))
        elif action == "workspace":
            return self._workspace(store, stream_id)
        else:
            raise AgentbusError(f"unknown action {action}")
        view = views.stream_view(self.ctx.repo, store, env=self.ctx.env)
        return self._send(*_json_bytes({"ok": True, "stream": view}))

    def _open_terminal(self, store: StreamStore, stream_id: str, role: str) -> None:
        if role not in {"impl", "audit"}:
            raise AgentbusError("role must be impl or audit")
        state = store.load()
        workdir = state.get("impl_worktree") if role == "impl" else (state.get("audit_worktree") or state.get("impl_worktree"))
        if role == "impl" and not workdir:
            raise AgentbusError("stream has no impl worktree; bind or create one first")
        if not workdir:
            raise AgentbusError("no worktree for this role")
        info = launch_role_konsole(store, stream_id, role, workdir, env=self.ctx.env)
        return self._send(*_json_bytes({"ok": True, "konsole": info, "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env)}))

    def _step(self, store: StreamStore, stream_id: str) -> None:
        state = arm_step(store)
        actor = next_actor(state, control=state.get("control") or "running")
        if actor in {"IMPL", "AUDIT"}:
            role = actor.lower()
            workdir = state.get("impl_worktree") if role == "impl" else (state.get("audit_worktree") or state.get("impl_worktree"))
            if not workdir:
                raise AgentbusError("cannot step: missing worktree")
            info = launch_role_konsole(
                store,
                stream_id,
                role,
                workdir,
                extra_args=["--once"],
                env=self.ctx.env,
            )
            return self._send(
                *_json_bytes(
                    {
                        "ok": True,
                        "launched": role,
                        "konsole": info,
                        "message": f"Step armed and {role.upper()} Konsole opened. Codex stays visible in the terminal.",
                        "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env),
                    }
                )
            )
        return self._send(
            *_json_bytes(
                {
                    "ok": True,
                    "launched": None,
                    "message": "No Codex step to run; stream is waiting for human/GPT.",
                    "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env),
                }
            )
        )

    def _workspace(self, store: StreamStore, stream_id: str) -> None:
        state = store.load()
        opened: list[str] = []
        reused: list[str] = []
        browser = (state.get("browser_gpt") or {}).get("url")
        impl_dir = state.get("impl_worktree")
        audit_dir = state.get("audit_worktree") or impl_dir
        for role, directory in (("impl", impl_dir), ("audit", audit_dir)):
            if not directory:
                continue
            info = launch_role_konsole(store, stream_id, role, directory, env=self.ctx.env, reuse=True)
            if info.get("reused"):
                reused.append(role)
            else:
                opened.append(role)
        return self._send(
            *_json_bytes(
                {
                    "ok": True,
                    "opened": opened,
                    "reused": reused,
                    "browser_url": browser,
                    "pr_url": pr_web_url(self.ctx.repo.origin, state.get("pr")),
                    "message": "Workspace ready. Existing role terminals were reused when alive. Focus was not stolen.",
                    "stream": views.stream_view(self.ctx.repo, store, env=self.ctx.env),
                }
            )
        )

    def _sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last = ""
        try:
            while True:
                payload = views.overview(self.ctx.repo, self.ctx.env)
                digest = sha256_text(json.dumps(payload, sort_keys=True, default=str))
                if digest != last:
                    last = digest
                    chunk = f"data: {json.dumps(payload, default=str)}\n\n".encode("utf-8")
                    self.wfile.write(chunk)
                    self.wfile.flush()
                else:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                time.sleep(1.5)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return


def make_server(ctx: RepoContext, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, env: dict[str, str] | None = None) -> ThreadingHTTPServer:
    if host not in {"127.0.0.1", "localhost"}:
        raise AgentbusError("WebUI binds to 127.0.0.1 only")
    return AgentBusHTTPServer((host, port), AgentBusHandler, WebContext(ctx, env))


def serve_forever(ctx: RepoContext, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, env: dict[str, str] | None = None) -> None:
    httpd = make_server(ctx, host, port, env)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
