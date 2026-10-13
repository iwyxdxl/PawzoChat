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

"""A serial, budgeted background conversation runner for each web group."""
from __future__ import annotations

from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field
import logging
from pathlib import Path
import random
import shutil
import tempfile
import threading
import time
import uuid

from pawzochat.core.config import DEFAULT_GROUP_SYSTEM_INSTRUCTIONS
from pawzochat.paths import EMOJI_DIR
from pawzochat.store.conversation import StaleMessageCursor, _message_fingerprint, _now_iso
from pawzochat.transport.sender import MessageSender
from pawzochat.utils.group_mentions import annotate_reply_mentions
from pawzochat.utils.profile import ProfileIdentity, load_profile_identity
from pawzochat.web.sse import broadcast

logger = logging.getLogger(__name__)


@dataclass
class _Generation:
    persona_id: str
    started_at: float = field(default_factory=lambda: time.monotonic())
    token: str = field(default_factory=lambda: uuid.uuid4().hex)
    cancelled: threading.Event = field(default_factory=threading.Event)
    member_names: dict[str, str] = field(default_factory=dict)
    user_identity: ProfileIdentity = field(default_factory=ProfileIdentity)


@dataclass
class _Runtime:
    queue: deque = field(default_factory=deque)
    # Explicit mentions stay ahead of probabilistic candidates. Keep their
    # existing order when another role adds a mention during its reply.
    mentions: list[str] = field(default_factory=list)
    active: _Generation | None = None
    worker: threading.Thread | None = None


