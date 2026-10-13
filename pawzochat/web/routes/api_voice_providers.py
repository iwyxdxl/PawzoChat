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

"""REST API for TTS (voice) provider management."""

from __future__ import annotations

import base64
import logging
import re

from flask import Blueprint, jsonify, request

from pawzochat.voice.base import VoiceGenerationError
from pawzochat.voice.providers.elevenlabs_tts import ElevenLabsTTSProvider
from pawzochat.voice.settings import (
    VOICE_GENERATION_DEFAULTS, control_family, control_description,
    normalize_voice_generation, validate_voice_generation,
)
from pawzochat.voice.request import synthesize_with_settings
from pawzochat.voice.manager import (
    MODEL_TYPE_OPTIONS,
    VALID_MODEL_TYPES,
    VOICE_CATALOGS,
    VOICE_PRESET_MODELS,
    VOICE_PROVIDER_PRESETS,
    ensure_voice_models_list,
    resolve_model_type,
    resolve_base_url,
    resolve_voice_catalog,
)
from pawzochat.web.routes import get_app

logger = logging.getLogger(__name__)

api_voice_providers_bp = Blueprint("api_voice_providers", __name__)

_NAME_RE = re.compile(r'^[a-zA-Z0-9一-鿿][a-zA-Z0-9一-鿿_\-]*$')
_SAFE_AUDIO_MIME_TYPES = {
    "audio/mpeg", "audio/wav", "audio/flac", "audio/opus",
    "audio/aac", "audio/L16;rate=24000", "audio/basic",
}


def _validate_provider_name(name: str) -> str | None:
    if not name:
        return "名称不能为空"
    if len(name) > 30:
        return "名称不能超过 30 个字符"
    if not _NAME_RE.match(name):
        return "名称只能包含字母、数字、中文、下划线和连字符，且不能以符号开头"
    return None


def _normalize_audio_mime_type(mime_type: str | None) -> str:
    mime = (mime_type or "").split(";", 1)[0].strip().lower()
    if mime == "audio/jpg":
        mime = "audio/mpeg"
    if mime in _SAFE_AUDIO_MIME_TYPES:
        return mime
    return "audio/mpeg"


def _reinit_voice(app):
    app.voice_manager.init_from_config(app.config.get("voice_providers", default={}))


def _provider_summary(name: str, cfg: dict) -> dict:
    """Build a JSON-safe summary dict for one voice provider entry."""
    preset = cfg.get("preset", "custom")
    preset_info = VOICE_PROVIDER_PRESETS.get(preset)
    base_url = preset_info["base_url"] if preset_info else cfg.get("base_url", "")

    # voice_catalog is derived per request, never persisted: it would go stale
    # the moment the provider's preset changed.
    models = [
        {**m, "voice_catalog": resolve_voice_catalog(cfg, m),
         "tts_controls": control_description(control_family(cfg, m))}
        for m in ensure_voice_models_list(cfg)
    ]

    return {
        "name": name,
        "preset": preset,
        "base_url": base_url,
        "api_key_set": bool(cfg.get("api_key", "")),
        "models": models,
    }


@api_voice_providers_bp.route("", methods=["GET"])
def list_voice_providers():
    app = get_app()
    providers_cfg = app.config.get("voice_providers", default={})
    result = [_provider_summary(name, cfg) for name, cfg in providers_cfg.items()]

    presets_out = {
        pid: {
            "name": p["name"],
            "default_name": p.get("default_name", p["name"]),
            "base_url": p["base_url"],
            "default_model_type": p.get("default_model_type", "openai_tts"),
            "endpoint_path": p["endpoint_path"],
        }
        for pid, p in VOICE_PROVIDER_PRESETS.items()
    }
    return jsonify({
        "providers": result,
        "presets": presets_out,
        "voice_defaults": VOICE_GENERATION_DEFAULTS,
        "preset_models": VOICE_PRESET_MODELS,
        "model_type_options": MODEL_TYPE_OPTIONS,
        "preset_voices": VOICE_CATALOGS,
    })


def _normalize_models_payload(models, provider_cfg) -> tuple[list[dict], str | None]:
    """Validate every model carries a known type; fill default when omitted."""
    out = []
    for m in models or []:
        mid = (m.get("id") or "").strip()
        if not mid:
            return [], "模型 ID 不能为空"
        entry = {
            "id": mid,
            "name": m.get("name") or mid,
        }
        t = m.get("type")
        if t and t not in VALID_MODEL_TYPES:
            return [], f"模型「{mid}」的调用方式不支持: {t}"
        entry["type"] = t or resolve_model_type(provider_cfg, m)
        if provider_cfg.get("preset") == "elevenlabs" and entry["type"] != "elevenlabs_tts":
            return [], "ElevenLabs 服务商须使用 ElevenLabs 原生调用方式"
        if entry["type"] == "elevenlabs_tts" and mid != ElevenLabsTTSProvider.MODEL:
            return [], "ElevenLabs 首版仅支持 eleven_v4"
        # Optional per-model voice preset
        if "voice" in m:
            entry["voice"] = m["voice"]
        out.append(entry)
    return out, None


