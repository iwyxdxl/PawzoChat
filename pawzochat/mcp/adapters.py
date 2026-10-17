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

"""Capability adapter layer — stable semantic tool interfaces backed by MCP.

Each ``CapabilityAdapter`` maps a fixed, model-facing tool name (like
``view_image`` or ``web_search``) to an underlying MCP Server tool,
performing parameter translation and optional data injection (e.g. reading
stored image data and injecting its base64 representation).
"""

from __future__ import annotations

import base64
import logging
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import wraps
from typing import TYPE_CHECKING, Any

from pawzochat.llm.base import ContentBlock, ToolExecutionResult

if TYPE_CHECKING:
    from pawzochat.mcp.manager import MCPManager

LocalToolHandler = Callable[[dict, dict], list[ContentBlock]]

logger = logging.getLogger(__name__)

_IMAGE_DATA_RE = re.compile(r"^\$image_data\((\w+)\)$")
_FILE_PATH_RE = re.compile(r"^\$file_path\((\w+)\)$")
_FILE_DATA_RE = re.compile(r"^\$file_data\((\w+)\)$")


def _registry_locked(method):
    @wraps(method)
    def locked(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return locked


@dataclass
class CapabilityAdapter:
    """Maps a stable capability name to a tool implementation.

    Two execution modes:
      * MCP-backed (default): set ``mcp_server`` + ``mcp_tool`` so calls are
        proxied through :class:`MCPManager`.
      * Local: set ``local_handler`` to a Python callable that runs in-process
        with ``(arguments, context) -> list[ContentBlock]``. Used for
        program-internal tools like image generation that don't need a real
        MCP server backend.
    """

    capability_name: str
    description: str
    parameters: dict
    mcp_server: str = ""
    mcp_tool: str = ""
    param_mapping: dict = field(default_factory=dict)
    inject_fields: dict = field(default_factory=dict)
    local_handler: LocalToolHandler | None = None


class CapabilityAdapterRegistry:
    """Registry that manages all capability adapters and delegates execution
    to the ``MCPManager``."""

    def __init__(self, mcp_manager: MCPManager):
        self._lock = threading.RLock()
        self._paused_owners: set[str] = set()
        self._active_owners: dict[str, int] = {}
        self._adapters: dict[str, CapabilityAdapter] = {}
        # capability_name → owner tag.
        # ""           : loaded from ``capability_adapters`` config (cleared on reload)
        # "builtin"    : program-internal local-handler tool (preserved across reloads)
        # "plugin:<id>": registered by a plugin via ctx.mcp.register_tool
        #                (preserved across capability_adapters reloads; removed on
        #                plugin teardown via unregister_owner)
        self._owners: dict[str, str] = {}
        self._mcp_manager = mcp_manager

    # ---- Registration -----------------------------------------------------

    @_registry_locked
    def load_from_config(self, adapters_cfg: dict):
        """Populate the registry from the ``capability_adapters`` section
        of ``config.yaml``.

        Names already owned by a non-empty tag (builtin or plugin) are
        skipped to prevent user config from overriding code-registered
        tools.
        """
        for name, cfg in adapters_cfg.items():
            if self._owners.get(name):
                continue
            mcp_server = cfg.get("mcp_server", "")
            if not mcp_server:
                continue
            adapter = CapabilityAdapter(
                capability_name=name,
                description=cfg.get("description", ""),
                parameters=cfg.get("parameters", {}),
                mcp_server=mcp_server,
                mcp_tool=cfg.get("mcp_tool", ""),
                param_mapping=cfg.get("param_mapping", {}),
                inject_fields=cfg.get("inject_fields", {}),
            )
            self.register(adapter)

    @_registry_locked
    def reload(self, adapters_cfg: dict):
        """Clear MCP-backed adapters and reload from config.

        Tools with a non-empty owner (built-ins, plugin-registered) are
        preserved — only ``capability_adapters`` config entries are
        cleared.
        """
        preserved_names = [
            name for name, owner in self._owners.items()
            if owner and name in self._adapters
        ]
        preserved_adapters = {n: self._adapters[n] for n in preserved_names}
        preserved_owners = {n: self._owners[n] for n in preserved_names}
        self._adapters.clear()
        self._owners.clear()
        self._adapters.update(preserved_adapters)
        self._owners.update(preserved_owners)
        if adapters_cfg:
            self.load_from_config(adapters_cfg)

    @_registry_locked
    def register(self, adapter: CapabilityAdapter, *, owner: str = ""):
        """Register an adapter with an optional owner tag.

        ``owner`` defaults to ``""`` (cleared on config reload). Use
        ``"builtin"`` for program-internal tools and ``"plugin:<id>"`` for
        plugin-registered tools — both are preserved across reloads.
        """
        self._adapters[adapter.capability_name] = adapter
        self._owners[adapter.capability_name] = owner
        if adapter.local_handler is not None:
            tag = owner or "config"
            logger.debug("能力适配器已注册（%s）: %s", tag, adapter.capability_name)
        else:
            logger.debug("能力适配器已注册: %s → %s/%s",
                         adapter.capability_name, adapter.mcp_server, adapter.mcp_tool)

    def register_builtin(
        self,
        name: str,
        description: str,
        parameters: dict,
        handler: LocalToolHandler,
    ):
        """Register a program-internal tool backed by a Python callable.

        These adapters are never proxied to an MCP server. ``handler`` is
        invoked as ``handler(arguments, context)`` and must return a list of
        :class:`ContentBlock`.
        """
        adapter = CapabilityAdapter(
            capability_name=name,
            description=description,
            parameters=parameters,
            local_handler=handler,
        )
        self.register(adapter, owner="builtin")

    @_registry_locked
    def register_plugin_tool(
        self,
        name: str,
        description: str,
        parameters: dict,
        handler: LocalToolHandler,
        owner: str,
    ):
        """Register an in-process tool owned by a plugin.

        Same execution model as :meth:`register_builtin` (local handler,
        never proxied to MCP), but tagged under ``owner`` (form
        ``"plugin:<id>"``) so it can be removed in bulk on plugin teardown.

        Raises ``ValueError`` if ``owner`` is not of the form
        ``"plugin:<id>"`` or the name is already registered.
        """
        if not isinstance(owner, str) or not owner.startswith("plugin:") or len(owner) <= len("plugin:"):
            raise ValueError("owner must be of the form 'plugin:<id>'")
        if name in self._adapters:
            raise ValueError(f"capability already registered: {name}")
        adapter = CapabilityAdapter(
            capability_name=name,
            description=description,
            parameters=parameters,
            local_handler=handler,
        )
        self.register(adapter, owner=owner)

    @_registry_locked
    def pause_owner(self, owner: str) -> bool:
        """Reject a busy owner, otherwise prevent new execution until resumed."""
        if self._active_owners.get(owner, 0):
            return False
        self._paused_owners.add(owner)
        return True

    @_registry_locked
    def resume_owner(self, owner: str) -> None:
        self._paused_owners.discard(owner)

    @_registry_locked
    def unregister_owner(self, owner: str) -> list[str]:
        """Remove every capability registered under ``owner``.

        Returns the list of names removed. Idempotent — unknown owners
        return an empty list. Built-in tools (``owner == "builtin"``) and
        the empty owner are protected: callers cannot mass-remove them
        through this method.
        """
        if not owner or owner == "builtin":
            return []
        removed = [
            name for name, tag in list(self._owners.items()) if tag == owner
        ]
        for name in removed:
            self._adapters.pop(name, None)
            self._owners.pop(name, None)
        return removed

    @_registry_locked
    def get_tools_by_owner(self, owner: str) -> list[dict]:
        """Return tool definitions registered under ``owner``.

        Output shape matches :meth:`get_tool_definitions`.
        """
        if not owner:
            return []
        names = {n for n, tag in self._owners.items() if tag == owner}
        return [d for d in self.get_tool_definitions() if d["name"] in names]

    # ---- Query ------------------------------------------------------------

    @_registry_locked
    def get_tool_definitions(self) -> list[dict]:
        """Return MCP-style tool definitions for all registered adapters."""
        defs: list[dict] = []
        for adapter in self._adapters.values():
            properties: dict = {}
            required: list[str] = []
            for pname, pschema in adapter.parameters.items():
                prop: dict = {"type": pschema.get("type", "string")}
                if "description" in pschema:
                    prop["description"] = pschema["description"]
                properties[pname] = prop
                if "default" not in pschema:
                    required.append(pname)

            defs.append({
                "name": adapter.capability_name,
                "description": adapter.description,
                "inputSchema": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
                "_is_capability": True,
                "_owner": self._owners.get(adapter.capability_name, ""),
            })
        return defs

    @_registry_locked
    def is_capability_tool(self, tool_name: str) -> bool:
        return tool_name in self._adapters

    # ---- Execution --------------------------------------------------------

    def execute(self, tool_name: str, arguments: dict, context: dict | None = None,
                *, timeout: float = 60.0) -> list[ContentBlock]:
        return self.execute_with_status(tool_name, arguments, context, timeout=timeout).blocks

    def execute_with_status(
        self,
        tool_name: str,
        arguments: dict,
        context: dict | None = None,
        *,
        timeout: float = 60.0,
    ) -> ToolExecutionResult:
        """Execute a capability adapter call.

        For built-in adapters the local handler runs in-process. Otherwise:
        1. Map parameters via ``param_mapping``.
        2. Inject system-level fields (e.g. image base64 from storage).
        3. Route to the backing MCP Server tool via ``MCPManager``, bounded
           by *timeout* (seconds).
        """
        with self._lock:
            adapter = self._adapters.get(tool_name)
            if not adapter:
                return ToolExecutionResult([ContentBlock(text=f"Unknown capability: {tool_name}")], True)
            owner = self._owners.get(tool_name, "")
            tracked = owner.startswith("plugin:") and adapter.local_handler is not None
            if tracked:
                if owner in self._paused_owners:
                    return ToolExecutionResult([ContentBlock(text="Plugin is stopping; retry later")], True)
                self._active_owners[owner] = self._active_owners.get(owner, 0) + 1

        ctx = context or {}

        if adapter.local_handler is not None:
            try:
                return ToolExecutionResult(adapter.local_handler(arguments, ctx), None)
            except Exception as exc:
                logger.exception("内置能力执行失败: %s", tool_name)
                return ToolExecutionResult([ContentBlock(text=f"工具执行失败: {exc}")], True)
            finally:
                if tracked:
                    with self._lock:
                        remaining = self._active_owners[owner] - 1
                        if remaining:
                            self._active_owners[owner] = remaining
                        else:
                            self._active_owners.pop(owner, None)

        mcp_args = self._build_mcp_args(adapter, arguments, ctx)

        namespaced = f"{adapter.mcp_server}__{adapter.mcp_tool}"
        return self._mcp_manager.call_tool_with_status(namespaced, mcp_args, timeout=timeout)

    def _build_mcp_args(
        self,
        adapter: CapabilityAdapter,
        arguments: dict,
        context: dict,
    ) -> dict:
        """Translate incoming arguments and inject fields."""
        mcp_args: dict = {}

        for local_param, value in arguments.items():
            mapped = adapter.param_mapping.get(local_param, local_param)
            mcp_args[mapped] = value

        for field_name, expr in adapter.inject_fields.items():
            value = self._resolve_inject(expr, arguments, context)
            if value is not None:
                mcp_args[field_name] = value

        return mcp_args

    @staticmethod
    def _resolve_inject(
        expr: str, arguments: dict, context: dict,
    ) -> Any | None:
        """Resolve special inject expressions.

        Supported:
          - ``$image_data(arg)`` → base64 image content
          - ``$file_path(arg)``  → local file path string
          - ``$file_data(arg)``  → base64 file content
        """
        m = _IMAGE_DATA_RE.match(expr)
        if m:
            return _resolve_image_data(m.group(1), arguments, context)

        m = _FILE_PATH_RE.match(expr)
        if m:
            return _resolve_file_field(m.group(1), arguments, context, "path")

        m = _FILE_DATA_RE.match(expr)
        if m:
            return _resolve_file_field(m.group(1), arguments, context, "data")

        return None


# ---- Module-level inject helpers ------------------------------------------


def _resolve_image_data(
    arg_name: str, arguments: dict, context: dict,
) -> str | None:
    image_id = arguments.get(arg_name, "")
    if not image_id:
        return None

    pending = context.get("pending_images", {})
    if image_id in pending:
        img = pending[image_id]
        if isinstance(img, dict) and "data" in img:
            return img["data"]
        if isinstance(img, bytes):
            return base64.b64encode(img).decode("ascii")

    return None


def _resolve_file_field(
    arg_name: str,
    arguments: dict,
    context: dict,
    field: str,
) -> str | None:
    """Resolve a file inject expression.

    *field* is ``"path"`` (return local path) or ``"data"`` (return base64).
    """
    from pathlib import Path

    file_id = arguments.get(arg_name, "")
    if not file_id:
        return None

    pending = context.get("pending_files", {})
    if file_id in pending:
        info = pending[file_id]
        file_path = info.get("path", "")
        if field == "path":
            return file_path
        if field == "data" and file_path:
            p = Path(file_path)
            if p.is_file():
                return base64.b64encode(p.read_bytes()).decode("ascii")
        return None

    return None
