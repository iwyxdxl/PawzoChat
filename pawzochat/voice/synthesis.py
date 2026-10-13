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

"""Voice-reply synthesis helper.

Triggered by [语音]/[voice] markers in the reply text (see
:func:`pawzochat.utils.text_splitter.parse_voice_reply`): provider resolution
→ voice fallback → TTS synthesis → duration probe → persist to disk. Any
failure returns ``None`` with a warning logged, and the caller degrades that
voice run into a regular text message.
"""

from __future__ import annotations

import logging
import secrets
from pathlib import Path
from typing import TYPE_CHECKING

from pawzochat.paths import CHATS_DIR
from pawzochat.voice.transcode import probe_mp3_duration_ms
from pawzochat.voice.request import synthesize_with_settings
from pawzochat.voice.settings import clean_fallback_text

if TYPE_CHECKING:
    from pawzochat.voice.manager import VoiceManager

logger = logging.getLogger(__name__)


def synthesize_voice_clip(
    voice_manager: VoiceManager,
    *,
    persona_id: str,
    settings: dict,
    text: str,
    emotion: str = "",
    media_dir: Path | None = None,
    preserve_boundaries: bool = False,
) -> dict | None:
    """Synthesize one clip into the private chat or a host-owned media root.

    ``media_dir`` overrides ``data/chats/<persona_id>`` for group staging;
    it never changes which persona's voice settings are used.
    ``preserve_boundaries`` keeps spaces where voice controls are removed
    from the transcript, so group mention names cannot merge with text.

    ``settings`` is the product of ``normalize_voice_generation``; the caller
    must have passed the availability gate already (enabled + resolvable
    provider/model). ``text`` is cleaned text (message separators already
    turned into commas); ``emotion`` is a validated emotion, "" for none.

    Returns ``{"path", "mime", "duration_ms", "text"}`` on success (fields
    aligned with the voice draft block); returns ``None`` on failure and
    never raises.
    """
    try:
        response = synthesize_with_settings(voice_manager, settings, text, emotion)
    except Exception:
        logger.warning(
            "语音合成失败，该语音段将降级为文字 persona=%s provider=%s model=%s",
            persona_id, settings["provider"], settings["model"],
            exc_info=True,
        )
        return None

    audio_bytes = response.audio_data
    duration_ms = probe_mp3_duration_ms(audio_bytes)

    out_dir = (Path(media_dir) if media_dir is not None else CHATS_DIR / persona_id) / "voice"
    out_path = out_dir / f"tts_{secrets.token_hex(8)}.{response.format or 'mp3'}"
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(audio_bytes)
    except Exception:
        logger.warning(
            "保存语音文件失败，该语音段将降级为文字 persona=%s path=%s",
            persona_id, out_path, exc_info=True,
        )
        return None

    logger.info(
        "已合成语音 persona=%s provider=%s model=%s voice=%s duration=%dms bytes=%d",
        persona_id, settings["provider"], settings["model"],
        settings["voice"] or "(默认)", duration_ms, len(audio_bytes),
    )
    return {
        "path": str(out_path),
        "mime": response.mime_type or "audio/mpeg",
        "duration_ms": duration_ms,
        "text": clean_fallback_text(text, preserve_boundaries=preserve_boundaries),
    }
