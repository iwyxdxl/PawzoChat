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

"""Data classes for iLink API objects and application domain models."""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Optional

# Re-export for existing config and transport callers.
from pawzochat.voice.settings import VOICE_GENERATION_DEFAULTS, normalize_voice_generation


# Single source of truth for proactive message defaults. Kept here (not in
# services/proactive.py) so it can be referenced from transport-level
# dataclasses and config loading without risking a circular import.
PROACTIVE_DEFAULTS: dict = {
    "enabled": False,
    "min_idle_hours": 1.0,
    "max_idle_hours": 3.0,
    "max_consecutive": 3,
    "prompt": (
        "用户已经一段时间没有回复了。请根据角色设定与近期对话，"
        "主动发起一条贴合角色的简短消息。"
    ),
    "quiet_hours": {
        "enabled": True,
        "start": "22:00",
        "end": "08:00",
    },
}


# Allowed values for ``image_generation.ref_mode``. Any value outside this set
# is normalized back to ``"avatar"`` on load.
REF_MODES: tuple[str, ...] = ("avatar", "custom", "none")

# Single source of truth for per-persona image-generation defaults. Mirrored by
# the Persona dataclass below and re-used by config deserialization, REST
# validation, card import/export, and the frontend default template.
IMAGE_GENERATION_DEFAULTS: dict = {
    "enabled": False,
    "provider": "",
    "model": "",
    "style_prefix": "",
    "art_style": "anime style, masterpiece, best quality",
    "negative_prompt": (
        "low quality, blurry, watermark, text, signature, "
        "lowres, bad anatomy, extra fingers, jpeg artifacts"
    ),
    "negative_enabled": True,
    "ref_mode": "avatar",
    "custom_ref_filename": "",
    "_style_param": "lxdxywi",
}


def normalize_image_generation(raw: Any) -> dict:
    """Coerce an ``image_generation`` payload into a complete, safe dict."""
    raw = raw if isinstance(raw, dict) else {}
    d = IMAGE_GENERATION_DEFAULTS
    ref_mode = raw.get("ref_mode", d["ref_mode"])
    if ref_mode not in REF_MODES:
        ref_mode = d["ref_mode"]
    return {
        "enabled": bool(raw.get("enabled", d["enabled"])),
        "provider": str(raw.get("provider", "") or ""),
        "model": str(raw.get("model", "") or ""),
        "style_prefix": str(raw.get("style_prefix", "") or ""),
        "art_style": str(
            raw["art_style"] if "art_style" in raw else d["art_style"],
        ),
        "negative_prompt": str(
            raw["negative_prompt"] if "negative_prompt" in raw
            else d["negative_prompt"],
        ),
        "negative_enabled": bool(raw.get("negative_enabled", d["negative_enabled"])),
        "ref_mode": ref_mode,
        "custom_ref_filename": str(raw.get("custom_ref_filename", "") or "").strip(),
    }


class MessageItemType:
    NONE = 0
    TEXT = 1
    IMAGE = 2
    VOICE = 3
    FILE = 4
    VIDEO = 5


class MessageType:
    NONE = 0
    USER = 1
    BOT = 2


class MessageState:
    NEW = 0
    GENERATING = 1
    FINISH = 2


class TypingStatus:
    TYPING = 1
    CANCEL = 2


class UploadMediaType:
    IMAGE = 1
    VIDEO = 2
    FILE = 3
    VOICE = 4


# ---------------------------------------------------------------------------
# iLink API data structures
# ---------------------------------------------------------------------------

@dataclass
class CDNMedia:
    encrypt_query_param: str = ""
    aes_key: str = ""
    encrypt_type: int = 0
    full_url: str = ""


@dataclass
class ImageData:
    media: Optional[CDNMedia] = None
    thumb_media: Optional[CDNMedia] = None
    aeskey: str = ""
    url: str = ""
    mid_size: int = 0
    thumb_size: int = 0
    thumb_height: int = 0
    thumb_width: int = 0
    hd_size: int = 0


@dataclass
class VoiceData:
    media: Optional[CDNMedia] = None
    encode_type: int = 0
    bits_per_sample: int = 0
    sample_rate: int = 0
    playtime: int = 0
    text: str = ""


@dataclass
class FileData:
    media: Optional[CDNMedia] = None
    file_name: str = ""
    md5: str = ""
    length: str = ""


