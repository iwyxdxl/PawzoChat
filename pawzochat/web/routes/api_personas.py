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

"""REST API for persona CRUD and SillyTavern-compatible import/export."""

from __future__ import annotations

from copy import deepcopy
import io
import json
import logging
import os
import shutil
import uuid

from flask import Blueprint, jsonify, request, send_file
from PIL import Image

from pawzochat.core.config import DEFAULT_SYSTEM_INSTRUCTIONS
from pawzochat.image.reference import (
    CUSTOM_REFERENCE_FILENAME,
    delete_custom_reference_image,
    load_custom_reference_image,
    save_custom_reference_image,
)
from pawzochat.paths import CHATS_DIR
from pawzochat.services import bundle as bundle_mod
from pawzochat.services import card_parser, persona_card
from pawzochat.services.memory import auto_summary_enabled
from pawzochat.services.worldbook import validate_book_name
from pawzochat.transport.models import (
    PROACTIVE_DEFAULTS,
    normalize_image_generation,
    normalize_voice_generation,
)
from pawzochat.web.routes import download_response, get_app, safe_download_stem
from pawzochat.voice.settings import merge_voice_generation, validate_voice_generation

logger = logging.getLogger(__name__)

api_personas_bp = Blueprint("api_personas", __name__)

def _enroll_persona_in_moments(app, persona_id: str) -> None:
    """Append *persona_id* to ``moments.publishers`` and ``moments.repliers``.

    Called when a new persona is created/imported so that they appear in
    Moments by default. Idempotent — silently skipped if already enrolled.
    Caller must hold ``app.config.lock`` and call ``save()`` themselves.
    """
    moments_cfg = dict(app.config.get("moments", default={}) or {})
    pubs = list(moments_cfg.get("publishers", []) or [])
    reps = list(moments_cfg.get("repliers", []) or [])
    changed = False
    if persona_id not in pubs:
        pubs.append(persona_id)
        changed = True
    if persona_id not in reps:
        reps.append(persona_id)
        changed = True
    if not changed:
        return
    moments_cfg["publishers"] = pubs
    moments_cfg["repliers"] = reps
    app.config._data["moments"] = moments_cfg


def _unenroll_persona_from_moments(app, persona_id: str) -> None:
    """Strip *persona_id* from moments publishers/repliers/probabilities.

    Mirror of ``_enroll_persona_in_moments``. Caller must hold
    ``app.config.lock`` and call ``save()`` themselves.
    """
    moments_cfg = dict(app.config.get("moments", default={}) or {})
    pubs = [pid for pid in (moments_cfg.get("publishers") or []) if pid != persona_id]
    reps = [pid for pid in (moments_cfg.get("repliers") or []) if pid != persona_id]
    probs = dict(moments_cfg.get("reply_probabilities") or {})
    mem = dict(moments_cfg.get("memory_enabled") or {})
    probs.pop(persona_id, None)
    mem.pop(persona_id, None)
    moments_cfg["publishers"] = pubs
    moments_cfg["repliers"] = reps
    moments_cfg["reply_probabilities"] = probs
    moments_cfg["memory_enabled"] = mem
    app.config._data["moments"] = moments_cfg


def _validate_persona_name(name: str) -> str | None:
    """Return an error message if *name* is invalid, else None."""
    if not name:
        return "角色名称不能为空"
    if len(name) > 100:
        return "角色名称过长（最多 100 个字符）"
    return None


def _avatar_path(persona_id: str) -> str:
    return str(CHATS_DIR / persona_id / "avatar.png")


def _name_exists(personas_cfg: dict, name: str, *, exclude_id: str = "") -> bool:
    """Check whether a persona name is already taken."""
    for pid, pdata in personas_cfg.items():
        if pid == exclude_id:
            continue
        if pdata.get("name", "") == name:
            return True
    return False


def _validate_group_reads(app, persona_id: str, value) -> str | None:
    """Allow current sources and unchanged preferences for deleted archives."""
    if not isinstance(value, dict) or any(
        not isinstance(gid, str) or not gid or not isinstance(enabled, bool)
        for gid, enabled in value.items()
    ):
        return "group_reads 必须是群 ID 与布尔值组成的对象"
    service = getattr(app, "group_memory_service", None)
    saved = app.config.get("personas", default={}).get(persona_id, {}).get("memory", {}).get("group_reads", {})
    if not isinstance(saved, dict):
        saved = {}
    try:
        unknown_source = any(
            not (service is not None and service.has_source(gid, persona_id))
            and saved.get(gid) is not enabled
            for gid, enabled in value.items()
        )
    except ValueError:
        unknown_source = True
    if unknown_source:
        return "群记忆来源不存在或不属于当前角色"
    return None


# Long prompt fields persisted in data/prompts/<id>.json instead of config.yaml,
# so config stays an index for short metadata only and prompts are unbounded.
_IMAGE_PROMPT_KEYS = ("style_prefix", "art_style", "negative_prompt")


def _ig_metadata(ig: dict) -> dict:
    """Strip the long prompt fields from a full image_generation dict so the
    remainder is safe to store in config.yaml."""
    return {k: v for k, v in ig.items() if k not in _IMAGE_PROMPT_KEYS}


def _persist_image_prompts(app, persona_id: str, ig: dict) -> None:
    """Write the three image prompt fields from *ig* to the persona's prompt
    JSON file."""
    app.config.save_image_prompt_parts(
        persona_id,
        style_prefix=ig.get("style_prefix", ""),
        art_style=ig.get("art_style", ""),
        negative_prompt=ig.get("negative_prompt", ""),
    )


