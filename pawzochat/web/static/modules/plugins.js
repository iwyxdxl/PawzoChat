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
import { esc, iconHtml } from "./utils.js";
import { api } from "./api.js";
import { toast, showLoading, hideLoading, confirm } from "./ui.js";
import { state } from "./state.js";
import {
  pluginListActionsMarkup, pluginSourceMarkup, pluginDetailUpdateMarkup,
  pluginTaskListMarkup, pluginUpdateBadge, pluginInstallMount, pluginErrorMessage,
  pluginForgetUninstalled, pluginSyncInstalled,
} from "./plugin_install.js";
import {
  setTopBar, goBack,
  registerPageRenderer,
} from "./navigation.js";

const content = () => document.getElementById("content-area");

let _pluginsCache = [];
let _currentPlugin = null;
let _renderRequest = 0;
let _uninstallPending = false;
let _uninstalling = false;

function _startRender() {
  const page = state.pageStack.at(-1);
  const request = ++_renderRequest;
  return () => request === _renderRequest && state.pageStack.at(-1) === page;
}

const _STATUS_LABELS = {
  active: "运行中",
  disabled: "已停用",
  broken: "异常",
  discovered: "已发现",
  unsupported: "不支持此系统",
};

const _PERMISSION_LABELS = {
  "messaging.send": "主动发送消息",
  "mcp.read": "读取 MCP 工具",
  "mcp.invoke": "调用 MCP 工具",
  "mcp.publish": "向 LLM 暴露新工具",
};

let _iframeMessageHandler = null;

function _statusBadge(status, platformError) {
  const label = platformError === "platform_invalid" ? "信息有误" : _STATUS_LABELS[status] || status;
  const cls = `plugin-status-${status === "active" ? "active" : status === "broken" ? "broken" : "disabled"}`;
  return `<span class="plugin-status ${cls}">${esc(label)}</span>`;
}

/* ============ Plugin List Page ============ */

async function renderPluginList() {
  const isCurrent = _startRender();
  _currentPlugin = null;
  _detachIframeHandler();
  setTopBar("插件管理", true,
    `<button class="top-btn plugin-refresh-btn" onclick="PawzoChat.pluginRefresh()" title="刷新插件列表" aria-label="刷新插件列表">
      ${iconHtml("ri-refresh-line")}
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    // A post-uninstall render must not join a GET started before deletion.
    const response = await fetch(`${window.PAWZOCHAT_BASE || ""}/api/plugins`, { cache: "no-store" });
    if (!response.ok) throw new Error("Plugin list unavailable");
    const res = await response.json();
    if (!isCurrent()) return;
    _pluginsCache = res.plugins || [];
  } catch (e) {
    if (!isCurrent()) return;
    toast("加载插件列表失败", "error");
    return;
  }

  _renderPluginListBody();
}

function _renderPluginListBody() {
  pluginSyncInstalled(_pluginsCache);
  const warning = `<div class="plugin-warning">
    ${iconHtml("ri-error-warning-line")}
    <span>安装第三方插件等同于在本机执行不受限的代码，请确认插件来源可信后再启用。PawzoChat 不对第三方插件的安全性负责，使用风险自负。</span>
  </div>`;

  if (_pluginsCache.length === 0) {
    content().innerHTML = `<div class="page plugin-page">
      ${warning}${pluginListActionsMarkup()}
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;opacity:.4">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-2h2v2zm0-4H9V7h2v5zm4 4h-2v-2h2v2zm0-4h-2V7h2v5z"/>
        </svg>
        <div class="empty-text">暂无已安装的插件</div>
        <div style="font-size:13px;color:var(--text-3);margin-top:8px;max-width:280px;text-align:center;line-height:1.5">
          ${window.PAWZOCHAT_BASE || state.settings?.is_public ? "请在本机打开 PawzoChat 安装插件。" : "点击「添加插件」，添加第一个插件。"}
        </div>
      </div>
    </div>`;
    pluginInstallMount();
    return;
  }

  const cards = _pluginsCache.map(p => {
    const desc = p.description
      ? `<div style="font-size:12px;color:var(--text-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.description)}</div>`
      : "";
    const parts = [];
    if (p.author) parts.push(p.author);
    parts.push(`v${p.version}`);
    const meta = parts.join(" · ");

    return `<div class="card" style="margin:8px 16px">
      <div class="card-row" onclick="PawzoChat.pushPage('pluginDetail','${esc(p.id)}')">
        <div class="row-icon orange">${iconHtml("ri-plug-line")}</div>
        <div style="flex:1;min-width:0">
          <div class="plugin-card-title">
            <span style="font-size:14px;font-weight:500">${esc(p.name)}</span>
            ${_statusBadge(p.status, p.platform_error)}
            <span data-plugin-update="${esc(p.id)}">${pluginUpdateBadge(p.id)}</span>
          </div>
          ${desc}
          <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(meta)}</div>
        </div>
        ${iconHtml("ri-arrow-right-s-line", "plugin-row-arrow")}
      </div>
    </div>`;
  }).join("");

  content().innerHTML = `<div class="page plugin-page">${warning}${pluginListActionsMarkup()}${cards}</div>`;
  pluginInstallMount();
}

