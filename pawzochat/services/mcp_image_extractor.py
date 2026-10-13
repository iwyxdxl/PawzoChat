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

"""Pull image payloads out of MCP tool results so they can be sent to users.

MCP servers may return images in three shapes:

* an ``ImageContent`` block — already normalized to
  ``ContentBlock(type="image", data=<b64>, mime_type=...)`` by
  :func:`pawzochat.mcp.client._mcp_content_to_blocks`.
* an ``EmbeddedResource`` carrying an ``image/*`` MIME blob — the same
  helper normalizes it into a ``type="image"`` block.
* a base64 data URI embedded in a ``TextContent`` — either a bare
  ``data:image/...;base64,...`` URI or a markdown
  ``![alt](data:image/...;base64,...)`` wrapper. This is the shape used by
  servers that have no way to attach binary content.

This module writes each image to ``data/chats/<persona_id>/images/mcp_*.<ext>``
and produces a sanitized block list to feed back to the LLM. The saved
metadata mirrors ``generated_images`` entries so
:meth:`pawzochat.services.chat.ChatService.process_round` emits them as
standalone assistant messages without any extra plumbing.
"""

from __future__ import annotations

import base64
import binascii
import io
import logging
import re
import secrets
from pathlib import Path

from pawzochat.llm.base import ContentBlock
from pawzochat.paths import CHATS_DIR

logger = logging.getLogger(__name__)


_MAX_IMAGE_BYTES = 20 * 1024 * 1024
_MAX_IMAGES_PER_RESULT = 8

# Markdown form is terminated by ``)``, so the base64 capture can safely
# include whitespace (RFC 2397 permits line-wrapped base64 in data URIs).
# Raw form has no terminator, so it stays strict — whitespace ends the
# capture and ``_decode_payload`` handles padding if the URI was split.
# Both alphabets accept URL-safe characters (``-``/``_``);
# ``_decode_payload`` normalizes them before strict decode.
_MD_IMG_RE = re.compile(
    r"!\[[^\]]*\]\(data:(image/[a-zA-Z0-9.+-]+);base64,"
    r"([A-Za-z0-9+/=_\s\-]+?)\)",
)
_RAW_DATA_URI_RE = re.compile(
    r"data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=_\-]+)",
)

# PIL.Image.format → (mime, ext). Covers everything PIL can decode that
# we might receive from an MCP server; bytes not parseable by PIL get
# rejected outright.
_PIL_FORMAT_MAP = {
    "PNG": ("image/png", "png"),
    "JPEG": ("image/jpeg", "jpg"),
    "JPEG2000": ("image/jp2", "jp2"),
    "GIF": ("image/gif", "gif"),
    "WEBP": ("image/webp", "webp"),
    "BMP": ("image/bmp", "bmp"),
    "TIFF": ("image/tiff", "tiff"),
    "ICO": ("image/x-icon", "ico"),
    "AVIF": ("image/avif", "avif"),
    "HEIF": ("image/heic", "heic"),
}


def _detect_and_verify(raw: bytes) -> tuple[str, str] | None:
    """Verify *raw* parses as an image and return ``(mime, ext)``.

    Trusts PIL's format identification over any caller-supplied MIME
    string, and runs ``Image.verify()`` so that truncated payloads — which
    can still satisfy a magic-byte sniff — are rejected before they are
    written to disk and shipped to WeChat as broken ``[图片]`` previews.

    Catches the full ``Exception`` tree because PIL's
    ``DecompressionBombError`` inherits straight from ``Exception`` (not
    ``OSError``), and a crafted header that declares >2× ``MAX_IMAGE_PIXELS``
    would otherwise escape into ``extract_mcp_images`` and abort the
    surrounding chat round.
    """
    from PIL import Image

    try:
        with Image.open(io.BytesIO(raw)) as img:
            fmt = (img.format or "").upper()
            # verify() invalidates the image instance, so do the format
            # lookup first.
            img.verify()
    except Exception:
        return None

    return _PIL_FORMAT_MAP.get(fmt)


def _safe_persona_images_dir(persona_id: str) -> Path | None:
    out_dir = CHATS_DIR / persona_id / "images"
    try:
        resolved = out_dir.resolve()
    except OSError:
        logger.warning("MCP 图片目录解析失败 persona=%s", persona_id)
        return None

    base_dir = CHATS_DIR.resolve()
    if resolved != base_dir and base_dir not in resolved.parents:
        logger.warning("拒绝写入 chats 目录外的 MCP 图片路径 persona=%s path=%s", persona_id, out_dir)
        return None
    return resolved


def _decode_payload(payload: str | bytes) -> bytes | None:
    """Decode a base64 image payload; accepts standard + URL-safe alphabets."""
    if isinstance(payload, bytes):
        try:
            text = payload.decode("ascii")
        except UnicodeDecodeError:
            return payload
        payload = text

    cleaned = re.sub(r"\s+", "", payload or "")
    if not cleaned:
        return None

    approx_bytes = (len(cleaned) * 3) // 4
    if approx_bytes > _MAX_IMAGE_BYTES:
        return None

    # Normalize URL-safe characters before strict decode so callers that
    # only use one regex flavour (raw form excludes ``_``/``-``) still
    # decode correctly when the upstream tool used url-safe base64.
    if "-" in cleaned or "_" in cleaned:
        cleaned = cleaned.replace("-", "+").replace("_", "/")
    # Pad to a multiple of 4 — some tools emit base64 without padding.
    rem = len(cleaned) % 4
    if rem:
        cleaned += "=" * (4 - rem)

    try:
        return base64.b64decode(cleaned, validate=True)
    except (binascii.Error, ValueError):
        return None