def _validate_image_generation(app, patch: dict) -> tuple[str | None, dict]:
    """Coerce + validate an ``image_generation`` block.

    Returns ``(error_msg_or_None, normalized_dict)``. An empty/disabled
    block can omit provider/model so users can save partial state.
    """
    normalized = normalize_image_generation(patch)
    provider = normalized["provider"].strip()
    model = normalized["model"].strip()
    if normalized["enabled"]:
        providers_cfg = app.config.get("image_providers", default={}) or {}
        if not provider or provider not in providers_cfg:
            return "请选择一个已配置的生图服务商", {}
        provider_cfg = providers_cfg.get(provider, {})
        if not provider_cfg.get("api_key"):
            return "请选择一个已填写 API Key 的生图服务商", {}
        models = provider_cfg.get("models") or []
        model_ids = {m.get("id", "") for m in models if isinstance(m, dict)}
        if not model or model not in model_ids:
            return "请选择该服务商下已配置的模型", {}
    normalized["provider"] = provider
    normalized["model"] = model
    return None, normalized


def _validate_voice_generation(app, patch: dict) -> tuple[str | None, dict]:
    """Coerce + validate a ``voice_generation`` block.

    Returns ``(error_msg_or_None, normalized_dict)``. An empty/disabled
    block can omit provider/model so users can save partial state.
    """
    error = validate_voice_generation(patch)
    if error:
        return error, {}
    normalized = normalize_voice_generation(patch)
    provider = normalized["provider"].strip()
    model = normalized["model"].strip()
    if normalized["enabled"]:
        providers_cfg = app.config.get("voice_providers", default={}) or {}
        if not provider or provider not in providers_cfg:
            return "请选择一个已配置的语音服务商", {}
        provider_cfg = providers_cfg.get(provider, {})
        if not provider_cfg.get("api_key"):
            return "请选择一个已填写 API Key 的语音服务商", {}
        models = provider_cfg.get("models") or []
        model_ids = {m.get("id", "") for m in models if isinstance(m, dict)}
        if not model or model not in model_ids:
            return "请选择该服务商下已配置的模型", {}
    normalized["provider"] = provider
    normalized["model"] = model
    return None, normalized


def _set_custom_reference_image(
    persona_id: str, cfg: dict, raw: bytes | None, *, activate: bool = True,
) -> None:
    """Persist or clear a reference image; imports keep the saved reference mode."""
    ig = normalize_image_generation(cfg.get("image_generation"))
    if raw is None:
        delete_custom_reference_image(persona_id)
        if ig["ref_mode"] == "custom":
            ig["ref_mode"] = "avatar"
        ig["custom_ref_filename"] = ""
    else:
        save_custom_reference_image(persona_id, raw)
        if activate:
            ig["ref_mode"] = "custom"
        ig["custom_ref_filename"] = CUSTOM_REFERENCE_FILENAME
    cfg["image_generation"] = _ig_metadata(ig)


@api_personas_bp.route("", methods=["GET"])
def list_personas():
    app = get_app()
    personas = app.config.load_personas()
    result = []
    for pid, p in personas.items():
        memory_data = app.memory_service.load_memories(pid)
        link = app.conversation_store.channel_link(pid) or {}
        result.append({
            "id": pid,
            "name": p.name,
            "llm_provider": p.llm_provider,
            "llm_model": p.llm_model,
            "temperature": p.temperature,
            "max_tokens": p.max_tokens,
            "emoji_enabled": p.emoji_enabled,
            "emoji_send_probability": p.emoji_send_probability,
            "emoji_group": p.emoji_group,
            "has_avatar": os.path.isfile(_avatar_path(pid)),
            "memory": p.memory,
            "memory_count": len(memory_data.get("memories", [])),
            "proactive": p.proactive,
            "image_generation": p.image_generation,
            "has_image_ref": load_custom_reference_image(pid, p.image_generation) is not None,
            "voice_generation": p.voice_generation,
            "wechat_chat_type": link.get("chat_type", "") if link else "",
            "linked_channel": link.get("channel", "") if link else "",
        })
    return jsonify({"personas": result})


@api_personas_bp.route("/<persona_id>", methods=["GET"])
def get_persona(persona_id: str):
    app = get_app()
    personas = app.config.load_personas()
    p = personas.get(persona_id)
    if p is None:
        return jsonify({"error": "Persona not found"}), 404
    memory_data = app.memory_service.load_memories(persona_id)
    link = app.conversation_store.channel_link(persona_id) or {}
    return jsonify({
        "id": p.id,
        "name": p.name,
        "llm_provider": p.llm_provider,
        "llm_model": p.llm_model,
        "temperature": p.temperature,
        "max_tokens": p.max_tokens,
        "character_prompt": p.character_prompt,
        "output_examples": p.output_examples,
        "system_instructions": p.system_instructions,
        "emoji_enabled": p.emoji_enabled,
        "emoji_send_probability": p.emoji_send_probability,
        "emoji_group": p.emoji_group,
        "has_avatar": os.path.isfile(_avatar_path(persona_id)),
        "memory": p.memory,
        "memory_count": len(memory_data.get("memories", [])),
        "proactive": p.proactive,
        "image_generation": p.image_generation,
        "has_image_ref": load_custom_reference_image(persona_id, p.image_generation) is not None,
        "voice_generation": p.voice_generation,
        "bound_worldbooks": p.bound_worldbooks,
        "wechat_chat_type": link.get("chat_type", "") if link else "",
        "linked_channel": link.get("channel", "") if link else "",
    })


