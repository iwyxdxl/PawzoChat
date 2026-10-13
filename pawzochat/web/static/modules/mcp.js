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
import { esc } from "./utils.js";
import { api } from "./api.js";
import { $ } from "./state.js";
import { toast, confirm, showLoading, hideLoading } from "./ui.js";
import {
  setTopBar, goBack,
  registerPageRenderer,
} from "./navigation.js";

const content = () => document.getElementById("content-area");

let _mcpServers = [];
let _mcpAdapters = {};
let _isPublic = false;

let _editEnvRows = [];
let _editMode = "form";
let _parsedServers = null;
let _adapterAdvancedOpen = false;
let _adapterParams = [];
let _adapterMappings = [];
let _adapterInjects = [];

/* ============ MCP Overview ============ */

async function renderMcpOverview() {
  const topRight = _isPublic ? "" :
    `<button class="top-btn" onclick="PawzoChat.pushPage('mcpServerEdit',{isNew:true})">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`;
  setTopBar("MCP 扩展", true, topRight);
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  let pluginTools = [];
  try {
    const [srvRes, adpRes, toolsRes] = await Promise.all([
      api.get("/api/mcp/servers"),
      api.get("/api/mcp/adapters"),
      api.get("/api/mcp/tools"),
    ]);
    _mcpServers = srvRes.servers || [];
    _mcpAdapters = adpRes.adapters || {};
    _isPublic = !!srvRes.is_public;
    pluginTools = (toolsRes.tools || []).filter(
      t => typeof t.owner === "string" && t.owner.startsWith("plugin:")
    );
  } catch (e) {
    toast("加载失败", "error");
    return;
  }

  if (_mcpServers.length === 0 && Object.keys(_mcpAdapters).length === 0 && pluginTools.length === 0) {
    content().innerHTML = `<div class="empty-state">
      <div class="empty-text">还没有配置 MCP Server</div>
      ${_isPublic ? '<div style="font-size:13px;color:var(--text-3);margin-top:8px">MCP 配置仅限本地管理</div>' : ""}
    </div>`;
    return;
  }

  const serversHtml = _mcpServers.map(s => {
    const dot = s.connected
      ? `<span class="mcp-status-dot connected"></span>`
      : `<span class="mcp-status-dot"></span>`;
    const statusText = s.connected ? `${s.tool_count} 个工具` : (s.enabled ? "未连接" : "已禁用");
    const transport = s.transport === "sse" ? "SSE" : s.transport === "streamable_http" ? "HTTP" : "stdio";
    return `<div class="card-row" onclick="PawzoChat.pushPage('mcpServerDetail',{name:'${esc(s.name)}'})">
      <div class="mcp-server-info">
        <div class="mcp-server-name">${dot}${esc(s.name)}</div>
        <div class="mcp-server-meta"><span class="mcp-transport-tag">${transport}</span>${esc(statusText)}</div>
      </div>
      <span class="row-arrow">›</span>
    </div>`;
  }).join("");

  const adapterKeys = Object.keys(_mcpAdapters);
  const adaptersHtml = adapterKeys.length > 0
    ? adapterKeys.map(name => {
        const a = _mcpAdapters[name];
        return `<div class="card-row" onclick="PawzoChat.pushPage('mcpAdapterEdit',{name:'${esc(name)}',isNew:false})">
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:500">${esc(name)}</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:2px">→ ${esc(a.mcp_server || "—")} / ${esc(a.mcp_tool || "—")}</div>
          </div>
          <span class="row-arrow">›</span>
        </div>`;
      }).join("")
    : `<div class="card-empty-hint">暂无适配器</div>`;

  const addAdapterBtn = _isPublic ? "" :
    `<button class="btn-outline btn-sm" onclick="PawzoChat.pushPage('mcpAdapterEdit',{isNew:true})">添加</button>`;

  const serversBlock = _mcpServers.length === 0
    ? `<div class="card-empty-hint">暂无 MCP Server</div>`
    : serversHtml;

  const pluginToolsBlock = pluginTools.length === 0
    ? ""
    : `<div class="card" style="margin-top:12px">
        <div class="card-header" title="由插件提供，前往插件详情页管理">
          <span>插件提供的工具</span>
        </div>
        ${pluginTools.map(t => {
          const pluginId = (t.owner || "").slice("plugin:".length);
          const desc = t.description
            ? `<div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(t.description)}</div>`
            : "";
          return `<div class="card-row" style="cursor:default" title="由插件 ${esc(pluginId)} 提供，前往插件详情页管理">
            <div style="flex:1;min-width:0">
              <div style="font-family:var(--mono-font,monospace);font-size:13px;color:var(--text-2);word-break:break-all">${esc(t.name)}</div>
              ${desc}
            </div>
            <span style="font-size:11px;color:var(--text-3);background:var(--bg-hover);padding:2px 8px;border-radius:10px;white-space:nowrap;margin-left:8px">plugin: ${esc(pluginId)}</span>
          </div>`;
        }).join("")}
      </div>`;

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="card-header">MCP 服务器</div>
      ${serversBlock}
    </div>
    <div class="card" style="margin-top:12px">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <span>能力适配器</span>${addAdapterBtn}
      </div>
      ${adaptersHtml}
    </div>
    ${pluginToolsBlock}
  </div>`;
}

/* ============ Server Detail ============ */

async function renderMcpServerDetail(data) {
  const name = data.name;
  const editBtn = _isPublic ? "" :
    `<button class="btn-text" onclick="PawzoChat.pushPage('mcpServerEdit',{name:'${esc(name)}',isNew:false})">编辑</button>`;
  setTopBar(name, true, editBtn);
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  let server = null;
  let tools = [];
  try {
    const res = await api.get("/api/mcp/servers");
    _isPublic = !!res.is_public;
    server = (res.servers || []).find(s => s.name === name);
    if (server?.connected) {
      const tRes = await api.get(`/api/mcp/servers/${encodeURIComponent(name)}/tools`);
      tools = tRes.tools || [];
    }
  } catch (e) {
    toast("加载失败", "error");
    return;
  }

  if (!server) {
    content().innerHTML = `<div class="empty-state"><div class="empty-text">Server 不存在</div></div>`;
    return;
  }

  const statusDot = server.connected
    ? `<span class="mcp-status-dot connected"></span> 已连接`
    : `<span class="mcp-status-dot"></span> 未连接`;
  const transport = { streamable_http: "Streamable HTTP", sse: "SSE", stdio: "stdio" }[server.transport] || server.transport;

  const vs = "flex:1;text-align:right;font-size:14px;color:var(--text-2)";
  let infoRows = `
    <div class="form-group"><div class="form-row"><label>状态</label><span style="${vs}">${statusDot}</span></div></div>
    <div class="form-group"><div class="form-row"><label>传输</label><span style="${vs}">${esc(transport)}</span></div></div>`;
  if (server.transport === "stdio") {
    infoRows += `<div class="form-group"><div class="form-row"><label>命令</label><span style="${vs}">${esc(server.command || "—")}</span></div></div>`;
  } else {
    infoRows += `<div class="form-group"><div class="form-row"><label>URL</label><span style="${vs};word-break:break-all;font-size:12px">${esc(server.url || "—")}</span></div></div>`;
  }
  infoRows += `<div class="form-group"><div class="form-row"><label>工具超时</label><span style="${vs}">${server.timeout_seconds ? `${server.timeout_seconds} 秒` : "默认（30 秒）"}</span></div></div>`;
  infoRows += `<div class="form-group"><div class="form-row"><label>工具数</label><span style="${vs}">${server.tool_count}</span></div></div>`;

  const actionsHtml = _isPublic ? "" : `<div class="mcp-actions">
    <button class="btn-outline" id="mcp-btn-connect" onclick="PawzoChat.mcpConnect('${esc(name)}')" ${server.connected ? "disabled" : ""}>连接</button>
    <button class="btn-outline" id="mcp-btn-disconnect" onclick="PawzoChat.mcpDisconnect('${esc(name)}')" ${server.connected ? "" : "disabled"}>断开</button>
    <button class="btn-outline" id="mcp-btn-refresh" onclick="PawzoChat.mcpRefresh('${esc(name)}')" ${server.connected ? "" : "disabled"}>刷新工具</button>
  </div>`;

  const toolsHtml = tools.length > 0
    ? tools.map((t, i) => {
        const desc = t.description ? `<div class="mcp-tool-desc">${esc(t.description)}</div>` : "";
        const schema = t.inputSchema ? JSON.stringify(t.inputSchema, null, 2) : "";
        return `<div class="mcp-tool-item" onclick="this.classList.toggle('open')">
          <div class="mcp-tool-name">${esc(t._original_name || t.name)}</div>
          ${desc}
          ${schema ? `<div class="mcp-tool-schema"><pre>${esc(schema)}</pre></div>` : ""}
        </div>`;
      }).join("")
    : `<div class="card-empty-hint">${server.connected ? "该 Server 未暴露任何工具" : "连接后查看工具列表"}</div>`;

  const deleteBtn = _isPublic ? "" :
    `<div class="persona-actions mt-16"><button class="btn-text danger" onclick="PawzoChat.mcpDeleteServer('${esc(name)}')">删除该 Server</button></div>`;

  content().innerHTML = `<div class="page">
    <div class="card">${infoRows}</div>
    ${actionsHtml}
    <div class="card" style="margin-top:12px">
      <div class="card-header">工具列表</div>
      ${toolsHtml}
    </div>
    ${deleteBtn}
  </div>`;
}

/* ============ Server Edit ============ */

async function renderMcpServerEdit(data) {
  const isNew = data.isNew;
  const oldName = data.name || "";

  if (isNew) {
    _editMode = _editMode || "form";
    _parsedServers = null;

    setTopBar("添加 MCP Server", true, "");
    content().innerHTML = `<div class="page">
      <div class="mcp-mode-tabs">
        <button class="mcp-mode-tab ${_editMode === "form" ? "active" : ""}" onclick="PawzoChat.mcpSwitchEditMode('form')">表单</button>
        <button class="mcp-mode-tab ${_editMode === "json" ? "active" : ""}" onclick="PawzoChat.mcpSwitchEditMode('json')">JSON</button>
        <button class="mcp-mode-tab ${_editMode === "url" ? "active" : ""}" onclick="PawzoChat.mcpSwitchEditMode('url')">URL</button>
      </div>
      <div id="mcp-edit-body"></div>
    </div>`;

    if (_editMode === "form") _renderFormMode(true, "");
    else if (_editMode === "json") _renderJsonMode();
    else _renderUrlMode();
    return;
  }

  setTopBar("编辑 MCP Server", true,
    `<button class="btn-text" onclick="PawzoChat.mcpSaveServer(false,'${esc(oldName)}')">保存</button>`
  );
  _renderFormMode(false, oldName);
}

async function _renderFormMode(isNew, oldName) {
  let server = {
    name: "", transport: "stdio", command: "", args: [], env_keys: [],
    env_has_value: {}, url: "", enabled: true, timeout_seconds: null,
  };

  if (!isNew && oldName) {
    try {
      const res = await api.get("/api/mcp/servers");
      server = (res.servers || []).find(s => s.name === oldName) || server;
    } catch (e) { /* silent */ }
  }

  _editEnvRows = (server.env_keys || []).map(k => ({
    key: k,
    value: "",
    hasValue: !!(server.env_has_value || {})[k],
  }));

  const argsText = (server.args || []).join("\n");
  const isStdio = server.transport === "stdio";
  const isHttp = server.transport === "streamable_http";
  const isSse = server.transport === "sse";
  const showUrl = isHttp || isSse;

  const topRightBtn = isNew
    ? `<button class="btn-text" onclick="PawzoChat.mcpSaveServer(true,'')">保存</button>`
    : "";
  if (isNew) {
    setTopBar("添加 MCP Server", true, topRightBtn);
  }

  const target = isNew ? $("mcp-edit-body") : content();
  if (!target) return;

  target.innerHTML = `${isNew ? "" : '<div class="page">'}
    <div class="card">
      <div class="form-group"><div class="form-row">
        <label>名称</label>
        <input id="mcp-name" value="${esc(isNew ? "" : server.name)}" placeholder="如 tavily_search" ${isNew ? "" : "disabled"}>
      </div></div>
      <div class="form-group"><div class="form-row">
        <label>传输方式</label>
        <select id="mcp-transport" onchange="PawzoChat.mcpTransportChange()">
          <option value="stdio" ${isStdio ? "selected" : ""}>stdio</option>
          <option value="streamable_http" ${isHttp ? "selected" : ""}>Streamable HTTP</option>
          <option value="sse" ${isSse ? "selected" : ""}>SSE</option>
        </select>
      </div></div>
    </div>
    <div class="card" id="mcp-stdio-fields" style="${isStdio ? "" : "display:none"}">
      <div class="form-group"><div class="form-row"><label>命令</label><input id="mcp-command" value="${esc(server.command || "")}" placeholder="如 npx 或 python"></div></div>
      <div class="form-group"><div class="form-row" style="flex-direction:column;align-items:stretch;gap:4px">
        <label class="form-label-secondary">参数（一行一个）</label>
        <textarea id="mcp-args" rows="3" class="form-textarea" placeholder="每行一个参数，如:&#10; -y&#10;tavily-mcp@latest">${esc(argsText)}</textarea>
      </div></div>
      <div class="form-group">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px">
          <label class="form-label-secondary">环境变量</label>
          <button class="btn-outline btn-sm" onclick="PawzoChat.mcpAddEnvRow()">添加</button>
        </div>
        <div id="mcp-env-list"></div>
      </div>
    </div>
    <div class="card" id="mcp-http-fields" style="${showUrl ? "" : "display:none"}">
      <div class="form-group"><div class="form-row"><label>URL</label><input id="mcp-url" value="${esc(server.url || "")}" placeholder="http://localhost:8000/mcp"></div></div>
    </div>
    <div class="card">
      <div class="form-group"><div class="form-row">
        <label>启用</label>
        <label class="switch-wrap"><input type="checkbox" id="mcp-enabled" ${server.enabled ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row">
        <label>工具超时（秒）</label>
        <input type="number" id="mcp-timeout" min="1" max="600" step="1"
          value="${server.timeout_seconds ?? ""}" placeholder="默认 30">
      </div></div>
      <div class="form-hint">单次工具调用的最长等待时间，留空使用默认 30 秒</div>
    </div>
    <div style="padding:0 16px;margin-top:12px">
      <button class="btn-outline btn-test" id="mcp-test-btn" onclick="PawzoChat.mcpTestConnection('${esc(isNew ? "" : oldName)}')">测试连接</button>
    </div>
    ${!isNew ? `<div class="persona-actions mt-16"><button class="btn-text danger" onclick="PawzoChat.mcpDeleteServer('${esc(oldName)}')">删除该 Server</button></div>` : ""}
  ${isNew ? "" : '</div>'}`;

  _renderEnvList();
}

function _renderJsonMode() {
  const target = $("mcp-edit-body");
  if (!target) return;

  target.innerHTML = `
    <div class="card">
      <div class="card-header">JSON 导入</div>
      <div class="form-hint">粘贴 MCP Server 配置（支持 Claude Desktop 格式）</div>
      <div style="padding:0 16px 16px">
        <textarea id="mcp-json-input" class="mcp-json-area" placeholder='{\n  "server-name": {\n    "command": "npx",\n    "args": ["-y", "package-name"]\n  }\n}'></textarea>
        <div id="mcp-json-error"></div>
        <button class="btn-outline" onclick="PawzoChat.mcpParseJson()" style="width:100%;margin-top:12px">解析</button>
      </div>
    </div>
    <div id="mcp-json-preview-area"></div>`;
}

function _renderUrlMode() {
  const target = $("mcp-edit-body");
  if (!target) return;

  target.innerHTML = `
    <div class="card">
      <div class="form-group"><div class="form-row">
        <label>MCP URL</label>
        <input id="mcp-url-input" placeholder="https://mcp.example.com/mcp" oninput="PawzoChat.mcpUrlAutoName()">
      </div></div>
      <div class="form-group"><div class="form-row">
        <label>名称</label>
        <input id="mcp-url-name" placeholder="自动从 URL 提取">
      </div></div>
      <div class="form-group"><div class="form-row">
        <label>启用</label>
        <label class="switch-wrap"><input type="checkbox" id="mcp-url-enabled" checked><span class="switch-track"></span></label>
      </div></div>
    </div>
    <div style="padding:0 16px;margin-top:12px">
      <button class="btn-outline btn-test" id="mcp-url-save-btn" onclick="PawzoChat.mcpSaveUrl()">添加</button>
    </div>`;
}

function _renderEnvList() {
  const el = $("mcp-env-list");
  if (!el) return;
  if (_editEnvRows.length === 0) {
    el.innerHTML = `<div class="card-empty-hint" style="padding:12px 16px">暂无环境变量</div>`;
    return;
  }
  el.innerHTML = _editEnvRows.map((row, i) => {
    const ph = row.hasValue ? "已设置（留空不修改）" : "输入值";
    return `<div class="env-row">
      <input class="env-key" value="${esc(row.key)}" placeholder="KEY" onchange="PawzoChat.mcpUpdateEnvKey(${i},this.value)">
      <input class="env-val" type="password" value="${esc(row.value)}" placeholder="${esc(ph)}" onchange="PawzoChat.mcpUpdateEnvVal(${i},this.value)">
      <button class="btn-icon-sm" onclick="PawzoChat.mcpRemoveEnvRow(${i})">&times;</button>
    </div>`;
  }).join("");
}

/* ============ Adapter Edit ============ */

async function renderMcpAdapterEdit(data) {
  const isNew = data.isNew;
  const oldName = data.name || "";
  setTopBar(isNew ? "添加适配器" : "编辑适配器", true,
    `<button class="btn-text" onclick="PawzoChat.mcpSaveAdapter(${isNew},'${esc(oldName)}')">保存</button>`
  );

  let adapter = { description: "", mcp_server: "", mcp_tool: "", parameters: {}, param_mapping: {}, inject_fields: {} };
  let availableServers = [];
  let availableTools = {};

  try {
    const res = await api.get("/api/mcp/adapters");
    availableServers = res.available_servers || [];
    availableTools = res.available_tools || {};
    if (!isNew && oldName && res.adapters && res.adapters[oldName]) {
      adapter = res.adapters[oldName];
    }
  } catch (e) { /* silent */ }

  _adapterAdvancedOpen = false;
  _adapterParams = Object.entries(adapter.parameters || {}).map(([k, v]) => ({
    name: k, type: v.type || "string", description: v.description || "",
  }));
  _adapterMappings = Object.entries(adapter.param_mapping || {}).map(([k, v]) => ({ from: k, to: v }));
  _adapterInjects = Object.entries(adapter.inject_fields || {}).map(([k, v]) => ({ field: k, expr: v }));

  const serverOpts = availableServers.map(s =>
    `<option value="${esc(s)}" ${s === adapter.mcp_server ? "selected" : ""}>${esc(s)}</option>`
  ).join("");

  const currentServerTools = availableTools[adapter.mcp_server] || [];
  const savedTool = adapter.mcp_tool;
  const toolList = savedTool && !currentServerTools.includes(savedTool)
    ? [savedTool, ...currentServerTools]
    : currentServerTools;
  const toolOpts = toolList.map(t =>
    `<option value="${esc(t)}" ${t === savedTool ? "selected" : ""}>${esc(t)}</option>`
  ).join("");

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="form-group"><div class="form-row"><label>能力名称</label><input id="adp-name" value="${esc(isNew ? "" : oldName)}" placeholder="如 view_image" ${isNew ? "" : "disabled"}></div></div>
      <div class="form-group"><div class="form-row"><label>描述</label><input id="adp-desc" value="${esc(adapter.description || "")}" placeholder="查看并分析图片"></div></div>
      <div class="form-group"><div class="form-row">
        <label>目标 Server</label>
        <select id="adp-server" onchange="PawzoChat.mcpAdapterServerChange()">
          <option value="">选择 Server</option>${serverOpts}
        </select>
      </div></div>
      <div class="form-group"><div class="form-row">
        <label>目标工具</label>
        <select id="adp-tool">
          <option value="">选择工具</option>${toolOpts}
        </select>
      </div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="fold-section-header" onclick="PawzoChat.mcpToggleAdapterAdvanced()">
        <span>高级设置</span><span id="adp-fold-arrow" class="fold-arrow">▶</span>
      </div>
      <div id="adp-advanced" class="fold-section-body" style="display:none">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-top:0;padding-top:12px">
          <span>参数定义</span>
          <button class="btn-outline btn-sm" onclick="PawzoChat.mcpAddAdapterParam()">添加</button>
        </div>
        <div id="adp-params-list"></div>
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--divider)">
          <span>参数映射</span>
          <button class="btn-outline btn-sm" onclick="PawzoChat.mcpAddAdapterMapping()">添加</button>
        </div>
        <div id="adp-mappings-list"></div>
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--divider)">
          <span>注入字段</span>
          <button class="btn-outline btn-sm" onclick="PawzoChat.mcpAddAdapterInject()">添加</button>
        </div>
        <div id="adp-injects-list"></div>
      </div>
    </div>
    ${!isNew ? `<div class="persona-actions mt-16"><button class="btn-text danger" onclick="PawzoChat.mcpDeleteAdapter('${esc(oldName)}')">删除该适配器</button></div>` : ""}
  </div>`;

  _renderAdapterAdvanced();
}

