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

"""QQ channel — bridges QQ Bot API v2 C2C messages to the chat pipeline.

C2C (private) only. Inbound images / videos / files arrive as time-limited
attachment URLs and are downloaded eagerly; inbound voice yields text when QQ
includes ``asr_refer_text`` in the attachment. Outbound supports text, images,
and files (base64 rich-media upload). Replies use the inbound ``msg_id`` while
the platform's passive-reply quota is available; active messages share automatic
pacing and recovery with PawzoChat's proactive push service.
"""

from __future__ import annotations

import logging
import mimetypes
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

import requests

from pawzochat.channels.base import Channel
from pawzochat.store.quotes import media_blocks
from pawzochat.channels.wechat import _MIME_TO_EXT, _detect_mime
from pawzochat.paths import CHATS_DIR
from pawzochat.transport.models import Account
from pawzochat.transport.sender import MessageSender
from pawzochat.transport.qq.client import QQClient, QQClientError
from pawzochat.transport.qq.gateway import QQGateway
from pawzochat.transport.qq.dedup import EventDeduplicator
from pawzochat.transport.qq.models import (
    FILE_TYPE_AUDIO,
    FILE_TYPE_FILE,
    FILE_TYPE_IMAGE,
    MSG_TYPE_MEDIA,
    MSG_TYPE_TEXT,
    QQInboundMessage,
)

if TYPE_CHECKING:
    from pawzochat.app import App

logger = logging.getLogger(__name__)

_MAX_INBOUND_IMAGE_BYTES = 20 * 1024 * 1024
_MAX_INBOUND_VIDEO_BYTES = 30 * 1024 * 1024
_MAX_INBOUND_FILE_BYTES = 100 * 1024 * 1024
_MAX_INBOUND_VOICE_BYTES = 20 * 1024 * 1024
_QQ_TEXT_LIMIT = 5000
_PASSIVE_REPLY_LIMIT = 4
_PASSIVE_REPLY_TTL_SECONDS = 60 * 60
_MAX_TRACKED_REPLY_MESSAGES = 10_000


def _normalize_ts(ts: str) -> str | None:
    """Normalize a QQ message timestamp (ISO8601 or unix epoch) to a local ISO
    string the conversation store can parse. Returns None on anything odd so the
    store falls back to ``now()`` — keeps date-grouping and sorting consistent.
    """
    if not ts:
        return None
    try:
        if ts.isdigit():
            value = int(ts)
            if value > 1_000_000_000_000:  # milliseconds
                value //= 1000
            return datetime.fromtimestamp(value, tz=timezone.utc).astimezone().isoformat()
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().isoformat()
    except Exception:
        return None


def _new_msg_seq() -> int:
    """Generate the 16-bit passive-reply sequence used by the official SDK."""
    time_part = int(time.time() * 1000) % 100_000_000
    return (time_part ^ secrets.randbelow(1 << 16)) % (1 << 16)


