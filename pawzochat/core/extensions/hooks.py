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

"""Typed extension hooks and registration helpers."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger(__name__)

HOOK_MESSAGE_RECEIVED = "message.received"
HOOK_MESSAGE_STORED = "message.stored"
HOOK_CONTEXT_BUILD = "context.build"
HOOK_REPLY_COMPOSE = "reply.compose"
HOOK_REPLY_PRE_SEND = "reply.pre_send"
HOOK_REPLY_SENT = "reply.sent"

HOOK_NAMES = (
    HOOK_MESSAGE_RECEIVED,
    HOOK_MESSAGE_STORED,
    HOOK_CONTEXT_BUILD,
    HOOK_REPLY_COMPOSE,
    HOOK_REPLY_PRE_SEND,
    HOOK_REPLY_SENT,
)


@dataclass
class MessageReceivedEvent:
    channel: str
    source: str
    persona_id: str
    text: str
    images: list[dict] = field(default_factory=list)
    files: list[dict] = field(default_factory=list)
    account_id: str = ""
    user_id: str = ""
    context_token: str = ""
    reply_ctx: dict | None = None
    raw_message: Any = None
    cancelled: bool = False
    voices: list[dict] = field(default_factory=list)

    def cancel(self) -> None:
        self.cancelled = True


@dataclass
class MessageStoredEvent:
    channel: str
    source: str
    persona_id: str
    message: dict
    account_id: str = ""
    user_id: str = ""
    context_token: str = ""
    reply_ctx: dict | None = None
    raw_message: Any = None


@dataclass
class ContextBuildEvent:
    persona_id: str
    persona: Any
    messages: list[dict]
    images: list[dict] = field(default_factory=list)


@dataclass
class ReplyComposeEvent:
    channel: str
    persona_id: str
    messages: list[dict]
    account_id: str = ""
    user_id: str = ""
    reply_ctx: dict | None = None


@dataclass
class ReplyPreSendEvent:
    channel: str
    persona_id: str
    message: dict
    is_last: bool = False
    account_id: str = ""
    user_id: str = ""
    reply_ctx: dict | None = None
    cancelled: bool = False

    def cancel(self) -> None:
        self.cancelled = True


@dataclass
class ReplySentEvent:
    channel: str
    persona_id: str
    message: dict
    delivered: bool
    is_last: bool = False
    account_id: str = ""
    user_id: str = ""
    reply_ctx: dict | None = None


class HookDispatcher:
    """Thread-safe hook registry and dispatcher."""

    def __init__(
        self,
        on_error: Callable[[str, str, BaseException], None] | None = None,
    ):
        self._handlers: dict[str, list[tuple[int, str, Callable]]] = {
            name: [] for name in HOOK_NAMES
        }
        self._lock = threading.Lock()
        self._on_error = on_error
        self._paused: set[str] = set()
        self._active: dict[str, int] = {}

    def pause_plugin(self, plugin_id: str) -> bool:
        """Block new calls, or reject without changes if a call is in flight."""
        with self._lock:
            if self._active.get(plugin_id, 0):
                return False
            self._paused.add(plugin_id)
            return True

    def resume_plugin(self, plugin_id: str) -> None:
        with self._lock:
            self._paused.discard(plugin_id)

    def register(
        self,
        plugin_id: str,
        hook_name: str,
        handler: Callable,
        priority: int = 100,
    ) -> None:
        if hook_name not in self._handlers:
            raise ValueError(f"Unknown hook: {hook_name}")
        with self._lock:
            bucket = self._handlers[hook_name]
            bucket.append((priority, plugin_id, handler))
            bucket.sort(key=lambda item: item[0])

    def unregister_plugin(self, plugin_id: str) -> None:
        with self._lock:
            for hook_name, handlers in self._handlers.items():
                self._handlers[hook_name] = [
                    item for item in handlers if item[1] != plugin_id
                ]

    def dispatch(self, hook_name: str, event: Any) -> None:
        with self._lock:
            handlers = list(self._handlers.get(hook_name, ()))

        for _priority, plugin_id, handler in handlers:
            with self._lock:
                # A dispatch snapshot may predate unregister/reload. Never
                # invoke a handler removed while an earlier handler ran.
                entry = (_priority, plugin_id, handler)
                if plugin_id in self._paused or entry not in self._handlers.get(hook_name, ()):
                    continue
                self._active[plugin_id] = self._active.get(plugin_id, 0) + 1
            try:
                handler(event)
            except Exception as exc:
                logger.exception(
                    "Plugin hook failed: plugin=%s hook=%s",
                    plugin_id,
                    hook_name,
                )
                if self._on_error:
                    self._on_error(plugin_id, hook_name, exc)
            finally:
                with self._lock:
                    remaining = self._active[plugin_id] - 1
                    if remaining:
                        self._active[plugin_id] = remaining
                    else:
                        self._active.pop(plugin_id, None)

    def dispatch_message_received(self, event: MessageReceivedEvent) -> None:
        self.dispatch(HOOK_MESSAGE_RECEIVED, event)

    def dispatch_message_stored(self, event: MessageStoredEvent) -> None:
        self.dispatch(HOOK_MESSAGE_STORED, event)

    def dispatch_context_build(self, event: ContextBuildEvent) -> None:
        self.dispatch(HOOK_CONTEXT_BUILD, event)

    def dispatch_reply_compose(self, event: ReplyComposeEvent) -> None:
        self.dispatch(HOOK_REPLY_COMPOSE, event)

    def dispatch_reply_pre_send(self, event: ReplyPreSendEvent) -> None:
        self.dispatch(HOOK_REPLY_PRE_SEND, event)

    def dispatch_reply_sent(self, event: ReplySentEvent) -> None:
        self.dispatch(HOOK_REPLY_SENT, event)


class HookRegistrar:
    """Plugin-facing registration helper."""

    def __init__(self, plugin_id: str, dispatcher: HookDispatcher):
        self._plugin_id = plugin_id
        self._dispatcher = dispatcher

    def on_message_received(self, handler: Callable, priority: int = 100) -> None:
        self._dispatcher.register(
            self._plugin_id, HOOK_MESSAGE_RECEIVED, handler, priority,
        )

    def on_message_stored(self, handler: Callable, priority: int = 100) -> None:
        self._dispatcher.register(
            self._plugin_id, HOOK_MESSAGE_STORED, handler, priority,
        )

    def on_context_build(self, handler: Callable, priority: int = 100) -> None:
        self._dispatcher.register(
            self._plugin_id, HOOK_CONTEXT_BUILD, handler, priority,
        )

    def on_reply_compose(self, handler: Callable, priority: int = 100) -> None:
        self._dispatcher.register(
            self._plugin_id, HOOK_REPLY_COMPOSE, handler, priority,
        )

    def on_reply_pre_send(self, handler: Callable, priority: int = 100) -> None:
        self._dispatcher.register(
            self._plugin_id, HOOK_REPLY_PRE_SEND, handler, priority,
        )

    def on_reply_sent(self, handler: Callable, priority: int = 100) -> None:
        self._dispatcher.register(
            self._plugin_id, HOOK_REPLY_SENT, handler, priority,
        )
