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

"""PawzoChat native persona bundle (``.ppack`` = plain ZIP).

Bundle layout:

    pawzochat.json    — manifest + portable persona settings
    prompt.json       — three-section prompt payload
    avatar.png        — optional 256x256 avatar
    image_refs/ref.png — optional custom reference image
    worldbooks/*.json — copy of each bound worldbook (native format)

Bundles preserve PawzoChat role settings (memory policy, proactive messages,
tools, image/voice generation and per-book scope/keywords). They do not include
memory entries, conversation history, provider credentials, emoji assets or
local account/group bindings. SillyTavern cards carry role settings in the
``pawzochat`` extension, which other clients may not understand.
"""

from __future__ import annotations

import io
import json
import logging
import zipfile
from dataclasses import dataclass, field

from pawzochat import __version__ as _PKG_VERSION  # type: ignore[attr-defined]
from pawzochat.image.reference import (
    CUSTOM_REFERENCE_ZIP_PATH,
    normalize_reference_image_png,
)
from pawzochat.transport.models import Persona

logger = logging.getLogger(__name__)

BUNDLE_KIND = "pawzochat_persona_bundle"
BUNDLE_VERSION = 1
MANIFEST_NAME = "pawzochat.json"
PROMPT_NAME = "prompt.json"
AVATAR_NAME = "avatar.png"
BOOKS_PREFIX = "worldbooks/"


@dataclass
class BundleImportResult:
    """Everything needed to reconstruct a persona + books from a bundle."""

    name: str
    persona_config: dict
    character_prompt: str
    output_examples: str
    system_instructions: str
    avatar_png: bytes | None = None
    reference_image_png: bytes | None = None
    books: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # An explicit blank prompt must not turn into the application's default.
    has_system_instructions: bool = False


def _persona_config_from(persona: Persona) -> dict:
    """Serialise the Persona-level config that lives in config.yaml."""
    return {
        "name": persona.name,
        "llm_provider": persona.llm_provider,
        "llm_model": persona.llm_model,
        "temperature": persona.temperature,
        "max_tokens": persona.max_tokens,
        "emoji_enabled": persona.emoji_enabled,
        "emoji_send_probability": persona.emoji_send_probability,
        "emoji_group": persona.emoji_group,
        # Group IDs point to local memory archives, which are not bundled.
        "memory": {key: value for key, value in persona.memory.items() if key != "group_reads"},
        "proactive": dict(persona.proactive),
        "tool_policy": dict(persona.tool_policy),
        "image_generation": dict(persona.image_generation),
        "voice_generation": dict(persona.voice_generation),
        "bound_worldbooks": list(persona.bound_worldbooks),
    }


def pack_persona(
    persona: Persona,
    *,
    avatar_png: bytes | None = None,
    reference_image_png: bytes | None = None,
    bound_books: list[dict] | None = None,
) -> bytes:
    """Return a ZIP byte-string containing persona + prompt + avatar + books."""
    books = bound_books or []
    config = _persona_config_from(persona)
    book_names = {str(book.get("name") or "").strip() for book in books}
    config["bound_worldbooks"] = [name for name in persona.bound_worldbooks if name in book_names]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.comment = b"84aw4m7c964"
        manifest = {
            "kind": BUNDLE_KIND,
            "version": BUNDLE_VERSION,
            "exporter_version": _PKG_VERSION,
            "persona": config,
        }
        zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.writestr(PROMPT_NAME, json.dumps(
            {
                "character_prompt": persona.character_prompt,
                "output_examples": persona.output_examples,
                "system_instructions": persona.system_instructions,
            },
            ensure_ascii=False, indent=2,
        ))
        if avatar_png:
            zf.writestr(AVATAR_NAME, avatar_png)
        if reference_image_png:
            zf.writestr(CUSTOM_REFERENCE_ZIP_PATH, reference_image_png)
        for book in books:
            name = str(book.get("name") or "").strip()
            if not name:
                continue
            zf.writestr(
                f"{BOOKS_PREFIX}{name}.json",
                json.dumps(book, ensure_ascii=False, indent=2),
            )
    return buf.getvalue()


def unpack_persona(zip_bytes: bytes) -> BundleImportResult:
    """Read a bundle's bytes into a structured import result. Validates manifest."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise ValueError(f"不是有效的 ZIP 文件: {exc}") from exc

    with zf:
        names = set(zf.namelist())
        if MANIFEST_NAME not in names:
            raise ValueError(f"缺少 {MANIFEST_NAME}")

        try:
            manifest = json.loads(zf.read(MANIFEST_NAME).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError(f"{MANIFEST_NAME} 解析失败: {exc}") from exc
        if manifest.get("kind") != BUNDLE_KIND:
            raise ValueError(f"不是 PawzoChat 角色包（kind={manifest.get('kind')!r}）")

        persona_cfg = manifest.get("persona") or {}
        if isinstance(persona_cfg.get("memory"), dict):
            # Older bundles included these non-portable archive references.
            persona_cfg["memory"].pop("group_reads", None)
        name = str(persona_cfg.get("name") or "").strip()
        if not name:
            raise ValueError("角色包缺少 name 字段")

        warnings: list[str] = []
        char, examples, system = "", "", ""
        has_system_instructions = False
        if PROMPT_NAME in names:
            try:
                prompt = json.loads(zf.read(PROMPT_NAME).decode("utf-8"))
                char = str(prompt.get("character_prompt") or "")
                examples = str(prompt.get("output_examples") or "")
                system = str(prompt.get("system_instructions") or "")
                has_system_instructions = "system_instructions" in prompt
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                warnings.append(f"{PROMPT_NAME} 损坏，已使用空 prompt: {exc}")

        avatar = zf.read(AVATAR_NAME) if AVATAR_NAME in names else None
        reference_image_png = None
        if CUSTOM_REFERENCE_ZIP_PATH in names:
            try:
                reference_image_png = normalize_reference_image_png(
                    zf.read(CUSTOM_REFERENCE_ZIP_PATH),
                )
            except Exception as exc:  # noqa: BLE001 - import-time validation
                warnings.append(f"自定义参考图损坏，已跳过: {exc}")

        books: list[dict] = []
        for entry_name in sorted(names):
            if not entry_name.startswith(BOOKS_PREFIX) or not entry_name.endswith(".json"):
                continue
            try:
                book = json.loads(zf.read(entry_name).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                warnings.append(f"世界书 {entry_name} 损坏，已跳过: {exc}")
                continue
            if isinstance(book, dict) and book.get("name"):
                books.append(book)

        # ZIP entry names need not follow the persona's binding order.
        bound_names = persona_cfg.get("bound_worldbooks")
        if isinstance(bound_names, list):
            order = {name: i for i, name in enumerate(bound_names) if isinstance(name, str)}
            books.sort(key=lambda book: order.get(str(book["name"]), len(bound_names)))

    return BundleImportResult(
        name=name,
        persona_config=persona_cfg,
        character_prompt=char,
        output_examples=examples,
        system_instructions=system,
        avatar_png=avatar,
        reference_image_png=reference_image_png,
        books=books,
        warnings=warnings,
        has_system_instructions=has_system_instructions,
    )
