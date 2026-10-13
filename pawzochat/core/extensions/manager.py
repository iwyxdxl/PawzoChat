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

"""Discovery and lifecycle manager for plugins under the runtime plugins directory."""

from __future__ import annotations

import copy
import importlib.util
import json
import logging
import re
import sys
import threading
from dataclasses import dataclass
from contextlib import contextmanager
from functools import wraps
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

import yaml

from pawzochat.paths import PLUGINS_DIR
from pawzochat.core.extensions.api import (
    ChannelsFacade,
    ConversationFacade,
    LLMFacade,
    MCPFacade,
    MessagingFacade,
    PersonaFacade,
    Plugin,
    PluginContext,
    PluginManifest,
)
from pawzochat.core.extensions.hooks import HookDispatcher, HookRegistrar
from pawzochat.core.extensions.platforms import normalize_platforms, supports_platform
from pawzochat.core.extensions.source import PluginError

if TYPE_CHECKING:
    from pawzochat.app import App
    from pawzochat.mcp.adapters import CapabilityAdapterRegistry

logger = logging.getLogger(__name__)

PLUGIN_MANIFEST_FILE = "plugin.yaml"
PLUGIN_CONFIG_FILE = "config.yaml"
PLUGIN_API_VERSION = 1
_PLUGIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

# Permissions the host currently grants through controlled facades. Unknown
# values are retained for user audit, but they do not unlock any host API.
KNOWN_PERMISSIONS = frozenset({
    "messaging.send", "mcp.read", "mcp.invoke", "mcp.publish", "channel.register",
})

# Defaults applied to ``config_ui`` shorthand (``config_ui: true``).
_CONFIG_UI_DEFAULT_ENTRY = "index.html"


class PluginBusyError(RuntimeError):
    """Host callbacks are still running; leave plugin files untouched."""


class PluginUnloadError(RuntimeError):
    """Plugin resources could not be stopped safely."""