@api_personas_bp.route("", methods=["POST"])
def create_persona():
    app = get_app()
    data = request.get_json(force=True)
    name = data.get("name", "").strip()

    err = _validate_persona_name(name)
    if err:
        return jsonify({"error": err}), 400
    mem_input = data.get("memory", {})
    if not isinstance(mem_input, dict):
        return jsonify({"error": "memory 必须是 JSON 对象"}), 400
    group_reads = mem_input.get("group_reads", {})
    if not isinstance(group_reads, dict) or group_reads:
        return jsonify({"error": "新角色尚无可配置的群记忆来源"}), 400

    with app.config.lock:
        personas_cfg = app.config.get("personas", default={})

        if _name_exists(personas_cfg, name):
            return jsonify({"error": f"角色名称「{name}」已存在"}), 409

        persona_id = uuid.uuid4().hex[:8]
        while persona_id in personas_cfg:
            persona_id = uuid.uuid4().hex[:8]

        ig_input = data.get("image_generation", {}) or {}
        ig_err, ig_cfg = _validate_image_generation(app, ig_input)
        if ig_err:
            return jsonify({"error": ig_err}), 400

        vg_input = data.get("voice_generation", {}) or {}
        vg_err, vg_cfg = _validate_voice_generation(app, vg_input)
        if vg_err:
            return jsonify({"error": vg_err}), 400

        system_instr = data.get("system_instructions", "")
        if not system_instr:
            system_instr = DEFAULT_SYSTEM_INSTRUCTIONS
        app.config.save_prompt_parts(
            persona_id,
            character_prompt=data.get("character_prompt", ""),
            output_examples=data.get("output_examples", ""),
            system_instructions=system_instr,
        )

        trigger_mode = mem_input.get("trigger_mode", "remind")
        if trigger_mode not in ("remind", "summarize", "summarize_only"):
            return jsonify({"error": "trigger_mode 必须是 remind、summarize 或 summarize_only"}), 400
        try:
            trigger_rounds = int(mem_input.get("trigger_rounds", 10))
            if trigger_rounds < 0:
                return jsonify({"error": "trigger_rounds 不能为负数"}), 400
            memory_cfg = {
                "enabled": bool(mem_input.get("enabled", True)),
                # Floor of 1: max_memories <= 0 makes the round-end
                # consolidation always fire, wasting an LLM call every round.
                "max_memories": max(1, int(mem_input.get("max_memories", 50))),
                "include_in_prompt": bool(mem_input.get("include_in_prompt", True)),
                "trigger_rounds": trigger_rounds,
                "trigger_mode": trigger_mode,
                "group_reads": {},
            }
        except (TypeError, ValueError):
            return jsonify({"error": "memory 配置字段类型无效"}), 400

        pro_input = data.get("proactive", {})
        qh_input = pro_input.get("quiet_hours", {}) if isinstance(pro_input, dict) else {}
        pro_defaults = PROACTIVE_DEFAULTS
        qh_defaults = pro_defaults["quiet_hours"]
        proactive_cfg = {
            "enabled": bool(pro_input.get("enabled", pro_defaults["enabled"])),
            "min_idle_hours": float(pro_input.get("min_idle_hours", pro_defaults["min_idle_hours"])),
            "max_idle_hours": float(pro_input.get("max_idle_hours", pro_defaults["max_idle_hours"])),
            "max_consecutive": int(pro_input.get("max_consecutive", pro_defaults["max_consecutive"])),
            "prompt": pro_input.get("prompt", pro_defaults["prompt"]),
            "quiet_hours": {
                "enabled": bool(qh_input.get("enabled", qh_defaults["enabled"])),
                "start": qh_input.get("start", qh_defaults["start"]),
                "end": qh_input.get("end", qh_defaults["end"]),
            },
        }

        bound_worldbooks_input = data.get("bound_worldbooks", [])
        if not isinstance(bound_worldbooks_input, list):
            bound_worldbooks_input = []

        _persist_image_prompts(app, persona_id, ig_cfg)

        personas_cfg[persona_id] = {
            "name": name,
            "llm_provider": data.get("llm_provider", ""),
            "llm_model": data.get("llm_model", ""),
            "temperature": float(data.get("temperature", 1.0)),
            "max_tokens": int(data.get("max_tokens", 2000)),
            "emoji_enabled": bool(data.get("emoji_enabled", False)),
            "emoji_send_probability": int(data.get("emoji_send_probability", 25)),
            "emoji_group": data.get("emoji_group", ""),
            "memory": memory_cfg,
            "proactive": proactive_cfg,
            "image_generation": _ig_metadata(ig_cfg),
            "voice_generation": vg_cfg,
            "bound_worldbooks": [str(n) for n in bound_worldbooks_input],
        }
        app.config._data["personas"] = personas_cfg

        _enroll_persona_in_moments(app, persona_id)

        app.config.save()
    return jsonify({"ok": True, "id": persona_id}), 201