/* ============ Plugin Detail Page ============ */

async function renderPluginDetail(pluginId) {
  const isCurrent = _startRender();
  _detachIframeHandler();
  setTopBar("插件详情", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const plugin = await api.get(`/api/plugins/${pluginId}`, { bypassCache: true });
    if (!isCurrent()) return;
    _currentPlugin = plugin;
    if (_currentPlugin.error) {
      toast("插件未找到", "error");
      goBack();
      return;
    }
  } catch (e) {
    if (!isCurrent()) return;
    toast("加载插件详情失败", "error");
    goBack();
    return;
  }

  _renderPluginDetailBody();
}

function _renderPluginDetailBody() {
  // Detach any prior iframe handler before re-rendering — re-attached below
  // when the new iframe (if any) loads.
  _detachIframeHandler();

  const p = _currentPlugin;
  if (!p) return;

  const m = p.manifest || {};
  const schema = m.config_schema || {};
  const settings = p.settings || {};
  const configUi = m.config_ui || {};
  const useCustomUi = !!configUi.entry;

  const desc = m.description
    ? `<div style="font-size:13px;color:var(--text-2);margin-top:4px;line-height:1.5">${esc(m.description)}</div>`
    : "";
  const errorBlock = p.platform_compatible === false
    ? `<div class="plugin-error">${p.platform_error === "platform_invalid" ? "插件信息有误，请重新安装。" : "此插件不支持当前系统。"}</div>`
    : p.last_error
    ? `<div class="plugin-error">插件暂时无法正常运行，请尝试重新加载或联系作者。</div>`
    : "";

  const metaRows = [];
  if (m.author) metaRows.push(_metaRow("作者", esc(m.author)));
  const sourceMarkup = pluginSourceMarkup(p);
  if (sourceMarkup) metaRows.push(sourceMarkup);
  const advancedRows = [_metaRow("API 版本", esc(m.api_version || 1))];
  if ((m.hooks || []).length)
    advancedRows.push(_metaRow("Hooks", m.hooks.map(h => `<code>${esc(h)}</code>`).join(" ")));
  if ((m.depends_on || []).length)
    advancedRows.push(_metaRow("依赖", m.depends_on.map(d => esc(d)).join(", ")));
  const perms = m.permissions || [];
  if (perms.length) {
    const items = perms.map(perm => {
      const label = _PERMISSION_LABELS[perm] || perm;
      return `<code title="${esc(label)}">${esc(perm)}</code>`;
    }).join(" ");
    advancedRows.push(_metaRow("权限", items));
  }

  const hasSchemaFields = schema.type === "object" && schema.properties
    && Object.keys(schema.properties).length > 0;

  const providedTools = Array.isArray(p.provided_tools) ? p.provided_tools : [];
  const toolsSection = providedTools.length === 0
    ? ""
    : `<div class="plugin-advanced-tools">
        <div class="card-header">该插件提供的 LLM 工具</div>
        ${providedTools.map(t => {
          const desc = t.description
            ? `<div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(t.description)}</div>`
            : "";
          return `<div style="padding:10px 16px;border-top:1px solid var(--border)">
            <div style="font-family:var(--mono-font,monospace);font-size:12px;color:var(--text-2);word-break:break-all">${esc(t.name)}</div>
            ${desc}
          </div>`;
        }).join("")}
      </div>`;

  let configSection = "";
  if (useCustomUi) {
    const src = p.config_ui_url;
    configSection = `
      <div class="card" style="margin:12px 16px 0">
        <div class="card-header">插件配置</div>
        <iframe id="plugin-config-frame"
          src="${esc(src)}"
          sandbox="allow-scripts"
          title="插件配置"
          style="width:100%;border:0;display:block;height:1px"></iframe>
      </div>`;
  } else if (hasSchemaFields) {
    configSection = `
      <div class="card" style="margin:12px 16px 0">
        <div class="card-header">插件配置</div>
        ${_renderSchemaForm(schema, settings)}
        <div style="padding:12px 16px;text-align:right">
          <button class="btn-primary btn-sm" onclick="PawzoChat.pluginSaveConfig('${esc(p.id)}')">保存配置</button>
        </div>
      </div>`;
  }

  content().innerHTML = `<div class="page plugin-page">
    <div class="card" style="margin:8px 16px">
      <div style="padding:16px">
        <div class="plugin-card-title">
          <span style="font-size:16px;font-weight:600">${esc(m.name || p.name)}</span>
          ${_statusBadge(p.status, p.platform_error)}
        </div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">v${esc(m.version || p.version)}</div>
        ${desc}
        ${errorBlock}
        ${metaRows.length ? `<div class="plugin-meta">${metaRows.join("")}</div>` : ""}
      </div>
    </div>
    <div class="card" style="margin:0 16px">
      <div class="form-group"><div class="form-row">
        <label>启用插件</label>
        <label class="switch-wrap">
          <input type="checkbox" id="plugin-enabled-toggle" ${p.enabled ? "checked" : ""}
            ${p.platform_compatible === false && !p.enabled ? 'disabled title="此插件无法在当前系统启用"' : ""}
            onchange="PawzoChat.pluginToggle('${esc(p.id)}',this.checked)">
          <span class="switch-track"></span>
        </label>
      </div></div>
      <div class="form-group"><div class="form-row">
        <label>重新加载</label>
        <button class="btn-outline btn-sm plugin-action-button" style="margin-left:auto" onclick="PawzoChat.pluginReload('${esc(p.id)}')">重新加载</button>
      </div></div>
      ${pluginDetailUpdateMarkup(p)}
    </div>
    ${pluginTaskListMarkup()}
    ${configSection}
    <details class="card plugin-advanced"><summary>高级信息</summary><div class="plugin-advanced-body">
      <div class="plugin-meta">${advancedRows.join("")}</div>
      ${p.last_error ? `<div class="plugin-error">${esc(p.last_error)}</div>` : ""}
      ${toolsSection}
    </div></details>
    ${window.PAWZOCHAT_BASE || state.settings?.is_public ? "" : `<div class="card plugin-uninstall-card">
      <button type="button" class="btn-text danger plugin-uninstall-button" id="plugin-uninstall-button">${iconHtml("ri-delete-bin-line")}<span>卸载插件</span></button>
      <p id="plugin-uninstall-error" class="plugin-uninstall-error" role="alert" hidden></p>
    </div>`}
  </div>`;

  document.getElementById("plugin-uninstall-button")?.addEventListener("click", () => pluginUninstall(p.id));
  if (useCustomUi) _attachIframeHandler(p, schema, settings);
  pluginInstallMount(p);
}

