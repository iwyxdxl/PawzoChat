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

"""YAML configuration loading, validation, and default value management."""

from __future__ import annotations

import copy
from datetime import datetime
import json
import logging
import os
from pathlib import Path
import shutil
import threading

import yaml

from pawzochat.paths import CONFIG_PATH, PROMPTS_DIR
from pawzochat.transport.models import (
    PROACTIVE_DEFAULTS,
    Persona,
    normalize_image_generation,
    normalize_voice_generation,
)

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_INSTRUCTIONS = (
    "回答应该尽量简短 控制在30字以内\n"
    "使用中文回答\n"
    "不要体现出机器人的特征 不要使用机器人术语\n"
    "单次回复的长度不应过长 应该是较为简短的日常对话\n"
    "语气可以参考输出示例\n"
    "使用反斜线(\\)分隔句子或短语 参考输出示例\n"
    "使用反斜线(\\)分隔的句子或短语不要超过四句 输出不要带句号和逗号\n"
    "不要使用括号描述动作和心理 只输出语言\n"
    "用户的消息带有消息发送时间 请以该时间为准 模型的输出不应该带时间"
)

# Group conversations own their shared instructions. Never inherit edits to a
# persona's private-chat system instructions when constructing group context.
DEFAULT_GROUP_SYSTEM_INSTRUCTIONS = (
    "这是一个有真人用户和多个角色共同参与的群聊\n"
    "请结合完整群聊记录自然接话 可以回应用户或其他成员\n"
    "接话前先结合发言者、称呼、点名、引用和前后文 判断每句话是在对谁说\n"
    "消息中的“我”属于该条消息的发言者 “你”和亲密称呼不一定指你 不要因为轮到你发言就自动代入\n"
    "其他成员对用户或另一位成员说话时 你可以自然插话、评论或调侃 但不要以被询问者的身份回答 不要把别人的关系或经历当成自己的\n"
    "对话对象不明确时 不要擅自认领称呼或代替别人回应 可以接明确的话题 必要时自然询问\n"
    "需要邀请其他角色回应时 可以使用 @成员完整姓名 点名 不必每次发言都点名\n"
    "一次回复对同一角色最多 @ 一次\n"
    "只输出你自己的本次发言 不替其他成员或用户说话 不要输出说话人标签\n"
    "使用中文回答 保持角色个性 语气可以参考角色的输出示例 不要使用机器人术语\n"
    "回复尽量简短 控制在30字以内 保持日常聊天的自然语气 \n"
    "使用反斜线(\\)分隔句子或短语 参考输出示例\n"
    "使用反斜线(\\)分隔的句子或短语不要超过两句 输出不要带句号和逗号\n"
    "不要使用括号描述动作和心理 只输出语言\n"
    "消息中的发送时间仅供理解上下文 回复不要带时间"
)

