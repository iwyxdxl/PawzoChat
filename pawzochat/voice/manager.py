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

"""TTS provider registry, factory, and preset definitions.

Routing model: ``type`` is per-model, not per-provider (mirrors image provider
pattern). A single relay can host both MiniMax native models and OpenAI-compatible
models; each model entry carries its own ``type`` and is dispatched independently
when ``VoiceManager.get_provider_for_model`` is called.

``type`` (transport) and voice catalog (vendor) are separate axes: ``type`` picks
which provider class makes the HTTP call, while the catalog picks whose voice ids
are valid. PawAPI is why they cannot be merged — it serves MiniMax voices over the
OpenAI-compatible transport. See ``resolve_voice_catalog``.
"""

from __future__ import annotations

import logging

from pawzochat.voice.base import VoiceProvider
from pawzochat.voice.settings import control_family
from pawzochat.voice.providers.mimo_tts import MimoTTSProvider
from pawzochat.voice.providers.elevenlabs_tts import ElevenLabsTTSProvider
from pawzochat.voice.providers.minimaxi_tts import MiniMaxTTSProvider
from pawzochat.voice.providers.openai_tts import OpenAITTSProvider
from pawzochat.voice.providers.pawapi_tts import PawAPITTSProvider

logger = logging.getLogger(__name__)

VOICE_PROVIDER_PRESETS: dict[str, dict] = {
    "elevenlabs": {
        "name": "ElevenLabs", "default_name": "ElevenLabs",
        "base_url": "https://api.elevenlabs.io",
        "default_model_type": "elevenlabs_tts",
        "endpoint_path": "/v1/text-to-speech/{voice_id}",
    },
    "minimaxi": {
        "name": "MiniMax",
        "default_name": "MiniMax",
        "base_url": "https://api.minimaxi.com",
        "default_model_type": "minimaxi_tts",
        "endpoint_path": "/v1/t2a_v2",
    },
    "mimo": {
        "name": "MiMo (小米)",
        "default_name": "MiMo",
        "base_url": "https://api.xiaomimimo.com/v1",
        "default_model_type": "mimo_tts",
        "endpoint_path": "/chat/completions",
    },
    "openai_compatible": {
        "name": "OpenAI",
        "default_name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "default_model_type": "openai_tts",
        "endpoint_path": "/audio/speech",
    },
    "pawapi": {
        "name": "PawAPI (推荐)",
        "default_name": "PawAPI",
        "base_url": "https://paw.v1chat.cc/v1",
        "default_model_type": "openai_tts",
        "endpoint_path": "/audio/speech",
    },
}

VOICE_PRESET_MODELS: dict[str, list[dict]] = {
    "elevenlabs": [{"id": "eleven_v4", "name": "Eleven v4", "type": "elevenlabs_tts"}],
    "minimaxi": [
        {"id": "speech-02-hd", "name": "Speech 02 HD", "type": "minimaxi_tts"},
        {"id": "speech-02-turbo", "name": "Speech 02 Turbo", "type": "minimaxi_tts"},
        {"id": "speech-2.6-hd", "name": "Speech 2.6 HD", "type": "minimaxi_tts"},
        {"id": "speech-2.6-turbo", "name": "Speech 2.6 Turbo", "type": "minimaxi_tts"},
        {"id": "speech-2.8-hd", "name": "Speech 2.8 HD", "type": "minimaxi_tts"},
        {"id": "speech-2.8-turbo", "name": "Speech 2.8 Turbo", "type": "minimaxi_tts"},
    ],
    "mimo": [
        {"id": "mimo-v2.5-tts", "name": "MiMo v2.5 TTS", "type": "mimo_tts"},
    ],
    "openai_compatible": [
        {"id": "gpt-4o-mini-tts", "name": "GPT-4o Mini TTS", "type": "openai_tts"},
        {"id": "tts-1", "name": "TTS 1", "type": "openai_tts"},
        {"id": "tts-1-hd", "name": "TTS 1 HD", "type": "openai_tts"},
    ],
    "pawapi": [
        {"id": "speech-02-hd", "name": "Speech 02 HD", "type": "openai_tts"},
        {"id": "speech-02-turbo", "name": "Speech 02 Turbo", "type": "openai_tts"},
        {"id": "speech-2.6-hd", "name": "Speech 2.6 HD", "type": "openai_tts"},
        {"id": "speech-2.6-turbo", "name": "Speech 2.6 Turbo", "type": "openai_tts"},
        {"id": "speech-2.8-hd", "name": "Speech 2.8 HD", "type": "openai_tts"},
        {"id": "speech-2.8-turbo", "name": "Speech 2.8 Turbo", "type": "openai_tts"},
    ],
}

