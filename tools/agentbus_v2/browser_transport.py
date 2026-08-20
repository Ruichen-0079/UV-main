"""Loopback browser transport for the v2 GPT lanes.

This module is deliberately transport-only.  It carries one immutable packet to a
configured browser conversation and returns the assistant's raw text.  Semantic
validation and result persistence remain in :mod:`effects`.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import logging
from pathlib import Path
import threading
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit


LOGGER = logging.getLogger(__name__)
DEFAULT_BRIDGE_HOST = "127.0.0.1"
DEFAULT_BRIDGE_PORT = 6791
BRIDGE_TOKEN_HEADER = "X-AgentBus-Token"
MAX_BRIDGE_BODY = 1_000_000
LANES = frozenset(("plan", "judge"))
OPERATIONS = {"plan": "PLAN_GPT", "judge": "JUDGE_GPT"}


class BrowserTransportError(RuntimeError):
    """An operational browser/bridge failure, never a semantic result."""


def canonical_conversation_url(value: str) -> str:
    """Normalize only URL syntax needed for exact tab matching."""
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise BrowserTransportError("conversation_url must be an absolute HTTP(S) URL")
    path = parsed.path.rstrip("/") or "/"
    return parsed._replace(path=path, fragment="").geturl()


@dataclass
class PendingBrowserJob:
    lane: str
    job_id: str
    operation: str
    packet: str
    conversation_url: str
    event: threading.Event
    response: str | BaseException | None = None

    def as_dict(self) -> dict[str, str]:
        return {
            "lane": self.lane,
            "job_id": self.job_id,
            "operation": self.operation,
            "packet": self.packet,
            "conversation_url": self.conversation_url,
        }


class _BridgeState:
    def __init__(self, token: str) -> None:
        if not token:
            raise BrowserTransportError("browser bridge token is required")
        self.token = token
        self.lock = threading.RLock()
        self.pending: dict[str, PendingBrowserJob] = {}
        self.heartbeats: dict[str, tuple[float, str]] = {}
        self.stopped = False

    def register(
        self,
        lane: str,
        job_id: str,
        operation: str,
        packet: str,
        conversation_url: str,
        timeout: float,
    ) -> str:
        if lane not in LANES:
            raise BrowserTransportError(f"unsupported browser lane: {lane}")
        if operation != OPERATIONS[lane]:
            raise BrowserTransportError(f"operation does not match browser lane: {lane}")
        pending = PendingBrowserJob(
            lane,
            job_id,
            operation,
            packet,
            canonical_conversation_url(conversation_url),
            threading.Event(),
        )
        with self.lock:
            if self.stopped:
                raise BrowserTransportError("browser bridge is stopped")
            if lane in self.pending:
                raise BrowserTransportError(f"browser lane is busy: {lane}")
            self.pending[lane] = pending
        if pending.event.wait(timeout):
            with self.lock:
                current = self.pending.get(lane)
                if current is pending:
                    self.pending.pop(lane, None)
                response = pending.response
            if isinstance(response, BaseException):
                raise response
            if isinstance(response, str) and response.strip():
                return response
            raise BrowserTransportError("browser returned an empty response")
        with self.lock:
            if self.pending.get(lane) is pending:
                self.pending.pop(lane, None)
        raise BrowserTransportError("browser bridge response timed out")

    def stop(self) -> None:
        with self.lock:
            self.stopped = True
            pending = tuple(self.pending.values())
            for item in pending:
                item.response = BrowserTransportError("browser bridge stopped")
                item.event.set()

    def pull(self, lane: str) -> dict[str, str] | None:
        with self.lock:
            item = self.pending.get(lane)
            return None if item is None else item.as_dict()

    def accept_result(self, lane: str, job_id: str, raw_response: str) -> None:
        with self.lock:
            item = self.pending.get(lane)
            if item is None:
                raise BrowserTransportError("no matching browser request is pending")
            if item.job_id != job_id:
                raise BrowserTransportError("browser result job_id does not match pending job")
            if not isinstance(raw_response, str) or not raw_response.strip():
                raise BrowserTransportError("browser result raw_response must be non-empty text")
            if item.response is not None:
                raise BrowserTransportError("browser result was already received")
            item.response = raw_response
            item.event.set()

    def heartbeat(self, lane: str, conversation_url: str) -> None:
        if lane not in LANES:
            raise BrowserTransportError(f"unsupported browser lane: {lane}")
        canonical = canonical_conversation_url(conversation_url)
        with self.lock:
            pending = self.pending.get(lane)
            if pending is not None and pending.conversation_url != canonical:
                raise BrowserTransportError("heartbeat conversation does not match pending lane")
            self.heartbeats[lane] = (time.time(), canonical)

    def lane_status(self, lane: str) -> dict[str, object]:
        with self.lock:
            pending = self.pending.get(lane)
            heartbeat = self.heartbeats.get(lane)
        result: dict[str, object] = {
            "bridge_pending": pending is not None,
            "bridge_connected": bool(
                heartbeat is not None and time.time() - heartbeat[0] <= 15.0
            ),
        }
        if heartbeat is not None:
            result["heartbeat_at"] = heartbeat[0]
        return result


class BrowserBridgeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], state: _BridgeState):
        self.bridge_state = state
        super().__init__(address, BrowserBridgeRequestHandler)


class BrowserBridgeRequestHandler(BaseHTTPRequestHandler):
    server: BrowserBridgeHTTPServer
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        LOGGER.debug("browser bridge %s - %s", self.address_string(), fmt % args)

    def _origin(self) -> str | None:
        origin = self.headers.get("Origin")
        if origin is None:
            return None
        parsed = urlsplit(origin)
        if (
            origin.startswith("moz-extension://")
            or origin in {"https://chatgpt.com", "https://chat.openai.com"}
            or (parsed.scheme == "http" and parsed.hostname == "127.0.0.1")
        ):
            return origin
        raise BrowserTransportError("browser bridge origin is not allowed")

    def _write(self, status: int, payload: object | None = None, *, empty: bool = False) -> None:
        try:
            origin = self._origin()
        except BrowserTransportError:
            # Still return a concrete HTTP error for a rejected origin, but do
            # not grant it CORS access.
            origin = None
        data = b"" if empty else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if origin is not None:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _error(self, status: int, detail: str) -> None:
        try:
            self._write(status, {"error": detail})
        except Exception:
            LOGGER.exception("unable to write browser bridge error")

    def _token(self) -> None:
        self._origin()
        if self.headers.get(BRIDGE_TOKEN_HEADER) != self.server.bridge_state.token:
            raise BrowserTransportError("missing or invalid browser bridge token")

    def _body(self) -> dict[str, object]:
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise BrowserTransportError("bridge body must be application/json")
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError as error:
            raise BrowserTransportError("invalid bridge Content-Length") from error
        if length < 0 or length > MAX_BRIDGE_BODY:
            raise BrowserTransportError("bridge body is missing or too large")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BrowserTransportError("malformed bridge JSON") from error
        if not isinstance(value, dict):
            raise BrowserTransportError("bridge JSON body must be an object")
        return value

    @staticmethod
    def _exact(value: dict[str, object], keys: set[str]) -> None:
        if set(value) != keys:
            raise BrowserTransportError(f"bridge keys must be exactly {sorted(keys)}")

    def do_OPTIONS(self) -> None:
        try:
            origin = self._origin()
            self.send_response(204)
            self.send_header("Content-Length", "0")
            if origin is not None:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Headers", BRIDGE_TOKEN_HEADER + ", Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Vary", "Origin")
            self.end_headers()
        except BrowserTransportError as error:
            self._error(403, str(error))

    def do_GET(self) -> None:
        try:
            self._token()
            parsed = urlsplit(self.path)
            if parsed.path != "/bridge/pull":
                raise BrowserTransportError("unknown browser bridge endpoint")
            values = parse_qs(parsed.query, keep_blank_values=True)
            lane = values.get("lane", [""])[0]
            if lane not in LANES:
                raise BrowserTransportError("unsupported browser lane")
            payload = self.server.bridge_state.pull(lane)
            if payload is None:
                self._write(204, empty=True)
            else:
                self._write(200, payload)
        except BrowserTransportError as error:
            self._error(403 if "token" in str(error) or "origin" in str(error) else 400, str(error))
        except Exception:
            LOGGER.exception("browser bridge GET failed")
            self._error(500, "internal browser bridge error")

    def do_POST(self) -> None:
        try:
            self._token()
            parsed = urlsplit(self.path)
            body = self._body()
            if parsed.path == "/bridge/result":
                self._exact(body, {"lane", "job_id", "raw_response"})
                lane, job_id, raw = body["lane"], body["job_id"], body["raw_response"]
                if type(lane) is not str or type(job_id) is not str or type(raw) is not str:
                    raise BrowserTransportError("bridge result fields must be strings")
                self.server.bridge_state.accept_result(lane, job_id, raw)
                self._write(200, {"accepted": True})
                return
            if parsed.path == "/bridge/heartbeat":
                self._exact(body, {"lane", "conversation_url"})
                lane, url = body["lane"], body["conversation_url"]
                if type(lane) is not str or type(url) is not str:
                    raise BrowserTransportError("heartbeat fields must be strings")
                self.server.bridge_state.heartbeat(lane, url)
                self._write(200, {"accepted": True})
                return
            raise BrowserTransportError("unknown browser bridge endpoint")
        except BrowserTransportError as error:
            text = str(error)
            status = 403 if "token" in text or "origin" in text else 409
            self._error(status, text)
        except Exception:
            LOGGER.exception("browser bridge POST failed")
            self._error(500, "internal browser bridge error")


class BrowserBridge:
    """One ephemeral HTTP bridge owned by one operational transport process."""

    def __init__(
        self,
        token: str,
        *,
        host: str = DEFAULT_BRIDGE_HOST,
        port: int = DEFAULT_BRIDGE_PORT,
    ) -> None:
        if host != DEFAULT_BRIDGE_HOST:
            raise BrowserTransportError("browser bridge must bind loopback")
        if not 0 <= port <= 65535:
            raise ValueError("browser bridge port must be between 0 and 65535")
        self.state = _BridgeState(token)
        self.host = host
        self.requested_port = port
        self.server: BrowserBridgeHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self._start_lock = threading.Lock()

    @property
    def port(self) -> int:
        return int(self.server.server_address[1]) if self.server is not None else self.requested_port

    def start(self) -> None:
        with self._start_lock:
            if self.server is not None:
                return
            self.server = BrowserBridgeHTTPServer((self.host, self.requested_port), self.state)
            self.thread = threading.Thread(
                target=self.server.serve_forever,
                name="agentbus-v2-browser-bridge",
                daemon=True,
            )
            self.thread.start()

    def request(
        self,
        lane: str,
        job_id: str,
        operation: str,
        packet: str,
        conversation_url: str,
        timeout: float,
    ) -> str:
        self.start()
        return self.state.register(lane, job_id, operation, packet, conversation_url, timeout)

    def lane_status(self, lane: str) -> dict[str, object]:
        return self.state.lane_status(lane)

    def close(self) -> None:
        self.state.stop()
        server, thread = self.server, self.thread
        self.server = None
        self.thread = None
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=2)


class BrowserAdapter:
    """GPTAdapter implementation backed by the local v2 browser bridge."""

    def __init__(
        self,
        state_root: Path,
        *,
        config_path: Path | None = None,
        host: str = DEFAULT_BRIDGE_HOST,
        port: int = DEFAULT_BRIDGE_PORT,
        timeout: float = 120.0,
        bridge: BrowserBridge | None = None,
    ) -> None:
        self.state_root = Path(state_root).resolve()
        self.config_path = Path(config_path).resolve() if config_path else None
        self.timeout = timeout
        self.bridge = bridge
        self.host = host
        self.port = port
        self._token: str | None = None
        self._lock = threading.Lock()

    def _lane_config(self, lane: str):
        from .gpt_transport import load_lane_config

        try:
            return load_lane_config(self.state_root, self.config_path)[lane]
        except KeyError as error:
            raise BrowserTransportError(f"unsupported browser lane: {lane}") from error

    def _bridge_for(self, token: str) -> BrowserBridge:
        with self._lock:
            if self._token is not None and self._token != token:
                raise BrowserTransportError("plan and judge browser bridge tokens must match")
            self._token = token
            if self.bridge is None:
                self.bridge = BrowserBridge(token, host=self.host, port=self.port)
            elif self.bridge.state.token != token:
                raise BrowserTransportError("browser bridge token does not match lane config")
            return self.bridge

    def send(self, lane: str, job_id: str, operation: str, packet_text: str) -> str:
        config = self._lane_config(lane)
        if config.transport != "browser":
            raise BrowserTransportError(f"{lane} lane is not configured for browser transport")
        if not config.conversation_url:
            raise BrowserTransportError(f"{lane} browser conversation_url is not configured")
        if not config.bridge_token:
            raise BrowserTransportError(f"{lane} browser bridge_token is not configured")
        bridge = self._bridge_for(config.bridge_token)
        return bridge.request(
            lane,
            job_id,
            operation,
            packet_text,
            config.conversation_url,
            self.timeout,
        )

    def lane_status(self, lane: str) -> dict[str, object]:
        with self._lock:
            bridge = self.bridge
        return {} if bridge is None else bridge.lane_status(lane)

    def close(self) -> None:
        with self._lock:
            bridge = self.bridge
            self.bridge = None
            self._token = None
        if bridge is not None:
            bridge.close()