function _renderAdapterAdvanced() {
  const paramsEl = $("adp-params-list");
  if (paramsEl) {
    paramsEl.innerHTML = _adapterParams.length === 0
      ? `<div class="card-empty-hint" style="padding:8px 16px">无</div>`
      : _adapterParams.map((p, i) => `<div class="env-row">
          <input value="${esc(p.name)}" placeholder="参数名" style="flex:1" onchange="PawzoChat.mcpUpdateAdpParam(${i},'name',this.value)">
          <input value="${esc(p.type)}" placeholder="类型" style="width:60px" onchange="PawzoChat.mcpUpdateAdpParam(${i},'type',this.value)">
          <input value="${esc(p.description)}" placeholder="描述" style="flex:2" onchange="PawzoChat.mcpUpdateAdpParam(${i},'description',this.value)">
          <button class="btn-icon-sm" onclick="PawzoChat.mcpRemoveAdpParam(${i})">&times;</button>
        </div>`).join("");
  }

  const mappingsEl = $("adp-mappings-list");
  if (mappingsEl) {
    mappingsEl.innerHTML = _adapterMappings.length === 0
      ? `<div class="card-empty-hint" style="padding:8px 16px">无</div>`
      : _adapterMappings.map((m, i) => `<div class="env-row">
          <input value="${esc(m.from)}" placeholder="本地参数" style="flex:1" onchange="PawzoChat.mcpUpdateAdpMapping(${i},'from',this.value)">
          <span style="color:var(--text-3);padding:0 4px">→</span>
          <input value="${esc(m.to)}" placeholder="MCP参数" style="flex:1" onchange="PawzoChat.mcpUpdateAdpMapping(${i},'to',this.value)">
          <button class="btn-icon-sm" onclick="PawzoChat.mcpRemoveAdpMapping(${i})">&times;</button>
        </div>`).join("");
  }

  const injectsEl = $("adp-injects-list");
  if (injectsEl) {
    injectsEl.innerHTML = _adapterInjects.length === 0
      ? `<div class="card-empty-hint" style="padding:8px 16px">无</div>`
      : _adapterInjects.map((j, i) => `<div class="env-row">
          <input value="${esc(j.field)}" placeholder="字段名" style="flex:1" onchange="PawzoChat.mcpUpdateAdpInject(${i},'field',this.value)">
          <input value="${esc(j.expr)}" placeholder="表达式" style="flex:2" onchange="PawzoChat.mcpUpdateAdpInject(${i},'expr',this.value)">
          <button class="btn-icon-sm" onclick="PawzoChat.mcpRemoveAdpInject(${i})">&times;</button>
        </div>`).join("");
  }
}


