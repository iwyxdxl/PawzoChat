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

"""Web-only group conversations. All mutations go through the group scheduler."""

from __future__ import annotations

import io
import json
import logging
import mimetypes
import secrets
import tempfile
import warnings
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.utils import secure_filename

from pawzochat.core.config import DEFAULT_GROUP_SYSTEM_INSTRUCTIONS
from pawzochat.store.conversation import StaleMessageCursor
from pawzochat.web.routes import get_app
from pawzochat.web.routes.api_conversations import _ext_from_mime, _resolve_sticker_path


api_groups_bp = Blueprint("api_groups", __name__)
logger = logging.getLogger(__name__)


@api_groups_bp.errorhandler(StaleMessageCursor)
def stale_history(error):
    return jsonify(error=str(error), code="stale_cursor"), 409


@api_groups_bp.errorhandler(KeyError)
def not_found(error):
    return jsonify(error="群聊或消息不存在"), 404


@api_groups_bp.errorhandler(ValueError)
def invalid_request(error):
    return jsonify(error=str(error)), 400


def _json_object():
    data = request.get_json(force=True)
    if not isinstance(data, dict):
        raise ValueError("请求内容必须是对象")
    return data


def _string(data, key, default=""):
    value = data.get(key, default)
    if not isinstance(value, str):
        raise ValueError(f"{key} 必须是字符串")
    return value.strip()


def _public_group(group):
    if group is None:
        raise KeyError("group")
    fields = ("group_id", "name", "members", "max_replies", "system_instructions", "has_avatar",
              "avatar_version", "created_at", "updated_at", "state", "last_message")
    result = {key: group[key] for key in fields if key in group}
    if "last_message" not in result:
        messages = group.get("messages", [])
        last = messages[-1] if messages else None
        result["last_message"] = None if last is None else {
            "role": last.get("role", ""),
            "speaker_id": last.get("speaker_id", ""),
            "speaker_name": last.get("speaker_name", ""),
            "timestamp": last.get("timestamp", ""),
            "text": _preview(last),
        }
    return result


def _preview(message):
    labels = {"image": "[图片]", "file": "[文件]", "voice": "[语音]", "emoji": "[表情]"}
    return " ".join(block.get("text", "") if block.get("type") == "text"
                    else labels.get(block.get("type"), "")
                    for block in message.get("content", []))[:60]


@api_groups_bp.get("")
def list_groups():
    return jsonify(groups=[_public_group(group) for group in get_app().group_store.list_groups()])


@api_groups_bp.post("")
def create_group():
    data = _json_object()
    group = get_app().group_chat_service.create_group(
        _string(data, "name"), data.get("members", []), data.get("max_replies", 5),
        system_instructions=data.get("system_instructions", DEFAULT_GROUP_SYSTEM_INSTRUCTIONS),
    )
    return jsonify(_public_group(group)), 201


@api_groups_bp.get("/default-system-instructions")
def default_system_instructions():
    return jsonify(text=DEFAULT_GROUP_SYSTEM_INSTRUCTIONS)


@api_groups_bp.get("/<group_id>")
def get_group(group_id):
    return jsonify(_public_group(get_app().group_store.get_group(group_id)))


@api_groups_bp.route("/<group_id>", methods=["PATCH", "PUT"])
def update_group(group_id):
    data = _json_object()
    if not data or set(data) - {"name", "members", "max_replies", "system_instructions"}:
        raise ValueError("请提供群名、成员、回复上限或群系统提示词")
    if "name" in data:
        data["name"] = _string(data, "name")
    return jsonify(_public_group(get_app().group_chat_service.update_group(group_id, **data)))


