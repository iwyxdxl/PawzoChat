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

"""Application bootstrap, lifecycle management, and thread orchestration."""

from __future__ import annotations

import logging
import signal
import sys
import threading
import webbrowser

from pawzochat.channels.qq import QQChannel
from pawzochat.channels.registry import ChannelRegistry
from pawzochat.channels.web import WebChannel
from pawzochat.channels.wechat import WeChatChannel
from pawzochat.core.config import ConfigManager
from pawzochat.core.extensions.manager import ExtensionManager
from pawzochat.core.extensions.installer import PluginInstaller
from pawzochat.image.manager import ImageManager
from pawzochat.voice.manager import VoiceManager
from pawzochat.llm.manager import LLMManager
from pawzochat.mcp.adapters import CapabilityAdapterRegistry
from pawzochat.mcp.manager import MCPManager
from pawzochat.paths import CERTS_DIR
from pawzochat.services.chat import ChatService
from pawzochat.services.group_chat import GroupChatService
from pawzochat.services.emoji import EmojiService
from pawzochat.services.memory import MemoryService
from pawzochat.services.group_memory import GroupMemoryService
from pawzochat.services.message_queue import MessageQueue
from pawzochat.services.moments import MomentsService
from pawzochat.services.proactive import ProactiveService
from pawzochat.services.reply_dispatcher import ReplyDispatcher
from pawzochat.services.telemetry import TelemetryService
from pawzochat.services.worldbook import WorldbookService
from pawzochat.store.conversation import ConversationStore
from pawzochat.store.group_conversation import GroupConversationStore
from pawzochat.store.moments import MomentsStore
from pawzochat.transport.auth import AuthManager
from pawzochat.transport.models import Account
from pawzochat.utils.log import resolve_log_level, setup_logging
from pawzochat.utils.port_lock import ensure_listen_port_free

logger = logging.getLogger(__name__)