DEFAULTS: dict = {
    "log_level": "info",
    "llm_providers": {},
    "image_providers": {},
    "voice_providers": {},
    "personas": {},
    "mcp_servers": {},
    "capability_adapters": {},
    "chat": {
        "max_context_rounds": 20,
        "queue_wait_seconds": 7,
    },
    "reply": {
        "typing_delay_enabled": True,
        "typing_speed": 0.2,
        "typing_speed_random_min": 0.05,
        "typing_speed_random_max": 0.1,
        "split_by_newline": True,
        "show_typing_indicator": True,
    },
    "web": {
        "port": 62000,
        "password": "",
        "public_enabled": False,
        "public_port": 0,
        "public_secret": "",
    },
    "theme": {
        "mode": "light",       # "light" | "dark" | "auto"
        "active": [],          # ordered list of theme folder names to layer
    },
    "moments": {
        "publishers": [],      # persona_ids allowed to publish moments
        "repliers": [],        # persona_ids that may reply (probability-gated)
        "reply_probabilities": {},  # {persona_id: int 0-100}; missing → 50
        "memory_enabled": {},  # {persona_id: bool}; missing → True
        "prompts": {
            "post": "",        # empty → service uses DEFAULT_POST_PROMPT
            "reply": "",       # empty → service uses DEFAULT_REPLY_PROMPT
        },
    },
    "telemetry": {
        # Only the user-facing privacy switch lives in config; the endpoint,
        # website id and heartbeat interval are project-fixed constants in
        # ``pawzochat/services/telemetry.py`` so they can't be accidentally
        # broken by editing config.yaml.
        "enabled": False,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge *override* into *base*, returning a new dict."""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


class ConfigManager:
    """Load, validate, and provide access to the YAML configuration."""

    def __init__(self):
        self._data: dict = {}
        self._fresh_install: bool = False
        self._lock = threading.RLock()

    @property
    def lock(self) -> threading.RLock:
        """Reentrant lock guarding ``_data`` read-modify-write sequences.

        Callers performing ``get → mutate → save()`` must wrap the block
        in ``with config.lock:`` so concurrent writers (Flask request
        threads and background services) cannot corrupt the YAML file.
        """
        return self._lock

    @property
    def data(self) -> dict:
        return self._data

    @property
    def fresh_install(self) -> bool:
        return self._fresh_install

    def mark_setup_done(self):
        self._fresh_install = False

    @staticmethod
    def _backup_path():
        return CONFIG_PATH.with_suffix(CONFIG_PATH.suffix + ".bak")

    @staticmethod
    def _read_config_file(path) -> dict:
        if path.stat().st_size == 0:
            raise ValueError("empty config")
        with open(path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)
        if not isinstance(raw, dict):
            raise ValueError("config root must be a mapping")
        return raw

    @staticmethod
    def _quarantine_bad_config(reason: str):
        if not CONFIG_PATH.exists():
            return None

        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        reason = "".join(ch for ch in reason if ch.isalnum() or ch in ("-", "_"))
        base = CONFIG_PATH.with_name(
            f"{CONFIG_PATH.stem}.invalid-{reason}-{stamp}{CONFIG_PATH.suffix}",
        )
        target = base
        counter = 1
        while target.exists():
            target = base.with_name(f"{base.stem}-{counter}{base.suffix}")
            counter += 1

        try:
            CONFIG_PATH.rename(target)
        except OSError:
            logger.warning("隔离损坏配置失败: %s", CONFIG_PATH, exc_info=True)
            return None

        logger.warning("损坏配置已隔离: %s -> %s", CONFIG_PATH, target)
        return target

    def load(self) -> dict:
        self._fresh_install = not CONFIG_PATH.exists()
        if not CONFIG_PATH.exists():
            logger.info("未找到配置文件，正在生成默认配置: %s", CONFIG_PATH)
            self._data = copy.deepcopy(DEFAULTS)
            self.save()
            return self._data

        try:
            raw = self._read_config_file(CONFIG_PATH)
        except (OSError, ValueError, yaml.YAMLError) as exc:
            reason = (
                "empty"
                if isinstance(exc, ValueError) and "empty" in str(exc)
                else "invalid"
            )
            self._quarantine_bad_config(reason)
            backup_path = self._backup_path()

            try:
                raw = self._read_config_file(backup_path)
            except (OSError, ValueError, yaml.YAMLError):
                logger.warning(
                    "配置文件不可用且备份恢复失败，将使用默认配置重新初始化: %s",
                    CONFIG_PATH,
                    exc_info=True,
                )
                self._fresh_install = True
                self._data = copy.deepcopy(DEFAULTS)
                self.save()
                return self._data

            logger.warning("已从配置备份恢复: %s", backup_path)
            self._data = _deep_merge(DEFAULTS, raw)
            self.save()
            return self._data

        self._data = _deep_merge(DEFAULTS, raw)
        logger.info("配置已加载: %s", CONFIG_PATH)
        return self._data

    def save(self):
        # Atomic write: dump to <name>.tmp then os.replace onto the real path.
        # A bare ``open(path, "w")`` truncates first and writes incrementally,
        # so any interruption mid-dump (crash, power loss, full disk) leaves
        # an empty/partial yaml on disk — next startup then deep-merges {} over
        # DEFAULTS and the user sees "config got wiped".
        with self._lock:
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = CONFIG_PATH.with_suffix(CONFIG_PATH.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                yaml.dump(self._data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
                f.flush()
                os.fsync(f.fileno())
            if CONFIG_PATH.exists():
                try:
                    self._read_config_file(CONFIG_PATH)
                    shutil.copy2(CONFIG_PATH, self._backup_path())
                except (OSError, ValueError, yaml.YAMLError):
                    logger.warning("当前配置不可备份，跳过备份: %s", CONFIG_PATH, exc_info=True)
            os.replace(tmp, CONFIG_PATH)
        logger.info("配置已保存: %s", CONFIG_PATH)

    # ---- convenience accessors ----

    def get(self, *keys: str, default=None):
        """Dot-path access: config.get('chat', 'max_context_rounds')."""
        node = self._data
        for k in keys:
            if isinstance(node, dict) and k in node:
                node = node[k]
            else:
                return default
        return node

    @staticmethod
    def prompt_path(persona_id: str) -> Path:
        """Derive the prompt JSON file path from a persona id."""
        return PROMPTS_DIR / f"{persona_id}.json"

    @staticmethod
    def _read_prompt_file(persona_id: str) -> dict:
        """Return the raw prompt JSON dict, or {} when missing/corrupt."""
        path = PROMPTS_DIR / f"{persona_id}.json"
        if not path.is_file():
            return {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("提示词文件损坏，已跳过: %s (%s)", path, exc)
            return {}
        return raw if isinstance(raw, dict) else {}

    @staticmethod
    def _atomic_write_prompt_file(persona_id: str, data: dict) -> None:
        PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
        target = PROMPTS_DIR / f"{persona_id}.json"
        tmp = target.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, target)

    @classmethod
    def _load_prompt_parts(cls, persona_id: str) -> tuple[str, str, str]:
        """Read the three chat prompt sections from the JSON file.

        Returns ``(character_prompt, output_examples, system_instructions)``.
        Tolerates missing or corrupt files so a single bad file cannot break
        the entire persona loading pipeline.
        """
        raw = cls._read_prompt_file(persona_id)
        return (
            raw.get("character_prompt", ""),
            raw.get("output_examples", ""),
            raw.get("system_instructions", ""),
        )

    @classmethod
    def _load_image_prompt_overrides(cls, persona_id: str) -> dict:
        """Return only image_* fields actually present in the prompt file,
        keyed by the public ``image_generation`` field names so the dict can
        be merged on top of the yaml block before normalization.
        """
        raw = cls._read_prompt_file(persona_id)
        out: dict = {}
        if "image_style_prefix" in raw:
            out["style_prefix"] = str(raw["image_style_prefix"])
        if "image_art_style" in raw:
            out["art_style"] = str(raw["image_art_style"])
        if "image_negative_prompt" in raw:
            out["negative_prompt"] = str(raw["image_negative_prompt"])
        return out

    @classmethod
    def save_prompt_parts(
        cls,
        persona_id: str,
        character_prompt: str,
        output_examples: str,
        system_instructions: str,
    ) -> None:
        """Atomically update the three chat prompt sections, preserving any
        image_* sections already in the file."""
        data = cls._read_prompt_file(persona_id)
        data.update({
            "character_prompt": character_prompt,
            "output_examples": output_examples,
            "system_instructions": system_instructions,
        })
        cls._atomic_write_prompt_file(persona_id, data)

    @classmethod
    def save_image_prompt_parts(
        cls,
        persona_id: str,
        style_prefix: str,
        art_style: str,
        negative_prompt: str,
    ) -> None:
        """Atomically update the three image prompt sections, preserving any
        chat sections already in the file."""
        data = cls._read_prompt_file(persona_id)
        data.update({
            "image_style_prefix": style_prefix,
            "image_art_style": art_style,
            "image_negative_prompt": negative_prompt,
        })
        cls._atomic_write_prompt_file(persona_id, data)

    def load_personas(self) -> dict[str, Persona]:
        """Parse personas section into Persona objects."""
        result: dict[str, Persona] = {}
        for pid, pdata in self.get("personas", default={}).items():
            name = pdata.get("name", pid)
            character, examples, system = self._load_prompt_parts(pid)

            tp_raw = pdata.get("tool_policy", {})
            tool_policy = {
                "mode": tp_raw.get("mode", "all"),
                "list": list(tp_raw.get("list", [])),
                "max_iterations": int(tp_raw.get("max_iterations", 10)),
                "timeout_seconds": int(tp_raw.get("timeout_seconds", 30)),
            }

            mem_raw = pdata.get("memory", {})
            trigger_mode = mem_raw.get("trigger_mode", "remind")
            group_reads = mem_raw.get("group_reads", {})
            if not isinstance(group_reads, dict):
                group_reads = {}
            memory = {
                "enabled": bool(mem_raw.get("enabled", True)),
                "max_memories": int(mem_raw.get("max_memories", 50)),
                "include_in_prompt": bool(mem_raw.get("include_in_prompt", True)),
                "trigger_rounds": int(mem_raw.get("trigger_rounds", 10)),
                "trigger_mode": trigger_mode
                if trigger_mode in ("remind", "summarize", "summarize_only") else "remind",
                # Missing sources, including future groups, are readable by
                # default. Ignore malformed hand-edited overrides.
                "group_reads": {
                    gid: enabled for gid, enabled in group_reads.items()
                    if isinstance(gid, str) and isinstance(enabled, bool)
                },
            }

            pro_raw = pdata.get("proactive", {})
            qh_raw = pro_raw.get("quiet_hours", {})
            pro_d = PROACTIVE_DEFAULTS
            qh_d = pro_d["quiet_hours"]
            proactive = {
                "enabled": bool(pro_raw.get("enabled", pro_d["enabled"])),
                "min_idle_hours": float(pro_raw.get("min_idle_hours", pro_d["min_idle_hours"])),
                "max_idle_hours": float(pro_raw.get("max_idle_hours", pro_d["max_idle_hours"])),
                "max_consecutive": int(pro_raw.get("max_consecutive", pro_d["max_consecutive"])),
                "prompt": pro_raw.get("prompt", pro_d["prompt"]),
                "quiet_hours": {
                    "enabled": bool(qh_raw.get("enabled", qh_d["enabled"])),
                    "start": qh_raw.get("start", qh_d["start"]),
                    "end": qh_raw.get("end", qh_d["end"]),
                },
            }

            ig_raw = dict(pdata.get("image_generation") or {})
            ig_raw.update(self._load_image_prompt_overrides(pid))
            image_generation = normalize_image_generation(ig_raw)

            voice_generation = normalize_voice_generation(pdata.get("voice_generation"))

            result[pid] = Persona(
                id=pid,
                name=name,
                character_prompt=character,
                output_examples=examples,
                system_instructions=system,
                llm_provider=pdata.get("llm_provider", ""),
                llm_model=pdata.get("llm_model", ""),
                temperature=float(pdata.get("temperature", 1.0)),
                max_tokens=int(pdata.get("max_tokens", 2000)),
                emoji_enabled=bool(pdata.get("emoji_enabled", False)),
                emoji_send_probability=int(pdata.get("emoji_send_probability", 25)),
                emoji_group=pdata.get("emoji_group", ""),
                tool_policy=tool_policy,
                memory=memory,
                proactive=proactive,
                image_generation=image_generation,
                voice_generation=voice_generation,
                bound_worldbooks=list(pdata.get("bound_worldbooks", [])),
            )
        return result