@api_groups_bp.delete("/<group_id>")
def delete_group(group_id):
    data = _json_object() if request.data else {}
    delete_memories = data.get("delete_memories", False)
    if not isinstance(delete_memories, bool):
        raise ValueError("delete_memories 必须是布尔值")
    app = get_app()
    try:
        if not app.group_chat_service.delete_group(group_id, delete_memories=delete_memories):
            raise KeyError(group_id)
    except OSError:
        logger.exception("Could not finish deleting group %s", group_id)
        message = ("群聊已删除，记忆清理未完成，请重试。" if app.group_store.get_group(group_id) is None
                   else "群聊删除失败，请检查存储后重试。")
        return jsonify(error=message), 503
    return jsonify(ok=True)


@api_groups_bp.get("/<group_id>/avatar")
def get_avatar(group_id):
    avatar = get_app().group_store.get_avatar(group_id)
    if avatar is None:
        raise KeyError(group_id)
    raw, version = avatar
    response = send_file(io.BytesIO(raw), mimetype="image/png", download_name="avatar.png",
                         etag=version, conditional=True, max_age=0)
    response.headers["Cache-Control"] = "private, no-cache"
    return response


@api_groups_bp.post("/<group_id>/avatar")
def upload_avatar(group_id):
    app = get_app()
    if app.group_store.get_group(group_id) is None:
        raise KeyError(group_id)
    upload = request.files.get("avatar")
    if upload is None:
        raise ValueError("请选择头像图片")
    raw = upload.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("头像图片不能超过 8 MB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.width * source.height > 20_000_000:
                    raise ValueError("头像图片尺寸过大")
                source.verify()
            with Image.open(io.BytesIO(raw)) as source:
                image = ImageOps.exif_transpose(source).convert("RGBA")
                side = min(image.size)
                left, top = (image.width - side) // 2, (image.height - side) // 2
                image = image.crop((left, top, left + side, top + side))
                image = image.resize((256, 256), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                image.save(output, "PNG")
    except (OSError, SyntaxError, ValueError, UnidentifiedImageError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ValueError("无法读取头像，请选择有效的图片") from None
    group = app.group_chat_service.set_avatar(group_id, output.getvalue())
    return jsonify(_public_group(group))


@api_groups_bp.delete("/<group_id>/avatar")
def delete_avatar(group_id):
    return jsonify(_public_group(get_app().group_chat_service.set_avatar(group_id, None)))


@api_groups_bp.post("/<group_id>/stop")
def stop_group(group_id):
    return jsonify(state=get_app().group_chat_service.stop_group(group_id))


@api_groups_bp.post("/<group_id>/clear")
@api_groups_bp.delete("/<group_id>/messages")
def clear_messages(group_id):
    app = get_app()
    app.group_chat_service.clear_messages(group_id)
    group = app.group_store.get_group(group_id)
    return jsonify(ok=True, state=group["state"] if group else None)


@api_groups_bp.get("/<group_id>/messages/dates")
def message_dates(group_id):
    store = get_app().group_store
    if store.get_group(group_id) is None:
        raise KeyError(group_id)
    return jsonify(dates=store.get_message_dates(group_id))


@api_groups_bp.get("/<group_id>/messages")
def get_messages(group_id):
    store = get_app().group_store
    if "date" in request.args:
        if any(key in request.args for key in ("limit", "before", "after")):
            raise ValueError("日期查询不能与分页同时使用")
        if store.get_group(group_id) is None:
            raise KeyError(group_id)
        return jsonify(group_id=group_id, date=request.args["date"],
                       messages=store.get_messages_by_date(group_id, request.args["date"]))
    page = store.get_message_page(group_id, limit=int(request.args.get("limit", "60")),
                                  before=request.args.get("before"), after=request.args.get("after"))
    if page is None:
        raise KeyError(group_id)
    return jsonify(page)


@api_groups_bp.post("/<group_id>/messages")
def send_message(group_id):
    app = get_app()
    if app.group_store.get_group(group_id) is None:
        raise KeyError(group_id)
    multipart = request.mimetype == "multipart/form-data"
    data = request.form if multipart else _json_object()
    text = _string(data, "text")
    client_message_id = _string(data, "client_message_id")
    if not client_message_id or len(client_message_id) > 128:
        raise ValueError("client_message_id 必须是 1–128 字符的消息标识")
    mentions = data.get("mentions", "[]" if multipart else [])
    if multipart:
        try:
            mentions = json.loads(mentions)
        except (ValueError, TypeError):
            raise ValueError("mentions 必须是角色 ID 数组") from None
    if not isinstance(mentions, list) or any(not isinstance(pid, str) or not pid for pid in mentions):
        raise ValueError("mentions 必须是角色 ID 数组")
    quote = _string(data, "quote")
    reply_to = _string(data, "reply_to_message_id")
    sticker_url = _string(data, "sticker_url")
    content = [{"type": "text", "text": text}] if text else []

    # Stage outside the group directory: a concurrent deletion must not be
    # undone by an upload creating its former directory again.
    with tempfile.TemporaryDirectory(prefix="pawzo-group-upload-") as temporary:
        stage = Path(temporary)
        if multipart:
            for kind, block_type in (("images", "image"), ("files", "file")):
                for upload in request.files.getlist(kind):
                    raw = upload.read()
                    if not raw:
                        continue
                    name = upload.filename or "file"
                    mime = upload.mimetype or "application/octet-stream"
                    suffix = (_ext_from_mime(mime) if kind == "images"
                              else Path(secure_filename(name)).suffix[:20])
                    path = stage / kind / f"{secrets.token_hex(16)}{suffix}"
                    path.parent.mkdir(exist_ok=True)
                    path.write_bytes(raw)
                    block = {"type": block_type, "path": str(path), "mime": mime}
                    if kind == "files":
                        block.update(name=name, size=len(raw))
                    content.append(block)
        if sticker_url:
            sticker = _resolve_sticker_path(sticker_url)
            if sticker is None:
                raise ValueError("表情文件不存在")
            path = stage / "images" / f"{secrets.token_hex(16)}{sticker.suffix}"
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(sticker.read_bytes())
            content.append({"type": "image", "path": str(path),
                            "mime": mimetypes.guess_type(path.name)[0] or "image/png"})
        if not content:
            raise ValueError("请发送文字、图片、文件或表情")
        result = app.group_chat_service.send_message(
            group_id, content, client_message_id=client_message_id,
            mention_persona_ids=mentions, quote=quote,
            reply_to_message_id=reply_to, media_dir=stage,
        )
    return jsonify(result), 200 if result.get("duplicate") else 201


@api_groups_bp.route("/<group_id>/messages/<message_id>", methods=["PATCH", "PUT"])
def edit_message(group_id, message_id):
    data = _json_object()
    if "text" not in data:
        raise ValueError("text is required")
    text = _string(data, "text")
    quote = _string(data, "quote") if "quote" in data else None
    result = get_app().group_chat_service.edit_message(
        group_id, message_id, text, quote=quote,
        expected_fingerprint=_string(data, "fingerprint"),
    )
    return jsonify(ok=True, message=result)


@api_groups_bp.delete("/<group_id>/messages/<message_id>")
def delete_message(group_id, message_id):
    get_app().group_chat_service.delete_message(
        group_id, message_id, expected_fingerprint=request.args.get("fingerprint", ""),
    )
    return jsonify(ok=True)


@api_groups_bp.get("/<group_id>/media/<kind>/<path:filename>")
def get_media(group_id, kind, filename):
    if kind not in {"images", "files", "voice"}:
        raise KeyError(kind)
    store = get_app().group_store
    if store.get_group(group_id) is None:
        raise KeyError(group_id)
    path = store.get_media_path(group_id, filename, kind=kind)
    if path is None:
        raise KeyError(filename)
    try:
        response = send_file(path, conditional=True, as_attachment=kind == "files")
    except FileNotFoundError:
        # A group may be deleted after the owner check but before opening it.
        raise KeyError(filename) from None
    if kind != "files":
        response.headers["Cache-Control"] = "private, max-age=31536000, immutable"
    return response