VOICE_PROVIDER_CLASSES: dict[str, type[VoiceProvider]] = {
    "elevenlabs_tts": ElevenLabsTTSProvider,
    "mimo_tts": MimoTTSProvider,
    "minimaxi_tts": MiniMaxTTSProvider,
    "openai_tts": OpenAITTSProvider,
}

MODEL_TYPE_OPTIONS: list[dict] = [
    {"value": "elevenlabs_tts", "label": "ElevenLabs 原生（仅 Eleven v4）",
     "endpoint_path": "/v1/text-to-speech/{voice_id}"},
    {
        "value": "minimaxi_tts",
        "label": "MiniMax 原生（/v1/t2a_v2）",
        "endpoint_path": "/v1/t2a_v2",
    },
    {
        "value": "mimo_tts",
        "label": "MiMo 原生（/v1/chat/completions）",
        "endpoint_path": "/v1/chat/completions",
    },
    {
        "value": "openai_tts",
        "label": "OpenAI 兼容（/v1/audio/speech）",
        "endpoint_path": "/v1/audio/speech",
    },
]

VALID_MODEL_TYPES: set[str] = {opt["value"] for opt in MODEL_TYPE_OPTIONS}

# Preset voice ids — surfaced to the front-end as dropdown suggestions.
#
# Keyed by *vendor catalog*, not by transport type: PawAPI relays MiniMax models
# over the OpenAI-compatible endpoint, so its models are typed ``openai_tts`` but
# need MiniMax voice ids. ``resolve_voice_catalog`` maps a model to its catalog.
#
# MiniMax splits system voices by region and the two catalogs DIVERGE — they are
# not subset/superset. api.minimaxi.com (China) publishes the legacy male-qn-* /
# female-* / character families; api.minimax.io (global) publishes none of them.
# Both the "minimaxi" and "pawapi" presets route to the China catalog, so they
# share the list below.
#
# Every id here comes from the official 系统音色列表
# (https://platform.minimaxi.com/docs/faq/system-voice-id) and was verified
# callable against /v1/t2a_v2. Ids that answer but are undocumented are left out
# on purpose: undocumented ids can be withdrawn without notice.
VOICE_CATALOGS: dict[str, list[dict]] = {
    "minimax": [
        # Chinese (Mandarin)
        {"id": "male-qn-qingse", "label": "青涩青年音色"},
        {"id": "male-qn-jingying", "label": "精英青年音色"},
        {"id": "male-qn-badao", "label": "霸道青年音色"},
        {"id": "male-qn-daxuesheng", "label": "青年大学生音色"},
        {"id": "female-shaonv", "label": "少女音色"},
        {"id": "female-yujie", "label": "御姐音色"},
        {"id": "female-chengshu", "label": "成熟女性音色"},
        {"id": "female-tianmei", "label": "甜美女性音色"},
        {"id": "clever_boy", "label": "聪明男童"},
        {"id": "cute_boy", "label": "可爱男童"},
        {"id": "lovely_girl", "label": "萌萌女童"},
        {"id": "cartoon_pig", "label": "卡通猪小琪"},
        {"id": "bingjiao_didi", "label": "病娇弟弟"},
        {"id": "junlang_nanyou", "label": "俊朗男友"},
        {"id": "chunzhen_xuedi", "label": "纯真学弟"},
        {"id": "lengdan_xiongzhang", "label": "冷淡学长"},
        {"id": "badao_shaoye", "label": "霸道少爷"},
        {"id": "tianxin_xiaoling", "label": "甜心小玲"},
        {"id": "qiaopi_mengmei", "label": "俏皮萌妹"},
        {"id": "wumei_yujie", "label": "妩媚御姐"},
        {"id": "diadia_xuemei", "label": "嗲嗲学妹"},
        {"id": "danya_xuejie", "label": "淡雅学姐"},
        {"id": "Chinese (Mandarin)_Reliable_Executive", "label": "沉稳高管"},
        {"id": "Chinese (Mandarin)_News_Anchor", "label": "新闻女声"},
        {"id": "Chinese (Mandarin)_Mature_Woman", "label": "傲娇御姐"},
        {"id": "Chinese (Mandarin)_Unrestrained_Young_Man", "label": "不羁青年"},
        {"id": "Arrogant_Miss", "label": "嚣张小姐"},
        {"id": "Robot_Armor", "label": "机械战甲"},
        {"id": "Chinese (Mandarin)_Kind-hearted_Antie", "label": "热心大婶"},
        {"id": "Chinese (Mandarin)_HK_Flight_Attendant", "label": "港普空姐"},
        {"id": "Chinese (Mandarin)_Humorous_Elder", "label": "搞笑大爷"},
        {"id": "Chinese (Mandarin)_Gentleman", "label": "温润男声"},
        {"id": "Chinese (Mandarin)_Warm_Bestie", "label": "温暖闺蜜"},
        {"id": "Chinese (Mandarin)_Male_Announcer", "label": "播报男声"},
        {"id": "Chinese (Mandarin)_Sweet_Lady", "label": "甜美女声"},
        {"id": "Chinese (Mandarin)_Southern_Young_Man", "label": "南方小哥"},
        {"id": "Chinese (Mandarin)_Wise_Women", "label": "阅历姐姐"},
        {"id": "Chinese (Mandarin)_Gentle_Youth", "label": "温润青年"},
        {"id": "Chinese (Mandarin)_Warm_Girl", "label": "温暖少女"},
        {"id": "Chinese (Mandarin)_Kind-hearted_Elder", "label": "花甲奶奶"},
        {"id": "Chinese (Mandarin)_Cute_Spirit", "label": "憨憨萌兽"},
        {"id": "Chinese (Mandarin)_Radio_Host", "label": "电台男主播"},
        {"id": "Chinese (Mandarin)_Lyrical_Voice", "label": "抒情男声"},
        {"id": "Chinese (Mandarin)_Straightforward_Boy", "label": "率真弟弟"},
        {"id": "Chinese (Mandarin)_Sincere_Adult", "label": "真诚青年"},
        {"id": "Chinese (Mandarin)_Gentle_Senior", "label": "温柔学姐"},
        {"id": "Chinese (Mandarin)_Stubborn_Friend", "label": "嘴硬竹马"},
        {"id": "Chinese (Mandarin)_Crisp_Girl", "label": "清脆少女"},
        {"id": "Chinese (Mandarin)_Pure-hearted_Boy", "label": "清澈邻家弟弟"},
        {"id": "Chinese (Mandarin)_Soft_Girl", "label": "柔和少女"},
        # Chinese (Cantonese)
        {"id": "Cantonese_ProfessionalHost（F)", "label": "专业女主持"},
        {"id": "Cantonese_GentleLady", "label": "温柔女声"},
        {"id": "Cantonese_ProfessionalHost（M)", "label": "专业男主持"},
        {"id": "Cantonese_PlayfulMan", "label": "活泼男声"},
        {"id": "Cantonese_CuteGirl", "label": "可爱女孩"},
        {"id": "Cantonese_KindWoman", "label": "善良女声"},
        # English
        {"id": "Santa_Claus", "label": "Santa Claus"},
        {"id": "Grinch", "label": "Grinch"},
        {"id": "Rudolph", "label": "Rudolph"},
        {"id": "Arnold", "label": "Arnold"},
        {"id": "Charming_Santa", "label": "Charming Santa"},
        {"id": "Charming_Lady", "label": "Charming Lady"},
        {"id": "Sweet_Girl", "label": "Sweet Girl"},
        {"id": "Cute_Elf", "label": "Cute Elf"},
        {"id": "Attractive_Girl", "label": "Attractive Girl"},
        {"id": "Serene_Woman", "label": "Serene Woman"},
        {"id": "English_Trustworthy_Man", "label": "Trustworthy Man"},
        {"id": "English_Graceful_Lady", "label": "Graceful Lady"},
        {"id": "English_Aussie_Bloke", "label": "Aussie Bloke"},
        {"id": "English_Whispering_girl", "label": "Whispering girl"},
        {"id": "English_Diligent_Man", "label": "Diligent Man"},
        {"id": "English_Gentle-voiced_man", "label": "Gentle-voiced man"},
        # Japanese
        {"id": "Japanese_IntellectualSenior", "label": "Intellectual Senior"},
        {"id": "Japanese_DecisivePrincess", "label": "Decisive Princess"},
        {"id": "Japanese_LoyalKnight", "label": "Loyal Knight"},
        {"id": "Japanese_DominantMan", "label": "Dominant Man"},
        {"id": "Japanese_SeriousCommander", "label": "Serious Commander"},
        {"id": "Japanese_ColdQueen", "label": "Cold Queen"},
        {"id": "Japanese_DependableWoman", "label": "Dependable Woman"},
        {"id": "Japanese_GentleButler", "label": "Gentle Butler"},
        {"id": "Japanese_KindLady", "label": "Kind Lady"},
        {"id": "Japanese_CalmLady", "label": "Calm Lady"},
        {"id": "Japanese_OptimisticYouth", "label": "Optimistic Youth"},
        {"id": "Japanese_GenerousIzakayaOwner", "label": "Generous Izakaya Owner"},
        {"id": "Japanese_SportyStudent", "label": "Sporty Student"},
        {"id": "Japanese_InnocentBoy", "label": "Innocent Boy"},
        {"id": "Japanese_GracefulMaiden", "label": "Graceful Maiden"},
        # Korean
        {"id": "Korean_SweetGirl", "label": "Sweet Girl"},
        {"id": "Korean_CheerfulBoyfriend", "label": "Cheerful Boyfriend"},
        {"id": "Korean_EnchantingSister", "label": "Enchanting Sister"},
        {"id": "Korean_ShyGirl", "label": "Shy Girl"},
        {"id": "Korean_ReliableSister", "label": "Reliable Sister"},
        {"id": "Korean_StrictBoss", "label": "Strict Boss"},
        {"id": "Korean_SassyGirl", "label": "Sassy Girl"},
        {"id": "Korean_ChildhoodFriendGirl", "label": "Childhood Friend Girl"},
        {"id": "Korean_PlayboyCharmer", "label": "Playboy Charmer"},
        {"id": "Korean_ElegantPrincess", "label": "Elegant Princess"},
        {"id": "Korean_BraveFemaleWarrior", "label": "Brave Female Warrior"},
        {"id": "Korean_BraveYouth", "label": "Brave Youth"},
        {"id": "Korean_CalmLady", "label": "Calm Lady"},
        {"id": "Korean_EnthusiasticTeen", "label": "Enthusiastic Teen"},
        {"id": "Korean_SoothingLady", "label": "Soothing Lady"},
        {"id": "Korean_IntellectualSenior", "label": "Intellectual Senior"},
        {"id": "Korean_LonelyWarrior", "label": "Lonely Warrior"},
        {"id": "Korean_MatureLady", "label": "Mature Lady"},
        {"id": "Korean_InnocentBoy", "label": "Innocent Boy"},
        {"id": "Korean_CharmingSister", "label": "Charming Sister"},
        {"id": "Korean_AthleticStudent", "label": "Athletic Student"},
        {"id": "Korean_BraveAdventurer", "label": "Brave Adventurer"},
        {"id": "Korean_CalmGentleman", "label": "Calm Gentleman"},
        {"id": "Korean_WiseElf", "label": "Wise Elf"},
        {"id": "Korean_CheerfulCoolJunior", "label": "Cheerful Cool Junior"},
        {"id": "Korean_DecisiveQueen", "label": "Decisive Queen"},
        {"id": "Korean_ColdYoungMan", "label": "Cold Young Man"},
        {"id": "Korean_MysteriousGirl", "label": "Mysterious Girl"},
        {"id": "Korean_QuirkyGirl", "label": "Quirky Girl"},
        {"id": "Korean_ConsiderateSenior", "label": "Considerate Senior"},
        {"id": "Korean_CheerfulLittleSister", "label": "Cheerful Little Sister"},
        {"id": "Korean_DominantMan", "label": "Dominant Man"},
        {"id": "Korean_AirheadedGirl", "label": "Airheaded Girl"},
        {"id": "Korean_ReliableYouth", "label": "Reliable Youth"},
        {"id": "Korean_FriendlyBigSister", "label": "Friendly Big Sister"},
        {"id": "Korean_GentleBoss", "label": "Gentle Boss"},
        {"id": "Korean_ColdGirl", "label": "Cold Girl"},
        {"id": "Korean_HaughtyLady", "label": "Haughty Lady"},
        {"id": "Korean_CharmingElderSister", "label": "Charming Elder Sister"},
        {"id": "Korean_IntellectualMan", "label": "Intellectual Man"},
        {"id": "Korean_CaringWoman", "label": "Caring Woman"},
        {"id": "Korean_WiseTeacher", "label": "Wise Teacher"},
        {"id": "Korean_ConfidentBoss", "label": "Confident Boss"},
        {"id": "Korean_AthleticGirl", "label": "Athletic Girl"},
        {"id": "Korean_PossessiveMan", "label": "Possessive Man"},
        {"id": "Korean_GentleWoman", "label": "Gentle Woman"},
        {"id": "Korean_CockyGuy", "label": "Cocky Guy"},
        {"id": "Korean_ThoughtfulWoman", "label": "Thoughtful Woman"},
        {"id": "Korean_OptimisticYouth", "label": "Optimistic Youth"},
    ],
    "mimo": [
        {"id": "mimo_default", "label": "MiMo 默认"},
        {"id": "冰糖", "label": "冰糖（中文·女）"},
        {"id": "茉莉", "label": "茉莉（中文·女）"},
        {"id": "苏打", "label": "苏打（中文·男）"},
        {"id": "白桦", "label": "白桦（中文·男）"},
        {"id": "Mia", "label": "Mia（英文·女）"},
        {"id": "Chloe", "label": "Chloe（英文·女）"},
        {"id": "Milo", "label": "Milo（英文·男）"},
        {"id": "Dean", "label": "Dean（英文·男）"},
    ],
    "openai": [
        {"id": "alloy", "label": ""},
        {"id": "ash", "label": ""},
        {"id": "ballad", "label": ""},
        {"id": "cedar", "label": ""},
        {"id": "coral", "label": ""},
        {"id": "echo", "label": ""},
        {"id": "fable", "label": ""},
        {"id": "marin", "label": ""},
        {"id": "nova", "label": ""},
        {"id": "onyx", "label": ""},
        {"id": "sage", "label": ""},
        {"id": "shimmer", "label": ""},
        {"id": "verse", "label": ""},
    ],
}