function _metaRow(label, value) {
  return `<div class="plugin-meta-row">
    <span class="plugin-meta-label">${esc(label)}</span>
    <span>${value}</span>
  </div>`;
}

/* ============ Schema Form Renderer ============ */

function _renderSchemaForm(schema, values) {
  if (!schema || schema.type !== "object" || !schema.properties) return "";
  const entries = Object.entries(schema.properties);
  entries.sort((a, b) => ((a[1].order ?? 999) - (b[1].order ?? 999)));
  return entries.map(([key, prop]) => _renderField(key, prop, values[key])).join("");
}

function _renderField(key, prop, value) {
  const type = prop.type || "string";
  const title = prop.title || key;
  const hint = prop.description
    ? `<div class="form-hint">${esc(prop.description)}</div>`
    : "";
  const ph = prop.placeholder ? ` placeholder="${esc(prop.placeholder)}"` : "";
  const da = `data-cfg-key="${esc(key)}" data-cfg-type="${esc(type)}"`;

  if (type === "boolean") {
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <label class="switch-wrap">
        <input type="checkbox" ${da} ${value ? "checked" : ""}>
        <span class="switch-track"></span>
      </label>
    </div>${hint}</div>`;
  }

  if (type === "string" && prop.enum) {
    const labels = prop.enum_labels || {};
    const opts = prop.enum.map(v => {
      const sel = v === value ? " selected" : "";
      return `<option value="${esc(v)}"${sel}>${esc(labels[v] || v)}</option>`;
    }).join("");
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <select ${da}>${opts}</select>
    </div>${hint}</div>`;
  }

  if (type === "string" && prop.secret) {
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <input type="password" ${da} value="${esc(value || "")}"${ph}>
    </div>${hint}</div>`;
  }

  if (type === "string" && prop.multiline) {
    return `<div class="form-group"><div class="form-row" style="flex-direction:column;align-items:stretch;gap:4px">
      <label>${esc(title)}</label>
      <textarea class="form-input" ${da} rows="4"${ph}>${esc(value || "")}</textarea>
    </div>${hint}</div>`;
  }

  if (type === "string") {
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <input type="text" ${da} value="${esc(value || "")}"${ph}>
    </div>${hint}</div>`;
  }

  if (type === "integer" || type === "number") {
    const min = prop.minimum != null ? ` min="${prop.minimum}"` : "";
    const max = prop.maximum != null ? ` max="${prop.maximum}"` : "";
    const step = type === "integer" ? ' step="1"' : ' step="any"';
    return `<div class="form-group"><div class="form-row">
      <label>${esc(title)}</label>
      <input type="number" ${da} value="${value != null ? value : ""}"${min}${max}${step}${ph}>
    </div>${hint}</div>`;
  }

  if (type === "array" && prop.items && prop.items.type === "string") {
    const lines = Array.isArray(value) ? value.join("\n") : "";
    const arrPh = ph || ` placeholder="每行一项"`;
    return `<div class="form-group"><div class="form-row" style="flex-direction:column;align-items:stretch;gap:4px">
      <label>${esc(title)}</label>
      <textarea class="form-input" ${da} data-cfg-array="lines" rows="4"${arrPh}>${esc(lines)}</textarea>
    </div>${hint}</div>`;
  }

  return `<div class="form-group"><div class="form-row">
    <label>${esc(title)}</label>
    <span class="readonly" style="font-size:13px;color:var(--text-3)">不支持的配置类型: ${esc(type)}</span>
  </div></div>`;
}

