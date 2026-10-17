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

"""LLM provider registry, factory, and model capability tracking."""

from __future__ import annotations

import logging

from pawzochat.llm.base import LLMProvider
from pawzochat.llm.providers.openai_compat import OpenAICompatProvider
from pawzochat.llm.providers.openai_responses import OpenAIResponsesProvider
from pawzochat.llm.providers.anthropic_provider import AnthropicProvider
from pawzochat.llm.providers.gemini_provider import GeminiProvider

logger = logging.getLogger(__name__)

PROVIDER_PRESETS: dict[str, dict] = {
    "pawapi": {
        "name": "PawAPI (推荐)",
        "default_name": "PawAPI",
        "base_url": "https://paw.v1chat.cc/v1",
        "type": "openai_compatible",
        "endpoint_path": "/chat/completions",
    },
    "openai": {
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "type": "openai_compatible",
        "endpoint_path": "/chat/completions",
    },
    "anthropic": {
        "name": "Anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "type": "anthropic",
        "endpoint_path": "/messages",
    },
    "google": {
        "name": "Google",
        "base_url": "",
        "type": "gemini",
        "endpoint_path": "/v1beta/models/{model}:generateContent",
    },
    "deepseek": {
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com",
        "type": "openai_compatible",
        "endpoint_path": "/chat/completions",
    },
    "siliconflow": {
        "name": "硅基流动",
        "base_url": "https://api.siliconflow.cn/v1",
        "type": "openai_compatible",
        "endpoint_path": "/chat/completions",
    },
}

