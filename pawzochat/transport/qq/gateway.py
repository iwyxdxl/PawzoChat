# PawzoChat - Human-like, versatile, extensible AI companion engine
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""QQ Bot API v2 WebSocket gateway client.

Runs one outbound WebSocket connection per account in a daemon thread (the same
threaded model as the WeChat long-poller). Handles the Hello/Identify/Heartbeat/
Resume handshake, dispatches inbound C2C messages to a callback, and reconnects
with exponential backoff. Group events are intentionally ignored (C2C-only).
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable

import websocket  # websocket-client

from pawzochat.transport.qq.client import QQClient
from pawzochat.transport.qq.models import (
    EVENT_C2C_MESSAGE_CREATE,
    EVENT_READY,
    EVENT_RESUMED,
    INTENT_GROUP_AND_C2C,
    OP_DISPATCH,
    OP_HEARTBEAT,
    OP_HEARTBEAT_ACK,
    OP_HELLO,
    OP_IDENTIFY,
    OP_INVALID_SESSION,
    OP_RECONNECT,
    OP_RESUME,
    QQInboundMessage,
)

logger = logging.getLogger(__name__)

_MAX_BACKOFF_SECONDS = 60
_RATE_LIMIT_DELAY_SECONDS = 60


class QQGateway:
    def __init__(
        self,
        client: QQClient,
        on_message: Callable[[QQInboundMessage], None],
        *,
        label: str = "",
    ):
        self.client = client
        self.on_message = on_message
        self.label = label or (client.app_id[:8] if client.app_id else "qq")
        self._thread: threading.Thread | None = None
        self._ws: websocket.WebSocketApp | None = None
        self._stopped = threading.Event()
        self._connected = False
        self._ready_seen = False
        self._session_id = ""
        self._last_seq: int | None = None
        self._heartbeat_interval_ms = 0
        self._hb_stop: threading.Event | None = None
        self._next_reconnect_delay = 0

    @property
    def running(self) -> bool:
        return self._connected and not self._stopped.is_set()

    # ---- Lifecycle ----

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stopped.clear()
        self._next_reconnect_delay = 0
        self._thread = threading.Thread(
            target=self._run_loop, name=f"qq-gw-{self.label}", daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stopped.set()
        self._stop_heartbeat()
        ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:
                logger.debug("[QQ %s] 关闭 websocket 出错", self.label, exc_info=True)
        self._connected = False

    # ---- Connection loop ----

    def _run_loop(self) -> None:
        backoff = 1
        while not self._stopped.is_set():
            self._ready_seen = False
            try:
                gateway_url = self.client.get_gateway()
            except Exception as exc:
                logger.warning("[QQ %s] 获取网关地址失败: %s", self.label, exc)
                if self._stopped.wait(backoff):
                    break
                backoff = min(backoff * 2, _MAX_BACKOFF_SECONDS)
                continue

            if self._stopped.is_set():
                break
            self._ws = websocket.WebSocketApp(
                gateway_url,
                on_open=self._on_open,
                on_message=self._on_message,
                on_error=self._on_error,
                on_close=self._on_close,
            )
            if self._stopped.is_set():
                break
            try:
                # WS-level ping/pong so a half-open socket is detected and
                # closed (falling through to the reconnect path below) instead
                # of blocking until the OS TCP timeout. ping_interval must be
                # greater than ping_timeout, and both well under QQ's ~40s
                # application heartbeat.
                self._ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception:
                logger.exception("[QQ %s] websocket 运行异常", self.label)

            self._stop_heartbeat()
            self._connected = False
            if self._stopped.is_set():
                break
            # Reset backoff if we had a healthy session this round.
            if self._ready_seen:
                backoff = 1
            custom_delay = self._next_reconnect_delay
            self._next_reconnect_delay = 0
            delay = custom_delay or backoff
            logger.info("[QQ %s] 连接断开，%ds 后重连", self.label, delay)
            if self._stopped.wait(delay):
                break
            if not custom_delay:
                backoff = min(backoff * 2, _MAX_BACKOFF_SECONDS)
        logger.info("[QQ %s] 网关循环结束", self.label)

    # ---- WebSocketApp callbacks ----

    def _on_open(self, ws) -> None:
        # stop() can race the socket handshake; close it as soon as it opens.
        if self._stopped.is_set():
            ws.close()
            return
        logger.debug("[QQ %s] websocket 已连接，等待 Hello", self.label)

    def _on_error(self, _ws, error) -> None:
        logger.warning("[QQ %s] websocket 错误: %s", self.label, error)

    def _on_close(self, _ws, status_code, msg) -> None:
        self._connected = False
        logger.debug("[QQ %s] websocket 关闭 code=%s msg=%s", self.label, status_code, msg)
        if status_code in (4914, 4915):
            logger.error(
                "[QQ %s] 网关权限不可用 (code=%s)，请检查机器人上线状态和事件权限",
                self.label,
                status_code,
            )
            self._stopped.set()
            return
        if status_code == 4004:
            logger.info("[QQ %s] access_token 失效，将刷新后重连", self.label)
            self.client.invalidate_access_token()
            return
        if status_code == 4008:
            logger.warning(
                "[QQ %s] 网关连接触发限流，60 秒后重连",
                self.label,
            )
            self._next_reconnect_delay = _RATE_LIMIT_DELAY_SECONDS
            return
        if (
            status_code in (4006, 4007, 4009)
            or (
                isinstance(status_code, int)
                and 4900 <= status_code <= 4913
            )
        ):
            logger.info(
                "[QQ %s] 网关会话不可恢复 (code=%s)，将重新鉴权",
                self.label,
                status_code,
            )
            self._session_id = ""
            self._last_seq = None
            self.client.invalidate_access_token()

    def _on_message(self, ws, raw: str) -> None:
        if self._stopped.is_set():
            return
        try:
            packet = json.loads(raw)
        except (ValueError, TypeError):
            logger.debug("[QQ %s] 收到非 JSON 帧", self.label)
            return

        if not isinstance(packet, dict):
            return

        op = packet.get("op")
        if op == OP_HELLO:
            self._handle_hello(ws, packet)
        elif op == OP_DISPATCH:
            self._handle_dispatch(packet)
        elif op == OP_HEARTBEAT_ACK:
            return
        elif op == OP_RECONNECT:
            # Server asks us to reconnect; keep session for a resume.
            logger.info("[QQ %s] 服务端要求重连", self.label)
            self._close_socket()
        elif op == OP_INVALID_SESSION:
            can_resume = packet.get("d") is True
            logger.info("[QQ %s] 会话失效，3 秒后重连 (can_resume=%s)", self.label, can_resume)
            if not can_resume:
                self._session_id = ""
                self._last_seq = None
                self.client.invalidate_access_token()
            self._next_reconnect_delay = 3
            self._close_socket()

    # ---- Protocol steps ----

    def _handle_hello(self, ws, packet: dict) -> None:
        d = packet.get("d") or {}
        self._heartbeat_interval_ms = int(d.get("heartbeat_interval", 0) or 0)
        self._start_heartbeat(ws)
        if self._session_id and self._last_seq is not None:
            self._send_resume()
        else:
            self._send_identify()

    def _handle_dispatch(self, packet: dict) -> None:
        seq = packet.get("s")
        if seq is not None:
            self._last_seq = seq
        event_type = packet.get("t")
        d = packet.get("d") or {}

        if event_type == EVENT_READY:
            self._session_id = d.get("session_id", "") or self._session_id
            self._connected = True
            self._ready_seen = True
            logger.info("[QQ %s] 已上线", self.label)
        elif event_type == EVENT_RESUMED:
            self._connected = True
            self._ready_seen = True
            logger.info("[QQ %s] 会话已恢复", self.label)
        elif event_type == EVENT_C2C_MESSAGE_CREATE:
            try:
                self.on_message(QQInboundMessage.from_c2c_event(d))
            except Exception:
                logger.exception("[QQ %s] 处理 C2C 消息出错", self.label)
        # All other events (group, friend add/del, etc.) are ignored.

    def _send_identify(self) -> None:
        try:
            token = self.client.get_access_token()
        except Exception as exc:
            logger.warning("[QQ %s] 鉴权获取 token 失败: %s", self.label, exc)
            self._close_socket()
            return
        self._safe_send({
            "op": OP_IDENTIFY,
            "d": {
                "token": f"QQBot {token}",
                "intents": INTENT_GROUP_AND_C2C,
                "shard": [0, 1],
                "properties": {},
            },
        })

    def _send_resume(self) -> None:
        try:
            token = self.client.get_access_token()
        except Exception as exc:
            logger.warning("[QQ %s] 恢复获取 token 失败: %s", self.label, exc)
            self._close_socket()
            return
        self._safe_send({
            "op": OP_RESUME,
            "d": {
                "token": f"QQBot {token}",
                "session_id": self._session_id,
                "seq": self._last_seq,
            },
        })

    # ---- Heartbeat ----

    def _start_heartbeat(self, ws) -> None:
        self._stop_heartbeat()
        if self._heartbeat_interval_ms <= 0:
            return
        stop = threading.Event()
        self._hb_stop = stop
        interval = self._heartbeat_interval_ms / 1000.0
        threading.Thread(
            target=self._heartbeat_loop, args=(ws, stop, interval),
            name=f"qq-hb-{self.label}", daemon=True,
        ).start()

    def _stop_heartbeat(self) -> None:
        if self._hb_stop is not None:
            self._hb_stop.set()
            self._hb_stop = None

    def _heartbeat_loop(self, ws, stop: threading.Event, interval: float) -> None:
        # Send through the socket this heartbeat was started for, so a heartbeat
        # left over from a previous connection can never emit a pre-handshake
        # frame on a freshly reconnected socket.
        while not stop.wait(interval):
            if stop.is_set() or self._stopped.is_set():
                return
            self._safe_send({"op": OP_HEARTBEAT, "d": self._last_seq}, ws=ws)

    # ---- Helpers ----

    def _safe_send(self, payload: dict, *, ws=None) -> None:
        ws = ws or self._ws
        if ws is None:
            return
        try:
            ws.send(json.dumps(payload))
        except Exception:
            logger.debug("[QQ %s] 发送帧失败", self.label, exc_info=True)

    def _close_socket(self) -> None:
        ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:
                logger.debug("[QQ %s] 关闭 socket 出错", self.label, exc_info=True)
