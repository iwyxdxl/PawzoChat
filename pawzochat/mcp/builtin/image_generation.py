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

"""Built-in capability tool: ``generate_image``.

Lets the chat LLM produce a picture mid-conversation by calling
:class:`pawzochat.image.manager.ImageManager`. The provider/model and
optional style prefix are read from the current persona's configuration
(``persona.image_generation``).

Two outputs per invocation:
* a ``ContentBlock(type="image")`` returned to the LLM so multimodal models
  can describe their own image accurately on the next turn;
* a ``ContentBlock(type="text")`` fallback so providers that flatten tool
  results to text (OpenAI, Gemini) still see a confirmation message.

The generated image is also persisted to
``data/chats/<persona_id>/images/gen_*.png`` and registered into
``context["generated_images"]`` so :class:`ChatService` can emit it as a
separate assistant message after the tool-use loop.
"""

from __future__ import annotations

import base64
import logging
import secrets
from pathlib import Path
from collections.abc import Callable
from typing import TYPE_CHECKING

from pawzochat.image.reference import resolve_reference_images
from pawzochat.llm.base import ContentBlock
from pawzochat.paths import CHATS_DIR
from pawzochat.transport.models import normalize_image_generation

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)


TOOL_NAME = "generate_image"

TOOL_DESCRIPTION = (
    "生成一张图片并直接作为消息发给用户。"
    "适用场景：用户邀请你拍照（如『拍个照看看你现在在干嘛』）、想看你所在的场景、"
    "想看你描述的物品/食物/景色，或当前情节确实需要以图回应。"
    "用户已在角色配置中预设了画面风格和角色形象，会自动拼接到 prompt 之前——"
    "你的 prompt 参数只负责场景/动作/镜头部分。"
    "纯风景/物品/食物等不需要出现人物的画面，可传 `use_reference_image=false` "
    "跳过角色形象参考图，避免人物被强行带入。具体规则见 system 中的"
    "『图片生成工具使用规则』。"
)

TOOL_PARAMETERS: dict = {
    "prompt": {
        "type": "string",
        "description": (
            "图像 prompt 中**仅可变的场景部分**。只描述：当前场景与环境（地点、时间、"
            "天气、背景物件）、角色的动作/姿态/表情、镜头与光线（如 50mm lens, "
            "soft sunlight, shallow depth of field）。**不要重复**人物形象（发色/服饰）"
            "和画面风格关键词——它们由系统自动拼接，重复会污染最终 prompt。"
            "直接描述画面，不要写元指令（如『生成一张』）。"
        ),
    },
    "width": {
        "type": "integer",
        "description": "图片宽度（像素），默认 1024。具体可用尺寸见 system 中的『图片生成工具使用规则』。",
        "default": 1024,
    },
    "height": {
        "type": "integer",
        "description": "图片高度（像素），默认 1024。具体可用尺寸见 system 中的『图片生成工具使用规则』。",
        "default": 1024,
    },
    "use_reference_image": {
        "type": "boolean",
        "description": (
            "是否在本次生图中附加角色形象参考图，默认 true。"
            "人物特写或需要保持角色外观一致时省略或传 true；"
            "纯风景、物品、食物、抽象画面等不需要出现人物时传 false，"
            "避免角色被强行带入画面。"
            "若用户在角色配置里关闭了参考图（ref_mode=none），本参数无效。"
        ),
        "default": True,
    },
}


def _join_prompt_parts(*parts: str) -> str:
    """Join non-empty *parts* with commas, stripping trailing punctuation
    (both ASCII and full-width) from each so we don't end up with ``..., ,``."""
    cleaned = []
    for p in parts:
        s = (p or "").strip().rstrip(",.;:!?，。；：！？")
        if s:
            cleaned.append(s)
    return ", ".join(cleaned)


def _err(msg: str) -> list[ContentBlock]:
    return [ContentBlock(type="text", text=msg)]


