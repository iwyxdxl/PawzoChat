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

"""ElevenLabs v4 native TTS and account voice discovery."""
from __future__ import annotations

from urllib.parse import quote

import requests

from pawzochat.voice.base import VoiceGenerationError, VoiceProvider, VoiceResponse


class ElevenLabsTTSProvider(VoiceProvider):
    provider_type = "elevenlabs_tts"
    control_family = "elevenlabs"
    MODEL = "eleven_v4"
    MAX_CHARACTERS = 10_000

    def __init__(self, base_url: str, api_key: str, **kwargs):
        # Both /v1/text-to-speech and /v2/voices are relative to this root.
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _request(self, method, path, **kwargs):
        if not self.api_key:
            raise VoiceGenerationError(self.provider_type, "请先设置 ElevenLabs API Key", status_code=400)
        try:
            response = method(
                self.base_url + path,
                headers={"xi-api-key": self.api_key, "Accept": "audio/mpeg" if path.startswith("/v1/") else "application/json"},
                timeout=120 if path.startswith("/v1/") else 30,
                allow_redirects=False,
                **kwargs,
            )
        except requests.exceptions.Timeout:
            raise VoiceGenerationError(self.provider_type, "ElevenLabs 请求超时，请稍后重试", status_code=504) from None
        except requests.exceptions.RequestException:
            raise VoiceGenerationError(self.provider_type, "无法连接 ElevenLabs，请检查服务地址和网络", status_code=502) from None
        if 300 <= response.status_code < 400:
            raise VoiceGenerationError(self.provider_type, "服务地址发生重定向，请填写最终 API 地址", status_code=502)
        if not response.ok:
            # Never echo upstream bodies: relays may include credentials or input.
            messages = {
                400: "请求参数无效，请检查模型和音色设置",
                401: "API Key 无效或缺少所需权限",
                402: "账户额度不足",
                403: "账户或音色无访问权限，请检查套餐和密钥权限",
                404: "音色或接口不存在，请检查音色 ID 和服务地址",
                422: "合成参数或音色不适用于 Eleven v4",
                429: "请求受限或账户额度不足，请检查额度并稍后重试",
            }
            message = messages.get(response.status_code, "服务暂时不可用，请稍后重试")
            # Some quota / voice failures use 401 or 400. Read only known error
            # codes, never display the upstream message or arbitrary content.
            try:
                data = response.json()
                detail = data.get("detail") if isinstance(data, dict) else None
                code = detail.get("status") if isinstance(detail, dict) else None
            except ValueError:
                code = None
            errors = {
                "quota_exceeded": "账户额度不足，请检查 ElevenLabs 额度",
                "insufficient_credits": "账户额度不足，请检查 ElevenLabs 额度",
                "invalid_api_key": "API Key 无效，请检查密钥",
                "missing_permissions": "密钥缺少所需权限",
                "voice_not_found": "音色不存在或当前账户无法访问，请检查 voice ID",
                "model_not_found": "服务商尚未提供 Eleven v4 模型",
                "too_many_concurrent_requests": "并发请求过多，请稍后重试",
                "rate_limit_exceeded": "请求频率受限，请稍后重试",
            }
            if isinstance(code, str):
                message = errors.get(code, message)
            raise VoiceGenerationError(self.provider_type, f"ElevenLabs HTTP {response.status_code}：{message}", status_code=response.status_code)
        return response

    def synthesize(self, text: str, *, model: str, voice: str = "", speed: float = 1.0, **kwargs) -> VoiceResponse:
        if model != self.MODEL:
            raise VoiceGenerationError(self.provider_type, "ElevenLabs 首版仅支持 eleven_v4", status_code=400)
        if not voice.strip() or voice in (".", ".."):
            raise VoiceGenerationError(self.provider_type, "请选择 ElevenLabs 音色或填写 voice ID", status_code=400)
        if not text.strip():
            raise VoiceGenerationError(self.provider_type, "输入文本为空", status_code=400)
        if len(text) > self.MAX_CHARACTERS:
            raise VoiceGenerationError(self.provider_type, "Eleven v4 单次合成文本不能超过 10000 字符（含控制标签）", status_code=400)
        body = {
            "text": text, "model_id": model,
            "voice_settings": {
                "stability": kwargs.get("stability", 0.5),
                "similarity_boost": kwargs.get("similarity_boost", 0.75),
            },
        }
        response = self._request(
            requests.post, f"/v1/text-to-speech/{quote(voice, safe='')}",
            json=body, params={"output_format": "mp3_44100_128"},
        )
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower().strip()
        if not response.content or content_type not in ("audio/mpeg", "audio/mp3", "application/octet-stream"):
            raise VoiceGenerationError(self.provider_type, "ElevenLabs 未返回有效的 MP3 音频", status_code=502)
        if response.content.lstrip().startswith((b"{", b"[", b"<")):
            raise VoiceGenerationError(self.provider_type, "ElevenLabs 返回了错误内容而非音频", status_code=502)
        return VoiceResponse(audio_data=response.content, mime_type="audio/mpeg", format="mp3")

    def list_voices(self, *, search: str = "", next_page_token: str = "", page_size: int = 30) -> dict:
        params = {"page_size": page_size, "include_total_count": "false"}
        if search:
            params["search"] = search
        if next_page_token:
            params["next_page_token"] = next_page_token
        response = self._request(requests.get, "/v2/voices", params=params)
        try:
            data = response.json()
            if not isinstance(data, dict) or not isinstance(data.get("voices"), list):
                raise ValueError
            voices = []
            for voice in data["voices"]:
                if not isinstance(voice, dict) or not isinstance(voice.get("voice_id"), str):
                    raise ValueError
                labels = voice.get("labels") or {}
                if not isinstance(labels, dict):
                    raise ValueError
                voices.append({
                    "id": voice["voice_id"], "name": str(voice.get("name") or voice["voice_id"]),
                    "category": str(voice.get("category") or ""),
                    "labels": {k: v for k, v in labels.items() if isinstance(v, str)},
                })
            has_more = data.get("has_more", False)
            token = data.get("next_page_token") or ""
            if not isinstance(has_more, bool) or not isinstance(token, str) or (has_more and not token):
                raise ValueError
        except (ValueError, TypeError, KeyError):
            raise VoiceGenerationError(self.provider_type, "ElevenLabs 音色列表格式无效", status_code=502) from None
        return {"voices": voices, "has_more": has_more, "next_page_token": token}
