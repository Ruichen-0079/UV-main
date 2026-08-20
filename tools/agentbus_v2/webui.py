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
from .executor_pool import list_executor_accounts
from .facts import FactError, load_config, paths_for, read_snapshot, sha256_text
from .scheduler import (
    ProjectEntry,
    Scheduler,
    SchedulerEvent,
    load_registry,
    update_project,
)


LOGGER = logging.getLogger(__name__)
DEFAULT_WEB_HOST = "127.0.0.1"
DEFAULT_WEB_PORT = 6790
MAX_REQUEST_BYTES = 1_000_000


class WebUIError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class WebUIState:
    """Owns only ephemeral UI/scheduler resources and registry mutations."""

    def __init__(self, state_root: Path, *, registry_path: Path | None = None) -> None:
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
        result = update_project(
            self.state_root, p_id, enabled=enabled, path=self.registry_file
        )
        return next(item for item in result.entries if item.p_id == p_id)

    def set_allow_merge(self, p_id: str, allow_merge: bool) -> ProjectEntry:
        result = update_project(
            self.state_root, p_id, allow_merge=allow_merge, path=self.registry_file
        )
        return next(item for item in result.entries if item.p_id == p_id)

    def tick_now(self, p_id: str) -> dict[str, object]:
        self.project(p_id)
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

    def status(self) -> dict[str, object]:
        registry = self.registry()
        scheduler_status = self.scheduler_status()
        gpt_transport = self.scheduler.gpt_transport
        with self._lock:
            events = [event.as_dict() for event in self._events]
        projects: list[dict[str, object]] = []
        for entry in registry.entries:
            paths = paths_for(self.state_root, entry.p_id)
            projection: dict[str, object] = {
                "p_id": entry.p_id,
                "enabled": entry.enabled,
                "allow_merge": entry.allow_merge,
                "in_flight": self.scheduler.is_in_flight(entry.p_id),
                "action": "ERROR",
                "detail": self._latest_detail(entry.p_id),
                "head": None,
                "spec_id": None,
                "manual_gpt": None,
            }
            try:
                config = load_config(paths)
                snapshot = read_snapshot(paths, allow_merge=entry.allow_merge)
                action = decide(snapshot)
                projection.update(
                    {
                        "action": action.kind.value,
                        "detail": projection["detail"] or action.reason,
                        "head": snapshot.head[:8],
                        "spec_id": snapshot.specs[-1].spec_id if snapshot.specs else None,
                        "manual_gpt": self._manual_packet(paths, action),
                    }
                )
                if projection["manual_gpt"] is not None:
                    projection["manual_gpt"]["mode"] = gpt_transport.mode_for(action)
                # Keep config loading explicit: it fences the registered P before
                # projecting any of its durable facts.
                if config.p_id != entry.p_id:
                    raise FactError("registered P/config identity mismatch")
            except (FactError, OSError) as error:
                projection["detail"] = str(error)
            projects.append(projection)
        return {
            "server": {"name": "agentbus-v2-webui", "loopback": True},
            "scheduler": scheduler_status,
            "executors": list_executor_accounts(self.state_root),
            "gpt_lanes": gpt_transport.status(),
            "projects": projects,
            "events": events,
        }