@api_personas_bp.route("/<persona_id>", methods=["PUT"])
def update_persona(persona_id: str):
    app = get_app()
    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求内容必须是 JSON 对象"}), 400
    if persona_id not in app.config.get("personas", default={}):
        return jsonify({"error": "Persona not found"}), 404
    mem_patch = data.get("memory")
    if isinstance(mem_patch, dict) and "group_reads" in mem_patch:
        # Source lookup may take group/archive locks; do it before taking the
        # config lock, whose callers also include background group workers.
        error = _validate_group_reads(app, persona_id, mem_patch["group_reads"])
        if error:
            return jsonify({"error": error}), 400

    with app.config.lock:
        personas_cfg = app.config.get("personas", default={})

        if persona_id not in personas_cfg:
            return jsonify({"error": "Persona not found"}), 404

        # Validate the whole form before publishing any in-memory settings.
        # A later voice/image validation error must not change memory gates or
        # trigger parameters without notifying the group memory worker.
        cfg = deepcopy(personas_cfg[persona_id])
        old_name = cfg.get("name", "")

        new_name = data.get("name", "").strip() if "name" in data else old_name
        if new_name != old_name:
            err = _validate_persona_name(new_name)
            if err:
                return jsonify({"error": err}), 400
            if _name_exists(personas_cfg, new_name, exclude_id=persona_id):
                return jsonify({"error": f"角色名称「{new_name}」已存在"}), 409

        if "name" in data:
            cfg["name"] = new_name
        if "llm_provider" in data:
            cfg["llm_provider"] = data["llm_provider"]
        if "llm_model" in data:
            cfg["llm_model"] = data["llm_model"]
        if "temperature" in data:
            cfg["temperature"] = float(data["temperature"])
        if "max_tokens" in data:
            cfg["max_tokens"] = int(data["max_tokens"])
        if "emoji_enabled" in data:
            cfg["emoji_enabled"] = bool(data["emoji_enabled"])
        if "emoji_send_probability" in data:
            cfg["emoji_send_probability"] = int(data["emoji_send_probability"])
        if "emoji_group" in data:
            cfg["emoji_group"] = data["emoji_group"]

        summarize_activated = False
        group_memory_settings_changed = False
        if "memory" in data:
            mem_patch = data["memory"]
            if not isinstance(mem_patch, dict):
                return jsonify({"error": "memory 必须是 JSON 对象"}), 400
            existing_mem = dict(cfg.get("memory", {}))
            previous_mem = dict(existing_mem)
            old_summarize = auto_summary_enabled(existing_mem)
            if "enabled" in mem_patch:
                existing_mem["enabled"] = bool(mem_patch["enabled"])
            if "max_memories" in mem_patch:
                try:
                    existing_mem["max_memories"] = max(1, int(mem_patch["max_memories"]))
                except (TypeError, ValueError):
                    return jsonify({"error": "max_memories 必须是整数"}), 400
            if "include_in_prompt" in mem_patch:
                existing_mem["include_in_prompt"] = bool(mem_patch["include_in_prompt"])
            if "trigger_rounds" in mem_patch:
                try:
                    trigger_rounds = int(mem_patch["trigger_rounds"])
                except (TypeError, ValueError):
                    return jsonify({"error": "trigger_rounds 必须是整数"}), 400
                if trigger_rounds < 0:
                    return jsonify({"error": "trigger_rounds 不能为负数"}), 400
                existing_mem["trigger_rounds"] = trigger_rounds
            if "trigger_mode" in mem_patch:
                if mem_patch["trigger_mode"] not in ("remind", "summarize", "summarize_only"):
                    return jsonify({"error": "trigger_mode 必须是 remind、summarize 或 summarize_only"}), 400
                existing_mem["trigger_mode"] = mem_patch["trigger_mode"]
            if "group_reads" in mem_patch:
                previous_reads = existing_mem.get("group_reads", {})
                existing_mem["group_reads"] = {
                    **(previous_reads if isinstance(previous_reads, dict) else {}),
                    **mem_patch["group_reads"],
                }
            group_memory_settings_changed = any(
                previous_mem.get(key, default) != existing_mem.get(key, default)
                for key, default in (("trigger_mode", "remind"), ("trigger_rounds", 10),
                                     ("max_memories", 50))
            )
            cfg["memory"] = existing_mem
            # Auto-summarization newly became effective (enabled/trigger_rounds/
            # trigger_mode turned it on). Reset the summary cursor to the
            # conversation's newest message so the very first summary does not
            # swallow the whole pre-existing history at once. Done after the
            # config is saved, best-effort: a failure must not fail the request.
            summarize_activated = (
                not old_summarize and auto_summary_enabled(existing_mem)
            )

        if "proactive" in data:
            pro_patch = data["proactive"]
            existing_pro = cfg.get("proactive", {})
            if "enabled" in pro_patch:
                existing_pro["enabled"] = bool(pro_patch["enabled"])
            if "min_idle_hours" in pro_patch:
                existing_pro["min_idle_hours"] = float(pro_patch["min_idle_hours"])
            if "max_idle_hours" in pro_patch:
                existing_pro["max_idle_hours"] = float(pro_patch["max_idle_hours"])
            if "max_consecutive" in pro_patch:
                existing_pro["max_consecutive"] = int(pro_patch["max_consecutive"])
            if "prompt" in pro_patch:
                existing_pro["prompt"] = pro_patch["prompt"]
            if "quiet_hours" in pro_patch:
                qh_patch = pro_patch["quiet_hours"] or {}
                existing_qh = existing_pro.get("quiet_hours", {})
                if "enabled" in qh_patch:
                    existing_qh["enabled"] = bool(qh_patch["enabled"])
                if "start" in qh_patch:
                    existing_qh["start"] = qh_patch["start"]
                if "end" in qh_patch:
                    existing_qh["end"] = qh_patch["end"]
                existing_pro["quiet_hours"] = existing_qh
            cfg["proactive"] = existing_pro

        # voice_generation is validated before image_generation: once the image
        # branch passes validation it immediately persists the prompt fields
        # (_persist_image_prompts). If voice validation failed afterward and
        # returned 400, it would leave a "partially saved" inconsistent state.
        if "voice_generation" in data:
            vg_patch = data["voice_generation"] or {}
            merged_vg = merge_voice_generation(cfg.get("voice_generation"), vg_patch)
            vg_err, vg_cfg = _validate_voice_generation(app, merged_vg)
            if vg_err:
                return jsonify({"error": vg_err}), 400
            cfg["voice_generation"] = vg_cfg

        if "image_generation" in data:
            ig_patch = data["image_generation"] or {}
            existing_ig = dict(cfg.get("image_generation") or {})
            existing_ig.update(app.config._load_image_prompt_overrides(persona_id))
            merged_ig = normalize_image_generation(existing_ig)
            if isinstance(ig_patch, dict):
                for key in (
                    "enabled",
                    "provider",
                    "model",
                    "style_prefix",
                    "art_style",
                    "negative_prompt",
                    "negative_enabled",
                    "ref_mode",
                    "custom_ref_filename",
                ):
                    if key in ig_patch:
                        merged_ig[key] = ig_patch[key]
            ig_err, ig_cfg = _validate_image_generation(app, merged_ig)
            if ig_err:
                return jsonify({"error": ig_err}), 400
            _persist_image_prompts(app, persona_id, ig_cfg)
            cfg["image_generation"] = _ig_metadata(ig_cfg)

        if "bound_worldbooks" in data:
            bwb = data["bound_worldbooks"]
            if not isinstance(bwb, list):
                bwb = []
            cfg["bound_worldbooks"] = [str(n) for n in bwb]

        prompt_fields = ("character_prompt", "output_examples", "system_instructions")
        if any(k in data for k in prompt_fields):
            cur_c, cur_e, cur_s = app.config._load_prompt_parts(persona_id)
            app.config.save_prompt_parts(
                persona_id,
                character_prompt=data.get("character_prompt", cur_c),
                output_examples=data.get("output_examples", cur_e),
                system_instructions=data.get("system_instructions", cur_s),
            )

        personas_cfg[persona_id] = cfg
        app.config._data["personas"] = personas_cfg
        app.config.save()

    # Reset the auto-summary cursor after the config is safely persisted.
    # The reset only reads/writes memory.json and the conversation store, which
    # are unrelated to the config lock, so it must not run inside it.
    if summarize_activated and app.memory_service:
        try:
            app.memory_service.reset_summary_cursor(persona_id)
        except Exception:
            logger.warning("重置总结游标失败 persona=%s", persona_id, exc_info=True)
    if group_memory_settings_changed:
        service = getattr(app, "group_memory_service", None)
        if service is not None:
            try:
                service.settings_changed(persona_id)
            except Exception:
                logger.warning("更新群记忆设置失败 persona=%s", persona_id, exc_info=True)
    return jsonify({"ok": True})