@api_voice_providers_bp.route("", methods=["POST"])
def create_voice_provider():
    app = get_app()
    data = request.get_json(force=True)
    name = data.get("name", "").strip()

    err = _validate_provider_name(name)
    if err:
        return jsonify({"error": err}), 400

    preset = data.get("preset", "custom")
    entry: dict = {"preset": preset}

    if preset == "custom":
        entry["base_url"] = data.get("base_url", "")

    entry["api_key"] = data.get("api_key", "")

    models, merr = _normalize_models_payload(data.get("models", []), entry)
    if merr:
        return jsonify({"error": merr}), 400
    entry["models"] = models

    with app.config.lock:
        providers = app.config._data.setdefault("voice_providers", {})
        if name in providers:
            return jsonify({"error": f"语音服务商「{name}」已存在"}), 409
        providers[name] = entry
        app.config.save()
        _reinit_voice(app)
    return jsonify({"ok": True}), 201


@api_voice_providers_bp.route("/<name>", methods=["PUT"])
def update_voice_provider(name: str):
    app = get_app()
    data = request.get_json(force=True)
    new_name = data.get("name", "").strip() if "name" in data else name

    with app.config.lock:
        providers = app.config._data.get("voice_providers", {})
        if name not in providers:
            return jsonify({"error": "语音服务商未找到"}), 404

        if new_name != name:
            err = _validate_provider_name(new_name)
            if err:
                return jsonify({"error": err}), 400
            if new_name in providers:
                return jsonify({"error": f"语音服务商「{new_name}」已存在"}), 409

        preset = data.get("preset", providers[name].get("preset", "custom"))
        entry: dict = {"preset": preset}

        if preset == "custom":
            entry["base_url"] = data.get("base_url", providers[name].get("base_url", ""))

        if data.get("api_key"):
            entry["api_key"] = data["api_key"]
        else:
            entry["api_key"] = providers[name].get("api_key", "")

        raw_models = data["models"] if "models" in data else ensure_voice_models_list(providers[name])
        models, merr = _normalize_models_payload(raw_models, entry)
        if merr:
            return jsonify({"error": merr}), 400
        entry["models"] = models

        if new_name != name:
            del providers[name]

        providers[new_name] = entry
        app.config.save()
        _reinit_voice(app)
    return jsonify({"ok": True})


@api_voice_providers_bp.route("/<name>", methods=["DELETE"])
def delete_voice_provider(name: str):
    app = get_app()
    with app.config.lock:
        providers = app.config._data.get("voice_providers", {})
        if name not in providers:
            return jsonify({"error": "语音服务商未找到"}), 404

        del providers[name]
        app.config.save()
        _reinit_voice(app)
    return jsonify({"ok": True})


@api_voice_providers_bp.route("/<name>/voices", methods=["GET"])
def list_account_voices(name: str):
    cfg = get_app().config.get("voice_providers", default={}).get(name)
    if cfg is None:
        return jsonify({"error": "语音服务商未找到"}), 404
    if cfg.get("preset") != "elevenlabs" and not any(
        resolve_model_type(cfg, model) == "elevenlabs_tts" for model in (cfg.get("models") or [])
    ):
        return jsonify({"error": "该服务商不支持账户音色查询"}), 400
    try:
        page_size = int(request.args.get("page_size", "30"))
        if not 1 <= page_size <= 100:
            raise ValueError
    except ValueError:
        return jsonify({"error": "page_size 必须为 1–100 的整数"}), 400
    provider = ElevenLabsTTSProvider(resolve_base_url(cfg), cfg.get("api_key", ""))
    try:
        result = provider.list_voices(search=request.args.get("search", ""),
                                      next_page_token=request.args.get("next_page_token", ""),
                                      page_size=page_size)
    except VoiceGenerationError as exc:
        return jsonify({"error": str(exc)}), exc.status_code or 502
    response = jsonify(result)
    response.headers["Cache-Control"] = "no-store"
    return response


# ---- Model CRUD under a voice provider ---------------------------------


