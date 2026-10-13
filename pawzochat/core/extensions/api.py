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

"""Public extension API exposed to third-party plugins."""

from __future__ import annotations

import copy
import logging
import re
import secrets
import shutil
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Mapping

from pawzochat.llm.base import ContentBlock, LLMResponse
from pawzochat.paths import CHATS_DIR
from pawzochat.services.proactive import scan_last_user_at

if TYPE_CHECKING:
    from pawzochat.app import App
    from pawzochat.core.config import ConfigManager
    from pawzochat.core.extensions.hooks import HookRegistrar
    from pawzochat.llm.manager import LLMManager
    from pawzochat.mcp.adapters import CapabilityAdapterRegistry
    from pawzochat.mcp.manager import MCPManager
    from pawzochat.store.conversation import ConversationStore


logger = logging.getLogger(__name__)

_PLUGIN_TOOL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_]*$")


def _coerce_handler_result(raw: Any) -> list[ContentBlock]:
    """Convert a plugin handler's dict-shaped return value to ContentBlock.

    Accepts:
      * ``list[dict]`` where each item is
        ``{"type": "text"|"image", "text": str, "data": str | None,
        "mime"|"mime_type": str, "uri": str}`` — same shape
        ``ctx.mcp.call_tool`` returns. Both ``mime`` and ``mime_type``
        keys are accepted (``pending_images`` uses the short ``mime``).
      * ``list[ContentBlock]`` for advanced plugins that import the
        internal type — passed through as-is.
      * Plain ``str`` — coerced to a single text block (handler shorthand).

    Anything else is wrapped as a single text block so the LLM still
    sees something rather than the round breaking.
    """
    if isinstance(raw, str):
        return [ContentBlock(type="text", text=raw)]
    if not isinstance(raw, list):
        return [ContentBlock(type="text", text=str(raw))]
    out: list[ContentBlock] = []
    for item in raw:
        if isinstance(item, ContentBlock):
            out.append(item)
            continue
        if isinstance(item, Mapping):
            mime = item.get("mime_type")
            if mime is None:
                mime = item.get("mime")
            out.append(ContentBlock(
                type=str(item.get("type") or "text"),
                text=item.get("text"),
                data=item.get("data"),
                mime_type=mime,
                uri=item.get("uri"),
            ))
            continue
        out.append(ContentBlock(type="text", text=str(item)))
    return out


@dataclass(frozen=True)
class PluginManifest:
    """Static plugin metadata loaded from ``plugin.yaml``."""

    id: str
    name: str
    version: str
    api_version: int
    entrypoint: str
    description: str = ""
    author: str = ""
    hooks: list[str] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)
    permissions: list[str] = field(default_factory=list)
    config_schema: dict = field(default_factory=dict)
    config_ui: dict = field(default_factory=dict)
    platforms: tuple[str, ...] = ()


class Plugin(ABC):
    """Base class for all third-party plugins."""

    @abstractmethod
    def setup(self, ctx: PluginContext) -> None:
        """Called once after the plugin is loaded."""

    def teardown(self) -> None:
        """Called once before the plugin is unloaded."""


class ConversationFacade:
    """Readonly conversation access for plugins."""

    def __init__(self, store: ConversationStore):
        self._store = store

    def get_conversation(self, persona_id: str) -> dict | None:
        return copy.deepcopy(self._store.get_conversation(persona_id))

    def get_recent_rounds(self, persona_id: str, count: int) -> list[dict]:
        return copy.deepcopy(self._store.get_recent_rounds(persona_id, count))

    def list_conversations(self) -> list[dict]:
        return copy.deepcopy(self._store.list_conversations())


class PersonaFacade:
    """Readonly persona access for plugins."""

    def __init__(self, config: ConfigManager):
        self._config = config

    def get(self, persona_id: str):
        return copy.deepcopy(self._config.load_personas().get(persona_id))

    def all(self) -> dict:
        return copy.deepcopy(self._config.load_personas())


