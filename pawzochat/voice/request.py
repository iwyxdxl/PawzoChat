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

"""One synthesis request path for persona chat and unsaved preview settings."""
from __future__ import annotations

from pawzochat.voice.base import VoiceGenerationError
from pawzochat.voice.settings import (
    effective_emotion, normalize_voice_generation, strip_interjections, strip_pause_tags,
    validate_voice_generation, prepare_elevenlabs_text, strip_elevenlabs_audio_tags,
)


def synthesize_with_settings(manager, settings, text, emotion=""):
    error = validate_voice_generation(settings)
    if error:
        raise ValueError(error)
    settings = normalize_voice_generation(settings)
    provider = manager.get_provider_for_model(settings["provider"], settings["model"])
    if provider is None:
        raise VoiceGenerationError("tts", "服务商或模型未就绪（请检查 API Key 和模型配置）", status_code=400)
    family = manager.get_control_family(settings["provider"], settings["model"])
    if family != provider.control_family:
        raise VoiceGenerationError("tts", "服务商与模型调用类型不匹配，无法传递语音控制参数，请检查模型的调用类型", status_code=400)
    voice = settings["voice"] or manager.get_model_voice(settings["provider"], settings["model"])
    kwargs = {}
    selected_emotion = effective_emotion(settings, emotion) if family in ("minimax", "mimo", "elevenlabs") else ""
    if selected_emotion and family != "elevenlabs":
        kwargs["emotion"] = selected_emotion
    if family != "elevenlabs":
        text = strip_elevenlabs_audio_tags(text)
    if family == "elevenlabs":
        text = prepare_elevenlabs_text(text, settings, selected_emotion)
        kwargs = {key: settings["elevenlabs"][key] for key in ("stability", "similarity_boost")}
    elif family == "minimax":
        mm = settings["minimax"]
        if not mm["interjections_enabled"]:
            text = strip_interjections(text)
        if not mm["pause_enabled"]:
            text = strip_pause_tags(text)
        language = mm["language_boost"] or ("Chinese,Yue" if voice.startswith("Cantonese_") else "")
        kwargs.update(volume=mm["volume"], pitch=mm["pitch"])
        if language:
            kwargs["language_boost"] = language
    elif family == "mimo":
        kwargs.update(settings["mimo"])
    if not text.strip():
        raise VoiceGenerationError("tts", "去除控制标签后没有可合成的文本", status_code=400)
    return provider.synthesize(text, model=settings["model"], voice=voice,
                               speed=settings["speed"], **kwargs)