@api_voice_providers_bp.route("/<name>/models", methods=["POST"])
def add_voice_model(name: str):
    app = get_app()
    data = request.get_json(force=True)
    model_id = data.get("id", "").strip()
    if not model_id:
        return jsonify({"error": "模型 ID 不能为空"}), 400

    mtype = data.get("type")
    if mtype and mtype not in VALID_MODEL_TYPES:
        return jsonify({"error": f"不支持的调用方式: {mtype}"}), 400

    with app.config.lock:
        providers = app.config._data.get("voice_providers", {})
        if name not in providers:
            return jsonify({"error": "语音服务商未找到"}), 404

        provider_cfg = providers[name]
        models = provider_cfg.setdefault("models", [])
        if any(m["id"] == model_id for m in models):
            return jsonify({"error": f"模型「{model_id}」已存在"}), 409

        new_entry = {
            "id": model_id,
            "name": data.get("name", model_id),
            "type": mtype or resolve_model_type(provider_cfg, {"id": model_id}),
        }
        if "voice" in data:
            new_entry["voice"] = data["voice"]

        validated, error = _normalize_models_payload([new_entry], provider_cfg)
        if error:
            return jsonify({"error": error}), 400
        models.append(validated[0])
        app.config.save()
        _reinit_voice(app)
    return jsonify({"ok": True}), 201


@api_voice_providers_bp.route("/<name>/models/<model_id>", methods=["PUT"])
def update_voice_model(name: str, model_id: str):
    app = get_app()
    data = request.get_json(force=True)

    with app.config.lock:
        providers = app.config._data.get("voice_providers", {})
        if name not in providers:
            return jsonify({"error": "语音服务商未找到"}), 404

        provider_cfg = providers[name]
        models = provider_cfg.setdefault("models", [])
        target = next((m for m in models if m["id"] == model_id), None)
        if target is None:
            return jsonify({"error": "模型未找到"}), 404

        updated = {**target, **{key: data[key] for key in ("name", "type", "voice") if key in data}}
        validated, error = _normalize_models_payload([updated], providers[name])
        if error:
            return jsonify({"error": error}), 400
        target.update(validated[0])

        app.config.save()
        _reinit_voice(app)
    return jsonify({"ok": True})


@api_voice_providers_bp.route("/<name>/models/<model_id>", methods=["DELETE"])
def delete_voice_model(name: str, model_id: str):
    app = get_app()
    with app.config.lock:
        providers = app.config._data.get("voice_providers", {})
        if name not in providers:
            return jsonify({"error": "语音服务商未找到"}), 404

        models = providers[name].get("models", [])
        new_models = [m for m in models if m["id"] != model_id]
        if len(new_models) == len(models):
            return jsonify({"error": "模型未找到"}), 404

        providers[name]["models"] = new_models
        app.config.save()
        _reinit_voice(app)
    return jsonify({"ok": True})


# ---- Test invocation -----------------------------------------------------


@api_voice_providers_bp.route("/<name>/_test", methods=["POST"])
def test_voice_provider(name: str):
    """Invoke the TTS provider with sample text and return audio inline."""
    app = get_app()
    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求必须为对象"}), 400
    raw_settings = data.get("voice_generation", {"model": data.get("model", ""), "voice": data.get("voice", "")})
    error = validate_voice_generation(raw_settings)
    if error:
        return jsonify({"error": error}), 400
    settings = normalize_voice_generation(raw_settings)
    settings["provider"] = name
    model = settings["model"]
    text = data.get("text", "")
    if not isinstance(text, str):
        return jsonify({"error": "text 必须为文本"}), 400
    text = text.strip()
    emotion = data.get("emotion", "")
    if not isinstance(emotion, str):
        return jsonify({"error": "emotion 必须为文本"}), 400

    if not model:
        return jsonify({"error": "请选择模型"}), 400
    if not text:
        return jsonify({"error": "请输入文本"}), 400

    if name not in app.config._data.get("voice_providers", {}):
        return jsonify({"error": "语音服务商未找到"}), 404

    try:
        resp = synthesize_with_settings(app.voice_manager, settings, text, emotion)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except VoiceGenerationError as e:
        status = e.status_code or 502
        if status < 400 or status >= 600:
            status = 502
        return jsonify({"error": str(e)}), status
    except Exception as e:
        logger.exception("TTS 测试调用失败: name=%s model=%s", name, model)
        return jsonify({"error": f"调用失败: {e}"}), 500

    return jsonify({
        "ok": True,
        "audio_b64": base64.b64encode(resp.audio_data).decode("ascii"),
        "mime_type": _normalize_audio_mime_type(resp.mime_type),
        "format": resp.format,
    })