def _split_qq_text(text: str, limit: int = _QQ_TEXT_LIMIT) -> list[str]:
    """Split only over-limit QQ text, preferring a newline boundary."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break
        cut = remaining.rfind("\n", 0, limit) + 1
        if cut <= 0:
            cut = limit
        chunks.append(remaining[:cut])
        remaining = remaining[cut:]
    return chunks


class QQChannel(Channel):
    channel_type = "qq"
    display_name = "QQ"

    def __init__(self, app: App):
        super().__init__(app)
        self._dedup = EventDeduplicator()
        self._clients: dict[str, QQClient] = {}
        self._gateways: dict[str, QQGateway] = {}
        # {(account_id, msg_id): (passive_count, first_used_at, warned)}.
        # QQ permits at most four passive replies for one inbound message.
        self._reply_usage: dict[tuple[str, str], tuple[int, float, bool]] = {}
        self._reply_lock = threading.Lock()
        # Inbound work (image downloads, queue handoff) runs here so a slow CDN
        # fetch never blocks a gateway's single WebSocket reader thread.
        self._inbound_pool = ThreadPoolExecutor(
            max_workers=4, thread_name_prefix="qq-inbound",
        )

    # ---- Per-account lifecycle ----

    def start_account(self, account: Account) -> None:
        # Idempotent: tear down any stale transport for this bot_id first so a
        # double-start can't leak an orphaned gateway thread / open socket.
        if account.bot_id in self._gateways or account.bot_id in self._clients:
            self.stop_account(account.bot_id)
        extra = account.extra or {}
        app_id = extra.get("app_id", "") or account.bot_id
        app_secret = extra.get("app_secret", "")
        sandbox = bool(extra.get("sandbox", False))
        client = QQClient(app_id, app_secret, sandbox=sandbox)
        self._clients[account.bot_id] = client
        client.push_policy.is_online = lambda: (
            self._clients.get(account.bot_id) is client and self.is_online(account.bot_id)
        )

        gateway = QQGateway(
            client,
            lambda msg, aid=account.bot_id: self.handle_incoming(aid, msg, client=client),
            label=account.bot_id[:8],
        )
        self._gateways[account.bot_id] = gateway
        gateway.start()
        logger.info("QQ 账号已启动: %s", account.bot_id)

    def stop_account(self, account_id: str) -> None:
        client = self._clients.pop(account_id, None)
        if client:
            client.close()
        gateway = self._gateways.pop(account_id, None)
        if gateway:
            gateway.stop()
        with self._reply_lock:
            for key in [k for k in self._reply_usage if k[0] == account_id]:
                self._reply_usage.pop(key, None)

    def shutdown(self) -> None:
        for account_id in set(self._clients) | set(self._gateways):
            self.stop_account(account_id)
        self._inbound_pool.shutdown(wait=False)

    def is_online(self, account_id: str) -> bool:
        gateway = self._gateways.get(account_id)
        return bool(gateway and gateway.running)

    # ---- Account creation metadata ----

    def account_form(self) -> dict:
        return {
            "method": "form",
            "hint": "需在 QQ 开放平台为机器人开通 C2C 私信消息权限",
            "fields": [
                {"key": "app_id", "label": "AppID", "required": True},
                {"key": "app_secret", "label": "AppSecret", "secret": True,
                 "required": True},
                {"key": "sandbox", "label": "沙箱环境", "type": "checkbox"},
                {"key": "note", "label": "备注", "required": False},
            ],
        }

    def validate_and_create(self, fields: dict) -> Account:
        app_id = (fields.get("app_id") or "").strip()
        app_secret = (fields.get("app_secret") or "").strip()
        if not app_id or not app_secret:
            raise ValueError("AppID 和 AppSecret 不能为空")
        sandbox = bool(fields.get("sandbox", False))

        # Verify the credentials by fetching an access token up front. The
        # validation client is throwaway (start_account builds its own), so
        # release its connection pool on both success and failure.
        client = QQClient(app_id, app_secret, sandbox=sandbox)
        try:
            client.get_access_token(force=True)
        except QQClientError as exc:
            raise ValueError(f"QQ 凭据校验失败：{exc}") from exc
        finally:
            client.close()

        return Account(
            bot_id=app_id,
            channel_type="qq",
            created_at=datetime.now(timezone.utc).isoformat(),
            note=(fields.get("note") or "").strip(),
            extra={"app_id": app_id, "app_secret": app_secret, "sandbox": sandbox},
        )

    # ---- Push policy ----

    def can_push_now(
        self,
        channel_link: dict,
        last_user_at: float,
        messages: list[dict],
    ) -> bool:
        if (channel_link.get("chat_type") or "single") != "single":
            return False
        return self.get_push_defer_reason(self.reply_ctx_from_link(channel_link)) is None

    def reply_ctx_from_link(self, channel_link: dict) -> dict:
        client = self._clients.get(channel_link.get("account_id", ""))
        return {
            **super().reply_ctx_from_link(channel_link),
            "reply_target": "",
            "msg_scope": "c2c",
            "generation": client.generation if client else "",
        }

    def is_reply_context_active(self, reply_ctx: dict) -> bool:
        client = self._clients.get(reply_ctx.get("account_id", ""))
        if not client or client._closed.is_set():
            return False
        if reply_ctx.get("generation") != client.generation:
            return False
        return self.get_push_defer_reason(reply_ctx) is None

    def get_push_defer_reason(self, reply_ctx: dict) -> str | None:
        if reply_ctx.get("_qq_defer_reason"):
            return reply_ctx["_qq_defer_reason"]
        account_id = reply_ctx.get("account_id", "")
        client = self._clients.get(account_id)
        if not client or client._closed.is_set():
            return "QQ 账号已停止"
        if reply_ctx.get("generation", client.generation) != client.generation:
            return "QQ 账号连接已更换"
        if not self.is_online(account_id):
            return "QQ 账号离线"
        peer = reply_ctx.get("user_id", "")
        if not peer:
            return "QQ 绑定缺少接收人"
        return client.push_policy.defer_reason(peer)

    def _reply_is_active(self, reply_key):
        if not reply_key[1]:
            return True
        with self._reply_lock:
            count, started, _ = self._reply_usage.get(reply_key, (0, time.monotonic(), False))
            return (
                count >= _PASSIVE_REPLY_LIMIT
                or time.monotonic() - started >= _PASSIVE_REPLY_TTL_SECONDS
            )

    @staticmethod
    def _check_active_upload(client, openid, active):
        client.check_open()
        if active:
            reason = client.push_policy.defer_reason(openid)
            if reason:
                raise QQClientError(reason, push_defer_reason=reason)

    # ---- Inbound ----

    def handle_incoming(self, account_id: str, message: QQInboundMessage, *, client=None) -> None:
        client = client or self._clients.get(account_id)
        if not client or self._clients.get(account_id) is not client:
            return
        ticket = self._dedup.reserve(account_id, message.msg_id)
        if ticket is None:
            return
        if not message.msg_id:
            logger.debug("[QQ] 消息缺少事件 ID，跳过去重")
        try:
            self._inbound_pool.submit(self._handle_incoming_blocking, account_id, message, ticket, client)
        except Exception:
            self._dedup.finish(account_id, message.msg_id, ticket, False)
            raise

    def remove_account_state(self, account_id):
        self._dedup.remove_account(account_id)

    def _handle_incoming_blocking(self, account_id, message, ticket, client):
        success = False
        message._queue_accepted = False
        try:
            self._process_inbound(account_id, message, client=client)
            success = True
        except Exception:
            logger.exception("[QQ] 处理入站消息失败")
        finally:
            self._dedup.finish(account_id, message.msg_id, ticket, success or message._queue_accepted)

    def _process_inbound(self, account_id: str, message: QQInboundMessage, *, client=None) -> None:
        client = client or self._clients.get(account_id)
        if not client or self._clients.get(account_id) is not client:
            return
        client.check_open()
        text = (message.content or "").strip()
        image_atts = message.image_attachments
        media_atts = message.video_attachments + message.file_attachments
        voice_atts = []
        for att in message.voice_attachments:
            transcript = att.asr_refer_text.strip()
            if not transcript:
                logger.info(
                    "[QQ] 收到语音消息，但事件未包含 asr_refer_text "
                    "(content_type=%s, filename=%s)",
                    att.content_type or "-",
                    att.filename or "-",
                )
                continue
            logger.info("[QQ] 已采用事件中的语音转写 (%d 字)", len(transcript))
            voice_atts.append(att)

        if not text and not image_atts and not media_atts and not voice_atts:
            return

        conversation = self._app.conversation_store.find_by_account(account_id)
        if not conversation:
            self._reply_no_binding(account_id, message, client=client)
            return

        persona_id = conversation["persona_id"]
        quote_data = {"quote": message.quote}
        if message.ref_msg_idx:
            quote_data = self._app.conversation_store.quotes.resolve(
                "qq", account_id, message.openid, message.ref_msg_idx, persona_id,
                inline=message.quote_text, inline_media=message.quote_media,
            )

        images = self._download_images(image_atts, persona_id) if image_atts else None
        files = self._download_files(media_atts, persona_id) if media_atts else None
        voices, failed_voice_texts = self._download_voices(voice_atts, persona_id)
        for transcript in failed_voice_texts:
            fallback = f"[语音] {transcript}"
            text = f"{text}\n{fallback}" if text else fallback

        if not text and not images and not files and not voices:
            raise QQClientError("QQ 入站媒体下载失败，等待事件重投")

        reply_ctx = {
            "channel": "qq",
            "account_id": account_id,
            "user_id": message.openid,
            "reply_target": message.msg_id,
            "msg_scope": "c2c",
            "generation": client.generation,
        }
        accepted = self._app.message_queue.accept_message(
            persona_id,
            text or "",
            source="qq",
            reply_ctx=reply_ctx,
            images=images or None,
            files=files or None,
            voices=voices or None,
            raw_message=message,
            account_id=account_id,
            user_id=message.openid,
            timestamp=_normalize_ts(message.timestamp),
            admission=client.admit,
            **quote_data,
        )
        message._queue_accepted = bool(accepted)
        with client._state_lock:
            if client._closed.is_set():
                return
            if accepted:
                client.push_policy.on_inbound(message.openid)
                message._queue_accepted = True
                actual_persona_id, _msg = accepted
                for platform_id in {message.msg_idx, message.msg_id} - {""}:
                    self._app.conversation_store.quotes.remember(
                        "qq", account_id, message.openid, platform_id, actual_persona_id,
                        _msg["local_id"], "\n".join(filter(None, [message.content] + [a.asr_refer_text for a in voice_atts])),
                        media_blocks(images, files, voices),
                    )
                self._app.conversation_store.update_channel_peer(
                    actual_persona_id, message.openid, chat_type="single",
                )
                if message.msg_id:
                    self._app.conversation_store.update_reply_target(
                        actual_persona_id, message.msg_id,
                    )

    def _download_voices(
        self,
        attachments,
        persona_id: str,
    ) -> tuple[list[dict], list[str]]:
        """Download QQ voice audio, preferring its browser-ready WAV URL."""
        if not attachments:
            return [], []

        from pawzochat.voice.transcode import normalize_inbound_audio

        voice_dir = CHATS_DIR / persona_id / "voice"
        voice_dir.mkdir(parents=True, exist_ok=True)
        result: list[dict] = []
        failed: list[str] = []

        for att in attachments:
            transcript = att.asr_refer_text.strip()
            source_url = att.voice_wav_url or att.url
            if not source_url:
                logger.warning("[QQ] 语音缺少下载 URL")
                failed.append(transcript)
                continue
            try:
                raw = self._fetch_url(source_url, _MAX_INBOUND_VOICE_BYTES)
                playable, ext, mime, duration_ms = normalize_inbound_audio(raw)
                save_path = voice_dir / f"voice_{secrets.token_hex(4)}{ext}"
                save_path.write_bytes(playable)
            except Exception as exc:
                logger.warning("[QQ] 语音下载或转码失败 (%s)", type(exc).__name__)
                failed.append(transcript)
                continue
            result.append({
                "path": str(save_path),
                "mime": mime,
                "duration_ms": duration_ms,
                "text": transcript,
            })
            logger.info(
                "QQ 语音已保存: %s (%d bytes, %s, %dms)",
                save_path.name, len(playable), mime, duration_ms,
            )
        return result, failed

    def _download_images(self, attachments, persona_id: str) -> list[dict]:
        img_dir = CHATS_DIR / persona_id / "images"
        img_dir.mkdir(parents=True, exist_ok=True)

        result: list[dict] = []
        for att in attachments:
            raw = self._download_attachment(att, _MAX_INBOUND_IMAGE_BYTES, "图片")
            if raw is None:
                continue
            # Derive mime/ext from the actual bytes (magic number) rather than
            # trusting the attachment's declared content_type.
            mime = _detect_mime(raw)
            ext = _MIME_TO_EXT.get(mime, ".jpg")
            save_path = img_dir / f"img_{secrets.token_hex(4)}{ext}"
            save_path.write_bytes(raw)
            result.append({
                "data": raw,
                "mime": mime,
                "path": str(save_path),
            })
            logger.info(
                "QQ 图片已保存: %s (%d bytes, %s)", save_path.name, len(raw), mime,
            )
        return result

    def _download_files(self, attachments, persona_id: str) -> list[dict]:
        """Download video/file attachments to ``…/files/`` and return
        ``{path, name, mime}`` content blocks.

        Unlike images these are not fed to the LLM as bytes — they become a
        ``[文件]`` name/mime hint (see ``chat._file_parts``). The original
        QQ filename is preserved when present.
        """
        files_dir = CHATS_DIR / persona_id / "files"
        files_dir.mkdir(parents=True, exist_ok=True)

        result: list[dict] = []
        for att in attachments:
            if att.is_video:
                max_bytes, label = _MAX_INBOUND_VIDEO_BYTES, "视频"
            else:
                max_bytes, label = _MAX_INBOUND_FILE_BYTES, "文件"
            raw = self._download_attachment(att, max_bytes, label)
            if raw is None:
                continue
            original_name = att.filename or ""
            ext = Path(original_name).suffix
            if not ext:
                ext = mimetypes.guess_extension(att.content_type or "") or ""
            save_path = files_dir / f"file_{secrets.token_hex(4)}{ext}"
            save_path.write_bytes(raw)
            name = original_name or save_path.name
            mime = (
                att.content_type
                or mimetypes.guess_type(name)[0]
                or "application/octet-stream"
            )
            result.append({
                "path": str(save_path),
                "name": name,
                "mime": mime,
            })
            logger.info(
                "QQ %s已保存: %s (%d bytes, %s)", label, save_path.name, len(raw), mime,
            )
        return result

    def _download_attachment(self, att, max_bytes: int, label: str) -> bytes | None:
        """Fetch one attachment's bytes, enforcing *max_bytes*. Returns ``None``
        on oversize or download failure (logged, never raises) so callers can
        skip the item without aborting the whole message."""
        if att.size and att.size > max_bytes:
            logger.warning("[QQ] 跳过超限%s size=%d", label, att.size)
            return None
        try:
            return self._fetch_url(att.url, max_bytes)
        except Exception as exc:
            logger.warning("[QQ] 下载%s失败 (%s)", label, type(exc).__name__)
            return None

    @staticmethod
    def _fetch_url(url: str, max_bytes: int) -> bytes:
        with requests.get(url, stream=True, timeout=30) as resp:
            resp.raise_for_status()
            chunks = bytearray()
            for chunk in resp.iter_content(8192):
                chunks.extend(chunk)
                if len(chunks) > max_bytes:
                    raise ValueError("媒体超过大小限制")
            return bytes(chunks)

    def _reply_no_binding(self, account_id: str, message: QQInboundMessage, *, client=None) -> None:
        client = client or self._clients.get(account_id)
        if not client or not message.openid:
            return
        try:
            client.send_c2c_message(
                message.openid,
                content="当前尚未绑定任何角色",
                msg_type=MSG_TYPE_TEXT,
                msg_id=message.msg_id,
                msg_seq=_new_msg_seq(),
            )
        except QQClientError:
            logger.debug("[QQ] 未绑定提示发送失败", exc_info=True)

    # ---- Outbound ----

    def deliver_message(
        self,
        persona_id: str,
        message: dict,
        reply_ctx: dict | None = None,
        *,
        is_first: bool = False,
        is_last: bool = False,
    ) -> bool:
        if not reply_ctx:
            return False
        account_id = reply_ctx.get("account_id", "")
        openid = reply_ctx.get("user_id", "")
        msg_id = reply_ctx.get("reply_target", "")
        client = self._clients.get(account_id)
        if not client or not openid:
            return False
        # Pin legacy direct callers too; generated and inbound contexts already
        # carry their generation before any model work begins.
        reply_ctx.setdefault("generation", client.generation)
        if reply_ctx["generation"] != client.generation or client._closed.is_set():
            return False
        if reply_ctx.get("_qq_send_failed"):
            return False

        reply_key = (account_id, msg_id)
        if self._reply_is_active(reply_key):
            reason = self.get_push_defer_reason(reply_ctx)
            if reason:
                reply_ctx["_qq_defer_reason"] = reason
                return False

        if not is_first:
            reply_cfg = self._app.config.get("reply", default={})
            delay = MessageSender.estimate_message_delay(message, reply_cfg)
            if delay and client._closed.wait(delay):
                return False

        def failed():
            if self._reply_is_active(reply_key):
                reply_ctx["_qq_send_failed"] = True
                reason = self.get_push_defer_reason(reply_ctx)
                if reason:
                    reply_ctx["_qq_defer_reason"] = reason
            return False

        def on_error(error):
            if error.push_defer_reason:
                reply_ctx["_qq_defer_reason"] = error.push_defer_reason

        def on_sent(response, body="", blocks=()):
            with client._state_lock:
                if client._closed.is_set() or self._clients.get(account_id) is not client:
                    return
                self._app.conversation_store.quotes.remember(
                    "qq", account_id, openid, (response.get("ext_info") or {}).get("ref_idx"),
                    persona_id, message.get("local_id", ""), body, blocks,
                )

        content_blocks = message.get("content", []) or []
        delivered = True
        for block in content_blocks:
            btype = block.get("type")
            path = block.get("path", "")
            block_delivered = True
            if btype in {"emoji", "image"} and path:
                block_delivered = self._send_media(
                    client, openid, reply_key, path, FILE_TYPE_IMAGE, on_sent=on_sent, on_error=on_error,
                    block={**block, "type": "image"},
                )
            elif btype == "file" and path:
                block_delivered = self._send_media(
                    client, openid, reply_key, path, FILE_TYPE_FILE, on_sent=on_sent, on_error=on_error, block=block,
                )
            elif btype == "voice" and path:
                block_delivered = self._send_voice(
                    client, openid, reply_key, path, on_sent=on_sent, on_error=on_error, block=block,
                )
            if not block_delivered:
                delivered = False
                if self._reply_is_active(reply_key):
                    return failed()

        text = "".join(
            block.get("text", "")
            for block in content_blocks
            if block.get("type") == "text"
        )
        if text.strip() and not self._send_text(
            client, openid, reply_key, text, on_sent=on_sent, on_error=on_error,
        ):
            return failed()
        return delivered

    def _send_text(self, client, openid, reply_key, text, *, on_sent=None, on_error=None) -> bool:
        for chunk in _split_qq_text(text):
            reply_msg_id, msg_seq = self._next_reply_params(reply_key)
            try:
                response = client.send_c2c_message(
                    openid,
                    content=chunk,
                    msg_type=MSG_TYPE_TEXT,
                    msg_id=reply_msg_id,
                    msg_seq=msg_seq,
                )
                if on_sent:
                    on_sent(response, chunk)
            except QQClientError as exc:
                if on_error:
                    on_error(exc)
                logger.exception("[QQ] 文本消息发送失败")
                return False
        return True

    @staticmethod
    def _upload_progress(account_id, path):
        from pawzochat.web.sse import broadcast
        def progress(done, total):
            broadcast("channel_upload", account_id=account_id, name=Path(path).name,
                      uploaded=done, total=total)
        return progress

    @staticmethod
    def _upload_error(account_id, path, error):
        from pawzochat.web.sse import broadcast
        broadcast("channel_upload", account_id=account_id, name=Path(path).name, error=str(error))

    def _send_media(self, client, openid, reply_key, path, file_type, *, on_sent=None, on_error=None, block=None) -> bool:
        """Upload a local file as C2C rich media (image / file / video / audio,
        per *file_type*) then send it. Returns False on any failure — including
        a QQClientError, which covers QQ rejecting an unsupported file type or
        extension, so the caller logs rather than silently swallowing it."""
        active = self._reply_is_active(reply_key)
        try:
            self._check_active_upload(client, openid, active)
            uploaded = client.upload_c2c_media_path(
                openid, path, file_type=file_type,
                file_name=Path(path).name if file_type == FILE_TYPE_FILE else "",
                on_progress=self._upload_progress(reply_key[0], path),
            )
            file_info = uploaded["file_info"]
            reply_msg_id, msg_seq = self._next_reply_params(reply_key)
            active = not reply_msg_id
            response = client.send_c2c_message(
                openid,
                content="",
                msg_type=MSG_TYPE_MEDIA,
                msg_id=reply_msg_id,
                msg_seq=msg_seq,
                media={"file_info": file_info},
            )
            if on_sent:
                on_sent(response, "", [block] if block else [])
            return True
        except QQClientError as exc:
            if active:
                client.push_policy.record_failure(openid, exc)
            if on_error:
                on_error(exc)
            self._upload_error(reply_key[0], path, exc)
            logger.exception("[QQ] 媒体消息发送失败 (file_type=%s): %s", file_type, path)
            return False

    def _send_voice(self, client, openid, reply_key, path, *, on_sent=None, on_error=None, block=None) -> bool:
        """Transcode TTS audio to SILK and send it as a real voice bubble via file_type=3 (audio).

        QQ's official API requires audio in SILK format; when the transcode
        dependency is missing or fails, this falls back to sending the plain
        MP3 as a file so the content still gets through.
        """
        active = self._reply_is_active(reply_key)
        try:
            self._check_active_upload(client, openid, active)
            if Path(path).stat().st_size > 20 * 1024 * 1024:
                self._upload_error(reply_key[0], path, "语音文件超过 20 MiB")
                return False
            audio_bytes = Path(path).read_bytes()
        except (OSError, QQClientError) as exc:
            if isinstance(exc, QQClientError) and on_error:
                on_error(exc)
            logger.warning("[QQ] 语音文件不可读或通道暂不可发送: %s", path)
            return False

        try:
            from pawzochat.voice.transcode import mp3_to_silk

            silk_bytes, _duration_ms = mp3_to_silk(audio_bytes)
        except Exception:
            logger.warning(
                "[QQ] MP3→SILK 转码失败，降级为文件发送: %s", path, exc_info=True,
            )
            return self._send_media(
                client, openid, reply_key, path, FILE_TYPE_FILE, on_sent=on_sent, on_error=on_error,
                block={**(block or {}), "type": "file"},
            )

        try:
            uploaded = client.upload_c2c_media(
                openid, silk_bytes, file_type=FILE_TYPE_AUDIO,
                on_progress=self._upload_progress(reply_key[0], path),
            )
            file_info = uploaded["file_info"]
            reply_msg_id, msg_seq = self._next_reply_params(reply_key)
            active = not reply_msg_id
            response = client.send_c2c_message(
                openid,
                content="",
                msg_type=MSG_TYPE_MEDIA,
                msg_id=reply_msg_id,
                msg_seq=msg_seq,
                media={"file_info": file_info},
            )
            if on_sent:
                on_sent(response, "", [block] if block else [])
            return True
        except QQClientError as exc:
            if active:
                client.push_policy.record_failure(openid, exc)
            if on_error:
                on_error(exc)
            self._upload_error(reply_key[0], path, exc)
            logger.exception("[QQ] 语音消息发送失败: %s", path)
            return False

    def _next_reply_params(self, reply_key: tuple[str, str]) -> tuple[str, int]:
        """Reserve a passive reply, falling back to an active send after four."""
        msg_id = reply_key[1]
        if not msg_id:
            return "", 1
        now = time.monotonic()
        with self._reply_lock:
            if (
                reply_key not in self._reply_usage
                and len(self._reply_usage) >= _MAX_TRACKED_REPLY_MESSAGES
            ):
                oldest = min(
                    self._reply_usage,
                    key=lambda key: self._reply_usage[key][1],
                )
                self._reply_usage.pop(oldest, None)
            count, first_used_at, warned = self._reply_usage.get(
                reply_key, (0, now, False),
            )
            if now - first_used_at >= _PASSIVE_REPLY_TTL_SECONDS:
                if not warned:
                    logger.info(
                        "[QQ] msg_id=%s 已超过被动回复时限，改用主动发送",
                        msg_id[:16],
                    )
                self._reply_usage[reply_key] = (count, first_used_at, True)
                return "", 1
            if count >= _PASSIVE_REPLY_LIMIT:
                if not warned:
                    logger.info(
                        "[QQ] msg_id=%s 已使用 4 次被动回复，后续分段改用主动发送",
                        msg_id[:16],
                    )
                self._reply_usage[reply_key] = (count, first_used_at, True)
                return "", 1
            self._reply_usage[reply_key] = (count + 1, first_used_at, warned)
        return msg_id, _new_msg_seq()
