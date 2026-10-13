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

"""Prepared message delivery with typing simulation."""

from __future__ import annotations

import logging
import random
import time
import threading

from pawzochat.transport.client import ILinkClient
from pawzochat.transport.models import TypingStatus
from pawzochat.transport.lifecycle import ConnectionInactive

logger = logging.getLogger(__name__)


class MessageSender:
    """High-level message sending with optional typing simulation."""

    def __init__(self, client: ILinkClient, reply_config: dict | None = None):
        self.client = client
        self._reply_config = dict(reply_config or {})
        self._typing_tickets: dict[str, dict] = {}
        self._typing_lock = threading.Lock()

    @staticmethod
    def _record_receipt(callback, response):
        if callback:
            try:
                callback(response)
            except Exception:
                logger.warning("发送成功，但引用回执记录失败", exc_info=True)

    def send_text(self, to_user_id: str, text: str, context_token: str, *, on_sent=None) -> bool:
        """Send a simple text message (no typing simulation)."""
        msg = ILinkClient.build_text_message(to_user_id, text, context_token)
        try:
            response = self.client.send_message(msg)
            self._record_receipt(on_sent, response)
            return True
        except Exception:
            logger.exception("发送文本消息失败: to=%s", to_user_id)
            return False

    def send_image(self, to_user_id: str, image_path: str, context_token: str, *, on_sent=None) -> bool:
        """Upload an image to CDN and send it as a WeChat image message."""
        from pawzochat.transport.cdn import upload_image

        try:
            cdn_info = upload_image(self.client, image_path, to_user_id)
            msg = ILinkClient.build_image_message(to_user_id, cdn_info, context_token)
            response = self.client.send_message(msg)
            self._record_receipt(on_sent, response)
            return True
        except ConnectionInactive:
            return False
        except Exception as exc:
            logger.warning("图片发送失败（不自动重发）: %s", type(exc).__name__)
            return False

    def send_file(
        self, to_user_id: str, file_path: str, context_token: str,
        file_name: str = "", *, on_sent=None,
    ) -> bool:
        """Upload once (CDN owns retries), then submit the message once."""
        from pawzochat.transport.cdn import upload_file

        try:
            cdn_info = upload_file(self.client, file_path, to_user_id, file_name=file_name)
            msg = ILinkClient.build_file_message(
                to_user_id, cdn_info, context_token, file_name=file_name,
            )
            response = self.client.send_message(msg)
            self._record_receipt(on_sent, response)
            return True
        except ConnectionInactive:
            return False
        except Exception as exc:
            logger.warning("文件发送失败（不自动重发）: %s", type(exc).__name__)
            return False

    def send_one_reply(
        self,
        to_user_id: str,
        text: str,
        context_token: str,
        ilink_user_id: str = "",
        *,
        is_first: bool = False,
        reply_config: dict | None = None,
        on_sent=None,
    ) -> bool:
        """Send one prepared text reply with typing simulation and no re-splitting."""
        if not text.strip():
            return False

        # Snapshot this send; an explicit empty config uses the global defaults.
        cfg = dict(self._reply_config if reply_config is None else reply_config)
        show_typing = cfg.get("show_typing_indicator", True)

        if show_typing and ilink_user_id:
            self._send_typing(ilink_user_id, context_token, TypingStatus.TYPING)

        if cfg.get("typing_delay_enabled", True) and not is_first:
            time.sleep(self.estimate_delay_from_config(text, cfg))

        ok = self.send_text(to_user_id, text, context_token, on_sent=on_sent)

        if show_typing and ilink_user_id:
            self._send_typing(ilink_user_id, context_token, TypingStatus.CANCEL)

        return ok

    @staticmethod
    def estimate_message_delay(message: dict, reply_config: dict | None = None) -> float:
        """Shared pacing for web and QQ message bubbles, including media."""
        cfg = reply_config or {}
        if not cfg.get("typing_delay_enabled", True):
            return 0.0
        content = message.get("content", []) or []
        if any(block.get("type") in {"emoji", "image", "file", "voice"} for block in content):
            return 0.6
        text = "".join(block.get("text", "") for block in content if block.get("type") == "text")
        return MessageSender.estimate_delay_from_config(text, cfg) if text.strip() else 0.0

    @staticmethod
    def estimate_delay_from_config(text: str, reply_config: dict | None = None) -> float:
        cfg = reply_config or {}
        typing_speed = float(cfg.get("typing_speed", 0.2))
        speed_min = float(cfg.get("typing_speed_random_min", 0.05))
        speed_max = float(cfg.get("typing_speed_random_max", 0.1))
        base = len(text) * typing_speed
        jitter = random.uniform(speed_min, speed_max)
        delay = base + jitter * len(text)
        return min(max(delay, 0.5), 8.0)

    def _send_typing(self, ilink_user_id: str, context_token: str, status: int):
        try:
            ticket = self._get_typing_ticket(ilink_user_id, context_token)
            if ticket:
                self.client.send_typing(ilink_user_id, ticket, status)
        except Exception:
            logger.debug("发送 typing 状态失败", exc_info=True)

    def _get_typing_ticket(self, ilink_user_id: str, context_token: str) -> str:
        # One sender belongs to one connection/account; restarts replace it.
        # Serialize refreshes so concurrent sends cannot fetch the same ticket twice.
        with self._typing_lock:
            now = time.monotonic()
            entry = self._typing_tickets.get(ilink_user_id)
            if entry and now < entry["next_fetch_at"]:
                return entry["ticket"]
            try:
                resp = self.client.get_config(ilink_user_id, context_token)
                if resp.get("ret") in (0, "0"):
                    ticket = resp.get("typing_ticket") or ""
                    if not isinstance(ticket, str):
                        raise ValueError("invalid typing ticket")
                    self._typing_tickets[ilink_user_id] = {
                        "ticket": ticket, "next_fetch_at": now + random.random() * 86400,
                        "retry_delay": 2,
                    }
                    return ticket
            except Exception as exc:
                logger.debug("获取 typing_ticket 失败: %s", type(exc).__name__)
            delay = min(entry["retry_delay"] * 2, 3600) if entry else 2
            self._typing_tickets[ilink_user_id] = {
                "ticket": entry["ticket"] if entry else "",
                "next_fetch_at": now + delay, "retry_delay": delay,
            }
            return self._typing_tickets[ilink_user_id]["ticket"]