def _as_bool(value: object, *, default: bool = True) -> bool:
    """Coerce common LLM-emitted bool-like values without flipping unknowns."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
        return default
    if isinstance(value, (int, float)):
        return value != 0
    return default


def make_handler(app: App) -> Callable[[dict, dict], list[ContentBlock]]:
    """Build a closure handler bound to the running ``App``.

    Returned callable signature matches
    ``LocalToolHandler``: ``(arguments, context) -> list[ContentBlock]``.
    """

    def handler(arguments: dict, context: dict) -> list[ContentBlock]:
        persona = context.get("persona")
        persona_id = context.get("persona_id") or ""
        if persona is None or not persona_id:
            return _err("生图工具上下文缺失：未提供 persona。")

        settings = normalize_image_generation(getattr(persona, "image_generation", None))
        if not settings["enabled"]:
            return _err("当前角色未启用图片生成。")
        if not settings["provider"] or not settings["model"]:
            return _err("当前角色未指定生图服务商或模型。")

        prompt = (arguments.get("prompt") or "").strip()
        if not prompt:
            return _err("调用 generate_image 需要 prompt。")

        try:
            width = int(arguments.get("width") or 1024)
            height = int(arguments.get("height") or 1024)
        except (TypeError, ValueError):
            width, height = 1024, 1024
        width = max(64, min(width, 4096))
        height = max(64, min(height, 4096))

        # Order matches what the LLM is told in the system guidance:
        # art_style, style_prefix, then the LLM's scene/action description.
        full_prompt = _join_prompt_parts(settings["art_style"], settings["style_prefix"], prompt)

        provider = app.image_manager.get_provider_for_model(settings["provider"], settings["model"])
        if provider is None:
            return _err(
                f"找不到可用的生图服务商/模型：{settings['provider']} / {settings['model']}。"
                f"请检查 API Key 是否填写、模型 ID 是否在该服务商下注册。"
            )

        # The AI may proactively skip the reference image for this call (pure
        # landscape/object scenes that don't need a character). A reference
        # image the user turned off in persona config (ref_mode=none) is never
        # switched back on. Defensive handling: some LLMs serialize booleans as strings or numbers.
        if not _as_bool(arguments.get("use_reference_image"), default=True):
            ref_images: list[tuple[bytes, str]] = []
        else:
            ref_images = resolve_reference_images(persona_id, settings)

        # Pass negatives only when the per-persona switch is on; providers that
        # don't natively support negatives (OpenAI/Gemini) get an empty string
        # so they won't append a misleading "Negative prompt" notice.
        neg_prompt_arg = settings["negative_prompt"].strip() if settings["negative_enabled"] else ""

        try:
            response = provider.generate(
                full_prompt,
                model=settings["model"],
                width=width,
                height=height,
                negative_prompt=neg_prompt_arg,
                reference_images=ref_images,
            )
        except Exception as exc:
            logger.exception(
                "生图调用失败 persona=%s provider=%s model=%s",
                persona_id, settings["provider"], settings["model"],
            )
            return _err(f"图片生成失败：{exc}")

        image_bytes = response.image_data
        mime = response.mime_type or "image/png"
        ext = "png" if mime.endswith("/png") else (
            "jpg" if mime.endswith("/jpeg") or mime.endswith("/jpg") else "png"
        )
        image_id = secrets.token_hex(8)
        # The role still selects its own avatar/reference; only the generated
        # artifact belongs to the group staging directory when one is supplied.
        media_dir = context.get("media_dir")
        out_dir = (Path(media_dir) if media_dir is not None else CHATS_DIR / persona_id) / "images"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"gen_{image_id}.{ext}"
        try:
            out_path.write_bytes(image_bytes)
        except Exception as exc:
            logger.exception("保存生成图片失败 persona=%s path=%s", persona_id, out_path)
            return _err(f"图片保存失败：{exc}")

        generated = context.get("generated_images")
        if isinstance(generated, list):
            generated.append({
                "path": str(out_path),
                "mime": mime,
                "prompt": full_prompt,
            })

        b64 = base64.b64encode(image_bytes).decode("ascii")
        logger.info(
            "已生成图片 persona=%s provider=%s model=%s size=%dx%d bytes=%d",
            persona_id, settings["provider"], settings["model"], width, height, len(image_bytes),
        )
        return [
            ContentBlock(type="image", data=b64, mime_type=mime),
            ContentBlock(
                type="text",
                text="图片已生成并展示给用户。请用一句简短自然的话回应这张图。",
            ),
        ]

    return handler
