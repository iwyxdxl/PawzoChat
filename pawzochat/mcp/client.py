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

"""Single MCP Server connection wrapper.

Each ``MCPClient`` manages the lifecycle of one connection to an MCP Server
(via stdio, Streamable HTTP, or SSE), caches its tool list, and routes
tool calls.

Connection lifecycle is owned by a single long-lived asyncio task
(``_lifecycle_task``) so that the anyio context managers from ``mcp.client``
are entered and exited in the same task. Other tasks (e.g. callers from
the Flask thread via ``asyncio.run_coroutine_threadsafe``) interact with
the session by sending/receiving on its memory streams — which is safe
across tasks — but never enter or exit its task groups.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from pathlib import Path
from typing import Any

from mcp import ClientSession, McpError, StdioServerParameters, types
from mcp.client.stdio import stdio_client
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamable_http_client

from pawzochat.llm.base import ContentBlock, ToolExecutionResult
from pawzochat.paths import APP_HOME

logger = logging.getLogger(__name__)

_PATHLIKE_SUFFIXES = {".py", ".pyw", ".exe", ".bat", ".cmd", ".sh"}

# Bounded wait for the lifecycle task to react to a graceful shutdown signal
# before we cancel it. Two seconds is long enough for the SDK's own stdio
# shutdown sequence (close stdin → wait → SIGTERM after 2s) plus slack.
_GRACEFUL_DISCONNECT_TIMEOUT = 5.0


def _looks_like_path(value: str) -> bool:
    if not value:
        return False
    # Never treat as path: CLI flags (-x, --key, --key=value), npm scoped
    # packages (@scope/name), URLs (https://, file://). These legitimately
    # contain "/" but must be passed to the subprocess verbatim.
    if value.startswith("-") or value.startswith("@") or "://" in value:
        return False
    path = Path(value)
    if path.is_absolute():
        return True
    if value.startswith(("./", "../", ".\\", "..\\")):
        return True
    return path.suffix.lower() in _PATHLIKE_SUFFIXES


def _resolve_app_relative_path(value: str) -> str:
    if not value:
        return value
    if not _looks_like_path(value):
        return value
    path = Path(value)
    if path.is_absolute():
        return str(path)
    return str((APP_HOME / path).resolve())


def _resolve_stdio_command(command: str) -> str:
    return _resolve_app_relative_path(str(command or "").strip())


def _resolve_stdio_args(args: list[Any]) -> list[str]:
    return [_resolve_app_relative_path(str(arg)) for arg in (args or [])]


def _mcp_content_to_blocks(content: list[Any]) -> list[ContentBlock]:
    """Convert MCP tool result content items to internal ContentBlocks."""
    blocks: list[ContentBlock] = []
    for item in content:
        if isinstance(item, types.TextContent):
            blocks.append(ContentBlock(type="text", text=item.text))
        elif isinstance(item, types.ImageContent):
            blocks.append(ContentBlock(
                type="image",
                data=item.data,
                mime_type=item.mimeType,
            ))
        elif isinstance(item, types.EmbeddedResource):
            res = item.resource
            uri = str(res.uri) if hasattr(res, "uri") else ""
            text = res.text if hasattr(res, "text") else None
            mime = getattr(res, "mimeType", None) or getattr(res, "mime_type", None)
            blob = getattr(res, "blob", None)
            mime_norm = str(mime or "").split(";", 1)[0].strip().lower()
            if mime_norm.startswith("image/") and blob:
                if isinstance(blob, bytes):
                    data = base64.b64encode(blob).decode("ascii")
                else:
                    data = str(blob)
                blocks.append(ContentBlock(
                    type="image",
                    data=data,
                    mime_type=mime_norm,
                ))
            else:
                blocks.append(ContentBlock(type="resource", uri=uri, text=text))
        else:
            blocks.append(ContentBlock(type="text", text=str(item)))
    return blocks or [ContentBlock(type="text", text="")]


class MCPClient:
    """Async wrapper around a single MCP Server connection."""

    def __init__(self, server_name: str, config: dict):
        self.server_name = server_name
        self.config = config
        self._session: ClientSession | None = None
        self._tools: list[types.Tool] = []
        self._lifecycle_task: asyncio.Task | None = None
        self._connected_event: asyncio.Event | None = None
        self._shutdown_event: asyncio.Event | None = None
        self._connect_error: BaseException | None = None

    @property
    def transport_type(self) -> str:
        return self.config.get("transport", "stdio")

    @property
    def configured_timeout(self) -> float | None:
        """Per-server tool-call timeout (seconds); None means unset."""
        raw = self.config.get("timeout_seconds")
        if raw is None or isinstance(raw, bool):
            return None
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return None
        return val if val > 0 else None

    @property
    def is_connected(self) -> bool:
        return self._session is not None

    async def _lifecycle(self):
        """Long-lived task that owns the transport + session context managers.

        Sets ``_connected_event`` once initialize() succeeds (or fails — in
        which case ``_connect_error`` is also set). Stays parked on
        ``_shutdown_event.wait()`` until ``disconnect()`` is called.
        """
        transport = self.transport_type
        try:
            if transport == "stdio":
                command = _resolve_stdio_command(self.config.get("command", ""))
                args = _resolve_stdio_args(list(self.config.get("args", [])))
                raw_env = dict(self.config.get("env", {}))
                env = {**os.environ, **raw_env} if raw_env else None
                params = StdioServerParameters(command=command, args=args, env=env)
                transport_cm = stdio_client(params)
            elif transport == "streamable_http":
                transport_cm = streamable_http_client(self.config.get("url", ""))
            elif transport == "sse":
                transport_cm = sse_client(self.config.get("url", ""))
            else:
                raise ValueError(f"Unsupported MCP transport: {transport}")

            async with transport_cm as streams:
                # streamable_http yields (read, write, terminate); others yield (read, write).
                read_stream, write_stream = streams[0], streams[1]

                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    result = await session.list_tools()
                    self._tools = list(result.tools)
                    self._session = session
                    logger.info(
                        "MCP Server '%s' 已连接 (%s), %d 个工具",
                        self.server_name, transport, len(self._tools),
                    )
                    self._connected_event.set()
                    await self._shutdown_event.wait()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._connect_error = exc
            if not self._connected_event.is_set():
                self._connected_event.set()
            logger.warning(
                "MCP Server '%s' lifecycle 退出: %s", self.server_name, exc,
            )
        finally:
            self._session = None

    async def connect(self):
        """Establish the connection and cache the tool list.

        Spawns the lifecycle task and waits for initialize() to complete.
        Raises the underlying exception if the lifecycle task fails before
        the session is ready.
        """
        if self._lifecycle_task is not None and not self._lifecycle_task.done():
            return  # already connecting / connected
        self._connected_event = asyncio.Event()
        self._shutdown_event = asyncio.Event()
        self._connect_error = None
        self._tools = []
        self._session = None
        self._lifecycle_task = asyncio.get_event_loop().create_task(
            self._lifecycle(),
            name=f"mcp-lifecycle-{self.server_name}",
        )
        await self._connected_event.wait()
        if self._connect_error is not None:
            err = self._connect_error
            # The lifecycle task already finished on error; drop the reference
            # so a subsequent connect() can spawn a fresh one.
            self._lifecycle_task = None
            raise err

    async def disconnect(self):
        """Signal the lifecycle task to exit and wait for it to finish.

        Falls back to cancellation if graceful shutdown does not complete
        within ``_GRACEFUL_DISCONNECT_TIMEOUT``.
        """
        task = self._lifecycle_task
        if task is None:
            return
        if self._shutdown_event is not None:
            self._shutdown_event.set()
        try:
            await asyncio.wait_for(
                asyncio.shield(task), timeout=_GRACEFUL_DISCONNECT_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "MCP Server '%s' 优雅关闭超时，强制取消", self.server_name,
            )
            task.cancel()
            try:
                await task
            except (Exception, asyncio.CancelledError):
                pass
        except Exception:
            logger.debug(
                "MCP Server '%s' disconnect 异常",
                self.server_name, exc_info=True,
            )
        self._lifecycle_task = None
        self._connected_event = None
        self._shutdown_event = None
        self._session = None
        self._tools = []

    async def reconnect(self):
        """Tear down the old connection and establish a fresh one."""
        logger.info("MCP Server '%s' 正在重连...", self.server_name)
        await self.disconnect()
        await self.connect()

    async def refresh_tools(self):
        """Re-fetch the tool list, reconnecting on transport failure.

        Read-only — safe to retry on any error including ``McpError`` (which
        the SDK uses for both server-side responses and "Connection closed"
        transport death).
        """
        if not self._session:
            return
        try:
            result = await self._session.list_tools()
        except Exception:
            logger.warning(
                "MCP Server '%s' refresh_tools 失败, 尝试重连",
                self.server_name,
            )
            await self.reconnect()
            if not self._session:
                return
            result = await self._session.list_tools()
        self._tools = list(result.tools)

    def get_tools(self) -> list[types.Tool]:
        return list(self._tools)

    async def call_tool(self, tool_name: str, arguments: dict) -> list[ContentBlock]:
        return (await self.call_tool_with_status(tool_name, arguments)).blocks

    async def call_tool_with_status(self, tool_name: str, arguments: dict) -> ToolExecutionResult:
        """Execute a tool call, reconnecting once on transport failure.

        ``McpError`` is raised immediately without retry to avoid duplicate
        side effects on mutating tools — the SDK uses it both for server-side
        RPC errors and for "Connection closed" after the request was already
        sent, and we cannot tell which side processed the request.
        """
        if not self._session:
            await self.reconnect()

        try:
            result = await self._session.call_tool(tool_name, arguments)
        except McpError:
            raise
        except Exception:
            logger.warning(
                "MCP Server '%s' call_tool 失败, 尝试重连",
                self.server_name,
            )
            await self.reconnect()
            if not self._session:
                raise
            result = await self._session.call_tool(tool_name, arguments)

        return ToolExecutionResult(_mcp_content_to_blocks(result.content), bool(result.isError))
