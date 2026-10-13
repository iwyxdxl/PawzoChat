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

"""REST API for private and per-group persona memory CRUD."""

from __future__ import annotations

import logging
import re

from flask import Blueprint, jsonify, request

from pawzochat.services.memory import DuplicateMemoryError, MemoryConflictError
from pawzochat.web.routes import get_app

api_memory_bp = Blueprint("api_memory", __name__)
logger = logging.getLogger(__name__)

# Match the built-in tool's order of magnitude; manual entry is a bit more
# generous.
_SUMMARY_MAX_CHARS = 2000


def _valid_fingerprint(value) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _write_conflict(persona_id: str, operation: str, exc: ValueError):
    logger.info(
        "网页记忆操作冲突 persona=%s operation=%s reason=%s",
        persona_id, operation, type(exc).__name__,
    )
    return jsonify({"error": str(exc)}), 409


def _group_storage_error(persona_id: str, group_id: str, exc: Exception):
    logger.warning("群记忆访问失败 persona=%s group=%s", persona_id, group_id, exc_info=True)
    if isinstance(exc, KeyError):
        return jsonify({"error": "群记忆来源不存在，请刷新后重试"}), 404
    return jsonify({"error": "无法读写群记忆，请检查该群的记忆存档"}), 503


def _validate_summary(value) -> tuple[str, str]:
    """Return (summary, error); a non-empty error means validation failed."""
    if not isinstance(value, str):
        return "", "记忆内容必须是字符串"
    summary = value.strip()
    if not summary:
        return "", "记忆内容不能为空"
    if len(summary) > _SUMMARY_MAX_CHARS:
        return "", f"记忆内容过长（最多 {_SUMMARY_MAX_CHARS} 字符）"
    return summary, ""


def _memory_target(app, persona_id: str, group_id: str | None):
    """Resolve a trusted scope without creating a memory archive from input."""
    if persona_id not in app.config.get("personas", default={}):
        return None, (), (jsonify({"error": "Persona not found"}), 404)
    if group_id is None:
        return app.memory_service, (persona_id,), None
    service = getattr(app, "group_memory_service", None)
    try:
        exists = service is not None and service.has_source(group_id, persona_id)
    except ValueError:
        exists = False
    if not exists:
        return None, (), (jsonify({"error": "群记忆来源不存在"}), 404)
    return service, (group_id, persona_id), None


@api_memory_bp.get("/<persona_id>/group-memories")
def list_group_memory_sources(persona_id: str):
    app = get_app()
    if persona_id not in app.config.get("personas", default={}):
        return jsonify({"error": "Persona not found"}), 404
    service = getattr(app, "group_memory_service", None)
    return jsonify({"groups": service.list_sources(persona_id) if service is not None else []})


@api_memory_bp.route("/<persona_id>/memories", methods=["GET"])
@api_memory_bp.get("/<persona_id>/group-memories/<group_id>")
def list_memories(persona_id: str, group_id: str | None = None):
    app = get_app()
    service, scope, error = _memory_target(app, persona_id, group_id)
    if error is not None:
        return error

    try:
        data = service.load_memories(*scope)
    except (KeyError, OSError, ValueError) as exc:
        if group_id is None:
            raise
        return _group_storage_error(persona_id, group_id, exc)
    memories = data.get("memories", [])
    memories_sorted = sorted(
        enumerate(memories),
        key=lambda pair: pair[1].get("created_at", ""),
        reverse=True,
    )
    result = []
    for idx, m in memories_sorted:
        result.append({
            "index": idx,
            "fingerprint": service.fingerprint(m),
            "summary": m.get("summary", ""),
            "importance": m.get("importance", 3),
            "created_at": m.get("created_at", ""),
        })
    return jsonify({"memories": result, "total": len(memories)})