class GroupChatService:
    """The store lock serializes intake, lifecycle changes and whole-turn commit.

    Generation runs outside that lock. Only the exact active generation can
    commit; a user's new message keeps it active, while stop/edit/delete revoke
    it. Complete turns are committed with their budget before the first bubble
    is published; the remaining bubbles stay private until their typing delay
    expires. Unpublished work is discarded on cancellation or restart.
    """

    def __init__(self, app):
        self._app = app
        self._store = app.group_store
        self._memory = getattr(app, "group_memory_service", None)
        self._runtimes: dict[str, _Runtime] = {}
        self._runtime_lock = threading.Lock()
        self._closing = threading.Event()
        for group in self._store.list_groups():
            if (group["state"].get("status") == "running" or group["state"].get("active_persona_id")
                    or self._store._cache[group["group_id"]].get("_pending_reply")):
                self._store.transaction(group["group_id"], lambda data: self._pause(
                    data, error="服务已重启，发送新消息后继续"))
        if self._memory is not None:
            self._memory.start()

    def _runtime(self, group_id: str) -> _Runtime:
        with self._runtime_lock:
            return self._runtimes.setdefault(group_id, _Runtime())

    def _group(self, group_id: str) -> dict:
        group = self._store.get_group(group_id)
        if group is None:
            raise KeyError(group_id)
        return group

    def _validate_settings(self, name, members, max_replies, *, creating=False):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
            raise ValueError("群名称须为 1 到 60 个字符")
        if type(max_replies) is not int or max_replies < 1:
            raise ValueError("回复上限须为正整数")
        if not isinstance(members, list) or (creating and len(members) < 2):
            raise ValueError("新群至少需要两个角色")
        personas = self._app.config.load_personas()
        result = []
        seen = set()
        for member in members:
            if not isinstance(member, dict):
                raise ValueError("无效的群成员")
            persona_id = member.get("persona_id")
            probability = member.get("reply_probability", 50)
            if not isinstance(persona_id, str) or persona_id not in personas:
                raise ValueError("群成员角色不存在")
            if persona_id in seen:
                raise ValueError("群成员不能重复")
            if type(probability) is not int or not 0 <= probability <= 100:
                raise ValueError("回复概率须为 0 到 100 的整数")
            if type(member.get("memory_enabled", True)) is not bool:
                raise ValueError("群记忆生成开关须为布尔值")
            if not isinstance(member.get("group_prompt", ""), str):
                raise ValueError("本群专属提示词须为字符串")
            seen.add(persona_id)
            clean = {"persona_id": persona_id, "reply_probability": probability}
            if "memory_enabled" in member:
                clean["memory_enabled"] = member["memory_enabled"]
            if "group_prompt" in member:
                clean["group_prompt"] = member["group_prompt"]
            result.append(clean)
        return name.strip(), result, max_replies

    def create_group(self, name: str, members: list[dict], max_replies: int = 5, *,
                     system_instructions: str = DEFAULT_GROUP_SYSTEM_INSTRUCTIONS) -> dict:
        if self._closing.is_set():
            raise RuntimeError("群聊服务正在关闭")
        if not isinstance(system_instructions, str):
            raise ValueError("群系统提示词须为字符串")
        name, members, max_replies = self._validate_settings(name, members, max_replies, creating=True)
        group = self._store.create_group(name, members, max_replies,
                                        system_instructions=system_instructions)
        if self._memory is not None:
            self._store.transaction(group["group_id"], self._memory.initialize_history)
            self._memory.sync_group(group["group_id"])
            group = self._group(group["group_id"])
        broadcast("group_updated", group_id=group["group_id"], state=group["state"])
        return group

    @staticmethod
    def _invalidate(runtime: _Runtime):
        runtime.queue.clear()
        runtime.mentions.clear()
        if runtime.active is not None:
            runtime.active.cancelled.set()
            runtime.active = None

    @staticmethod
    def _pause(data, *, error=""):
        data.pop("_pending_reply", None)
        data["state"].update(status="paused", active_persona_id="", error=error)

    def update_group(self, group_id: str, **changes) -> dict:
        if set(changes) - {"name", "members", "max_replies", "system_instructions"}:
            raise ValueError("不支持的群设置")
        with self._store.lock(group_id):
            group = self._group(group_id)
            system_instructions = changes.get("system_instructions", group["system_instructions"])
            if not isinstance(system_instructions, str):
                raise ValueError("群系统提示词须为字符串")
            if self._memory is not None:
                if not self._memory.drain_group(group_id, schedule=False):
                    raise OSError("群记忆尚未保存，请稍后重试修改群设置")
            name, members, maximum = self._validate_settings(
                changes.get("name", group["name"]), changes.get("members", group["members"]),
                changes.get("max_replies", group["max_replies"]))
            previous_members = {member["persona_id"]: member for member in group["members"]}
            for member in members:
                previous = previous_members.get(member["persona_id"], {})
                if "memory_enabled" not in member and "memory_enabled" in previous:
                    member["memory_enabled"] = previous["memory_enabled"]
                member.setdefault("group_prompt", previous.get("group_prompt", ""))
            scheduling_members = lambda values: [(m["persona_id"], m["reply_probability"]) for m in values]
            scheduling_changed = (scheduling_members(members) != scheduling_members(group["members"])
                                  or maximum != group["max_replies"])
            def update(data):
                previous_memory = {m["persona_id"]: m.get("memory_enabled", True) for m in data["members"]}
                current_memory = {m["persona_id"]: m.get("memory_enabled", True) for m in members}
                for pid in previous_memory.keys() | current_memory.keys():
                    if previous_memory.get(pid) != current_memory.get(pid):
                        revisions = data.setdefault("_memory_member_revisions", {})
                        revisions[pid] = revisions.get(pid, 0) + 1
                data.update(name=name, members=members, max_replies=maximum,
                            system_instructions=system_instructions)
                # Prompt edits apply to the next generation. The current turn
                # keeps its captured context and finishes all of its bubbles.
                if scheduling_changed:
                    self._pause(data)
            group = self._store.transaction(group_id, update)
            if scheduling_changed:
                self._invalidate(self._runtime(group_id))
            if self._memory is not None:
                self._memory.sync_group(group_id)
            self._state_event(group)
            broadcast("group_updated", group_id=group_id, state=group["state"])
            return self._store._public(group)

    def remove_persona(self, persona_id: str) -> int:
        removed = 0
        for summary in self._store.list_groups():
            group_id = summary["group_id"]
            with self._store.lock(group_id):
                group = self._store.get_group(group_id)
                if group is None or not any(m["persona_id"] == persona_id for m in group["members"]):
                    continue
                # Persona deletion is already durable. Revoke queued and
                # unpublished work even if this group's cleanup cannot save.
                self._invalidate(self._runtime(group_id))
                if self._memory is not None:
                    self._memory.drain_group(group_id, schedule=False)
                # Other already-missing roles can still be retained as history
                # references; do not run creation validation during deletion.
                def remove(data):
                    data["members"] = [m for m in data["members"] if m["persona_id"] != persona_id]
                    self._pause(data)
                try:
                    group = self._store.transaction(group_id, remove)
                except OSError:
                    logger.exception("Could not remove deleted persona %s from group %s", persona_id, group_id)
                    continue
                if self._memory is not None:
                    self._memory.sync_group(group_id)
                self._state_event(group)
                broadcast("group_updated", group_id=group_id, state=group["state"])
                removed += 1
        return removed

    def set_avatar(self, group_id: str, png: bytes | None) -> dict:
        # Appearance changes must not cancel active replies or reset the budget.
        with self._store.lock(group_id):
            group = self._store.set_avatar(group_id, png)
            broadcast("group_updated", group_id=group_id, state=group["state"])
            return group

    def delete_group(self, group_id: str, *, delete_memories: bool = False) -> bool:
        with self._store.lock(group_id):
            group = self._store.get_group(group_id)
            if group is None:
                if self._memory is not None and delete_memories:
                    return self._memory.finish_group_deletion(group_id)
                return False
            if self._memory is not None and not delete_memories:
                self._memory.retire_group(group_id)
            try:
                if self._memory is not None and delete_memories:
                    result = self._memory.delete_group_with_memories(
                        group_id, lambda: self._store.delete_group(group_id))
                else:
                    result = self._store.delete_group(group_id)
            finally:
                if self._store.get_group(group_id) is None:
                    self._invalidate(self._runtime(group_id))
                    state = dict(group["state"], status="paused", active_persona_id="",
                                 version=group["state"]["version"] + 1)
                    broadcast("group_updated", group_id=group_id, state=state, deleted=True)
            return result

    def stop_group(self, group_id: str) -> dict:
        with self._store.lock(group_id):
            self._group(group_id)
            group = self._store.transaction(group_id, self._pause)
            self._invalidate(self._runtime(group_id))
            self._state_event(group)
            if self._memory is not None:
                self._memory.drain_group(group_id)
            return group["state"]

    @staticmethod
    def _validate_content(content):
        if not isinstance(content, list) or not content or any(not isinstance(b, dict) for b in content):
            raise ValueError("消息内容不能为空")
        if not any(b.get("type") != "text" or str(b.get("text", "")).strip() for b in content):
            raise ValueError("消息内容不能为空")
        return deepcopy(content)

    def _candidates(self, group, queue=(), *, speaker=None, active=None, mentions=()):
        result = list(dict.fromkeys([*mentions, *queue]))
        selected = []
        for member in group["members"]:
            persona_id = member["persona_id"]
            if persona_id in result or persona_id in {speaker, active}:
                continue
            probability = member["reply_probability"]
            if probability == 100 or (probability > 0 and random.randrange(100) < probability):
                selected.append(persona_id)
        random.shuffle(selected)
        return deque(result + selected)

    @staticmethod
    def _quote_text(message):
        labels = {"image": "[图片]", "file": "[文件]", "voice": "[语音]", "emoji": "[表情]"}
        content = " ".join(str(b.get("text", "")) if b.get("type") == "text"
                           else labels.get(b.get("type"), "") for b in message.get("content", []))
        return f'{message.get("speaker_name", "我")}：{content}'

    def send_message(self, group_id: str, content: list[dict], *, client_message_id: str,
                     mention_persona_ids: list[str] | None = None, quote: str = "",
                     quote_media: list | None = None, reply_to_message_id: str = "",
                     media_dir: Path | None = None) -> dict:
        if self._closing.is_set():
            raise RuntimeError("群聊服务正在关闭")
        if not isinstance(client_message_id, str) or not 1 <= len(client_message_id) <= 200:
            raise ValueError("需要有效的 client_message_id")
        content = self._validate_content(content)
        if not isinstance(quote, str) or not isinstance(reply_to_message_id, str):
            raise ValueError("引用信息无效")
        mentions = mention_persona_ids if mention_persona_ids is not None else []
        if not isinstance(mentions, list) or any(not isinstance(pid, str) for pid in mentions):
            raise ValueError("@成员信息无效")
        with self._store.lock(group_id):
            group = self._group(group_id)
            # Receipts survive history edits/deletion, so a delayed HTTP retry
            # can never start a fresh cycle or restore an intentionally removed message.
            local_id = self._store._cache[group_id].get("_requests", {}).get(client_message_id)
            if local_id:
                message = next((m for m in group["messages"] if m["local_id"] == local_id), None)
                if message is None:
                    raise ValueError("该消息已删除，请重新发送新消息")
                return {"message": message, "state": group["state"], "duplicate": True}
            member_ids = {m["persona_id"] for m in group["members"]}
            if any(pid not in member_ids for pid in mentions):
                raise ValueError("@的角色不在群内")
            mentions = list(dict.fromkeys(mentions))
            if reply_to_message_id:
                target = next((m for m in group["messages"] if m["local_id"] == reply_to_message_id), None)
                if target is None:
                    raise KeyError(reply_to_message_id)
                quote = self._quote_text(target)
                quote_media = [deepcopy(block) for block in target.get("content", [])
                               if block.get("type") in {"image", "file", "voice", "emoji"}]
            runtime = self._runtime(group_id)
            active = runtime.active
            queue = self._candidates(group, active=active.persona_id if active else None, mentions=mentions)
            # Only user intake gets a fallback; role-to-role replies may go idle.
            # An active turn already supplies a reply. Zero-probability members
            # remain mention-only, including when every member is set to zero.
            if not queue and active is None:
                candidates = [m for m in group["members"] if m["reply_probability"] > 0]
                if candidates:
                    queue.extend(random.choices(
                        [m["persona_id"] for m in candidates],
                        weights=[m["reply_probability"] for m in candidates], k=1))
            local_id = uuid.uuid4().hex
            message = {"local_id": local_id, "turn_id": local_id, "client_message_id": client_message_id,
                       "role": "user", "source": "web", "speaker_id": "user", "speaker_name": load_profile_identity().display_name, "timestamp": _now_iso(),
                       "content": content, "mentions": mentions}
            if quote:
                message["quote"] = quote
            if reply_to_message_id:
                message["reply_to_message_id"] = reply_to_message_id
            if quote_media:
                message["quote_media"] = deepcopy(quote_media)
            created = []
            try:
                created = self._commit_media(group_id, [message], Path(media_dir) if media_dir is not None else None)
                self._validate_quote_media(group_id, message.get("quote_media", []))
                def save(data):
                    if self._memory is not None:
                        self._memory.number_message(data, message)
                    data["messages"].append(message)
                    data.setdefault("_requests", {})[client_message_id] = local_id
                    data["state"].update(
                        status="running" if active or queue else "idle", reply_count=0,
                        cycle_id=uuid.uuid4().hex, active_persona_id=active.persona_id if active else "", error="")
                    if self._memory is not None:
                        self._memory.record_event(data)
                group = self._store.transaction(group_id, save)
            except Exception:
                self._rollback_media(created)
                raise
            runtime.queue = queue
            runtime.mentions = list(mentions)
            broadcast("group_message", group_id=group_id, message=message, state=group["state"])
            broadcast("group_updated", group_id=group_id, state=group["state"])
            if self._memory is not None:
                self._memory.drain_group(group_id)
            self._ensure_worker(group_id, runtime)
            return {"message": deepcopy(message), "state": group["state"], "duplicate": False}

    def _ensure_worker(self, group_id, runtime):
        if runtime.worker is not None and runtime.worker.is_alive():
            return
        if not runtime.queue or self._closing.is_set():
            return
        runtime.worker = threading.Thread(target=self._worker, args=(group_id, runtime),
                                          daemon=True, name=f"group-{group_id[:8]}")
        runtime.worker.start()

    def _history(self, group):
        maximum = self._app.config.get("chat", "max_context_rounds", default=20)
        try:
            maximum = max(1, int(maximum))
        except (TypeError, ValueError):
            maximum = 20
        messages = group["messages"]
        first_bubble = {}
        for index, message in enumerate(messages):
            turn = message.get("turn_id", message["local_id"])
            first_bubble.setdefault(turn, index)
        # A user can interject between bubbles of the same logical turn. Pick
        # recent distinct turns, then retain a contiguous suffix containing
        # every bubble of any turn it intersects, including that interjection.
        recent = set()
        start = len(messages)
        for message in reversed(messages):
            turn = message.get("turn_id", message["local_id"])
            recent.add(turn)
            start = min(start, first_bubble[turn])
            if len(recent) >= maximum:
                break
        index = len(messages) - 1
        while index >= start:
            message = messages[index]
            start = min(start, first_bubble[message.get("turn_id", message["local_id"])])
            index -= 1
        return deepcopy(messages[start:])

    def _worker(self, group_id, runtime):
        try:
            while not self._closing.is_set():
                with self._store.lock(group_id):
                    group = self._store.get_group(group_id)
                    if group is None or not runtime.queue or group["state"]["status"] != "running":
                        runtime.worker = None
                        return
                    if group["state"]["reply_count"] >= group["max_replies"]:
                        runtime.queue.clear()
                        runtime.mentions.clear()
                        group = self._store.transaction(group_id, lambda data: data["state"].update(
                            status="quota_reached", active_persona_id=""))
                        self._state_event(group)
                        runtime.worker = None
                        return
                    persona_id = runtime.queue.popleft()
                    if persona_id in runtime.mentions:
                        runtime.mentions.remove(persona_id)
                    personas = self._app.config.load_personas()
                    if (persona_id not in personas
                            or not any(m["persona_id"] == persona_id for m in group["members"])):
                        group = self._store.transaction(group_id, lambda data: data["state"].update(
                            active_persona_id="", status="running" if runtime.queue else "idle",
                            error="群成员角色已不存在"))
                        self._state_event(group)
                        continue
                    job = _Generation(persona_id)
                    job.member_names = {
                        m["persona_id"]: (personas[m["persona_id"]].get("name", m["persona_id"])
                                          if isinstance(personas[m["persona_id"]], dict)
                                          else personas[m["persona_id"]].name)
                        for m in group["members"] if m["persona_id"] in personas
                    }
                    job.user_identity = load_profile_identity()
                    runtime.active = job
                    group = self._store.transaction(group_id, lambda data: data["state"].update(
                        active_persona_id=persona_id, status="running"))
                    history = self._history(group)
                    group["_media_root"] = str(self._store.group_dir(group_id).resolve())
                    # Match the same names shown to this generation even if
                    # a profile/persona is renamed while the model is working.
                    group["_mention_member_names"] = dict(job.member_names)
                    group["_user_identity"] = job.user_identity
                    memory_context = (self._memory.prepare_tool_context(
                        group_id, persona_id,
                        is_cancelled=lambda: self._closing.is_set() or job.cancelled.is_set())
                        if self._memory is not None else None)
                    self._state_event(group)
                try:
                    with tempfile.TemporaryDirectory(prefix="pawzo-group-") as temporary:
                        memory_args = {"memory_context": memory_context} if self._memory is not None else {}
                        drafts = self._app.chat_service.generate_group_reply(
                            persona_id, history, group=group, media_dir=Path(temporary),
                            is_cancelled=lambda: self._closing.is_set() or job.cancelled.is_set(), **memory_args)
                        if not self._closing.is_set() and not job.cancelled.is_set():
                            emoji_service = getattr(self._app, "emoji_service", None)
                            if emoji_service is not None:
                                original_drafts = drafts
                                try:
                                    composed = emoji_service.compose(persona_id, deepcopy(drafts))
                                    if not self._closing.is_set() and not job.cancelled.is_set():
                                        self._stage_emoji(composed, Path(temporary))
                                        drafts = composed
                                except Exception:
                                    # Emoji packs can be removed during generation.
                                    # Optional decoration must not discard the reply.
                                    logger.warning("Group emoji composition failed: %s", group_id, exc_info=True)
                                    drafts = original_drafts
                        if not isinstance(drafts, list) or not drafts:
                            if job.cancelled.is_set() or self._closing.is_set():
                                continue
                            raise ValueError("角色没有返回可展示的消息")
                        if not self._wait_for_delivery(job, drafts[0], job.started_at):
                            continue
                        with self._store.lock(group_id):
                            current = self._store.get_group(group_id)
                            if (current is None or runtime.active is not job or job.cancelled.is_set()
                                    or self._closing.is_set()):
                                continue
                            messages = self._complete(group_id, runtime, job, current, drafts, Path(temporary),
                                                      memory_context=memory_context)
                        self._deliver_remaining(group_id, runtime, job, messages, memory_context=memory_context)
                except Exception as exc:
                    logger.exception("Group reply failed: group=%s persona=%s", group_id, persona_id)
                    with self._store.lock(group_id):
                        current = self._store.get_group(group_id)
                        if current is not None and runtime.active is job and not job.cancelled.is_set():
                            runtime.active = None
                            def fail(data):
                                data.pop("_pending_reply", None)
                                data["state"].update(
                                    active_persona_id="", status="running" if runtime.queue else "idle",
                                    error=f"角色回复失败：{str(exc)[:300]}")
                            group = self._store.transaction(group_id, fail)
                            self._state_event(group)
        except Exception:
            logger.exception("Group scheduler stopped unexpectedly: %s", group_id)
            with self._store.lock(group_id):
                self._invalidate(runtime)
                group = self._store.get_group(group_id)
                if group is not None:
                    try:
                        group = self._store.transaction(group_id, lambda data: self._pause(
                            data, error="群聊调度失败，请重新发送消息"))
                        self._state_event(group)
                    except Exception:
                        logger.exception("Could not persist group failure state: %s", group_id)
        finally:
            with self._store.lock(group_id):
                if runtime.worker is threading.current_thread():
                    runtime.worker = None
                    # Intake may restart the group after error cleanup but
                    # before this thread exits. Hand that new queue off; the
                    # failed/cancelled generation itself is never retried.
                    group = self._store.get_group(group_id)
                    if group is not None and group["state"]["status"] == "running":
                        self._ensure_worker(group_id, runtime)

    def _complete(self, group_id, runtime, job, group, drafts, temporary, *, memory_context=None):
        if not isinstance(drafts, list) or not drafts:
            raise ValueError("角色没有返回可展示的消息")
        personas = self._app.config.load_personas()
        persona = personas.get(job.persona_id)
        if persona is None or not any(m["persona_id"] == job.persona_id for m in group["members"]):
            raise ValueError("角色已从群内移除")
        name = persona.get("name", job.persona_id) if isinstance(persona, dict) else persona.name
        timestamp = _now_iso()
        messages = []
        for draft in drafts:
            content = self._validate_content(draft.get("content") if isinstance(draft, dict) else None)
            messages.append({"local_id": uuid.uuid4().hex, "turn_id": job.token,
                             "role": "assistant", "source": "web", "persona_id": job.persona_id,
                             "speaker_id": job.persona_id,
                             "speaker_name": name, "timestamp": timestamp, "content": content})
        annotate_reply_mentions(messages, job.member_names, speaker_id=job.persona_id,
                                user_name=job.user_identity.display_name)
        next_count = group["state"]["reply_count"] + 1
        created = []
        try:
            created = self._commit_media(group_id, messages, temporary)
            def commit(data):
                # Persist the whole turn and its one budget charge atomically,
                # but expose only the due bubble to all history/list APIs.
                if self._memory is not None:
                    self._memory.number_message(data, messages[0])
                data["messages"].append(messages[0])
                data["_pending_reply"] = {"token": job.token, "messages": messages[1:]}
                data["state"].update(reply_count=next_count, active_persona_id=job.persona_id,
                                     error="", status="running")
                if self._memory is not None and len(messages) == 1:
                    self._memory.record_event(data, persona_id=job.persona_id, tool_context=memory_context)
            group = self._store.transaction(group_id, commit)
        except Exception:
            self._rollback_media(created)
            raise
        broadcast("group_message", group_id=group_id, message=messages[0], state=group["state"])
        return messages

    def _wait_for_delivery(self, job, message, since):
        """Wait outside the group lock; generation time counts toward typing."""
        if self._closing.is_set() or job.cancelled.is_set():
            return False
        delay = MessageSender.estimate_message_delay(
            message, self._app.config.get("reply", default={}))
        remaining = max(0.0, delay - (time.monotonic() - since))
        if remaining and job.cancelled.wait(remaining):
            return False
        return not self._closing.is_set() and not job.cancelled.is_set()

    def _deliver_remaining(self, group_id, runtime, job, messages, *, memory_context=None):
        since = time.monotonic()
        for index, message in enumerate(messages[1:], 1):
            if not self._wait_for_delivery(job, message, since):
                return
            with self._store.lock(group_id):
                group = self._store.get_group(group_id)
                if (group is None or runtime.active is not job or job.cancelled.is_set()
                        or self._closing.is_set()):
                    return
                if job.persona_id not in self._app.config.load_personas():
                    raise ValueError("角色已删除")
                def publish(data):
                    pending = data.get("_pending_reply", {})
                    if (pending.get("token") != job.token or not pending.get("messages")
                            or pending["messages"][0]["local_id"] != message["local_id"]):
                        raise RuntimeError("待发送的群消息已失效")
                    next_message = pending["messages"].pop(0)
                    next_message["timestamp"] = _now_iso()
                    if self._memory is not None:
                        self._memory.number_message(data, next_message)
                    # Append at delivery time so a user's interjection keeps
                    # the same order in SSE, pagination and reloaded history.
                    data["messages"].append(next_message)
                    if self._memory is not None and not pending["messages"]:
                        self._memory.record_event(data, persona_id=job.persona_id, tool_context=memory_context)
                group = self._store.transaction(group_id, publish)
                message = messages[index] = group["messages"][-1]
                broadcast("group_message", group_id=group_id, message=message, state=group["state"])
                since = time.monotonic()
        with self._store.lock(group_id):
            group = self._store.get_group(group_id)
            if (group is None or runtime.active is not job or job.cancelled.is_set()
                    or self._closing.is_set()):
                return
            # Intake may have replaced the queue and reset the cycle while
            # bubbles were being delivered. Use that latest state, not the
            # state captured when generation or delivery started.
            # Trigger mentions only after every bubble has been delivered.
            # Intake can replace the explicit queue while bubbles are sent;
            # preserve that user's priority and add each role target once.
            mentions = list(dict.fromkeys([
                *runtime.mentions, *(pid for message in messages for pid in message.get("mentions", []))]))
            if group["state"]["reply_count"] >= group["max_replies"]:
                queue, mentions = deque(), []
            else:
                queue = self._candidates(group, runtime.queue, speaker=job.persona_id, mentions=mentions)
            def finish(data):
                data.pop("_pending_reply", None)
                data["state"].update(active_persona_id="", error="",
                                     status="quota_reached" if data["state"]["reply_count"] >= data["max_replies"]
                                     else "running" if queue else "idle")
            group = self._store.transaction(group_id, finish)
            runtime.active = None
            runtime.queue = queue
            runtime.mentions = mentions
            broadcast("group_turn", group_id=group_id, messages=messages, state=group["state"])
            self._state_event(group)
            broadcast("group_updated", group_id=group_id, state=group["state"])
            if self._memory is not None:
                self._memory.drain_group(group_id)

    def _commit_media(self, group_id, messages, temporary):
        """Copy staged attachments under the lock; only JSON commit publishes them."""
        self._group(group_id)  # Never recreate a directory after group deletion.
        temporary = temporary.resolve() if temporary is not None else None
        created = []
        mapped = {}
        try:
            for message in messages:
                for block in message.get("content", []):
                    if not block.get("path"):
                        continue
                    source = Path(block["path"]).resolve()
                    try:
                        if temporary is None:
                            raise ValueError()
                        relative = source.relative_to(temporary)
                    except ValueError:
                        try:
                            source.relative_to(self._store.group_dir(group_id).resolve())
                        except ValueError:
                            raise ValueError("附件不属于当前群聊") from None
                        if not source.is_file():
                            raise ValueError("群附件不存在")
                        continue  # Existing media from this group is durable.
                    if len(relative.parts) != 2 or relative.parts[0] not in {"images", "files", "voice"}:
                        raise ValueError("无效的群附件路径")
                    if source not in mapped:
                        if not source.is_file():
                            raise ValueError("群附件不存在")
                        target_dir = self._store.media_dir(group_id, relative.parts[0])
                        target = target_dir / f"{uuid.uuid4().hex}{source.suffix}"
                        created.append(target)
                        shutil.copyfile(source, target)
                        mapped[source] = target
                    block["path"] = str(mapped[source])
                    if block.get("type") == "emoji":
                        block["url"] = f"/api/groups/{group_id}/media/images/{mapped[source].name}"
            return created
        except Exception:
            self._rollback_media(created)
            raise

    def _validate_quote_media(self, group_id, media):
        if not isinstance(media, list) or any(not isinstance(block, dict) for block in media):
            raise ValueError("引用附件格式无效")
        for block in media:
            if not block.get("path"):
                continue
            try:
                Path(block["path"]).resolve().relative_to(self._store.group_dir(group_id).resolve())
            except (ValueError, TypeError):
                raise ValueError("引用附件不属于当前群聊") from None

    @staticmethod
    def _stage_emoji(drafts, temporary):
        for draft in drafts or []:
            for block in draft.get("content", []):
                if block.get("type") != "emoji" or not block.get("path"):
                    continue
                source = Path(block["path"]).resolve()
                try:
                    source.relative_to(EMOJI_DIR.resolve())
                except ValueError:
                    continue
                target = temporary / "images" / f"{uuid.uuid4().hex}{source.suffix}"
                target.parent.mkdir(exist_ok=True)
                shutil.copyfile(source, target)
                block["path"] = str(target)

    @staticmethod
    def _rollback_media(paths):
        for path in paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not clean uncommitted group media: %s", path)

    @staticmethod
    def _state_event(group):
        broadcast("group_state", group_id=group["group_id"], state=group["state"])

    def _history_change(self, group_id, change, *, clear=False):
        with self._store.lock(group_id):
            self._group(group_id)
            if self._memory is not None:
                if not self._memory.drain_group(group_id, schedule=False):
                    raise OSError("群记忆尚未保存，请稍后重试修改历史")
            def mutate(data):
                change(data)
                self._pause(data)
                data["_memory_revision"] = data.get("_memory_revision", 0) + 1
            group = self._store.transaction(group_id, mutate, structural=True)
            self._invalidate(self._runtime(group_id))
            if self._memory is not None:
                self._memory.history_changed(group_id, clear=clear)
            self._state_event(group)
            broadcast("group_updated", group_id=group_id, state=group["state"], history_changed=True)
            return group

    def clear_messages(self, group_id: str) -> bool:
        self._history_change(group_id, lambda data: data.update(messages=[]), clear=True)
        return True

    def edit_message(self, group_id: str, message_id: str, text: str, *,
                     quote: str | None = None, expected_fingerprint: str = "") -> dict:
        if not isinstance(text, str) or (quote is not None and not isinstance(quote, str)):
            raise ValueError("消息文字格式无效")
        def edit(data):
            message = next((m for m in data["messages"] if m["local_id"] == message_id), None)
            if message is None:
                raise KeyError(message_id)
            if expected_fingerprint and _message_fingerprint(message) != expected_fingerprint:
                raise StaleMessageCursor("Message changed; reload messages")
            block = next((b for b in message["content"] if b.get("type") == "text"), None)
            if block is None:
                if text:
                    message["content"].insert(0, {"type": "text", "text": text})
            else:
                block["text"] = text
            if quote is not None:
                message.pop("quote_media", None)
                message.pop("reply_to_message_id", None)
                if quote:
                    message["quote"] = quote
                else:
                    message.pop("quote", None)
        group = self._history_change(group_id, edit)
        return next(m for m in group["messages"] if m["local_id"] == message_id)

    def delete_message(self, group_id: str, message_id: str, *, expected_fingerprint: str = "") -> bool:
        def delete(data):
            message = next((m for m in data["messages"] if m["local_id"] == message_id), None)
            if message is None:
                raise KeyError(message_id)
            if expected_fingerprint and _message_fingerprint(message) != expected_fingerprint:
                raise StaleMessageCursor("Message changed; reload messages")
            data["messages"] = [m for m in data["messages"] if m["local_id"] != message_id]
        self._history_change(group_id, delete)
        return True

    def shutdown(self):
        self._closing.set()
        if self._memory is not None:
            self._memory.shutdown()
        with self._runtime_lock:
            ids = list(self._runtimes)
        for group_id in ids:
            with self._store.lock(group_id):
                runtime = self._runtime(group_id)
                self._invalidate(runtime)
                group = self._store.get_group(group_id)
                if group is not None and group["state"]["status"] == "running":
                    try:
                        group = self._store.transaction(group_id, self._pause)
                    except OSError:
                        logger.exception("Could not persist stopped group during shutdown: %s", group_id)
                        continue
                    self._state_event(group)
