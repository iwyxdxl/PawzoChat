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

"""REST API for LLM provider management."""

from __future__ import annotations

import re

import requests as http_requests
from flask import Blueprint, jsonify, request

from pawzochat.llm.manager import (
    PRESET_MODELS,
    PROVIDER_PRESETS,
    ensure_models_list,
)
from pawzochat.web.routes import get_app

api_providers_bp = Blueprint("api_providers", __name__)

_NAME_RE = re.compile(r'^[a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff_\-]*$')


def _validate_provider_name(name: str) -> str | None:
    if not name:
        return "名称不能为空"
    if len(name) > 30:
        return "名称不能超过 30 个字符"
    if not _NAME_RE.match(name):
        return "名称只能包含字母、数字、中文、下划线和连字符，且不能以符号开头"
    return None


def _reinit_llm(app):
    app.llm_manager._providers.clear()
    app.llm_manager.init_from_config(app.config.get("llm_providers", default={}))


def _provider_summary(name: str, cfg: dict) -> dict:
    """Build a JSON-safe summary dict for one provider entry."""
    preset = cfg.get("preset", "custom")
    preset_info = PROVIDER_PRESETS.get(preset) if preset != "custom" else None

    if preset_info:
        ptype = preset_info["type"]
        base_url = preset_info["base_url"]
    else:
        ptype = cfg.get("type", "openai_compatible")
        base_url = cfg.get("base_url", "")

    append_field = "append_responses_path" if ptype == "openai_responses" else "append_chat_path"
    return {
        "name": name,
        "preset": preset,
        "type": ptype,
        "base_url": base_url,
        "api_key_set": bool(cfg.get("api_key", "")),
        append_field: cfg.get(append_field, True),
        "models": ensure_models_list(cfg),
    }


@api_providers_bp.route("", methods=["GET"])
def list_providers():
    app = get_app()
    providers_cfg = app.config.get("llm_providers", default={})
    result = [_provider_summary(name, cfg) for name, cfg in providers_cfg.items()]

    presets_out = {
        pid: {
            "name": p["name"],
            "default_name": p.get("default_name", p["name"]),
            "base_url": p["base_url"],
            "type": p["type"],
            "endpoint_path": p["endpoint_path"],
        }
        for pid, p in PROVIDER_PRESETS.items()
    }
    return jsonify({
        "providers": result,
        "presets": presets_out,
        "preset_models": PRESET_MODELS,
    })


@api_providers_bp.route("", methods=["POST"])
def create_provider():
    app = get_app()
    data = request.get_json(force=True)
    name = data.get("name", "").strip()

    err = _validate_provider_name(name)
    if err:
        return jsonify({"error": err}), 400

    providers = app.config._data.setdefault("llm_providers", {})
    if name in providers:
        return jsonify({"error": f"Provider '{name}' already exists"}), 409

    preset = data.get("preset", "custom")
    entry: dict = {"preset": preset}

    if preset == "custom":
        entry["type"] = data.get("type", "openai_compatible")
        entry["base_url"] = data.get("base_url", "")
        append_field = "append_responses_path" if entry["type"] == "openai_responses" else "append_chat_path"
        entry[append_field] = data.get(append_field, True)

    entry["api_key"] = data.get("api_key", "")
    entry["models"] = data.get("models", ensure_models_list(entry))

    providers[name] = entry
    app.config.save()
    _reinit_llm(app)
    return jsonify({"ok": True}), 201


@api_providers_bp.route("/<name>", methods=["PUT"])
def update_provider(name: str):
    app = get_app()
    providers = app.config._data.get("llm_providers", {})
    if name not in providers:
        return jsonify({"error": "Provider not found"}), 404

    data = request.get_json(force=True)
    new_name = data.get("name", "").strip() if "name" in data else name

    if new_name != name:
        err = _validate_provider_name(new_name)
        if err:
            return jsonify({"error": err}), 400
        if new_name in providers:
            return jsonify({"error": f"对话服务商名称「{new_name}」已存在"}), 409

    preset = data.get("preset", providers[name].get("preset", "custom"))
    entry: dict = {"preset": preset}

    if preset == "custom":
        entry["type"] = data.get("type", providers[name].get("type", "openai_compatible"))
        entry["base_url"] = data.get("base_url", providers[name].get("base_url", ""))
        append_field = "append_responses_path" if entry["type"] == "openai_responses" else "append_chat_path"
        entry[append_field] = data.get(append_field, providers[name].get(append_field, True))

    if data.get("api_key"):
        entry["api_key"] = data["api_key"]
    else:
        entry["api_key"] = providers[name].get("api_key", "")

    if "models" in data:
        entry["models"] = data["models"]
    else:
        entry["models"] = providers[name].get("models", ensure_models_list(entry))

    if new_name != name:
        del providers[name]
        for pcfg in app.config._data.get("personas", {}).values():
            if pcfg.get("llm_provider") == name:
                pcfg["llm_provider"] = new_name

    providers[new_name] = entry
    app.config.save()
    _reinit_llm(app)
    return jsonify({"ok": True})


