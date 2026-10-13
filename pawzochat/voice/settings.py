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

"""Provider-level TTS controls shared by persistence, UI, chat and preview."""
from __future__ import annotations

import copy
import math
import re

VOICE_GENERATION_DEFAULTS = {
    "enabled": False, "provider": "", "model": "", "voice": "", "speed": 1.0,
    "trigger_mode": "ai", "trigger_probability": 50,
    "emotion_enabled": False, "emotion": "",
    "minimax": {"interjections_enabled": False, "pause_enabled": False,
                "language_boost": "", "volume": 1.0, "pitch": 0},
    "mimo": {"dialect": "auto", "speaking_rate": "auto", "style_instruction": ""},
    "elevenlabs": {"stability": 0.5, "similarity_boost": 0.75, "audio_tags_enabled": False},
}
INTERJECTIONS = tuple(f"({tag})" for tag in (
    "laughs", "chuckle", "coughs", "clear-throat", "groans", "breath", "pant",
    "inhale", "exhale", "gasps", "sniffs", "sighs", "snorts", "burps",
    "lip-smacking", "humming", "hissing", "emm", "sneezes",
))
_INTERJECTION_RE = re.compile("|".join(re.escape(t) for t in INTERJECTIONS), re.I)
_PAUSE_TAG_RE = re.compile(r"<#[+-]?(?:\d+(?:\.\d*)?|\.\d+)#>")
# Include retired tags only to clean fallback text from older replies.
_EMOTION_TAG_RE = re.compile(r"\[(?:happy|sad|angry|fearful|disgusted|surprised|neutral|calm|fluent|whisper)\]", re.I)
EMOTIONS = {"": "自动", "happy": "高兴", "sad": "悲伤", "angry": "愤怒", "fearful": "害怕",
            "disgusted": "厌恶", "surprised": "惊讶", "calm": "平静"}
ELEVENLABS_AUDIO_TAGS = ("laughs", "chuckles", "sighs", "exhales", "clears throat", "whispers", "shouts")
_ELEVENLABS_AUDIO_TAG_RE = re.compile(r"\[(?:" + "|".join(re.escape(t) for t in ELEVENLABS_AUDIO_TAGS) + r")\]", re.I)
LANGUAGES = {
    'Chinese': '中文（普通话）',
    'Chinese,Yue': '中文（粤语）',
    'English': '英语',
    'Arabic': '阿拉伯语',
    'Russian': '俄语',
    'Spanish': '西班牙语',
    'French': '法语',
    'Portuguese': '葡萄牙语',
    'German': '德语',
    'Turkish': '土耳其语',
    'Dutch': '荷兰语',
    'Ukrainian': '乌克兰语',
    'Vietnamese': '越南语',
    'Indonesian': '印尼语',
    'Japanese': '日语',
    'Italian': '意大利语',
    'Korean': '韩语',
    'Thai': '泰语',
    'Polish': '波兰语',
    'Romanian': '罗马尼亚语',
    'Greek': '希腊语',
    'Czech': '捷克语',
    'Finnish': '芬兰语',
    'Hindi': '印地语',
    'Bulgarian': '保加利亚语',
    'Danish': '丹麦语',
    'Hebrew': '希伯来语',
    'Malay': '马来语',
    'Persian': '波斯语',
    'Slovak': '斯洛伐克语',
    'Swedish': '瑞典语',
    'Croatian': '克罗地亚语',
    'Filipino': '菲律宾语',
    'Hungarian': '匈牙利语',
    'Norwegian': '挪威语',
    'Slovenian': '斯洛文尼亚语',
    'Catalan': '加泰罗尼亚语',
    'Nynorsk': '新挪威语',
    'Tamil': '泰米尔语',
    'Afrikaans': '南非荷兰语',
}
DIALECTS = {"auto": "自动", "普通话": "普通话", "粤语": "粤语", "四川话": "四川话", "东北话": "东北话", "河南话": "河南话"}
RATES = {"auto": "自动", "slow": "慢", "slightly_slow": "稍慢", "normal": "正常", "slightly_fast": "稍快", "fast": "快"}