@dataclass
class VideoData:
    media: Optional[CDNMedia] = None
    video_size: int = 0
    play_length: int = 0
    video_md5: str = ""
    thumb_media: Optional[CDNMedia] = None
    thumb_size: int = 0
    thumb_height: int = 0
    thumb_width: int = 0


@dataclass
class RefMessage:
    svr_id: str = ""
    partial_text: dict | None = None
    message_item: Optional[MessageItem] = None
    title: str = ""


@dataclass
class MessageItem:
    type: int = MessageItemType.NONE
    text: str = ""
    image: Optional[ImageData] = None
    voice: Optional[VoiceData] = None
    file: Optional[FileData] = None
    video: Optional[VideoData] = None
    ref_msg: Optional[RefMessage] = None
    create_time_ms: int = 0
    msg_id: str = ""


@dataclass
class Message:
    message_id: str = ""
    from_user_id: str = ""
    to_user_id: str = ""
    client_id: str = ""
    session_id: str = ""
    group_id: str = ""
    context_token: str = ""
    message_type: int = MessageType.NONE
    message_state: int = MessageState.FINISH
    items: list[MessageItem] = field(default_factory=list)
    create_time_ms: int = 0

    @property
    def text_content(self) -> str:
        """Extract concatenated text from TEXT and VOICE (transcribed) items."""
        parts = []
        for item in self.items:
            if item.type == MessageItemType.TEXT and item.text:
                parts.append(item.text)
            elif item.type == MessageItemType.VOICE and item.voice and item.voice.text:
                parts.append(item.voice.text)
        return "\n".join(parts)

    @property
    def has_image(self) -> bool:
        return any(i.type == MessageItemType.IMAGE for i in self.items)


# ---------------------------------------------------------------------------
# Application domain models
# ---------------------------------------------------------------------------

@dataclass
class Account:
    bot_id: str = ""
    bot_token: str = ""
    ilink_user_id: str = ""
    get_updates_buf: str = ""
    created_at: str = ""
    note: str = ""
    # Channel this account belongs to. Legacy accounts (and every existing
    # construction site) default to "wechat" so older accounts.json files and
    # the iLink QR flow keep working with no other edits. QQ uses "qq"; plugin
    # channels use "plugin:<id>".
    channel_type: str = "wechat"
    # Channel-specific credentials / settings that don't fit the WeChat-shaped
    # top-level fields (e.g. QQ app_id/app_secret/sandbox, plugin tokens).
    extra: dict = field(default_factory=dict)


@dataclass
class Persona:
    id: str = ""
    name: str = ""
    character_prompt: str = ""
    output_examples: str = ""
    system_instructions: str = ""
    llm_provider: str = ""
    llm_model: str = ""
    temperature: float = 1.0
    max_tokens: int = 2000
    emoji_enabled: bool = False
    emoji_send_probability: int = 25
    emoji_group: str = ""
    tool_policy: dict = field(default_factory=lambda: {
        "mode": "all",
        "list": [],
        "max_iterations": 10,
        "timeout_seconds": 30,
    })
    memory: dict = field(default_factory=lambda: {
        "enabled": True,
        "max_memories": 50,
        "include_in_prompt": True,
        "trigger_rounds": 10,
        "trigger_mode": "remind",
    })
    proactive: dict = field(default_factory=lambda: copy.deepcopy(PROACTIVE_DEFAULTS))
    image_generation: dict = field(default_factory=lambda: copy.deepcopy(IMAGE_GENERATION_DEFAULTS))
    voice_generation: dict = field(default_factory=lambda: copy.deepcopy(VOICE_GENERATION_DEFAULTS))
    bound_worldbooks: list[str] = field(default_factory=list)

    @property
    def prompt(self) -> str:
        parts = []
        if self.character_prompt:
            parts.append("[人设设定]\n" + self.character_prompt)
        if self.output_examples:
            parts.append("[输出示例]\n" + self.output_examples)
        if self.system_instructions:
            parts.append("[系统指令]\n" + self.system_instructions)
        return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# API response helpers
# ---------------------------------------------------------------------------