/* ============ Exported Actions ============ */

export function mcpTransportChange() {
  const t = $("mcp-transport")?.value;
  const stdio = $("mcp-stdio-fields");
  const http = $("mcp-http-fields");
  if (stdio) stdio.style.display = t === "stdio" ? "" : "none";
  if (http) http.style.display = (t === "streamable_http" || t === "sse") ? "" : "none";
}

export function mcpAddEnvRow() {
  _editEnvRows.push({ key: "", value: "", hasValue: false });
  _renderEnvList();
}
export function mcpRemoveEnvRow(idx) {
  _editEnvRows.splice(idx, 1);
  _renderEnvList();
}
export function mcpUpdateEnvKey(idx, val) { _editEnvRows[idx].key = val; }
export function mcpUpdateEnvVal(idx, val) { _editEnvRows[idx].value = val; }

export async function mcpTestConnection(savedName) {
  const body = _buildServerBody();
  const testName = savedName || body.name || "_test";

  showLoading("测试中…");
  try {
    const res = await api.post(`/api/mcp/servers/${encodeURIComponent(testName)}/test`, body);
    if (res.data.ok) {
      toast(`连接成功，发现 ${res.data.tool_count} 个工具`, "success");
    } else {
      toast(`连接失败: ${res.data.error || "未知错误"}`, "error");
    }
  } catch (e) { toast("测试请求失败", "error"); }
  finally { hideLoading(); }
}

