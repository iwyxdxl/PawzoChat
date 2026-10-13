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

"""Bidirectional mapping between PawzoChat models and SillyTavern cards.

Two domains live here because they travel together on the wire:

* **Persona ↔ SillyTavern v2/v3 card**
  Each card has a three-section prompt (description/personality/scenario) that
  we fold into PawzoChat's single ``character_prompt``. PawzoChat-only
  settings (llm/emoji/memory/proactive/tool_policy/image_generation) ride inside
  ``data.extensions.pawzochat`` so they round-trip without polluting the
  standard card shape.

* **PawzoChat worldbook ↔ SillyTavern character_book / lorebook**
  The two schemas don't line up 1-to-1 (PawzoChat has one keyword set per
  book; SillyTavern has per-entry keys + selective/constant/position/order).
  We flatten on import and reconstruct on export. Unmapped fields are kept in
  ``extras.sillytavern`` for lossless round-trips when a book came from
  SillyTavern originally.
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from pawzochat import __version__ as _PKG_VERSION  # type: ignore[attr-defined]
from pawzochat.transport.models import (
    PROACTIVE_DEFAULTS,
    Persona,
    normalize_image_generation,
    normalize_voice_generation,
)
from pawzochat.image.reference import CUSTOM_REFERENCE_FILENAME, normalize_reference_image_png

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class PersonaImportResult:
    """Parsed persona + side effects to apply after validation passes."""

    name: str
    character_prompt: str
    output_examples: str
    system_instructions: str
    llm_provider: str = ""
    llm_model: str = ""
    temperature: float = 1.0
    max_tokens: int = 2000
    emoji_enabled: bool = False
    emoji_send_probability: int = 25
    emoji_group: str = ""
    memory: dict = field(default_factory=dict)
    proactive: dict = field(default_factory=dict)
    tool_policy: dict = field(default_factory=dict)
    image_generation: dict = field(default_factory=dict)
    voice_generation: dict = field(default_factory=dict)
    reference_image_png: bytes | None = None
    warnings: list[str] = field(default_factory=list)
    embedded_book: dict | None = None
    # Preserve intentionally blank prompts on PawzoChat exports.
    has_system_instructions: bool = False


# ---------------------------------------------------------------------------
# Worldbook <-> character_book
# ---------------------------------------------------------------------------

def _entry_keys(entry: dict) -> list[str]:
    """Normalise an ST entry's keys (accepts ``key`` or ``keys``; str or list)."""
    raw = entry.get("key") or entry.get("keys") or []
    if isinstance(raw, str):
        raw = [raw]
    return [str(k).strip() for k in raw if str(k).strip()]


def _entry_is_disabled(entry: dict) -> bool:
    """Read SillyTavern's per-entry "off" state.

    ST writes either ``disable: true`` (most common, including SillyTavern's
    own export) or ``enabled: false`` (some forks / custom tools). Either
    counts as off here.
    """
    if entry.get("disable"):
        return True
    if entry.get("enabled") is False:
        return True
    return False


def _walk_sillytavern_entries(entries_obj: Any) -> list[tuple[str, dict]]:
    """Return ``[(title, entry_dict), ...]`` in display order.

    Single source of truth for turning a SillyTavern ``entries`` container into
    an ordered list with deterministic titles. Callers use the same titles for
    ``content`` sections AND for indexing ``entry_extras``, so a section with a
    non-standard name (e.g. fallback to ``key[0]`` or ``entry_N``) still
    matches its passthrough metadata on export.

    Disabled entries are kept (their state surfaces via ``section_meta``) so
    users can re-enable them in the UI without losing the body text.
    """
    if isinstance(entries_obj, dict):
        items = list(entries_obj.values())
    elif isinstance(entries_obj, list):
        items = entries_obj
    else:
        return []

    def sort_key(e: dict):
        idx = e.get("displayIndex")
        if idx is None:
            idx = e.get("insertion_order")
        if idx is None:
            idx = e.get("uid", 0)
        try:
            return int(idx)
        except (TypeError, ValueError):
            return 0

    items = sorted(
        [e for e in items if isinstance(e, dict)],
        key=sort_key,
    )

    seen: set[str] = set()
    pairs: list[tuple[str, dict]] = []
    for i, e in enumerate(items):
        title = (e.get("comment") or e.get("name") or "").strip()
        if not title:
            keys = _entry_keys(e)
            if keys:
                title = keys[0]
        if not title:
            title = f"entry_{i + 1}"
        base = title
        j = 2
        while title in seen:
            title = f"{base}_{j}"
            j += 1
        seen.add(title)
        pairs.append((title, e))
    return pairs