@api_personas_bp.route("/<persona_id>", methods=["DELETE"])
def delete_persona(persona_id: str):
    app = get_app()
    delete_conv = request.args.get("delete_conversation", "").lower() == "true"
    group_memory = getattr(app, "group_memory_service", None)

    with app.config.lock:
        personas_cfg = app.config.get("personas", default={})

        if persona_id not in personas_cfg:
            if group_memory is None or not group_memory.persona_deletion_pending(persona_id):
                return jsonify({"error": "Persona not found"}), 404
        else:
            previous = deepcopy(app.config._data)
            try:
                # No group locks here: the intent survives a crash after the
                # config deletion, while group cleanup runs outside this lock.
                if group_memory is not None:
                    group_memory.begin_persona_deletion(persona_id)
                del personas_cfg[persona_id]
                app.config._data["personas"] = personas_cfg
                _unenroll_persona_from_moments(app, persona_id)
                app.config.save()
            except OSError:
                app.config._data = previous
                logger.exception("删除角色配置失败 persona=%s", persona_id)
                return jsonify({"error": "角色删除失败，请检查存储后重试。"}), 503

    cleanup_failed = False
    try:
        app.config.prompt_path(persona_id).unlink(missing_ok=True)
    except OSError:
        cleanup_failed = True
        logger.exception("清理角色人设失败 persona=%s", persona_id)

    group_service = getattr(app, "group_chat_service", None)
    try:
        if group_service is not None:
            group_service.remove_persona(persona_id)
    except Exception:
        cleanup_failed = True
        logger.exception("清理角色群成员配置失败 persona=%s", persona_id)
    try:
        if group_memory is not None:
            group_memory.finish_persona_deletion(persona_id)
    except OSError:
        cleanup_failed = True
        logger.exception("清理角色群记忆失败 persona=%s", persona_id)

    # Clean up all moments and replies from this persona.
    try:
        app.moments_service.delete_moments_by_author(persona_id)
    except Exception:
        logger.exception("清理角色朋友圈数据失败 persona=%s", persona_id)

    if delete_conv:
        app.conversation_store.delete_conversation(persona_id)

    if cleanup_failed:
        return jsonify({"error": "角色已删除，部分数据清理未完成，请检查存储后重试；未完成的群记忆清理将在重启时继续。"}), 503
    return jsonify({"ok": True})


@api_personas_bp.route("/default-system-instructions", methods=["GET"])
def get_default_system_instructions():
    return jsonify({"text": DEFAULT_SYSTEM_INSTRUCTIONS})


def _save_avatar_from_image(persona_id: str, img: Image.Image) -> None:
    """Crop to a centered square, resize to 256×256, save as the persona avatar."""
    img = img.convert("RGBA")
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    img = img.resize((256, 256), Image.LANCZOS)

    dest = _avatar_path(persona_id)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    img.save(dest, "PNG")