@api_memory_bp.route("/<persona_id>/memories", methods=["POST"])
@api_memory_bp.post("/<persona_id>/group-memories/<group_id>")
def add_memory(persona_id: str, group_id: str | None = None):
    app = get_app()
    service, scope, error = _memory_target(app, persona_id, group_id)
    if error is not None:
        return error

    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求内容必须是 JSON 对象"}), 400
    summary, err = _validate_summary(data.get("summary", ""))
    if err:
        return jsonify({"error": err}), 400

    try:
        importance = int(data.get("importance", 3))
    except (TypeError, ValueError):
        return jsonify({"error": "importance 必须是整数"}), 400
    created_at = data.get("created_at", "")
    if not isinstance(created_at, str):
        return jsonify({"error": "created_at 必须是字符串"}), 400

    try:
        entry, _ = service.add_memory(
            *scope, summary, importance, created_at,
        )
    except DuplicateMemoryError as exc:
        return _write_conflict(persona_id, "add", exc)
    except (KeyError, OSError, ValueError) as exc:
        if group_id is None:
            raise
        return _group_storage_error(persona_id, group_id, exc)
    return jsonify({"ok": True, "memory": entry}), 201


@api_memory_bp.route("/<persona_id>/memories/<int:index>", methods=["PUT"])
@api_memory_bp.put("/<persona_id>/group-memories/<group_id>/<int:index>")
def update_memory(persona_id: str, index: int, group_id: str | None = None):
    app = get_app()
    service, scope, error = _memory_target(app, persona_id, group_id)
    if error is not None:
        return error

    data = request.get_json(force=True)
    fingerprint = data.get("fingerprint") if isinstance(data, dict) else None
    if not _valid_fingerprint(fingerprint):
        return jsonify({"error": "缺少或无效的记忆校验值，请刷新后重新打开。"}), 400
    updates = {}
    if "summary" in data:
        s, err = _validate_summary(data["summary"])
        if err:
            return jsonify({"error": err}), 400
        updates["summary"] = s
    if "importance" in data:
        try:
            updates["importance"] = int(data["importance"])
        except (TypeError, ValueError):
            return jsonify({"error": "importance 必须是整数"}), 400
    if "created_at" in data:
        if not isinstance(data["created_at"], str):
            return jsonify({"error": "created_at 必须是字符串"}), 400
        updates["created_at"] = data["created_at"]

    if not updates:
        return jsonify({"error": "没有需要更新的字段"}), 400

    try:
        service.update_memory(
            *scope, index, updates, expected_fingerprint=fingerprint,
        )
    except (MemoryConflictError, DuplicateMemoryError) as exc:
        return _write_conflict(persona_id, "update", exc)
    except (KeyError, OSError, ValueError) as exc:
        if group_id is None:
            raise
        return _group_storage_error(persona_id, group_id, exc)
    return jsonify({"ok": True})


@api_memory_bp.route("/<persona_id>/memories/<int:index>", methods=["DELETE"])
@api_memory_bp.delete("/<persona_id>/group-memories/<group_id>/<int:index>")
def delete_memory(persona_id: str, index: int, group_id: str | None = None):
    app = get_app()
    service, scope, error = _memory_target(app, persona_id, group_id)
    if error is not None:
        return error

    fingerprint = request.args.get("fingerprint")
    if not _valid_fingerprint(fingerprint):
        return jsonify({"error": "缺少或无效的记忆校验值，请刷新后重新打开。"}), 400
    try:
        service.delete_memory(*scope, index, expected_fingerprint=fingerprint)
    except MemoryConflictError as exc:
        return _write_conflict(persona_id, "delete", exc)
    except (KeyError, OSError, ValueError) as exc:
        if group_id is None:
            raise
        return _group_storage_error(persona_id, group_id, exc)
    return jsonify({"ok": True})


@api_memory_bp.delete("/<persona_id>/group-memories/<group_id>")
def delete_group_memory_source(persona_id: str, group_id: str):
    app = get_app()
    service, scope, error = _memory_target(app, persona_id, group_id)
    if error is not None:
        return error
    try:
        source_deleted = service.delete_source(*scope)
    except (KeyError, OSError, ValueError) as exc:
        return _group_storage_error(persona_id, group_id, exc)
    return jsonify({"ok": True, "source_deleted": source_deleted})
