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

"""Helpers for inbound text formatting and outbound reply cleaning."""

from __future__ import annotations

import re
from datetime import datetime, timezone

from pawzochat.transport.models import (
    Message,
    MessageItem,
    MessageItemType,
)
from pawzochat.utils.text_splitter import strip_voice_markers

_WEEKDAYS = ("一", "二", "三", "四", "五", "六", "日")

_THINK_RE = re.compile(r"^.*</(?:think|thought)>\s*", flags=re.DOTALL)

_TIME_PREFIX_RE = re.compile(
    r"\["
    r"(?:"
    r"\d{4}年\d{1,2}月\d{1,2}日\s+星期[一二三四五六日]\s+\d{1,2}:\d{2}"
    r"|"
    r"\d{4}-\d{1,2}-\d{1,2}(?:\s+\w+)?\s+\d{1,2}:\d{2}"
    r")"
    r"(?::\d{2})?"
    r"\]\s*",
)

_MULTI_NEWLINE_RE = re.compile(r"\n{3,}")

# These are group-context metadata, not ordinary bracketed message content.
_GROUP_SPEAKER_LABEL_RE = re.compile(
    r"[\[【]群成员[：:][^\[\]【】\r\n]*?[；;][ \t]*"
    r"角色[ \t]*ID[：:][ \t]*[A-Za-z0-9_-]+[ \t]*[\]】]"
    r"[ \t]*(?:[：:][ \t]*)?"
)


def format_message_time(timestamp: str | None = None) -> str:
    """Return a Chinese time expression like ``[2026年04月02日 星期四 13:45]``.

    *timestamp* should be an ISO-format string (as stored by
    ``ConversationStore``).  Falls back to the current local time when
    *timestamp* is ``None`` or cannot be parsed.
    """
    dt: datetime | None = None
    if timestamp:
        try:
            dt = datetime.fromisoformat(timestamp)
        except (ValueError, TypeError):
            pass
    if dt is None:
        dt = datetime.now(timezone.utc).astimezone()

    weekday = _WEEKDAYS[dt.weekday()]
    return (
        f"[{dt.year}年{dt.month:02d}月{dt.day:02d}日"
        f" 星期{weekday}"
        f" {dt.hour:02d}:{dt.minute:02d}]"
    )


_REF_MEDIA_PLACEHOLDERS = {
    MessageItemType.IMAGE: "[图片]",
    MessageItemType.FILE: "[文件]",
    MessageItemType.VOICE: "[语音]",
    MessageItemType.VIDEO: "[视频]",
}


def _media_placeholder(item: MessageItem) -> str:
    """Chinese placeholder for a quoted non-text item (image/file/voice/video)."""
    return _REF_MEDIA_PLACEHOLDERS.get(item.type, "")


def _ref_item_body(item: MessageItem) -> str:
    """Best-effort text for a quoted message item: its text, or a media placeholder.

    Unlike upstream (which forwards quoted media as a separate MediaPath),
    PawzoChat does not download quoted media, so a placeholder keeps the LLM
    aware that the user quoted an image/file/voice/video.
    """
    if item.type == MessageItemType.TEXT and item.text:
        return item.text
    if item.type == MessageItemType.VOICE and item.voice and item.voice.text:
        return item.voice.text
    return _media_placeholder(item)


def extract_wechat_quote(message: Message) -> str:
    """Return the quoted message's original text for *message*, or '' when none.

    The quoted *content* only is returned (no sender attribution): the quoted
    item's text, or a media placeholder for non-text quotes.  The per-item
    ``ref_msg.title`` (the quoted sender's display title) is used only as a
    last-resort fallback when the quoted item carries no extractable body.

    Stored separately in a message's ``quote`` field so the chat UI can render
    a WeChat-style quote bubble instead of an inline ``[引用: …]`` prefix.
    """
    for item in message.items:
        ref = item.ref_msg
        if not ref:
            continue
        if ref.message_item:
            body = _ref_item_body(ref.message_item)
            if body:
                return body
        return ref.title
    return ""


def inject_quote_prefix(text: str, quote: str) -> str:
    """Prepend a ``[引用: …]\\n`` block to *text* for LLM context, or return as-is.

    Re-creates the inline quote marker the LLM used to see when the quote was
    embedded in the message text, now that it lives in a separate ``quote``
    field.  Keeps LLM input stable across the storage-structure change.
    """
    if quote:
        return f"[引用: {quote}]\n{text}"
    return text


def build_wechat_inbound_text(message: Message) -> str:
    """Build normalised user text from a WeChat *message*.

    Only TEXT items are included. Media, including voice and its transcript,
    travels through the structured content-block pipeline. A quoted message is
    captured separately via :func:`extract_wechat_quote`, not embedded here.
    """
    parts = [
        item.text
        for item in message.items
        if item.type == MessageItemType.TEXT and item.text
    ]
    text = "\n".join(parts)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _MULTI_NEWLINE_RE.sub("\n\n", text)
    return text.strip()


def clean_assistant_reply_text(text: str) -> str:
    """Clean an LLM reply for display / sending.

    The function is **idempotent** — calling it twice on the same input
    always produces the same output, so it is safe to use both as the
    primary cleaner and as a send-time safety net.
    """
    if not text:
        return ""

    text = _THINK_RE.sub("", text)

    text = text.replace("\r\n", "\n").replace("\r", "\n")

    text = text.replace("\\n", "\n")

    text = _TIME_PREFIX_RE.sub("", text)

    text = _MULTI_NEWLINE_RE.sub("\n\n", text)

    return text.strip()


def strip_group_speaker_labels(text: str) -> str:
    """Remove copied group metadata at the start of a reply/bubble/voice run.

    Keep literal labels inside prose, quotations and ordinary bracketed text.
    A voice marker may precede a leaked label; preserve that marker so the
    regular voice pipeline still receives it. Call only for group assistants,
    never for user content or private conversations.
    """
    if not text:
        return ""
    parts = re.split(r"([\r\n\\$])", text)
    for index in range(0, len(parts), 2):
        segment = parts[index]
        kept: list[str] = []
        start = 0
        at_boundary = True
        for match in _GROUP_SPEAKER_LABEL_RE.finditer(segment):
            prefix = segment[start:match.start()]
            if not at_boundary or strip_voice_markers(prefix).strip():
                # A voice run can start after prose on the same line. Keep
                # the marker while removing its copied speaker prefix, even
                # when this round will subsequently ignore voice markers.
                marker_start = max(prefix.rfind("["), prefix.rfind("【"))
                if marker_start < 0 or strip_voice_markers(prefix[marker_start:]).strip():
                    kept.append(segment[start:match.end()])
                    start = match.end()
                    at_boundary = False
                    continue
            kept.append(prefix)
            start = match.end()
            at_boundary = True
        if start:
            parts[index] = "".join(kept) + segment[start:]
    return "".join(parts).strip()