def _parse_sillytavern_entries(
    entries_obj: Any,
) -> tuple[dict[str, str], list[str], dict[str, dict]]:
    """Flatten SillyTavern ``entries`` into ``(content, keywords, section_meta)``.

    ``section_meta`` mirrors each entry's enabled state (derived from ST's
    ``disable`` / ``enabled`` field) so the per-section toggle survives the
    round-trip. Keywords are aggregated only from effectively-enabled entries
    — disabled ones say nothing about what the book is currently scanning for.
    """
    sections: dict[str, str] = {}
    section_meta: dict[str, dict] = {}
    all_keys: list[str] = []
    seen_keys: set[str] = set()

    for title, e in _walk_sillytavern_entries(entries_obj):
        sections[title] = str(e.get("content") or e.get("text") or "")
        enabled = not _entry_is_disabled(e)
        section_meta[title] = {"enabled": enabled}
        if not enabled:
            continue
        for k in _entry_keys(e):
            lowered = k.lower()
            if lowered not in seen_keys:
                seen_keys.add(lowered)
                all_keys.append(k)

    return sections, all_keys, section_meta


def character_book_to_worldbook(cb: dict, fallback_name: str = "") -> dict:
    """Build a PawzoChat worldbook dict from a SillyTavern character_book/lorebook.

    Returns a dict shaped for ``WorldbookService.save_book`` plus a hidden
    ``extras`` field capturing fields we can't represent natively so an export
    back to SillyTavern preserves them.

    Per-entry ``disable`` (or ``enabled: false``) state is preserved as
    ``section_meta[section] = {"enabled": ...}`` rather than dropped, so users
    can flip the switch back on without losing the body text.
    """
    if not isinstance(cb, dict):
        return {
            "name": fallback_name,
            "scope": {"range": "selected", "keyword_filter": False},
            "keywords": [],
            "content": {},
            "section_meta": {},
        }

    entries = cb.get("entries")
    sections, keywords, section_meta = _parse_sillytavern_entries(entries)

    # Heuristic: if *every* effectively-enabled entry is constant=True,
    # keyword filtering would be pointless; leave it off so the book applies
    # unconditionally. Disabled entries are excluded from the heuristic — their
    # constant flag is not authoritative since they don't inject anyway.
    all_constant = False
    entry_list: list[dict] = []
    if isinstance(entries, dict):
        entry_list = [e for e in entries.values()
                      if isinstance(e, dict) and not _entry_is_disabled(e)]
    elif isinstance(entries, list):
        entry_list = [e for e in entries
                      if isinstance(e, dict) and not _entry_is_disabled(e)]
    if entry_list:
        all_constant = all(bool(e.get("constant")) for e in entry_list)

    name = str(cb.get("name") or fallback_name or "").strip()

    return {
        "name": name,
        "scope": {
            "range": "selected",
            "keyword_filter": bool(keywords) and not all_constant,
        },
        "keywords": keywords,
        "content": sections,
        "section_meta": section_meta,
        "extras": {"sillytavern": _snapshot_sillytavern_book(cb)},
    }


