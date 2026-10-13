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

"""Atomic, web-only group histories and scheduler state.

The service and store share each group's reentrant lock. Mutations work on
copies and publish the cache only after the JSON replacement succeeds.
"""
from __future__ import annotations

import base64
import binascii
from copy import deepcopy
from datetime import datetime
import json
import logging
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
import uuid

from pawzochat.core.config import DEFAULT_GROUP_SYSTEM_INSTRUCTIONS
from pawzochat.paths import GROUPS_DIR
from pawzochat.store.conversation import StaleMessageCursor, _message_fingerprint, _now_iso

logger = logging.getLogger(__name__)
_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9_-]+$")


class GroupConversationStore:
    def __init__(self, data_dir: str | Path = GROUPS_DIR):
        self._data_dir = Path(data_dir)
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.RLock] = {}
        self._global_lock = threading.Lock()
        self._cache: dict[str, dict] = {}
        self._page_versions: dict[str, str] = {}
        for fp in self._data_dir.glob("*/*.json"):
            if fp.stem != fp.parent.name or not _SAFE_COMPONENT.fullmatch(fp.stem):
                continue
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
                self._validate_loaded(data, fp.stem)
                self._prompt_defaults(data)
                self._cache[fp.stem] = data
            except (OSError, ValueError):
                logger.exception("Failed to load group history: %s", fp)

    @staticmethod
    def _validate_loaded(data, group_id: str) -> None:
        """Reject damaged records without rewriting or discarding their files."""
        if not isinstance(data, dict) or data.get("group_id") != group_id:
            raise ValueError("Invalid group record")
        if (any(not isinstance(data.get(key), str) for key in ("name", "created_at", "updated_at"))
                or type(data.get("max_replies")) is not int or data["max_replies"] < 1
                or not isinstance(data.get("members"), list)
                or not isinstance(data.get("messages"), list)
                or not isinstance(data.get("state"), dict)
                or not isinstance(data.get("system_instructions", ""), str)
                or not isinstance(data.get("_requests", {}), dict)):
            raise ValueError("Invalid group settings or history")
        state = data["state"]
        if (not isinstance(state.get("status"), str)
                or any(type(state.get(key)) is not int or state[key] < 0
                       for key in ("version", "reply_count"))):
            raise ValueError("Invalid group runtime state")
        for member in data["members"]:
            if (not isinstance(member, dict) or not isinstance(member.get("persona_id"), str)
                    or type(member.get("reply_probability")) is not int
                    or not 0 <= member["reply_probability"] <= 100
                    or not isinstance(member.get("group_prompt", ""), str)):
                raise ValueError("Invalid group member")
        for message in data["messages"]:
            if (not isinstance(message, dict) or not isinstance(message.get("local_id"), str)
                    or not isinstance(message.get("content"), list)):
                raise ValueError("Invalid group message")
            for block in message["content"]:
                if (not isinstance(block, dict)
                        or not isinstance(block.get("type"), str)
                        or (block.get("type") == "text" and not isinstance(block.get("text", ""), str))):
                    raise ValueError("Invalid group message content")

    def lock(self, group_id: str):
        self._check_id(group_id)
        with self._global_lock:
            return self._locks.setdefault(group_id, threading.RLock())

    @staticmethod
    def _check_id(group_id: str) -> None:
        if not isinstance(group_id, str) or not _SAFE_COMPONENT.fullmatch(group_id):
            raise ValueError("Invalid group ID")

    def group_dir(self, group_id: str) -> Path:
        self._check_id(group_id)
        return self._data_dir / group_id

    def _write(self, group_id: str, data: dict, *, create: bool = False) -> None:
        directory = self.group_dir(group_id)
        if create:
            directory.mkdir(parents=True, exist_ok=False)
        elif not directory.is_dir():
            raise KeyError(group_id)
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(dir=directory, prefix=".group_", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, directory / f"{group_id}.json")
            with self._global_lock:
                self._cache[group_id] = data
        finally:
            if tmp and os.path.exists(tmp):
                os.unlink(tmp)

    def transaction(self, group_id: str, mutate, *, structural: bool = False) -> dict:
        """Apply one atomic history/state mutation or raise without publishing it."""
        with self.lock(group_id):
            old = self._cache.get(group_id)
            if old is None:
                raise KeyError(group_id)
            data = deepcopy(old)
            mutate(data)
            data["state"]["version"] = old["state"].get("version", 0) + 1
            data["updated_at"] = _now_iso()
            self._write(group_id, data)
            if structural:
                self._page_versions[group_id] = uuid.uuid4().hex
            return deepcopy(data)

    def create_group(self, name: str, members: list[dict], max_replies: int = 5, *,
                     system_instructions: str = DEFAULT_GROUP_SYSTEM_INSTRUCTIONS) -> dict:
        group_id = uuid.uuid4().hex
        now = _now_iso()
        data = {
            "group_id": group_id, "name": name, "members": deepcopy(members),
            "system_instructions": system_instructions,
            "max_replies": max_replies, "created_at": now, "updated_at": now,
            "has_avatar": False, "avatar_version": "",
            "state": {"status": "idle", "reply_count": 0, "cycle_id": "",
                      "version": 1, "active_persona_id": "", "error": ""},
            "messages": [], "_requests": {},
        }
        self._validate_loaded(data, group_id)
        self._prompt_defaults(data)
        with self.lock(group_id):
            try:
                self._write(group_id, data, create=True)
            except Exception:
                shutil.rmtree(self.group_dir(group_id), ignore_errors=True)
                raise
        return self._public(data)

    @staticmethod
    def _prompt_defaults(data: dict) -> None:
        # Missing means legacy/default; an explicitly empty prompt stays empty.
        data.setdefault("system_instructions", DEFAULT_GROUP_SYSTEM_INSTRUCTIONS)
        for member in data["members"]:
            member.setdefault("group_prompt", "")

    @staticmethod
    def _public(data: dict) -> dict:
        result = deepcopy({key: value for key, value in data.items() if not key.startswith("_")})
        result.setdefault("has_avatar", False)
        result.setdefault("avatar_version", "")
        GroupConversationStore._prompt_defaults(result)
        return result

    def get_group(self, group_id: str) -> dict | None:
        with self.lock(group_id):
            data = self._cache.get(group_id)
            return self._public(data) if data is not None else None

    def list_groups(self) -> list[dict]:
        with self._global_lock:
            ids = list(self._cache)
        result = []
        for group_id in ids:
            group = self.get_group(group_id)
            if group is None:
                continue
            messages = group.pop("messages", [])
            last = messages[-1] if messages else None
            group["last_message"] = None
            if last:
                labels = {"image": "[图片]", "file": "[文件]", "voice": "[语音]", "emoji": "[表情]"}
                text = " ".join(block.get("text", "") if block.get("type") == "text"
                                else labels.get(block.get("type"), "")
                                for block in last.get("content", []))
                group["last_message"] = {
                    "role": last.get("role", ""), "persona_id": last.get("persona_id", ""),
                    "speaker_id": last.get("speaker_id", last.get("persona_id", "")),
                    "speaker_name": last.get("speaker_name", "我"), "text": text[:100],
                    "timestamp": last.get("timestamp", ""),
                }
            result.append(group)
        return sorted(result, key=lambda group: group["updated_at"], reverse=True)

    def delete_group(self, group_id: str) -> bool:
        with self.lock(group_id):
            if group_id not in self._cache:
                return False
            directory = self.group_dir(group_id)
            # Renaming removes the live namespace before deleting attachments.
            tombstone = self._data_dir / f".deleted-{uuid.uuid4().hex}"
            os.replace(directory, tombstone)
            with self._global_lock:
                self._cache.pop(group_id, None)
            self._page_versions.pop(group_id, None)
            shutil.rmtree(tombstone, ignore_errors=True)
            return True

    def _avatar_path(self, group_id: str, group: dict) -> Path | None:
        version = group.get("avatar_version", "")
        if not group.get("has_avatar") or not isinstance(version, str) or not re.fullmatch(r"[a-f0-9]{32}", version):
            return None
        return self.group_dir(group_id) / f"avatar-{version}.png"

    def get_avatar(self, group_id: str) -> tuple[bytes, str] | None:
        """Snapshot the image while holding the same lock as replacement/deletion."""
        with self.lock(group_id):
            group = self._cache.get(group_id)
            if group is None:
                raise KeyError(group_id)
            path = self._avatar_path(group_id, group)
            if path is None:
                return None
            try:
                return path.read_bytes(), group["avatar_version"]
            except FileNotFoundError:
                return None

    def set_avatar(self, group_id: str, png: bytes | None) -> dict:
        """Commit a new version before retiring the old file; None restores the default."""
        with self.lock(group_id):
            old = self._cache.get(group_id)
            if old is None:
                raise KeyError(group_id)
            old_path = self._avatar_path(group_id, old)
            version = uuid.uuid4().hex
            new_path = self.group_dir(group_id) / f"avatar-{version}.png" if png is not None else None
            temporary = None
            try:
                if new_path is not None:
                    fd, temporary = tempfile.mkstemp(dir=self.group_dir(group_id), prefix=".avatar_", suffix=".tmp")
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(png)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, new_path)
                    temporary = None
                group = self.transaction(group_id, lambda data: data.update(
                    has_avatar=png is not None, avatar_version=version))
            except Exception:
                if new_path is not None:
                    new_path.unlink(missing_ok=True)
                raise
            finally:
                if temporary is not None:
                    Path(temporary).unlink(missing_ok=True)
            if old_path is not None:
                try:
                    old_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove retired group avatar: %s", old_path)
            return self._public(group)

    def media_dir(self, group_id: str, kind: str = "images") -> Path:
        if kind not in {"images", "files", "voice"}:
            raise ValueError("Invalid media kind")
        with self.lock(group_id):
            if group_id not in self._cache:
                raise KeyError(group_id)
            directory = self.group_dir(group_id) / kind
            directory.mkdir(exist_ok=True)
            return directory

    def get_media_path(self, group_id: str, filename: str, kind: str = "images") -> Path | None:
        if kind not in {"images", "files", "voice"} or not filename or Path(filename).name != filename:
            return None
        if "\\" in filename or filename in {".", ".."}:
            return None
        with self.lock(group_id):
            if group_id not in self._cache:
                return None
            base = (self.group_dir(group_id) / kind).resolve()
            target = (base / filename).resolve()
            if target.parent != base or not target.is_file():
                return None
            return target

    def get_message_page(self, group_id: str, *, limit: int = 60,
                         before: str | None = None, after: str | None = None) -> dict | None:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        if before is not None and after is not None:
            raise ValueError("before and after are mutually exclusive")
        with self.lock(group_id):
            data = self._cache.get(group_id)
            if data is None:
                return None
            version = self._page_versions.setdefault(group_id, uuid.uuid4().hex)
            messages = data["messages"]
            position = len(messages)
            token = before if before is not None else after
            if token is not None:
                try:
                    if not isinstance(token, str) or not token or len(token) > 2048:
                        raise ValueError()
                    raw = base64.b64decode(token + "=" * (-len(token) % 4), altchars=b"-_", validate=True)
                    cursor = json.loads(raw)
                    if (not isinstance(cursor, list) or len(cursor) != 3 or cursor[0] != group_id
                            or not isinstance(cursor[1], str) or type(cursor[2]) is not int or cursor[2] < 0):
                        raise ValueError()
                except (ValueError, TypeError, UnicodeError, binascii.Error) as exc:
                    raise ValueError("Invalid message cursor") from exc
                if cursor[1] != version:
                    raise StaleMessageCursor("History changed; reload messages")
                position = cursor[2]
                if position > len(messages):
                    raise ValueError("Invalid message cursor position")
            if after is not None:
                start, end = position, min(len(messages), position + limit)
                more = end < len(messages)
            else:
                start, end = max(0, position - limit), position
                more = start > 0
            def encode(boundary):
                raw = json.dumps([group_id, version, boundary], separators=(",", ":")).encode()
                return base64.urlsafe_b64encode(raw).decode().rstrip("=")
            return {"group_id": group_id,
                    "messages": [dict(deepcopy(message), _page_key=message["local_id"], _position=index)
                                 for index, message in enumerate(messages[start:end], start)],
                    "before_cursor": encode(start), "after_cursor": encode(end), "has_more": more,
                    "state": deepcopy(data["state"])}

    @staticmethod
    def _message_date(message: dict) -> str:
        try:
            return datetime.fromisoformat(message.get("timestamp", "")).strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            return ""

    def get_message_dates(self, group_id: str) -> list[dict]:
        data = self.get_group(group_id)
        counts: dict[str, int] = {}
        for message in (data or {}).get("messages", []):
            date = self._message_date(message)
            if date:
                counts[date] = counts.get(date, 0) + 1
        return [{"date": date, "count": count} for date, count in sorted(counts.items(), reverse=True)]

    def get_messages_by_date(self, group_id: str, date_str: str) -> list[dict]:
        data = self.get_group(group_id)
        return [dict(message, index=index, fingerprint=_message_fingerprint(message))
                for index, message in enumerate((data or {}).get("messages", []))
                if self._message_date(message) == date_str]
