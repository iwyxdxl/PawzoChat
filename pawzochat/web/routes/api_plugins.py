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

"""REST API for plugin discovery, management and sandboxed config UI assets."""

from __future__ import annotations

import logging
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from flask import Blueprint, current_app, jsonify, request, send_from_directory, url_for
from itsdangerous import BadData, URLSafeTimedSerializer
from werkzeug.exceptions import BadRequest

from pawzochat.core.extensions.manager import PluginBusyError, PluginUnloadError
from pawzochat.core.extensions.source import PluginError, validate_plugin_id, validate_url
from pawzochat.web.routes import get_app

api_plugins_bp = Blueprint("api_plugins", __name__)
logger = logging.getLogger(__name__)

_UI_TOKEN_SALT = "plugin-ui-assets-v1"
_UI_TOKEN_MAX_AGE = 24 * 60 * 60
_UI_RESIZE_SCRIPT = (
    Path(__file__).resolve().parents[1] / "static/modules/plugin_config_resize.js"
).read_bytes()


def _ui_token_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.secret_key, salt=_UI_TOKEN_SALT)


def _source_metadata(plugin: dict) -> dict:
    """Download-management metadata is only exposed by the local panel."""
    result = dict(plugin)
    installer = getattr(get_app(), "installer", None)
    if installer is not None and not request.environ.get("pawzochat.is_public", False):
        try:
            result.update(installer.get_source_info(result["id"]))
        except PluginError as exc:
            # A corrupt record must neither hide other plugins nor be presented
            # as a trustworthy local/online installation.
            result.update(source_type="invalid", source_url=None, public_key=None,
                          source_error={"code": exc.code, "message": exc.message})
    return result


def _plugin_detail(plugin_id: str) -> dict | None:
    app = get_app()
    with app.extension_manager._lock:
        detail = app.extension_manager.get_plugin(plugin_id)
        if detail is None:
            return None
        detail = _source_metadata(detail)
        detail["provided_tools"] = app.extension_manager.get_provided_tools(plugin_id)
    detail["config_ui_url"] = None
    entry = detail["manifest"].get("config_ui", {}).get("entry")
    if entry:
        endpoint = "api_plugins.plugin_ui_asset"
        values = {"plugin_id": plugin_id, "filename": entry}
        if request.environ.get("pawzochat.is_public", False):
            endpoint = "api_plugins.plugin_ui_token_asset"
            values["token"] = _ui_token_serializer().dumps({"plugin_id": plugin_id})
        detail["config_ui_url"] = url_for(endpoint, **values)
    return detail


@api_plugins_bp.after_request
def prevent_plugin_response_caching(response):
    # Plugin details contain configuration secrets and temporary UI access URLs.
    response.headers.setdefault("Cache-Control", "no-store")
    return response


@api_plugins_bp.errorhandler(PluginError)
def plugin_operation_error(error):
    return jsonify(error.to_dict()), error.status


@api_plugins_bp.errorhandler(PluginBusyError)
def plugin_busy_error(error):
    return jsonify({"error": "plugin_busy", "message": "插件正在处理请求，请稍后重试"}), 409


@api_plugins_bp.errorhandler(PluginUnloadError)
def plugin_unload_error(error):
    logger.error("Plugin manager cannot proceed: %s", error)
    return jsonify({"error": "recovery_required", "message": "插件未能安全停止或需要恢复，请查看服务日志"}), 500


@api_plugins_bp.route("", methods=["GET"])
def list_plugins():
    app = get_app()
    with app.extension_manager._lock:
        plugins = [_source_metadata(p) for p in app.extension_manager.list_plugins()]
    return jsonify({"plugins": plugins})


@api_plugins_bp.route("/refresh", methods=["POST"])
def refresh_plugins():
    app = get_app()
    with app.extension_manager._lock:
        app.extension_manager.refresh()
        plugins = [_source_metadata(p) for p in app.extension_manager.list_plugins()]
    return jsonify({"ok": True, "plugins": plugins})


def _require_local():
    if request.environ.get("pawzochat.is_public", False):
        return jsonify({"error": "local_only", "message": "此操作仅限本地访问"}), 403
    return None


def _origin(value: str):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
        return parsed.scheme, parsed.hostname.lower(), port
    except ValueError:
        return None


def _require_local_same_origin():
    blocked = _require_local()
    if blocked is not None:
        return blocked
    port = current_app.config.get("LOCAL_LISTEN_PORT")
    allowed = {("http", "127.0.0.1", port), ("http", "localhost", port)}
    target = _origin(request.host_url)
    source = _origin(request.headers["Origin"] if "Origin" in request.headers
                     else request.headers.get("Referer", ""))
    if port is None or target not in allowed or source != target:
        return jsonify({"error": "same_origin_required", "message": "仅允许本地同源请求"}), 403
    return None


