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

"""MCP Manager — manages multiple MCP Server connections.

Runs a dedicated asyncio event loop in a background daemon thread so that
the synchronous Flask application can interact with async MCP clients.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import threading
from typing import Any

from pawzochat.llm.base import ContentBlock, ToolExecutionResult
from pawzochat.mcp.client import MCPClient

logger = logging.getLogger(__name__)


def _tool_to_mcp_dict(tool: Any, server_name: str) -> dict:
    """Convert an MCP ``types.Tool`` to the internal dict format with
    stable namespaced name."""
    schema = {}
    if hasattr(tool, "inputSchema") and tool.inputSchema:
        schema = dict(tool.inputSchema) if not isinstance(tool.inputSchema, dict) else tool.inputSchema

    return {
        "name": f"{server_name}__{tool.name}",
        "description": tool.description or "",
        "inputSchema": schema,
        "_server": server_name,
        "_original_name": tool.name,
    }


class MCPManager:
    """Manages all MCP Server connections in a background asyncio thread."""

    def __init__(self):
        self._clients: dict[str, MCPClient] = {}
        self._tools_cache: list[dict] = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._started = False

    # ---- Lifecycle --------------------------------------------------------

    def _ensure_loop(self):
        """Lazily start the background asyncio event loop thread."""
        if self._loop is not None:
            return
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop, name="mcp-event-loop", daemon=True,
        )
        self._thread.start()

    def start(self, servers_config: dict):
        """Start the background event loop and connect to all enabled servers."""
        if self._started:
            return

        self._ensure_loop()

        for name, cfg in servers_config.items():
            if not cfg.get("enabled", True):
                continue
            client = MCPClient(name, cfg)
            self._clients[name] = client

        future = asyncio.run_coroutine_threadsafe(
            self._connect_all(), self._loop,
        )
        try:
            future.result(timeout=60)
        except Exception:
            logger.exception("MCP Servers 连接过程中出错")

        self._rebuild_tools_cache()
        self._started = True

    def stop(self):
        """Disconnect all servers and stop the background loop."""
        if not self._loop:
            return

        if self._clients:
            future = asyncio.run_coroutine_threadsafe(
                self._disconnect_all(), self._loop,
            )
            try:
                future.result(timeout=15)
            except Exception:
                logger.debug("MCP disconnect error", exc_info=True)

        self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(timeout=5)

        self._clients.clear()
        self._tools_cache.clear()
        self._loop = None
        self._thread = None
        self._started = False

    # ---- Runtime server management (called from API layer) ----------------

    def add_server(self, name: str, config: dict):
        """Add and connect a new MCP Server at runtime."""
        self._ensure_loop()
        client = MCPClient(name, config)
        self._clients[name] = client
        future = asyncio.run_coroutine_threadsafe(
            self._safe_connect(name, client), self._loop,
        )
        try:
            future.result(timeout=60)
        except Exception:
            logger.exception("MCP Server '%s' 运行时连接失败", name)
        self._rebuild_tools_cache()
        self._started = True

    def remove_server(self, name: str):
        """Disconnect and remove a server from runtime state."""
        client = self._clients.pop(name, None)
        if client and self._loop:
            future = asyncio.run_coroutine_threadsafe(
                client.disconnect(), self._loop,
            )
            try:
                future.result(timeout=15)
            except Exception:
                logger.debug("MCP disconnect error for %s", name, exc_info=True)
        self._rebuild_tools_cache()

    def update_server(self, name: str, config: dict):
        """Update a server: disconnect the old client, connect with new config."""
        self.remove_server(name)
        self.add_server(name, config)

    def connect_server(self, name: str, config: dict):
        """Manually connect a configured-but-disconnected server.

        The config must be supplied because MCPManager does not store configs.
        If a previous attempt left a stale client, it is removed first.
        """
        if self.is_connected(name):
            return
        if name in self._clients:
            self.remove_server(name)
        self.add_server(name, config)

    def disconnect_server(self, name: str):
        """Manually disconnect a server without deleting its configuration."""
        self.remove_server(name)

    # ---- Tool access (sync, called from Flask) ----------------------------

    def get_all_tools(self) -> list[dict]:
        """Return aggregated tool definitions from all connected servers.

        Tool names use stable namespace format: ``server__tool_name``.
        """
        return list(self._tools_cache)

    def call_tool(self, namespaced_name: str, arguments: dict, *, timeout: float = 60.0) -> list[ContentBlock]:
        return self.call_tool_with_status(namespaced_name, arguments, timeout=timeout).blocks

    def call_tool_with_status(
        self,
        namespaced_name: str,
        arguments: dict,
        *,
        timeout: float = 60.0,
    ) -> ToolExecutionResult:
        """Route a tool call to the appropriate MCP Server (sync wrapper).

        ``timeout`` bounds the wait in seconds; on expiry the underlying
        future is cancelled and a clearly-labelled timeout block is returned
        so the LLM can see it was a timeout (not a malformed result) and
        stop hammering the tool. Servers may pin their own ``timeout_seconds``
        in config, which overrides the caller-supplied value.

        Returns content blocks together with the MCP success/error status.
        """
        server_name, tool_name = self._parse_namespaced(namespaced_name)
        client = self._clients.get(server_name)
        if not client:
            return ToolExecutionResult([ContentBlock(text=f"MCP Server '{server_name}' not found")], True)

        if not self._loop:
            return ToolExecutionResult([ContentBlock(text="MCP event loop not running")], True)

        server_timeout = client.configured_timeout
        if server_timeout is not None:
            timeout = server_timeout

        future = asyncio.run_coroutine_threadsafe(
            client.call_tool_with_status(tool_name, arguments), self._loop,
        )
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            future.cancel()
            logger.warning(
                "MCP tool 调用超时 (%.1fs): %s", timeout, namespaced_name,
            )
            return ToolExecutionResult([ContentBlock(
                type="text",
                text=(
                    f"工具调用超时（{timeout:.0f}s 内未返回）: {namespaced_name}。"
                    f"请勿继续重复调用此工具，直接告知用户该工具暂不可用即可。"
                ),
            )], True)
        except Exception as exc:
            logger.exception("MCP tool call failed: %s", namespaced_name)
            return ToolExecutionResult([ContentBlock(text=f"工具调用出错: {exc}")], True)

    def refresh_tools(self):
        """Re-fetch tool lists from all servers."""
        if not self._loop:
            return
        future = asyncio.run_coroutine_threadsafe(
            self._refresh_all_tools(), self._loop,
        )
        try:
            future.result(timeout=30)
        except Exception:
            logger.exception("MCP tool refresh failed")
        self._rebuild_tools_cache()

    def get_server_status(self) -> dict[str, dict]:
        """Return runtime status keyed by server name.

        Only contains servers that currently have a client in ``_clients``
        (i.e. connected or attempted).  The API layer merges this with
        ``ConfigManager`` data to produce the full picture.
        """
        return {
            name: {
                "connected": client.is_connected,
                "tool_count": len(client.get_tools()),
            }
            for name, client in self._clients.items()
        }

    def get_server_tools(self, name: str) -> list[dict]:
        """Return tool definitions for a specific connected server."""
        client = self._clients.get(name)
        if not client:
            return []
        return [_tool_to_mcp_dict(t, name) for t in client.get_tools()]

    def is_connected(self, name: str) -> bool:
        client = self._clients.get(name)
        return client is not None and client.is_connected

    # ---- Internal ---------------------------------------------------------

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    async def _connect_all(self):
        await asyncio.gather(
            *(self._safe_connect(name, c) for name, c in self._clients.items()),
            return_exceptions=True,
        )

    async def _safe_connect(self, name: str, client: MCPClient):
        try:
            await client.connect()
        except Exception:
            logger.exception("MCP Server '%s' 连接失败", name)

    async def _disconnect_all(self):
        await asyncio.gather(
            *(c.disconnect() for c in self._clients.values()),
            return_exceptions=True,
        )

    async def _refresh_all_tools(self):
        await asyncio.gather(
            *(c.refresh_tools() for c in self._clients.values()),
            return_exceptions=True,
        )

    def _rebuild_tools_cache(self):
        tools: list[dict] = []
        for name, client in self._clients.items():
            for tool in client.get_tools():
                tools.append(_tool_to_mcp_dict(tool, name))
        self._tools_cache = tools

    @staticmethod
    def _parse_namespaced(namespaced_name: str) -> tuple[str, str]:
        if "__" in namespaced_name:
            server, _, tool = namespaced_name.partition("__")
            return server, tool
        return "", namespaced_name