def _snapshot_sillytavern_book(cb: dict) -> dict:
    """Capture ST-only fields so a re-export can put them back.

    Uses the shared ``_walk_sillytavern_entries`` helper so the keys in the
    returned ``entry_extras`` dict match the section names that
    ``_parse_sillytavern_entries`` produced for ``content``. Otherwise entries
    that fall back to ``key[0]`` / ``entry_N`` for their title would be missing
    from the snapshot and lose their passthrough metadata on re-export.

    Passthrough fields (``_ST_ENTRY_PASSTHROUGH_FIELDS``) are fields PawzoChat
    has no native expression for — they round-trip untouched, including when
    multiple books are later merged into one exported ``character_book``.
    ``key`` / ``keys`` are snapshotted separately because PawzoChat flattens
    ST per-entry keys into a book-level keyword list; export restores them in
    a controlled place without letting stale extras overwrite local fields.
    """
    keep_top = ("description", "scan_depth", "token_budget", "recursive_scanning",
                "extensions")
    snap: dict[str, Any] = {k: cb[k] for k in keep_top if k in cb}

    entry_map: dict[str, dict] = {}
    for title, e in _walk_sillytavern_entries(cb.get("entries")):
        entry_snap = {
            k: v for k, v in e.items() if k in _ST_ENTRY_PASSTHROUGH_FIELDS
        }
        keys = _entry_keys(e)
        if keys:
            entry_snap["key"] = keys
        entry_map[title] = entry_snap
    snap["entry_extras"] = entry_map
    return snap


# SillyTavern entry fields that PawzoChat has no UI to edit and therefore
# should round-trip untouched. Fields owned by PawzoChat's data model
# (constant/content/comment/uid/disable) are deliberately excluded — they're
# re-derived from current state on export. Entry keys are restored explicitly
# from extras instead of through this passthrough allowlist.
_ST_ENTRY_PASSTHROUGH_FIELDS = frozenset({
    "selective",           # main-vs-secondary key AND/OR semantics
    "order",               # per-entry injection priority
    "position",            # 0 = before_char, 1 = after_char
    "depth",
    "probability",
    "useProbability",
    "addMemo",
    "excludeRecursion",
    "role",
    "cooldown",
    "delay",
    "use_regex",
    "secondary_keys",
    "keysecondary",
    "scan_depth",
    "match_persona_description",
    "match_character_description",
    "match_character_personality",
    "match_character_depth_prompt",
    "match_scenario",
    "match_creator_notes",
    "extensions",
})


def worldbook_to_character_book(books: list[dict]) -> dict:
    """Merge one or more PawzoChat books into a single character_book dict.

    Per-section ``enabled`` state is exported via SillyTavern's ``disable``
    field, so a round-trip preserves user toggles. Disabled sections still
    travel with the export (with ``disable=True``); they're only skipped
    locally at prompt-injection time.
    """
    merged: dict[str, dict] = {}
    uid = 0
    for book in books:
        book_name = str(book.get("name", ""))
        extras = (book.get("extras") or {}).get("sillytavern") or {}
        entry_extras = extras.get("entry_extras") or {}
        book_kw = [str(k) for k in (book.get("keywords") or [])]
        content = book.get("content") or {}
        section_meta = book.get("section_meta") or {}
        # keyword_filter is the single authority: when False the entry always
        # injects (constant=True) regardless of whether the book happens to
        # carry leftover keywords from a previous "keyword mode" session.
        keyword_filter = bool(book.get("scope", {}).get("keyword_filter", False))

        for section, text in content.items():
            if not str(text).strip():
                continue

            meta = section_meta.get(section)
            enabled = True
            if isinstance(meta, dict) and meta.get("enabled") is False:
                enabled = False

            restored = entry_extras.get(section)
            restored_keys = _entry_keys(restored) if isinstance(restored, dict) else []

            comment = f"【{book_name}】{section}" if len(books) > 1 else section
            base: dict[str, Any] = {
                "uid": uid,
                "key": restored_keys or (list(book_kw) if keyword_filter else []),
                "keysecondary": [],
                "comment": comment,
                "content": str(text),
                "constant": not keyword_filter,
                "selective": True,
                "order": 100 + uid,
                "position": 0,
                "disable": not enabled,
                "addMemo": True,
                "excludeRecursion": False,
                "probability": 100,
                "useProbability": True,
                "depth": 4,
            }
            if isinstance(restored, dict):
                # Defensive: persisted extras may predate the allowlist; keep
                # only ST passthrough fields. Entry keys are handled above.
                for k, v in restored.items():
                    if k in _ST_ENTRY_PASSTHROUGH_FIELDS:
                        base[k] = v
            merged[str(uid)] = base
            uid += 1

    result: dict[str, Any] = {
        "name": books[0].get("name", "") if len(books) == 1 else "PawzoChat 合并世界书",
        "entries": merged,
        "extensions": {},
    }
    # When there's one book and it was originally from SillyTavern, restore
    # the book-level extras.
    if len(books) == 1:
        extras = (books[0].get("extras") or {}).get("sillytavern") or {}
        for field_name in ("description", "scan_depth", "token_budget",
                           "recursive_scanning"):
            if field_name in extras:
                result[field_name] = extras[field_name]
        if isinstance(extras.get("extensions"), dict):
            result["extensions"] = extras["extensions"]
    return result