INDEX_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentBus v2</title><style>
:root{font:14px system-ui,sans-serif;color:#e8edf2;background:#171a1e}body{margin:20px}button{margin:2px;padding:5px 9px;background:#29313a;color:#e8edf2;border:1px solid #56616d;border-radius:4px}button:hover{background:#35414d}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #30363d;padding:7px;text-align:left;vertical-align:top}th{color:#9da9b5}.muted{color:#9da9b5}.ok{color:#8ed081}.warn{color:#ffd166}.err{color:#ff7b72}textarea{width:100%;min-height:90px;background:#0f1114;color:#e8edf2;border:1px solid #56616d}code{font-size:12px}#error{min-height:20px;color:#ff7b72}.events{max-height:180px;overflow:auto;white-space:pre-wrap;font:12px ui-monospace,monospace}
</style></head><body><h1>AgentBus v2</h1><div id="toolbar"><button onclick="scheduler('start')">Start Scheduler</button><button onclick="scheduler('stop')">Stop Scheduler</button><span id="summary" class="muted"></span></div><div id="error"></div><table><thead><tr><th>P</th><th>Schedule</th><th>Action</th><th>HEAD / SPEC</th><th>GPT</th><th>Controls</th></tr></thead><tbody id="projects"></tbody></table><h3>Executors</h3><pre id="executors" class="muted"></pre><h3>GPT lanes</h3><pre id="gpt-lanes" class="muted"></pre><h3>Recent events</h3><div id="events" class="events"></div><script>
const TOKEN=__TOKEN__;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function request(url,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-AgentBus-Token':TOKEN},body:JSON.stringify(body??{})});let v;try{v=await r.json()}catch{throw Error('HTTP '+r.status+' (non-JSON response)')}if(!r.ok)throw Error(v.error||('HTTP '+r.status));return v}
async function scheduler(op){try{await request('/api/scheduler/'+op,{});await refresh()}catch(e){showError(e)}}
async function project(p,op,body){try{await request('/api/project/'+encodeURIComponent(p)+'/'+op,body);await refresh()}catch(e){showError(e)}}
async function submit(p){const box=document.getElementById('gpt-'+CSS.escape(p));try{const v=JSON.parse(box.value);await request('/api/project/'+encodeURIComponent(p)+'/gpt-submit',v);box.value='';await refresh()}catch(e){showError(e)}}
function copyText(v){navigator.clipboard?.writeText(v)}
function showError(e){document.getElementById('error').textContent=String(e);setTimeout(()=>document.getElementById('error').textContent='',5000)}
function render(v){const s=v.scheduler||{};document.getElementById('summary').textContent='scheduler '+(s.running?'RUNNING':'STOPPED')+' · enabled '+(s.enabled_p_ids||[]).length+' · in-flight '+(s.in_flight_p_ids||[]).length;document.getElementById('executors').textContent=JSON.stringify(v.executors||[],null,2);document.getElementById('gpt-lanes').textContent=JSON.stringify(v.gpt_lanes||[],null,2);document.getElementById('events').textContent=(v.events||[]).slice().reverse().map(e=>JSON.stringify(e)).join('\n');document.getElementById('projects').innerHTML=(v.projects||[]).map(p=>{const g=p.manual_gpt;return `<tr><td><strong>${esc(p.p_id)}</strong><br><span class="muted">${p.in_flight?'IN-FLIGHT':'IDLE'}</span></td><td>${p.enabled?'<span class="ok">ENABLED</span>':'<span class="muted">DISABLED</span>'}<br>merge ${p.allow_merge?'ON':'OFF'}</td><td><strong>${esc(p.action)}</strong><br><span class="${p.action==='HUMAN'?'err':'muted'}">${esc(p.detail)}</span></td><td><code>${esc(p.head||'—')}</code><br><code>${esc(p.spec_id||'—')}</code></td><td>${g?`<b class="warn">${esc(g.operation)}</b> <span class="muted">${esc(g.mode||'MANUAL')}</span><br><code>${esc(g.job_id)}</code><br><button onclick="copyText(decodeURIComponent('${encodeURIComponent(g.packet_path).replaceAll("'","%27")}'))">Copy packet path</button><button onclick="copyText('${esc(g.instruction)}')">Copy instruction</button><br><code>${esc(g.packet_sha256||'packet not generated yet')}</code><textarea id="gpt-${esc(p.p_id)}" placeholder="Paste exact GPT JSON here"></textarea><button onclick="submit('${esc(p.p_id)}')">Submit</button>`:'—'}</td><td><button onclick="project('${esc(p.p_id)}','enabled',{enabled:${!p.enabled}})">${p.enabled?'Disable':'Enable'}</button><button onclick="project('${esc(p.p_id)}','allow-merge',{allow_merge:${!p.allow_merge}})">${p.allow_merge?'Disallow merge':'Allow merge'}</button><button onclick="project('${esc(p.p_id)}','tick',{})">Tick now</button></td></tr>`}).join('')}
async function refresh(){try{const r=await fetch('/api/status');if(!r.ok)throw Error('HTTP '+r.status);render(await r.json())}catch(e){showError('Server unreachable or status failed: '+e)}}refresh();setInterval(refresh,1500);
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
    if not host:
        raise ValueError("webui host cannot be empty")
    if port < 0 or port > 65535:
        raise ValueError("webui port must be between 0 and 65535")
    return WebUIHTTPServer((host, port), state)
