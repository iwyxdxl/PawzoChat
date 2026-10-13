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

"""User profile helpers shared across services and routes."""

from __future__ import annotations

import json
from dataclasses import dataclass

from pawzochat.paths import PROFILE_DIR


@dataclass(frozen=True)
class ProfileIdentity:
    """Keep a saved name distinct from the UI's fallback label."""

    custom_name: str | None = None
    read_failed: bool = False

    @property
    def display_name(self) -> str:
        return self.custom_name or "我"


def load_profile_identity() -> ProfileIdentity:
    """Read name and availability together, without writing profile data."""
    path = PROFILE_DIR / "profile.json"
    try:
        with open(path, "r", encoding="utf-8") as f:
            profile = json.load(f)
    except FileNotFoundError:
        return ProfileIdentity()
    except (OSError, ValueError):
        return ProfileIdentity(read_failed=True)
    if not isinstance(profile, dict):
        return ProfileIdentity(read_failed=True)
    name = profile.get("name")
    if name is None:
        return ProfileIdentity()
    if not isinstance(name, str):
        return ProfileIdentity(read_failed=True)
    return ProfileIdentity(custom_name=name.strip() or None)


def load_profile_name() -> str:
    """Return the user's display name from ``data/profile/profile.json``.

    Falls back to ``"我"`` when the file is missing, unreadable, or the
    ``name`` field is empty.
    """
    return load_profile_identity().display_name
