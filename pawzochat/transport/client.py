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

"""Unified HTTP client for the iLink Bot API.

This file contains code ported from ``@tencent-weixin/openclaw-weixin@2.4.9``
(MIT-licensed).
See https://github.com/Tencent/openclaw-weixin for the original.

Endpoints: getupdates, sendmessage, getuploadurl, getconfig, sendtyping,
msg/notifystart, msg/notifystop.
QR-code login uses POST start and GET status.
"""

from __future__ import annotations

import base64
import logging
import secrets
import time

import requests
import httpx

from pawzochat.transport.diagnostics import qr_request

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"
CHANNEL_VERSION = "2.4.9"
ILINK_APP_ID = "bot"
ILINK_APP_CLIENT_VERSION = sum(
    (int(part) & 0xff) << shift
    for part, shift in zip(CHANNEL_VERSION.split("."), (16, 8, 0))
)

# Self-declared client identity sent in base_info.bot_agent. Mirrors the
# official plugin's default (config key channels.openclaw-weixin.botAgent),
# which falls back to "OpenClaw" when unset. Observability only — the server
# does not use it for auth or routing.
BOT_AGENT = "OpenClaw"

DEFAULT_LONG_POLL_TIMEOUT = 35
DEFAULT_API_TIMEOUT = 15
DEFAULT_CONFIG_TIMEOUT = 10


def _random_wechat_uin() -> str:
    """Generate X-WECHAT-UIN header: random uint32 → decimal string → base64."""
    uint32 = secrets.randbits(32)
    return base64.b64encode(str(uint32).encode("utf-8")).decode("ascii")


def _build_common_headers() -> dict[str, str]:
    """Headers shared by both GET and POST requests (app identification)."""
    return {
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": str(ILINK_APP_CLIENT_VERSION),
    }


def _build_post_headers(token: str = "") -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": _random_wechat_uin(),
        **_build_common_headers(),
    }
    if token.strip():
        headers["Authorization"] = f"Bearer {token.strip()}"
    return headers


def _build_base_info() -> dict:
    return {"channel_version": CHANNEL_VERSION, "bot_agent": BOT_AGENT}


def _generate_client_id() -> str:
    """Mirrors upstream util/random.ts `generateId("openclaw-weixin")`:
    `openclaw-weixin:{ms}-{8-char hex}`. The random suffix prevents
    collisions when two messages are sent within the same millisecond.
    """
    return f"openclaw-weixin:{int(time.time() * 1000)}-{secrets.token_hex(4)}"