def _installer_route(*, write=False):
    """Guard every new entry point and preserve the installer's saved status."""
    def decorate(func):
        @wraps(func)
        def wrapped(*args, **kwargs):
            blocked = _require_local_same_origin() if write else _require_local()
            if blocked is not None:
                return blocked
            try:
                result = func(*args, **kwargs)
                if isinstance(result, tuple):
                    body, status = result
                else:
                    body, status = result, 200
                return jsonify(body), status
            except (PluginError, PluginBusyError, PluginUnloadError):
                raise
            except Exception:
                logger.exception("Plugin installation API failed: %s", request.endpoint)
                return jsonify({"error": "operation_failed", "message": "插件操作失败，请查看服务日志"}), 500
        return wrapped
    return decorate


def _get_installer():
    installer = getattr(get_app(), "installer", None)
    if installer is None:
        raise PluginError("service_stopping", "插件安装服务尚未就绪", 503)
    return installer


def _json_body(required: set[str], optional: set[str] | None = None) -> dict:
    if not request.is_json:
        raise PluginError("bad_field", "请求体必须是 JSON 对象")
    try:
        data = request.get_json()
    except BadRequest as exc:
        raise PluginError("bad_field", "请求体不是合法的 JSON") from exc
    if not isinstance(data, dict):
        raise PluginError("bad_field", "请求体必须是 JSON 对象")
    if set(data) - required - (optional or set()):
        raise PluginError("bad_field", "请求包含不支持的字段")
    for key in required:
        if not isinstance(data.get(key), str) or not data[key]:
            raise PluginError("bad_field", f"{key} 必须是非空字符串")
    for key in optional or ():
        if key in data and (not isinstance(data[key], str) or not data[key]):
            raise PluginError("bad_field", f"{key} 必须是非空字符串")
    return data


def _uuid(value: str) -> str:
    try:
        parsed = UUID(value)
        if str(parsed) != value.lower():
            raise ValueError
        return str(parsed)
    except (ValueError, AttributeError) as exc:
        raise PluginError("bad_field", "task_id 必须是 UUID") from exc


def _force_check() -> bool:
    values = request.args.getlist("force")
    if len(values) > 1 or (values and values[0] not in {"0", "1"}):
        raise PluginError("bad_field", "force 必须为 0 或 1")
    return values == ["1"]


@api_plugins_bp.route("/install/preview", methods=["POST"])
@_installer_route(write=True)
def preview_plugin_install():
    data = _json_body({"url"})
    result = _get_installer().start_preview(validate_url(data["url"]))
    return result, 202


@api_plugins_bp.route("/tasks/<task_id>", methods=["GET"])
@_installer_route()
def get_plugin_task(task_id: str):
    return _get_installer().get_task(_uuid(task_id))


@api_plugins_bp.route("/install", methods=["POST"])
@_installer_route(write=True)
def confirm_plugin_install():
    data = _json_body({"task_id"})
    return _get_installer().install_confirm(_uuid(data["task_id"]))


@api_plugins_bp.route("/install/cancel", methods=["POST"])
@_installer_route(write=True)
def cancel_plugin_install():
    data = _json_body({"task_id"})
    return _get_installer().cancel(_uuid(data["task_id"]))


@api_plugins_bp.route("/updates", methods=["GET"])
@_installer_route()
def check_plugin_updates():
    return {"updates": _get_installer().check_updates(force=_force_check())}


@api_plugins_bp.route("/<plugin_id>/updates", methods=["GET"])
@_installer_route()
def check_single_plugin_update(plugin_id: str):
    validate_plugin_id(plugin_id)
    updates = _get_installer().check_updates([plugin_id], force=_force_check())
    if plugin_id not in updates:
        raise PluginError("not_found", "插件不存在或未配置在线来源", 404)
    return updates[plugin_id]


@api_plugins_bp.route("/<plugin_id>/upgrade", methods=["POST"])
@_installer_route(write=True)
def upgrade_plugin(plugin_id: str):
    validate_plugin_id(plugin_id)
    data = _json_body({"task_id"}, {"trust_token"})
    return _get_installer().upgrade(plugin_id, _uuid(data["task_id"]),
                                    trust_token=data.get("trust_token"))


@api_plugins_bp.route("/<plugin_id>", methods=["GET"])
def get_plugin(plugin_id: str):
    detail = _plugin_detail(plugin_id)
    if not detail:
        return jsonify({"error": "Plugin not found"}), 404
    return jsonify(detail)


