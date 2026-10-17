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

"""Built-in capability tool: ``view_reference_image``.

Lets the chat LLM peek at the persona's own character-reference image
mid-conversation. Resolves the configured avatar / custom ref via
:func:`pawzochat.image.reference.resolve_reference_images` and registers it
into ``context["pending_images"]`` keyed by ``img_<hex>``, then returns a
``[图片 ID:xxx]`` text hint — exactly the same convention
:meth:`pawzochat.services.chat.ChatService._image_parts` uses for incoming
user images. The LLM follows up with a call to the existing
``recognize_image`` capability adapter (configured under
``capability_adapters`` in ``config.yaml``, backed by
``data/mcp_servers/image_recognition_pawapi/``) which uses
``$image_data(image_id)`` injection to read the bytes back out of
``pending_images``.

Why not return ``ContentBlock(type="image")`` directly:

* OpenAI's tool-result converter (:func:`llm.converter._tool_content_to_str`)
  flattens image blocks to ``"[image data]"`` — the LLM never sees them.
* Gemini's function-response converter
  (:meth:`llm.providers.gemini_provider.GeminiProvider._build_contents`)
  drops non-text blocks the same way.
* For Anthropic the image *would* pass through, but
  :func:`services.mcp_image_extractor.extract_mcp_images` would then persist
  it to disk and emit it back to the user as a new assistant image message —
  the user does not want to see their own reference image bounced back.

The unified pending-images path sidesteps all three issues at the cost of
requiring ``recognize_image`` (or another image-recognition capability) to be
enabled in the user's config — which is the existing convention for any
non-vision delivery in this codebase.

The tool is filtered out of the LLM's tool list when image generation is
disabled or the persona has no usable reference image; see
:meth:`ChatService._filter_view_reference_image`.
"""

from __future__ import annotations

import base64
import logging
import secrets
from collections.abc import Callable
from typing import TYPE_CHECKING

from pawzochat.image.reference import resolve_reference_images
from pawzochat.llm.base import ContentBlock
from pawzochat.transport.models import normalize_image_generation

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)


TOOL_NAME = "view_reference_image"

TOOL_DESCRIPTION = (
    "获取当前角色的头像或自定义形象参考图，用于确认外观、补充生图细节或回答外观相关的问题。"
    "工具返回图片 ID（形如 [图片 ID:img_xxx]），将该 ID 传给 recognize_image 的 image_id "
    "参数即可读取图片内容。同一轮对话中可复用已读取的结果。"
)

TOOL_PARAMETERS: dict = {}


def _err(msg: str) -> list[ContentBlock]:
    return [ContentBlock(type="text", text=msg)]


def make_handler(app: App) -> Callable[[dict, dict], list[ContentBlock]]:
    """Build a closure handler bound to the running ``App``.

    Signature matches ``LocalToolHandler``:
    ``(arguments, context) -> list[ContentBlock]``.
    """

    def handler(arguments: dict, context: dict) -> list[ContentBlock]:
        persona = context.get("persona")
        persona_id = context.get("persona_id") or ""
        if persona is None or not persona_id:
            return _err("查看参考图工具上下文缺失：未提供 persona。")

        image_cfg = normalize_image_generation(
            getattr(persona, "image_generation", None),
        )
        if not image_cfg["enabled"]:
            return _err("当前角色未启用图片生成，参考图查看不可用。")
        if (
            app.capability_registry is None
            or not app.capability_registry.is_capability_tool("recognize_image")
        ):
            return _err("未启用 recognize_image 适配器，无法读取参考图内容。")

        refs = resolve_reference_images(persona_id, image_cfg)
        if not refs:
            # Normally hidden by ChatService._filter_view_reference_image; this
            # guards against state drift mid-round (file deleted, mode flipped).
            return _err("当前角色未配置可用的形象参考图。")

        # Persona model currently stores at most one reference (avatar or
        # custom ref.png). If multi-ref support is added later, expose a
        # parameter — for now hand back exactly one to keep call costs sane.
        data, mime = refs[0]
        b64 = base64.b64encode(data).decode("ascii")

        pending_images = context.get("pending_images")
        if not isinstance(pending_images, dict):
            return _err(
                "无法把参考图注册进 pending_images 通道，"
                "可能未启用 recognize_image 适配器。",
            )

        img_id = f"img_{secrets.token_hex(4)}"
        pending_images[img_id] = {"data": b64, "mime": mime}
        logger.info(
            "view_reference_image: pending registered persona=%s img_id=%s",
            persona_id, img_id,
        )
        return [ContentBlock(
            type="text",
            text=(
                f"角色形象参考图 [图片 ID:{img_id}]。"
                f"请调用 recognize_image 工具并把 image_id 设为 `{img_id}` 读取内容。"
            ),
        )]

    return handler
