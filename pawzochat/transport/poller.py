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

"""Long-polling message receiver — one Poller thread per Account."""

from __future__ import annotations

import asyncio
import httpx
import time
import math
import logging
import threading
from typing import TYPE_CHECKING, Callable
from contextlib import nullcontext
from pawzochat.transport.lifecycle import ConnectionInactive

from pawzochat.transport.client import ILinkClient
from pawzochat.transport.models import Account, parse_message

if TYPE_CHECKING:
    from pawzochat.transport.auth import AuthManager

logger = logging.getLogger(__name__)

class ILinkAPIError(RuntimeError):
    """Raised when getUpdates returns an API-level failure in an HTTP 200."""


class MessagePoller:
    """Runs a long-poll loop in a daemon thread for one Account."""

    def __init__(
        self,
        account: Account,
        client: ILinkClient,
        auth_manager: AuthManager,
        on_message: Callable[[str, object], None],
        poll_timeout: float = 35,
    ):
        self.account = account
        self.client = client
        self.auth_manager = auth_manager
        self.on_message = on_message
        self.poll_timeout = poll_timeout
        self._running = False
        self._loop = None
        self._task = None
        self._thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._poll_loop,
            name=f"poller-{self.account.bot_id[:8]}",
            daemon=True,
        )
        self._thread.start()
        logger.info("轮询线程已启动: %s", self.account.bot_id)

    def stop(self) -> None:
        self._running = False
        loop, task = self._loop, self._task
        if loop and task:
            try:
                loop.call_soon_threadsafe(task.cancel)
            except RuntimeError:
                pass
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=2)
        if not thread or not thread.is_alive():
            self._thread = None

    def _poll_loop(self) -> None:
        try:
            asyncio.run(self._poll_async())
        except asyncio.CancelledError:
            pass
        finally:
            self._running = False
            self._loop = self._task = None

    async def _poll_async(self):
        self._loop = asyncio.get_running_loop()
        self._task = asyncio.current_task()
        errors = 0
        async with httpx.AsyncClient() as http:
            while self._running:
                connection = self.client.connection
                if connection and connection.cooldown_until > time.time():
                    await asyncio.sleep(min(connection.cooldown_until - time.time(), 3600))
                    continue
                try:
                    response = await self.client.get_updates_async(
                        http, buf=self.account.get_updates_buf, timeout=self.poll_timeout,
                    )
                    if not self._running:
                        break
                    self._handle_response(response)
                    errors = 0
                except ConnectionInactive:
                    if not connection or not connection.active:
                        break
                    errors = 0
                except Exception:
                    if not self._running:
                        break
                    errors += 1
                    wait = 30 if errors >= 3 else 2
                    if errors >= 3:
                        errors = 0
                    logger.exception("轮询出错，%d 秒后重试", wait)
                    await asyncio.sleep(wait)

    def _handle_response(self, response: dict) -> None:
        if not self._running:
            return
        errcode = response.get("errcode")
        ret = response.get("ret")
        code = next(
            (value for value in (errcode, ret) if value not in (None, 0, "0")),
            None,
        )
        if code is not None:
            errmsg = response.get("errmsg", "")
            logger.warning(
                "getUpdates API 失败 ret=%s errcode=%s: %s",
                ret,
                errcode,
                errmsg,
            )
            if any(str(value) == "-14" for value in (ret, errcode)):
                logger.error(
                    "微信 bot_token 暂时失效 (code=-14)，暂停 60 分钟后自动重试"
                )
                if self.client.connection:
                    self.client.connection.stale()
                return
            raise ILinkAPIError(
                f"getUpdates ret={ret} errcode={errcode} errmsg={errmsg}"
            )

        connection = self.client.connection
        with connection.lock if connection else nullcontext():
            if not self._running or (connection and not connection.active):
                return
            new_buf = response.get("get_updates_buf", "")
            if new_buf:
                self.account.get_updates_buf = new_buf
                self.auth_manager.update_account(self.account)

        timeout_hint = response.get("longpolling_timeout_ms")
        if (isinstance(timeout_hint, (int, float)) and not isinstance(timeout_hint, bool)
                and math.isfinite(timeout_hint) and timeout_hint > 0):
            self.poll_timeout = timeout_hint / 1000

        for raw_msg in response.get("msgs", []):
            if not self._running or (connection and not connection.active):
                return
            try:
                message = parse_message(raw_msg)
                if not message.from_user_id:
                    continue

                logger.info(
                    "[%s] 收到消息 from=%s text=%s",
                    self.account.bot_id[:8],
                    message.from_user_id[:12],
                    message.text_content[:50] if message.text_content else "(非文本)",
                )
                self.on_message(self.account.bot_id, message)
            except Exception:
                logger.exception("解析消息失败: %s", raw_msg)
