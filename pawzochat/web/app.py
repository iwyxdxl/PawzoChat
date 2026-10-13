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

"""Flask application factory for the PawzoChat web panel."""

from __future__ import annotations

import json
import logging
import os
import secrets
from datetime import timedelta
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from flask import Flask, Response, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from PIL import Image

from pawzochat.paths import CHATS_DIR, EMOJI_DIR, PROFILE_DIR
from pawzochat.utils.crypto import verify_password

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

_MIME_MAP = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

_AUTH_EXEMPT = frozenset(["/login", "/static/style.css", "/static/logo.png"])
_STATEFUL_METHODS = frozenset(["POST", "PUT", "PATCH", "DELETE"])


def _normalize_origin(value: str) -> str:
    if not value:
        return ""
    parsed = urlsplit(value)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


class SecretPrefixMiddleware:
    """WSGI middleware that requires a secret path prefix for all requests.

    Strips the prefix and sets SCRIPT_NAME so Flask generates correct URLs.
    Returns 404 for requests that don't match the prefix.

    After ``max_failures`` consecutive wrong-password logins the entire
    public endpoint is locked (403).  The lock resets on application restart.
    """

    def __init__(self, wsgi_app, secret: str, *, max_failures: int = 5):
        self.wsgi_app = wsgi_app
        self.prefix = f"/{secret}"
        self.locked = False
        self.fail_count = 0
        self.max_failures = max_failures

    def record_login_failure(self):
        self.fail_count += 1
        if self.fail_count >= self.max_failures:
            self.locked = True
            logger.warning(
                "公网访问已锁定：连续 %d 次密码错误，需重启程序解锁",
                self.fail_count,
            )

    def record_login_success(self):
        self.fail_count = 0

    def __call__(self, environ, start_response):
        if self.locked:
            start_response(
                "403 Forbidden",
                [("Content-Type", "text/plain; charset=utf-8")],
            )
            return [b"Public access locked. Restart the application to unlock."]
        path = environ.get("PATH_INFO", "/")
        if path == self.prefix or path.startswith(self.prefix + "/"):
            environ["SCRIPT_NAME"] = self.prefix
            environ["PATH_INFO"] = path[len(self.prefix) :] or "/"
            environ["pawzochat.is_public"] = True
            return self.wsgi_app(environ, start_response)
        start_response("404 Not Found", [("Content-Type", "text/plain; charset=utf-8")])
        return [b"Not Found"]