# ---------------------------------------------------------------------------
# Persona <-> SillyTavern character card
# ---------------------------------------------------------------------------

_PAWZO_EXT_KEY = "pawzochat"


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _join_sections(*parts: tuple[str, str]) -> str:
    """Join ``(title, text)`` sections with blank-line separators, skipping empties."""
    out: list[str] = []
    for title, text in parts:
        text = (text or "").strip()
        if not text:
            continue
        if title:
            out.append(f"[{title}]\n{text}")
        else:
            out.append(text)
    return "\n\n".join(out)


def card_to_persona(card: dict) -> PersonaImportResult:
    """Parse a SillyTavern v2/v3 card dict into PawzoChat-ready fields.

    Accepts both the wrapped form (``{spec, data: {...}}``) and a bare
    v1-style body (``{name, description, ...}``) — the latter is treated as
    the ``data`` payload directly.
    """
    if not isinstance(card, dict):
        raise ValueError("角色卡必须是对象")

    data = card.get("data") if isinstance(card.get("data"), dict) else card
    if not isinstance(data, dict):
        raise ValueError("角色卡缺少 data 字段")

    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError("角色卡缺少角色名")

    description = str(data.get("description") or "")
    personality = str(data.get("personality") or "")
    scenario = str(data.get("scenario") or "")
    character_prompt = _join_sections(
        ("", description),
        ("性格", personality),
        ("背景", scenario),
    ) if personality.strip() or scenario.strip() else description

    mes_example = str(data.get("mes_example") or "")
    system_instr = str(
        data.get("system_prompt")
        or data.get("post_history_instructions")
        or ""
    )

    warnings: list[str] = []
    first_mes = str(data.get("first_mes") or "").strip()
    alt = data.get("alternate_greetings") or []
    if first_mes:
        warnings.append("已忽略角色卡的 first_mes（开场白）字段")
    if isinstance(alt, list) and any(str(x).strip() for x in alt):
        warnings.append(f"已忽略 {len([x for x in alt if str(x).strip()])} 条 alternate_greetings（备选问候语）")

    extensions = data.get("extensions") or {}
    pawzo_ext = extensions.get(_PAWZO_EXT_KEY) if isinstance(extensions, dict) else None
    pawzo_ext = pawzo_ext if isinstance(pawzo_ext, dict) else {}

    ig_defaults = normalize_image_generation({})
    raw_image_generation = pawzo_ext.get("image_generation")
    image_generation = normalize_image_generation(raw_image_generation)
    # For SillyTavern-origin cards (no pawzochat extension), pull positive /
    # negative from extensions.sd_character_prompt. Only backfill when our own
    # field is empty / still at its default — never clobber a user-edited value.
    st_pos, st_neg = _extract_st_sd_prompts(extensions)
    pulled_in: list[str] = []
    if st_pos and not image_generation.get("style_prefix"):
        image_generation["style_prefix"] = st_pos
        pulled_in.append("人物形象提示词")
    if st_neg and image_generation.get("negative_prompt") == ig_defaults["negative_prompt"]:
        image_generation["negative_prompt"] = st_neg
        pulled_in.append("负面提示词")
    reference_image_png = _extract_custom_reference_png(raw_image_generation, warnings)
    if reference_image_png is not None:
        if "ref_mode" not in raw_image_generation:
            image_generation["ref_mode"] = "custom"
        image_generation["custom_ref_filename"] = CUSTOM_REFERENCE_FILENAME
    if pulled_in:
        warnings.append(
            "已从角色卡 extensions.sd_character_prompt 导入" + "/".join(pulled_in),
        )

    result = PersonaImportResult(
        name=name,
        character_prompt=character_prompt,
        output_examples=mes_example,
        system_instructions=system_instr,
        llm_provider=str(pawzo_ext.get("llm_provider", "")),
        llm_model=str(pawzo_ext.get("llm_model", "")),
        temperature=float(pawzo_ext.get("temperature", 1.0)),
        max_tokens=int(pawzo_ext.get("max_tokens", 2000)),
        emoji_enabled=bool(pawzo_ext.get("emoji_enabled", False)),
        emoji_send_probability=int(pawzo_ext.get("emoji_send_probability", 25)),
        emoji_group=str(pawzo_ext.get("emoji_group", "")),
        memory=_normalize_memory(pawzo_ext.get("memory")),
        proactive=_normalize_proactive(pawzo_ext.get("proactive")),
        tool_policy=_normalize_tool_policy(pawzo_ext.get("tool_policy")),
        image_generation=image_generation,
        voice_generation=normalize_voice_generation(pawzo_ext.get("voice_generation")),
        reference_image_png=reference_image_png,
        warnings=warnings,
        # External ST cards use empty strings for unset prompt overrides.
        # Only PawzoChat exports can deliberately opt out of our default.
        has_system_instructions=bool(system_instr) or (
            bool(pawzo_ext)
            and ("system_prompt" in data or "post_history_instructions" in data)
        ),
    )

    cb = data.get("character_book")
    if isinstance(cb, dict) and cb.get("entries"):
        result.embedded_book = cb
    return result