def control_family(provider_cfg: dict, model_entry: dict) -> str:
    preset = provider_cfg.get("preset")
    if preset in ("minimaxi", "pawapi"):
        return "minimax"
    if preset == "elevenlabs":
        return "elevenlabs"
    if preset == "mimo":
        return "mimo"
    return {"minimaxi_tts": "minimax", "mimo_tts": "mimo", "elevenlabs_tts": "elevenlabs"}.get(model_entry.get("type"), "openai")


def control_description(family: str) -> dict:
    if family == "elevenlabs":
        return {"family": family, "stability": {"min": 0, "max": 1, "step": 0.01},
                "similarity_boost": {"min": 0, "max": 1, "step": 0.01},
                "emotions": EMOTIONS,
                "emotion_hint": "通过音频标签引导整条语音的情绪。",
                "audio_tags_hint": "允许 AI 按语境添加笑声、叹气、耳语等标签。"}
    common = {"family": family, "speed": {"min": 0.5, "max": 2, "step": 0.1}}
    if family == "minimax":
        return {**common, "languages": {"": "跟随音色", "auto": "自动判断", **LANGUAGES},
                "emotions": EMOTIONS, "volume": {"min": 0.01, "max": 10, "step": 0.01},
                "pitch": {"min": -12, "max": 12, "step": 1},
                "interjection_hint": "仅 Speech 2.8 系列模型支持语气词。",
                "pause_hint": "开启后模型可在语音中添加停顿。",
                "emotion_hint": "控制合成语音的情绪，但也可能影响声音风格。"}
    if family == "mimo":
        return {**common, "dialects": DIALECTS, "rates": RATES,
                "emotions": EMOTIONS,
                "emotion_hint": "通过风格指令控制情绪；关闭后不自动添加情绪指令，自填风格描述仍会生效。"}
    return common


def _number(value, default, lo, hi):
    try:
        n = float(value)
        return max(lo, min(hi, n)) if math.isfinite(n) else default
    except (TypeError, ValueError):
        return default