class LLMFacade:
    """Controlled LLM access for plugins.

    Two call modes:
      * ``chat(provider_name, ...)`` — caller picks the provider explicitly.
      * ``chat_as_persona(persona_id, ...)`` — reuse the persona's bound
        provider / model / temperature / max_tokens, with optional overrides.

    Neither method is permission-gated; declaring an LLM call in code is
    self-documenting and the existing ``chat()`` predates the permission
    system.
    """

    def __init__(self, llm_manager: LLMManager, config_manager: ConfigManager):
        self._llm_manager = llm_manager
        self._config = config_manager

    def chat(
        self,
        provider_name: str,
        messages: list[dict],
        *,
        model: str = "",
        temperature: float = 1.0,
        max_tokens: int = 1000,
        tools: list[dict] | None = None,
    ) -> LLMResponse:
        provider = self._llm_manager.get_provider(provider_name)
        if not provider:
            raise RuntimeError(f"LLM provider not available: {provider_name}")
        return provider.chat(
            messages,
            tools=tools,
            model=model or None,
            temperature=temperature,
            max_tokens=max_tokens,
        )

    def chat_as_persona(
        self,
        persona_id: str,
        messages: list[dict],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict] | None = None,
    ) -> LLMResponse:
        """Call the LLM using the persona's bound provider + settings.

        Each call re-reads the persona config, so panel changes to model /
        temperature take effect without reloading the plugin.

        Raises:
            ValueError: ``persona_id`` does not exist.
            RuntimeError: the persona's bound provider is not registered
                (missing API key or absent from current config).
        """
        persona = self._config.load_personas().get(persona_id)
        if not persona:
            raise ValueError(f"Persona not found: {persona_id}")
        provider_name = persona.get("llm_provider") or ""
        provider = self._llm_manager.get_provider(provider_name)
        if not provider:
            raise RuntimeError(
                f"Persona '{persona_id}' bound provider '{provider_name}' is not available"
            )
        return provider.chat(
            messages,
            tools=tools,
            model=model if model is not None else (persona.get("llm_model") or None),
            temperature=temperature if temperature is not None else persona.get("temperature", 1.0),
            max_tokens=max_tokens if max_tokens is not None else persona.get("max_tokens", 1000),
        )

    def list_providers(self) -> list[str]:
        """Names of LLM providers currently registered (have valid API key)."""
        return list(self._llm_manager.available_providers)

    def get_persona_binding(self, persona_id: str) -> dict | None:
        """Return the persona's LLM binding snapshot, or None if persona is unknown.

        Shape: ``{"provider": str, "model": str, "temperature": float, "max_tokens": int}``
        """
        persona = self._config.load_personas().get(persona_id)
        if not persona:
            return None
        return {
            "provider": persona.get("llm_provider", ""),
            "model": persona.get("llm_model", ""),
            "temperature": persona.get("temperature", 1.0),
            "max_tokens": persona.get("max_tokens", 1000),
        }


