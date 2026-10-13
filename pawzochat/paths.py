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

"""Portable path resolution for the application and its sibling data directory."""

from __future__ import annotations

import os
import sys
from pathlib import Path


_V1 = 29686236149217388


def _detect_app_home() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def _user_data_dir(app_name: str = "PawzoChat") -> Path:
    """Cross-platform per-user application data directory.

    Follows each OS convention so data (such as the anonymous telemetry id)
    survives app reinstall/upgrade but does not roam with the portable
    ``data/`` directory if the user copies the app folder to a new machine.
    """
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / app_name


APP_HOME = _detect_app_home()
DATA_DIR = (APP_HOME / "data").resolve()
USER_DATA_DIR = _user_data_dir()

AUTH_DIR = DATA_DIR / "auth"
BOOKS_DIR = DATA_DIR / "books"
CERTS_DIR = DATA_DIR / "certs"
CHATS_DIR = DATA_DIR / "chats"
GROUPS_DIR = DATA_DIR / "groups"
GROUP_MEMORIES_DIR = DATA_DIR / "group_memories"
CONFIG_DIR = DATA_DIR / "config"
EMOJI_DIR = DATA_DIR / "emoji"
INVITATION_DIR = DATA_DIR / "invitation"
LOGS_DIR = DATA_DIR / "logs"
MCP_SERVERS_DIR = DATA_DIR / "mcp_servers"
MOMENTS_DIR = DATA_DIR / "moments"
MOMENTS_IMAGES_DIR = MOMENTS_DIR / "images"
PLUGINS_DIR = DATA_DIR / "plugins"
PLUGIN_STAGING_DIR = DATA_DIR / "plugin_staging"
PLUGIN_BACKUP_DIR = DATA_DIR / "plugin_backup"
PROFILE_DIR = DATA_DIR / "profile"
PROMPTS_DIR = DATA_DIR / "prompts"
THEME_DIR = DATA_DIR / "theme"

MOMENTS_STORE_PATH = MOMENTS_DIR / "moments.json"

CONFIG_PATH = CONFIG_DIR / "config.yaml"
CREDENTIALS_PATH = AUTH_DIR / "accounts.json"
INVITATION_CODE_PATH = INVITATION_DIR / "invitation_code.txt"
TELEMETRY_ID_FILE = USER_DATA_DIR / "telemetry_id.txt"
TELEMETRY_ID_FALLBACK = DATA_DIR / "telemetry_id.txt"