def _save_avatar_from_bytes(persona_id: str, raw: bytes) -> bool:
    """Load *raw* as an image and save it as the persona avatar. Returns success."""
    try:
        with Image.open(io.BytesIO(raw)) as img:
            _save_avatar_from_image(persona_id, img)
        return True
    except Exception as exc:
        logger.warning("头像处理失败（persona=%s）: %s", persona_id, exc)
        return False


@api_personas_bp.route("/<persona_id>/avatar", methods=["POST"])
def upload_avatar(persona_id: str):
    app = get_app()
    personas_cfg = app.config.get("personas", default={})
    if persona_id not in personas_cfg:
        return jsonify({"error": "Persona not found"}), 404

    f = request.files.get("avatar")
    if not f:
        return jsonify({"error": "No file uploaded"}), 400

    try:
        img = Image.open(f.stream)
    except Exception:
        return jsonify({"error": "Invalid image"}), 400

    _save_avatar_from_image(persona_id, img)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Custom reference image (image_ref)
# ---------------------------------------------------------------------------

@api_personas_bp.route("/<persona_id>/image_ref", methods=["POST"])
def upload_image_ref(persona_id: str):
    """Upload a custom appearance reference image and bind it to the persona."""
    app = get_app()
    with app.config.lock:
        personas_cfg = app.config.get("personas", default={})
        if persona_id not in personas_cfg:
            return jsonify({"error": "Persona not found"}), 404

        f = request.files.get("image")
        if not f:
            return jsonify({"error": "No file uploaded"}), 400

        raw = f.read()
        try:
            with Image.open(io.BytesIO(raw)) as img:
                img.load()
        except Exception:
            return jsonify({"error": "Invalid image"}), 400

        cfg = personas_cfg[persona_id]
        _set_custom_reference_image(persona_id, cfg, raw)
        app.config._data["personas"] = personas_cfg
        app.config.save()

    return jsonify({"ok": True, "filename": CUSTOM_REFERENCE_FILENAME})


@api_personas_bp.route("/<persona_id>/image_ref", methods=["GET"])
def get_image_ref(persona_id: str):
    app = get_app()
    personas_cfg = app.config.get("personas", default={})
    if persona_id not in personas_cfg:
        return jsonify({"error": "Persona not found"}), 404

    cfg = personas_cfg[persona_id]
    ref = load_custom_reference_image(persona_id, cfg.get("image_generation"))
    if ref is None:
        return jsonify({"error": "No reference image"}), 404

    raw, mime = ref
    return send_file(io.BytesIO(raw), mimetype=mime)


@api_personas_bp.route("/<persona_id>/image_ref", methods=["DELETE"])
def delete_image_ref(persona_id: str):
    app = get_app()
    with app.config.lock:
        personas_cfg = app.config.get("personas", default={})
        if persona_id not in personas_cfg:
            return jsonify({"error": "Persona not found"}), 404

        cfg = personas_cfg[persona_id]
        _set_custom_reference_image(persona_id, cfg, None)
        app.config._data["personas"] = personas_cfg
        app.config.save()

    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Import / Export
# ---------------------------------------------------------------------------

def _unique_persona_name(personas_cfg: dict, name: str) -> str:
    """Append ``_2``, ``_3``, … until the name is unused."""
    if not _name_exists(personas_cfg, name):
        return name
    i = 2
    while _name_exists(personas_cfg, f"{name}_{i}"):
        i += 1
    return f"{name}_{i}"


def _new_persona_id(personas_cfg: dict) -> str:
    pid = uuid.uuid4().hex[:8]
    while pid in personas_cfg:
        pid = uuid.uuid4().hex[:8]
    return pid