def parse_message(raw: dict) -> Message:
    """Parse a raw JSON message dict from getUpdates into a Message object."""
    msg = Message(
        message_id=str(raw.get("message_id", "") or ""),
        from_user_id=raw.get("from_user_id", ""),
        to_user_id=raw.get("to_user_id", ""),
        client_id=raw.get("client_id", ""),
        session_id=raw.get("session_id", ""),
        group_id=raw.get("group_id", ""),
        context_token=raw.get("context_token", ""),
        message_type=raw.get("message_type", 0),
        message_state=raw.get("message_state", 0),
        create_time_ms=raw.get("create_time_ms", 0),
    )
    for raw_item in raw.get("item_list", []):
        item = _parse_message_item(raw_item)
        msg.items.append(item)
    return msg


def _parse_message_item(raw: dict) -> MessageItem:
    item_type = raw.get("type", 0)
    item = MessageItem(
        type=item_type,
        create_time_ms=raw.get("create_time_ms", 0),
        msg_id=str(raw.get("msg_id", "") or ""),
    )
    if item_type == MessageItemType.TEXT:
        text_item = raw.get("text_item", {})
        item.text = text_item.get("text", "")
    elif item_type == MessageItemType.IMAGE:
        item.image = _parse_image_data(raw.get("image_item", {}))
    elif item_type == MessageItemType.VOICE:
        item.voice = _parse_voice_data(raw.get("voice_item", {}))
    elif item_type == MessageItemType.FILE:
        item.file = _parse_file_data(raw.get("file_item", {}))
    elif item_type == MessageItemType.VIDEO:
        item.video = _parse_video_data(raw.get("video_item", {}))

    raw_ref = raw.get("ref_msg")
    if raw_ref:
        item.ref_msg = RefMessage(
            title=raw_ref.get("title", ""),
            svr_id=str(raw_ref.get("svr_id", "") or ""),
            partial_text=raw_ref.get("partial_text") if isinstance(raw_ref.get("partial_text"), dict) else None,
        )
        if raw_ref.get("message_item"):
            item.ref_msg.message_item = _parse_message_item(raw_ref["message_item"])

    return item


def _parse_cdn_media(raw: dict) -> CDNMedia:
    return CDNMedia(
        encrypt_query_param=raw.get("encrypt_query_param", ""),
        aes_key=raw.get("aes_key", ""),
        encrypt_type=raw.get("encrypt_type", 0),
        full_url=raw.get("full_url", ""),
    )


def _parse_image_data(raw: dict) -> ImageData:
    data = ImageData(
        aeskey=raw.get("aeskey", ""),
        url=raw.get("url", ""),
        mid_size=raw.get("mid_size", 0),
        thumb_size=raw.get("thumb_size", 0),
        thumb_height=raw.get("thumb_height", 0),
        thumb_width=raw.get("thumb_width", 0),
        hd_size=raw.get("hd_size", 0),
    )
    if raw.get("media"):
        data.media = _parse_cdn_media(raw["media"])
    if raw.get("thumb_media"):
        data.thumb_media = _parse_cdn_media(raw["thumb_media"])
    return data


def _parse_voice_data(raw: dict) -> VoiceData:
    data = VoiceData(
        encode_type=raw.get("encode_type", 0),
        bits_per_sample=raw.get("bits_per_sample", 0),
        sample_rate=raw.get("sample_rate", 0),
        playtime=raw.get("playtime", 0),
        text=raw.get("text", ""),
    )
    if raw.get("media"):
        data.media = _parse_cdn_media(raw["media"])
    return data


def _parse_file_data(raw: dict) -> FileData:
    data = FileData(
        file_name=raw.get("file_name", ""),
        md5=raw.get("md5", ""),
        length=raw.get("len", ""),
    )
    if raw.get("media"):
        data.media = _parse_cdn_media(raw["media"])
    return data


def _parse_video_data(raw: dict) -> VideoData:
    data = VideoData(
        video_size=raw.get("video_size", 0),
        play_length=raw.get("play_length", 0),
        video_md5=raw.get("video_md5", ""),
        thumb_size=raw.get("thumb_size", 0),
        thumb_height=raw.get("thumb_height", 0),
        thumb_width=raw.get("thumb_width", 0),
    )
    if raw.get("media"):
        data.media = _parse_cdn_media(raw["media"])
    if raw.get("thumb_media"):
        data.thumb_media = _parse_cdn_media(raw["thumb_media"])
    return data