function _collectSettings() {
  const result = {};
  content().querySelectorAll("[data-cfg-key]").forEach(el => {
    const key = el.dataset.cfgKey;
    const type = el.dataset.cfgType;

    if (type === "boolean") {
      result[key] = el.checked;
    } else if (type === "integer") {
      result[key] = el.value === "" ? 0 : parseInt(el.value, 10);
    } else if (type === "number") {
      result[key] = el.value === "" ? 0 : parseFloat(el.value);
    } else if (type === "array" && el.dataset.cfgArray === "lines") {
      result[key] = el.value.split("\n").map(s => s.trim()).filter(Boolean);
    } else {
      result[key] = el.value;
    }
  });
  return result;
}

/* ============ Exported actions ============ */

export async function pluginUninstall(pluginId) {
  if (_uninstallPending || window.PAWZOCHAT_BASE || state.settings?.is_public || _currentPlugin?.id !== pluginId) return;
  const page = state.pageStack.at(-1);
  const plugin = _currentPlugin;
  _uninstallPending = true;
  let host;
  try {
    if (!await confirm("卸载插件", `确定卸载「${plugin.manifest?.name || plugin.name}」吗？插件文件、配置和插件目录内的数据将被永久删除，无法撤销。`, true, "卸载")) return;
    if (state.pageStack.at(-1) !== page) return;
    _uninstalling = true;
    ++_renderRequest;
    host = content().querySelector(".plugin-page");
    if (host) { host.inert = true; host.setAttribute("aria-busy", "true"); }
    const button = document.getElementById("plugin-uninstall-button");
    if (button) { button.disabled = true; button.querySelector("span").textContent = "正在卸载…"; }
    const error = document.getElementById("plugin-uninstall-error");
    if (error) error.hidden = true;
    showLoading("正在卸载…");
    const res = await api.del(`/api/plugins/${encodeURIComponent(pluginId)}`);
    if (res.status >= 400) {
      const message = res.data.error === "plugin_in_use" && res.data.dependents?.length
        ? `请先卸载依赖此插件的插件：${res.data.dependents.map(p => p.name || p.id).join("、")}`
        : res.data.error === "conflict" ? "插件目录或 ID 存在冲突，请检查本地目录后重试。"
        : pluginErrorMessage(res.data, "卸载失败，请稍后重试。");
      if (state.pageStack.at(-1) === page && error) { error.textContent = message; error.hidden = false; }
      toast(message, "error");
      return;
    }
    pluginForgetUninstalled(pluginId);
    _pluginsCache = _pluginsCache.filter(p => p.id !== pluginId);
    toast("插件已卸载", "success");
    if (state.pageStack.at(-1) === page) {
      _currentPlugin = null;
      _detachIframeHandler();
      goBack();
    } else if (state.pageStack.at(-1)?.name === "pluginList") {
      renderPluginList();
    }
  } catch (_) {
    toast("暂时无法确认卸载结果，请刷新插件列表后重试。", "error");
  } finally {
    if (host) { host.inert = false; host.removeAttribute("aria-busy"); }
    if (_uninstalling) hideLoading();
    _uninstalling = false;
    _uninstallPending = false;
    if (state.pageStack.at(-1) === page) {
      const button = document.getElementById("plugin-uninstall-button");
      if (button) { button.disabled = false; button.querySelector("span").textContent = "卸载插件"; }
    }
  }
}