class MessagingFacade:
    """Outbound message API for plugins.

    Gated by the ``messaging.send`` permission declared in
    ``plugin.yaml``. Each plugin receives its own facade bound to its
    manifest, so the permission check can't be bypassed by reaching
    across plugin boundaries.
    """

    def __init__(self, app: App, manifest: PluginManifest):
        self._app = app
        self._manifest = manifest

    def send_message(
        self,
        persona_id: str,
        *,
        channel: str,
        text: str = "",
        images: list[dict] | None = None,
        files: list[dict] | None = None,
    ) -> bool:
        """Send a literal pre-composed assistant message into a conversation.

        Args:
            persona_id: Target conversation (one persona = one conversation).
            channel: Registered channel (e.g. ``"web"``, ``"wechat"``, ``"qq"``).
            text: Plain-text body. At least one of ``text`` / ``images`` /
                ``files`` is required.
            images: Optional list of image blocks of the form
                ``{"path": "...", "mime": "..."}``. The plugin owns the
                file paths; the host does not copy them.
            files: Optional list of file blocks of the form
                ``{"path": "...", "name": "...", "mime": "..."}``.
                ``name`` defaults to ``basename(path)``, ``mime`` defaults
                to ``application/octet-stream``. The plugin owns the file
                paths; the host does not copy them.

        Returns:
            ``True`` when the channel accepted the delivery. ``False`` when
            the persona is busy (an LLM round is in flight); caller may
            retry later.

        Raises:
            PermissionError: plugin lacks ``messaging.send``.
            ValueError: bad arguments / unknown persona.
            RuntimeError: Channel push preconditions not met (binding, peer,
                reply window, connection or active-send pause).
        """
        if "messaging.send" not in self._manifest.permissions:
            raise PermissionError(
                "Plugin must declare 'messaging.send' in plugin.yaml permissions"
            )
        if channel != "web" and not self._app.channel_registry.has(channel):
            raise ValueError(f"Unknown channel: {channel!r}")
        if not isinstance(text, str):
            raise ValueError("text must be a string")
        image_blocks = self._normalize_images(images)
        file_blocks = self._normalize_files(files)
        if not (text or image_blocks or file_blocks):
            raise ValueError("send_message requires text, images, or files")
        if not persona_id:
            raise ValueError("persona_id is required")

        convo = self._app.conversation_store.get_conversation(persona_id)
        if convo is None:
            raise ValueError(f"Conversation not found: {persona_id}")

        # Files supplied by the plugin live outside the host's data tree by
        # default. Copy them into data/chats/<persona>/files/ so the web
        # preview's /api/files endpoint (and any consumer that re-reads the
        # message later) can resolve them by basename. WeChat sender opens
        # the post-copy path and CDN-uploads from there.
        if file_blocks:
            file_blocks = self._persist_files_for_persona(persona_id, file_blocks)

        reply_ctx = self._build_reply_ctx(channel, convo, persona_id)
        message = self._build_message(text, image_blocks, file_blocks)

        mq = self._app.message_queue
        rd = self._app.reply_dispatcher
        if mq is None or rd is None:
            raise RuntimeError("Messaging subsystem not ready yet")

        # Reuse the proactive mutex so we never interleave with an
        # in-flight LLM round for the same persona.
        if not mq.try_begin_proactive(persona_id):
            return False
        try:
            delivered = rd.deliver_messages(persona_id, [message], reply_ctx=reply_ctx)
            return bool(delivered)
        finally:
            mq.end_proactive(persona_id)

    def _build_reply_ctx(self, channel: str, convo: dict, persona_id: str) -> dict:
        if channel == "web":
            return {"channel": "web"}

        link = self._app.conversation_store.channel_link(persona_id)
        if not link:
            raise RuntimeError(
                f"Persona {persona_id} is not bound to a channel — "
                "channel='web' is required"
            )
        link_channel = link.get("channel", "")
        if link_channel != channel:
            raise RuntimeError(
                f"Persona {persona_id} is bound to {link_channel!r}, not {channel!r}"
            )
        if (link.get("chat_type") or "single") == "group":
            raise RuntimeError(f"Persona {persona_id} is bound to a group chat (unsupported)")
        if not link.get("peer_id"):
            raise RuntimeError(
                f"Persona {persona_id} channel link is missing peer_id "
                "(awaits first inbound user message to backfill)"
            )

        channel_impl = self._app.channel_registry.get(channel, default=None)
        if channel_impl is None:
            raise RuntimeError(f"Channel {channel!r} is not available")

        messages = convo.get("messages", []) or []
        last_user_at = scan_last_user_at(messages)
        if last_user_at <= 0:
            raise RuntimeError(
                f"Persona {persona_id} has no historical user message to anchor on"
            )
        # Per-channel push policy (WeChat 23h openclaw TTL window + 10-reply
        # quota; QQ connection and active-send recovery state).
        if not channel_impl.can_push_now(link, last_user_at, messages):
            raise RuntimeError(
                f"Persona {persona_id} channel {channel!r} cannot push right now "
                "(offline, reply window expired, or active push paused)"
            )

        return channel_impl.reply_ctx_from_link(link)

    @staticmethod
    def _normalize_images(images: list[dict] | None) -> list[dict]:
        if images is None:
            return []
        if not isinstance(images, list):
            raise ValueError("images must be a list")
        blocks: list[dict] = []
        for index, img in enumerate(images):
            if not isinstance(img, Mapping):
                raise ValueError(f"images[{index}] must be an object")
            path = str(img.get("path", "")).strip()
            if not path:
                raise ValueError(f"images[{index}].path is required")
            mime = str(img.get("mime") or "image/jpeg").strip() or "image/jpeg"
            blocks.append({"type": "image", "path": path, "mime": mime})
        return blocks

    @staticmethod
    def _persist_files_for_persona(persona_id: str, file_blocks: list[dict]) -> list[dict]:
        """Ensure every file block's path lives under the persona's files dir.

        Plugin-supplied paths can be anywhere on disk. We copy them into
        ``data/chats/<persona>/files/<random>__<original_name>`` so:
          * Web preview's ``/api/files/<persona>/<basename>`` route can serve them.
          * The stored conversation message keeps a stable, host-owned path
            that won't break if the plugin later moves or deletes the source.
        Files already under the persona's files dir are left as-is.
        """
        target_dir = CHATS_DIR / persona_id / "files"
        target_dir.mkdir(parents=True, exist_ok=True)
        target_dir_resolved = target_dir.resolve()
        persisted: list[dict] = []
        for block in file_blocks:
            src = Path(block["path"])
            try:
                src_resolved = src.resolve()
            except Exception:
                raise ValueError(f"file path is not resolvable: {block['path']}")
            if not src_resolved.is_file():
                raise ValueError(f"file not found: {block['path']}")
            # If already under target_dir, no copy.
            try:
                src_resolved.relative_to(target_dir_resolved)
                new_path = str(src_resolved)
            except ValueError:
                random_prefix = secrets.token_hex(4)
                safe_name = src.name or "file"
                dest = target_dir / f"{random_prefix}__{safe_name}"
                shutil.copyfile(src_resolved, dest)
                new_path = str(dest)
            persisted.append({**block, "path": new_path})
        return persisted

    @staticmethod
    def _normalize_files(files: list[dict] | None) -> list[dict]:
        if files is None:
            return []
        if not isinstance(files, list):
            raise ValueError("files must be a list")
        blocks: list[dict] = []
        for index, f in enumerate(files):
            if not isinstance(f, Mapping):
                raise ValueError(f"files[{index}] must be an object")
            path = str(f.get("path", "")).strip()
            if not path:
                raise ValueError(f"files[{index}].path is required")
            name = str(f.get("name") or Path(path).name).strip() or Path(path).name
            mime = str(f.get("mime") or "application/octet-stream").strip() or "application/octet-stream"
            blocks.append({"type": "file", "path": path, "name": name, "mime": mime})
        return blocks

    def _build_message(
        self,
        text: str,
        image_blocks: list[dict],
        file_blocks: list[dict] | None = None,
    ) -> dict:
        content: list[dict] = []
        if text:
            content.append({"type": "text", "text": text})
        content.extend(image_blocks)
        if file_blocks:
            content.extend(file_blocks)
        return {
            "role": "assistant",
            "source": f"plugin:{self._manifest.id}",
            "content": content,
        }