def create_app(app_instance: App) -> Flask:
    flask_app = Flask(
        __name__,
        template_folder="templates",
        static_folder=None,
    )
    flask_app.secret_key = os.urandom(32)
    flask_app.config["PAWZOCHAT_APP"] = app_instance
    # Snapshot at service construction; request headers and later configuration
    # edits must not redefine the local installation API's allowed origin.
    flask_app.config["LOCAL_LISTEN_PORT"] = int(
        app_instance.config.get("web", "port", default=62000)
    )
    # Re-read templates from disk when they change — a long-running panel must
    # not keep serving a stale compiled page after the files under it were
    # replaced (dev edits, in-place file swaps).
    flask_app.config["TEMPLATES_AUTO_RELOAD"] = True
    flask_app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB (supports multi-image Moments uploads)
    flask_app.permanent_session_lifetime = timedelta(hours=24)
    flask_app.config["SESSION_COOKIE_NAME"] = "pawzochat_session"
    flask_app.config["SESSION_COOKIE_HTTPONLY"] = True
    flask_app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    flask_app.config["SESSION_COOKIE_SECURE"] = bool(
        app_instance.config.get("web", "public_enabled", default=False)
    )

    # ---- Auth middleware ----

    @flask_app.before_request
    def require_login():
        password = app_instance.config.get("web", "password", default="")
        if not password:
            return None
        is_public = request.environ.get("pawzochat.is_public", False)
        if not is_public:
            return None
        if request.path in _AUTH_EXEMPT:
            return None
        if (
            request.endpoint == "api_plugins.plugin_ui_token_asset"
            and request.method in {"GET", "HEAD"}
        ):
            # Sandboxed UI subresources omit SameSite cookies. This exact
            # read-only route validates its scoped, expiring token itself.
            return None
        if session.get("authenticated"):
            return None
        if request.path.startswith("/api/"):
            return {"error": "unauthorized"}, 401
        return redirect(url_for("login"))

    @flask_app.before_request
    def require_same_origin_for_public_writes():
        if request.method not in _STATEFUL_METHODS:
            return None
        if not request.environ.get("pawzochat.is_public", False):
            return None
        if request.path == "/login":
            return None

        expected = request.host_url.rstrip("/")
        origin = _normalize_origin(request.headers.get("Origin", ""))
        referer = _normalize_origin(request.headers.get("Referer", ""))
        if origin == expected or referer == expected:
            return None

        logger.warning(
            "拒绝公网跨站写请求: method=%s path=%s origin=%s referer=%s",
            request.method, request.path, origin or "-", referer or "-",
        )
        return {"error": "forbidden"}, 403

    @flask_app.after_request
    def apply_security_headers(response):
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        if request.environ.get("pawzochat.is_public", False):
            response.headers.setdefault(
                "Content-Security-Policy", "frame-ancestors 'none'"
            )
        return response

    # ---- Login / Logout ----

    @flask_app.route("/login", methods=["GET", "POST"])
    def login():
        password = app_instance.config.get("web", "password", default="")
        is_public = request.environ.get("pawzochat.is_public", False)
        if not password or not is_public:
            return redirect(url_for("index"))

        if request.method == "GET":
            csrf_token = secrets.token_hex(32)
            session["csrf_token"] = csrf_token
            return render_template("login.html", error=None, csrf_token=csrf_token)

        csrf_token = request.form.get("csrf_token", "")
        expected_csrf = session.get("csrf_token", "")
        if (
            not csrf_token
            or not expected_csrf
            or not secrets.compare_digest(csrf_token, expected_csrf)
        ):
            new_csrf = secrets.token_hex(32)
            session["csrf_token"] = new_csrf
            return render_template("login.html", error="请求无效，请刷新页面重试", csrf_token=new_csrf)

        submitted = request.form.get("password", "")
        mw: SecretPrefixMiddleware | None = flask_app.config.get("PUBLIC_MIDDLEWARE")

        if verify_password(submitted, password):
            session.permanent = True
            session.pop("csrf_token", None)
            session["authenticated"] = True
            if mw:
                mw.record_login_success()
            return redirect(url_for("index"))

        if mw:
            mw.record_login_failure()
        new_csrf = secrets.token_hex(32)
        session["csrf_token"] = new_csrf
        return render_template("login.html", error="密码错误", csrf_token=new_csrf)

    @flask_app.route("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # ---- Static files ----

    @flask_app.route("/static/<path:filename>")
    def serve_static(filename):
        resp = send_from_directory(
            _STATIC_DIR,
            filename,
            conditional=True,
            etag=True,
            max_age=300,
        )
        ext = os.path.splitext(filename)[1].lower()
        if ext in _MIME_MAP:
            resp.headers["Content-Type"] = _MIME_MAP[ext]
        if request.environ.get("pawzochat.is_public", False):
            # Public HTTPS link: serve straight from local cache for 5 minutes,
            # then revalidate via ETag/Last-Modified — avoids re-shipping
            # JS/CSS/SVG on every page switch over the WAN.
            resp.headers["Cache-Control"] = "public, max-age=300, must-revalidate"
        else:
            # Local panel: always revalidate. Loopback 304s are free, and a
            # blind max-age window pins the UI to stale JS/CSS right after an
            # update — a plain reload should always pick up new code.
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    # ---- Blueprints ----

    from pawzochat.web.routes.api_conversations import api_conversations_bp
    from pawzochat.web.routes.api_groups import api_groups_bp
    from pawzochat.web.routes.api_personas import api_personas_bp
    from pawzochat.web.routes.api_memory import api_memory_bp
    from pawzochat.web.routes.api_settings import api_settings_bp
    from pawzochat.web.routes.api_providers import api_providers_bp
    from pawzochat.web.routes.api_image_providers import api_image_providers_bp
    from pawzochat.web.routes.api_voice_providers import api_voice_providers_bp
    from pawzochat.web.routes.api_accounts import api_accounts_bp
    from pawzochat.web.routes.api_emoji import api_emoji_bp
    from pawzochat.web.routes.api_mcp import api_mcp_bp
    from pawzochat.web.routes.api_moments import api_moments_bp
    from pawzochat.web.routes.api_plugins import api_plugins_bp
    from pawzochat.web.routes.api_setup import api_setup_bp
    from pawzochat.web.routes.api_telemetry import api_telemetry_bp
    from pawzochat.web.routes.api_themes import api_themes_bp
    from pawzochat.web.routes.api_worldbooks import api_worldbooks_bp
    from pawzochat.web.routes.api_persona_writer import api_persona_writer_bp

    flask_app.register_blueprint(api_conversations_bp, url_prefix="/api/conversations")
    flask_app.register_blueprint(api_groups_bp, url_prefix="/api/groups")
    flask_app.register_blueprint(api_personas_bp, url_prefix="/api/personas")
    flask_app.register_blueprint(api_memory_bp, url_prefix="/api/personas")
    flask_app.register_blueprint(api_settings_bp, url_prefix="/api/settings")
    flask_app.register_blueprint(api_providers_bp, url_prefix="/api/providers")
    flask_app.register_blueprint(api_image_providers_bp, url_prefix="/api/image-providers")
    flask_app.register_blueprint(api_voice_providers_bp, url_prefix="/api/voice-providers")
    flask_app.register_blueprint(api_accounts_bp, url_prefix="/api/accounts")
    flask_app.register_blueprint(api_emoji_bp, url_prefix="/api/emoji")
    flask_app.register_blueprint(api_mcp_bp, url_prefix="/api/mcp")
    flask_app.register_blueprint(api_moments_bp, url_prefix="/api/moments")
    flask_app.register_blueprint(api_plugins_bp, url_prefix="/api/plugins")
    flask_app.register_blueprint(api_setup_bp, url_prefix="/api/setup")
    flask_app.register_blueprint(api_telemetry_bp, url_prefix="/api/telemetry")
    flask_app.register_blueprint(api_themes_bp, url_prefix="/api/themes")
    flask_app.register_blueprint(api_worldbooks_bp, url_prefix="/api/worldbooks")
    flask_app.register_blueprint(api_persona_writer_bp, url_prefix="/api/persona-writer")

    @flask_app.route("/emoji-static/<path:filepath>")
    def serve_emoji(filepath):
        # conditional=True: emoji filenames aren't content-addressed (the user
        # may replace the emoji pack), so this uses ETag/304 negotiated caching
        # — the browser only sends a validation request when it already has a
        # local copy, instead of a full re-download, so emoji bubbles don't
        # collapse and re-expand on message-list re-renders.
        return send_from_directory(
            str(EMOJI_DIR), filepath, conditional=True,
        )

    @flask_app.route("/api/images/<persona_id>/<path:filename>")
    def serve_image(persona_id, filename):
        safe_pid = os.path.normpath(persona_id)
        safe_name = os.path.normpath(filename)
        if ".." in safe_pid or ".." in safe_name or os.path.isabs(safe_pid) or os.path.isabs(safe_name):
            return {"error": "forbidden"}, 403
        abs_dir = CHATS_DIR / safe_pid / "images"
        resp = send_from_directory(str(abs_dir), safe_name, conditional=True)
        # Chat image filenames are random hex with immutable content, so they
        # can be strongly cached long-term; otherwise every message-list
        # re-render would re-download the image in full, the bubble's height
        # would be 0 before it loads, and scrolling would land at the bottom
        # of the "collapsed list" (i.e. appear stuck at the previous message).
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    @flask_app.route("/api/files/<persona_id>/<path:filename>")
    def serve_file(persona_id, filename):
        safe_pid = os.path.normpath(persona_id)
        safe_name = os.path.normpath(filename)
        if ".." in safe_pid or ".." in safe_name or os.path.isabs(safe_pid) or os.path.isabs(safe_name):
            return {"error": "forbidden"}, 403
        abs_dir = CHATS_DIR / safe_pid / "files"
        return send_from_directory(
            str(abs_dir), safe_name, conditional=False, as_attachment=True,
        )

    @flask_app.route("/api/audio/<persona_id>/<path:filename>")
    def serve_audio(persona_id, filename):
        safe_pid = os.path.normpath(persona_id)
        safe_name = os.path.normpath(filename)
        if ".." in safe_pid or ".." in safe_name or os.path.isabs(safe_pid) or os.path.isabs(safe_name):
            return {"error": "forbidden"}, 403
        abs_dir = CHATS_DIR / safe_pid / "voice"
        # conditional=True lets Werkzeug handle Range/206 — Safari's media elements depend on it.
        resp = send_from_directory(str(abs_dir), safe_name, conditional=True)
        # Voice filenames are likewise random hex with immutable content, so they get the same strong-caching policy as chat images.
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    @flask_app.route("/api/personas/<persona_id>/avatar")
    def serve_avatar(persona_id):
        safe_pid = os.path.normpath(persona_id)
        if ".." in safe_pid or os.path.isabs(safe_pid):
            return {"error": "forbidden"}, 403
        abs_dir = CHATS_DIR / safe_pid
        avatar_file = abs_dir / "avatar.png"
        if not avatar_file.is_file():
            return {"error": "not found"}, 404
        resp = send_from_directory(str(abs_dir), "avatar.png", conditional=False)
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        return resp

    # ---- Profile API ----

    _PROFILE_JSON = PROFILE_DIR / "profile.json"
    _PROFILE_AVATAR = PROFILE_DIR / "avatar.png"

    def _load_profile() -> dict:
        if _PROFILE_JSON.is_file():
            with open(_PROFILE_JSON, "r", encoding="utf-8") as f:
                return json.load(f)
        return {"name": "我"}

    @flask_app.route("/api/profile", methods=["GET"])
    def get_profile():
        p = _load_profile()
        return jsonify({"name": p.get("name", "我"), "has_avatar": _PROFILE_AVATAR.is_file()})

    @flask_app.route("/api/profile", methods=["PATCH"])
    def update_profile():
        data = request.get_json(force=True)
        p = _load_profile()
        if "name" in data:
            name = str(data["name"]).strip()
            if not name:
                return jsonify({"error": "名称不能为空"}), 400
            if len(name) > 50:
                return jsonify({"error": "名称过长"}), 400
            p["name"] = name
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        with open(_PROFILE_JSON, "w", encoding="utf-8") as f:
            json.dump(p, f, ensure_ascii=False)
        return jsonify({"ok": True, "name": p["name"], "has_avatar": _PROFILE_AVATAR.is_file()})

    @flask_app.route("/api/profile/avatar", methods=["POST"])
    def upload_profile_avatar():
        f = request.files.get("avatar")
        if not f:
            return jsonify({"error": "No file uploaded"}), 400
        try:
            img = Image.open(f.stream).convert("RGBA")
        except Exception:
            return jsonify({"error": "Invalid image"}), 400
        w, h = img.size
        side = min(w, h)
        left, top = (w - side) // 2, (h - side) // 2
        img = img.crop((left, top, left + side, top + side)).resize((256, 256), Image.LANCZOS)
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        img.save(str(_PROFILE_AVATAR), "PNG")
        return jsonify({"ok": True})

    @flask_app.route("/api/profile/avatar", methods=["GET"])
    def serve_profile_avatar():
        if not _PROFILE_AVATAR.is_file():
            return {"error": "not found"}, 404
        resp = send_from_directory(str(PROFILE_DIR), "avatar.png", conditional=False)
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        return resp

    from pawzochat.web.sse import sse_stream

    @flask_app.route("/api/events")
    def events():
        is_public = bool(request.environ.get("pawzochat.is_public", False))
        return Response(sse_stream(is_public=is_public), mimetype="text/event-stream")

    # ---- Update API ----

    def _delayed_update_shutdown() -> None:
        import os
        import threading

        # Don't call shutdown(): srv.stop() would block on the SSE long
        # connection, truncating the HTTP response and making the frontend
        # report "failed to trigger update". Just os._exit(0) instead — the
        # updater overwrites all files anyway, so a clean shutdown isn't needed.
        threading.Timer(1.0, lambda: os._exit(0)).start()

    def _apply_downloaded_update(*, broadcast_fn=None) -> None:
        updater = app_instance.updater
        if updater is None:
            raise RuntimeError("dev_mode")
        if not updater.download_status.get("ready"):
            raise RuntimeError("staging_not_ready")

        updater.apply(shutdown_cb=_delayed_update_shutdown)
        if broadcast_fn:
            broadcast_fn("update_progress", **updater.download_status)

    @flask_app.route("/api/update/check")
    def update_check():
        is_public = request.environ.get("pawzochat.is_public", False)
        if is_public:
            return {"error": "not found"}, 404

        updater = app_instance.updater
        if updater is None:
            return {
                "has_update": False,
                "reason": "dev_mode",
                "current_version": __import__("pawzochat").__version__,
                "download_state": {
                    "stage": "unsupported",
                    "progress": 0,
                    "ready": False,
                    "error": "",
                },
            }

        result = updater.result
        if result is None:
            return {
                "has_update": False,
                "checking": True,
                "download_state": updater.download_status,
            }
        payload = dict(result)
        payload["download_state"] = updater.download_status
        return payload

    @flask_app.route("/api/update/state")
    def update_state():
        is_public = request.environ.get("pawzochat.is_public", False)
        if is_public:
            return {"error": "not found"}, 404

        updater = app_instance.updater
        if updater is None:
            return {
                "stage": "unsupported",
                "progress": 0,
                "ready": False,
                "error": "dev_mode",
            }

        return updater.download_status

    @flask_app.route("/api/update/download", methods=["POST"])
    def update_download():
        is_public = request.environ.get("pawzochat.is_public", False)
        if is_public:
            return {"error": "not found"}, 404

        updater = app_instance.updater
        if updater is None:
            return {"error": "dev_mode"}, 400

        result = updater.result
        if not result or not result.get("download_available"):
            return {"error": "no_download_available"}, 400

        # Nothing to fetch when a staged bundle already awaits apply — without
        # this a stale frontend state would silently restart the download.
        if updater.download_status.get("ready"):
            return {"ok": True, "message": "already_ready"}

        # Atomic check-and-set: a second rapid request gets a clean 409
        # instead of spawning a doomed duplicate download thread.
        if not updater.try_begin_download():
            return {"error": "already_downloading"}, 409

        try:
            from pawzochat.web.sse import broadcast

            def _download():
                import time as _time

                try:
                    _last_broadcast = [0.0]

                    def on_progress(pct: float):
                        now = _time.monotonic()
                        # Throttle: send at most once every 0.3s, to avoid flooding the SSE queue and dropping later critical events
                        if pct < 1.0 and now - _last_broadcast[0] < 0.3:
                            return
                        _last_broadcast[0] = now
                        broadcast(
                            "update_progress",
                            progress=round(pct * 100, 1),
                            stage="downloading",
                        )

                    def on_status(status: str):
                        broadcast(
                            "update_progress",
                            progress=100,
                            stage=status,
                            status=status,
                        )

                    updater.download(progress_cb=on_progress, status_cb=on_status, reserved=True)
                    _apply_downloaded_update(broadcast_fn=broadcast)
                except Exception as exc:
                    logger.exception("下载更新失败")
                    error_state = updater.download_status
                    broadcast(
                        "update_progress",
                        progress=error_state.get("progress", 0),
                        stage=error_state.get("stage", "error"),
                        ready=error_state.get("ready", False),
                        error=error_state.get("error") or str(exc),
                    )

            import threading
            threading.Thread(target=_download, name="update-download", daemon=True).start()
        except Exception:
            # The worker never started — release the reserved slot, otherwise
            # every later download request would get 409 until restart.
            updater.release_download()
            raise
        return {"ok": True, "message": "download_started"}

    @flask_app.route("/api/update/apply", methods=["POST"])
    def update_apply():
        is_public = request.environ.get("pawzochat.is_public", False)
        if is_public:
            return {"error": "not found"}, 404

        updater = app_instance.updater
        if updater is None:
            return {"error": "dev_mode"}, 400

        if not updater.download_status.get("ready"):
            return {"error": "staging_not_ready"}, 400

        try:
            _apply_downloaded_update()
            return {"ok": True, "message": "applying"}
        except Exception as exc:
            logger.exception("应用更新失败")
            return {"error": str(exc)}, 500

    @flask_app.route("/api/status")
    def status():
        from pawzochat import __version__
        online = sum(
            1
            for acc in app_instance.accounts
            if (ch := app_instance.channel_registry.get(
                acc.channel_type, default=None,
            )) and ch.is_online(acc.bot_id)
        )
        convs = len(app_instance.conversation_store.list_conversations())
        return {
            "version": __version__,
            "running": True,
            "accounts_online": online,
            "conversations_active": convs,
        }

    @flask_app.route("/api/wechat-links")
    def wechat_links():
        link_map = app_instance.conversation_store.get_link_map()
        personas = app_instance.config.load_personas()
        links = []
        for account_id, persona_id in link_map.items():
            p = personas.get(persona_id)
            links.append({
                "account_id": account_id,
                "persona_id": persona_id,
                "persona_name": p.name if p else persona_id,
                "channel": app_instance.conversation_store.get_link_channel(
                    account_id,
                ),
            })
        return {"links": links}

    @flask_app.route("/")
    def index():
        # no-cache: the HTML wires up the static assets, so it must revalidate
        # on every load — same policy as the /static handler.
        resp = flask_app.make_response(render_template("index.html"))
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @flask_app.context_processor
    def inject_globals():
        from pawzochat import __version__
        theme_mode = app_instance.config.get("theme.mode", "light")
        return {"version": __version__, "theme_mode": theme_mode}

    return flask_app