export async function pluginToggle(pluginId, enabled) {
  if (_uninstalling) return;
  const page = state.pageStack.at(-1);
  const endpoint = enabled ? "enable" : "disable";
  showLoading("操作中…");
  try {
    const res = await api.post(`/api/plugins/${pluginId}/${endpoint}`, {});
    if (_uninstalling) return;
    if (res.status >= 400) {
      toast(pluginErrorMessage(res.data), "error");
      if (state.pageStack.at(-1) === page) _revertToggle();
      return;
    }
    toast(enabled ? "已启用" : "已停用", "success");

    if (state.pageStack.at(-1) === page && _currentPlugin?.id === pluginId) {
      _currentPlugin = res.data.plugin;
      _renderPluginDetailBody();
    }
  } catch (e) {
    toast("操作失败", "error");
    if (state.pageStack.at(-1) === page) _revertToggle();
  }
  finally { if (!_uninstalling) hideLoading(); }
}

function _revertToggle() {
  const el = document.getElementById("plugin-enabled-toggle");
  if (el) el.checked = !el.checked;
}

export async function pluginSaveConfig(pluginId) {
  if (_uninstalling) return;
  const page = state.pageStack.at(-1);
  const settings = _collectSettings();
  showLoading("保存中…");
  try {
    const res = await api.patch(`/api/plugins/${pluginId}/config`, { settings });
    if (_uninstalling) return;
    if (res.status >= 400) {
      toast(pluginErrorMessage(res.data, "保存失败，请检查设置后重试。"), "error");
      return;
    }
    toast("配置已保存", "success");
    if (state.pageStack.at(-1) !== page) return;
    _currentPlugin = res.data.plugin;
    _renderPluginDetailBody();
  } catch (e) {
    toast("保存失败", "error");
  }
  finally { if (!_uninstalling) hideLoading(); }
}

export async function pluginReload(pluginId) {
  if (_uninstalling) return;
  const page = state.pageStack.at(-1);
  showLoading("正在重新加载…");
  try {
    const res = await api.post(`/api/plugins/${pluginId}/reload`, {});
    if (_uninstalling) return;
    if (res.status >= 400) {
      toast(pluginErrorMessage(res.data, "重新加载失败，请稍后重试。"), "error");
      return;
    }
    toast("已重新加载", "success");
    if (state.pageStack.at(-1) !== page) return;
    _currentPlugin = res.data.plugin;
    _renderPluginDetailBody();
  } catch (e) {
    toast("重新加载失败", "error");
  }
  finally { if (!_uninstalling) hideLoading(); }
}

