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

"""REST API for WeChat bot account management."""

from __future__ import annotations

import base64
import io
import logging
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from pawzochat.transport.client import DEFAULT_BASE_URL, ILinkClient
from pawzochat.transport.models import Account
from pawzochat.transport.diagnostics import qr_error
from pawzochat.web.routes import get_app

logger = logging.getLogger(__name__)

api_accounts_bp = Blueprint("api_accounts", __name__)


@api_accounts_bp.route("", methods=["GET"])
def list_accounts():
    app = get_app()
    link_map = app.conversation_store.get_link_map()  # {account_id: persona_id}

    result = []
    for acc in app.accounts:
        channel = app.channel_registry.get(acc.channel_type, default=None)
        result.append({
            "bot_id": acc.bot_id,
            "channel_type": acc.channel_type,
            "channel_name": channel.display_name if channel else acc.channel_type,
            "created_at": acc.created_at,
            "online": channel.is_online(acc.bot_id) if channel else False,
            "linked_persona": link_map.get(acc.bot_id),
            "note": acc.note,
            **(channel.connection_status(acc.bot_id) if channel and hasattr(channel, "connection_status") else {}),
        })
    return jsonify({"accounts": result})


@api_accounts_bp.route("/channels", methods=["GET"])
def list_channel_types():
    """List addable channel types and how to add an account for each."""
    app = get_app()
    result = []
    for channel in app.channel_registry.all():
        form = channel.account_form()
        if form.get("method", "none") == "none":
            continue
        result.append({
            "type": channel.channel_type,
            "name": channel.display_name,
            "method": form.get("method", "form"),
            "fields": form.get("fields", []),
            "hint": form.get("hint", ""),
        })
    return jsonify({"channels": result})


@api_accounts_bp.route("", methods=["POST"])
def create_account():
    """Create a form-based channel account (QQ, plugin channels).

    WeChat uses the QR endpoints instead.
    """
    app = get_app()
    data = request.get_json(force=True) or {}
    channel_type = (data.get("channel_type") or "").strip()
    fields = data.get("fields") or {}
    if not channel_type:
        return jsonify({"error": "channel_type is required"}), 400
    if not isinstance(fields, dict):
        return jsonify({"error": "fields must be an object"}), 400

    channel = app.channel_registry.get(channel_type, default=None)
    if channel is None:
        return jsonify({"error": f"未知通道: {channel_type}"}), 400
    if channel.account_form().get("method") != "form":
        return jsonify({"error": "该通道不支持表单添加"}), 400

    try:
        account = channel.validate_and_create(fields)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        logger.exception("创建账号失败 channel=%s", channel_type)
        return jsonify({"error": "创建账号失败，请稍后重试"}), 500

    if any(a.bot_id == account.bot_id for a in app.accounts):
        return jsonify({"error": "该账号已存在"}), 409

    app._auth_manager._add_and_save(account)
    app._start_account(account)
    return jsonify({
        "ok": True,
        "bot_id": account.bot_id,
        "channel_type": account.channel_type,
    })


@api_accounts_bp.route("/qr/start", methods=["POST"])
def qr_start():
    try:
        accounts = sorted(get_app().accounts, key=lambda a: a.created_at, reverse=True)
        tokens = [a.bot_token for a in accounts if a.channel_type == "wechat" and a.bot_token]
        qr_data = ILinkClient.get_qrcode(DEFAULT_BASE_URL, tokens)
        qrcode_str = qr_data.get("qrcode", "")
        qr_img_content = qr_data.get("qrcode_img_content", "")
        if not qrcode_str:
            return jsonify({**qr_data, "error": qr_data.get("errmsg", "获取二维码失败，请稍后重试")}), 502
        qr_image = _generate_qr_base64(qr_img_content or qrcode_str)
        return jsonify({"qr_image": qr_image, "qrcode": qrcode_str})
    except Exception:
        logger.warning("获取二维码失败")
        return jsonify({**qr_error("invalid_response"), "error": "获取二维码失败，请稍后重试"}), 502