@api_providers_bp.route("/<name>", methods=["DELETE"])
def delete_provider(name: str):
    app = get_app()
    providers = app.config._data.get("llm_providers", {})
    if name not in providers:
        return jsonify({"error": "Provider not found"}), 404

    del providers[name]
    app.config.save()
    _reinit_llm(app)
    return jsonify({"ok": True})


# ---- Model CRUD under a provider ----------------------------------------

@api_providers_bp.route("/<name>/models", methods=["POST"])
def add_model(name: str):
    app = get_app()
    providers = app.config._data.get("llm_providers", {})
    if name not in providers:
        return jsonify({"error": "Provider not found"}), 404

    data = request.get_json(force=True)
    model_id = data.get("id", "").strip()
    if not model_id:
        return jsonify({"error": "模型 ID 不能为空"}), 400

    models = providers[name].setdefault("models", ensure_models_list(providers[name]))
    if any(m["id"] == model_id for m in models):
        return jsonify({"error": f"模型 '{model_id}' 已存在"}), 409

    models.append({
        "id": model_id,
        "name": data.get("name", model_id),
        "capabilities": list(data.get("capabilities", [])),
        "context_window": data.get("context_window"),
        "max_output": data.get("max_output"),
    })
    app.config.save()
    _reinit_llm(app)
    return jsonify({"ok": True}), 201


@api_providers_bp.route("/<name>/models/<model_id>", methods=["PUT"])
def update_model(name: str, model_id: str):
    app = get_app()
    providers = app.config._data.get("llm_providers", {})
    if name not in providers:
        return jsonify({"error": "Provider not found"}), 404

    models = providers[name].setdefault("models", ensure_models_list(providers[name]))
    target = None
    for m in models:
        if m["id"] == model_id:
            target = m
            break
    if target is None:
        return jsonify({"error": "Model not found"}), 404

    data = request.get_json(force=True)
    if "name" in data:
        target["name"] = data["name"]
    if "capabilities" in data:
        target["capabilities"] = list(data["capabilities"])
    if "context_window" in data:
        target["context_window"] = data["context_window"]
    if "max_output" in data:
        target["max_output"] = data["max_output"]

    app.config.save()
    _reinit_llm(app)
    return jsonify({"ok": True})


@api_providers_bp.route("/<name>/models/<model_id>", methods=["DELETE"])
def delete_model(name: str, model_id: str):
    app = get_app()
    providers = app.config._data.get("llm_providers", {})
    if name not in providers:
        return jsonify({"error": "Provider not found"}), 404

    models = providers[name].get("models", [])
    new_models = [m for m in models if m["id"] != model_id]
    if len(new_models) == len(models):
        return jsonify({"error": "Model not found"}), 404

    providers[name]["models"] = new_models
    app.config.save()
    _reinit_llm(app)
    return jsonify({"ok": True})


# ---- Fetch remote models (proxy) -----------------------------------------

@api_providers_bp.route("/_fetch-models", methods=["POST"])
def fetch_remote_models():
    """Proxy endpoint to fetch model list from an OpenAI-compatible API."""
    app = get_app()
    data = request.get_json(force=True)
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "URL 不能为空"}), 400

    api_key = data.get("api_key") or ""
    provider_name = data.get("provider_name") or ""
    if not api_key and provider_name:
        providers = app.config._data.get("llm_providers", {})
        if provider_name in providers:
            api_key = providers[provider_name].get("api_key", "")

    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        resp = http_requests.get(url, headers=headers, timeout=15)
    except http_requests.exceptions.Timeout:
        return jsonify({"error": "请求超时"}), 504
    except http_requests.exceptions.ConnectionError:
        return jsonify({"error": "连接失败，请检查 URL"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    if resp.status_code != 200:
        return jsonify({"error": f"远端返回 HTTP {resp.status_code}"}), 502

    try:
        body = resp.json()
    except Exception:
        return jsonify({"error": "返回数据格式无效"}), 502

    raw = body.get("data") if isinstance(body, dict) else body
    if not isinstance(raw, list):
        return jsonify({"error": "返回数据格式无效"}), 502

    models = [{"id": m["id"], "name": m.get("id", "")}
              for m in raw if isinstance(m, dict) and m.get("id")]
    return jsonify({"models": models})