def _make_default_avatar_png() -> bytes:
    """Build a neutral 256×256 PNG used when a persona has no avatar."""
    img = Image.new("RGBA", (256, 256), (229, 231, 235, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _persona_config_from_card_result(
    result: persona_card.PersonaImportResult,
    name: str,
) -> dict:
    """Assemble the config.yaml persona dict from a card-import result."""
    memory = result.memory or {
        "enabled": True, "max_memories": 50, "include_in_prompt": True,
        "trigger_rounds": 10, "trigger_mode": "remind",
    }
    d = PROACTIVE_DEFAULTS
    qd = d["quiet_hours"]
    proactive = result.proactive or {
        "enabled": d["enabled"],
        "min_idle_hours": d["min_idle_hours"],
        "max_idle_hours": d["max_idle_hours"],
        "max_consecutive": d["max_consecutive"],
        "prompt": d["prompt"],
        "quiet_hours": {"enabled": qd["enabled"], "start": qd["start"], "end": qd["end"]},
    }
    image_generation = normalize_image_generation(result.image_generation)
    if result.reference_image_png is not None:
        image_generation["custom_ref_filename"] = CUSTOM_REFERENCE_FILENAME
    return {
        "name": name,
        "llm_provider": result.llm_provider,
        "llm_model": result.llm_model,
        "temperature": float(result.temperature),
        "max_tokens": int(result.max_tokens),
        "emoji_enabled": bool(result.emoji_enabled),
        "emoji_send_probability": int(result.emoji_send_probability),
        "emoji_group": result.emoji_group,
        "memory": memory,
        "proactive": proactive,
        "tool_policy": result.tool_policy or {
            "mode": "all", "list": [], "max_iterations": 10, "timeout_seconds": 30,
        },
        "image_generation": image_generation,
        "voice_generation": normalize_voice_generation(result.voice_generation),
        "bound_worldbooks": [],
    }


def _import_book(app, book: dict, fallback_name: str) -> tuple[str | None, str | None]:
    """Persist a worldbook import, returning ``(saved_name, error)``.

    Handles name conflicts by appending ``_2`` / ``_3`` and substitutes a
    sanitised fallback when the source name is empty or invalid.
    """
    raw_name = str(book.get("name") or "").strip() or fallback_name
    if validate_book_name(raw_name):
        raw_name = fallback_name
    if validate_book_name(raw_name):
        return None, f"世界书名称「{raw_name}」非法"

    final = raw_name
    i = 2
    while app.worldbook_service.get_book(final) is not None:
        final = f"{raw_name}_{i}"
        i += 1

    try:
        app.worldbook_service.save_book(
            final,
            scope=book.get("scope", {"range": "selected", "keyword_filter": False}),
            keywords=book.get("keywords", []),
            content=book.get("content", {}),
            extras=book.get("extras"),
            section_meta=book.get("section_meta"),
        )
    except ValueError as exc:
        return None, str(exc)
    return final, None


@api_personas_bp.route("/_import", methods=["POST"])
def import_persona():
    """Import a persona from SillyTavern PNG/JSON or PawzoChat ``.ppack``.

    Multipart form fields:
      - ``file`` (required): PNG/JSON/ZIP upload.
      - ``include_worldbook`` (optional, default "true"): whether to create
        and bind any embedded ``character_book`` / bundled worldbooks.
      - ``persona_name`` (optional): override the name from the card.
    """
    app = get_app()
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "未选择文件"}), 400

    include_books = request.form.get("include_worldbook", "true").lower() != "false"
    override_name = (request.form.get("persona_name") or "").strip()

    raw = f.read()
    fmt = card_parser.detect_format(raw, f.filename or "")

    warnings: list[str] = []
    avatar_bytes: bytes | None = None
    reference_image_png: bytes | None = None
    import_books: list[dict] = []
    persona_cfg: dict = {}
    character_prompt = ""
    output_examples = ""
    system_instructions = ""

    try:
        if fmt == "png_card":
            card = card_parser.read_png_card(raw)
            if not card:
                return jsonify({"error": "PNG 内未检测到角色卡数据"}), 400
            result = persona_card.card_to_persona(card)
            warnings = list(result.warnings)
            avatar_bytes = raw
            reference_image_png = result.reference_image_png
            character_prompt = result.character_prompt
            output_examples = result.output_examples
            system_instructions = result.system_instructions
            final_name = override_name or result.name
            persona_cfg = _persona_config_from_card_result(result, final_name)
            if include_books and result.embedded_book:
                book = persona_card.character_book_to_worldbook(
                    result.embedded_book, fallback_name=final_name,
                )
                import_books.append(book)

        elif fmt == "json_card":
            card = card_parser.parse_json_card(raw)
            result = persona_card.card_to_persona(card)
            warnings = list(result.warnings)
            reference_image_png = result.reference_image_png
            character_prompt = result.character_prompt
            output_examples = result.output_examples
            system_instructions = result.system_instructions
            final_name = override_name or result.name
            persona_cfg = _persona_config_from_card_result(result, final_name)
            if include_books and result.embedded_book:
                book = persona_card.character_book_to_worldbook(
                    result.embedded_book, fallback_name=final_name,
                )
                import_books.append(book)

        elif fmt == "pawzo_bundle":
            result = bundle_mod.unpack_persona(raw)
            warnings = list(result.warnings)
            avatar_bytes = result.avatar_png
            reference_image_png = result.reference_image_png
            character_prompt = result.character_prompt
            output_examples = result.output_examples
            system_instructions = result.system_instructions
            final_name = override_name or result.name
            cfg = dict(result.persona_config)
            cfg["name"] = final_name
            # Drop bindings until books are imported and their final names known.
            cfg["bound_worldbooks"] = []
            persona_cfg = cfg
            if include_books:
                import_books = list(result.books)

        else:
            return jsonify({"error": "无法识别的文件格式（仅支持 PNG/JSON/ZIP 角色包）"}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    err = _validate_persona_name(final_name)
    if err:
        return jsonify({"error": err}), 400

    # --- Write phase (transactional-ish) -----------------------------------
    created_persona_dir = False
    persona_id = ""
    created_books: list[dict] = []
    try:
        with app.config.lock:
            personas_cfg = app.config.get("personas", default={})
            final_name = _unique_persona_name(personas_cfg, final_name)
            persona_cfg["name"] = final_name
            persona_id = _new_persona_id(personas_cfg)

            # Prompt file (chat sections)
            app.config.save_prompt_parts(
                persona_id,
                character_prompt=character_prompt,
                output_examples=output_examples,
                system_instructions=(
                    system_instructions if result.has_system_instructions
                    else DEFAULT_SYSTEM_INSTRUCTIONS
                ),
            )
            created_persona_dir = True

            # Image prompt sections live in the same prompt file; metadata stays in yaml.
            ig_raw = persona_cfg.get("image_generation")
            ig_raw = ig_raw if isinstance(ig_raw, dict) else {}
            ig_full = normalize_image_generation(ig_raw)
            if reference_image_png is not None and "ref_mode" not in ig_raw:
                ig_full["ref_mode"] = "custom"
            _persist_image_prompts(app, persona_id, ig_full)
            persona_cfg["image_generation"] = _ig_metadata(ig_full)

            # Avatar
            if avatar_bytes and _save_avatar_from_bytes(persona_id, avatar_bytes):
                created_persona_dir = True

            if reference_image_png is not None:
                _set_custom_reference_image(persona_id, persona_cfg, reference_image_png, activate=False)
                created_persona_dir = True

            # Books — create and remember the (possibly renamed) final names.
            saved_book_names: list[str] = []
            for book in import_books:
                saved, berr = _import_book(app, book, fallback_name=final_name)
                if berr:
                    warnings.append(berr)
                    continue
                saved_book_names.append(saved)
                created_books.append({"name": saved, "original_name": book.get("name", "")})

            persona_cfg["bound_worldbooks"] = saved_book_names
            personas_cfg[persona_id] = persona_cfg
            app.config._data["personas"] = personas_cfg
            _enroll_persona_in_moments(app, persona_id)
            app.config.save()
    except Exception as exc:
        logger.exception("角色导入失败")
        # Best-effort rollback: remove anything we managed to write before the
        # failure, so a retry starts from a clean slate instead of accumulating
        # _2/_3 suffix duplicates.
        prompt_path = app.config.prompt_path(persona_id) if persona_id else None
        if prompt_path and prompt_path.is_file():
            try:
                prompt_path.unlink()
            except OSError:
                pass
        if created_persona_dir and persona_id:
            try:
                shutil.rmtree(CHATS_DIR / persona_id, ignore_errors=True)
            except OSError:
                pass
        for created in created_books:
            try:
                app.worldbook_service.delete_book(created["name"])
            except Exception as cleanup_exc:  # noqa: BLE001 — best-effort cleanup
                logger.warning("回滚世界书失败 %s: %s", created.get("name"), cleanup_exc)
        return jsonify({"error": f"导入失败: {exc}"}), 500

    return jsonify({
        "ok": True,
        "id": persona_id,
        "name": final_name,
        "warnings": warnings,
        "created_worldbooks": created_books,
    }), 201


@api_personas_bp.route("/<persona_id>/_export", methods=["GET", "POST"])
def export_persona(persona_id: str):
    """Download a persona as PNG/JSON/bundle.

    GET: uses the persona's saved avatar (or a neutral fallback) as the PNG
    container. POST (multipart): an optional ``avatar`` file overrides the
    container image for that one export — useful when the user wants a
    different cover for the shared card without changing the in-app avatar.

    Query/form params: ``format`` (png | json_v3 | bundle),
    ``include_books`` (1 | 0).
    """
    app = get_app()
    personas = app.config.load_personas()
    persona = personas.get(persona_id)
    if persona is None:
        return jsonify({"error": "Persona not found"}), 404

    # Accept params from query string (GET) or form (POST).
    def _param(key: str, default: str = "") -> str:
        val = request.args.get(key)
        if val is None:
            val = request.form.get(key, default)
        return val

    fmt = (_param("format") or "png").lower()
    include_books = _param("include_books", "1").lower() not in ("0", "false", "")

    bound_books: list[dict] = []
    if include_books:
        for bname in persona.bound_worldbooks or []:
            try:
                b = app.worldbook_service.get_book(bname)
            except ValueError:
                b = None
            if b:
                bound_books.append(b)

    safe_stem = safe_download_stem(persona.name) or persona_id
    reference_image = load_custom_reference_image(persona_id, persona.image_generation)
    reference_image_png = reference_image[0] if reference_image else None

    if fmt in ("png", "png_v3"):
        card = persona_card.persona_to_card(
            persona,
            bound_books=bound_books,
            reference_image_png=reference_image_png,
        )
        uploaded = request.files.get("avatar") if request.method == "POST" else None
        if uploaded:
            try:
                raw = uploaded.read()
                with Image.open(io.BytesIO(raw)) as img:
                    img = img.convert("RGBA")
                    w, h = img.size
                    side = min(w, h)
                    left = (w - side) // 2
                    top = (h - side) // 2
                    img = img.crop((left, top, left + side, top + side))
                    img = img.resize((256, 256), Image.LANCZOS)
                    out = io.BytesIO()
                    img.save(out, "PNG")
                    base_png = out.getvalue()
            except Exception as exc:
                return jsonify({"error": f"自定义封面处理失败: {exc}"}), 400
        else:
            avatar_path = _avatar_path(persona_id)
            if os.path.isfile(avatar_path):
                with open(avatar_path, "rb") as fp:
                    base_png = fp.read()
            else:
                base_png = _make_default_avatar_png()
        try:
            out = card_parser.write_png_card(base_png, card)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 500
        return download_response(
            out, "image/png", f"{safe_stem}.png", fallback_stem=persona_id,
        )

    if fmt in ("json", "json_v3"):
        card = persona_card.persona_to_card(
            persona,
            bound_books=bound_books,
            reference_image_png=reference_image_png,
        )
        body = json.dumps(card, ensure_ascii=False, indent=2).encode("utf-8")
        return download_response(
            body, "application/json", f"{safe_stem}.v3.json",
            fallback_stem=persona_id,
        )

    if fmt == "bundle":
        avatar_path = _avatar_path(persona_id)
        avatar_bytes = None
        if os.path.isfile(avatar_path):
            with open(avatar_path, "rb") as fp:
                avatar_bytes = fp.read()
        body = bundle_mod.pack_persona(
            persona,
            avatar_png=avatar_bytes,
            reference_image_png=reference_image_png,
            bound_books=bound_books if include_books else [],
        )
        return download_response(
            body, "application/zip", f"{safe_stem}.ppack.zip",
            fallback_stem=persona_id,
        )

    return jsonify({"error": f"未知导出格式: {fmt}"}), 400