def _save_image(
    persona_id: str, payload: str | bytes, mime: str,
    *, media_dir: Path | None = None,
) -> dict | None:
    """Decode + write one image; return ``{path, mime, filename}`` or None.

    The caller-supplied *mime* is informational only — the actual file
    format comes from inspecting the decoded bytes via Pillow so a
    mislabelled or upstream-corrupted MIME (e.g. ``image/jpegpeg``) cannot
    cause us to write a bogus image to disk.
    """
    raw = _decode_payload(payload)
    if not raw:
        logger.warning(
            "MCP 图片 base64 解码失败 persona=%s mime=%s",
            persona_id, mime,
        )
        return None
    if len(raw) > _MAX_IMAGE_BYTES:
        logger.warning(
            "MCP 图片过大 persona=%s mime=%s size=%d",
            persona_id, mime, len(raw),
        )
        return None

    detected = _detect_and_verify(raw)
    if detected is None:
        head = raw[:16].hex(" ")
        logger.warning(
            "MCP 图片格式不受支持或数据损坏 persona=%s mime=%s size=%d head=%s",
            persona_id, mime, len(raw), head,
        )
        return None

    normalized_mime, ext = detected
    # media_dir is supplied by the host, never by tool arguments. Group callers
    # own this staging root and move the finished turn's files on commit.
    out_dir = (Path(media_dir).resolve() / "images") if media_dir is not None else _safe_persona_images_dir(persona_id)
    if out_dir is None:
        return None

    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"mcp_{secrets.token_hex(8)}.{ext}"
        out_path.write_bytes(raw)
    except OSError:
        logger.exception("MCP 图片落盘失败 persona=%s", persona_id)
        return None

    return {
        "path": str(out_path),
        "mime": normalized_mime,
        "filename": out_path.name,
    }


def _extract_from_text(
    persona_id: str, text: str,
    *,
    remaining: int,
    media_dir: Path | None = None,
) -> tuple[str, list[dict], int]:
    """Find data URIs in *text*; save each, return sanitized text + saved entries."""
    saved: list[dict] = []
    skipped = 0

    def repl(match: re.Match) -> str:
        nonlocal skipped
        if len(saved) >= remaining:
            skipped += 1
            return "(图片数量超过上限)"
        entry = _save_image(persona_id, match.group(2), match.group(1), media_dir=media_dir)
        if entry:
            saved.append(entry)
            return "(图片已发送给用户)"
        return "(图片解析失败)"

    # Markdown form first so we strip the `![alt](...)` wrapper entirely;
    # otherwise the leftover `![alt]()` would clutter what the LLM sees.
    new_text = _MD_IMG_RE.sub(repl, text)
    new_text = _RAW_DATA_URI_RE.sub(repl, new_text)
    return new_text, saved, skipped


def extract_mcp_images(
    blocks: list[ContentBlock],
    *,
    persona_id: str,
    media_dir: Path | None = None,
) -> tuple[list[dict], list[ContentBlock]]:
    """Pull image payloads out of MCP tool result blocks.

    ``media_dir`` is an optional host-owned staging root. Omitting it keeps
    the existing private-chat image directory for the supplied persona.

    Returns ``(saved, rewritten)``:

    * ``saved`` — one ``{"path", "mime", "filename"}`` per image written to
      disk. Caller should extend ``context["generated_images"]`` with these
      so the outer ``process_round`` loop turns each into an outbound
      assistant message.
    * ``rewritten`` — block list to feed back to the LLM as the tool
      result. Image blocks are kept so vision-capable providers can still see
      them; for each batch of saved images a single confirmation text block is
      appended so providers that flatten images to text know the image was
      delivered and don't respond with ``[图片]``.
    """
    saved: list[dict] = []
    rewritten: list[ContentBlock] = []
    skipped = 0
    failed = 0

    for block in blocks:
        if block.type == "image":
            if not block.data:
                continue
            if len(saved) >= _MAX_IMAGES_PER_RESULT:
                skipped += 1
                continue
            entry = _save_image(
                persona_id, block.data, block.mime_type or "image/png",
                media_dir=media_dir,
            )
            if entry is None:
                # Decode/verify failed — drop the broken image block
                # (broken payloads upset some providers). The aggregated
                # ``failed`` summary text added below tells the LLM the
                # image is gone so it doesn't fabricate a ``[图片]``
                # placeholder.
                failed += 1
                continue
            saved.append(entry)
            rewritten.append(block)
            continue

        if block.type == "text" and block.text:
            remaining = _MAX_IMAGES_PER_RESULT - len(saved)
            new_text, extracted, extra_skipped = _extract_from_text(
                persona_id, block.text, remaining=remaining,
                media_dir=media_dir,
            )
            saved.extend(extracted)
            skipped += extra_skipped
            if new_text.strip():
                rewritten.append(ContentBlock(type="text", text=new_text))
            continue

        rewritten.append(block)

    if saved:
        names = "、".join(s["filename"] for s in saved)
        rewritten.append(ContentBlock(
            type="text",
            text=(
                f"以上 {len(saved)} 张图片已通过 MCP 工具落盘并直接发送给用户（{names}）。"
                "请用一两句自然的话回应这些图片，不要重复 base64、不要输出 [图片] 占位符。"
            ),
        ))
    if skipped:
        rewritten.append(ContentBlock(
            type="text",
            text=f"另有 {skipped} 张 MCP 图片因数量上限未处理。",
        ))
    if failed:
        rewritten.append(ContentBlock(
            type="text",
            text=(
                f"另有 {failed} 张 MCP 图片解析失败已忽略，请不要输出 [图片] 占位符。"
            ),
        ))

    return saved, rewritten