# preset -> catalog. The vendor behind a preset decides which voice ids are valid.
_PRESET_VOICE_CATALOGS: dict[str, str] = {
    "elevenlabs": "elevenlabs",
    "minimaxi": "minimax",
    "pawapi": "minimax",
    "mimo": "mimo",
    "openai_compatible": "openai",
}

# Fallback for "custom" relays, where the transport is the only vendor hint.
_TYPE_VOICE_CATALOGS: dict[str, str] = {
    "elevenlabs_tts": "elevenlabs",
    "minimaxi_tts": "minimax",
    "mimo_tts": "mimo",
    "openai_tts": "openai",
}


def _preset_default_type(preset: str) -> str:
    info = VOICE_PROVIDER_PRESETS.get(preset)
    return info["default_model_type"] if info else "openai_tts"


def resolve_model_type(provider_cfg: dict, model_entry: dict) -> str:
    """Pick the type for one model: ``model.type`` or the preset default."""
    return model_entry.get("type") or _preset_default_type(
        provider_cfg.get("preset", "custom"),
    )


def resolve_voice_catalog(provider_cfg: dict, model_entry: dict) -> str:
    """Pick which voice catalog one model's ids come from.

    The catalog follows the vendor, not the transport: a PawAPI model speaks the
    OpenAI-compatible protocol but is served by MiniMax, so it needs MiniMax
    voice ids. Only "custom" relays fall back to the transport type.
    """
    preset = provider_cfg.get("preset", "custom")
    catalog = _PRESET_VOICE_CATALOGS.get(preset)
    if catalog:
        return catalog
    return _TYPE_VOICE_CATALOGS.get(
        resolve_model_type(provider_cfg, model_entry), "openai",
    )