class ILinkClient:
    """HTTP client wrapping all iLink Bot API calls for a single account."""

    def __init__(self, bot_token: str, base_url: str = DEFAULT_BASE_URL, *, connection=None):
        self.bot_token = bot_token
        self.connection = connection
        self.base_url = base_url.rstrip("/")
        self._session = requests.Session()

    def _headers(self) -> dict[str, str]:
        return _build_post_headers(self.bot_token)

    def _post(self, endpoint: str, payload: dict, timeout: float = DEFAULT_API_TIMEOUT, *, lifecycle=False) -> dict:
        if self.connection and not lifecycle:
            self.connection.check()
        url = f"{self.base_url}/{endpoint}"
        payload["base_info"] = _build_base_info()
        resp = self._session.post(url, json=payload, headers=self._headers(), timeout=timeout)
        resp.raise_for_status()
        result = resp.json() if resp.text.strip() else {}
        if self.connection and any(str(result.get(k)) == "-14" for k in ("ret", "errcode")):
            self.connection.stale()
            self.connection.check()
        return result

    def close(self):
        self._session.close()

    async def get_updates_async(self, http, buf="", timeout=None):
        if self.connection:
            self.connection.check()
        try:
            resp = await http.post(
                f"{self.base_url}/ilink/bot/getupdates",
                json={"get_updates_buf": buf, "base_info": _build_base_info()},
                headers=self._headers(), timeout=timeout if timeout is not None else DEFAULT_LONG_POLL_TIMEOUT,
            )
            resp.raise_for_status()
            return resp.json() if resp.content else {}
        except httpx.TimeoutException:
            return {"ret": 0, "msgs": [], "get_updates_buf": buf}

    # ---- Core API endpoints ----

    def get_updates(self, buf: str = "", timeout: float | None = None) -> dict:
        """Long-poll for new messages. Returns raw response dict."""
        poll_timeout = timeout if timeout is not None else DEFAULT_LONG_POLL_TIMEOUT
        try:
            return self._post(
                "ilink/bot/getupdates",
                {"get_updates_buf": buf},
                timeout=poll_timeout,
            )
        except requests.Timeout:
            logger.debug("getUpdates: 长轮询超时，正常重试")
            return {"ret": 0, "msgs": [], "get_updates_buf": buf}

    def send_message(self, msg: dict) -> dict:
        """Send a message. *msg* is the WeixinMessage-shaped dict."""
        response = self._post("ilink/bot/sendmessage", {"msg": msg})
        ret = response.get("ret")
        if ret not in (None, 0, "0"):
            raise RuntimeError(
                f"sendMessage ret={ret} errmsg={response.get('errmsg', '') or '(none)'}"
            )
        return response

    def get_upload_url(
        self,
        *,
        filekey: str,
        media_type: int,
        to_user_id: str,
        rawsize: int,
        rawfilemd5: str,
        filesize: int,
        aeskey: str,
        no_need_thumb: bool = True,
        thumb_rawsize: int | None = None,
        thumb_rawfilemd5: str | None = None,
        thumb_filesize: int | None = None,
    ) -> dict:
        body: dict = {
            "filekey": filekey,
            "media_type": media_type,
            "to_user_id": to_user_id,
            "rawsize": rawsize,
            "rawfilemd5": rawfilemd5,
            "filesize": filesize,
            "aeskey": aeskey,
            "no_need_thumb": no_need_thumb,
        }
        if thumb_rawsize is not None:
            body["thumb_rawsize"] = thumb_rawsize
        if thumb_rawfilemd5 is not None:
            body["thumb_rawfilemd5"] = thumb_rawfilemd5
        if thumb_filesize is not None:
            body["thumb_filesize"] = thumb_filesize
        return self._post("ilink/bot/getuploadurl", body)

    def get_config(self, ilink_user_id: str, context_token: str = "") -> dict:
        return self._post(
            "ilink/bot/getconfig",
            {"ilink_user_id": ilink_user_id, "context_token": context_token},
            timeout=DEFAULT_CONFIG_TIMEOUT,
        )

    def send_typing(self, ilink_user_id: str, typing_ticket: str, status: int = 1) -> dict:
        return self._post(
            "ilink/bot/sendtyping",
            {
                "ilink_user_id": ilink_user_id,
                "typing_ticket": typing_ticket,
                "status": status,
            },
            timeout=DEFAULT_CONFIG_TIMEOUT,
        )

    # ---- Online-state reconciliation (best-effort, never raises) ----

    def notify_start(self) -> None:
        """Tell the server this account's client is coming online.

        Best-effort: failures are logged and swallowed so they never block
        account startup. Mirrors upstream gateway.startAccount -> notifyStart.
        """
        try:
            result = self._post("ilink/bot/msg/notifystart", {}, timeout=DEFAULT_CONFIG_TIMEOUT, lifecycle=True)
            if result.get("ret") not in (None, 0, "0"):
                logger.warning("notifystart 返回非零业务码（已忽略）")
        except Exception:
            logger.warning("notifystart 失败（已忽略）")

    def notify_stop(self) -> None:
        """Tell the server this account's client is going offline.

        Best-effort: failures are logged and swallowed so they never block
        shutdown / account removal. Mirrors upstream gateway.stopAccount -> notifyStop.
        """
        try:
            result = self._post("ilink/bot/msg/notifystop", {}, timeout=DEFAULT_CONFIG_TIMEOUT, lifecycle=True)
            if result.get("ret") not in (None, 0, "0"):
                logger.warning("notifystop 返回非零业务码（已忽略）")
        except Exception:
            logger.warning("notifystop 失败（已忽略）")

    # ---- QR Code login (POST start / GET status, no auth needed) ----

    @staticmethod
    def get_qrcode(base_url: str = DEFAULT_BASE_URL, local_tokens=()) -> dict:
        """Request a new QR code for login. Returns {"qrcode": "...", ...}.

        Upstream 2.1.4 removed the client-side timeout (no AbortController);
        the request is no longer aborted on a fixed deadline. Server / TCP
        stack limits still apply.
        """
        tokens = list(dict.fromkeys(t.strip() for t in local_tokens
                                    if isinstance(t, str) and t.strip()))[:10]
        return qr_request(
            "get_bot_qrcode", base_url, headers=_build_post_headers(),
            tokens=tokens,
        )

    @staticmethod
    def check_qrcode_status(
        qrcode: str,
        base_url: str = DEFAULT_BASE_URL,
        verify_code: str = "",
    ) -> dict:
        """Poll for 35 seconds; return a safe, classified error on failure."""
        return qr_request(
            "get_qrcode_status", base_url, headers=_build_common_headers(),
            qrcode=qrcode, verify_code=verify_code,
        )

    # ---- Helper: build a sendMessage text payload ----

    @staticmethod
    def build_text_message(
        to_user_id: str,
        text: str,
        context_token: str,
    ) -> dict:
        """Construct a WeixinMessage dict for sending a text message."""
        return {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": _generate_client_id(),
            "message_type": 2,  # BOT
            "message_state": 2,  # FINISH
            "context_token": context_token,
            "item_list": [
                {
                    "type": 1,  # TEXT
                    "text_item": {"text": text},
                }
            ],
        }

    @staticmethod
    def build_image_message(
        to_user_id: str,
        cdn_info: dict,
        context_token: str,
    ) -> dict:
        """Construct a WeixinMessage dict for sending an image.

        *cdn_info* must contain:
          - encrypt_query_param: CDN download parameter
          - aes_key: base64-encoded AES-128 key
          - mid_size: ciphertext file size in bytes
        """
        return {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": _generate_client_id(),
            "message_type": 2,  # BOT
            "message_state": 2,  # FINISH
            "context_token": context_token,
            "item_list": [
                {
                    "type": 2,  # IMAGE
                    "image_item": {
                        "media": {
                            "encrypt_query_param": cdn_info["encrypt_query_param"],
                            "aes_key": cdn_info["aes_key"],
                            "encrypt_type": 1,
                        },
                        "mid_size": cdn_info["mid_size"],
                    },
                }
            ],
        }

    @staticmethod
    def build_file_message(
        to_user_id: str,
        cdn_info: dict,
        context_token: str,
        *,
        file_name: str = "",
    ) -> dict:
        """Construct a WeixinMessage dict for sending a file (doc/pdf/zip/...).

        *cdn_info* (returned by :func:`pawzochat.transport.cdn.upload_file`)
        must contain:
          - encrypt_query_param: CDN download parameter
          - aes_key: base64-encoded AES-128 key
          - file_name: original file name (shown to receiver)
          - length: plaintext byte length

        The iLink FileItem schema represents ``len`` as a decimal string.
        Sending it as a JSON number makes sendmessage reject the otherwise
        valid CDN reference with ``ret=-1, errmsg=invalid request``.
        """
        resolved_name = (file_name or cdn_info["file_name"]).strip() or cdn_info["file_name"]
        return {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": _generate_client_id(),
            "message_type": 2,  # BOT
            "message_state": 2,  # FINISH
            "context_token": context_token,
            "item_list": [
                {
                    "type": 4,  # FILE
                    "file_item": {
                        "media": {
                            "encrypt_query_param": cdn_info["encrypt_query_param"],
                            "aes_key": cdn_info["aes_key"],
                            "encrypt_type": 1,
                        },
                        "file_name": resolved_name,
                        "len": str(cdn_info["length"]),
                    },
                }
            ],
        }

