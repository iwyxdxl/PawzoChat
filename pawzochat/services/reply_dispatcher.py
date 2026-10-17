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

"""Final reply persistence, broadcasting, hook dispatch, and channel delivery."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from pawzochat.core.extensions.hooks import ReplyPreSendEvent, ReplySentEvent
from pawzochat.utils.message_text import clean_assistant_reply_text
from pawzochat.web.sse import broadcast

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)


class ReplyDispatcher:
    """Dispatch assistant message drafts to storage, UI, and external channels."""

    def __init__(self, app: App):
        self._app = app

    def deliver_messages(
        self,
        persona_id: str,
        messages: list[dict],
        reply_ctx: dict | None = None,
    ) -> list[dict]:
        delivered_messages: list[dict] = []
        channel = (reply_ctx or {}).get("channel", "web")
        account_id = (reply_ctx or {}).get("account_id", "")
        user_id = (reply_ctx or {}).get("user_id", "")
        is_first = True
        # Keep the invocation history before the first stored reply, even if
        # emoji composition prepends a bubble or a pre-send hook cancels one.
        tool_history = [item for draft in messages for item in draft.get("tool_history", [])]

        for index, draft in enumerate(messages):
            is_last = index == len(messages) - 1
            message = self._normalize_message(draft)

            pre_send = ReplyPreSendEvent(
                channel=channel,
                persona_id=persona_id,
                message=message,
                is_last=is_last,
                account_id=account_id,
                user_id=user_id,
                reply_ctx=reply_ctx,
            )
            self._app.extension_manager.dispatch_reply_pre_send(pre_send)
            if pre_send.cancelled:
                continue

            message = self._normalize_message(pre_send.message)
            history_args = ({"tool_history": tool_history}
                            if tool_history and message.get("role") == "assistant" else {})
            stored = self._app.conversation_store.add_message(
                persona_id,
                message.get("role", "assistant"),
                message.get("content", []),
                message.get("source", "llm"),
                **history_args,
            )
            if message.get("role") == "assistant":
                tool_history = []

            channel_impl = self._app.channel_registry.get(channel, default=None)
            if channel_impl is None:
                # A named-but-unregistered external channel (e.g. a plugin
                # channel disabled/reloaded between intake and delivery). Don't
                # silently fall back to web (which would report phantom success);
                # persist + broadcast below, but record a non-delivery so
                # ProactiveService increments fail_streak / applies cooldown.
                logger.warning(
                    "通道 %s 未注册，消息仅本地保存未投递 persona=%s",
                    channel, persona_id,
                )
                delivered = False
            else:
                delivered = channel_impl.deliver_message(
                    persona_id,
                    stored,
                    pre_send.reply_ctx,
                    is_first=is_first,
                    is_last=is_last,
                )

            broadcast(
                "assistant_message",
                persona_id=persona_id,
                message=stored,
                is_last=is_last,
            )
            is_first = False
            # Only count as delivered when the channel actually accepted
            # it — lets callers (e.g. ProactiveService) detect wechat send
            # failures even though the message was persisted.
            if delivered:
                delivered_messages.append(stored)

            self._app.extension_manager.dispatch_reply_sent(
                ReplySentEvent(
                    channel=channel,
                    persona_id=persona_id,
                    message=stored,
                    delivered=delivered,
                    is_last=is_last,
                    account_id=account_id,
                    user_id=user_id,
                    reply_ctx=pre_send.reply_ctx,
                ),
            )

        broadcast("conversation_updated", persona_id=persona_id)
        return delivered_messages

    @staticmethod
    def _normalize_message(message: dict) -> dict:
        content = list(message.get("content", []) or [])
        for block in content:
            if block.get("type") == "text" and block.get("text"):
                block["text"] = clean_assistant_reply_text(block["text"])
        return {
            "role": message.get("role", "assistant"),
            "content": content,
            "source": message.get("source", "llm"),
        }