PRESET_MODELS: dict[str, list[dict]] = {
    "openai": [
        # Official chat model IDs and limits verified 2026-09-25:
        # https://developers.openai.com/api/docs/models
        {"id": "gpt-6-astra", "name": "GPT-6 Astra",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        # Sol/Luna tool calling on Chat Completions requires reasoning_effort=none.
        {"id": "gpt-6-sol", "name": "GPT-6 Sol",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-6-luna", "name": "GPT-6 Luna",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        # GPT-5.6 family. The gpt-5.6 alias points to gpt-5.6-sol, so only
        # the canonical model ID is listed here.
        {"id": "gpt-5.6-sol", "name": "GPT-5.6 Sol",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-5.6-terra", "name": "GPT-5.6 Terra",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-5.6-luna", "name": "GPT-5.6 Luna",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        # GPT-5.5; gpt-5.5-2026-04-23 is the pinned snapshot.
        {"id": "gpt-5.5", "name": "GPT-5.5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        # GPT-5.4 series
        {"id": "gpt-5.4", "name": "GPT-5.4",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-5.4-mini", "name": "GPT-5.4 Mini",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        {"id": "gpt-5.4-nano", "name": "GPT-5.4 Nano",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        # GPT-5.x intermediate versions
        {"id": "gpt-5.2", "name": "GPT-5.2",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        {"id": "gpt-5.1", "name": "GPT-5.1",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        # GPT-5 base series
        {"id": "gpt-5", "name": "GPT-5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        {"id": "gpt-5-mini", "name": "GPT-5 Mini",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        {"id": "gpt-5-nano", "name": "GPT-5 Nano",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        # GPT-4.1 series
        {"id": "gpt-4.1", "name": "GPT-4.1",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1047576, "max_output": 32768},
        {"id": "gpt-4.1-mini", "name": "GPT-4.1 Mini",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1047576, "max_output": 32768},
        {"id": "gpt-4.1-nano", "name": "GPT-4.1 Nano",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1047576, "max_output": 32768},
        # GPT-4o series
        {"id": "gpt-4o", "name": "GPT-4o",
         "capabilities": ["vision", "tool_use"],
         "context_window": 128000, "max_output": 16384},
        {"id": "gpt-4o-mini", "name": "GPT-4o Mini",
         "capabilities": ["vision", "tool_use"],
         "context_window": 128000, "max_output": 16384},
    ],
    "anthropic": [
        # Official model IDs and limits verified 2026-09-25:
        # https://platform.claude.com/docs/en/models/overview
        # Keep still-active older models; Haiku uses its canonical snapshot.
        {"id": "claude-fable-5-1", "name": "Claude Fable 5.1",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-opus-5-5", "name": "Claude Opus 5.5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-fable-5", "name": "Claude Fable 5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-opus-5", "name": "Claude Opus 5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-sonnet-5", "name": "Claude Sonnet 5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-opus-4-8", "name": "Claude Opus 4.8",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-opus-4-7", "name": "Claude Opus 4.7",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-opus-4-6", "name": "Claude Opus 4.6",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 64000},
        {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 200000, "max_output": 64000},
    ],
    "google": [
        # Official generateContent chat models verified 2026-09-25:
        # https://ai.google.dev/gemini-api/docs/models
        {"id": "gemini-3.8-flash", "name": "Gemini 3.8 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.7-flash", "name": "Gemini 3.7 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.6-flash", "name": "Gemini 3.6 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.5-flash", "name": "Gemini 3.5 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.5-flash-lite", "name": "Gemini 3.5 Flash-Lite",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro Preview",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.1-flash-lite", "name": "Gemini 3.1 Flash-Lite",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        # Gemini 2.5 remains available only to users with prior model usage.
        {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-2.5-flash-lite", "name": "Gemini 2.5 Flash-Lite",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
    ],
    "deepseek": [
        # Official model IDs, capabilities and limits verified 2026-09-25:
        # https://api-docs.deepseek.com/quick_start/pricing/
        # The old deepseek-v4-flash ID now redirects to deepseek-flash.
        {"id": "deepseek-flash", "name": "DeepSeek V4.1 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 384000},
        {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro 0813",
         "capabilities": ["tool_use"],
         "context_window": 1000000, "max_output": 384000},
    ],
    "siliconflow": [
        {"id": "Pro/MiniMaxAI/MiniMax-M2.5", "name": "MiniMax M2.5 (Pro)",
         "capabilities": ["tool_use"],
         "context_window": 204800, "max_output": 64000},
        # SiliconFlow /v1/models and model center verified 2026-07-29.
        {"id": "zai-org/GLM-5.2", "name": "GLM-5.2",
         "capabilities": ["tool_use"],
         "context_window": 1048576, "max_output": None},
        {"id": "Pro/zai-org/GLM-5.1", "name": "GLM-5.1 (Pro)",
         "capabilities": ["tool_use"],
         "context_window": 202752, "max_output": None},
        {"id": "zai-org/GLM-4.5V", "name": "GLM-4.5V",
         "capabilities": ["vision", "tool_use"],
         "context_window": 65536, "max_output": None},
        {"id": "zai-org/GLM-4.5-Air", "name": "GLM-4.5-Air",
         "capabilities": ["tool_use"],
         "context_window": 131072, "max_output": None},
        {"id": "moonshotai/Kimi-K2.7-Code", "name": "Kimi-K2.7-Code",
         "capabilities": ["vision", "tool_use"],
         "context_window": 262144, "max_output": None},
        {"id": "Pro/moonshotai/Kimi-K2.6", "name": "Kimi-K2.6 (Pro)",
         "capabilities": ["vision", "tool_use"],
         "context_window": 262144, "max_output": None},
        {"id": "deepseek-ai/DeepSeek-V4-Pro", "name": "DeepSeek V4 Pro",
         "capabilities": ["tool_use"],
         "context_window": 1048576, "max_output": 384000},
        {"id": "deepseek-ai/DeepSeek-V4-Flash", "name": "DeepSeek V4 Flash",
         "capabilities": ["tool_use"],
         "context_window": 1048576, "max_output": 384000},
        {"id": "deepseek-ai/DeepSeek-V3.2", "name": "DeepSeek V3.2",
         "capabilities": ["tool_use"],
         "context_window": 163840, "max_output": 64000},
        {"id": "Pro/deepseek-ai/DeepSeek-V3.2", "name": "DeepSeek V3.2 (Pro)",
         "capabilities": ["tool_use"],
         "context_window": 163840, "max_output": 64000},
        {"id": "deepseek-ai/DeepSeek-V3.1-Terminus",
         "name": "DeepSeek V3.1 Terminus",
         "capabilities": ["tool_use"],
         "context_window": 163840, "max_output": 64000},
        {"id": "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
         "name": "DeepSeek V3.1 Terminus (Pro)",
         "capabilities": ["tool_use"],
         "context_window": 163840, "max_output": 64000},
        {"id": "deepseek-ai/DeepSeek-R1", "name": "DeepSeek R1 0528",
         "capabilities": ["tool_use"],
         "context_window": 163840, "max_output": 64000},
        {"id": "Pro/deepseek-ai/DeepSeek-R1", "name": "DeepSeek R1 0528 (Pro)",
         "capabilities": ["tool_use"],
         "context_window": 163840, "max_output": 64000},
        {"id": "deepseek-ai/DeepSeek-V3", "name": "DeepSeek V3 0324",
         "capabilities": ["tool_use"],
         "context_window": 163840, "max_output": 8192},
        {"id": "Pro/deepseek-ai/DeepSeek-V3", "name": "DeepSeek V3 0324 (Pro)",
         "capabilities": ["tool_use"],
         "context_window": 163840, "max_output": 8192},
        # Current Qwen 3.5+ chat models. Older chat models and non-chat image,
        # embedding, and reranker models are intentionally excluded.
        {"id": "Qwen/Qwen3.6-35B-A3B", "name": "Qwen3.6-35B-A3B",
         "capabilities": ["vision", "tool_use"],
         "context_window": 262144, "max_output": None},
        {"id": "Qwen/Qwen3.6-27B", "name": "Qwen3.6-27B",
         "capabilities": ["vision", "tool_use"],
         "context_window": 262144, "max_output": None},
        {"id": "Qwen/Qwen3.5-397B-A17B", "name": "Qwen3.5-397B-A17B",
         "capabilities": ["vision", "tool_use"],
         "context_window": 262144, "max_output": 32768},
        {"id": "Qwen/Qwen3.5-122B-A10B", "name": "Qwen3.5-122B-A10B",
         "capabilities": ["vision", "tool_use"],
         "context_window": 262144, "max_output": 32768},
        {"id": "Qwen/Qwen3.5-35B-A3B", "name": "Qwen3.5-35B-A3B",
         "capabilities": ["vision", "tool_use"],
         "context_window": 262144, "max_output": None},
        {"id": "Qwen/Qwen3.5-27B", "name": "Qwen3.5-27B",
         "capabilities": ["vision", "tool_use"],
         "context_window": 262144, "max_output": None},
    ],
    "pawapi": [
        # PawAPI /v1/models and Chat Completions checked 2026-09-25.
        # https://api-docs.deepseek.com/quick_start/pricing/
        {"id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 384000},
        # PawAPI DeepSeek V3/V3.2: 128K context; tool-calling support follows what PawAPI provides
        {"id": "deepseek-v3", "name": "DeepSeek V3",
         "capabilities": ["tool_use"],
         "context_window": 128000, "max_output": 8192},
        {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro",
         "capabilities": ["tool_use"],
         "context_window": 1000000, "max_output": 384000},
        # https://ai.google.dev/gemini-api/docs/models
        {"id": "gemini-3.8-flash", "name": "Gemini 3.8 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.7-flash", "name": "Gemini 3.7 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.6-flash", "name": "Gemini 3.6 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.5-flash", "name": "Gemini 3.5 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.1-pro", "name": "Gemini 3.1 Pro",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3.1-flash-lite-preview",
         "name": "Gemini 3.1 Flash-Lite Preview",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3-pro", "name": "Gemini 3 Pro",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash Preview",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1048576, "max_output": 65536},
        # https://platform.claude.com/docs/en/models/overview
        {"id": "claude-opus-5-5", "name": "Claude Opus 5.5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-fable-5", "name": "Claude Fable 5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-opus-5", "name": "Claude Opus 5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-sonnet-5", "name": "Claude Sonnet 5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-opus-4-8", "name": "Claude Opus 4.8",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-opus-4-7", "name": "Claude Opus 4.7",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-opus-4-6", "name": "Claude Opus 4.6",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 128000},
        {"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1000000, "max_output": 64000},
        # PawAPI exposes Haiku's alias, not the official dated snapshot ID.
        {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 200000, "max_output": 64000},
        # https://developers.openai.com/api/docs/models
        {"id": "gpt-6-astra", "name": "GPT-6 Astra",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-5.6-sol", "name": "GPT-5.6 Sol",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-5.6-terra", "name": "GPT-5.6 Terra",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-5.6-luna", "name": "GPT-5.6 Luna",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-5.5", "name": "GPT 5.5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-5.4", "name": "GPT-5.4",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1050000, "max_output": 128000},
        {"id": "gpt-5.4-mini", "name": "GPT-5.4 Mini",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        {"id": "gpt-5.2", "name": "GPT-5.2",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        {"id": "chatgpt-5.2", "name": "ChatGPT 5.2",
         "capabilities": ["vision", "tool_use"],
         "context_window": 128000, "max_output": 16384},
        {"id": "gpt-5", "name": "GPT-5",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        {"id": "gpt-5-mini", "name": "GPT-5 Mini",
         "capabilities": ["vision", "tool_use"],
         "context_window": 400000, "max_output": 128000},
        {"id": "gpt-4.1", "name": "GPT-4.1",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1047576, "max_output": 32768},
        {"id": "gpt-4.1-mini", "name": "GPT-4.1 Mini",
         "capabilities": ["vision", "tool_use"],
         "context_window": 1047576, "max_output": 32768},
        {"id": "gpt-4o", "name": "GPT-4o",
         "capabilities": ["vision", "tool_use"],
         "context_window": 128000, "max_output": 16384},
        {"id": "gpt-4o-mini", "name": "GPT-4o Mini",
         "capabilities": ["vision", "tool_use"],
         "context_window": 128000, "max_output": 16384},
        # Doubao Seed 2.0 Pro: Volcano Ark flagship multimodal/tools; 256K context / 128K max output
        {"id": "doubao-seed-2-0-pro-260215", "name": "豆包 Seed 2.0 Pro",
         "capabilities": ["vision", "tool_use"],
         "context_window": 256000, "max_output": 128000},
        # Doubao Seed 1.6: Volcano Ark multimodal/tools; commonly quoted 256K context (Ark console is authoritative)
        {"id": "doubao-seed-1-6-250615", "name": "豆包 Seed 1.6",
         "capabilities": ["vision", "tool_use"],
         "context_window": 256000, "max_output": 32768},
        {"id": "doubao-seed-1-6-flash-250615", "name": "豆包 Seed 1.6 Flash",
         "capabilities": ["vision", "tool_use"],
         "context_window": 256000, "max_output": 32768},
    ],
}

PROVIDER_CLASSES: dict[str, type[LLMProvider]] = {
    "openai_compatible": OpenAICompatProvider,
    "openai_responses": OpenAIResponsesProvider,
    "anthropic": AnthropicProvider,
    "gemini": GeminiProvider,
}


def _normalize_model_entry(entry: dict) -> dict:
    """Ensure a model config entry has all expected fields."""
    return {
        "id": entry.get("id", ""),
        "name": entry.get("name", entry.get("id", "")),
        "capabilities": list(entry.get("capabilities", [])),
        "context_window": entry.get("context_window"),
        "max_output": entry.get("max_output"),
    }


def ensure_models_list(provider_cfg: dict) -> list[dict]:
    """Return the normalized models list for a provider."""
    return [_normalize_model_entry(m) for m in (provider_cfg.get("models") or [])]


class LLMManager:
    """Instantiate, register, and look up LLM providers by name."""

    def __init__(self):
        self._providers: dict[str, LLMProvider] = {}
        self._providers_cfg: dict[str, dict] = {}

    def register_provider(self, name: str, provider: LLMProvider):
        self._providers[name] = provider
        logger.info("LLM Provider 已注册: %s (%s)", name, provider.provider_type)

    def get_provider(self, name: str) -> LLMProvider | None:
        return self._providers.get(name)

    def init_from_config(self, providers_cfg: dict):
        """Read the llm_providers config section and instantiate all configured providers."""
        self._providers_cfg = providers_cfg
        for name, cfg in providers_cfg.items():
            api_key = cfg.get("api_key", "")
            if not api_key:
                logger.debug("跳过未配置 API key 的 Provider: %s", name)
                continue

            preset = cfg.get("preset", "custom")
            if preset != "custom" and preset in PROVIDER_PRESETS:
                preset_info = PROVIDER_PRESETS[preset]
                ptype = preset_info["type"]
                base_url = preset_info["base_url"]
            else:
                ptype = cfg.get("type", "openai_compatible")
                base_url = cfg.get("base_url", "")

            cls = PROVIDER_CLASSES.get(ptype)
            if cls is None:
                logger.warning("不支持的 Provider 类型: %s (name=%s)", ptype, name)
                continue

            try:
                init_kwargs: dict = {
                    "api_key": api_key,
                }
                if ptype != "gemini":
                    init_kwargs["base_url"] = base_url
                if ptype == "openai_compatible":
                    init_kwargs["append_chat_path"] = cfg.get("append_chat_path", True)
                if ptype == "openai_responses":
                    init_kwargs["append_responses_path"] = cfg.get("append_responses_path", True)

                provider = cls(**init_kwargs)
                self.register_provider(name, provider)
            except Exception:
                logger.exception("初始化 LLM Provider 失败: %s", name)

    def get_model_capabilities(
        self, provider_name: str, model_id: str
    ) -> list[str]:
        """Return the capability list for a specific model under a provider."""
        info = self.get_model_info(provider_name, model_id)
        return info.get("capabilities", [])

    def get_model_info(
        self, provider_name: str, model_id: str
    ) -> dict:
        """Return full model metadata (id, name, capabilities, context_window, max_output)."""
        cfg = self._providers_cfg.get(provider_name, {})
        models = ensure_models_list(cfg)

        for m in models:
            if m["id"] == model_id:
                return m

        return _normalize_model_entry({"id": model_id or ""})

    @property
    def available_providers(self) -> list[str]:
        return list(self._providers.keys())
