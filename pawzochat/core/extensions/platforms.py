# PawzoChat - Human-like, versatile, extensible AI companion engine
# Copyright (C) 2026 iwyxdxl
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Platform declarations shared by release indexes and installed plugins."""

from __future__ import annotations

import sys
from collections.abc import Sequence

_PLATFORMS = frozenset({"windows", "macos", "linux"})


def normalize_platforms(value: object) -> tuple[str, ...]:
    """Validate an explicitly supplied list; omission is handled by callers."""
    if (not isinstance(value, list) or not value
            or any(not isinstance(item, str) or item not in _PLATFORMS for item in value)
            or len(set(value)) != len(value)):
        raise ValueError("platforms 必须是不重复的非空数组，可选 windows、macos、linux")
    return tuple(value)


def current_platform() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("linux"):
        return "linux"
    return sys.platform


def supports_platform(platforms: Sequence[str]) -> bool:
    """An omitted declaration is unrestricted, including on unknown systems."""
    return not platforms or current_platform() in platforms
