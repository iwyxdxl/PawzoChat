# PawzoChat - Human-like, versatile, extensible AI companion engine
# Copyright (C) 2026  iwyxdxl
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Standard OpenAI Responses adapter for custom conversation providers."""

from __future__ import annotations

import json
import logging
from urllib.parse import urlsplit, urlunsplit

from openai import BadRequestError, OpenAI
from openai.types.responses import Response

from pawzochat.llm.base import LLMProvider, LLMResponse, ToolCall
from pawzochat.llm.converter import messages_to_responses, mcp_tools_to_responses

logger = logging.getLogger(__name__)


def _unsupported_option(exc: BadRequestError, payload: dict) -> str | None:
    """Only relax explicitly unsupported optional parameters, once each."""
    body = exc.body if isinstance(exc.body, dict) else {}
    error = body.get("error", body)
    if not isinstance(error, dict):
        return None
    message = str(error.get("message", "")).lower()
    code = error.get("code")
    if code not in {"unsupported_parameter", "unsupported_value"} and not any(
        marker in message for marker in ("not supported", "unsupported", "does not support", "不支持")
    ):
        return None
    param = str(error.get("param") or "")
    if "temperature" in payload and (param == "temperature" or (not param and "temperature" in message)):
        return "temperature"
    if "text" in payload and (
        param in {"text", "text.format", "text.format.type"}
        or (not param and ("text.format" in message or "json_object" in message))
    ):
        return "text"
    return None


def _parse_response(response: Response) -> LLMResponse:
    if not isinstance(response, Response):
        raise RuntimeError("Responses API 返回格式异常：需要非流式 JSON 响应")
    status = getattr(response, "status", None)
    if status != "completed":
        details = getattr(response, "incomplete_details", None)
        reason = getattr(details, "reason", None)
        error = getattr(response, "error", None)
        reason = reason or getattr(error, "message", None) or status or "缺少 status"
        raise RuntimeError(f"Responses API 未完成：{reason}")
    output = getattr(response, "output", None)
    if not isinstance(output, list) or not output:
        raise RuntimeError("Responses API 返回格式异常：output 为空")

    texts: list[str] = []
    calls: list[ToolCall] = []
    items: list[dict] = []
    call_ids: set[str] = set()
    for item in output:
        if not hasattr(item, "model_dump"):
            raise RuntimeError("Responses API 返回格式异常：无效 output 条目")
        raw = item.model_dump(mode="json", exclude_none=True)
        items.append(raw)
        if raw.get("status") in {"in_progress", "incomplete"}:
            raise RuntimeError("Responses API 返回了未完成的输出条目")
        if raw.get("type") == "message":
            for block in raw.get("content") or []:
                text = block.get("text") if block.get("type") == "output_text" else (
                    block.get("refusal") if block.get("type") == "refusal" else None
                )
                if isinstance(text, str):
                    texts.append(text)
        elif raw.get("type") == "function_call":
            call_id, name = raw.get("call_id"), raw.get("name")
            if not call_id or not name or call_id in call_ids:
                raise RuntimeError("Responses API 返回无效或重复的工具调用标识")
            try:
                args = json.loads(raw.get("arguments", ""))
            except (TypeError, ValueError) as exc:
                raise RuntimeError(f"Responses API 工具 {name} 的参数不是有效 JSON") from exc
            if not isinstance(args, dict):
                raise RuntimeError(f"Responses API 工具 {name} 的参数必须是 JSON 对象")
            call_ids.add(call_id)
            calls.append(ToolCall(id=call_id, name=name, arguments=args))
    text = "".join(texts)
    if not text.strip() and not calls:
        raise RuntimeError("Responses API 未返回文本或工具调用")
    return LLMResponse(
        text=text, tool_calls=calls or None,
        finish_reason="tool_use" if calls else "stop",
        responses_output_items=items,
    )


class OpenAIResponsesProvider(LLMProvider):
    provider_type = "openai_responses"

    def __init__(self, base_url: str, api_key: str, append_responses_path: bool = True, **kwargs):
        self.base_url = base_url.strip()
        self.api_key = api_key
        url = urlsplit(self.base_url)
        self._endpoint_url = (
            urlunsplit(url._replace(path=url.path.rstrip("/") + "/responses"))
            if append_responses_path else self.base_url
        )
        self._client = OpenAI(base_url=self.base_url, api_key=api_key)

    def chat(self, messages: list[dict], tools: list[dict] | None = None, **kwargs) -> LLMResponse:
        model = kwargs.get("model")
        if not model:
            raise ValueError("未指定模型，请在角色设置中选择一个模型")
        payload = {
            "model": model,
            "input": messages_to_responses(messages),
            "temperature": kwargs.get("temperature", 1.0),
            "max_output_tokens": kwargs.get("max_tokens", 2000),
            "store": False,
            "stream": False,
            "include": ["reasoning.encrypted_content"],
        }
        if tools:
            payload["tools"] = mcp_tools_to_responses(tools)
        if kwargs.get("json_mode", False):
            payload["text"] = {"format": {"type": "json_object"}}

        logger.info("Responses API 调用开始 (model=%s)", model)
        while True:
            try:
                # SDK's public POST retains typed parsing, auth, timeout and
                # retries while allowing an exact custom endpoint (no suffix).
                response = self._client.post(self._endpoint_url, body=payload, cast_to=Response)
                break
            except BadRequestError as exc:
                option = _unsupported_option(exc, payload)
                if option is None:
                    raise
                logger.warning("Responses API 不支持 %s，移除后重试 (model=%s)", option, model)
                payload.pop(option)
        return _parse_response(response)