class MCPFacade:
    """Read, invoke, and publish MCP (Model Context Protocol) tools.

    Permission gates:
      * ``list_tools`` / ``list_servers`` → ``mcp.read``
      * ``call_tool`` → ``mcp.invoke`` (does NOT implicitly include ``mcp.read``)
      * ``register_tool`` → ``mcp.publish``

    Tool calls go through the same underlying ``MCPManager.call_tool`` path
    the LLM uses, so behavior (timeouts, error surfaces) matches what the
    model sees during tool use.

    Tools registered via :meth:`register_tool` run in-process; they are
    surfaced to the LLM alongside MCP-server tools and built-in
    capabilities, namespaced as ``plugin_<id>__<name>``.
    """

    def __init__(
        self,
        manifest: PluginManifest,
        mcp_manager: MCPManager | None,
        capability_registry: CapabilityAdapterRegistry | None = None,
    ):
        self._manifest = manifest
        self._mcp = mcp_manager
        self._capability_registry = capability_registry
        self._owner_tag = f"plugin:{manifest.id}"

    def list_tools(self) -> list[dict]:
        """Enumerate every tool from every connected MCP server.

        Each item: ``{"name": "<server>__<tool>", "description": str,
        "inputSchema": dict, "server": str}``. Internal cache fields are
        stripped.
        """
        self._require("mcp.read")
        if self._mcp is None:
            return []
        return [
            {
                "name": t.get("name", ""),
                "description": t.get("description", ""),
                "inputSchema": t.get("inputSchema", {}),
                "server": t.get("_server", ""),
            }
            for t in self._mcp.get_all_tools()
        ]

    def list_servers(self) -> dict[str, dict]:
        """Return ``{server_name: {"connected": bool, "tool_count": int}}``."""
        self._require("mcp.read")
        if self._mcp is None:
            return {}
        return self._mcp.get_server_status()

    def call_tool(self, name: str, arguments: dict | None = None) -> list[dict]:
        """Invoke an MCP tool by its namespaced ``<server>__<tool>`` name.

        Returns the tool's ContentBlock list serialized as dicts:
        ``[{"type": str, "text": str, "data": Any | None}, ...]``.

        Tool execution errors do NOT raise — failures surface as a single
        text block whose body starts with ``"工具调用出错: "``. Plugins
        should inspect the returned list, not rely on exceptions.
        """
        self._require("mcp.invoke")
        if not isinstance(name, str) or not name:
            raise ValueError("tool name is required")
        if self._mcp is None:
            raise RuntimeError("MCP subsystem is not initialized")
        blocks = self._mcp.call_tool(name, arguments or {})
        return [
            {
                "type": getattr(b, "type", "text"),
                "text": getattr(b, "text", "") or "",
                "data": getattr(b, "data", None),
            }
            for b in blocks
        ]

    def register_tool(
        self,
        name: str,
        description: str,
        parameters: dict,
        handler: Callable[[dict, dict], list[dict]],
    ) -> str:
        """Expose a plugin-provided tool to the LLM.

        The tool is registered into the same surface MCP-server tools and
        built-in capabilities share, so the model can pick it during
        tool_use just like any other tool. The exposed tool name is
        namespaced as ``plugin_<plugin_id>__<name>`` and returned to the
        caller.

        Args:
            name: Short local name, must match ``^[a-z0-9][a-z0-9_]*$``.
                Two underscores in a row are disallowed to keep the
                ``plugin_<id>__<name>`` namespace boundary unambiguous.
            description: Human-readable tool description shown to the LLM.
            parameters: JSON-Schema-style ``properties`` map. Each entry is
                ``{"type": "string"|"integer"|..., "description": "..."}``;
                add ``"default": ...`` to mark a field optional. Same shape
                accepted by the built-in capability adapters.
            handler: Sync callable ``(arguments, context) -> list[dict]``
                where each result dict is
                ``{"type": "text"|"image", "text": str, "data": str | None}``.
                ``context`` carries the current round's runtime state:
                    * ``pending_images``: ``{image_id: {"data": base64, "mime": str}}``
                      — the synthetic IDs the LLM sees as ``[图片 ID:...]``.
                    * ``pending_files``: ``{file_id: {"path": str, ...}}``
                    * ``persona_id``, ``persona``: current conversation persona.
                    * ``generated_images``: list of image dicts the LLM
                      generated earlier this round (rarely needed).
                Handler exceptions are caught and surfaced to the LLM as a
                text block — they do not crash the chat round.

        Returns:
            The namespaced tool name (``plugin_<plugin_id>__<name>``)
            actually exposed to the LLM. Useful for logging.

        Raises:
            PermissionError: plugin lacks ``mcp.publish``.
            ValueError: bad ``name`` format, or this plugin already
                registered a tool with the same local ``name``.
            RuntimeError: capability registry is not yet initialized
                (called too early in plugin lifecycle, before app start
                finished — should not happen in normal ``setup()``).
        """
        self._require("mcp.publish")
        if not isinstance(name, str) or not _PLUGIN_TOOL_NAME_RE.match(name) or "__" in name:
            raise ValueError(
                "tool name must match ^[a-z0-9][a-z0-9_]*$ and not contain '__'"
            )
        if not isinstance(description, str):
            raise ValueError("description must be a string")
        if not isinstance(parameters, dict):
            raise ValueError("parameters must be a dict")
        if not callable(handler):
            raise ValueError("handler must be callable")
        if self._capability_registry is None:
            raise RuntimeError(
                "Capability registry not initialized — call register_tool from setup() after host startup"
            )

        namespaced = f"plugin_{self._manifest.id}__{name}"

        def _wrapped(args: dict, ctx: dict) -> list[ContentBlock]:
            try:
                raw = handler(args, ctx)
            except Exception as exc:
                logger.exception(
                    "插件 %s 的工具 %s 执行抛出异常", self._manifest.id, namespaced
                )
                return [ContentBlock(type="text", text=f"工具执行失败: {exc}")]
            return _coerce_handler_result(raw)

        # register_plugin_tool raises ValueError if ``namespaced`` was
        # already registered (e.g. plugin called register_tool twice with
        # the same local name).
        self._capability_registry.register_plugin_tool(
            name=namespaced,
            description=description,
            parameters=parameters,
            handler=_wrapped,
            owner=self._owner_tag,
        )
        return namespaced

    def _require(self, perm: str) -> None:
        if perm not in self._manifest.permissions:
            raise PermissionError(
                f"Plugin must declare '{perm}' in plugin.yaml permissions"
            )


