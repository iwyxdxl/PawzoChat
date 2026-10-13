# PawzoChat - Human-like, versatile, extensible AI companion engine
# Copyright (C) 2026 iwyxdxl
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Local plugin downloads and recoverable, serialized directory transactions.

Network workers never execute plugin code. The manager lock is acquired before
any task lock when claiming work; progress/cancellation only need the task lock.
The journal lives outside both directories being renamed, and startup recovery
runs before discovery can import a plugin.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import math
import os
import secrets
import shutil
import stat
import threading
import time
import unicodedata
import uuid
import zipfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import yaml
import requests
from urllib3.exceptions import HTTPError as UrllibHTTPError

from pawzochat.paths import PLUGIN_BACKUP_DIR, PLUGIN_STAGING_DIR
from .source import PluginError, fetch_release, open_http_stream, parse_version, validate_plugin_id, validate_url
from .manager import PluginBusyError
from .platforms import supports_platform

logger = logging.getLogger(__name__)
_TERMINAL = {"succeeded", "error", "cancelled", "expired"}
_FINISHED_STAGES = {"committed", "rolled_back"}
_STAGES = {"preparing", "prepared", "old_moved", "published", "restoring", "recovery_required"} | _FINISHED_STAGES
_TTL = 30 * 60
_RETENTION = 24 * 60 * 60
_CHUNK = 64 * 1024