class App:
    """Central application object wiring all subsystems together."""

    def __init__(self):
        self.config = ConfigManager()
        self.conversation_store = ConversationStore()
        self.group_store = GroupConversationStore()
        self.moments_store = MomentsStore()
        self.llm_manager = LLMManager()
        self.image_manager = ImageManager()
        self.voice_manager = VoiceManager()
        self.mcp_manager = MCPManager()
        self.extension_manager = ExtensionManager(
            self,
            self.config,
            self.conversation_store,
            self.llm_manager,
            mcp_manager=self.mcp_manager,
        )
        self.installer = PluginInstaller(self.extension_manager, self.config)
        self.capability_registry: CapabilityAdapterRegistry | None = None
        self.memory_service: MemoryService | None = None
        self.group_memory_service: GroupMemoryService | None = None
        self.worldbook_service: WorldbookService | None = None
        self.chat_service: ChatService | None = None
        self.group_chat_service: GroupChatService | None = None
        self.emoji_service: EmojiService | None = None
        self.message_queue: MessageQueue | None = None
        self.reply_dispatcher: ReplyDispatcher | None = None
        # Channel registry must exist before extension_manager.start() so
        # plugin channels can register during plugin setup. It's the single
        # source of truth for channels — built-ins aren't held as attributes.
        self.channel_registry = ChannelRegistry()
        self.proactive_service: ProactiveService | None = None
        self.moments_service: MomentsService | None = None
        self.telemetry: TelemetryService | None = None

        self.accounts: list[Account] = []
        # Guards the in-memory roster against concurrent web-worker mutations
        # (create/QR-confirm append vs delete reassign). RLock so a locked
        # caller can call helpers that re-take it without deadlocking.
        self._accounts_lock = threading.RLock()
        self._auth_manager: AuthManager | None = None
        self._web_servers: list = []
        self._shutdown_event = threading.Event()

        if getattr(sys, "frozen", False):
            from pawzochat.updater import UpdateChecker
            self.updater: UpdateChecker | None = UpdateChecker()
        else:
            self.updater = None

    # ---- Lifecycle ----

    def start(self):
        self.config.load()

        setup_logging(resolve_log_level(self.config.get("log_level", default="info")))
        logger.info("=" * 50)
        logger.info("  PawzoChat 启动中…")
        logger.info("=" * 50)

        # Recover before any plugin discovery; logging is already available
        # so a failed recovery leaves actionable diagnostics.
        self.installer.configure()
        self.installer.startup_cleanup()

        self.llm_manager.init_from_config(self.config.get("llm_providers", default={}))
        if not self.llm_manager.available_providers:
            logger.warning("没有配置有效的对话 Provider — 请在设置-对话服务商中添加")

        self.image_manager.init_from_config(self.config.get("image_providers", default={}))
        if self.image_manager.available_providers:
            logger.info(
                "已加载 %d 个生图 Provider", len(self.image_manager.available_providers),
            )

        self.voice_manager.init_from_config(self.config.get("voice_providers", default={}))
        if self.voice_manager.available_providers:
            logger.info(
                "已加载 %d 个语音 Provider", len(self.voice_manager.available_providers),
            )

        mcp_cfg = self.config.get("mcp_servers", default={})
        if mcp_cfg:
            self.mcp_manager.start(mcp_cfg)

        self.capability_registry = CapabilityAdapterRegistry(self.mcp_manager)
        self.extension_manager.set_capability_registry(self.capability_registry)
        from pawzochat.mcp.builtin.image_generation import (
            TOOL_DESCRIPTION as _IMG_DESC,
            TOOL_NAME as _IMG_NAME,
            TOOL_PARAMETERS as _IMG_PARAMS,
            make_handler as _make_image_handler,
        )
        self.capability_registry.register_builtin(
            name=_IMG_NAME,
            description=_IMG_DESC,
            parameters=_IMG_PARAMS,
            handler=_make_image_handler(self),
        )
        from pawzochat.mcp.builtin.view_reference_image import (
            TOOL_DESCRIPTION as _VIEW_REF_DESC,
            TOOL_NAME as _VIEW_REF_NAME,
            TOOL_PARAMETERS as _VIEW_REF_PARAMS,
            make_handler as _make_view_ref_handler,
        )
        self.capability_registry.register_builtin(
            name=_VIEW_REF_NAME,
            description=_VIEW_REF_DESC,
            parameters=_VIEW_REF_PARAMS,
            handler=_make_view_ref_handler(self),
        )
        from pawzochat.mcp.builtin.memory_tools import (
            RECORD_TOOL_DESCRIPTION as _MEM_REC_DESC,
            RECORD_TOOL_NAME as _MEM_REC_NAME,
            RECORD_TOOL_PARAMETERS as _MEM_REC_PARAMS,
            UPDATE_TOOL_DESCRIPTION as _MEM_UPD_DESC,
            UPDATE_TOOL_NAME as _MEM_UPD_NAME,
            UPDATE_TOOL_PARAMETERS as _MEM_UPD_PARAMS,
            make_handlers as _make_memory_handlers,
        )
        _record_handler, _update_handler = _make_memory_handlers(self)
        self.capability_registry.register_builtin(
            name=_MEM_REC_NAME,
            description=_MEM_REC_DESC,
            parameters=_MEM_REC_PARAMS,
            handler=_record_handler,
        )
        self.capability_registry.register_builtin(
            name=_MEM_UPD_NAME,
            description=_MEM_UPD_DESC,
            parameters=_MEM_UPD_PARAMS,
            handler=_update_handler,
        )
        adapters_cfg = self.config.get("capability_adapters", default={})
        if adapters_cfg:
            self.capability_registry.load_from_config(adapters_cfg)

        self.memory_service = MemoryService(
            config=self.config,
            store=self.conversation_store,
            llm_manager=self.llm_manager,
        )
        self.group_memory_service = GroupMemoryService(
            config=self.config, group_store=self.group_store,
            private_memory_service=self.memory_service,
        )

        self.worldbook_service = WorldbookService(config=self.config)

        self.chat_service = ChatService(
            store=self.conversation_store,
            config=self.config,
            llm_manager=self.llm_manager,
            mcp_manager=self.mcp_manager,
            capability_registry=self.capability_registry,
            extension_manager=self.extension_manager,
            memory_service=self.memory_service,
            group_memory_service=self.group_memory_service,
            worldbook_service=self.worldbook_service,
            image_manager=self.image_manager,
            voice_manager=self.voice_manager,
        )

        self.emoji_service = EmojiService(self.config, self.llm_manager)
        self.group_chat_service = GroupChatService(self)
        self.moments_service = MomentsService(self)
        self.reply_dispatcher = ReplyDispatcher(self)
        self.message_queue = MessageQueue(self)
        self.channel_registry.register(WebChannel(self))
        self.channel_registry.register(WeChatChannel(self))
        self.channel_registry.register(QQChannel(self))
        self.proactive_service = ProactiveService(self)
        self.extension_manager.start()
        self.installer.start_update_checker()
        self.message_queue.start()
        self.proactive_service.start()
        self.moments_service.start()

        self._auth_manager = AuthManager()

        saved_accounts = self._auth_manager.load_accounts()
        if saved_accounts:
            logger.info("发现 %d 个已保存账号，正在恢复…", len(saved_accounts))
            for acc in saved_accounts:
                self._start_account(acc)
        else:
            logger.info("未发现已保存账号，等待通过 Web 面板扫码登录…")

        self.telemetry = TelemetryService(self.config)
        self.telemetry.start()

        self._start_web_server()
        self._print_access_info()
        self._start_update_check()

        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

        logger.info("PawzoChat 运行中，按 Ctrl+C 退出")
        self._shutdown_event.wait()

    def shutdown(self):
        import os

        logger.info("正在关闭 PawzoChat…")

        # Watchdog: force-exit if shutdown blocks (SSE long connections, Cheroot workers, etc.)
        def _watchdog():
            logger.warning("关闭超时，强制退出")
            os._exit(1)

        wd = threading.Timer(5.0, _watchdog)
        wd.daemon = True
        wd.start()
        self.installer.stop()

        # Best-effort offline notify, fired FIRST and concurrently (no join) so
        # they get maximum wall-clock before exit without serializing N×timeout
        # into the 5s watchdog window.
        for channel in self.channel_registry.all():
            channel.notify_offline()

        if self.telemetry:
            self.telemetry.stop()
        if self.group_chat_service:
            self.group_chat_service.shutdown()
        for srv in self._web_servers:
            try:
                srv.stop()
            except Exception:
                logger.debug("Web server stop error", exc_info=True)
        for channel in self.channel_registry.all():
            # Plugin channels are stopped with their runtime under the manager
            # transaction lock, after callback admission has been closed.
            if not channel.channel_type.startswith("plugin:"):
                channel.shutdown()
        if self.proactive_service:
            self.proactive_service.stop()
        if self.moments_service:
            self.moments_service.stop()
        if self.message_queue:
            self.message_queue.stop()
        self.extension_manager.stop()
        self.mcp_manager.stop()

        wd.cancel()
        logger.info("PawzoChat 已关闭")
        self._shutdown_event.set()

    # ---- Web server ----

    def _start_web_server(self):
        from cheroot.wsgi import Server as WSGIServer

        from pawzochat.web.app import SecretPrefixMiddleware, create_app

        port = int(self.config.get("web", "port", default=62000))
        ensure_listen_port_free(port, "127.0.0.1", label="本地面板")

        flask_app = create_app(self)
        flask_app.config["LOCAL_LISTEN_PORT"] = port

        local_server = WSGIServer(("127.0.0.1", port), flask_app)
        self._web_servers.append(local_server)
        threading.Thread(
            target=local_server.safe_start,
            name="web-local",
            daemon=True,
        ).start()
        url = f"http://127.0.0.1:{port}"
        logger.info("本地面板已启动: %s", url)

        def _open_browser():
            try:
                webbrowser.open(url)
            except Exception:
                logger.debug("自动打开浏览器失败", exc_info=True)

        threading.Timer(1.0, _open_browser).start()

        if self.config.get("web", "public_enabled", default=False):
            public_port = int(self.config.get("web", "public_port", default=0))
            secret = self.config.get("web", "public_secret", default="")
            if not self.config.get("web", "password", default=""):
                logger.warning("公网访问已启用但未设置密码，已跳过启动公网服务器")
            elif public_port and secret:
                from cheroot.ssl.builtin import BuiltinSSLAdapter
                from pawzochat.utils.certs import ensure_self_signed_cert

                ensure_listen_port_free(public_port, "0.0.0.0", label="公网面板")

                cert_path, key_path = ensure_self_signed_cert(CERTS_DIR)
                public_mw = SecretPrefixMiddleware(flask_app.wsgi_app, secret)
                flask_app.config["PUBLIC_MIDDLEWARE"] = public_mw

                public_server = WSGIServer(("0.0.0.0", public_port), public_mw)
                public_server.ssl_adapter = BuiltinSSLAdapter(
                    str(cert_path), str(key_path),
                )

                # Cheroot writes error_log directly to stderr, bypassing
                # Python logging filters.  Override to suppress noisy TLS
                # handshake failures caused by self-signed cert rejections.
                _orig_error_log = public_server.error_log

                def _quiet_error_log(msg="", level=20, traceback=False):
                    if "peer dropped the TLS connection suddenly" in str(msg):
                        return
                    _orig_error_log(msg, level, traceback)

                public_server.error_log = _quiet_error_log
                self._web_servers.append(public_server)
                threading.Thread(
                    target=public_server.safe_start,
                    name="web-public",
                    daemon=True,
                ).start()
                logger.info(
                    "公网面板已启动 (HTTPS): 0.0.0.0:%s/%s", public_port, secret,
                )

    def _print_access_info(self):
        """Print access URLs to the console after startup."""
        port = int(self.config.get("web", "port", default=62000))
        public_enabled = self.config.get("web", "public_enabled", default=False)
        public_port = int(self.config.get("web", "public_port", default=0))
        secret = self.config.get("web", "public_secret", default="")

        logger.info("=" * 40)
        logger.info("  访问信息")
        logger.info("=" * 40)
        logger.info("  本地地址: http://127.0.0.1:%s", port)
        if public_enabled and public_port and secret:
            logger.info(
                "  公网地址: https://你的公网IP:%s/%s", public_port, secret,
            )
        logger.info("=" * 40)

    # ---- Update ----

    def _start_update_check(self):
        if not self.updater:
            return

        def _check():
            try:
                result = self.updater.check()
                if result.get("has_update"):
                    logger.info(
                        "有新版本可用: v%s", result.get("latest_version", "?"),
                    )
            except Exception:
                logger.debug("后台更新检查出错", exc_info=True)

        threading.Thread(target=_check, name="update-check", daemon=True).start()

    # ---- Internal ----

    def _signal_handler(self, signum, frame):
        self.shutdown()

    def _start_account(self, account: Account):
        with self._accounts_lock:
            if any(a.bot_id == account.bot_id for a in self.accounts):
                # A concurrent confirmation already enrolled this account; don't
                # spin up a second transport for the same bot_id.
                logger.info("账号 %s 已在线，忽略重复启动", account.bot_id)
                return
            self.accounts.append(account)
        channel = self.channel_registry.get(account.channel_type, default=None)
        if channel is None:
            # Channel not registered yet (e.g. a plugin channel whose plugin is
            # disabled/broken). Keep the account on the roster but offline; it
            # will be brought up when the channel registers (see retry_deferred).
            logger.warning(
                "账号 %s 的通道 %s 尚未注册，暂不上线",
                account.bot_id, account.channel_type,
            )
            return
        channel.start_account(account)

    def retry_deferred_accounts(self, channel_type: str) -> None:
        """Bring online restored accounts whose channel just became available.

        Called when a plugin channel registers (e.g. a plugin is enabled at
        runtime) so its previously-saved accounts, skipped during restore, come
        up without a restart.
        """
        channel = self.channel_registry.get(channel_type, default=None)
        if channel is None:
            return
        for acc in self.accounts:
            if acc.channel_type == channel_type and not channel.is_online(acc.bot_id):
                try:
                    channel.start_account(acc)
                except Exception:
                    logger.exception("延迟启动账号失败: %s", acc.bot_id)
