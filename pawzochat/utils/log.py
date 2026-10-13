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

"""Logging configuration with console and rotating file handlers."""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler

from pawzochat.paths import LOGS_DIR

LOG_FILE = LOGS_DIR / "pawzochat.log"
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def resolve_log_level(name: str | None, default: int = logging.INFO) -> int:
    """Map a level name (e.g. ``debug``, ``INFO``) to ``logging`` constants."""
    if not name:
        return default
    lvl = getattr(logging, str(name).strip().upper(), None)
    return lvl if isinstance(lvl, int) else default


class _TLSHandshakeFilter(logging.Filter):
    """Suppress noisy TLS handshake errors caused by self-signed certificate rejections."""

    _NOISE = "peer dropped the TLS connection suddenly"

    def filter(self, record: logging.LogRecord) -> bool:
        return self._NOISE not in record.getMessage()


class _ColorConsoleFormatter(logging.Formatter):
    """Formatter that colors WARNING yellow and ERROR/CRITICAL red on terminals."""

    _YELLOW = "\033[33m"
    _RED = "\033[31m"
    _RESET = "\033[0m"

    _COLORS = {
        logging.WARNING: _YELLOW,
        logging.ERROR: _RED,
        logging.CRITICAL: _RED,
    }

    def format(self, record: logging.LogRecord) -> str:
        text = super().format(record)
        color = self._COLORS.get(record.levelno)
        if color:
            return f"{color}{text}{self._RESET}"
        return text


def _enable_windows_ansi() -> None:
    """Enable ANSI escape code processing on Windows 10+."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_ulong()
        kernel32.GetConsoleMode(handle, ctypes.byref(mode))
        kernel32.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        pass


def setup_logging(level: int = logging.INFO):
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    _enable_windows_ansi()

    root = logging.getLogger()
    root.setLevel(level)

    # Keep routine HTTP requests and connection activity out of application logs.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    if root.handlers:
        return

    tls_filter = _TLSHandshakeFilter()

    console = logging.StreamHandler()
    console.setLevel(level)
    console.setFormatter(_ColorConsoleFormatter(LOG_FORMAT, datefmt=DATE_FORMAT))
    console.addFilter(tls_filter)
    root.addHandler(console)

    file_handler = RotatingFileHandler(
        LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT))
    file_handler.addFilter(tls_filter)
    root.addHandler(file_handler)

    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("requests").setLevel(logging.WARNING)
    logging.getLogger("charset_normalizer").setLevel(logging.WARNING)
