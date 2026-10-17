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

"""Google Gemini provider via the official ``google-genai`` SDK."""

from __future__ import annotations

import base64
import logging

import httpx
from google import genai
from google.genai import types

from pawzochat.llm.base import LLMProvider, LLMResponse, ToolCall
from pawzochat.llm.converter import mcp_tools_to_gemini, tool_image_messages

logger = logging.getLogger(__name__)


class GeminiProvider(LLMProvider):
    provider_type = "gemini"

    def __init__(
        self,
        api_key: str,
        **kwargs,
    ):
        self.api_key = api_key
        self._client = genai.Client(api_key=api_key)

    def _build_contents(self, messages: list[dict]):
        """Convert internal messages to Gemini contents + system_instruction.

        Handles text, images, assistant tool calls, and tool results.
        """
        system_parts: list[str] = []
        contents: list[types.Content] = []

        previous_role = None
        for msg in tool_image_messages(messages):
            role = msg["role"]
            follows_tool = previous_role == "tool"
            previous_role = role
            content = msg.get("content", "")

            if role == "system":
                text = content if isinstance(content, str) else str(content)
                if text:
                    system_parts.append(text)
                continue

            if role == "tool":
                fn_name = msg.get("_function_name", "unknown")
                raw = msg.get("content", "")
                if isinstance(raw, list):
                    text_parts = []
                    for block in raw:
                        if hasattr(block, "text") and block.text:
                            text_parts.append(block.text)
                        elif isinstance(block, dict) and block.get("text"):
                            text_parts.append(block["text"])
                    response_data = {"result": "\n".join(text_parts)} if text_parts else {"result": ""}
                else:
                    response_data = {"result": str(raw)}

                if msg.get("_tool_is_error"):
                    response_data = {"error": response_data["result"]}
                part = types.Part.from_function_response(name=fn_name, response=response_data)
                if follows_tool:
                    contents[-1].parts.append(part)
                else:
                    contents.append(types.Content(role="user", parts=[part]))
                continue

            if role == "assistant" and msg.get("tool_calls"):
                parts: list[types.Part] = []
                if content and isinstance(content, str):
                    parts.append(types.Part.from_text(text=content))
                for tc in msg["tool_calls"]:
                    tc_obj = tc if isinstance(tc, ToolCall) else ToolCall(**tc)
                    parts.append(types.Part.from_function_call(
                        name=tc_obj.name,
                        args=tc_obj.arguments,
                    ))
                contents.append(types.Content(role="model", parts=parts))
                continue

            gemini_role = "model" if role == "assistant" else "user"
            parts = []

            if isinstance(content, str):
                parts.append(types.Part.from_text(text=content))
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        btype = block.get("type", "text")
                        if btype == "text":
                            parts.append(types.Part.from_text(text=block.get("text", "")))
                        elif btype == "image" and block.get("data"):
                            raw_data = base64.b64decode(block["data"])
                            parts.append(types.Part.from_bytes(
                                data=raw_data,
                                mime_type=block.get("mime_type", "image/jpeg"),
                            ))

            if parts:
                if msg.get("_tool_image_context") and follows_tool:
                    contents[-1].parts.extend(parts)
                else:
                    contents.append(types.Content(role=gemini_role, parts=parts))

        system_instruction = "\n\n".join(system_parts) if system_parts else None
        return system_instruction, contents

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> LLMResponse:
        model = kwargs.pop("model", None)
        if not model:
            raise ValueError("未指定模型，请在角色设置中选择一个模型")
        temperature = kwargs.pop("temperature", 1.0)
        max_tokens = kwargs.pop("max_tokens", 2000)
        json_mode = kwargs.pop("json_mode", False)

        system_instruction, contents = self._build_contents(messages)

        config_kwargs = {
            "temperature": temperature,
            "max_output_tokens": max_tokens,
        }
        if json_mode:
            config_kwargs["response_mime_type"] = "application/json"
        config = types.GenerateContentConfig(**config_kwargs)
        if system_instruction:
            config.system_instruction = system_instruction

        if tools:
            decls = mcp_tools_to_gemini(tools)
            config.tools = [types.Tool(function_declarations=[
                types.FunctionDeclaration(**d) for d in decls
            ])]

        logger.info("Gemini API 调用开始 (model=%s)", model)
        try:
            response = self._client.models.generate_content(
                model=model,
                contents=contents,
                config=config,
            )
        except httpx.TimeoutException:
            logger.warning("Gemini API 调用超时 (model=%s)", model, exc_info=True)
            raise
        except Exception:
            logger.exception("Gemini API 调用失败 (model=%s)", model)
            raise

        if not response.candidates:
            return LLMResponse(text="", finish_reason="stop")

        candidate = response.candidates[0]
        if not candidate.content or not candidate.content.parts:
            return LLMResponse(text="", finish_reason="stop")

        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []

        for part in candidate.content.parts:
            if part.text:
                text_parts.append(part.text)
            elif part.function_call:
                fc = part.function_call
                tool_calls.append(ToolCall(
                    id=f"gemini_{fc.name}_{id(fc)}",
                    name=fc.name,
                    arguments=dict(fc.args) if fc.args else {},
                ))

        if tool_calls:
            return LLMResponse(
                text="\n".join(text_parts) if text_parts else None,
                tool_calls=tool_calls,
                finish_reason="tool_use",
            )

        return LLMResponse(
            text="\n".join(text_parts) if text_parts else "",
            finish_reason="stop",
        )