export async function pluginRefresh() {
  if (_uninstalling) return;
  const isCurrent = _startRender();
  showLoading("刷新中…");
  try {
    const res = await api.post("/api/plugins/refresh", {});
    if (!isCurrent()) return;
    if (res.status >= 400) {
      toast(pluginErrorMessage(res.data, "刷新失败，请稍后重试。"), "error");
      return;
    }
    _pluginsCache = res.data.plugins || [];
    _renderPluginListBody();
    toast("已刷新", "success");
  } catch (e) {
    if (isCurrent()) toast("刷新失败", "error");
  }
  finally { if (!_uninstalling) hideLoading(); }
}

/* ============ Custom config UI (sandboxed iframe) ============ */

function _detachIframeHandler() {
  if (_iframeMessageHandler) {
    window.removeEventListener("message", _iframeMessageHandler);
    _iframeMessageHandler = null;
  }
}

function _attachIframeHandler(plugin, schema, settings) {
  const iframe = document.getElementById("plugin-config-frame");
  if (!iframe) return;
  let hasAutoHeight = false;

  const handler = async (event) => {
    // event.origin is "null" for sandboxed iframes (no allow-same-origin),
    // so we identify the sender by its window object instead.
    if (event.source !== iframe.contentWindow) return;
    const data = event.data || {};
    const type = data.type;
    if (!type) return;

    if (type === "ready") {
      iframe.contentWindow.postMessage({
        type: "init",
        plugin: {
          id: plugin.id,
          name: (plugin.manifest && plugin.manifest.name) || plugin.name,
          version: (plugin.manifest && plugin.manifest.version) || plugin.version,
        },
        schema,
        settings,
        locale: (navigator.language || "zh-CN"),
      }, "*");
      return;
    }

    if (type === "pawzo:config-resize" || type === "resize") {
      // The injected bridge follows the document, including content shrinking.
      // Prefer it over legacy plugin reporters that measure the iframe viewport.
      if (type === "resize" && hasAutoHeight) return;
      const h = Number(data.height);
      if (!Number.isFinite(h) || h < 0) return;
      if (type === "pawzo:config-resize") hasAutoHeight = true;
      iframe.style.height = `${Math.ceil(h)}px`;
      return;
    }

    if (type === "toast") {
      const level = ["success", "error", "info"].includes(data.level) ? data.level : "info";
      const msg = String(data.message || "");
      if (msg) toast(msg, level);
      return;
    }

    if (type === "save") {
      if (_uninstalling) return;
      const correlationId = data.id;
      try {
        const res = await api.patch(
          `/api/plugins/${plugin.id}/config`,
          { settings: data.settings || {} },
        );
        if (_uninstalling || !iframe.isConnected) return;
        if (res.status >= 400) {
          const errMsg = (res.data && res.data.error) || "保存失败";
          iframe.contentWindow.postMessage({
            type: "save-result",
            id: correlationId,
            ok: false,
            error: errMsg,
          }, "*");
          toast(errMsg, "error");
          return;
        }
        // Keep this iframe's handshake data in sync after a successful save.
        plugin = res.data.plugin;
        schema = plugin.manifest?.config_schema || {};
        settings = res.data.settings || {};
        _currentPlugin = plugin;
        iframe.contentWindow.postMessage({
          type: "save-result",
          id: correlationId,
          ok: true,
          settings,
        }, "*");
        toast("配置已保存", "success");
      } catch (e) {
        iframe.contentWindow.postMessage({
          type: "save-result",
          id: correlationId,
          ok: false,
          error: String(e && e.message || e),
        }, "*");
        toast("保存失败", "error");
      }
      return;
    }
  };

  _iframeMessageHandler = handler;
  window.addEventListener("message", handler);
}

/* ============ Register pages ============ */

registerPageRenderer("pluginList", renderPluginList);
registerPageRenderer("pluginDetail", renderPluginDetail);

// A completed background task refreshes only the currently visible plugin page.
window.addEventListener("pawzo:plugins-changed", event => {
  if (_uninstalling) return;
  const page = state.pageStack.at(-1);
  if (page?.name === "pluginList") renderPluginList();
  else if (page?.name === "pluginDetail" && page.data === event.detail?.plugin_id) renderPluginDetail(page.data);
});
