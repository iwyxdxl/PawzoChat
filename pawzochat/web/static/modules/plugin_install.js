/*!
 * PawzoChat - Human-like, versatile, extensible AI companion engine
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* Plugin distribution UI. Server task state is authoritative; SSE is a hint. */
import { esc, escAttr, iconHtml } from "./utils.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { toast, showSheet, closeOverlay } from "./ui.js";

const _tasks = new Map();
const _pollTimers = new Map();
const _polling = new Map();
const _submitting = new Set();
const _checks = new Map();
const _removedPlugins = new Set();
let _updateEpoch = 0;
let _updates = {};
let _detail = null;
let _starting = false;
let _sourceDraft = "";
let _restored = false;
const _terminal = new Set(["succeeded", "error", "cancelled", "expired"]);
const _storageKey = "pawzo_plugin_tasks_v1";
const _arg = value => escAttr(JSON.stringify(String(value)));
const _local = () => !window.PAWZOCHAT_BASE && !state.settings?.is_public;
const _phases = {
  queued: "准备中", fetch_index: "准备中", download: "下载中",
  verify: "检查中", extract: "准备中", ready: "等待确认",
  prepare: "准备中", switch: "安装中", validate: "检查中",
  restore: "恢复中", committing: "安装中", succeeded: "已完成",
  error: "操作失败", cancelled: "已取消", expired: "预览已过期",
};
const _linkError = "链接无法识别，请使用作者提供的安装链接。";
const _packageError = "安装包检查未通过，请重新下载或联系作者。";
const _trustWarning = "无法确认此更新来自原作者，请确认来源可信后继续。";
const _errorMessages = {
  not_json: _linkError, not_plugin_index: _linkError, missing_field: _linkError,
  bad_field: "插件信息有误，请重新获取或联系作者。",
  checksum_mismatch: _packageError, unsafe_archive: _packageError,
  signature_invalid: _packageError, signature_malformed: _packageError,
  id_mismatch: _packageError, version_mismatch: _packageError,
  index_too_new: "请先更新 PawzoChat。", incompatible: "请先更新 PawzoChat。",
  platform_unsupported: "此插件不支持当前系统。",
  platform_invalid: "插件信息有误，请重新安装。",
  stale_preview: "插件已更新，请重新获取插件。",
  task_expired: "预览已过期，请重新获取插件。",
  invalid_trust_token: "确认已过期，请重新获取插件。",
  task_not_ready: "插件尚未准备好，请稍后重试。",
  task_conflict: "还有操作未完成，请稍后再试。",
  plugin_busy: "插件正在使用，请稍后再试。",
  conflict: "此版本暂时无法安装，请重新获取插件或联系作者。",
  download_too_large: "安装包太大，请联系插件作者。",
  bad_response: "暂时无法下载，请检查网络或稍后重试。",
  invalid_settings: "当前设置不适用于此版本，请检查设置或联系作者。",
  recovery_required: "插件暂时无法使用，请重启 PawzoChat 后重试。",
  service_stopping: "PawzoChat 正在准备中，请稍后重试。",
  upgrade_failed_rolled_back: "更新未完成，已恢复原来的插件和数据。",
  operation_failed: "操作未完成，请重试或联系插件作者。",
  pubkey_changed: _trustWarning, signature_missing: _trustWarning,
  not_found: "未找到插件或安装记录，请刷新后重试。",
  local_only: "请在本机打开 PawzoChat 后操作。",
  same_origin_required: "请从 PawzoChat 页面重新操作。",
  cancelled: "已取消。",
};

