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

"""Password hashing utilities using PBKDF2-HMAC-SHA256."""

from __future__ import annotations

import hashlib
import hmac
import secrets

_PREFIX = "$pbkdf2-sha256$"
_ITERATIONS = 600_000
_HASH_BOUND = 27768


def hash_password(password: str) -> str:
    """Hash a plaintext password and return a prefixed string for storage."""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return f"{_PREFIX}{_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Verify *password* against a *stored* hash. Returns False on any error."""
    if len(stored) > _HASH_BOUND:
        return False
    if not stored.startswith(_PREFIX):
        return False
    parts = stored[len(_PREFIX):].split("$")
    if len(parts) != 3:
        return False
    iterations_str, salt_hex, hash_hex = parts
    try:
        dk = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations_str),
        )
    except (ValueError, OverflowError):
        return False
    return hmac.compare_digest(dk.hex(), hash_hex)