def _normalize_memory(raw: Any) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    trigger_mode = raw.get("trigger_mode", "remind")
    return {
        "enabled": bool(raw.get("enabled", True)),
        "max_memories": int(raw.get("max_memories", 50)),
        "include_in_prompt": bool(raw.get("include_in_prompt", True)),
        "trigger_rounds": int(raw.get("trigger_rounds", 10)),
        "trigger_mode": trigger_mode
        if trigger_mode in ("remind", "summarize", "summarize_only") else "remind",
    }


def _normalize_proactive(raw: Any) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    qh = raw.get("quiet_hours") if isinstance(raw.get("quiet_hours"), dict) else {}
    d = PROACTIVE_DEFAULTS
    qd = d["quiet_hours"]
    return {
        "enabled": bool(raw.get("enabled", d["enabled"])),
        "min_idle_hours": float(raw.get("min_idle_hours", d["min_idle_hours"])),
        "max_idle_hours": float(raw.get("max_idle_hours", d["max_idle_hours"])),
        "max_consecutive": int(raw.get("max_consecutive", d["max_consecutive"])),
        "prompt": str(raw.get("prompt", d["prompt"])),
        "quiet_hours": {
            "enabled": bool(qh.get("enabled", qd["enabled"])),
            "start": str(qh.get("start", qd["start"])),
            "end": str(qh.get("end", qd["end"])),
        },
    }


def _normalize_tool_policy(raw: Any) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "mode": str(raw.get("mode", "all")),
        "list": list(raw.get("list", [])),
        "max_iterations": int(raw.get("max_iterations", 10)),
        "timeout_seconds": int(raw.get("timeout_seconds", 30)),
    }


def _extract_custom_reference_png(image_generation: Any, warnings: list[str]) -> bytes | None:
    if not isinstance(image_generation, dict):
        return None
    payload = image_generation.get("custom_ref_image_png_b64")
    if not payload:
        return None
    try:
        raw = base64.b64decode(payload)
    except Exception as exc:  # noqa: BLE001 - import-time validation
        warnings.append(f"自定义参考图解析失败: {exc}")
        return None
    try:
        return normalize_reference_image_png(raw)
    except Exception as exc:  # noqa: BLE001 - import-time validation
        warnings.append(f"自定义参考图无效，已忽略: {exc}")
        return None