def _now():
    return datetime.now(timezone.utc).isoformat()


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _uuid(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError
    except (ValueError, AttributeError):
        raise PluginError("bad_field", "任务 ID 必须是规范 UUID") from None
    return value


def _sync_dir(path):
    # Windows doesn't support opening/fsyncing directories. File fsync remains
    # mandatory; POSIX rename durability also includes both parent directories.
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    _sync_dir(path.parent)


def _write_json(path, data):
    _atomic_write(path, json.dumps(data, ensure_ascii=False, indent=2))


class PluginInstaller:
    def __init__(self, manager, config_manager, *, staging_dir=None, backup_dir=None):
        self.manager = manager
        self.config = config_manager
        self.staging = Path(staging_dir) if staging_dir is not None else PLUGIN_STAGING_DIR
        self.backups = Path(backup_dir) if backup_dir is not None else PLUGIN_BACKUP_DIR
        self._task_lock = threading.RLock()
        self._tasks = {}
        self._stale_staging = set()
        self._cache = {}
        self._uninstall_epochs = {}
        self._stop = threading.Event()
        self._recovery_required = False
        self._checker = None
        self._maintenance = None

    def configure(self):
        options = self.config.get("plugins", default={})
        if not isinstance(options, dict):
            raise ValueError("plugins 配置必须是对象")
        def setting(name, default, positive=False):
            value = options.get(name, default)
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or not math.isfinite(value) or value < 0 or (positive and value == 0)):
                raise ValueError(f"plugins.{name} 必须是{'正数' if positive else '非负数'}")
            return value
        self.max_download = int(setting("max_download_mb", 500) * 1024 * 1024)
        self.max_unzipped = int(setting("max_unzipped_mb", 2048) * 1024 * 1024)
        self.download_timeout = setting("download_timeout_seconds", 600, True)
        for path in (self.staging, self.backups, self.manager._plugins_root):
            path.mkdir(parents=True, exist_ok=True)
        self.staging = self.staging.resolve()
        self.backups = self.backups.resolve()
        self._root = self.manager._plugins_root.resolve()
        if len({p.stat().st_dev for p in (self.staging, self.backups, self._root)}) != 1:
            raise ValueError("插件目录、暂存和备份必须位于同一文件系统")

    def _accepting(self):
        if self._stop.is_set():
            raise PluginError("service_stopping", "服务正在停止，请稍后重试", 503)
        if self._recovery_required:
            raise PluginError("recovery_required", "插件事务需要恢复，请查看日志并重启服务", 500)

    @staticmethod
    def _contained(path, parent):
        if path.is_symlink():
            raise PluginError("recovery_required", "插件管理路径不允许符号链接", 500)
        try:
            path.resolve().relative_to(parent.resolve())
        except (ValueError, OSError, RuntimeError):
            raise PluginError("recovery_required", "插件管理路径越界", 500) from None
        return path

    def _task_dir(self, task_id):
        return self._contained(self.staging / _uuid(task_id), self.staging)

    def _tx_dir(self, plugin_id, task_id):
        base = self._contained(self.backups / validate_plugin_id(plugin_id), self.backups)
        return self._contained(base / _uuid(task_id), base)

    def _live(self, name):
        if not isinstance(name, str) or name in {"", ".", ".."} or "/" in name or "\\" in name:
            raise PluginError("recovery_required", "事务中的插件目录无效", 500)
        return self._contained(self._root / name, self._root)

    def _emit(self, task, force=False):
        now = time.monotonic()
        if not force and now - task.get("_emitted", 0) < .2:
            return
        task["_emitted"] = now
        try:
            from pawzochat.web.sse import broadcast
            fields = {k: copy.deepcopy(task.get(k)) for k in (
                "task_id", "plugin_id", "status", "phase", "progress", "received_bytes", "message", "error", "cancel_requested")}
            broadcast("plugin_task_progress", **fields)
        except Exception:
            logger.debug("Plugin task notification failed", exc_info=True)

    def _progress(self, task, **values):
        with self._task_lock:
            changed = any(task.get(k) != values.get(k, task.get(k)) for k in ("status", "phase"))
            task.update(values)
            if task.get("_request"):
                task["operation"] = task["_request"]["operation"]
            if task["status"] in _TERMINAL:
                # Retain only status, retry context and the idempotent response;
                # completed previews no longer need their potentially large
                # manifest/release data or a live trust challenge.
                source_url = task.get("source", {}).get("source_url")
                if source_url:
                    task["source"] = {"source_url": source_url}
                else:
                    task.pop("source", None)
                for key in ("_release", "_baseline", "_tree_digest", "_trust", "_expires", "expires_at", "_uninstall_epochs",
                            "manifest", "conflict", "compatible", "app_compatible", "platform_compatible"):
                    task.pop(key, None)
            task["updated_at"] = _now()
            self._emit(task, changed)

    def _new_task(self, task_id=None):
        task = {"task_id": task_id or str(uuid.uuid4()), "status": "queued", "phase": "fetch_index",
                "progress": None, "received_bytes": 0, "message": "正在准备…", "error": None,
                "result": None, "created_at": _now(), "cancel_requested": False,
                "_cancel": threading.Event()}
        self._tasks[task["task_id"]] = task
        return task

    def start_preview(self, source_url):
        self._accepting()
        validate_url(source_url)
        self._expire_tasks()
        with self._task_lock:
            self._accepting()
            if sum(t["status"] in {"queued", "running", "ready"} for t in self._tasks.values()) >= 8:
                raise PluginError("task_conflict", "预览任务过多，请先取消或完成已有任务", 409)
            task = self._new_task()
            task["source"] = {"source_url": source_url}
            task["_uninstall_epochs"] = self._uninstall_epochs.copy()
        threading.Thread(target=self._run_preview, args=(task, source_url), daemon=True,
                         name=f"plugin-preview-{task['task_id'][:8]}").start()
        return {"task_id": task["task_id"], "status": "queued"}

    @staticmethod
    def _check_cancel(task):
        if task["_cancel"].is_set():
            raise PluginError("cancelled", "下载已取消", 409)

    def _run_preview(self, task, url):
        directory = self._task_dir(task["task_id"])
        try:
            self._check_cancel(task)
            directory.mkdir()
            self._progress(task, status="running", phase="fetch_index", message="正在读取插件索引…")
            release = fetch_release(url, cancel_event=task["_cancel"])
            self._check_platform(release=release)
            self._progress(task, plugin_id=release.id, phase="download", message="正在下载插件…")
            archive = directory / "archive.zip"
            self._download(task, release.download_url, archive)
            self._progress(task, phase="verify", progress=None, message="正在校验安装包…")
            digest = hashlib.sha256()
            with archive.open("rb") as stream:
                for chunk in iter(lambda: stream.read(_CHUNK), b""):
                    self._check_cancel(task)
                    digest.update(chunk)
            if digest.hexdigest() != release.sha256.lower():
                raise PluginError("checksum_mismatch", "安装包 SHA-256 校验失败")
            self._progress(task, phase="extract", message="正在安全解压…")
            payload = self._extract(task, archive, directory)
            manifest = self._validate_manifest(payload, release)
            self._check_platform(manifest=manifest)
            # Host-owned files are never trusted, including Python bytecode.
            for name in ("config.yaml", ".install.json", "state"):
                self._remove(payload / name)
            tree_digest = self._tree_digest(payload, task)
            with self.manager._lock:
                if task.get("_uninstall_epochs", {}).get(release.id, 0) != self._uninstall_epochs.get(release.id, 0):
                    raise PluginError("stale_preview", "插件已被卸载，请重新获取插件", 409)
                baseline = self._snapshot(release.id)
                conflict = None if baseline is None else {
                    "plugin_id": release.id, "installed_version": baseline["version"],
                    "source_type": "online" if baseline["source"].get("source_url") else "local",
                    "source_changed": baseline["source"].get("source_url") != url}
                with self._task_lock:
                    self._check_cancel(task)
                    task.update(_release=release, _baseline=baseline, _tree_digest=tree_digest,
                                manifest=asdict(manifest), source=release.to_dict(), conflict=conflict,
                                compatible=release.compatible, app_compatible=release.app_compatible,
                                platform_compatible=True, _expires=time.time() + _TTL)
                    task["expires_at"] = datetime.fromtimestamp(task["_expires"], timezone.utc).isoformat()
                    self._progress(task, status="ready", phase="ready", progress=1, message="预览已就绪")
        except Exception as exc:
            error = self._error(exc)
            cancelled = task["_cancel"].is_set() or error.code == "cancelled"
            self._progress(task, status="cancelled" if cancelled else "error", phase="cancelled" if cancelled else "error",
                           message="已取消" if cancelled else error.message,
                           error=None if cancelled else {"code": error.code, "message": error.message},
                           _http_status=error.status, _response=error.to_dict(), _finished=time.time())
            self._cleanup_task_files(task)

    def _download(self, task, url, target):
        deadline = time.monotonic() + self.download_timeout
        response = open_http_stream(url, timeout=(min(5, self.download_timeout), min(30, self.download_timeout)),
                                    cancel_event=task["_cancel"], deadline=deadline)
        try:
            try:
                total = int(response.headers.get("Content-Length", "0")) or None
            except ValueError:
                total = None
            received = 0
            with target.open("xb") as stream:
                while True:
                    self._check_cancel(task)
                    if time.monotonic() >= deadline:
                        raise PluginError("bad_response", "下载超过总时间限制", 502)
                    chunk = response.raw.read1(_CHUNK, decode_content=True)
                    if not chunk:
                        break
                    received += len(chunk)
                    if self.max_download and received > self.max_download:
                        raise PluginError("download_too_large", "安装包超过下载大小限制")
                    stream.write(chunk)
                    self._progress(task, received_bytes=received,
                                   progress=min(received / total, 1) if total and total > 0 else None)
                if time.monotonic() >= deadline:
                    raise PluginError("bad_response", "下载超过总时间限制", 502)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            response.close()

    def _extract(self, task, archive, directory):
        extracted = directory / "extracted"
        extracted.mkdir()
        actual = 0
        with zipfile.ZipFile(archive) as package:
            members = package.infolist()
            if not members or len(members) > 20000:
                raise PluginError("unsafe_archive", "安装包为空或文件数量过多")
            seen = set()
            for item in members:
                self._check_cancel(task)
                name = item.filename
                device_names = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
                parts = PurePosixPath(name).parts
                mode = item.external_attr >> 16
                if (not name or name != item.orig_filename or "\\" in name or "\0" in name or name.startswith("/")
                        or not parts or any(p in {".", ".."} or ":" in p or p.endswith((".", " ")) for p in parts)
                        or any(p.split(".")[0].casefold() in device_names for p in parts)
                        or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR})):
                    raise PluginError("unsafe_archive", "安装包包含不安全的文件路径或类型")
                # Also reject collisions on case-insensitive and Unicode-normalizing filesystems.
                key = unicodedata.normalize("NFC", "/".join(parts)).casefold()
                if key in seen:
                    raise PluginError("unsafe_archive", "安装包包含重复文件路径")
                seen.add(key)
                target = self._contained(extracted.joinpath(*parts), extracted)
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if item.flag_bits & 1:
                    raise PluginError("unsafe_archive", "不支持加密安装包")
                if item.file_size > max(item.compress_size, 1) * 200:
                    raise PluginError("unsafe_archive", "安装包压缩比超过限制")
                target.parent.mkdir(parents=True, exist_ok=True)
                member_bytes = 0
                with package.open(item) as src, target.open("xb") as dst:
                    while True:
                        self._check_cancel(task)
                        chunk = src.read(_CHUNK)
                        if not chunk:
                            break
                        actual += len(chunk)
                        member_bytes += len(chunk)
                        if ((self.max_unzipped and actual > self.max_unzipped)
                                or actual > max(archive.stat().st_size, 1) * 200
                                or member_bytes > max(item.compress_size, 1) * 200):
                            raise PluginError("unsafe_archive", "解压大小或压缩比超过限制")
                        dst.write(chunk)
                if os.name != "nt" and item.create_system == 3:
                    # Keep bundled helpers executable, without trusting archive
                    # ownership, write permissions, or setuid/setgid/sticky bits.
                    target.chmod(stat.S_IMODE(target.stat().st_mode) | (mode & 0o111))
            candidates = []
            if (extracted / "plugin.yaml").is_file():
                candidates.append(extracted)
            children = list(extracted.iterdir())
            candidates.extend(p for p in children if p.is_dir() and (p / "plugin.yaml").is_file())
            if len(candidates) != 1 or (candidates[0] != extracted and (len(children) != 1)):
                raise PluginError("unsafe_archive", "plugin.yaml 必须在根目录或唯一顶层目录中")
            payload = directory / "payload"
            self._rename(candidates[0], payload)
            if extracted.exists():
                self._remove(extracted)
            for path in list(payload.rglob("*")):
                if path.name == "__pycache__" or path.suffix in {".pyc", ".pyo"}:
                    self._remove(path)
            return payload

    def _validate_manifest(self, payload, release=None):
        try:
            manifest_path = self._contained(payload / "plugin.yaml", payload)
            if manifest_path.stat().st_size > 1024 * 1024:
                raise PluginError("bad_field", "插件清单超过 1 MB")
            manifest = self.manager._load_manifest(manifest_path)
            parse_version(manifest.version)
        except Exception as exc:
            logger.debug("Invalid plugin manifest: %s", payload, exc_info=True)
            raise PluginError("bad_field", "插件清单无效，请检查字段、SemVer 版本和 api_version") from exc
        if release:
            if manifest.id != release.id:
                raise PluginError("id_mismatch", "插件清单 ID 与索引不一致")
            if manifest.version != release.version:
                raise PluginError("version_mismatch", "插件清单版本与索引不一致")
        return manifest

    @staticmethod
    def _check_platform(*, release=None, manifest=None):
        # Keep execution eligibility separate from identity validation: an
        # existing plugin from another system must remain readable for recovery.
        if ((release is not None and not release.platform_compatible)
                or (manifest is not None and not supports_platform(manifest.platforms))):
            raise PluginError("platform_unsupported", "此插件不支持当前系统", 409)

    @staticmethod
    def _tree_digest(root, task=None):
        digest = hashlib.sha256()
        for path in sorted(root.rglob("*")):
            if task:
                PluginInstaller._check_cancel(task)
            info = path.lstat()
            is_file = stat.S_ISREG(info.st_mode)
            if not is_file and not stat.S_ISDIR(info.st_mode):
                raise PluginError("unsafe_archive", "候选目录包含不安全的文件类型")
            name = path.relative_to(root).as_posix().encode()
            # Explicit boundaries prevent file contents from masquerading as
            # another entry; permission changes must also invalidate a preview.
            digest.update(len(name).to_bytes(8, "big"))
            digest.update(name)
            digest.update(b"f" if is_file else b"d")
            digest.update(bytes([info.st_mode & 0o111 if os.name != "nt" else 0]))
            if is_file:
                digest.update(info.st_size.to_bytes(8, "big"))
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(_CHUNK), b""):
                        if task:
                            PluginInstaller._check_cancel(task)
                        digest.update(chunk)
        return digest.hexdigest()

    def _read_source(self, root):
        path = root / ".install.json"
        if not path.exists():
            return {}
        self._contained(path, root)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("not an object")
            _uuid(data.get("installation_generation"))
            if data.get("source_url"):
                validate_url(data["source_url"])
            return data
        except Exception as exc:
            raise PluginError("bad_field", "插件来源记录损坏，请检查 .install.json") from exc

    def _identity(self, root):
        if not root.exists():
            return None
        self._contained(root / "plugin.yaml", root)
        manifest = self._validate_manifest(root)
        source = self._read_source(root)
        record = root / ".install.json"
        return {"id": manifest.id, "version": manifest.version,
                "manifest_digest": hashlib.sha256((root / "plugin.yaml").read_bytes()).hexdigest(),
                "source_digest": hashlib.sha256(record.read_bytes()).hexdigest() if record.exists() else None,
                "generation": source.get("installation_generation"), "source": source}

    def _snapshot(self, plugin_id):
        # Scan identity as well as registered runtimes: a malformed config must
        # never make an existing on-disk ID look safe to overwrite.
        roots = []
        for candidate in self._root.iterdir():
            if candidate.is_dir() and (candidate / "plugin.yaml").is_file():
                try:
                    manifest = self.manager._load_manifest(candidate / "plugin.yaml")
                except Exception:
                    continue
                if manifest.id == plugin_id:
                    roots.append(self._live(candidate.name))
        if len(roots) > 1:
            raise PluginError("conflict", "存在重复插件 ID，请先处理本地目录", 409)
        if not roots:
            return None
        identity = self._identity(roots[0])
        return {**identity, "live_name": roots[0].name}

    def get_task(self, task_id):
        _uuid(task_id)
        self._expire_tasks()
        with self._task_lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise PluginError("not_found", "任务不存在或已失效", 404)
            return copy.deepcopy({k: v for k, v in task.items() if not k.startswith("_")})

    def cancel(self, task_id):
        _uuid(task_id)
        with self._task_lock:
            task = self._tasks.get(task_id)
            if task is None or task["status"] in _TERMINAL:
                return {"ok": True, "task_id": task_id}, 200
            if task["status"] == "committing":
                raise PluginError("task_conflict", "正在提交，无法取消", 409)
            task["_cancel"].set()
            if task["status"] == "ready":
                self._progress(task, status="cancelled", phase="cancelled", message="已取消", _finished=time.time())
                self._cleanup_task_files(task)
                return {"ok": True, "task_id": task_id, "status": "cancelled"}, 200
            self._progress(task, cancel_requested=True, message="正在取消…")
            return {"task_id": task_id, "cancel_requested": True}, 202

    def _expire_tasks(self):
        with self._task_lock:
            now = time.time()
            for task_id, task in list(self._tasks.items()):
                if task["status"] == "ready" and now >= task["_expires"]:
                    task["_cancel"].set()
                    self._progress(task, status="expired", phase="expired", message="预览已过期，请重新预览", _finished=now)
                if task["status"] in _TERMINAL:
                    # A transient file lock must not leave downloads behind
                    # forever, nor discard the only record that can retry it.
                    if not task.get("_files_cleaned"):
                        self._cleanup_task_files(task)
                    if task.get("_files_cleaned") and now - task.get("_finished", now) > _RETENTION:
                        self._tasks.pop(task_id, None)
            self._cleanup_stale_staging()

    def _existing(self, task_id, request):
        task = self._tasks.get(task_id)
        if task is None:
            raise PluginError("not_found", "任务不存在或已失效", 404)
        if task.get("_request") is not None:
            if task["_request"] != request:
                raise PluginError("task_conflict", "该任务已被其他操作使用", 409)
            if task["status"] == "committing":
                return task, ({"task_id": task_id, "status": "committing"}, 202)
            if task.get("_response") is not None:
                return task, (copy.deepcopy(task["_response"]), task["_http_status"])
        if task["status"] == "expired" or (task["status"] == "ready" and time.time() >= task["_expires"]):
            raise PluginError("task_expired", "预览已过期，请重新预览", 410)
        if task["status"] != "ready":
            raise PluginError("task_not_ready", "任务未就绪或已结束", 409)
        return task, None

    def install_confirm(self, task_id):
        return self._confirm(_uuid(task_id), "install")

    def upgrade(self, plugin_id, task_id, *, trust_token=None):
        return self._confirm(_uuid(task_id), "upgrade", validate_plugin_id(plugin_id), trust_token)

    def _uninstall_identity(self, root):
        """Identify the directory without trusting installation metadata."""
        if not root.exists():
            return None
        self._contained(root, root.parent)
        manifest = self._contained(root / "plugin.yaml", root)
        info = root.stat()
        return {"device": info.st_dev, "inode": info.st_ino,
                "manifest_digest": hashlib.sha256(manifest.read_bytes()).hexdigest()}

    def _uninstall_target(self, plugin_id):
        root = self.manager.get_plugin_root(plugin_id)
        if root is None:
            raise PluginError("not_found", "插件不存在", 404)
        live = self._live(root.name)
        self._contained(root, self._root)
        if root.resolve() != live.resolve() or not live.is_dir():
            raise PluginError("conflict", "插件目录已变化，请刷新后重试", 409)
        matches = []
        # Loaded plugins still depend on their original manifests if files
        # have changed on disk. Also check undiscovered/invalid-config plugins.
        dependents = {p["id"]: {"id": p["id"], "name": p["name"]}
                      for p in self.manager.list_plugins()
                      if p["id"] != plugin_id and plugin_id in p["depends_on"]}
        for candidate in self._root.iterdir():
            if not candidate.is_dir() or not (candidate / "plugin.yaml").is_file():
                continue
            try:
                manifest = self.manager._load_manifest(candidate / "plugin.yaml")
            except Exception:
                continue
            if manifest.id == plugin_id:
                matches.append(candidate)
            elif plugin_id in manifest.depends_on:
                dependents[manifest.id] = {"id": manifest.id, "name": manifest.name}
        if matches != [live]:
            raise PluginError("conflict", "插件目录或 ID 存在歧义，请检查本地目录", 409)
        if dependents:
            raise PluginError("plugin_in_use", "请先卸载依赖此插件的其他插件", 409,
                              dependents=[dependents[pid] for pid in sorted(dependents)])
        return live

    def uninstall(self, plugin_id):
        validate_plugin_id(plugin_id)
        with self.manager._lock:
            self._accepting()
            live = self._uninstall_target(plugin_id)
            # Share the install/upgrade barrier and lock ordering. No directory
            # is moved until teardown has completed successfully.
            with self.manager.transaction():
                return self._uninstall_locked(plugin_id, live)

    def _uninstall_locked(self, plugin_id, live):
        txid = str(uuid.uuid4())
        txdir = self._tx_dir(plugin_id, txid)
        previous = self._summary(plugin_id)
        journal = {"schema": 1, "operation": "uninstall", "task_id": txid,
                   "request": {"operation": "uninstall", "plugin_id": plugin_id},
                   "plugin_id": plugin_id, "live_name": live.name, "stage": "preparing",
                   "old_identity": self._uninstall_identity(live), "created_at": _now()}
        unloaded = False
        try:
            txdir.mkdir(parents=True, exist_ok=False)
            self._save_journal(journal)
            self.manager.unload_plugin(plugin_id, root_dir=live)
            unloaded = True
            self._rename(live, txdir / "old")
            self._save_journal(journal, "old_moved")
            journal.update(response={"ok": True}, http_status=200, finished_epoch=time.time())
            self._save_journal(journal, "committed")
        except Exception:
            # An atomic journal write can succeed before fsync raises. A
            # durable commit is final, including during startup recovery.
            persisted = None
            try:
                path = txdir / "transaction.json"
                if path.exists():
                    persisted = json.loads(path.read_text(encoding="utf-8"))
                committed = bool(persisted and persisted.get("stage") == "committed"
                                 and persisted.get("task_id") == txid
                                 and persisted.get("operation") == "uninstall")
                if not committed and persisted:
                    self._restore_uninstall_files(journal)
                    if unloaded:
                        self.manager.refresh()
                        restored = self._summary(plugin_id)
                        if restored is None or any(restored[key] != previous[key]
                                                   for key in ("version", "enabled", "status")):
                            raise RuntimeError("卸载失败后未能恢复插件运行状态")
                    journal.update(response={"error": "operation_failed", "message": "卸载未完成"},
                                   http_status=500, finished_epoch=time.time())
                    self._save_journal(journal, "rolled_back")
            except Exception as recovery_error:
                logger.exception("Plugin uninstall recovery failed: %s at %s", plugin_id, txdir)
                self._block_recovery()
                raise PluginError("recovery_required", "卸载恢复未完成，请重启服务后重试", 500) from recovery_error
            if not committed:
                self._cleanup_finished_transactions(plugin_id)
                raise
        self._invalidate(plugin_id)
        with self._task_lock:
            self._uninstall_epochs[plugin_id] = self._uninstall_epochs.get(plugin_id, 0) + 1
            for task in self._tasks.values():
                if task.get("plugin_id") != plugin_id or task["status"] in _TERMINAL:
                    continue
                task["_cancel"].set()
                if task["status"] == "ready":
                    error = PluginError("stale_preview", "插件已被卸载，请重新获取插件", 409)
                    self._finish(task, error.to_dict(), error.status)
                    self._cleanup_task_files(task)
        self._cleanup_finished_transactions(plugin_id)
        return {"ok": True}

    def _restore_uninstall_files(self, journal):
        live = self._live(journal["live_name"])
        txdir = self._tx_dir(journal["plugin_id"], journal["task_id"])
        old = self._contained(txdir / "old", txdir)
        identity = journal["old_identity"]
        if live.exists():
            if old.exists() or self._uninstall_identity(live) != identity:
                raise RuntimeError("卸载恢复目录身份不一致")
        elif self._uninstall_identity(old) == identity:
            self._rename(old, live)
        else:
            raise RuntimeError("缺少卸载前的插件目录")

    def _confirm(self, task_id, operation, plugin_id=None, trust_token=None):
        request = {"operation": operation, "plugin_id": plugin_id,
                   "trust_digest": _digest(trust_token) if trust_token is not None else None}
        with self._task_lock:
            _, existing = self._existing(task_id, request)
            if existing:
                return existing
        with self.manager._lock:
            self._accepting()
            with self._task_lock:
                task, existing = self._existing(task_id, request)
                if existing:
                    return existing
                self._check_cancel(task)
                release = task["_release"]
                self._check_platform(release=release)
                if not release.app_compatible:
                    raise PluginError("incompatible", f"需要 PawzoChat {release.min_app_version} 或更新版本", 409)
                if plugin_id and release.id != plugin_id:
                    raise PluginError("id_mismatch", "任务不属于该插件")
                plugin_id = release.id
                baseline = self._snapshot(plugin_id)
                if baseline != task["_baseline"]:
                    task.pop("_trust", None)
                    raise PluginError("stale_preview", "插件已发生变化，请重新预览", 409)
                if operation == "install":
                    if baseline or self._live(plugin_id).exists():
                        raise PluginError("conflict", "插件已存在，请使用升级操作", 409)
                    live = self._live(plugin_id)
                else:
                    if baseline is None:
                        raise PluginError("stale_preview", "插件已被移除，请重新预览", 409)
                    if parse_version(release.version) <= parse_version(baseline["version"]):
                        raise PluginError("conflict", "升级版本必须高于当前版本", 409)
                    self._check_trust(task, baseline, release, trust_token)
                    live = self._live(baseline["live_name"])
                payload = self._task_dir(task_id) / "payload"
                self._contained(payload, self._task_dir(task_id))
                manifest = self._validate_manifest(payload, release)
                self._check_platform(manifest=manifest)
                if self._tree_digest(payload, task) != task["_tree_digest"]:
                    raise PluginError("checksum_mismatch", "预览文件已变化，请重新预览")
                task["_request"] = request
                self._progress(task, status="committing", phase="prepare", progress=None, message="正在准备安装…")
            return self._commit(task, operation, plugin_id, live, payload, manifest, baseline, release=release)

    def _check_trust(self, task, baseline, release, token):
        old = baseline["source"].get("public_key")
        new = release.public_key or None
        if not old or old == new:
            if token is not None:
                raise PluginError("invalid_trust_token", "本次任务不需要此信任凭据", 409)
            return
        binding = _digest([baseline, release.to_dict()])
        challenge = task.get("_trust")
        if token is not None:
            if not challenge or binding != challenge["binding"] or not secrets.compare_digest(token, challenge["token"]):
                raise PluginError("invalid_trust_token", "信任确认已失效，请重新预览", 409)
            return
        if not challenge or challenge["binding"] != binding:
            challenge = {"token": secrets.token_urlsafe(32), "binding": binding}
            task["_trust"] = challenge
        raise PluginError("pubkey_changed" if new else "signature_missing",
                          "插件作者公钥变更，请确认是否信任" if new else "新版本不再提供签名，请确认是否继续",
                          409, task_id=task["task_id"], old_pubkey=old, new_pubkey=new, trust_token=challenge["token"])

    @staticmethod
    def _error(exc):
        if isinstance(exc, PluginError):
            return exc
        if isinstance(exc, PluginBusyError):
            return PluginError("plugin_busy", "插件仍有执行中的调用，请稍后重新预览并重试", 409)
        if isinstance(exc, (requests.RequestException, UrllibHTTPError)):
            return PluginError("bad_response", "读取插件安装包失败或超时", 502)
        if isinstance(exc, (zipfile.BadZipFile, NotImplementedError)):
            return PluginError("unsafe_archive", "安装包不是受支持的 ZIP 文件")
        logger.warning("Plugin operation failed: %s", exc, exc_info=True)
        return PluginError("operation_failed", "插件操作失败，请查看服务日志", 500)

    def _save_journal(self, journal, stage=None):
        pending = copy.deepcopy(journal)
        if stage:
            pending["stage"] = stage
        pending["updated_at"] = _now()
        _write_json(self._tx_dir(journal["plugin_id"], journal["task_id"]) / "transaction.json", pending)
        # Do not let a failed write make the in-memory transaction look
        # committed. Recovery also inspects disk after ambiguous replace errors.
        journal.clear()
        journal.update(pending)

    @staticmethod
    def _remove(path):
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path)

    @staticmethod
    def _rename(source, destination):
        if destination.exists() or destination.is_symlink():
            raise PluginError("conflict", "目标目录已存在，拒绝覆盖", 409)
        for attempt in range(3):
            try:
                source.rename(destination)
                _sync_dir(source.parent)
                if source.parent != destination.parent:
                    _sync_dir(destination.parent)
                return
            except PermissionError:
                if os.name != "nt" or attempt == 2:
                    raise
                time.sleep(1)

    def _copy(self, source, destination):
        if source.is_symlink() or any(p.is_symlink() for p in source.rglob("*")):
            raise PluginError("unsafe_archive", "配置或状态含符号链接，无法安全复制")
        if source.is_dir():
            shutil.copytree(source, destination)
        else:
            shutil.copy2(source, destination)

    @staticmethod
    def _sync_tree(root):
        for path in root.rglob("*"):
            if path.is_file():
                with path.open("rb") as stream:
                    os.fsync(stream.fileno())
        for path in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            _sync_dir(path)
        _sync_dir(root)

    def _prepare_candidate(self, payload, manifest, live, baseline, generation, release):
        for name in ("config.yaml", "state", ".install.json"):
            self._remove(payload / name)
        if baseline:
            if (live / "config.yaml").exists():
                self._copy(live / "config.yaml", payload / "config.yaml")
            if (live / "state").exists():
                self._copy(live / "state", payload / "state")
            config = self.manager._load_plugin_config(payload / "config.yaml")
        else:
            config = {"enabled": False, "settings": {}}
        try:
            config["settings"] = self.manager._prepare_settings(manifest.config_schema, config.get("settings", {}))
        except Exception as exc:
            raise PluginError("invalid_settings", f"插件配置不兼容：{exc}") from exc
        config["enabled"] = bool(config.get("enabled", False)) if baseline else False
        _atomic_write(payload / "config.yaml", yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
        (payload / "state").mkdir(exist_ok=True)
        metadata = {"source_url": release.source_url, "download_url": release.download_url,
                    "sha256": release.sha256, "public_key": release.public_key or None,
                    "min_app_version": release.min_app_version or None}
        if release.platforms:
            metadata["platforms"] = list(release.platforms)
        metadata.update(installed_at=_now(), installed_version=manifest.version, installation_generation=generation)
        _write_json(payload / ".install.json", metadata)
        self._sync_tree(payload)
        return config["enabled"]

    def _summary(self, plugin_id):
        return next((p for p in self.manager.list_plugins() if p["id"] == plugin_id), None)

    def _commit(self, task, operation, plugin_id, live, payload, manifest, baseline, *, release):
        try:
            with self.manager.transaction():
                return self._commit_locked(task, operation, plugin_id, live, payload, manifest, baseline,
                                           release=release)
        except Exception as exc:
            # Entering the callback barrier can fail before a journal or any
            # filesystem mutation. The claimed task is still terminal.
            error = self._error(exc)
            self._finish(task, error.to_dict(), error.status)
            self._persist_early_failure(task, operation, plugin_id, live.name,
                                        error.to_dict(), error.status)
            if not self._recovery_required:
                self._cleanup_task_files(task)
                self._cleanup_finished_transactions(plugin_id)
            return error.to_dict(), error.status

    def _commit_locked(self, task, operation, plugin_id, live, payload, manifest, baseline, *, release):
        txdir = self._tx_dir(plugin_id, task["task_id"])
        generation = str(uuid.uuid4())
        previous = self._summary(plugin_id)
        journal = {"schema": 1, "operation": operation, "task_id": task["task_id"],
                   "request": task["_request"],
                   "plugin_id": plugin_id, "live_name": live.name, "stage": "preparing",
                   "old_identity": baseline, "new_generation": generation,
                   "old_status": previous["status"] if previous else None,
                   "old_enabled": previous["enabled"] if previous else False,
                   "created_at": _now()}
        journal_exists = False
        try:
            txdir.mkdir(parents=True, exist_ok=False)
            self._save_journal(journal)
            journal_exists = True
            if baseline:
                if previous is None:
                    raise PluginError("conflict", "插件配置无效，请先修复本地插件配置", 409)
                try:
                    self.manager._prepare_settings(manifest.config_schema,
                        self.manager._load_plugin_config(live / "config.yaml").get("settings", {}))
                except Exception as exc:
                    raise PluginError("invalid_settings", f"当前配置不兼容目标版本：{exc}") from exc
                self.manager.unload_plugin(plugin_id, root_dir=live)
            enabled = self._prepare_candidate(payload, manifest, live, baseline, generation, release)
            journal["new_identity"] = self._identity(payload)
            journal["prepared_at"] = _now()
            self._save_journal(journal, "prepared")
            self._progress(task, phase="switch", message="正在切换插件版本…")
            if baseline:
                self._rename(live, txdir / "old")
                self._save_journal(journal, "old_moved")
            self._rename(payload, live)
            self._save_journal(journal, "published")
            self._progress(task, phase="validate", message="正在验证插件状态…")
            self.manager.refresh()
            plugin = self._summary(plugin_id)
            if (plugin is None or plugin["version"] != manifest.version or plugin["enabled"] != enabled
                    or plugin["status"] != ("active" if enabled else "disabled")):
                raise PluginError("operation_failed", "新版本加载验证失败", 500)
            result = {"ok": True, "plugin": plugin}
            if operation == "upgrade":
                result.update(previous_version=baseline["version"], new_version=manifest.version)
            journal.update(response=result, http_status=200, finished_epoch=time.time())
            self._save_journal(journal, "committed")
        except Exception as exc:
            error = self._error(exc)
            try:
                if journal_exists or (txdir / "transaction.json").exists():
                    persisted = json.loads((txdir / "transaction.json").read_text(encoding="utf-8"))
                    if persisted.get("stage") == "committed":
                        # Atomic replace may have succeeded before its parent
                        # directory fsync raised. Never roll back a published
                        # terminal success that restart would otherwise keep.
                        if (persisted.get("task_id") != task["task_id"]
                                or persisted.get("new_generation") != generation):
                            raise RuntimeError("提交日志归属不一致")
                        result = persisted["response"]
                        self._finish(task, result, persisted["http_status"])
                        self._invalidate(plugin_id)
                        self._cleanup_task_files(task)
                        self._cleanup_finished_transactions(plugin_id)
                        return result, persisted["http_status"]
                    # A failed drain has not switched files. If the original
                    # runtime remains registered, avoid tearing it down again.
                    unchanged_runtime = (journal["stage"] == "preparing" and self._summary(plugin_id) == previous)
                    self._progress(task, phase="restore", message="正在恢复…")
                    self._save_journal(journal, "restoring")
                    if not unchanged_runtime:
                        self.manager.unload_plugin(plugin_id, root_dir=live)
                    self._restore_files(journal)
                    if not unchanged_runtime:
                        self.manager.refresh()
                    restored = self._summary(plugin_id)
                    if baseline:
                        expected_status = journal["old_status"]
                        if (restored is None or restored["version"] != baseline["version"]
                                or restored["enabled"] != journal["old_enabled"]
                                or restored["status"] != expected_status):
                            raise RuntimeError("旧插件运行状态恢复验证失败")
                    elif restored is not None:
                        raise RuntimeError("新安装插件未被正确移除")
                    if operation == "upgrade" and journal.get("prepared_at"):
                        error = PluginError("upgrade_failed_rolled_back", "提交失败，已恢复操作前的插件与数据", 500,
                                            cause=error.to_dict(), plugin=restored)
                    journal.update(response=error.to_dict(), http_status=error.status, finished_epoch=time.time())
                    self._save_journal(journal, "rolled_back")
                else:
                    # No journal means no unload or rename was allowed to start.
                    journal.update(response=error.to_dict(), http_status=error.status, finished_epoch=time.time())
                    self._persist_early_failure(task, operation, plugin_id, live.name,
                                                error.to_dict(), error.status)
            except Exception:
                logger.exception("Plugin recovery required: %s at %s", plugin_id, txdir)
                self._block_recovery()
                error = PluginError("recovery_required", "插件恢复未完成；已保留现场，请查看日志并重启服务", 500)
                journal.update(response=error.to_dict(), http_status=500, finished_epoch=time.time())
                try:
                    self._save_journal(journal, "recovery_required")
                except Exception:
                    logger.exception("Unable to persist recovery failure")
            self._finish(task, error.to_dict(), error.status)
            self._invalidate(plugin_id)
            if not self._recovery_required:
                self._cleanup_task_files(task)
                self._cleanup_finished_transactions(plugin_id)
            return error.to_dict(), error.status
        # Nothing after the durable committed record may roll back the success.
        self._finish(task, result, 200)
        self._invalidate(plugin_id)
        # Independent best-effort cleanups: a locked snapshot must not prevent
        # the already-installed archive from being removed.
        self._cleanup_task_files(task)
        self._cleanup_finished_transactions(plugin_id)
        return result, 200

    def _block_recovery(self):
        self._recovery_required = True
        # Manager also guards old refresh/enable/config endpoints after a failure.
        self.manager.block_management("插件事务恢复未完成，请查看日志并重启服务")

    def _finish(self, task, response, status):
        success = status < 400
        self._progress(task, status="succeeded" if success else "error", phase="succeeded" if success else "error",
                       progress=1 if success else None, message="操作完成" if success else response["message"],
                       result=response if success else None,
                       error=None if success else {"code": response["error"], "message": response["message"]},
                       _response=copy.deepcopy(response), _http_status=status, _finished=time.time())

    def _cleanup_task_files(self, task):
        with self._task_lock:
            if self._recovery_required or task["status"] not in _TERMINAL:
                return
            try:
                self._remove(self._task_dir(task["task_id"]))
                task["_files_cleaned"] = True
            except Exception:
                logger.warning("Plugin task cleanup deferred: %s", task["task_id"], exc_info=True)

    def _cleanup_stale_staging(self):
        with self._task_lock:
            if self._recovery_required:
                return
            for path in tuple(self._stale_staging):
                try:
                    self._contained(path, self.staging)
                    self._remove(path)
                    self._stale_staging.discard(path)
                except Exception:
                    logger.warning("Plugin staging cleanup deferred: %s", path.name, exc_info=True)

    @staticmethod
    def _same_identity(actual, expected):
        return actual == {k: v for k, v in (expected or {}).items() if k != "live_name"}

    def _restore_files(self, journal):
        if journal["operation"] == "uninstall":
            self._restore_uninstall_files(journal)
            return
        live = self._live(journal["live_name"])
        txdir = self._tx_dir(journal["plugin_id"], journal["task_id"])
        old = self._contained(txdir / "old", txdir)
        failed = self._contained(txdir / "failed", txdir)
        before = journal["old_identity"]
        actual = self._identity(live)
        if before is None:
            if old.exists():
                raise RuntimeError("新装事务出现意外旧快照")
            if actual is not None:
                if not self._same_identity(actual, journal.get("new_identity")):
                    raise RuntimeError("新装目录不属于本次事务")
                self._rename(live, failed)
            return
        if actual is not None and self._same_identity(actual, before):
            if old.exists():
                raise RuntimeError("旧版本同时出现在两个位置")
            return
        if not old.exists() or not self._same_identity(self._identity(old), before):
            raise RuntimeError("缺少有效的旧插件快照")
        if actual is not None:
            if not self._same_identity(actual, journal.get("new_identity")):
                raise RuntimeError("当前插件不属于本次事务")
            self._rename(live, failed)
        self._rename(old, live)

    def _journals(self, plugin_id=None):
        parent = self.backups if plugin_id is None else self._contained(self.backups / validate_plugin_id(plugin_id), self.backups)
        paths = parent.glob("*/*/transaction.json") if plugin_id is None else parent.glob("*/transaction.json")
        records = []
        for path in paths:
            try:
                self._contained(path, self.backups)
                record = json.loads(path.read_text(encoding="utf-8"))
                # Legacy rollback journals remain recoverable after removing
                # manual downgrade; they cannot start a new operation.
                if (record.get("schema") != 1 or record.get("stage") not in _STAGES
                        or record.get("operation") not in {"install", "upgrade", "rollback", "uninstall"}
                        or self._tx_dir(record["plugin_id"], record["task_id"]) != path.parent):
                    raise ValueError("事务记录身份错误")
                self._live(record["live_name"])
                records.append(record)
            except Exception as exc:
                logger.error("Unable to read plugin journal %s", path, exc_info=True)
                raise PluginError("recovery_required", "无法读取插件事务，请查看日志并恢复现场", 500) from exc
        return records

    def startup_cleanup(self):
        """Recover without importing code, then and only then remove staging."""
        with self.manager._lock:
            try:
                journals = self._journals()
                pending = {}
                for journal in journals:
                    if journal["stage"] not in _FINISHED_STAGES:
                        pid = journal["plugin_id"]
                        if pid in pending:
                            raise RuntimeError(f"插件 {pid} 存在多份未完成事务")
                        pending[pid] = journal
                for journal in pending.values():
                    self._save_journal(journal, "restoring")
                    self._restore_files(journal)
                    response = {"error": "operation_failed", "message": "上次操作被中断，已恢复操作前文件，请重新预览"}
                    journal.update(response=response, http_status=500, finished_epoch=time.time())
                    self._save_journal(journal, "rolled_back")
                with self._task_lock:
                    for journal in journals:
                        if journal["operation"] == "uninstall":
                            continue
                        if time.time() - journal.get("finished_epoch", time.time()) > _RETENTION:
                            continue
                        task = self._new_task(journal["task_id"])
                        task.update(plugin_id=journal["plugin_id"], _request=journal["request"])
                        self._finish(task, journal["response"], journal["http_status"])
                        task["_finished"] = journal.get("finished_epoch", time.time())
                for path in self.staging.iterdir():
                    self._contained(path, self.staging)
                    self._stale_staging.add(path)
            except Exception:
                self._block_recovery()
                logger.exception("Plugin startup recovery failed; refusing discovery")
                raise
            self._cleanup_stale_staging()
            self._cleanup_finished_transactions()

    def _persist_early_failure(self, task, operation, plugin_id, live_name, response, status):
        try:
            directory = self._tx_dir(plugin_id, task["task_id"])
            if (directory / "transaction.json").exists():
                return
            journal = {"schema": 1, "operation": operation, "task_id": task["task_id"],
                       "request": task["_request"],
                       "plugin_id": plugin_id, "live_name": live_name,
                       "stage": "rolled_back",
                       "response": response, "http_status": status,
                       "finished_epoch": time.time(), "created_at": _now()}
            self._save_journal(journal)
        except Exception:
            # No live mutation occurred, so preserve availability. The task
            # remains an in-memory error and its staging files are disposable.
            logger.exception("Unable to retain rejected plugin request: %s", task["task_id"])

    def _cleanup_finished_transactions(self, plugin_id=None):
        with self.manager._lock:
            if self._recovery_required:
                return
            try:
                journals = self._journals(plugin_id)
            except Exception:
                logger.warning("Plugin transaction cleanup deferred", exc_info=True)
                return
            for journal in journals:
                if journal["stage"] not in _FINISHED_STAGES:
                    continue
                try:
                    directory = self._tx_dir(journal["plugin_id"], journal["task_id"])
                    # Only a durable terminal record permits deleting recovery
                    # files. A locked file keeps its journal for the next retry.
                    for name in ("old", "failed", "transaction.json.tmp"):
                        self._remove(directory / name)
                    if time.time() - journal.get("finished_epoch", time.time()) > _RETENTION:
                        self._remove(directory)
                    else:
                        # Finished transactions need only the idempotent result;
                        # recovery identities and old runtime state are obsolete.
                        retained = {key: journal[key] for key in (
                            "schema", "operation", "task_id", "request", "plugin_id", "live_name",
                            "stage", "response", "http_status", "finished_epoch", "created_at", "updated_at"
                        ) if key in journal}
                        if retained != journal:
                            self._save_journal(retained)
                except Exception:
                    logger.warning("Plugin transaction cleanup deferred: %s", journal["task_id"], exc_info=True)

    def get_source_info(self, plugin_id):
        with self.manager._lock:
            snapshot = self._snapshot(validate_plugin_id(plugin_id))
            if snapshot is None:
                return {"source_type": "local", "source_url": None}
            source = snapshot["source"]
            return {"source_type": "online" if source.get("source_url") else "local", "source_url": source.get("source_url"),
                    "public_key": source.get("public_key")}

    def _invalidate(self, plugin_id):
        with self._task_lock:
            self._cache.pop(plugin_id, None)

    def check_updates(self, plugin_ids=None, *, force=False):
        self._accepting()
        self._expire_tasks()
        snapshots = {}
        results = {}
        with self.manager._lock:
            ids = plugin_ids if plugin_ids is not None else [p["id"] for p in self.manager.list_plugins()]
            for pid in ids:
                try:
                    snapshot = self._snapshot(validate_plugin_id(pid))
                    if snapshot is None:
                        raise PluginError("not_found", "插件不存在", 404)
                    if not snapshot["source"].get("source_url"):
                        results[pid] = {"id": pid, "current": snapshot["version"], "has_update": False, "source_type": "local"}
                        continue
                    with self._task_lock:
                        cached = self._cache.get(pid)
                        if not force and cached and cached[0] == snapshot and time.monotonic() - cached[1] < 3600:
                            results[pid] = copy.deepcopy(cached[2])
                            continue
                    snapshots[pid] = snapshot
                except Exception as exc:
                    error = self._error(exc)
                    results[pid] = {"id": pid, "has_update": False, "error": {"code": error.code, "message": error.message}}
        # Each request uses at most four daemon workers. Network I/O is outside
        # manager/task locks; shutdown never joins blocked HTTP reads.
        import queue
        work = queue.Queue()
        output = {}
        output_lock = threading.Lock()
        for item in snapshots.items():
            work.put(item)
        def worker():
            while not self._stop.is_set():
                try:
                    pid, baseline = work.get_nowait()
                except queue.Empty:
                    return
                source = baseline["source"]
                try:
                    release = fetch_release(source["source_url"], cancel_event=self._stop)
                    if release.id != pid:
                        raise PluginError("id_mismatch", "更新索引的 ID 与当前插件不一致")
                    result = {"id": pid, "current": baseline["version"], "latest": release.version,
                              "has_update": parse_version(release.version) > parse_version(baseline["version"]),
                              "compatible": release.compatible, "app_compatible": release.app_compatible,
                              "platform_compatible": release.platform_compatible, "changelog": release.changelog,
                              "source_url": source["source_url"], "source_type": "online",
                              "min_app_version": release.min_app_version, "public_key": release.public_key,
                              "trust_required": bool(source.get("public_key") and source["public_key"] != release.public_key)}
                except Exception as exc:
                    error = self._error(exc)
                    result = {"id": pid, "current": baseline["version"], "source_type": "online", "source_url": source["source_url"],
                              "has_update": False, "error": {"code": error.code, "message": error.message}}
                with output_lock:
                    output[pid] = result
        threads = [threading.Thread(target=worker, daemon=True, name="plugin-source-check") for _ in range(min(4, len(snapshots)))]
        for thread in threads:
            thread.start()
        for thread in threads:
            while thread.is_alive():
                thread.join(.2)
                if self._stop.is_set():
                    return results
        with self.manager._lock:
            for pid, result in output.items():
                try:
                    current = self._snapshot(pid)
                except PluginError:
                    continue
                if current != snapshots[pid]:
                    continue
                with self._task_lock:
                    self._cache[pid] = (snapshots[pid], time.monotonic(), result)
                results[pid] = result
        return results

    def start_update_checker(self):
        if self._checker is not None:
            return
        def check_loop():
            while not self._stop.is_set():
                try:
                    updates = self.check_updates()
                    if any(row.get("has_update") for row in updates.values()):
                        from pawzochat.web.sse import broadcast
                        broadcast("plugin_updates_available", updates=updates)
                except Exception:
                    logger.warning("Plugin update check failed", exc_info=True)
                if self._stop.wait(24 * 60 * 60):
                    break
        def maintain_loop():
            while not self._stop.wait(60):
                try:
                    self._expire_tasks()
                    self._cleanup_finished_transactions()
                except Exception:
                    logger.warning("Plugin preview cleanup failed", exc_info=True)
        self._checker = threading.Thread(target=check_loop, daemon=True, name="plugin-update-check")
        self._maintenance = threading.Thread(target=maintain_loop, daemon=True, name="plugin-preview-cleanup")
        self._checker.start()
        self._maintenance.start()

    def stop(self):
        self._stop.set()
        with self._task_lock:
            for task in self._tasks.values():
                if task["status"] in {"queued", "running", "ready"}:
                    task["_cancel"].set()
                    task["cancel_requested"] = True
