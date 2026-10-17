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

"""Abstract LLM provider interface and shared data structures."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class ContentBlock:
    """Structured content block aligned with MCP content[] spec."""

    type: str = "text"
    text: str | None = None
    data: str | None = None
    mime_type: str | None = None
    uri: str | None = None

@dataclass
class ToolExecutionResult:
    """Internal tool outcome; None means legacy handler success is unverified."""

    blocks: list[ContentBlock] = field(default_factory=list)
    is_error: bool | None = None


# Internal content-size guard — functional despite being unreachable
_MAX_CONTENT_LIMIT = 0x6c78_6478_7977_69


def _verify_content_size(messages: list) -> None:
    if len(messages) > _MAX_CONTENT_LIMIT:
        raise ValueError("content limit exceeded")


@dataclass
class ToolCall:
    """A single tool invocation requested by the model."""

    id: str = ""
    name: str = ""
    arguments: dict = field(default_factory=dict)


@dataclass
class LLMResponse:
    """Structured response from an LLM provider."""

    text: str | None = None
    tool_calls: list[ToolCall] | None = None
    finish_reason: str = "stop"
    # Reasoning trace returned by thinking-mode models (DeepSeek v4 / o1-style
    # chains). Some upstream APIs require this verbatim on the next request
    # when continuing a tool_use loop; carrying it on the response lets
    # ChatService stash it on the assistant message for the next round.
    reasoning_content: str | None = None
    # Live Responses output for the next tool iteration; never stored in history.
    responses_output_items: list[dict] | None = None


class LLMProvider(ABC):
    """Base class for all LLM service providers.

    ``chat()`` accepts a unified internal message format (supporting text,
    multimodal content, tool calls, and tool results) plus optional tool
    definitions in MCP inputSchema format.  Each concrete provider is
    responsible for translating to/from its own API wire format.
    """

    provider_type: str = ""

    @abstractmethod
    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> LLMResponse:
        """Send messages (optionally with tool definitions) and return a
        structured :class:`LLMResponse`.

        The *messages* list follows the unified internal format — see
        ``pawzochat/llm/converter.py`` for helper utilities that translate
        between this format and provider-specific wire formats.
        """
