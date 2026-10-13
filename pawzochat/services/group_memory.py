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

"""Independent member memories, durable group events and retained archives."""
from __future__ import annotations

from copy import deepcopy
import json
import logging
from pathlib import Path
import re
import threading
import time

from pawzochat.paths import GROUP_MEMORIES_DIR
from pawzochat.services.memory import (
    DuplicateMemoryError, MemoryConflictError, MemoryService, _clamp_importance,
    _has_summary, _now_readable, _SUMMARIZE_PROMPT,
    auto_summary_enabled,
)
from pawzochat.utils.message_text import inject_quote_prefix

logger = logging.getLogger(__name__)
_SAFE_ID = re.compile(r"[A-Za-z0-9_-]+")


class _ScopedMemoryService(MemoryService):
    """Reuse checked CRUD and consolidation, with explicit (group, persona) keys."""

    def __init__(self, owner, private):
        super().__init__(private.config, private.store, private.llm_manager)
        self.owner = owner
        self._llm_semaphore = private._llm_semaphore

    def _get_lock(self, scope):
        with self._global_lock:
            return self._locks.setdefault(scope, threading.RLock())

    def _memory_path(self, scope):
        return self.owner._path(*scope)

    def load_memories(self, scope):
        path = self._memory_path(scope)
        if not path.is_file():
            return {"memories": []}
        # A damaged archive must never silently become an empty writable file.
        data = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(data, dict) or not isinstance(data.get("memories"), list)
                or any(not isinstance(entry, dict) for entry in data["memories"])):
            raise ValueError("群记忆文件格式无效")
        counters = ("epoch", "memory_version", "event_count", "last_event", "summary_count",
                    "reminder_count", "summary_seq", "history_revision", "member_revision")
        if any(key in data and (type(data[key]) is not int or data[key] < 0) for key in counters):
            raise ValueError("群记忆计数格式无效")
        if (any(key in data and not isinstance(data[key], str) for key in ("group_name", "persona_name"))
                or any(key in entry and not isinstance(entry[key], str)
                       for entry in data["memories"] for key in ("summary", "created_at"))):
            raise ValueError("群记忆文本格式无效")
        return data

    def save_memories(self, scope, data):
        old = self.load_memories(scope)
        data["memory_version"] = old.get("memory_version", 0) + int(old["memories"] != data["memories"])
        super().save_memories(scope, data)

    def get_memory_settings(self, scope):
        return self.owner.get_settings(*scope)

    def _resolve_persona(self, scope):
        return self.owner.private._resolve_persona(scope[1])

    def _background_token(self, scope):
        data = self.load_memories(scope)
        return data.get("epoch", 0)

    def _background_valid(self, scope, token):
        if self.owner._closing.is_set():
            return False
        data = self.load_memories(scope)
        group = self.owner.store._cache.get(scope[0])
        return (group is not None and data.get("history_revision", 0) == group.get("_memory_revision", 0)
                and data.get("member_revision", 0) == self.owner._member_revision(scope)
                and data.get("epoch", 0) == token and data.get("active", False)
                and data.get("generation_enabled", True)
                and self.owner._live_member(scope) is not None
                and self._resolve_persona(scope) is not None)

    def _consolidate_bg(self, scope, max_memories, persona):
        try:
            self._consolidate(scope, max_memories, persona)
        except Exception:
            self.owner._report_error(scope, "群记忆整理失败，将在后续消息中重试。")
            logger.exception("Group memory consolidation failed: %s", scope)
        finally:
            with self._global_lock:
                self._consolidating.discard(scope)

    def _call_json_with_retries(self, *args, **kwargs):
        result = super()._call_json_with_retries(*args, **kwargs)
        cancelled = kwargs.get("is_cancelled")
        if result is None and not (cancelled and cancelled()):
            self.owner._report_error(kwargs["persona_id"], "群记忆生成或整理失败，将在后续消息中重试。")
        return result