function _message(data, fallback = "操作未完成，请稍后重试。") {
  const code = typeof data === "string" ? data : data?.code || data?.error?.code || data?.error;
  // Server diagnostics remain available through the API, not in routine UI.
  return Object.hasOwn(_errorMessages, code) ? _errorMessages[code]
    : data instanceof Error && Object.values(_errorMessages).includes(data.message) ? data.message : fallback;
}
export { _message as pluginErrorMessage };
export function pluginSyncInstalled(plugins) {
  // An authoritative list can discover a manual reinstall in this session.
  for (const plugin of plugins) _removedPlugins.delete(plugin.id);
}
export function pluginForgetUninstalled(pluginId) {
  _removedPlugins.add(pluginId);
  _updateEpoch++;
  _checks.clear();
  delete _updates[pluginId];
  if (_detail?.id === pluginId) _detail = null;
  for (const [id, task] of _tasks) {
    if ((task.plugin_id || task.manifest?.id || task.conflict?.plugin_id) !== pluginId) continue;
    _tasks.delete(id);
    clearTimeout(_pollTimers.get(id));
    _pollTimers.delete(id);
    _submitting.delete(id);
  }
  _saveTasks();
  _renderTaskCards();
  _paintUpdates();
}
function _sourceDomain(url) {
  try { return new URL(url).hostname; } catch (_) { return "插件作者提供的来源"; }
}
function _bytes(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const unit = n < 1024 ** 2 ? "KB" : n < 1024 ** 3 ? "MB" : "GB";
  return `${(n / (unit === "KB" ? 1024 : unit === "MB" ? 1024 ** 2 : 1024 ** 3)).toFixed(1)} ${unit}`;
}
function _saveTasks() {
  try {
    const ids = [..._tasks.values()].filter(task => !_terminal.has(task.status)).map(task => task.task_id).slice(-24);
    if (ids.length) sessionStorage.setItem(_storageKey, JSON.stringify(ids));
    else sessionStorage.removeItem(_storageKey);
  } catch (_) { /* optional persistence */ }
}
function _restoreTasks() {
  if (_restored || !_local()) return;
  _restored = true;
  try {
    const ids = JSON.parse(sessionStorage.getItem(_storageKey) || "[]");
    if (Array.isArray(ids)) for (const id of ids.slice(-24)) {
      if (typeof id === "string" && /^[a-f0-9-]{32,36}$/i.test(id)) {
        _tasks.set(id, { task_id: id, status: "queued", _restoring: true });
        _queryTask(id);
      }
    }
  } catch (_) { /* stale browser storage */ }
}
function _progress(task) {
  const pct = Number.isFinite(task.progress) ? Math.max(0, Math.min(100, Math.round(task.progress * 100))) : null;
  return `<div class="plugin-progress ${pct == null ? "is-indeterminate" : ""}" role="progressbar" aria-label="插件安装进度" ${pct == null ? "" : `aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"`}><span style="width:${pct == null ? 36 : pct}%"></span></div>
    <div class="plugin-progress-caption"><span>${esc(task.cancel_requested ? "正在取消…" : (_phases[task.phase] || _phases[task.status] || "处理中"))}</span><span>${esc(pct == null ? _bytes(task.received_bytes) : `${pct}%`)}</span></div>`;
}

function pluginAddIcon() {
  return `<svg class="plugin-add-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
}
export function pluginListActionsMarkup() {
  return `${_local() ? `<div class="card plugin-list-actions" role="group" aria-label="插件操作">
    <button type="button" id="plugin-check-all" onclick="PawzoChat.pluginCheckUpdates()" ${_checks.has("*") ? "disabled" : ""}>${_checkButtonContent()}</button>
    <button type="button" onclick="PawzoChat.pluginShowInstall()">${pluginAddIcon()}<span>添加插件</span></button>
  </div>${pluginTaskListMarkup()}` : ""}<div class="plugin-list-heading">已安装插件</div>`;
}
function _checkButtonContent() {
  return `${iconHtml("ri-download-cloud-2-line")}<span>${_checks.has("*") ? "正在检查…" : "检查更新"}</span>`;
}
export function pluginShowInstall() {
  if (!_local()) return;
  showSheet(`<div class="plugin-sheet">
    <div class="sheet-title">添加插件</div>
    <div class="plugin-section-heading"><span class="row-icon primary">${iconHtml("ri-download-cloud-2-line")}</span><div><h2>从链接安装</h2><p>粘贴插件作者提供的安装链接</p></div></div>
    <form class="plugin-url-form" onsubmit="event.preventDefault();PawzoChat.pluginStartPreview()">
      <label class="plugin-sr-only" for="plugin-source-url">插件安装链接</label>
      <input id="plugin-source-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" required placeholder="粘贴安装链接" value="${escAttr(_sourceDraft)}" oninput="PawzoChat.pluginSourceInput(this.value)">
      <button type="submit" class="btn-primary" id="plugin-preview-start" ${_starting ? "disabled" : ""}>${_starting ? "正在获取…" : "获取插件"}</button>
    </form>
    <section class="plugin-manual-install">
      <div class="plugin-section-heading"><span class="row-icon primary">${iconHtml("ri-folder-open-line")}</span><div><h2>手动安装</h2></div></div>
      <p class="plugin-caption">将插件文件夹放入 <code>data/plugins/</code> 后点击插件页右上角刷新。</p>
    </section>
    <button type="button" class="btn-secondary plugin-close-button" onclick="PawzoChat.closeOverlay()">取消</button>
  </div>`);
}
export function pluginTaskListMarkup() {
  return _local() ? `<div id="plugin-task-list"></div>` : "";
}
export function pluginSourceMarkup(plugin) {
  if (!_local()) return "";
  const sourceError = plugin.source_error || plugin.source_type === "invalid";
  const sourceUrl = plugin.source_url || plugin.source?.source_url;
  const sourceText = sourceError ? "暂时无法确认插件来源，无法检查更新。请联系插件作者。"
    : sourceUrl ? _sourceDomain(sourceUrl) : "本地安装";
  return `<div class="plugin-meta-row plugin-detail-source">
    <span class="plugin-meta-label">来源</span>
    <span${sourceError ? ' class="plugin-tone-danger"' : ""}>${esc(sourceText)}</span>
  </div>`;
}
export function pluginDetailUpdateMarkup(plugin) {
  if (!_local() || plugin.source_error || plugin.source_type === "invalid"
      || !(plugin.source_url || plugin.source?.source_url)) return "";
  return `<div class="form-group" id="plugin-update-controls">${_updateControlsContent(plugin)}</div>`;
}
export function pluginUpdateBadge(pluginId) {
  const update = _updates[pluginId];
  return !_local() || !update?.has_update ? "" : `<span class="plugin-update-badge">${update.platform_compatible === false ? "新版不支持此系统" : update.compatible === false ? "需更新 PawzoChat" : "有更新"}</span>`;
}
function _updateControlsContent(p) {
  const update = _updates[p.id];
  const checking = _checks.has(p.id) || _checks.has("*");
  const updateText = update?.error ? _message(update, "检查更新失败")
    : update?.has_update ? update.platform_compatible === false ? "新版不支持当前系统" : `可更新至 v${update.latest || ""}${update.compatible === false ? " · 需要更新 PawzoChat" : ""}`
    : update ? "已是最新版本" : "";
  return `<div class="form-row plugin-update-row">
      <div class="plugin-update-copy">
        <span class="plugin-update-label">检查更新</span>
        ${!checking && updateText ? `<p class="plugin-caption ${update?.error ? "plugin-tone-danger" : ""}" role="status">${esc(updateText)}</p>` : ""}
      </div>
      <div class="plugin-update-buttons">
        <button type="button" class="btn-outline btn-sm plugin-action-button" onclick="PawzoChat.pluginCheckUpdates(${_arg(p.id)})" ${checking ? "disabled" : ""}>${checking ? "检查中…" : "检查更新"}</button>
        ${update?.has_update ? `<button type="button" class="btn-primary btn-sm plugin-action-button" onclick="PawzoChat.pluginPreviewUpgrade(${_arg(p.id)})" ${update.compatible === false || _starting ? "disabled" : ""}>更新</button>` : ""}
      </div>
    </div>
    ${update?.trust_required ? `<p class="form-hint plugin-tone-danger">${_trustWarning}</p>` : ""}`;
}
export function pluginInstallMount(plugin = null) {
  if (!_local()) return;
  if (plugin) _removedPlugins.delete(plugin.id);
  _detail = plugin;
  _restoreTasks();
  _renderTaskCards();
  if (!plugin || ((plugin.source_url || plugin.source?.source_url)
      && !plugin.source_error && plugin.source_type !== "invalid")) {
    pluginCheckUpdates(plugin?.id, false);
  }
}
function _paintUpdates() {
  document.querySelectorAll("[data-plugin-update]").forEach(el => { el.innerHTML = pluginUpdateBadge(el.dataset.pluginUpdate); });
  const controls = document.getElementById("plugin-update-controls");
  if (controls && _detail) controls.innerHTML = _updateControlsContent(_detail);
  const button = document.getElementById("plugin-check-all");
  if (button) { button.disabled = _checks.has("*"); button.innerHTML = _checkButtonContent(); }
}
export async function pluginCheckUpdates(pluginId, force = true) {
  if (!_local() || _removedPlugins.has(pluginId)) return;
  const key = pluginId || "*";
  if (_checks.has(key)) return;
  const checkToken = Symbol(key), epoch = _updateEpoch;
  _checks.set(key, checkToken); _paintUpdates();
  try {
    const url = pluginId ? `/api/plugins/${encodeURIComponent(pluginId)}/updates` : "/api/plugins/updates";
    // Avoid joining an older API-cache in-flight request after an installation.
    const response = await fetch(url + (force ? "?force=1" : ""), { cache: "no-store" });
    const data = await response.json();
    if (epoch !== _updateEpoch) return;
    if (!response.ok && !pluginId) throw new Error(_message(data));
    if (pluginId) _updates[pluginId] = data;
    else {
      if (data.error) throw new Error(_message(data));
      _updates = data.updates || {};
      for (const id of _removedPlugins) delete _updates[id];
    }
    if (force) {
      const results = pluginId ? [data] : Object.values(_updates);
      const errors = results.filter(v => v.error);
      const count = results.filter(v => v.has_update).length;
      toast(errors.length ? `${errors.length} 个插件暂时无法检查更新` : count ? `发现 ${count} 个插件有更新` : "已检查，暂无可用更新", errors.length ? "error" : count ? "success" : "info");
    }
  } catch (e) { if (force) toast(_message(e, "暂时无法检查更新，请稍后重试。"), "error"); }
  finally { if (_checks.get(key) === checkToken) _checks.delete(key); _paintUpdates(); }
}
export function pluginSourceInput(value) { _sourceDraft = value; }
export async function pluginStartPreview(sourceUrl) {
  if (!_local() || _starting) return;
  const value = (sourceUrl || document.getElementById("plugin-source-url")?.value || _sourceDraft).trim();
  try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); }
  catch (_) { toast("请输入有效的插件安装链接", "error"); return; }
  _sourceDraft = value; _starting = true;
  const button = document.getElementById("plugin-preview-start");
  if (button) { button.disabled = true; button.textContent = "正在获取…"; }
  try {
    const res = await api.post("/api/plugins/install/preview", { url: value });
    if (res.status >= 400 || !res.data.task_id) throw new Error(_message(res.data));
    const id = res.data.task_id;
    _tasks.set(id, { task_id: id, status: "queued", source: { source_url: value } });
    _saveTasks(); _renderTaskCards(); pluginOpenTask(id);
  } catch (e) { toast(_message(e, "暂时无法获取插件信息，请稍后重试。"), "error"); }
  finally {
    _starting = false;
    const currentButton = document.getElementById("plugin-preview-start");
    if (currentButton) { currentButton.disabled = false; currentButton.textContent = "获取插件"; }
  }
}
export async function pluginPreviewUpgrade(pluginId) {
  if (!_local() || _starting) return;
  let p = _detail?.id === pluginId ? _detail : null;
  if (!p) {
    try { p = await api.get(`/api/plugins/${encodeURIComponent(pluginId)}`, { bypassCache: true }); }
    catch (_) { toast("暂时无法获取插件信息，请稍后重试。", "error"); return; }
  }
  const source = p?.source_url || p?.source?.source_url;
  if (!source) { toast("请粘贴插件作者提供的安装链接", "info"); return; }
  pluginStartPreview(source);
}