def _extract_st_sd_prompts(extensions: Any) -> tuple[str, str]:
    """Read SillyTavern stable-diffusion extension's per-character prompts.

    SillyTavern's SD extension writes ``{positive, negative}`` to
    ``data.extensions.sd_character_prompt`` when the user opts to share with
    the character. Older variants may store a bare string (treated as
    positive, with no negative). Returns ``(positive, negative)`` with empty
    strings filling in for missing fields.
    """
    if not isinstance(extensions, dict):
        return "", ""
    raw = extensions.get("sd_character_prompt")
    if isinstance(raw, str):
        return raw.strip(), ""
    if isinstance(raw, dict):
        positive = raw.get("positive")
        negative = raw.get("negative")
        return (
            positive.strip() if isinstance(positive, str) else "",
            negative.strip() if isinstance(negative, str) else "",
        )
    return "", ""


def persona_to_card(
    persona: Persona,
    *,
    bound_books: list[dict] | None = None,
    reference_image_png: bytes | None = None,
) -> dict:
    """Serialise a Persona (and optionally its bound books) to a v3 card dict.

    Only SillyTavern v3 is produced on export; v2 clients that receive a v3
    payload treat the extra fields as unknown and ignore them, so the narrow
    surface is worth the simpler code path. Import still accepts both v2 and
    v3 cards in ``card_to_persona``.
    """
    image_generation = dict(persona.image_generation or {})
    if reference_image_png is not None:
        image_generation["custom_ref_filename"] = CUSTOM_REFERENCE_FILENAME
        image_generation["custom_ref_image_png_b64"] = base64.b64encode(reference_image_png).decode("ascii")

    pawzo_ext = {
        "version": 1,
        "exporter_version": _PKG_VERSION,
        "llm_provider": persona.llm_provider,
        "llm_model": persona.llm_model,
        "temperature": persona.temperature,
        "max_tokens": persona.max_tokens,
        "emoji_enabled": persona.emoji_enabled,
        "emoji_send_probability": persona.emoji_send_probability,
        "emoji_group": persona.emoji_group,
        # Group IDs describe local memory archives, not portable role settings.
        "memory": {key: value for key, value in persona.memory.items() if key != "group_reads"},
        "proactive": persona.proactive,
        "tool_policy": persona.tool_policy,
        "image_generation": image_generation,
        "voice_generation": normalize_voice_generation(persona.voice_generation),
    }

    data: dict[str, Any] = {
        "name": persona.name,
        "description": persona.character_prompt,
        "personality": "",
        "scenario": "",
        "first_mes": "",
        "mes_example": persona.output_examples,
        "creator_notes": f"Exported from PawzoChat {_PKG_VERSION} at {_iso_now()}",
        "system_prompt": persona.system_instructions,
        "post_history_instructions": "",
        "alternate_greetings": [],
        "tags": [],
        "creator": "PawzoChat",
        "character_version": "1",
        "creation_date": _iso_now(),
        "modification_date": _iso_now(),
        "nickname": "",
        "source": [],
        "group_only_greetings": [],
        "extensions": {_PAWZO_EXT_KEY: pawzo_ext},
    }

    # Mirror style_prefix / negative_prompt onto SillyTavern's standard
    # sd_character_prompt field so exported cards round-trip cleanly: when
    # imported back into ST its SD extension picks them up directly.
    ig = persona.image_generation or {}
    style_prefix = ig.get("style_prefix", "")
    negative_prompt = ig.get("negative_prompt", "") if ig.get("negative_enabled", True) else ""
    if style_prefix or negative_prompt:
        data["extensions"]["sd_character_prompt"] = {
            "positive": style_prefix,
            "negative": negative_prompt,
        }

    if bound_books:
        data["character_book"] = worldbook_to_character_book(bound_books)

    return {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": data,
    }