class GroupMemoryService:
    """Keep each member's memories independent of chat history lifetime.

    Group JSON owns a persistent event outbox. Applying an event and its tools
    updates a member file and its last-event receipt in one atomic replacement.
    A crash can replay an event safely. Model work is always outside group and
    memory locks; its epoch and history revision are checked before committing.
    """

    def __init__(self, config, group_store, private_memory_service, data_dir=GROUP_MEMORIES_DIR):
        self.config = config
        self.store = group_store
        self.private = private_memory_service
        self.data_dir = Path(data_dir)
        self._closing = threading.Event()
        self._backend = _ScopedMemoryService(self, private_memory_service)
        self._jobs_lock = threading.Lock()
        self._jobs: dict[tuple[str, str], int] = {}
        self._source_errors: dict[tuple[str, str], str] = {}
        self._read_errors: set[tuple[str, str]] = set()
        self._task_errors: set[tuple[str, str]] = set()

    @staticmethod
    def _scope(group_id, persona_id):
        if any(not isinstance(value, str) or not _SAFE_ID.fullmatch(value) for value in (group_id, persona_id)):
            raise ValueError("无效的群记忆标识")
        return group_id, persona_id

    def _path(self, group_id, persona_id):
        group_id, persona_id = self._scope(group_id, persona_id)
        return self.data_dir / group_id / f"{persona_id}.json"

    def has_source(self, group_id, persona_id):
        try:
            scope = self._scope(group_id, persona_id)
            with self.store.lock(group_id), self._backend._get_lock(scope):
                if not self._path(*scope).is_file() or self._deletion_pending(group_id):
                    return False
                try:
                    data = self._backend.load_memories(scope)
                except (OSError, ValueError):
                    # A damaged source remains selectable so it can be removed.
                    return True
                if not data.get("deleted"):
                    return True
                group = self.store._cache.get(group_id)
                if (group is None or not any(member["persona_id"] == persona_id for member in group["members"])
                        or self.private._resolve_persona(persona_id) is None):
                    return False
                try:
                    self._backend.save_memories(scope, self._empty_member_source(scope, group, data))
                except OSError:
                    logger.exception("Could not restore empty group memory source: %s", scope)
                    return False
                self._source_errors.pop(scope, None)
                self._read_errors.discard(scope)
                self._task_errors.discard(scope)
                return True
        except (OSError, ValueError):
            return False

    def _deletion_marker(self, group_id):
        self._scope(group_id, "_")
        return self.data_dir / f".delete-group-{group_id}"

    def _deletion_pending(self, group_id):
        return self._deletion_marker(group_id).is_file() and group_id not in self.store._cache

    def _persona_deletion_marker(self, persona_id):
        self._scope("_", persona_id)
        return self.data_dir / f".delete-persona-{persona_id}"

    def begin_persona_deletion(self, persona_id):
        """Record intent before deleting config; never acquire group locks here."""
        marker = self._persona_deletion_marker(persona_id)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()

    def persona_deletion_pending(self, persona_id):
        try:
            return self._persona_deletion_marker(persona_id).is_file()
        except ValueError:
            return False

    def finish_persona_deletion(self, persona_id):
        """Erase this role's sources and membership, retaining shared history."""
        marker = self._persona_deletion_marker(persona_id)
        if not marker.is_file():
            return
        if persona_id in self.config.get("personas", default={}):
            # The config deletion failed or the process stopped before saving.
            marker.unlink(missing_ok=True)
            return
        # Enumerate directories explicitly so a permission error cannot be
        # mistaken for successful erasure. Include archives of deleted groups.
        group_ids = {group["group_id"] for group in self.store.list_groups()}
        group_ids.update(path.name for path in self.data_dir.iterdir()
                         if _SAFE_ID.fullmatch(path.name) and path.is_dir())
        for group_id in group_ids:
            scope = (group_id, persona_id)
            with self.store.lock(group_id), self._backend._get_lock(scope):
                group = self.store._cache.get(group_id)
                related = group is not None and (
                    any(m["persona_id"] == persona_id for m in group["members"])
                    or persona_id in group.get("_memory_member_revisions", {})
                    or group["state"].get("active_persona_id") == persona_id
                    or any(any(r["persona_id"] == persona_id for r in event["recipients"])
                           or (event.get("persona_id") == persona_id and "tools" in event)
                           for event in group.get("_memory_outbox", [])))
                if related:
                    def remove(data):
                        was_member = any(m["persona_id"] == persona_id for m in data["members"])
                        data["members"] = [m for m in data["members"] if m["persona_id"] != persona_id]
                        data.get("_memory_member_revisions", {}).pop(persona_id, None)
                        for event in data.get("_memory_outbox", []):
                            event["recipients"] = [r for r in event["recipients"] if r["persona_id"] != persona_id]
                            if event.get("persona_id") == persona_id:
                                event.pop("tools", None)
                        if was_member or data["state"].get("active_persona_id") == persona_id:
                            data.pop("_pending_reply", None)
                            data["state"].update(status="paused", active_persona_id="", error="")
                    self.store.transaction(group_id, remove)
                path = self._path(*scope)
                path.unlink(missing_ok=True)
                path.with_suffix(".json.tmp").unlink(missing_ok=True)
                self._source_errors.pop(scope, None)
                self._read_errors.discard(scope)
                self._task_errors.discard(scope)
        marker.unlink(missing_ok=True)

    def _read_source(self, scope):
        try:
            data = self._backend.load_memories(scope)
            if scope in self._read_errors:
                self._read_errors.discard(scope)
                self._source_errors.pop(scope, None)
            return data
        except (OSError, ValueError):
            self._read_errors.add(scope)
            self._source_errors[scope] = "群记忆文件无法读取，请检查文件或恢复备份。"
            logger.exception("Could not read group memory: %s", scope)
            return None

    def _report_error(self, scope, message):
        self._task_errors.add(scope)
        self._source_errors[scope] = message

    def _live_member(self, scope):
        # Store transactions replace cache snapshots; this read takes no group
        # lock, preserving the group→memory lock order during consolidation.
        group = self.store._cache.get(scope[0])
        return next((member for member in (group or {}).get("members", [])
                     if member["persona_id"] == scope[1] and member.get("memory_enabled", True)), None)

    def _member_revision(self, scope):
        group = self.store._cache.get(scope[0], {})
        return group.get("_memory_member_revisions", {}).get(scope[1], 0)

    def _require(self, group_id, persona_id):
        scope = self._scope(group_id, persona_id)
        if not self.has_source(*scope):
            raise KeyError("群记忆不存在")
        return scope

    @staticmethod
    def initialize_history(data):
        """Assign persistent monotonic positions once, including legacy groups."""
        sequence = data.get("_memory_message_seq", 0)
        for message in data.get("messages", []):
            if "_memory_seq" not in message:
                sequence += 1
                message["_memory_seq"] = sequence
            else:
                sequence = max(sequence, message["_memory_seq"])
        data["_memory_message_seq"] = sequence
        data.setdefault("_memory_event_seq", 0)
        data.setdefault("_memory_revision", 0)

    @staticmethod
    def number_message(data, message):
        data["_memory_message_seq"] = data.get("_memory_message_seq", 0) + 1
        message["_memory_seq"] = data["_memory_message_seq"]

    def start(self):
        # Recovery applies only already committed local work, never starts an
        # LLM request or summarizes pre-feature history automatically.
        for marker in self.data_dir.glob(".delete-persona-*"):
            persona_id = marker.name.removeprefix(".delete-persona-")
            if not _SAFE_ID.fullmatch(persona_id):
                continue
            try:
                self.finish_persona_deletion(persona_id)
            except OSError:
                logger.exception("Could not finish persona group data deletion: %s", persona_id)
        for marker in self.data_dir.glob(".delete-group-*"):
            group_id = marker.name.removeprefix(".delete-group-")
            if not _SAFE_ID.fullmatch(group_id):
                continue
            try:
                with self.store.lock(group_id):
                    if group_id not in self.store._cache:
                        self._delete_group_sources(group_id)
                    marker.unlink(missing_ok=True)
            except OSError:
                logger.exception("Could not finish group memory deletion: %s", group_id)
        for group in self.store.list_groups():
            group_id = group["group_id"]
            with self.store.lock(group_id):
                raw = self.store._cache[group_id]
                if "_memory_message_seq" not in raw:
                    self.store.transaction(group_id, self.initialize_history)
                # Earlier versions hid even current members after clearing.
                # Restore their empty sources before replaying stale events.
                self.sync_group(group_id, restore_deleted_only=True)
                if self.drain_group(group_id, schedule=False):
                    self.sync_group(group_id)

    def _scopes_for_group(self, group_id):
        directory = self.data_dir / group_id
        return [(group_id, path.stem) for path in directory.glob("*.json") if _SAFE_ID.fullmatch(path.stem)]

    def sync_group(self, group_id, *, reset=False, restore_deleted_only=False):
        """Refresh membership/settings, retaining files for removed members."""
        with self.store.lock(group_id):
            group = self.store._cache.get(group_id)
            if group is None:
                return
            members = {member["persona_id"]: member for member in group["members"]}
            scopes = set(self._scopes_for_group(group_id)) | {(group_id, pid) for pid in members}
            personas = self.config.load_personas()
            for scope in scopes:
                pid = scope[1]
                with self._backend._get_lock(scope):
                    if self.persona_deletion_pending(pid) or (pid not in personas and not self._path(*scope).is_file()):
                        continue
                    data = self._read_source(scope)
                    if data is None or (restore_deleted_only and not data.get("deleted")):
                        continue
                    if data.get("deleted"):
                        if pid not in members or pid not in personas:
                            continue
                        data = self._empty_member_source(scope, group, data)
                    new = "group_id" not in data
                    active = pid in members and pid in personas
                    enabled = members.get(pid, {}).get("memory_enabled", True)
                    settings = self.private.get_memory_settings(pid)
                    mode = settings["trigger_mode"]
                    trigger = settings["trigger_rounds"]
                    previous_auto = data.get("auto_summary", False)
                    effective_auto = active and enabled and mode in {"summarize", "summarize_only"} and trigger > 0
                    lifecycle_changed = (new or data.get("active") != active
                                         or data.get("generation_enabled", True) != enabled or reset
                                         or data.get("member_revision", 0) != self._member_revision(scope))
                    settings_changed = data.get("settings_signature") != [mode, trigger, settings["max_memories"]]
                    baseline = lifecycle_changed or (not previous_auto and effective_auto)
                    if lifecycle_changed or settings_changed:
                        data["epoch"] = data.get("epoch", 0) + 1
                    if baseline:
                        data.update(summary_seq=group.get("_memory_message_seq", 0),
                                    summary_count=0, event_count=0, reminder_count=0,
                                    last_event=group.get("_memory_event_seq", 0))
                    persona = personas.get(pid)
                    data.update(group_id=group_id, persona_id=pid, group_name=group["name"],
                                persona_name=(persona.name if persona is not None else data.get("persona_name", pid)),
                                active=active, generation_enabled=enabled,
                                status="active" if active else "removed",
                                settings_signature=[mode, trigger, settings["max_memories"]],
                                member_revision=self._member_revision(scope),
                                auto_summary=effective_auto, history_revision=group.get("_memory_revision", 0))
                    if new:
                        data["error"] = ""
                    try:
                        self._backend.save_memories(scope, data)
                    except OSError:
                        self._source_errors[scope] = "群记忆设置未能保存，请检查磁盘后重试。"
                        logger.exception("Could not save group memory settings: %s", scope)

    def get_settings(self, group_id, persona_id):
        scope = self._scope(group_id, persona_id)
        settings = dict(self.private.get_memory_settings(persona_id))
        data = self._read_source(scope) or {}
        settings["enabled"] = bool(data.get("active") and self._live_member(scope) is not None
                                   and data.get("member_revision", 0) == self._member_revision(scope)
                                   and data.get("generation_enabled", True)
                                   and not self._closing.is_set()
                                   and self.private._resolve_persona(persona_id) is not None)
        settings["include_in_prompt"] = True
        return settings

    fingerprint = staticmethod(MemoryService.fingerprint)

    def load_memories(self, group_id, persona_id):
        scope = self._scope(group_id, persona_id)
        with self.store.lock(group_id), self._backend._get_lock(scope):
            self._require(*scope)
            return deepcopy(self._backend.load_memories(scope))

    def add_memory(self, group_id, persona_id, summary, importance, created_at=""):
        scope = self._scope(group_id, persona_id)
        with self.store.lock(group_id), self._backend._get_lock(scope):
            return self._backend.add_memory(self._require(*scope), summary, importance, created_at)

    def update_memory(self, group_id, persona_id, index, updates, *, expected_fingerprint):
        scope = self._scope(group_id, persona_id)
        with self.store.lock(group_id), self._backend._get_lock(scope):
            return self._backend.update_memory(self._require(*scope), index, updates,
                                               expected_fingerprint=expected_fingerprint)

    def delete_memory(self, group_id, persona_id, index, *, expected_fingerprint):
        scope = self._scope(group_id, persona_id)
        with self.store.lock(group_id), self._backend._get_lock(scope):
            self._backend.delete_memory(self._require(*scope), index,
                                        expected_fingerprint=expected_fingerprint)

    def _delete_source(self, scope):
        """Erase content but keep a hidden epoch barrier against late work."""
        with self._backend._get_lock(scope):
            try:
                previous = self._backend.load_memories(scope)
            except (OSError, ValueError):
                previous = {}
            epoch = previous.get("epoch", 0)
            epoch = epoch if isinstance(epoch, int) else 0
            tombstone = {"memories": [], "deleted": True,
                         "epoch": max(epoch + 1, time.time_ns())}
            # Bypass the scoped save's read/compare: corrupt files must also
            # be deletable, and the new epoch invalidates every old snapshot.
            MemoryService.save_memories(self._backend, scope, tombstone)
            self._source_errors.pop(scope, None)
            self._read_errors.discard(scope)
            self._task_errors.discard(scope)

    def _empty_member_source(self, scope, group, previous):
        member = next(member for member in group["members"] if member["persona_id"] == scope[1])
        persona = self.private._resolve_persona(scope[1])
        settings = self.private.get_memory_settings(scope[1])
        mode, rounds = settings["trigger_mode"], settings["trigger_rounds"]
        enabled = member.get("memory_enabled", True)
        epoch = previous.get("epoch", 0)
        epoch = epoch if isinstance(epoch, int) else 0
        return {"memories": [], "epoch": max(epoch + 1, time.time_ns()),
                "group_id": scope[0], "persona_id": scope[1], "group_name": group["name"],
                "persona_name": persona.name if persona is not None else scope[1],
                "active": persona is not None, "generation_enabled": enabled, "status": "active", "error": "",
                "summary_seq": group.get("_memory_message_seq", 0), "summary_count": 0,
                "event_count": 0, "reminder_count": 0, "last_event": group.get("_memory_event_seq", 0),
                "settings_signature": [mode, rounds, settings["max_memories"]],
                "auto_summary": enabled and mode in {"summarize", "summarize_only"} and rounds > 0,
                "member_revision": self._member_revision(scope),
                "history_revision": group.get("_memory_revision", 0)}

    def delete_source(self, group_id, persona_id):
        """Clear a current member's memories; remove an archived source."""
        scope = self._scope(group_id, persona_id)
        with self.store.lock(group_id), self._backend._get_lock(scope):
            self._require(*scope)
            group = self.store._cache.get(group_id)
            if group is None or not any(member["persona_id"] == persona_id for member in group["members"]):
                self._delete_source(scope)
                return True
            try:
                previous = self._backend.load_memories(scope)
            except (OSError, ValueError):
                previous = {}
            data = self._empty_member_source(scope, group, previous)
            # Manual clearing also repairs damaged sources and atomically
            # invalidates old tools, summaries and pending event receipts.
            MemoryService.save_memories(self._backend, scope, data)
            self._source_errors.pop(scope, None)
            self._read_errors.discard(scope)
            self._task_errors.discard(scope)
            return False

    def _delete_group_sources(self, group_id):
        try:
            paths = list((self.data_dir / group_id).iterdir())
        except FileNotFoundError:
            return
        # Unlike glob, iterdir reports permission errors. Never acknowledge
        # erasure merely because an unreadable directory looked empty.
        for path in paths:
            if path.suffix == ".json" and _SAFE_ID.fullmatch(path.stem):
                self._delete_source((group_id, path.stem))

    def delete_group_with_memories(self, group_id, delete_group):
        """Recover a crash between deleting chat history and its archives."""
        with self.store.lock(group_id):
            marker = self._deletion_marker(group_id)
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.touch()
            try:
                result = delete_group()
            except Exception:
                if group_id in self.store._cache:
                    marker.unlink(missing_ok=True)
                raise
            # From this point the marker hides all sources until erasure has
            # finished, including after an interrupted/failed disk write.
            self._delete_group_sources(group_id)
            marker.unlink(missing_ok=True)
            return result

    def finish_group_deletion(self, group_id):
        with self.store.lock(group_id):
            if not self._deletion_pending(group_id):
                return False
            self._delete_group_sources(group_id)
            self._deletion_marker(group_id).unlink(missing_ok=True)
            return True

    def list_sources(self, persona_id):
        if not isinstance(persona_id, str) or not _SAFE_ID.fullmatch(persona_id):
            raise ValueError("无效的角色标识")
        overrides = self.config.get("personas", default={}).get(persona_id, {}).get("memory", {}).get("group_reads", {})
        if not isinstance(overrides, dict):
            overrides = {}
        result = []
        for path in self.data_dir.glob(f"*/{persona_id}.json"):
            group_id = path.parent.name
            if not _SAFE_ID.fullmatch(group_id):
                continue
            if self._deletion_pending(group_id):
                continue
            data = self._read_source((group_id, persona_id)) or {"memories": []}
            if data.get("deleted"):
                if not self.has_source(group_id, persona_id):
                    continue
                data = self._read_source((group_id, persona_id)) or {"memories": []}
            group = self.store.get_group(group_id)
            status = ("deleted" if group is None else "active"
                      if any(member["persona_id"] == persona_id for member in group["members"]) else "removed")
            result.append({"group_id": group_id, "name": group["name"] if group else data.get("group_name", group_id),
                           "status": status, "include_in_private": overrides.get(group_id, True) is not False,
                           "generation_enabled": data.get("generation_enabled", True),
                           "total": len(data["memories"]),
                           "error": self._source_errors.get((group_id, persona_id), data.get("error", ""))})
        return sorted(result, key=lambda source: (source["status"] != "active", source["name"], source["group_id"]))

    def format_group_memories(self, group_id, persona_id, *, tool_context=None):
        data = self._read_source(self._scope(group_id, persona_id))
        if data is None:
            if tool_context is not None:
                tool_context["blocked"] = True
            return ""
        memories = tool_context.get("working_memories", data["memories"]) if tool_context else data["memories"]
        return MemoryService.format_memory_entries(memories, tool_context=tool_context,
                                                    title="[本群中我自己的长期记忆]")

    def format_private_reference(self, persona_id):
        settings = self.private.get_memory_settings(persona_id)
        if not settings["enabled"] or not settings["include_in_prompt"]:
            return ""
        try:
            return MemoryService.format_memory_entries(self.private.load_memories(persona_id)["memories"],
                                                        title="[我在私聊中的记忆，仅供参考，不可修改]", editable=False)
        except (OSError, ValueError, TypeError, AttributeError):
            logger.exception("Could not read private memory reference: %s", persona_id)
            return ""

    def format_private_imports(self, persona_id):
        settings = self.private.get_memory_settings(persona_id)
        if not settings["enabled"] or not settings["include_in_prompt"]:
            return ""
        sections = []
        for source in self.list_sources(persona_id):
            if not source["include_in_private"]:
                continue
            name = source["name"].replace("\n", " ").replace("\r", " ").replace("]", "］")
            data = self._read_source((source["group_id"], persona_id))
            if data is None:
                continue
            section = MemoryService.format_memory_entries(
                data["memories"], editable=False,
                title=f"[我在群聊「{name}」中的记忆，仅供参考，不可修改]")
            if section:
                sections.append(section)
        return "\n\n".join(sections)

    def settings_changed(self, persona_id):
        for group in self.store.list_groups():
            if any(member["persona_id"] == persona_id for member in group["members"]):
                if self.drain_group(group["group_id"], schedule=False):
                    self.sync_group(group["group_id"])

    def prepare_tool_context(self, group_id, persona_id, *, is_cancelled=lambda: False):
        fallback = {"group_id": group_id, "persona_id": persona_id, "fingerprints": {},
                    "blocked": True, "operations": [], "working_memories": [], "is_cancelled": is_cancelled}
        with self.store.lock(group_id):
            settled = self.drain_group(group_id, schedule=False)
            if not settled and self.store._cache.get(group_id, {}).get("_memory_outbox"):
                return fallback
            scope = self._scope(group_id, persona_id)
            if not self.has_source(*scope):
                return fallback
            group = self.store._cache.get(group_id)
            if group is None:
                raise KeyError(group_id)
            with self._backend._get_lock(scope):
                data = self._read_source(scope)
                if data is None:
                    return fallback
                return {"group_id": group_id, "persona_id": persona_id, "epoch": data.get("epoch", 0),
                        "memory_version": data.get("memory_version", 0),
                        "fingerprints": {i: self.fingerprint(entry) for i, entry in enumerate(data["memories"])},
                        "working_memories": deepcopy(data["memories"]), "operations": [], "blocked": False,
                        "cutoff_seq": group.get("_memory_message_seq", 0),
                        "cutoff_count": data.get("event_count", 0), "is_cancelled": is_cancelled,
                        "history_revision": group.get("_memory_revision", 0)}

    def _validate_tool_context(self, context):
        if not isinstance(context, dict) or context.get("blocked") or context.get("is_cancelled", lambda: True)():
            raise MemoryConflictError("本轮群记忆写入已停止")
        try:
            scope = self._require(context.get("group_id"), context.get("persona_id"))
        except KeyError as exc:
            context["blocked"] = True
            raise MemoryConflictError("本群记忆已删除，本轮写入已停止") from exc
        settings = self.get_settings(*scope)
        data = self._backend.load_memories(scope)
        if (not settings["enabled"] or settings["trigger_mode"] == "summarize_only"
                or data.get("epoch", 0) != context.get("epoch")
                or data.get("memory_version", 0) != context.get("memory_version")):
            context["blocked"] = True
            raise MemoryConflictError("群记忆已变化或已关闭，本轮写入已停止")
        return scope

    def stage_add_memory(self, context, summary, importance):
        self._validate_tool_context(context)
        memories = context["working_memories"]
        if _has_summary(memories, summary):
            raise DuplicateMemoryError("已有相同内容的记忆，无需重复记录。")
        entry = {"summary": summary.strip(), "importance": _clamp_importance(importance), "created_at": _now_readable()}
        index = len(memories)
        memories.append(entry)
        context["operations"].append({"op": "add", "entry": deepcopy(entry)})
        context["fingerprints"][index] = self.fingerprint(entry)
        return deepcopy(entry), index

    def stage_update_memory(self, context, index, updates, *, expected_fingerprint):
        self._validate_tool_context(context)
        memories = context["working_memories"]
        self._backend._check_target(memories, index, expected_fingerprint)
        entry = dict(memories[index])
        if "summary" in updates:
            summary = updates["summary"].strip()
            if _has_summary(memories, summary, exclude=index):
                raise DuplicateMemoryError("其他记忆已包含相同内容")
            entry["summary"] = summary
        if "importance" in updates:
            entry["importance"] = _clamp_importance(updates["importance"])
        if entry == memories[index]:
            return False
        memories[index] = entry
        context["operations"].append({"op": "update", "index": index, "entry": deepcopy(entry)})
        context["fingerprints"][index] = self.fingerprint(entry)
        return True

    def check_and_ack_reminder(self, group_id, persona_id, *, tool_context=None):
        settings = self.get_settings(group_id, persona_id)
        if not settings["enabled"] or settings["trigger_mode"] != "remind" or settings["trigger_rounds"] <= 0:
            return None
        data = self.load_memories(group_id, persona_id)
        count = data.get("event_count", 0)
        if count - data.get("reminder_count", 0) < settings["trigger_rounds"]:
            return None
        if tool_context is not None:
            tool_context["reminder_ack"] = count
        return ("[记忆检查] 本群已进行多轮交流。如有值得长期记住的新信息，使用 record_memory 或 update_memory"
                "暂存到你自己的本群记忆；没有重要信息则正常回复。")

    def record_event(self, data, *, persona_id="", tool_context=None):
        """Called inside the same group transaction as a user/complete turn."""
        data["_memory_event_seq"] = data.get("_memory_event_seq", 0) + 1
        recipients = []
        for member in data["members"]:
            if not member.get("memory_enabled", True):
                continue
            scope = (data["group_id"], member["persona_id"])
            memory = self._read_source(scope) or {}
            if (memory.get("active") and memory.get("member_revision", 0)
                    == data.get("_memory_member_revisions", {}).get(scope[1], 0)):
                recipients.append({"persona_id": scope[1], "epoch": memory.get("epoch", 0)})
        event = {"id": data["_memory_event_seq"], "message_seq": data.get("_memory_message_seq", 0),
                 "revision": data.get("_memory_revision", 0), "recipients": recipients, "persona_id": persona_id}
        if tool_context is not None:
            keys = ("epoch", "memory_version", "history_revision", "cutoff_seq", "cutoff_count", "reminder_ack")
            event["tools"] = {key: tool_context[key] for key in keys if key in tool_context}
            event["tools"]["operations"] = [] if tool_context.get("blocked") else deepcopy(tool_context.get("operations", []))
        data.setdefault("_memory_outbox", []).append(event)

    def _apply_event(self, group_id, event, recipient):
        scope = (group_id, recipient["persona_id"])
        with self._backend._get_lock(scope):
            if self.private._resolve_persona(scope[1]) is None:
                return
            data = self._backend.load_memories(scope)
            if data.get("last_event", 0) >= event["id"]:
                return
            if data.get("epoch", 0) != recipient["epoch"] or not data.get("active"):
                return
            data["event_count"] = data.get("event_count", 0) + 1
            tools = event.get("tools", {}) if event["persona_id"] == scope[1] else {}
            operations = tools.get("operations", [])
            if operations:
                if (tools.get("epoch") != data.get("epoch", 0)
                        or tools.get("memory_version") != data.get("memory_version", 0)
                        or tools.get("history_revision") != event["revision"]):
                    data["error"] = "本轮暂存记忆与最新记忆冲突，已整批取消，请检查后重试。"
                else:
                    for operation in operations:
                        if operation["op"] == "add":
                            data["memories"].append(deepcopy(operation["entry"]))
                        else:
                            data["memories"][operation["index"]] = deepcopy(operation["entry"])
                    data["error"] = ""
                    data["reminder_count"] = max(data.get("reminder_count", 0), tools["cutoff_count"])
                    if self.get_settings(*scope)["trigger_mode"] == "summarize":
                        data["summary_seq"] = max(data.get("summary_seq", 0), tools["cutoff_seq"])
                        data["summary_count"] = max(data.get("summary_count", 0), tools["cutoff_count"])
            if "reminder_ack" in tools and tools.get("epoch") == data.get("epoch", 0):
                data["reminder_count"] = max(data.get("reminder_count", 0), tools["reminder_ack"])
            data["last_event"] = event["id"]
            self._backend.save_memories(scope, data)

    def drain_group(self, group_id, *, schedule=True):
        scopes = set()
        with self.store.lock(group_id):
            group = self.store._cache.get(group_id)
            if group is None:
                return True
            events = deepcopy(group.get("_memory_outbox", []))
            try:
                for event in events:
                    for recipient in event["recipients"]:
                        self._apply_event(group_id, event, recipient)
                        scopes.add((group_id, recipient["persona_id"]))
                if events:
                    through = events[-1]["id"]
                    self.store.transaction(group_id, lambda data: data.update(
                        _memory_outbox=[event for event in data.get("_memory_outbox", []) if event["id"] > through]))
            except (OSError, ValueError):
                logger.exception("Could not settle committed group memory events: %s", group_id)
                return False
        if schedule:
            for scope in scopes:
                if scope in self._task_errors:
                    self._task_errors.discard(scope)
                    self._source_errors.pop(scope, None)
                try:
                    self._schedule(scope)
                except Exception:
                    self._report_error(scope, "群记忆任务未能启动，请检查记忆文件后重试。")
                    logger.exception("Could not schedule group memory: %s", scope)
        return True

    def _schedule(self, scope):
        if self._closing.is_set():
            return
        settings = self.get_settings(*scope)
        if not settings["enabled"]:
            return
        if auto_summary_enabled(settings):
            with self._jobs_lock:
                if scope in self._jobs:
                    self._jobs[scope] += 1
                    return
                self._jobs[scope] = 1
            try:
                threading.Thread(target=self._summary_worker, args=(scope,), daemon=True,
                                 name=f"group-memory-{scope[0][:8]}-{scope[1]}").start()
            except Exception:
                with self._jobs_lock:
                    self._jobs.pop(scope, None)
                raise
        else:
            self._backend.maybe_consolidate(scope)

    def _summary_worker(self, scope):
        while True:
            with self._jobs_lock:
                request_version = self._jobs.get(scope)
            try:
                if not self._closing.is_set():
                    self._summarize(scope)
                    self._backend.maybe_consolidate(scope)
            except Exception:
                self._report_error(scope, "群记忆生成失败，将在后续消息中重试。")
                logger.exception("Group memory background task failed: %s", scope)
            with self._jobs_lock:
                if self._closing.is_set() or self._jobs.get(scope) == request_version:
                    self._jobs.pop(scope, None)
                    return

    def _summarize(self, scope):
        group_id, persona_id = scope
        with self.store.lock(group_id):
            # The final public bubble and its event are committed before the
            # scheduler settles memory. Snapshot both at the same boundary.
            if not self.drain_group(group_id, schedule=False):
                return
            group = self.store._cache.get(group_id)
            if group is None:
                return
            with self._backend._get_lock(scope):
                data = self._backend.load_memories(scope)
                settings = self.get_settings(*scope)
                count = data.get("event_count", 0)
                if not auto_summary_enabled(settings) or count - data.get("summary_count", 0) < settings["trigger_rounds"]:
                    return
                token = data.get("epoch", 0)
                revision = group.get("_memory_revision", 0)
                cursor = data.get("summary_seq", 0)
                memory_version = data.get("memory_version", 0)
                cutoff = group.get("_memory_message_seq", 0)
                messages = deepcopy([message for message in group["messages"] if cursor < message.get("_memory_seq", 0) <= cutoff])
        persona = self.private._resolve_persona(persona_id)
        if persona is None or not messages:
            return
        lines = []
        for message in messages:
            speaker = message.get("speaker_name", "用户")
            if message.get("speaker_id") == persona_id:
                speaker = f"我（{speaker}）"
            parts = []
            labels = {"image": "[图片]", "file": "[文件]", "emoji": "[表情]", "voice": "[语音]"}
            for block in message.get("content", []):
                text = block.get("text") if block.get("type") in {"text", "voice"} else None
                parts.append(text or labels.get(block.get("type"), ""))
            text = inject_quote_prefix(" ".join(parts), message.get("quote", ""))
            if text:
                lines.append(f"{speaker}: {text}")
        if not lines:
            return
        prompt = (f"这是群聊「{group.get('name', '')}」的公开记录。你是{persona.name}，只从你自己的视角回忆，"
                  "按发言者姓名区分人物，不把其他成员的经历当成自己的经历。"
                  "如果记录中没有你的发言，只回忆你看到的内容，不编造自己做出的回应、承诺或行动。\n\n"
                  + _SUMMARIZE_PROMPT.format(conversation="\n".join(lines)))
        result = self._backend._call_json_with_retries(
            persona, prompt, persona_id=scope, operation="群记忆总结", max_tokens=2000,
            is_cancelled=lambda: not self._backend._background_valid(scope, token))
        with self.store.lock(group_id):
            current = self.store._cache.get(group_id)
            if current is None or current.get("_memory_revision", 0) != revision:
                return
            with self._backend._get_lock(scope):
                data = self._backend.load_memories(scope)
                if (not self._backend._background_valid(scope, token)
                        or not auto_summary_enabled(self.get_settings(*scope))
                        or count - data.get("summary_count", 0) < self.get_settings(*scope)["trigger_rounds"]
                        or data.get("summary_seq", 0) != cursor
                        or data.get("memory_version", 0) != memory_version):
                    return
                if result is None:
                    data["error"] = "群记忆总结失败，将在后续消息中重试。"
                else:
                    if not _has_summary(data["memories"], result["summary"]):
                        data["memories"].append({"summary": result["summary"],
                                                 "importance": _clamp_importance(result.get("importance", 3)),
                                                 "created_at": _now_readable()})
                    data.update(summary_seq=cutoff, summary_count=count, error="")
                self._backend.save_memories(scope, data)

    def history_changed(self, group_id, *, clear=False):
        with self.store.lock(group_id):
            # Advancing the epoch also invalidates delayed tool/consolidation
            # results. Existing memories remain user-managed independent data.
            self.sync_group(group_id, reset=clear)
            for scope in self._scopes_for_group(group_id):
                with self._backend._get_lock(scope):
                    data = self._read_source(scope)
                    if data is None:
                        continue
                    data["epoch"] = data.get("epoch", 0) + 1
                    try:
                        self._backend.save_memories(scope, data)
                    except OSError:
                        self._report_error(scope, "历史变更后的群记忆状态未能保存，请检查存储后重试。")
                        logger.exception("Could not invalidate group memory after history change: %s", scope)

    def retire_group(self, group_id):
        if not self.drain_group(group_id, schedule=False):
            raise OSError("已提交的群记忆尚未保存，请稍后重试删除群聊")
        # Refresh the display snapshot but do not mark the scope inactive
        # before group deletion succeeds. Store existence is the archive gate.
        self.sync_group(group_id)

    def shutdown(self):
        self._closing.set()