function _scheduleTask(id) {
  clearTimeout(_pollTimers.get(id));
  const task = _tasks.get(id);
  if (!task || _terminal.has(task.status)) { _pollTimers.delete(id); return; }
  _pollTimers.set(id, setTimeout(() => _queryTask(id), task.status === "ready" && !_submitting.has(id) ? 15000 : 1500));
}
function _acceptTask(id, data) {
  const previous = _tasks.get(id);
  if (!previous) return;
  // A GET started before confirmation may arrive after a newer snapshot.
  if (previous.status === "committing" && ["queued", "running", "ready"].includes(data.status)) return;
  const next = { ...previous, ...data, task_id: id, _restoring: false, _connectionError: "" };
  _tasks.set(id, next);
  if (_terminal.has(next.status)) {
    _finishTask(next, previous._restoring);
    return;
  }
  _renderTaskCards(); _paintTaskSheet(id); _scheduleTask(id);
}
function _finishTask(task, restoring) {
  const id = task.task_id;
  const currentSheet = document.getElementById("plugin-task-sheet")?.dataset.taskId === id;
  const visibleSheet = currentSheet && document.getElementById("action-sheet")?.classList.contains("show");
  // Keep a failed preview's retry link in the open sheet, without retaining a
  // task history. Late responses cannot recreate a task once it leaves the map.
  _paintTaskSheet(id);
  _tasks.delete(id);
  clearTimeout(_pollTimers.get(id)); _pollTimers.delete(id);
  _saveTasks(); _renderTaskCards();
  if (currentSheet && ["succeeded", "cancelled"].includes(task.status)) closeOverlay();
  if (task.status === "succeeded") {
    _removedPlugins.delete(task.plugin_id || task.manifest?.id || task.result?.plugin?.id);
    if (!restoring) toast(task.operation === "upgrade" || task.conflict ? "插件已升级" : "插件安装完成，请手动启用", "success");
    if (_sourceDraft === task.source?.source_url && !document.getElementById("plugin-source-url")) _sourceDraft = "";
    _updateEpoch++; _updates = {}; _checks.clear();
    window.dispatchEvent(new CustomEvent("pawzo:plugins-changed", { detail: { plugin_id: task.plugin_id || task.manifest?.id } }));
    pluginCheckUpdates(undefined, false);
  } else if (!restoring && task.status === "cancelled") {
    toast("已取消", "info");
  } else if (!restoring && !visibleSheet && ["error", "expired"].includes(task.status)) {
    toast(_message(task.error || { code: task.status === "expired" ? "task_expired" : "operation_failed" }), "error");
  }
}
async function _queryTask(id) {
  if (!_tasks.has(id) || !_local()) return;
  if (_polling.has(id)) return _polling.get(id);
  const request = (async () => {
    try {
      const res = await fetch(`/api/plugins/tasks/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await res.json();
      if (res.status === 404 || res.status === 410) {
        _acceptTask(id, { status: "expired", phase: "expired", error: { code: "task_expired" } });
      } else if (!res.ok) throw new Error(_message(data, "查询任务失败"));
      else _acceptTask(id, data);
    } catch (_) {
      const task = _tasks.get(id);
      if (task) { task._connectionError = "连接暂时中断，正在重连，请稍候。"; _renderTaskCards(); _paintTaskSheet(id); }
    } finally { _polling.delete(id); _scheduleTask(id); }
  })();
  _polling.set(id, request);
  return request;
}
async function _refreshTask(id) {
  // A mutation response must not join a GET whose snapshot predates it.
  const pending = _polling.get(id);
  if (pending) await pending;
  return _queryTask(id);
}
export function onPluginTaskProgress(data) {
  if (!_local() || !_tasks.has(data.task_id)) return;
  const task = _tasks.get(data.task_id);
  if (_terminal.has(task.status)) return;
  // A delayed SSE payload cannot move a completed task backwards.
  if (!["ready", "committing"].includes(task.status)) {
    for (const field of ["phase", "progress", "received_bytes", "cancel_requested"]) if (field in data) task[field] = data[field];
    _renderTaskCards(); _paintTaskSheet(data.task_id);
  }
  if (data.status && (data.status !== task.status || ["ready", "committing"].includes(data.status))) _refreshTask(data.task_id);
}
export function onPluginUpdatesAvailable(data) {
  if (!_local()) return;
  _updates = { ..._updates, ...Object.fromEntries(Object.entries(data.updates || {}).filter(([id]) => !_removedPlugins.has(id))) }; _paintUpdates();
}
export function pluginReconnect() {
  if (!_local()) return;
  _restoreTasks();
  for (const [id, task] of _tasks) if (!_terminal.has(task.status)) _queryTask(id);
  if (state.pageStack.at(-1)?.name?.startsWith("plugin")) pluginCheckUpdates(undefined, false);
}
function _renderTaskCards() {
  const host = document.getElementById("plugin-task-list");
  if (!host || !_local()) return;
  host.innerHTML = [..._tasks.values()].reverse().map(task => {
    const busy = ["queued", "running", "committing"].includes(task.status) || _submitting.has(task.task_id);
    const label = task._restoring ? "正在查看进度…" : task._connectionError ? "等待重新连接" : task.status === "ready" ? "已准备好，等待确认" : _phases[task.status] || "处理中";
    return `<article class="card plugin-task-card"><button class="plugin-task-summary" onclick="PawzoChat.pluginOpenTask(${_arg(task.task_id)})">
      <span class="row-icon primary">${iconHtml("ri-download-cloud-2-line")}</span><span class="plugin-task-copy"><strong>${esc(task.manifest?.name || task.manifest?.id || task.plugin_id || "插件安装")}</strong><span>${esc(label)}</span></span>${iconHtml("ri-arrow-right-s-line")}</button>
      ${busy ? `<div class="plugin-task-progress">${_progress(task)}</div>` : ""}
    </article>`;
  }).join("");
}
function _taskContent(task) {
  const id = task.task_id, m = task.manifest || task.result?.plugin?.manifest || task.result?.plugin || {}, source = task.source || {};
  const ready = task.status === "ready" && !_submitting.has(id);
  const done = _terminal.has(task.status);
  const busy = !done && (["queued", "running", "committing"].includes(task.status) || _submitting.has(id));
  const upgrading = task.operation === "upgrade" || !!task.conflict;
  const title = upgrading ? "升级插件" : "安装插件";
  const trust = task._trust;
  const error = task.error || task._actionError || (task.status === "expired" ? { code: "task_expired" } : task.status === "error" ? { code: "operation_failed" } : null);
  return `<div class="plugin-sheet" id="plugin-task-sheet" data-task-id="${escAttr(id)}">
    <div class="sheet-title">${esc(title)}</div>
    <div class="plugin-preview-title"><span class="row-icon primary">${iconHtml("ri-plug-line")}</span><div><h3>${esc(m.name || m.id || task.plugin_id || (done ? "插件安装" : "正在获取插件信息"))}</h3><p>${esc(task.conflict?.installed_version ? `v${task.conflict.installed_version} → v${m.version || ""}` : m.version ? `v${m.version}` : done ? "" : "准备好后即可确认安装")}</p></div></div>
    ${busy ? `<div class="plugin-sheet-progress" aria-live="polite">${_progress(task)}</div>` : ""}
    ${task._connectionError ? `<p class="plugin-note" role="status">${esc(task._connectionError)}</p>` : ""}
    ${m.description ? `<p class="plugin-preview-description">${esc(m.description)}</p>` : ""}
    ${source.source_url ? `<div class="plugin-preview-field"><span>安装来源</span><div class="plugin-source-address">${esc(_sourceDomain(source.source_url))}</div></div>` : ""}
    ${ready ? `<p class="plugin-caption">${upgrading ? "升级后保留当前设置和数据。" : "安装后需手动启用。"}</p>
      ${task.conflict?.source_type === "local" ? `<p class="plugin-note">以后可通过此来源检查更新。</p>` : ""}
      ${task.platform_compatible === false ? `<p class="plugin-alert" role="alert">此插件不支持当前系统。</p>` : task.compatible === false ? `<p class="plugin-alert" role="alert">请先更新 PawzoChat${source.min_app_version ? ` 至 ${esc(source.min_app_version)} 或更高版本` : ""}。</p>` : ""}
      ${(source.changelog || task.changelog) ? `<div class="plugin-preview-field"><span>更新内容</span><p class="plugin-changelog">${esc(source.changelog || task.changelog)}</p></div>` : ""}` : ""}
    ${error ? `<p class="plugin-alert" role="alert">${esc(_message(error))}</p>` : ""}
    ${trust && ready ? `<p class="plugin-trust" role="alert">${_trustWarning}</p>` : ""}
    ${task.status === "succeeded" ? `<p class="plugin-note plugin-note-success">${upgrading ? "插件已升级，当前设置和数据已保留。" : "插件已安装，请在插件详情中手动启用。"}</p>` : ""}
    ${task.status === "cancelled" ? `<p class="plugin-caption">已取消安装。</p>` : ""}
    <div class="plugin-sheet-actions">
      ${ready ? `<button class="btn-primary" onclick="PawzoChat.pluginConfirmTask(${_arg(id)},${trust ? "true" : "false"})" ${task.compatible === false || task.cancel_requested || task._actionError?.code === "stale_preview" ? "disabled" : ""}>${trust ? "确认来源并继续" : upgrading ? `确认升级到 v${esc(m.version || "")}` : "确认安装"}</button>` : ""}
      ${["queued", "running", "ready"].includes(task.status) && !_submitting.has(id) ? `<button class="btn-outline" onclick="PawzoChat.pluginCancelTask(${_arg(id)})" ${task.cancel_requested ? "disabled" : ""}>${task.cancel_requested ? "正在取消…" : "取消"}</button>` : ""}
      ${done || task._actionError?.code === "stale_preview" ? `${source.source_url && task.status !== "succeeded" ? `<button class="btn-outline" onclick="PawzoChat.pluginStartPreview(${_arg(source.source_url)})">重新获取插件</button>` : ""}` : ""}
      <button class="btn-text" onclick="PawzoChat.closeOverlay()">${done ? "关闭" : "收起，稍后查看"}</button>
    </div></div>`;
}
export function pluginOpenTask(id) {
  const task = _tasks.get(id);
  if (!task || !_local()) return;
  showSheet(_taskContent(task));
  if (!_terminal.has(task.status)) _queryTask(id);
}
function _paintTaskSheet(id) {
  const sheet = document.getElementById("plugin-task-sheet");
  if (sheet?.dataset.taskId !== id) return;
  const task = _tasks.get(id);
  if (task) sheet.outerHTML = _taskContent(task);
}
export async function pluginCancelTask(id) {
  const task = _tasks.get(id);
  if (!task || task.cancel_requested || _submitting.has(id) || !_local()) return;
  task.cancel_requested = true; _paintTaskSheet(id); _renderTaskCards();
  try {
    const res = await api.post("/api/plugins/install/cancel", { task_id: id });
    if (res.status >= 400) { task.cancel_requested = false; toast(_message(res.data), "error"); }
    if (res.data.status === "cancelled") _acceptTask(id, { status: "cancelled", phase: "cancelled" });
    await _refreshTask(id);
  } catch (_) { task.cancel_requested = false; toast("暂时无法确认是否取消，请稍后重试。", "error"); _queryTask(id); }
}
export async function pluginConfirmTask(id, trust = false) {
  const task = _tasks.get(id);
  if (!task || !_local() || _submitting.has(id) || task.status !== "ready" || task.compatible === false || task.cancel_requested) return;
  const body = { task_id: id };
  if (trust) { if (!task._trust?.trust_token) return; body.trust_token = task._trust.trust_token; }
  const pluginId = task.conflict?.plugin_id || task.manifest?.id;
  const endpoint = task.conflict ? `/api/plugins/${encodeURIComponent(pluginId)}/upgrade` : "/api/plugins/install";
  task._actionError = null; _submitting.add(id); _paintTaskSheet(id); _renderTaskCards();
  // Keep querying while a synchronous commit is in flight, so long setup() calls
  // do not freeze progress or require a second submission.
  _scheduleTask(id);
  try {
    const res = await api.post(endpoint, body);
    if (res.status >= 400) {
      if (["pubkey_changed", "signature_missing"].includes(res.data.error) && res.data.trust_token) task._trust = res.data;
      else task._actionError = { code: res.data.error, message: _message(res.data) };
    } else if (res.status !== 202) {
      _acceptTask(id, { status: "succeeded", phase: "succeeded", result: res.data, operation: task.conflict ? "upgrade" : "install" });
    }
  } catch (_) { task._connectionError = "连接中断，正在查看安装结果，请稍候。"; }
  finally {
    _submitting.delete(id);
    // Keep the challenge/action failure when applying the authoritative snapshot.
    const current = _tasks.get(id);
    if (current) { current._trust = task._trust; current._actionError = task._actionError; }
    await _refreshTask(id); _paintTaskSheet(id); _renderTaskCards();
  }
}