class ChannelsFacade:
    """Lets a plugin provide a full chat channel — its own message receive
    loop plus an outbound send handler. The host owns the message queue and
    AI; the plugin owns the transport I/O.

    Gated by the ``channel.register`` permission. The plugin's channel is
    registered under the type ``plugin:<plugin_id>``.
    """

    def __init__(self, app: App, manifest: PluginManifest):
        self._app = app
        self._manifest = manifest
        self._channel_type = f"plugin:{manifest.id}"

    def register_channel(
        self,
        *,
        display_name: str,
        on_outbound: Callable[[str, dict, dict], bool | None],
        account_fields: list | None = None,
        id_field: str = "",
        on_start_account: Callable | None = None,
        on_stop_account: Callable | None = None,
        on_validate: Callable[[dict], None] | None = None,
        hint: str = "",
    ) -> str:
        """Register this plugin's chat channel.

        Args:
            display_name: Channel name shown in the add-account UI.
            on_outbound: ``(persona_id, message, reply_ctx) -> bool`` — deliver
                one assistant message to the remote user. Return ``False`` on
                failure (``None`` is treated as success).
            account_fields: Declarative form fields for adding an account
                (``[{"key","label","secret"?,"required"?,"type"?}]``). Empty →
                the channel isn't user-addable from the UI.
            id_field: Which field key holds the unique account id (defaults to a
                generated id).
            on_start_account / on_stop_account: optional lifecycle callbacks
                ``(Account) -> None`` / ``(account_id) -> None``.
            on_validate: optional ``(fields) -> None`` raising ``ValueError`` on
                bad input when an account is added.
            hint: optional help text shown under the add-account form.

        Returns the channel type string (``plugin:<id>``).
        """
        self._require()
        if not callable(on_outbound):
            raise ValueError("on_outbound must be callable")

        from pawzochat.channels.plugin import PluginChannel

        channel = PluginChannel(
            self._app,
            channel_type=self._channel_type,
            display_name=display_name,
            on_outbound=on_outbound,
            account_fields=account_fields,
            id_field=id_field,
            on_start_account=on_start_account,
            on_stop_account=on_stop_account,
            on_validate=on_validate,
            hint=hint,
        )
        self._app.channel_registry.register(channel)
        # Bring up any saved accounts of this type that were skipped at restore
        # because the channel wasn't registered yet.
        self._app.retry_deferred_accounts(self._channel_type)
        return self._channel_type

    def submit_inbound(
        self,
        account_id: str,
        *,
        peer_id: str = "",
        text: str = "",
        images: list[dict] | None = None,
        files: list[dict] | None = None,
        reply_target: str = "",
    ) -> bool:
        """Push an inbound message from the plugin's receive loop into the
        pipeline. ``peer_id`` is the remote user id; ``reply_target`` is the
        channel's reply anchor (echoed back in ``reply_ctx`` on delivery).

        Returns ``True`` if the message was accepted (the account is bound to a
        persona and the queue took it).
        """
        self._require()
        mq = self._app.message_queue
        if mq is None:
            raise RuntimeError("Messaging subsystem not ready yet")

        conv = self._app.conversation_store.find_by_account(account_id)
        if conv is None:
            return False
        persona_id = conv["persona_id"]

        # Validate/normalize the plugin-supplied media to the same shape the
        # outbound path enforces, so a malformed item raises a clean ValueError
        # to the plugin instead of an opaque AttributeError deep in the queue.
        image_blocks = MessagingFacade._normalize_images(images)
        file_blocks = MessagingFacade._normalize_files(files)

        reply_ctx = {
            "channel": self._channel_type,
            "account_id": account_id,
            "user_id": peer_id,
            "reply_target": reply_target,
        }
        accepted = mq.accept_message(
            persona_id,
            text or "",
            source=self._channel_type,
            reply_ctx=reply_ctx,
            images=image_blocks or None,
            files=file_blocks or None,
            account_id=account_id,
            user_id=peer_id,
        )
        if accepted:
            actual_persona_id, _msg = accepted
            if peer_id:
                self._app.conversation_store.update_channel_peer(
                    actual_persona_id, peer_id, chat_type="single",
                )
            if reply_target:
                self._app.conversation_store.update_reply_target(
                    actual_persona_id, reply_target,
                )
        return bool(accepted)

    def _require(self) -> None:
        if "channel.register" not in self._manifest.permissions:
            raise PermissionError(
                "Plugin must declare 'channel.register' in plugin.yaml permissions"
            )


@dataclass
class PluginContext:
    """Runtime context injected into plugins."""

    manifest: PluginManifest
    root_dir: Path
    config_path: Path
    state_dir: Path
    logger: logging.Logger
    config: Mapping[str, Any]
    hooks: HookRegistrar
    conversations: ConversationFacade
    personas: PersonaFacade
    llm: LLMFacade
    messaging: MessagingFacade
    mcp: MCPFacade
    channels: ChannelsFacade