def _managed(method):
    @wraps(method)
    def locked(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return locked


@dataclass
class PluginRuntime:
    manifest: PluginManifest
    root_dir: Path
    config_path: Path
    state_dir: Path
    enabled: bool
    settings: dict
    status: str = "discovered"
    last_error: str = ""
    plugin: Plugin | None = None
    module_name: str = ""
    platform_compatible: bool = True
    platform_error: str = ""


class ExtensionManager:
    """Loads and dispatches external plugins from the runtime plugins directory."""

    def __init__(self, app: App, config_manager, conversation_store, llm_manager, mcp_manager=None):
        self._lock = threading.RLock()
        self._recovery_required = ""
        self._transaction_depth = 0
        self._app = app
        self._plugins_root = PLUGINS_DIR
        self._plugins: dict[str, PluginRuntime] = {}
        self._conversations = ConversationFacade(conversation_store)
        self._personas = PersonaFacade(config_manager)
        self._llm = LLMFacade(llm_manager, config_manager)
        self._mcp_manager = mcp_manager
        self._capability_registry: CapabilityAdapterRegistry | None = None
        self.hooks = HookDispatcher(self._on_hook_error)

    @_managed
    def set_capability_registry(self, registry: CapabilityAdapterRegistry) -> None:
        """Inject the capability registry after construction.

        ``ExtensionManager`` is built in ``App.__init__`` before the
        registry exists, so the registry is wired in via this setter
        before ``start()`` is called. ``MCPFacade.register_tool`` raises
        ``RuntimeError`` until the registry is set.
        """
        self._capability_registry = registry

    def start(self) -> None:
        self.refresh()

    @_managed
    def stop(self) -> None:
        self._pause_all_plugin_calls()
        try:
            for plugin_id in list(self._plugins):
                self._unload_runtime(self._plugins[plugin_id], keep_status=False)
            self._plugins.clear()
        finally:
            self._resume_active_plugin_calls()

    @_managed
    def refresh(self) -> None:
        self._assert_management_available()
        self._pause_all_plugin_calls()
        try:
            self._refresh_plugins()
        finally:
            self._resume_active_plugin_calls()

    def _refresh_plugins(self) -> None:
        for plugin_id in list(self._plugins):
            self._unload_runtime(self._plugins[plugin_id], keep_status=False)
        self._plugins.clear()

        self._plugins_root.mkdir(parents=True, exist_ok=True)
        for root_dir in sorted(
            (p for p in self._plugins_root.iterdir() if p.is_dir()),
            key=lambda path: path.name,
        ):
            manifest_path = root_dir / PLUGIN_MANIFEST_FILE
            if not manifest_path.is_file():
                continue
            try:
                runtime = self._build_runtime(root_dir)
            except Exception:
                logger.exception("Failed to discover plugin: %s", root_dir.name)
                continue
            pid = runtime.manifest.id
            if pid in self._plugins:
                existing_dir = self._plugins[pid].root_dir.name
                logger.warning(
                    "Duplicate plugin id '%s' in '%s' (already loaded from '%s'), skipping",
                    pid, root_dir.name, existing_dir,
                )
                continue
            self._plugins[pid] = runtime

        ordered_plugin_ids, unresolved_ids = self._sorted_plugin_ids()
        for pid in sorted(unresolved_ids):
            ordered_plugin_ids.append(pid)

        for plugin_id in ordered_plugin_ids:
            runtime = self._plugins[plugin_id]
            if not runtime.platform_compatible:
                continue
            if not runtime.enabled:
                runtime.status = "disabled"
                continue
            missing = [
                dep for dep in runtime.manifest.depends_on
                if dep not in self._plugins
            ]
            if missing:
                runtime.status = "broken"
                runtime.last_error = (
                    f"Missing dependencies: {', '.join(sorted(missing))}"
                )
                continue
            inactive = [
                dep for dep in runtime.manifest.depends_on
                if self._plugins[dep].status != "active"
            ]
            if inactive:
                runtime.status = "broken"
                runtime.last_error = (
                    f"Dependencies not active: {', '.join(sorted(inactive))}"
                )
                continue
            self._load_runtime(runtime)

    @_managed
    def list_plugins(self) -> list[dict]:
        return [
            self._runtime_summary(runtime)
            for runtime in sorted(
                self._plugins.values(),
                key=lambda item: item.manifest.id,
            )
        ]

    @_managed
    def get_plugin(self, plugin_id: str) -> dict | None:
        runtime = self._plugins.get(plugin_id)
        if not runtime:
            return None
        detail = self._runtime_summary(runtime)
        detail["manifest"] = {
            "id": runtime.manifest.id,
            "name": runtime.manifest.name,
            "version": runtime.manifest.version,
            "api_version": runtime.manifest.api_version,
            "entrypoint": runtime.manifest.entrypoint,
            "description": runtime.manifest.description,
            "author": runtime.manifest.author,
            "hooks": list(runtime.manifest.hooks),
            "depends_on": list(runtime.manifest.depends_on),
            "permissions": list(runtime.manifest.permissions),
            "config_schema": copy.deepcopy(runtime.manifest.config_schema),
            "config_ui": copy.deepcopy(runtime.manifest.config_ui),
            "platforms": list(runtime.manifest.platforms),
        }
        detail["settings"] = copy.deepcopy(runtime.settings)
        return detail

    @_managed
    def set_enabled(self, plugin_id: str, enabled: bool) -> None:
        self._assert_management_available()
        runtime = self._require_runtime(plugin_id)
        if enabled:
            # Re-read both author declarations before changing persistent
            # settings, including plugins copied here from another system.
            manifest = self._load_manifest(runtime.root_dir / PLUGIN_MANIFEST_FILE)
            self._assert_platform_supported(manifest, runtime.root_dir)
        cfg = self._load_plugin_config(runtime.config_path)
        cfg["enabled"] = bool(enabled)
        self._pause_all_plugin_calls()
        try:
            self._write_plugin_config(runtime.config_path, cfg)
            self.refresh()
        finally:
            self._resume_active_plugin_calls()

    @_managed
    def update_settings(self, plugin_id: str, settings: dict) -> dict:
        self._assert_management_available()
        runtime = self._require_runtime(plugin_id)
        prepared = self._prepare_settings(runtime.manifest.config_schema, settings)
        cfg = self._load_plugin_config(runtime.config_path)
        cfg["settings"] = prepared
        self._pause_all_plugin_calls()
        try:
            self._write_plugin_config(runtime.config_path, cfg)
            self.refresh()
        finally:
            self._resume_active_plugin_calls()
        refreshed = self._require_runtime(plugin_id)
        return copy.deepcopy(refreshed.settings)

    @_managed
    def reload_plugin(self, plugin_id: str) -> None:
        self._assert_management_available()
        self._require_runtime(plugin_id)
        self.refresh()
        self._require_runtime(plugin_id)

    @_managed
    def get_plugin_ui_root(self, plugin_id: str) -> Path | None:
        """Return the plugin's ``ui/`` directory if it declares ``config_ui``.

        Falls back to ``None`` for plugins that aren't registered or don't
        opt in. Used by the static-asset route to serve custom HTML panels
        without trusting URL-derived directory names.
        """
        runtime = self._plugins.get(plugin_id)
        if runtime is None or not runtime.manifest.config_ui:
            return None
        return runtime.root_dir / "ui"

    @_managed
    def get_plugin_root(self, plugin_id: str) -> Path | None:
        """Return the discovered real root, independent of manifest ID."""
        runtime = self._plugins.get(plugin_id)
        return runtime.root_dir if runtime is not None else None

    @_managed
    def block_management(self, reason: str) -> None:
        """Prevent refresh from loading an unresolved on-disk transaction."""
        self._recovery_required = reason or "Plugin recovery required"

    def _assert_management_available(self) -> None:
        if self._recovery_required:
            raise PluginUnloadError(self._recovery_required)

    def _plugin_channel(self, plugin_id: str):
        registry = getattr(self._app, "channel_registry", None)
        return registry.get(f"plugin:{plugin_id}", default=None) if registry else None

    def _resume_plugin_calls(self, plugin_id: str) -> None:
        if self._transaction_depth or self._recovery_required:
            return
        self.hooks.resume_plugin(plugin_id)
        if self._capability_registry is not None:
            self._capability_registry.resume_owner(f"plugin:{plugin_id}")
        channel = self._plugin_channel(plugin_id)
        if channel is not None:
            resumed = channel.resume_callbacks()
            retry = getattr(self._app, "retry_deferred_accounts", None)
            runtime = self._plugins.get(plugin_id)
            if resumed and callable(retry) and runtime and runtime.status == "active":
                try:
                    retry(f"plugin:{plugin_id}")
                except Exception:
                    logger.exception("Unable to restart deferred plugin accounts: %s", plugin_id)

    @contextmanager
    def transaction(self):
        """Freeze all host plugin callbacks until a directory transaction ends."""
        with self._lock:
            self._assert_management_available()
            if self._transaction_depth == 0:
                self._pause_all_plugin_calls()
            self._transaction_depth += 1
            try:
                yield
            finally:
                self._transaction_depth -= 1
                if not self._transaction_depth:
                    self._resume_active_plugin_calls()

    def _pause_plugin_calls(self, plugin_id: str) -> None:
        # Reject immediately rather than wait while holding the manager lock:
        # an in-flight callback may itself need that lock.
        if not self.hooks.pause_plugin(plugin_id):
            raise PluginBusyError(f"Plugin {plugin_id} has active hooks; retry later")
        try:
            if self._capability_registry is not None:
                if not self._capability_registry.pause_owner(f"plugin:{plugin_id}"):
                    raise PluginBusyError(f"Plugin {plugin_id} has active tools; retry later")
            channel = self._plugin_channel(plugin_id)
            if channel is not None and not channel.pause_callbacks():
                raise PluginBusyError(f"Plugin {plugin_id} has active channel callbacks; retry later")
        except Exception:
            self._resume_plugin_calls(plugin_id)
            raise

    def _pause_all_plugin_calls(self) -> None:
        paused = []
        try:
            for plugin_id in self._plugins:
                self._pause_plugin_calls(plugin_id)
                paused.append(plugin_id)
        except Exception:
            for plugin_id in paused:
                self._resume_plugin_calls(plugin_id)
            raise

    def _resume_active_plugin_calls(self) -> None:
        for plugin_id, runtime in self._plugins.items():
            if runtime.status == "active":
                self._resume_plugin_calls(plugin_id)

    @_managed
    def unload_plugin(self, plugin_id: str, *, root_dir: Path | None = None) -> None:
        """Stop one plugin before replacement, including failed-load modules.

        Busy callbacks and failed teardown raise before the caller may rename
        any directory. A failed runtime is retained so cleanup can be retried.
        """
        runtime = self._plugins.get(plugin_id)
        if runtime is not None:
            self._unload_runtime(runtime, keep_status=False)
            self._plugins.pop(plugin_id, None)
            return
        self._pause_plugin_calls(plugin_id)
        try:
            self.hooks.unregister_plugin(plugin_id)
            self._unregister_plugin_tools(plugin_id)
            self._unregister_plugin_channel(plugin_id)
        finally:
            sys.modules.pop(f"pawzochat_plugin_{plugin_id}", None)
            if root_dir is not None:
                self._clear_plugin_modules(root_dir)

    @staticmethod
    def _clear_plugin_modules(root_dir: Path) -> None:
        root = Path(root_dir).resolve()

        def belongs_to_plugin(path) -> bool:
            try:
                Path(path).resolve().relative_to(root)
                return True
            except (OSError, RuntimeError, TypeError, ValueError):
                return False

        stale = {}
        for name, module in list(sys.modules.items()):
            filename = getattr(module, "__file__", None)
            # Namespace packages have no __file__. Keep a shared namespace
            # when another directory also contributes to it, but remove a
            # namespace belonging entirely to this plugin.
            locations = tuple(getattr(module, "__path__", ())) if not filename else ()
            if ((filename and belongs_to_plugin(filename))
                    or (locations and all(belongs_to_plugin(path) for path in locations))):
                stale[name] = module
        for name, module in stale.items():
            if sys.modules.get(name) is module:
                sys.modules.pop(name, None)
            # `from package import child` can reuse this attribute without
            # consulting sys.modules, including on a shared namespace package.
            parent_name, _, child_name = name.rpartition(".")
            parent = sys.modules.get(parent_name)
            if parent is not None and vars(parent).get(child_name) is module:
                delattr(parent, child_name)
        importlib.invalidate_caches()

    def dispatch_message_received(self, event) -> None:
        self.hooks.dispatch_message_received(event)

    def dispatch_message_stored(self, event) -> None:
        self.hooks.dispatch_message_stored(event)

    def dispatch_context_build(self, event) -> None:
        self.hooks.dispatch_context_build(event)

    def dispatch_reply_compose(self, event) -> None:
        self.hooks.dispatch_reply_compose(event)

    def dispatch_reply_pre_send(self, event) -> None:
        self.hooks.dispatch_reply_pre_send(event)

    def dispatch_reply_sent(self, event) -> None:
        self.hooks.dispatch_reply_sent(event)

    def _build_runtime(self, root_dir: Path) -> PluginRuntime:
        manifest = self._load_manifest(root_dir / PLUGIN_MANIFEST_FILE)
        config_path = root_dir / PLUGIN_CONFIG_FILE
        cfg = self._load_plugin_config(config_path)
        if not config_path.exists():
            defaults = self._apply_defaults(manifest.config_schema, {})
            cfg = {"enabled": False, "settings": defaults}
            self._write_plugin_config(config_path, cfg)
        settings = self._prepare_settings(
            manifest.config_schema, cfg.get("settings", {}),
        )
        if cfg.get("settings", {}) != settings:
            cfg["settings"] = settings
            self._write_plugin_config(config_path, cfg)

        state_dir = root_dir / "state"
        state_dir.mkdir(parents=True, exist_ok=True)

        runtime = PluginRuntime(
            manifest=manifest,
            root_dir=root_dir,
            config_path=config_path,
            state_dir=state_dir,
            enabled=bool(cfg.get("enabled", False)),
            settings=settings,
            status="discovered",
        )
        self._apply_platform_guard(runtime)
        return runtime

    @staticmethod
    def _assert_platform_supported(manifest: PluginManifest, root_dir: Path) -> None:
        """Require both the package and persisted index to allow this OS.

        Missing declarations retain legacy behavior. An unreadable or malformed
        install record must never silently remove a previously saved restriction.
        """
        record_path = root_dir / ".install.json"
        installed_platforms = ()
        if record_path.exists() or record_path.is_symlink():
            try:
                if (record_path.is_symlink() or not record_path.is_file()
                        or record_path.stat().st_size > 1024 * 1024):
                    raise ValueError("Invalid install metadata file")
                record = json.loads(record_path.read_text(encoding="utf-8"))
                if not isinstance(record, dict):
                    raise ValueError("Install metadata must be an object")
                if "platforms" in record:
                    installed_platforms = normalize_platforms(record["platforms"])
            except (OSError, UnicodeError, ValueError) as exc:
                raise PluginError("platform_invalid", "插件平台信息无效，请重新安装") from exc
        if not supports_platform(manifest.platforms) or not supports_platform(installed_platforms):
            raise PluginError("platform_unsupported", "此插件不支持当前系统", 409)

    def _apply_platform_guard(self, runtime: PluginRuntime) -> bool:
        try:
            self._assert_platform_supported(runtime.manifest, runtime.root_dir)
        except PluginError as exc:
            runtime.platform_compatible = False
            runtime.platform_error = exc.code
            runtime.enabled = False
            runtime.status = "unsupported"
            runtime.last_error = exc.message
            return False
        runtime.platform_compatible = True
        runtime.platform_error = ""
        return True

    def _load_runtime(self, runtime: PluginRuntime) -> None:
        # The guard also belongs at the import boundary: disabled or unsupported
        # plugins must never execute their module-level code.
        if not self._apply_platform_guard(runtime):
            return
        module_name = ""
        try:
            self._pause_plugin_calls(runtime.manifest.id)
            module_part, sep, attr = runtime.manifest.entrypoint.partition(":")
            if not sep or not module_part or not attr:
                raise ValueError("entrypoint must be in 'module:function' format")

            module_path = runtime.root_dir.joinpath(*module_part.split(".")).with_suffix(".py")
            if not module_path.is_file():
                raise FileNotFoundError(f"Entrypoint module not found: {module_path}")

            module_name = f"pawzochat_plugin_{runtime.manifest.id}"
            runtime.module_name = module_name
            spec = importlib.util.spec_from_file_location(module_name, module_path)
            if spec is None or spec.loader is None:
                raise ImportError(f"Unable to load module spec: {module_path}")

            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)

            factory = getattr(module, attr, None)
            if not callable(factory):
                raise AttributeError(
                    f"Entrypoint function not found: {runtime.manifest.entrypoint}"
                )

            plugin = factory()
            if not isinstance(plugin, Plugin):
                raise TypeError(
                    f"{runtime.manifest.id} did not return a Plugin instance"
                )

            ctx = PluginContext(
                manifest=runtime.manifest,
                root_dir=runtime.root_dir,
                config_path=runtime.config_path,
                state_dir=runtime.state_dir,
                logger=logging.getLogger(f"pawzochat.plugin.{runtime.manifest.id}"),
                config=copy.deepcopy(runtime.settings),
                hooks=HookRegistrar(runtime.manifest.id, self.hooks),
                conversations=self._conversations,
                personas=self._personas,
                llm=self._llm,
                messaging=MessagingFacade(self._app, runtime.manifest),
                mcp=MCPFacade(
                    runtime.manifest,
                    self._mcp_manager,
                    self._capability_registry,
                ),
                channels=ChannelsFacade(self._app, runtime.manifest),
            )
            runtime.plugin = plugin
            plugin.setup(ctx)

            runtime.module_name = module_name
            runtime.status = "active"
            runtime.last_error = ""
            self._resume_plugin_calls(runtime.manifest.id)
        except Exception as exc:
            cleanup_error = ""
            try:
                self._unload_runtime(runtime, keep_status=True)
            except Exception as cleanup_exc:
                cleanup_error = f"; cleanup failed: {cleanup_exc}"
                logger.exception("Failed to clean up plugin setup: %s", runtime.manifest.id)
            runtime.status = "broken"
            runtime.last_error = f"{exc}{cleanup_error}"
            logger.exception("Failed to load plugin: %s", runtime.manifest.id)

    def _unload_runtime(
        self,
        runtime: PluginRuntime,
        *,
        keep_status: bool,
    ) -> None:
        self._pause_plugin_calls(runtime.manifest.id)
        self.hooks.unregister_plugin(runtime.manifest.id)
        errors = []
        try:
            if runtime.plugin is not None:
                try:
                    runtime.plugin.teardown()
                except Exception as exc:
                    errors.append(exc)
                    logger.exception("Failed to teardown plugin: %s", runtime.manifest.id)
            for cleanup in (self._unregister_plugin_tools, self._unregister_plugin_channel):
                try:
                    cleanup(runtime.manifest.id)
                except Exception as exc:
                    errors.append(exc)
                    logger.exception("Failed to unregister plugin resources: %s", runtime.manifest.id)
        finally:
            self.hooks.unregister_plugin(runtime.manifest.id)
            if runtime.module_name:
                sys.modules.pop(runtime.module_name, None)
            runtime.module_name = ""
            try:
                self._clear_plugin_modules(runtime.root_dir)
            except Exception as exc:
                errors.append(exc)
        if errors:
            # Keep the instance to allow idempotent teardown to be retried;
            # never claim an unsafe runtime was fully stopped.
            runtime.status = "broken"
            runtime.last_error = "; ".join(str(exc) for exc in errors)
            raise PluginUnloadError(f"Plugin {runtime.manifest.id} cleanup failed: {runtime.last_error}") from errors[0]
        runtime.plugin = None
        if not keep_status:
            runtime.status = "discovered"
            runtime.last_error = ""

    def _unregister_plugin_channel(self, plugin_id: str) -> None:
        """Stop and unregister a plugin's channel (if it registered one).

        Idempotent — safe to call from both the unload path and the
        load-error path.
        """
        channel_type = f"plugin:{plugin_id}"
        channel = self._plugin_channel(plugin_id)
        if channel is None:
            return
        channel.shutdown(strict=True)
        self._app.channel_registry.unregister(channel_type)

    def _unregister_plugin_tools(self, plugin_id: str) -> None:
        """Strip every capability tagged ``plugin:<plugin_id>``.

        Idempotent — safe to call from both the unload path and the
        load-error path.
        """
        if self._capability_registry is None:
            return
        removed = self._capability_registry.unregister_owner(
            f"plugin:{plugin_id}"
        )
        if removed:
            logger.info(
                "Unregistered %d tool(s) from plugin %s: %s",
                len(removed), plugin_id, ", ".join(sorted(removed)),
            )

    @_managed
    def get_provided_tools(self, plugin_id: str) -> list[dict]:
        """Return the tools registered by ``plugin_id`` via ctx.mcp.register_tool.

        Each item: ``{"name": "<namespaced>", "description": str,
        "inputSchema": dict}``. Empty list if the plugin registered no
        tools or the registry is not yet initialized.
        """
        if self._capability_registry is None:
            return []
        defs = self._capability_registry.get_tools_by_owner(
            f"plugin:{plugin_id}"
        )
        return [
            {
                "name": d.get("name", ""),
                "description": d.get("description", ""),
                "inputSchema": d.get("inputSchema", {}),
            }
            for d in defs
        ]

    def _runtime_summary(self, runtime: PluginRuntime) -> dict:
        return {
            "id": runtime.manifest.id,
            "name": runtime.manifest.name,
            "version": runtime.manifest.version,
            "description": runtime.manifest.description,
            "author": runtime.manifest.author,
            "enabled": runtime.enabled,
            "platform_compatible": runtime.platform_compatible,
            "platform_error": runtime.platform_error,
            "status": runtime.status,
            "last_error": runtime.last_error,
            "hooks": list(runtime.manifest.hooks),
            "depends_on": list(runtime.manifest.depends_on),
            "permissions": list(runtime.manifest.permissions),
            "config_ui": copy.deepcopy(runtime.manifest.config_ui),
        }

    def _load_manifest(self, manifest_path: Path) -> PluginManifest:
        raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
        plugin_id = str(raw.get("id", "")).strip()
        if not plugin_id:
            raise ValueError(f"Plugin id missing in {manifest_path}")
        if not _PLUGIN_ID_RE.match(plugin_id):
            raise ValueError(
                f"Invalid plugin id '{plugin_id}': must match [a-z0-9][a-z0-9_-]*"
            )

        api_version = int(raw.get("api_version", 0) or 0)
        if api_version != PLUGIN_API_VERSION:
            raise ValueError(
                f"Unsupported api_version={api_version} for plugin {plugin_id}"
            )

        raw_permissions = raw.get("permissions", []) or []
        if isinstance(raw_permissions, str):
            permissions = [raw_permissions.strip()]
        else:
            permissions = [
                str(permission).strip()
                for permission in raw_permissions
                if str(permission).strip()
            ]
        unknown = [p for p in permissions if p not in KNOWN_PERMISSIONS]
        if unknown:
            logger.warning(
                "Plugin %s declares unrecognized permission(s): %s. "
                "They will be shown for audit but do not grant host capabilities.",
                plugin_id,
                ", ".join(sorted(set(unknown))),
            )

        config_ui = self._normalize_config_ui(raw.get("config_ui"), plugin_id)
        try:
            platforms = normalize_platforms(raw["platforms"]) if "platforms" in raw else ()
        except ValueError as exc:
            raise PluginError("platform_invalid", "插件平台信息无效，请重新安装") from exc

        return PluginManifest(
            id=plugin_id,
            name=str(raw.get("name", plugin_id)).strip() or plugin_id,
            version=str(raw.get("version", "0.0.0")).strip() or "0.0.0",
            api_version=api_version,
            entrypoint=str(raw.get("entrypoint", "")).strip(),
            description=str(raw.get("description", "")).strip(),
            author=str(raw.get("author", "")).strip(),
            hooks=list(raw.get("hooks", []) or []),
            depends_on=list(raw.get("depends_on", []) or []),
            permissions=permissions,
            config_schema=copy.deepcopy(raw.get("config_schema", {}) or {}),
            config_ui=config_ui,
            platforms=platforms,
        )

    @staticmethod
    def _normalize_config_ui(raw: Any, plugin_id: str) -> dict:
        """Coerce ``config_ui`` into ``{entry, height}`` or empty dict.

        Accepts ``True`` (shorthand for default entry) or a mapping. ``entry``
        is relative to the plugin's ``ui/`` directory; the older
        ``ui/index.html`` form is accepted and normalized for compatibility.
        """
        if not raw:
            return {}
        if raw is True:
            return {"entry": _CONFIG_UI_DEFAULT_ENTRY, "height": "auto"}
        if not isinstance(raw, dict):
            raise ValueError(
                f"plugin {plugin_id}: config_ui must be a boolean or a mapping"
            )
        entry = str(raw.get("entry") or _CONFIG_UI_DEFAULT_ENTRY).strip()
        if not entry:
            entry = _CONFIG_UI_DEFAULT_ENTRY
        # Defend against absolute paths and parent traversal at manifest-load
        # time — the serve route will re-check, but failing fast here gives
        # plugin authors a clearer error than a 404 at runtime.
        normalized = entry.replace("\\", "/").lstrip("/")
        parts = PurePosixPath(normalized).parts
        if ".." in parts:
            raise ValueError(
                f"plugin {plugin_id}: config_ui.entry must not contain '..'"
            )
        if parts and parts[0] == "ui":
            parts = parts[1:]
        normalized = "/".join(parts) or _CONFIG_UI_DEFAULT_ENTRY
        height = raw.get("height", "auto")
        if isinstance(height, (int, float)):
            height_value: Any = max(0, int(height))
        else:
            height_value = str(height or "auto").strip() or "auto"
        return {"entry": normalized, "height": height_value}

    @staticmethod
    def _load_plugin_config(config_path: Path) -> dict:
        if not config_path.exists():
            return {}
        raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            return {}
        return raw

    @staticmethod
    def _write_plugin_config(config_path: Path, data: dict) -> None:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            yaml.safe_dump(
                data,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            ),
            encoding="utf-8",
        )

    def _prepare_settings(self, schema: dict, settings: Any) -> dict:
        value = copy.deepcopy(settings if isinstance(settings, dict) else {})
        value = self._apply_defaults(schema, value)
        self._validate_settings(schema, value, path="settings")
        return value

    def _apply_defaults(self, schema: dict, value: Any):
        if not schema:
            return copy.deepcopy(value)

        schema_type = schema.get("type")
        if schema_type == "object":
            result = copy.deepcopy(value if isinstance(value, dict) else {})
            for key, subschema in (schema.get("properties") or {}).items():
                if key in result:
                    result[key] = self._apply_defaults(subschema, result[key])
                elif "default" in subschema:
                    result[key] = copy.deepcopy(subschema["default"])
            return result

        if value is None and "default" in schema:
            return copy.deepcopy(schema["default"])
        return copy.deepcopy(value)

    def _validate_settings(self, schema: dict, value: Any, *, path: str) -> None:
        if not schema:
            if not isinstance(value, dict):
                raise ValueError(f"{path} must be an object")
            return

        schema_type = schema.get("type")
        if schema_type == "object":
            if not isinstance(value, dict):
                raise ValueError(f"{path} must be an object")
            required = schema.get("required", []) or []
            for key in required:
                if key not in value:
                    raise ValueError(f"{path}.{key} is required")
            for key, subschema in (schema.get("properties") or {}).items():
                if key in value:
                    self._validate_settings(
                        subschema,
                        value[key],
                        path=f"{path}.{key}",
                    )
            return

        if schema_type == "string" and not isinstance(value, str):
            raise ValueError(f"{path} must be a string")
        if schema_type == "boolean" and not isinstance(value, bool):
            raise ValueError(f"{path} must be a boolean")
        if schema_type == "integer" and not isinstance(value, int):
            raise ValueError(f"{path} must be an integer")
        if schema_type == "number" and not isinstance(value, (int, float)):
            raise ValueError(f"{path} must be a number")
        if schema_type == "array":
            if not isinstance(value, list):
                raise ValueError(f"{path} must be an array")
            item_schema = schema.get("items", {}) or {}
            for idx, item in enumerate(value):
                self._validate_settings(
                    item_schema,
                    item,
                    path=f"{path}[{idx}]",
                )

    def _sorted_plugin_ids(self) -> tuple[list[str], set[str]]:
        """Kahn topological sort. Returns (ordered, cyclic) where *cyclic*
        contains only the plugin IDs that participate in a dependency cycle."""
        from collections import deque

        all_ids = set(self._plugins)
        in_degree: dict[str, int] = {pid: 0 for pid in all_ids}
        dependents: dict[str, list[str]] = {pid: [] for pid in all_ids}

        for pid in all_ids:
            for dep in self._plugins[pid].manifest.depends_on:
                if dep in all_ids:
                    in_degree[pid] += 1
                    dependents[dep].append(pid)

        queue = deque(sorted(pid for pid, deg in in_degree.items() if deg == 0))
        order: list[str] = []

        while queue:
            pid = queue.popleft()
            order.append(pid)
            for child in sorted(dependents[pid]):
                in_degree[child] -= 1
                if in_degree[child] == 0:
                    queue.append(child)

        cyclic = all_ids - set(order)
        return order, cyclic

    @_managed
    def _on_hook_error(self, plugin_id: str, hook_name: str, exc: BaseException) -> None:
        runtime = self._plugins.get(plugin_id)
        if runtime:
            runtime.last_error = f"{hook_name}: {exc}"

    def _require_runtime(self, plugin_id: str) -> PluginRuntime:
        runtime = self._plugins.get(plugin_id)
        if not runtime:
            raise KeyError(plugin_id)
        return runtime
