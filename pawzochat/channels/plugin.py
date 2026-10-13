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

"""Adapter exposing a plugin-provided channel as a first-class Channel.

A plugin owns its own message receive loop (a thread) and a send handler; this
adapter wires those into the core registry so the reply dispatcher and the
add-account UI treat the plugin channel like any built-in one. The plugin pushes
inbound messages via ``ctx.channels.submit_inbound(...)``.
"""

from __future__ import annotations

import logging
import secrets
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from functools import wraps
from typing import TYPE_CHECKING

from pawzochat.channels.base import Channel
from pawzochat.transport.models import Account

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)


def _plugin_callback(*, rejected=None, raise_on_pause=False):
    def decorate(method):
        @wraps(method)
        def guarded(self, *args, **kwargs):
            with self._callback_lock:
                if self._paused:
                    if raise_on_pause:
                        raise RuntimeError("Plugin channel is stopping; retry later")
                    return rejected
                self._active_callbacks += 1
            try:
                return method(self, *args, **kwargs)
            finally:
                with self._callback_lock:
                    self._active_callbacks -= 1
        return guarded
    return decorate


class PluginChannel(Channel):
    def __init__(
        self,
        app: App,
        *,
        channel_type: str,
        display_name: str,
        on_outbound: Callable[[str, dict, dict], bool | None],
        account_fields: list | None = None,
        id_field: str = "",
        on_start_account: Callable[[Account], None] | None = None,
        on_stop_account: Callable[[str], None] | None = None,
        on_validate: Callable[[dict], None] | None = None,
        hint: str = "",
    ):
        super().__init__(app)
        self.channel_type = channel_type
        self.display_name = display_name or channel_type
        self._account_fields = account_fields or []
        self._id_field = id_field
        self._hint = hint
        self._on_outbound = on_outbound
        self._on_start_account = on_start_account
        self._on_stop_account = on_stop_account
        self._on_validate = on_validate
        self._started: set[str] = set()
        self._callback_lock = threading.RLock()
        self._active_callbacks = 0
        manager = getattr(app, "extension_manager", None)
        self._paused = bool(getattr(manager, "_transaction_depth", 0))

    def pause_callbacks(self) -> bool:
        with self._callback_lock:
            if self._active_callbacks:
                return False
            self._paused = True
            return True

    def resume_callbacks(self) -> bool:
        with self._callback_lock:
            was_paused = self._paused
            self._paused = False
            return was_paused

    # ---- Lifecycle ----

    @_plugin_callback()
    def start_account(self, account: Account) -> None:
        # Only mark the account online if the plugin's start callback succeeds,
        # so a failed start reports offline (is_online=False) and stays eligible
        # for retry_deferred_accounts on the next channel registration.
        if self._on_start_account:
            try:
                self._on_start_account(account)
            except Exception:
                logger.exception("插件通道 %s 启动账号失败", self.channel_type)
                self._started.discard(account.bot_id)
                return
        self._started.add(account.bot_id)

    @_plugin_callback()
    def stop_account(self, account_id: str) -> None:
        self._stop_account(account_id, strict=False)

    def _stop_account(self, account_id: str, *, strict: bool) -> None:
        if self._on_stop_account:
            try:
                self._on_stop_account(account_id)
            except Exception:
                logger.exception("插件通道 %s 停止账号失败", self.channel_type)
                if strict:
                    raise
        self._started.discard(account_id)

    def shutdown(self, *, strict: bool = False) -> None:
        if not self.pause_callbacks():
            raise RuntimeError("Plugin channel has active callbacks; retry later")
        errors = []
        for account_id in list(self._started):
            try:
                # Lifecycle callbacks run after the external callback gate
                # closes, and must remain available until plugin teardown ends.
                self._stop_account(account_id, strict=strict)
            except Exception as exc:
                errors.append(exc)
        if errors:
            raise RuntimeError(f"Failed to stop plugin channel: {errors[0]}") from errors[0]

    def is_online(self, account_id: str) -> bool:
        return account_id in self._started

    # ---- Outbound ----

    @_plugin_callback(rejected=False)
    def deliver_message(
        self,
        persona_id: str,
        message: dict,
        reply_ctx: dict | None = None,
        *,
        is_first: bool = False,
        is_last: bool = False,
    ) -> bool:
        try:
            result = self._on_outbound(persona_id, message, reply_ctx or {})
        except Exception:
            logger.exception("插件通道 %s 投递失败", self.channel_type)
            return False
        return True if result is None else bool(result)

    # ---- Account creation metadata ----

    def account_form(self) -> dict:
        if not self._account_fields:
            return {"method": "none", "fields": []}
        form = {"method": "form", "fields": self._account_fields}
        if self._hint:
            form["hint"] = self._hint
        return form

    @_plugin_callback(raise_on_pause=True)
    def validate_and_create(self, fields: dict) -> Account:
        if self._on_validate:
            # Plugins raise ValueError with a user-facing message on bad input.
            self._on_validate(fields)
        if self._id_field and fields.get(self._id_field):
            bot_id = str(fields[self._id_field]).strip()
        else:
            bot_id = f"{self.channel_type}:{secrets.token_hex(4)}"
        return Account(
            bot_id=bot_id,
            channel_type=self.channel_type,
            created_at=datetime.now(timezone.utc).isoformat(),
            note=str(fields.get("note", "")).strip(),
            extra=dict(fields),
        )

    # ---- Push policy ----

    def can_push_now(
        self,
        channel_link: dict,
        last_user_at: float,
        messages: list[dict],
    ) -> bool:
        # Plugin channels permit proactive sends by default; a plugin that
        # can't should simply no-op (or return False) in its on_outbound.
        return True