@api_accounts_bp.route("/qr/status", methods=["GET"])
def qr_status():
    qrcode = request.args.get("qrcode", "")
    base_url = request.args.get("base_url", "") or DEFAULT_BASE_URL
    verify_code = request.args.get("verify_code", "")
    app = get_app()

    if not qrcode:
        return jsonify(qr_error("invalid_response")), 400
    status_data = ILinkClient.check_qrcode_status(qrcode, base_url, verify_code)
    if status_data.get("error_kind"):
        return jsonify(status_data)

    status = status_data.get("status", "")

    if status == "scaned_but_redirect":
        redirect_host = status_data.get("redirect_host", "")
        return jsonify({"status": "scaned_but_redirect", "redirect_host": redirect_host})

    if status == "binded_redirect":
        bot_id = str(status_data.get("ilink_bot_id", "") or "").strip()
        known = next((a for a in app.accounts if a.channel_type == "wechat" and a.bot_id == bot_id), None)
        return jsonify({"status": status, "already_connected": True,
                        "bot_id": known.bot_id if known else ""})

    if status == "confirmed":
        with app._accounts_lock:
            bot_id = str(status_data.get("ilink_bot_id", "") or "").strip()
            if not bot_id:
                logger.error("扫码已确认，但响应缺少 ilink_bot_id")
                return jsonify({**qr_error("invalid_response"), "error": "登录失败：服务器未返回账号 ID"}), 502
            confirmed_token = str(status_data.get("bot_token", "") or "")
            confirmed_user_id = str(status_data.get("ilink_user_id", "") or "")
            confirmed_base_url = str(
                status_data.get("baseurl", "") or base_url or DEFAULT_BASE_URL
            ).rstrip("/")
            existing = next((a for a in app.accounts if a.bot_id == bot_id), None)
            if existing:
                if existing.channel_type != "wechat":
                    return jsonify({**qr_error("invalid_response"), "error": "该账号 ID 已被其他通道使用"}), 409
                new_token = confirmed_token or existing.bot_token
                new_user_id = confirmed_user_id or existing.ilink_user_id
                if not new_token:
                    logger.error("扫码已确认，但账号缺少 bot_token (bot_id=%s)", bot_id)
                    return jsonify({**qr_error("invalid_response"), "error": "登录失败：服务器未返回登录凭据"}), 502
                new_extra = {**(existing.extra or {}), "base_url": confirmed_base_url}
                if confirmed_token and confirmed_token != existing.bot_token:
                    new_extra.pop("cooldown_until", None)
                credentials_changed = (
                    existing.bot_token != new_token
                    or existing.ilink_user_id != new_user_id
                    or existing.extra != new_extra
                )
                channel = app.channel_registry.get("wechat", default=None)
                if credentials_changed and channel:
                    channel.stop_account(bot_id)
                if credentials_changed:
                    existing.bot_token = new_token
                    existing.ilink_user_id = new_user_id
                    existing.extra = new_extra
                    app._auth_manager.update_account(existing)
                if channel and (
                    credentials_changed or not channel.is_online(bot_id)
                ):
                    if not credentials_changed:
                        channel.stop_account(bot_id)
                    channel.start_account(existing)
                return jsonify({"status": "confirmed", "bot_id": bot_id})

            if not confirmed_token:
                logger.error("扫码已确认，但响应缺少 bot_token (bot_id=%s)", bot_id)
                return jsonify({**qr_error("invalid_response"), "error": "登录失败：服务器未返回登录凭据"}), 502
            account = Account(
                bot_id=bot_id,
                bot_token=confirmed_token,
                ilink_user_id=confirmed_user_id,
                created_at=datetime.now(timezone.utc).isoformat(),
                extra={"base_url": confirmed_base_url},
            )
            app._auth_manager._add_and_save(account)
            app._start_account(account)
            return jsonify({"status": "confirmed", "bot_id": account.bot_id})

    return jsonify({"status": status})


@api_accounts_bp.route("/<path:bot_id>", methods=["PATCH"])
def update_account(bot_id: str):
    app = get_app()
    data = request.get_json() or {}

    for acc in app.accounts:
        if acc.bot_id == bot_id:
            if "note" in data:
                acc.note = data["note"]
            app._auth_manager.update_account(acc)
            return jsonify({"ok": True})

    return jsonify({"error": "Account not found"}), 404


@api_accounts_bp.route("/<path:bot_id>", methods=["DELETE"])
def delete_account(bot_id: str):
    app = get_app()

    with app._accounts_lock:
        acc = next((a for a in app.accounts if a.bot_id == bot_id), None)
        channel = (
            app.channel_registry.get(acc.channel_type, default=None) if acc else None
        )
        if channel:
            # Stops the receive loop + best-effort offline notify (fire-and-forget).
            channel.stop_account(bot_id)

        # Atomic with create/QR-confirm appends so a concurrent op can't resurrect
        # a just-deleted account or drop a just-added one.
        app.accounts = [a for a in app.accounts if a.bot_id != bot_id]
        app._auth_manager.remove_account(bot_id)
        app.conversation_store.quotes.purge(account=bot_id)
        if channel and hasattr(channel, "remove_account_state"):
            channel.remove_account_state(bot_id)
        app.conversation_store.remove_links_for_account(bot_id)

    return jsonify({"ok": True})


# ---- Helpers ----

def _generate_qr_base64(content: str) -> str:
    import qrcode

    qr = qrcode.QRCode(
        version=1, error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=8, border=2,
    )
    qr.add_data(content)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"