@api_plugins_bp.route("/<plugin_id>", methods=["DELETE"])
@_installer_route(write=True)
def uninstall_plugin(plugin_id: str):
    return _get_installer().uninstall(plugin_id)


@api_plugins_bp.route("/<plugin_id>/enable", methods=["POST"])
def enable_plugin(plugin_id: str):
    app = get_app()
    try:
        app.extension_manager.set_enabled(plugin_id, True)
    except KeyError:
        return jsonify({"error": "Plugin not found"}), 404
    return jsonify({"ok": True, "plugin": _plugin_detail(plugin_id)})


@api_plugins_bp.route("/<plugin_id>/disable", methods=["POST"])
def disable_plugin(plugin_id: str):
    app = get_app()
    try:
        app.extension_manager.set_enabled(plugin_id, False)
    except KeyError:
        return jsonify({"error": "Plugin not found"}), 404
    return jsonify({"ok": True, "plugin": _plugin_detail(plugin_id)})


@api_plugins_bp.route("/<plugin_id>/reload", methods=["POST"])
def reload_plugin(plugin_id: str):
    app = get_app()
    try:
        app.extension_manager.reload_plugin(plugin_id)
    except KeyError:
        return jsonify({"error": "Plugin not found"}), 404
    return jsonify({"ok": True, "plugin": _plugin_detail(plugin_id)})


@api_plugins_bp.route("/<plugin_id>/config", methods=["PATCH"])
def update_plugin_config(plugin_id: str):
    app = get_app()
    data = request.get_json(force=True)
    settings = data.get("settings", {})
    if not isinstance(settings, dict):
        return jsonify({"error": "settings must be an object"}), 400
    try:
        saved = app.extension_manager.update_settings(plugin_id, settings)
    except KeyError:
        return jsonify({"error": "Plugin not found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"ok": True, "settings": saved, "plugin": _plugin_detail(plugin_id)})


@api_plugins_bp.route("/<plugin_id>/ui/<path:filename>", methods=["GET"])
def plugin_ui_asset(plugin_id: str, filename: str):
    return _serve_plugin_ui_asset(plugin_id, filename)


@api_plugins_bp.route("/<plugin_id>/ui-assets/<token>/<path:filename>", methods=["GET"])
def plugin_ui_token_asset(plugin_id: str, token: str, filename: str):
    """Read-only asset access for sandbox requests without SameSite cookies."""
    try:
        payload = _ui_token_serializer().loads(token, max_age=_UI_TOKEN_MAX_AGE)
    except BadData:
        return jsonify({"error": "unauthorized"}), 401
    if payload != {"plugin_id": plugin_id}:
        return jsonify({"error": "unauthorized"}), 401
    return _serve_plugin_ui_asset(plugin_id, filename)


def _serve_plugin_ui_asset(plugin_id: str, filename: str):
    """Serve a plugin's custom config UI assets from ``<plugin_root>/ui/``.

    Refuses to serve unless the plugin's manifest explicitly declares
    ``config_ui``. The plugin's actual root directory is looked up via
    ``ExtensionManager`` rather than derived from the URL — manifest ``id``
    and directory name are independent and we trust the manager's view.
    """
    app = get_app()
    ui_root = app.extension_manager.get_plugin_ui_root(plugin_id)
    if ui_root is None:
        return jsonify({"error": "Plugin not found or config_ui not declared"}), 404

    ui_root = ui_root.resolve()
    try:
        target = (ui_root / filename).resolve()
    except (OSError, ValueError):
        return jsonify({"error": "Invalid path"}), 400
    # send_from_directory rejects ``..`` traversal already, but we check
    # the resolved path is contained under ui_root as defence-in-depth
    # (catches symlink escapes too).
    if ui_root not in target.parents:
        return jsonify({"error": "Invalid path"}), 400
    if not target.is_file():
        return jsonify({"error": "Asset not found"}), 404

    resp = send_from_directory(
        str(ui_root),
        filename,
        conditional=False,
        etag=False,
        max_age=0,
    )
    if resp.mimetype == "text/html":
        # Run inside the existing sandbox: the host never needs access to the
        # plugin document, and ordinary HTML needs no custom resize protocol.
        resp.direct_passthrough = False
        resp.set_data(resp.get_data() + b"\n<script>\n" + _UI_RESIZE_SCRIPT + b"\n</script>\n")
    # Force fresh fetches so plugin reloads aren't masked by the cache.
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    # Allow the panel to embed its sandboxed UI in both local and public mode.
    resp.headers["X-Frame-Options"] = "SAMEORIGIN"
    resp.headers["Content-Security-Policy"] = "frame-ancestors 'self'"
    return resp