def normalize_voice_generation(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    out = copy.deepcopy(VOICE_GENERATION_DEFAULTS)
    for key in ("provider", "model", "voice"):
        out[key] = str(raw.get(key) or "").strip()
    out["enabled"] = bool(raw.get("enabled", False))
    out["trigger_mode"] = "probability" if raw.get("trigger_mode") == "probability" else "ai"
    probability = raw.get("trigger_probability")
    out["trigger_probability"] = int(_number(
        probability if not isinstance(probability, bool) else None, 50, 0, 100,
    ))
    out["speed"] = _number(raw.get("speed"), 1.0, 0.25, 4)
    out["emotion_enabled"] = raw.get("emotion_enabled") is True
    emotion = raw.get("emotion", "")
    out["emotion"] = "calm" if emotion == "neutral" else (emotion if isinstance(emotion, str) and emotion in EMOTIONS else "")
    mm = raw.get("minimax") if isinstance(raw.get("minimax"), dict) else {}
    lang = mm.get("language_boost", "")
    out["minimax"] = {
        "interjections_enabled": mm.get("interjections_enabled") is True,
        "pause_enabled": mm.get("pause_enabled") is True,
        "language_boost": lang if isinstance(lang, str) and lang in ("", "auto", *LANGUAGES) else "",
        "volume": _number(mm.get("volume"), 1.0, 0, 10) or 1.0,
        "pitch": int(_number(mm.get("pitch"), 0, -12, 12)),
    }
    mi = raw.get("mimo") if isinstance(raw.get("mimo"), dict) else {}
    out["mimo"] = {
        "dialect": mi.get("dialect") if isinstance(mi.get("dialect"), str) and mi["dialect"] in DIALECTS else "auto",
        "speaking_rate": mi.get("speaking_rate") if isinstance(mi.get("speaking_rate"), str) and mi["speaking_rate"] in RATES else "auto",
        "style_instruction": str(mi.get("style_instruction") or ""),
    }
    el = raw.get("elevenlabs") if isinstance(raw.get("elevenlabs"), dict) else {}
    out["elevenlabs"] = {
        "stability": _number(el.get("stability"), 0.5, 0, 1),
        "similarity_boost": _number(el.get("similarity_boost"), 0.75, 0, 1),
        "audio_tags_enabled": el.get("audio_tags_enabled") is True,
    }
    return out


def merge_voice_generation(current, patch):
    out = normalize_voice_generation(current)
    if not isinstance(patch, dict):
        return patch
    for key in VOICE_GENERATION_DEFAULTS:
        if key in patch:
            if key in ("minimax", "mimo", "elevenlabs") and isinstance(patch[key], dict):
                out[key].update(patch[key])
            else:
                out[key] = patch[key]
    return out


def validate_voice_generation(raw) -> str | None:
    """Validate explicit API values before tolerant on-disk normalization."""
    if not isinstance(raw, dict):
        return "voice_generation 必须为对象"
    if "trigger_mode" in raw and raw["trigger_mode"] not in ("ai", "probability"):
        return "trigger_mode 必须为 ai 或 probability"
    if "trigger_probability" in raw and (
        type(raw["trigger_probability"]) is not int
        or not 0 <= raw["trigger_probability"] <= 100
    ):
        return "trigger_probability 必须为 0–100 的整数"
    for key in ("enabled", "emotion_enabled"):
        if key in raw and not isinstance(raw[key], bool):
            return f"{key} 必须为布尔值"
    for key in ("provider", "model", "voice", "emotion"):
        if key in raw and not isinstance(raw[key], str):
            return f"{key} 必须为文本"
    if raw.get("emotion", "") not in (*EMOTIONS, "neutral"):
        return "emotion 不在支持的情绪列表中"
    for key in ("minimax", "mimo", "elevenlabs"):
        if key in raw and not isinstance(raw[key], dict):
            return f"{key} 必须为对象"
    mm, mi = raw.get("minimax", {}), raw.get("mimo", {})
    el = raw.get("elevenlabs", {})
    if "audio_tags_enabled" in el and not isinstance(el["audio_tags_enabled"], bool):
        return "elevenlabs.audio_tags_enabled 必须为布尔值"
    for key in ("interjections_enabled", "pause_enabled"):
        if key in mm and not isinstance(mm[key], bool):
            return f"minimax.{key} 必须为布尔值"
    for values, key, options, path in ((mm, "language_boost", ("", "auto", *LANGUAGES), "minimax"),
                                      (mi, "dialect", DIALECTS, "mimo"), (mi, "speaking_rate", RATES, "mimo")):
        if key in values and (not isinstance(values[key], str) or values[key] not in options):
            return f"{path}.{key} 不在支持的选项中"
    if "style_instruction" in mi and (not isinstance(mi["style_instruction"], str) or len(mi["style_instruction"]) > 4000):
        return "mimo.style_instruction 必须为不超过 4000 字符的文本"
    for values, key, lo, hi, integral in ((raw, "speed", 0.25, 4, False), (mm, "volume", 0, 10, False), (mm, "pitch", -12, 12, True),
                                          (el, "stability", 0, 1, False), (el, "similarity_boost", 0, 1, False)):
        if key not in values:
            continue
        try:
            n = float(values[key])
            if isinstance(values[key], bool) or not math.isfinite(n) or n < lo or n > hi or (key == "volume" and n == 0) or (integral and not n.is_integer()):
                raise ValueError
        except (TypeError, ValueError):
            return f"{key} 超出有效范围：{'(' if key == 'volume' else '['}{lo}, {hi}]" + ("，须为整数" if integral else "")
    return None


def strip_interjections(text: str) -> str:
    return _INTERJECTION_RE.sub("", text)


def strip_pause_tags(text: str) -> str:
    return _PAUSE_TAG_RE.sub("", text)


def clean_fallback_text(text: str, *, preserve_boundaries: bool = False) -> str:
    # Group mentions must remain recognizable after voice controls disappear:
    # @name(laughs)hello should not turn into the different name @namehello.
    replacement = " " if preserve_boundaries else ""
    for pattern in (_INTERJECTION_RE, _PAUSE_TAG_RE, _EMOTION_TAG_RE, _ELEVENLABS_AUDIO_TAG_RE):
        text = pattern.sub(replacement, text)
    return text


def strip_elevenlabs_audio_tags(text: str) -> str:
    return _ELEVENLABS_AUDIO_TAG_RE.sub(" ", text)


def prepare_elevenlabs_text(text: str, settings: dict, emotion: str = "") -> str:
    # Spaces retain word and mention boundaries when a control disappears.
    text = _INTERJECTION_RE.sub(" ", _PAUSE_TAG_RE.sub(" ", text))
    if not settings["elevenlabs"]["audio_tags_enabled"]:
        text = strip_elevenlabs_audio_tags(text)
    if not settings["emotion_enabled"]:
        text = _EMOTION_TAG_RE.sub(" ", text)
    if not clean_fallback_text(text).strip():
        return ""
    return f"[{emotion}] {text}" if emotion else text


def effective_emotion(settings: dict, emotion: str = "") -> str:
    if not settings["emotion_enabled"]:
        return ""
    # Legacy persona emotion values remain readable for configuration roundtrips,
    # but only a per-message emotion can affect synthesis.
    value = "calm" if emotion == "neutral" else emotion
    return value if value in EMOTIONS else ""


def voice_guidance(settings: dict, family: str, voice: str = "") -> str:
    """Only inject enabled protocols; there is deliberately no model-name gate."""
    sections = []
    language = ""
    if family == "minimax":
        boost = settings["minimax"]["language_boost"] or ("Chinese,Yue" if voice.startswith("Cantonese_") else "")
        language = LANGUAGES.get(boost, "")
    elif family == "mimo" and settings["mimo"]["dialect"] != "auto":
        language = settings["mimo"]["dialect"]
    if language:
        sections.append(
            "【语音语言与方言】\n"
            f"本次语音使用：{language}。\n"
            "请使用符合该语言或方言的词汇、句式和日常表达组织语音内容，同时保持角色原有的身份、性格和说话习惯。"
            "不要为了体现方言而刻意堆砌口头禅或生硬改写。\n"
            "这一要求只作用于语音段，普通文字回复仍遵循原有角色设定。"
        )
    if family == "minimax" and settings["minimax"]["interjections_enabled"]:
        sections.append(
            "【语气词与非语言声音】\n"
            "你可以根据角色性格、语境和说话状态，在语音正文中自然插入以下声音标签。"
            "它们会交给语音模型表现为相应声音，不是需要照字面读出的英文，也不是动作旁白。\n\n"
            "可用标签及含义：\n"
            "- (laughs)：笑声；(chuckle)：轻笑。\n"
            "- (sighs)：叹气；(groans)：呻吟。\n"
            "- (coughs)：咳嗽；(clear-throat)：清嗓子；(sneezes)：打喷嚏。\n"
            "- (breath)：正常换气；(pant)：喘气；(inhale)：吸气；(exhale)：呼气。\n"
            "- (gasps)：倒吸气；(sniffs)：吸鼻子；(snorts)：鼻哼声。\n"
            "- (burps)：打嗝；(lip-smacking)：咂嘴。\n"
            "- (humming)：哼声；(hissing)：嘶嘶声；(emm)：嗯声。\n\n"
            "只能使用上述写法，保留英文小写、半角括号和标签中的连字符。不要自行翻译、改写或创造新标签。\n"
            "把标签放在声音应当出现的位置，例如：[语音](chuckle)你怎么连这个都记得。\n"
            "需要表现迟疑时可以使用 (emm)，疲惫或感慨时可以使用 (sighs)；是否添加仍应由具体语境决定，"
            "不要把某种情绪机械地绑定到某个声音。\n\n"
            "这些标签只描述局部声音，不决定整条语音的情绪。普通的“嗯”“哈哈”等口语文字仍可自然使用，不必全部替换成标签。\n"
            "不必每条语音都添加，也不要连续堆叠标签或为展示效果而遍历标签。咳嗽、喘气、打嗝等声音只在语境确实需要时使用，"
            "避免无缘由地改变角色当时的状态。"
        )
    if family == "elevenlabs" and settings["elevenlabs"]["audio_tags_enabled"]:
        sections.append(
            "【声音与语气标签】\n"
            "仅在语音正文中，按角色性格和语境少量使用以下英文方括号标签："
            "[laughs] 笑声、[chuckles] 轻笑、[sighs] 叹气、[exhales] 呼气、"
            "[clears throat] 清嗓、[whispers] 耳语、[shouts] 大声说话。\n"
            "例如：[语音][chuckles]这都被你发现了。"
            "标签放在声音发生的位置，不要朗读标签或添加动作旁白；不要创造其他标签或堆叠标签。"
            "这些标签只控制局部声音和说话方式，不替代整条语音的情绪标记。"
        )
    if family in ("minimax", "mimo", "elevenlabs") and settings["emotion_enabled"]:
        sections.append(
            "【单条语音的情绪】\n"
            "在情绪特别强烈、确有必要明确表达基调时，可以把语音开头的标记写成 [语音-情绪值]，"
            "例如：[语音-happy]真的呀，太好了！\n\n"
            "可用情绪值：\n"
            "- happy：高兴、愉悦。\n"
            "- sad：悲伤、难过。\n"
            "- angry：愤怒、生气。\n"
            "- fearful：害怕、不安。\n"
            "- disgusted：厌恶、嫌弃。\n"
            "- surprised：惊讶、意外。\n"
            "- neutral：明确指定平静、中性的表达。\n\n"
            "情绪值使用上述英文小写，写在语音起始标记内，不要写成独立的 [happy]，"
            "也不要把“开心地说”等说明插入朗读正文。\n"
            "一个情绪标记作用于它开启的整条语音，不是只修饰紧随其后的一个词。若确实需要切换情绪，应另起一条语音，"
            "不要在同一条语音中堆叠情绪指令。\n\n"
            "不确定或不需要突出情绪时，直接使用 [语音]，让语音模型自然表达。省略情绪不等于指定 neutral，"
            "不需要为了补全格式而给每条语音加上情绪值。\n"
            "每条语音独立决定是否指定情绪，不继承上一条的情绪。"
            "例如：[语音-happy]终于等到你了！[语音]今天路上还顺利吗？\n"
            "这里第二条语音不指定情绪。\n\n"
            "情绪控制可能明显改变声音风格，应当适量使用。轻微的情感变化可以通过措辞和语境表达，不必都添加情绪标记。"
        )
    if family == "minimax" and settings["minimax"]["pause_enabled"]:
        sections.append(
            "【停顿控制】\n"
            "你可以在语音正文中需要明确停顿的位置使用 <#x#>，其中 x 是停顿时长，单位为秒。\n"
            "例如：[语音]等一下<#0.5#>我想想。这里的 <#0.5#> 表示在“等一下”和“我想想”之间请求停顿 0.5 秒。\n\n"
            "时长范围为 0.01–99.99 秒，最多保留两位小数。使用半角字符和小数点，数字中不加空格、单位或其他说明，"
            "例如 <#0.3#>、<#1#>。\n"
            "标记必须放在两段可朗读文本之间，不能放在语音开头或结尾，也不能连续放置多个停顿标记。\n\n"
            "停顿可以用于表现思考、迟疑、话题转折，或给一句有分量的话留出短暂间隔。"
            "时长应符合角色当时的说话状态和对话节奏；日常交流以短停顿为主，不要因为允许较大数值就制造长时间静音。\n"
            "普通句读优先使用逗号、句号等标点，让语音模型自然处理。只有确实需要明确控制间隔时才添加停顿标记，"
            "不必每句话都添加，也不要同时堆叠多种分隔符来强化同一次停顿。"
        )
    return "\n\n".join(sections)