export async function mcpSaveServer(isNew, oldName) {
  const body = _buildServerBody();

  if (isNew) {
    if (!body.name) { toast("名称不能为空", "error"); return; }
    showLoading("保存中…");
    try {
      const res = await api.post("/api/mcp/servers", body);
      if (res.status >= 400) { toast(res.data.error || "保存失败", "error"); return; }
      toast("已保存", "success");
      goBack();
    } catch (e) { toast("保存失败", "error"); }
    finally { hideLoading(); }
  } else {
    showLoading("保存中…");
    try {
      const res = await api.put(`/api/mcp/servers/${encodeURIComponent(oldName)}`, body);
      if (res.status >= 400) { toast(res.data.error || "保存失败", "error"); return; }
      toast("已保存", "success");
      goBack();
    } catch (e) { toast("保存失败", "error"); }
    finally { hideLoading(); }
  }
}

export async function mcpDeleteServer(name) {
  const ok = await confirm("删除 MCP Server", `确认删除 "${name}"？关联的适配器也会被删除。`, true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    await api.del(`/api/mcp/servers/${encodeURIComponent(name)}`);
    toast("已删除", "success");
    goBack();
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export async function mcpConnect(name) {
  showLoading("连接中…");
  try {
    const res = await api.post(`/api/mcp/servers/${encodeURIComponent(name)}/connect`, {});
    if (res.data.ok) {
      toast("已连接", "success");
      renderMcpServerDetail({ name });
    } else {
      toast(res.data.error || "连接失败", "error");
    }
  } catch (e) { toast("连接请求失败", "error"); }
  finally { hideLoading(); }
}

export async function mcpDisconnect(name) {
  showLoading("断开中…");
  try {
    await api.post(`/api/mcp/servers/${encodeURIComponent(name)}/disconnect`, {});
    toast("已断开", "success");
    renderMcpServerDetail({ name });
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export async function mcpRefresh(name) {
  showLoading("刷新中…");
  try {
    const res = await api.post(`/api/mcp/servers/${encodeURIComponent(name)}/refresh`, {});
    toast(`已刷新，${res.data.tool_count} 个工具`, "success");
    renderMcpServerDetail({ name });
  } catch (e) { toast("刷新失败", "error"); }
  finally { hideLoading(); }
}

export function mcpToggleAdapterAdvanced() {
  _adapterAdvancedOpen = !_adapterAdvancedOpen;
  const body = $("adp-advanced");
  const arrow = $("adp-fold-arrow");
  if (body) body.style.display = _adapterAdvancedOpen ? "" : "none";
  if (arrow) arrow.textContent = _adapterAdvancedOpen ? "▼" : "▶";
}

export async function mcpAdapterServerChange() {
  const serverName = $("adp-server")?.value || "";
  const toolSelect = $("adp-tool");
  if (!toolSelect) return;

  toolSelect.innerHTML = `<option value="">加载中…</option>`;
  if (!serverName) {
    toolSelect.innerHTML = `<option value="">选择工具</option>`;
    return;
  }

  try {
    const res = await api.get(`/api/mcp/servers/${encodeURIComponent(serverName)}/tools`);
    const tools = res.tools || [];
    if (tools.length === 0) {
      toolSelect.innerHTML = `<option value="">该 Server 未连接或无工具</option>`;
    } else {
      toolSelect.innerHTML = `<option value="">选择工具</option>` +
        tools.map(t => `<option value="${esc(t._original_name || t.name)}">${esc(t._original_name || t.name)}</option>`).join("");
    }
  } catch (e) {
    toolSelect.innerHTML = `<option value="">加载失败</option>`;
  }
}

export function mcpAddAdapterParam() { _adapterParams.push({ name: "", type: "string", description: "" }); _renderAdapterAdvanced(); }
export function mcpRemoveAdpParam(i) { _adapterParams.splice(i, 1); _renderAdapterAdvanced(); }
export function mcpUpdateAdpParam(i, field, val) { _adapterParams[i][field] = val; }

export function mcpAddAdapterMapping() { _adapterMappings.push({ from: "", to: "" }); _renderAdapterAdvanced(); }
export function mcpRemoveAdpMapping(i) { _adapterMappings.splice(i, 1); _renderAdapterAdvanced(); }
export function mcpUpdateAdpMapping(i, field, val) { _adapterMappings[i][field] = val; }

export function mcpAddAdapterInject() { _adapterInjects.push({ field: "", expr: "" }); _renderAdapterAdvanced(); }
export function mcpRemoveAdpInject(i) { _adapterInjects.splice(i, 1); _renderAdapterAdvanced(); }
export function mcpUpdateAdpInject(i, field, val) { _adapterInjects[i][field] = val; }

export async function mcpSaveAdapter(isNew, oldName) {
  const name = $("adp-name")?.value.trim() || oldName;
  if (!name) { toast("能力名称不能为空", "error"); return; }

  const parameters = {};
  for (const p of _adapterParams) {
    if (!p.name) continue;
    parameters[p.name] = { type: p.type || "string" };
    if (p.description) parameters[p.name].description = p.description;
  }

  const param_mapping = {};
  for (const m of _adapterMappings) {
    if (m.from && m.to) param_mapping[m.from] = m.to;
  }

  const inject_fields = {};
  for (const j of _adapterInjects) {
    if (j.field && j.expr) inject_fields[j.field] = j.expr;
  }

  const body = {
    name,
    description: $("adp-desc")?.value.trim() || "",
    mcp_server: $("adp-server")?.value || "",
    mcp_tool: $("adp-tool")?.value || "",
    parameters,
    param_mapping,
    inject_fields,
  };

  showLoading("保存中…");
  try {
    let res;
    if (isNew) { res = await api.post("/api/mcp/adapters", body); }
    else { res = await api.put(`/api/mcp/adapters/${encodeURIComponent(oldName)}`, body); }
    if (res.status >= 400) { toast(res.data.error || "保存失败", "error"); return; }
    toast("已保存", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function mcpDeleteAdapter(name) {
  const ok = await confirm("删除适配器", `确认删除 "${name}"？`, true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    await api.del(`/api/mcp/adapters/${encodeURIComponent(name)}`);
    toast("已删除", "success");
    goBack();
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export async function getMcpSummary() {
  try {
    const res = await api.get("/api/mcp/servers");
    const servers = res.servers || [];
    const connected = servers.filter(s => s.connected).length;
    if (servers.length === 0) return "未配置";
    return `${connected} 个已连接`;
  } catch (e) { return ""; }
}


/* ============ Multi-mode Add Actions ============ */

export function mcpSwitchEditMode(mode) {
  _editMode = mode;
  document.querySelectorAll(".mcp-mode-tab").forEach(btn => {
    btn.classList.toggle("active", btn.textContent.trim() === { form: "表单", json: "JSON", url: "URL" }[mode]);
  });
  if (mode === "form") _renderFormMode(true, "");
  else if (mode === "json") _renderJsonMode();
  else _renderUrlMode();
}

function _inferTransport(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    if (path.endsWith("/sse")) return "sse";
  } catch { /* ignore */ }
  return "streamable_http";
}

function _extractNameFromUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    if (parts.length >= 2) {
      const candidate = parts[parts.length - 2];
      if (candidate && candidate !== "www" && candidate !== "mcp") return candidate;
      for (let i = parts.length - 3; i >= 0; i--) {
        if (parts[i] && parts[i] !== "www" && parts[i] !== "mcp") return parts[i];
      }
      return candidate;
    }
    return parts[0] || "server";
  } catch { return "server"; }
}

export function mcpUrlAutoName() {
  const url = $("mcp-url-input")?.value.trim() || "";
  const nameInput = $("mcp-url-name");
  if (!nameInput) return;
  if (url) {
    nameInput.value = _extractNameFromUrl(url);
  }
}

export function mcpParseJson() {
  const raw = $("mcp-json-input")?.value.trim() || "";
  const errorEl = $("mcp-json-error");
  const previewEl = $("mcp-json-preview-area");
  if (!errorEl || !previewEl) return;
  errorEl.innerHTML = "";
  previewEl.innerHTML = "";

  if (!raw) { errorEl.innerHTML = `<div class="mcp-json-error">请粘贴 JSON 内容</div>`; return; }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { errorEl.innerHTML = `<div class="mcp-json-error">JSON 格式错误：${esc(e.message)}</div>`; return; }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errorEl.innerHTML = `<div class="mcp-json-error">JSON 必须是一个对象</div>`; return;
  }

  let servers = parsed;
  if (parsed.mcpServers && typeof parsed.mcpServers === "object") servers = parsed.mcpServers;

  const entries = Object.entries(servers);
  if (entries.length === 0) {
    errorEl.innerHTML = `<div class="mcp-json-error">未发现任何 server 配置</div>`; return;
  }

  const errors = [];
  const valid = [];
  for (const [name, cfg] of entries) {
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
      errors.push(`"${name}": 配置必须是一个对象`); continue;
    }
    if (!cfg.command && !cfg.url) {
      errors.push(`"${name}": 缺少 command 或 url 字段`); continue;
    }
    if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
      errors.push(`"${name}": args 必须是数组`); continue;
    }
    if (cfg.env !== undefined && (typeof cfg.env !== "object" || Array.isArray(cfg.env))) {
      errors.push(`"${name}": env 必须是对象`); continue;
    }
    const transport = cfg.command ? "stdio" : _inferTransport(cfg.url);
    valid.push({ name: name.trim(), cfg, transport });
  }

  if (errors.length > 0) {
    errorEl.innerHTML = `<div class="mcp-json-error">${errors.map(e => esc(e)).join("\n")}</div>`;
  }
  if (valid.length === 0) return;

  _parsedServers = valid;
  const transportLabel = { stdio: "stdio", streamable_http: "HTTP", sse: "SSE" };
  previewEl.innerHTML = `
    <div class="card" style="margin-top:12px">
      <div class="card-header">将导入 ${valid.length} 个 Server</div>
      <div class="mcp-json-preview">
        ${valid.map(s => `<div class="mcp-json-preview-item">
          <span class="mcp-json-preview-name">${esc(s.name)}</span>
          <span class="mcp-json-preview-tag">${transportLabel[s.transport] || s.transport}</span>
        </div>`).join("")}
      </div>
    </div>
    <div style="padding:0 16px;margin-top:12px">
      <button class="btn-outline btn-test" onclick="PawzoChat.mcpImportJson()">导入全部</button>
    </div>`;
}

export async function mcpImportJson() {
  if (!_parsedServers || _parsedServers.length === 0) return;

  const serversMap = {};
  for (const s of _parsedServers) {
    const entry = { ...s.cfg };
    if (!entry.transport) {
      entry.transport = s.transport;
    }
    serversMap[s.name] = entry;
  }

  showLoading("导入中…");
  try {
    const res = await api.post("/api/mcp/servers/batch", { servers: serversMap });
    const d = res.data || res;
    const msgs = [];
    if (d.created?.length) msgs.push(`已导入 ${d.created.length} 个`);
    if (d.skipped?.length) msgs.push(`跳过 ${d.skipped.length} 个（已存在）`);
    if (d.errors?.length) msgs.push(`${d.errors.length} 个出错`);
    toast(msgs.join("，"), d.errors?.length ? "error" : "success");
    if (d.created?.length) goBack();
  } catch (e) { toast("导入失败", "error"); }
  finally { hideLoading(); }
}

export async function mcpSaveUrl() {
  const url = $("mcp-url-input")?.value.trim() || "";
  const name = $("mcp-url-name")?.value.trim() || "";
  const enabled = $("mcp-url-enabled")?.checked ?? true;

  if (!url) { toast("URL 不能为空", "error"); return; }
  if (!name) { toast("名称不能为空", "error"); return; }

  const transport = _inferTransport(url);
  const body = { name, transport, url, enabled };

  showLoading("添加中…");
  try {
    const res = await api.post("/api/mcp/servers", body);
    if (res.status >= 400) {
      toast((res.data && res.data.error) || "添加失败", "error");
    } else {
      toast("已添加", "success");
      goBack();
    }
  } catch (e) { toast("添加失败", "error"); }
  finally { hideLoading(); }
}

/* ============ Helpers ============ */

function _buildServerBody() {
  const transport = $("mcp-transport")?.value || "stdio";
  const body = {
    name: $("mcp-name")?.value.trim() || "",
    transport,
    enabled: $("mcp-enabled")?.checked ?? true,
  };
  const timeoutRaw = $("mcp-timeout")?.value.trim() || "";
  const timeoutNum = Math.trunc(Number(timeoutRaw));
  body.timeout_seconds = (timeoutRaw && Number.isFinite(timeoutNum) && timeoutNum > 0)
    ? timeoutNum : null;
  if (transport === "stdio") {
    body.command = $("mcp-command")?.value.trim() || "";
    body.args = ($("mcp-args")?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
    const env = {};
    for (const row of _editEnvRows) {
      if (row.key) env[row.key] = row.value;
    }
    body.env = env;
  } else if (transport === "streamable_http" || transport === "sse") {
    body.url = $("mcp-url")?.value.trim() || "";
  }
  return body;
}

/* ============ Register page renderers ============ */

registerPageRenderer("mcpOverview", renderMcpOverview);
registerPageRenderer("mcpServerDetail", renderMcpServerDetail);
registerPageRenderer("mcpServerEdit", renderMcpServerEdit);
registerPageRenderer("mcpAdapterEdit", renderMcpAdapterEdit);