def resolve_base_url(provider_cfg: dict) -> str:
    preset = provider_cfg.get("preset", "custom")
    info = VOICE_PROVIDER_PRESETS.get(preset)
    return info["base_url"] if info else provider_cfg.get("base_url", "")


def ensure_voice_models_list(provider_cfg: dict) -> list[dict]:
    """Return the models list with each entry's type resolved (for API output)."""
    return [
        {
            "id": m.get("id", ""),
            "name": m.get("name", m.get("id", "")),
            "type": resolve_model_type(provider_cfg, m),
            "voice": m.get("voice", ""),
        }
        for m in (provider_cfg.get("models") or [])
    ]


class VoiceManager:
    """Resolve TTS providers per (provider_name, model_id) at call time."""

    def __init__(self):
        self._providers_cfg: dict[str, dict] = {}

    def init_from_config(self, providers_cfg: dict):
        self._providers_cfg = providers_cfg or {}

    def get_provider_for_model(
        self, name: str, model_id: str,
    ) -> VoiceProvider | None:
        """Build (or return None) the right provider class for one model."""
        cfg = self._providers_cfg.get(name)
        if cfg is None or not cfg.get("api_key"):
            return None

        model_entry = next(
            (m for m in (cfg.get("models") or []) if m.get("id") == model_id),
            None,
        )
        if model_entry is None:
            return None

        ptype = resolve_model_type(cfg, model_entry)
        cls = VOICE_PROVIDER_CLASSES.get(ptype)
        if cls is None:
            logger.warning(
                "不支持的 TTS type: %s (provider=%s model=%s)", ptype, name, model_id,
            )
            return None

        if cfg.get("preset") == "pawapi" and ptype == "openai_tts":
            cls = PawAPITTSProvider
        return cls(base_url=resolve_base_url(cfg), api_key=cfg["api_key"])

    def get_control_family(self, name: str, model_id: str) -> str:
        cfg = self._providers_cfg.get(name, {})
        model = next((m for m in (cfg.get("models") or []) if m.get("id") == model_id), {})
        return control_family(cfg, {**model, "type": resolve_model_type(cfg, model)})

    def get_model_voice(self, name: str, model_id: str) -> str:
        """Return the model entry's default voice id ("" when unset/missing)."""
        cfg = self._providers_cfg.get(name)
        if cfg is None:
            return ""
        model_entry = next(
            (m for m in (cfg.get("models") or []) if m.get("id") == model_id),
            None,
        )
        if model_entry is None:
            return ""
        return str(model_entry.get("voice", "") or "")

    @property
    def available_providers(self) -> list[str]:
        return list(self._providers_cfg.keys())
