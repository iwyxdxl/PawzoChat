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
import { avatarHtml, formatTime, esc, escAttr, jsArg, iconHtml, voiceOptionsHtml, voiceCatalogFor } from "./utils.js";
import { mountAccountVoicePicker } from "./voice_picker.js";
import { api, downloadFile } from "./api.js";
import { state, $, content, sidebar } from "./state.js";
import { toast, confirm, showSheet, closeOverlay, showLoading, hideLoading, setOverlayDismissible } from "./ui.js";
import {
  setTopBar, pushPage, goBack,
  registerTabRenderer, registerPageRenderer,
  isDesktop, setSidebarBar, refreshSidebar,
} from "./navigation.js";
import { applyThemeFromState, invalidateCache } from "./theme.js";
import { fetchQrStatus, renderVerifyInput, clearVerifyInput } from "./qr_verify.js";
import { voiceControlHtml, readVoiceControls, bindVoiceControls, voiceTestEmotionHtml } from "./voice_controls.js";

const _CAM_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;

/* ============ Settings Main (Tab) ============ */

async function renderSettings() {
  const desktop = isDesktop();
  const target = desktop ? sidebar() : content();

  if (desktop) setSidebarBar("设置", "");
  else setTopBar("设置", false, "");

  target.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  let statusInfo = { version: "", accounts_online: 0, conversations_active: 0 };
  try { statusInfo = await api.get("/api/status"); state._version = statusInfo.version; } catch (e) { /* silent */ }

  let updateDot = "";
  try {
    const u = await api.get("/api/update/check", { bypassCache: true });
    state._updateInfo = u;
    if (u.download_state) state._updateState = u.download_state;
    if (u.has_update) updateDot = `<span class="update-dot"></span>`;
  } catch (e) { /* silent */ }

  let acctCount = 0, provCount = 0, imgProvCount = 0, voiceProvCount = 0, emojiGroupCount = 0, mcpSummary = "";
  try {
    const [a, p, ip, vp, s, e] = await Promise.all([
      api.get("/api/accounts"),
      api.get("/api/providers"),
      api.get("/api/image-providers"),
      api.get("/api/voice-providers"),
      api.get("/api/settings"),
      api.get("/api/emoji/groups"),
    ]);
    acctCount = (a.accounts || []).length;
    provCount = (p.providers || []).length;
    imgProvCount = (ip.providers || []).length;
    voiceProvCount = (vp.providers || []).length;
    state.settings = s;
    emojiGroupCount = (e.groups || []).length;
  } catch (e) { /* silent */ }
  try {
    const mcp = await api.get("/api/mcp/servers");
    const srvs = mcp.servers || [];
    const conn = srvs.filter(s => s.connected).length;
    mcpSummary = srvs.length === 0 ? "未配置" : `${conn} 个已连接`;
    if (mcp.is_public) mcpSummary = "仅本地管理";
  } catch (e) { /* silent */ }

  const isPublic = !!state.settings?.is_public;

  const profile = state.profile || { name: "我", has_avatar: false };
  const base = window.PAWZOCHAT_BASE || "";
  const profileAvUrl = profile.has_avatar ? `${base}/api/profile/avatar` : "";

  target.innerHTML = `<div class="page">
    <div class="status-card" onclick="PawzoChat.pushPage('profileEdit')">
      ${avatarHtml(profile.name, "", profileAvUrl)}
      <div class="info">
        <div class="app-name">${esc(profile.name)}</div>
        <div class="version">PawzoChat v${esc(statusInfo.version)}</div>
      </div>
      <span class="row-arrow">›</span>
    </div>
    <div class="card">
      <div class="card-row" onclick="PawzoChat.pushPage('settingsAccounts')">
        <div class="row-icon green">${iconHtml("ri-smartphone-line")}</div>
        <span class="row-label">聊天账号</span><span class="row-value">${acctCount} 个</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('settingsProviders')">
        <div class="row-icon orange">${iconHtml("ri-magic-line")}</div>
        <span class="row-label">对话服务商</span><span class="row-value">${provCount} 个</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('settingsImageProviders')">
        <div class="row-icon peach">${iconHtml("ri-image-2-line")}</div>
        <span class="row-label">生图服务商</span><span class="row-value">${imgProvCount} 个</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('settingsVoiceProviders')">
        <div class="row-icon cyan">${iconHtml("ri-voiceprint-line")}</div>
        <span class="row-label">语音服务商</span><span class="row-value">${voiceProvCount} 个</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('mcpOverview')">
        <div class="row-icon blue">${iconHtml("ri-puzzle-line")}</div>
        <span class="row-label">MCP 扩展</span><span class="row-value">${esc(mcpSummary)}</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('pluginList')">
        <div class="row-icon red">${iconHtml("ri-plug-line")}</div>
        <span class="row-label">插件管理</span><span class="row-arrow">›</span>
      </div>
    </div>
    <div class="card">
      <div class="card-row" onclick="PawzoChat.pushPage('settingsChat')">
        <div class="row-icon primary">${iconHtml("ri-settings-3-line")}</div>
        <span class="row-label">对话设置</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('settingsReply')">
        <div class="row-icon indigo">${iconHtml("ri-edit-line")}</div>
        <span class="row-label">回复设置</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('settingsTheme')">
        <div class="row-icon purple">${iconHtml("ri-palette-line")}</div>
        <span class="row-label">主题</span><span class="row-arrow">›</span>
      </div>
    </div>
    <div class="card">
      <div class="card-row" onclick="PawzoChat.pushPage('settingsEmoji')">
        <div class="row-icon yellow">${iconHtml("ri-chat-smile-2-line")}</div>
        <span class="row-label">表情包管理</span><span class="row-value">${emojiGroupCount} 个分组</span><span class="row-arrow">›</span>
      </div>
    </div>
    <div class="card">
      ${!isPublic ? `<div class="card-row" onclick="PawzoChat.pushPage('settingsNetwork')">
        <div class="row-icon cyan">${iconHtml("ri-global-line")}</div>
        <span class="row-label">网络设置</span><span class="row-arrow">›</span>
      </div>` : ''}
      <div class="card-row" onclick="PawzoChat.pushPage('settingsAbout')">
        <div class="row-icon neutral">${iconHtml("ri-information-line")}</div>
        <span class="row-label">关于 PawzoChat</span>${updateDot}<span class="row-arrow">›</span>
      </div>
    </div>
  </div>`;
}

/* ============ Accounts ============ */

let _accountsCache = [];
let _currentAccount = null;

async function renderSettingsAccounts() {
  setTopBar("聊天账号", true,
    `<button class="top-btn" onclick="PawzoChat.addAccount()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/accounts");
    const accounts = res.accounts || [];
    _accountsCache = accounts;
    const personas = state.personas;

    if (accounts.length === 0) {
      content().innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <div class="empty-text">还没有添加任何账号</div>
        <button onclick="PawzoChat.addAccount()">添加账号</button>
      </div>`;
      return;
    }

    const html = accounts.map((a, idx) => {
      const statusClass = a.connection_state === "cooldown" ? "cooldown" : a.online ? "online" : "offline";
      const statusLabel = statusClass === "cooldown" ? "凭据冷却中" : a.online ? "在线" : "离线";
      const status = `<span class="account-card-status ${statusClass}">
        <span class="account-card-status-dot" aria-hidden="true"></span>${statusLabel}
      </span>`;
      const displayName = a.note || a.bot_id;
      const largeChannelIcon = a.channel_type === "wechat" || a.channel_type === "qq";
      const channelIcon = a.channel_type === "wechat" ? "ri-wechat-fill"
        : a.channel_type === "qq" ? "ri-qq-fill"
        : a.channel_type ? "ri-plug-line" : "ri-smartphone-line";
      const channelTag = a.channel_name
        ? `<span class="account-card-channel" title="${escAttr(a.channel_name)}">${esc(a.channel_name)}</span>`
        : "";
      const linked = a.linked_persona
        ? `已链接到：${personas.find(p => p.id === a.linked_persona)?.name || a.linked_persona}`
        : "未链接角色";
      const createdAt = a.created_at ? formatTime(a.created_at) : "";
      return `<div class="card account-card">
        <div class="card-row" onclick="PawzoChat.openAccount(${idx})">
          <div class="row-icon account-card-icon${largeChannelIcon ? " account-card-icon-large" : ""}">${iconHtml(channelIcon)}</div>
          <div class="account-card-info">
            <div class="account-card-name" title="${escAttr(displayName)}">${esc(displayName)}</div>
            <div class="account-card-details">
              <div class="account-card-description account-card-id" title="${escAttr(a.bot_id)}">${esc(a.bot_id)}</div>
              <div class="account-card-description" title="${escAttr(linked)}">${esc(linked)}</div>
            </div>
            <div class="account-card-meta">
              ${channelTag}
              ${status}
              ${createdAt ? `<span class="account-card-date" title="创建于 ${escAttr(createdAt)}" aria-label="创建于 ${escAttr(createdAt)}"><span class="account-card-date-label">创建于 </span>${esc(createdAt)}</span>` : ""}
            </div>
          </div>
          <span class="row-arrow">›</span>
        </div>
      </div>`;
    }).join("");
    content().innerHTML = `<div class="page">${html}</div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export function openAccount(idx) {
  const a = _accountsCache[idx];
  if (a) pushPage("accountDetail", a);
}

let _channelTypes = [];
let _pendingFormChannel = "";
let _pendingFormFields = [];

export async function addAccount() {
  let channels = [];
  try {
    const res = await api.get("/api/accounts/channels");
    channels = res.channels || [];
  } catch (e) { toast("加载通道失败", "error"); return; }

  _channelTypes = channels;
  if (channels.length === 0) { toast("没有可用通道", "error"); return; }

  // A single QR channel (WeChat only) goes straight to scanning.
  if (channels.length === 1 && channels[0].method === "qr") {
    startWeChatQrFlow();
    return;
  }

  const items = channels.map(c => `
    <div class="sheet-item" onclick="PawzoChat.selectChannelType(${jsArg(c.type)})">
      <span style="flex:1">${esc(c.name)}</span>
      <span class="row-arrow">›</span>
    </div>`).join("");
  showSheet(`<div class="sheet-title">选择通道类型</div>${items}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
}

export function selectChannelType(type) {
  const ch = _channelTypes.find(c => c.type === type);
  if (!ch) return;
  closeOverlay();
  setTimeout(() => {
    if (ch.method === "qr") startWeChatQrFlow();
    else showChannelFormSheet(ch);
  }, 220);
}

async function startWeChatQrFlow() {
  try {
    const res = await api.post("/api/accounts/qr/start", {});
    if (res.status >= 400) { toast(res.data.error, "error"); return; }

    _qrPollBaseUrl = "";
    _qrVerifyCode = "";
    _qrPolling = true;
    showSheet(`<div class="qr-dialog">
      <div class="sheet-title">扫码登录微信</div>
      <img src="${res.data.qr_image}" alt="QR Code">
      <div class="qr-status" id="qr-poll-status">请用微信扫描二维码</div>
      <button class="btn-text" onclick="PawzoChat.closeOverlay()">取消</button>
    </div>`, () => { _qrPolling = false; });

    pollQrStatus(res.data.qrcode);
  } catch (e) { toast("获取二维码失败", "error"); }
}

function showChannelFormSheet(ch) {
  _pendingFormChannel = ch.type;
  _pendingFormFields = ch.fields || [];
  // Use the field index (not f.key) for DOM ids so a plugin-defined key with
  // unusual characters can't produce a broken id or a lookup that diverges
  // from the rendered element.
  const fieldsHtml = _pendingFormFields.map((f, i) => {
    const id = `acct-field-${i}`;
    if (f.type === "checkbox") {
      return `<label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:14px;color:var(--text-2)">
        <input type="checkbox" id="${id}"> ${esc(f.label || f.key)}</label>`;
    }
    const inputType = f.secret ? "password" : "text";
    const req = f.required ? ` <span style="color:var(--danger)">*</span>` : "";
    return `<div style="margin-bottom:14px">
      <div style="font-size:13px;color:var(--text-2);margin-bottom:6px">${esc(f.label || f.key)}${req}</div>
      <input class="form-input" id="${id}" type="${inputType}" placeholder="${escAttr(f.placeholder || "")}">
    </div>`;
  }).join("");
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">添加 ${esc(ch.name)} 账号</div>
    ${ch.type === "qq" ? `<div style="font-size:12px;color:var(--text-3);margin:4px 0 14px">前往 <a href="https://q.qq.com/qqbot/openclaw/" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:underline">QQ 开放平台 OpenClaw 机器人配置页面</a> 获取 AppID 和 AppSecret，并开通 C2C 私信消息权限</div>` : (ch.hint ? `<div style="font-size:12px;color:var(--text-3);margin:4px 0 14px">${esc(ch.hint)}</div>` : "")}
    ${fieldsHtml}
    <div id="acct-form-err" style="color:var(--danger);font-size:13px;margin-bottom:10px;display:none"></div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.submitFormAccount()">添加</button>
    </div>
  </div>`);
}

function _showFormError(msg) {
  const err = $("acct-form-err");
  if (err) { err.textContent = msg; err.style.display = "block"; }
}

export async function submitFormAccount() {
  const fields = {};
  for (let i = 0; i < _pendingFormFields.length; i++) {
    const f = _pendingFormFields[i];
    const el = $(`acct-field-${i}`);
    if (!el) continue;
    if (f.type === "checkbox") {
      fields[f.key] = el.checked;
    } else {
      fields[f.key] = el.value.trim();
      if (f.required && !fields[f.key]) {
        _showFormError(`请填写${f.label || f.key}`);
        return;
      }
    }
  }
  showLoading("添加中…");
  try {
    const res = await api.post("/api/accounts", {
      channel_type: _pendingFormChannel,
      fields,
    });
    hideLoading();
    if (res.status >= 400) {
      _showFormError((res.data && res.data.error) || "添加失败");
      return;
    }
    closeOverlay();
    toast("添加成功", "success");
    renderSettingsAccounts();
  } catch (e) {
    hideLoading();
    _showFormError("添加失败，请稍后重试");
  }
}

let _pendingNoteBotId = null;
let _qrPollBaseUrl = "";
let _qrVerifyCode = "";
let _qrPolling = false;

async function pollQrStatus(qrcode, deadline = Date.now() + 5 * 60 * 1000) {
  if (!_qrPolling) return;
  const el = $("qr-poll-status");
  if (!el) { _qrPolling = false; return; }
  const finish = (message) => {
    _qrPolling = false;
    _qrVerifyCode = "";
    _qrPollBaseUrl = "";
    clearVerifyInput(el);
    el.textContent = message;
  };

  try {
    // One submission consumes the code even when the request fails.
    const verifyCode = _qrVerifyCode;
    _qrVerifyCode = "";
    const res = await fetchQrStatus(qrcode, _qrPollBaseUrl, verifyCode, deadline);
    if (!_qrPolling || $("qr-poll-status") !== el) return;
    if (res.status === "local_timeout") {
      finish("等待已超时，请重新开始连接");
      return;
    }
    if (res.status === "error" || res.retryable === false) {
      finish(res.errmsg || res.error || "连接未完成，请重新开始");
      return;
    }
    if (res.retryable && res.error_kind !== "timeout") {
      el.textContent = res.errmsg || "连接暂时中断，正在重试…";
    }
    if (res.status === "binded_redirect") {
      finish("该微信已连接，无需重复添加");
      setTimeout(() => {
        if ($("qr-poll-status") === el) { closeOverlay(); renderSettingsAccounts(); }
      }, 800);
      return;
    }
    if (res.status === "confirmed") {
      finish("登录成功！");
      const botId = res.bot_id || "";
      setTimeout(() => {
        if ($("qr-poll-status") !== el) return;
        closeOverlay();
        if (botId) {
          _pendingNoteBotId = botId;
          setTimeout(() => showNoteSheet(), 300);
        } else {
          renderSettingsAccounts();
        }
      }, 800);
      return;
    }
    if (res.status === "scaned") {
      el.textContent = "扫描成功，请在手机上确认";
    } else if (res.status === "scaned_but_redirect") {
      el.textContent = "扫描成功，正在切换线路…";
      const host = res.redirect_host;
      if (host) _qrPollBaseUrl = `https://${host}`;
    } else if (res.status === "need_verifycode") {
      el.textContent = "请输入手机上显示的验证码";
      renderVerifyInput(el, (code) => { _qrVerifyCode = code; });
    } else if (res.status === "verify_code_blocked") {
      finish("验证码错误次数过多，请重新开始");
      return;
    } else if (res.status === "expired") {
      finish("二维码已过期，请重新开始");
      return;
    }
  } catch (e) { /* silent */ }
  setTimeout(() => { if ($("qr-poll-status") === el) pollQrStatus(qrcode, deadline); }, 2000);
}

function showNoteSheet() {
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">设置账号备注</div>
    <div style="font-size:13px;color:var(--text-3);text-align:center;margin-bottom:16px">为新添加的账号设置一个易于识别的名称</div>
    <div style="margin-bottom:20px">
      <input class="form-input" id="new-acct-note" placeholder="输入备注名">
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.skipAccountNote()">跳过</button>
      <button class="btn-primary" onclick="PawzoChat.confirmAccountNote()">保存</button>
    </div>
  </div>`, () => {
    _pendingNoteBotId = null;
    renderSettingsAccounts();
  });
}

export function skipAccountNote() {
  _pendingNoteBotId = null;
  closeOverlay();
}

export async function confirmAccountNote() {
  const note = $("new-acct-note")?.value.trim();
  if (note && _pendingNoteBotId) {
    showLoading("保存中…");
    try {
      await api.patch(`/api/accounts/${encodeURIComponent(_pendingNoteBotId)}`, { note });
    } catch (_) { /* best-effort */ }
    finally { hideLoading(); }
  }
  _pendingNoteBotId = null;
  closeOverlay();
}

function renderAccountDetail(data) {
  _currentAccount = data;
  const personaName = data.linked_persona
    ? (state.personas.find(p => p.id === data.linked_persona)?.name || data.linked_persona)
    : "未链接";

  setTopBar("账号详情", true,
    `<button class="btn-text" onclick="PawzoChat.saveAccountNote()">保存</button>`
  );
  const vs = "flex:1;text-align:right;font-size:14px;color:var(--text-2)";
  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="form-group"><div class="form-row"><label>备注名</label><input id="acct-note" value="${esc(data.note || "")}" placeholder="为账号设置一个备注"></div></div>
      <div class="form-group"><div class="form-row"><label>Bot ID</label><span style="${vs};font-size:12px;word-break:break-all">${esc(data.bot_id)}</span></div></div>
      <div class="form-group"><div class="form-row"><label>状态</label><span style="${vs}">${data.connection_state === "cooldown" ? '<span style="color:var(--text-3)">凭据冷却中</span>' : data.online ? '<span style="color:var(--success)">● 在线</span>' : '<span style="color:var(--text-3)">● 离线</span>'}</span></div></div>
      <div class="form-group"><div class="form-row"><label>链接角色</label><span style="${vs}">${esc(personaName)}</span></div></div>
      <div class="form-group"><div class="form-row"><label>创建时间</label><span style="${vs}">${data.created_at ? formatTime(data.created_at) : "未知"}</span></div></div>
    </div>
    <div class="persona-actions">
      <button class="btn-text danger" onclick="PawzoChat.deleteAccount()">退出登录</button>
    </div>
  </div>`;
}

export async function saveAccountNote() {
  if (!_currentAccount) return;
  const note = $("acct-note").value.trim();
  showLoading("保存中…");
  try {
    await api.patch(`/api/accounts/${encodeURIComponent(_currentAccount.bot_id)}`, { note });
    toast("已保存", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function deleteAccount() {
  if (!_currentAccount) return;
  const ok = await confirm("退出登录", "确认退出该账号？相关链接也会被清除。", true);
  if (!ok) return;
  showLoading("操作中…");
  try {
    await api.del(`/api/accounts/${encodeURIComponent(_currentAccount.bot_id)}`);
    toast("已退出", "success");
    goBack();
    refreshSidebar();
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

/* ============ Providers ============ */

const PROVIDER_NAME_RE = /^[a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff_\-]*$/;
function validateProviderName(name) {
  if (!name) return "名称不能为空";
  if (name.length > 30) return "名称不能超过 30 个字符";
  if (!PROVIDER_NAME_RE.test(name))
    return "名称只能包含字母、数字、中文、下划线和连字符，且不能以符号开头";
  return null;
}

let _providerPresets = {};
let _presetModels = {};
let _editModels = [];
let _fetchedModels = [];
let _editingProviderName = "";
const _PRESET_LABELS = {
  openai: "OpenAI (GPT)", anthropic: "Anthropic (Claude)", google: "Google (Gemini)",
  deepseek: "DeepSeek", siliconflow: "硅基流动", custom: "自定义",
};
function _presetLabel(id) {
  return _providerPresets[id]?.name || _PRESET_LABELS[id] || id;
}
const _CAPABILITY_LABELS = {
  vision: "视觉", tool_use: "工具调用", streaming: "流式", reasoning: "推理",
};
const _OPENAI_ENDPOINTS = { openai_compatible: "/chat/completions", openai_responses: "/responses" };
let _providerAppendPaths = {};

function _responsesEndpointUrl(baseUrl, endpoint) {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = (endpoint === "/models" ? path.replace(/\/responses$/, "") : path) + endpoint;
    return url.href;
  } catch {
    return baseUrl.replace(/\/+$/, "") + endpoint;
  }
}

function _previewUrl(preset, type, baseUrl, appendPath) {
  if (preset && preset !== "custom") {
    const info = _providerPresets[preset];
    if (!info) return "";
    if (preset === "google") {
      return `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`;
    }
    return info.base_url + info.endpoint_path;
  }
  if (!baseUrl) return "";
  if (type === "anthropic") return baseUrl.replace(/\/+$/, "") + "/messages";
  if (type === "openai_responses" && appendPath) return _responsesEndpointUrl(baseUrl, "/responses");
  if (appendPath) return baseUrl.replace(/\/+$/, "") + (_OPENAI_ENDPOINTS[type] || "/chat/completions");
  return baseUrl;
}

async function renderSettingsProviders() {
  setTopBar("对话服务商", true,
    `<button class="top-btn" onclick="PawzoChat.openProviderTypeSheet()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/providers");
    const providers = res.providers || [];
    _providerPresets = res.presets || {};
    _presetModels = res.preset_models || {};
    if (providers.length === 0) {
      content().innerHTML = `<div class="empty-state">
        <div class="empty-text">没有已配置的对话服务商</div>
        <button onclick="PawzoChat.openProviderTypeSheet()">添加对话服务商</button>
      </div>`;
      return;
    }
    const html = providers.map(p => {
      const presetLabel = _presetLabel(p.preset);
      const tag = p.preset !== "custom"
        ? `<span style="font-size:11px;color:var(--primary);background:var(--primary-light);padding:1px 6px;border-radius:4px">${esc(presetLabel)}</span>`
        : `<span style="font-size:11px;color:var(--text-3)">自定义</span>`;
      const modelCount = (p.models || []).length;
      return `<div class="card" style="margin:8px 16px;cursor:pointer" onclick="PawzoChat.pushPage('providerEdit',{name:'${esc(p.name)}'})">
        <div style="padding:14px 16px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:15px;font-weight:600">${esc(p.name)}</span>
            ${tag}
          </div>
          <div style="font-size:13px;color:var(--text-2);margin-top:4px">${modelCount} 个模型</div>
        </div>
      </div>`;
    }).join("");
    content().innerHTML = `<div class="page">${html}</div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export function openProviderTypeSheet() {
  const ids = Object.keys(_providerPresets);
  const items = ids.map(id =>
    `<div class="sheet-item" onclick="PawzoChat.closeOverlay();PawzoChat.pushPage('providerEdit',{isNew:true,preset:'${esc(id)}'})">${esc(_presetLabel(id))}</div>`
  ).join("");
  const customItem = `<div class="sheet-item" onclick="PawzoChat.closeOverlay();PawzoChat.pushPage('providerEdit',{isNew:true,preset:'custom'})">${esc(_PRESET_LABELS.custom)}</div>`;
  showSheet(`<div class="sheet-title">选择对话服务商类型</div>${items}${customItem}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
}

async function renderProviderEdit(data) {
  const isNew = data.isNew;
  setTopBar(isNew ? "新建对话服务商" : "编辑对话服务商", true,
    `<button class="btn-text" onclick="PawzoChat.saveProvider(${isNew},'${esc(data.name || "")}')">保存</button>`
  );

  let p = { name: "", preset: "", type: "openai_compatible", base_url: "", api_key_set: false, append_chat_path: true, models: [] };

  try {
    const res = await api.get("/api/providers");
    _providerPresets = res.presets || {};
    _presetModels = res.preset_models || {};
    if (!isNew && data.name) {
      p = (res.providers || []).find(pr => pr.name === data.name) || p;
    }
  } catch (e) { /* silent */ }

  if (isNew && data.preset) p.preset = data.preset;

  _editModels = JSON.parse(JSON.stringify(p.models || []));
  _editingProviderName = data.name || "";

  const presetOpts = Object.keys(_providerPresets)
    .map(id => `<option value="${id}" ${p.preset === id ? "selected" : ""}>${esc(_presetLabel(id))}</option>`)
    .join("")
    + `<option value="custom" ${(!p.preset || p.preset === "custom") ? "selected" : ""}>自定义</option>`;

  const customTypes = [["openai_compatible", "OpenAI Compatible"], ["openai_responses", "OpenAI Responses"], ["anthropic", "Anthropic"]];
  const typeOpts = customTypes.map(([v, l]) => `<option value="${v}" ${v === p.type ? "selected" : ""}>${l}</option>`).join("");

  const isCustom = !p.preset || p.preset === "custom";
  const showAppend = isCustom && !!_OPENAI_ENDPOINTS[p.type];
  _providerAppendPaths = {
    openai_compatible: p.append_chat_path ?? true,
    openai_responses: p.append_responses_path ?? true,
  };

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="form-group"><div class="form-row"><label>服务商</label><select id="pv-preset" onchange="PawzoChat.onProviderPresetChange()">${presetOpts}</select></div></div>
      <div class="form-group"><div class="form-row"><label>名称</label><input id="pv-name" value="${esc(isNew && !isCustom && p.preset ? (_providerPresets[p.preset]?.default_name || _providerPresets[p.preset]?.name || "") : p.name)}" placeholder="对话服务商名称"></div></div>
      <div id="pv-custom-fields" style="${isCustom ? "" : "display:none"}">
        <div class="form-group"><div class="form-row"><label>类型</label><select id="pv-type" onchange="PawzoChat.onProviderTypeChange()">${typeOpts}</select></div></div>
        <div class="form-group"><div class="form-row"><label>Base URL</label><input id="pv-url" value="${esc(p.base_url)}" placeholder="https://api.example.com/v1" oninput="PawzoChat.updateProviderPreview()"></div></div>
        <div class="form-group" id="pv-append-row" style="${showAppend ? "" : "display:none"}"><div class="form-row"><label id="pv-append-label">拼接 ${_OPENAI_ENDPOINTS[p.type] || "/chat/completions"}</label>
          <label class="switch-wrap"><input type="checkbox" id="pv-append" data-path-type="${esc(p.type)}" ${_providerAppendPaths[p.type] !== false ? "checked" : ""} onchange="PawzoChat.updateProviderPreview()"><span class="switch-track"></span></label>
        </div></div>
      </div>
      <div class="form-group"><div class="form-row"><label>API Key</label><input type="password" id="pv-key" placeholder="${p.api_key_set ? '已设置 (留空不修改)' : '输入 API Key'}"></div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="form-group"><div class="form-row" style="flex-direction:column;align-items:flex-start;gap:4px">
        <label style="color:var(--text-3);font-size:12px">请求地址预览</label>
        <span id="pv-preview" style="font-size:13px;color:var(--text-2);word-break:break-all"></span>
      </div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <span>模型列表</span>
        <div style="display:flex;gap:8px">
          <button id="pv-fetch-models-btn" class="btn-outline btn-sm" onclick="PawzoChat.fetchRemoteModels()" style="${showAppend ? '' : 'display:none'}">拉取模型</button>
          <button id="pv-import-preset-btn" class="btn-outline btn-sm" onclick="PawzoChat.importPresetModels()" style="${isCustom ? 'display:none' : ''}">导入预设</button>
          <button class="btn-outline btn-sm" onclick="PawzoChat.addEditModel()">添加</button>
        </div>
      </div>
      <div id="pv-models-list"></div>
    </div>
    ${!isNew ? `<div class="persona-actions mt-16"><button class="btn-text danger" onclick="PawzoChat.deleteProvider('${esc(data.name)}')">删除该对话服务商</button></div>` : ""}
  </div>`;

  updateProviderPreview();
  _renderModelsList();

  if (isNew && data.preset && data.preset !== "custom") {
    importPresetModels();
  }
}

function _renderModelsList() {
  const el = $("pv-models-list");
  if (!el) return;
  if (_editModels.length === 0) {
    el.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:13px">暂无模型，点击"导入预设"或"添加"</div>`;
    return;
  }
  el.innerHTML = _editModels.map((m, i) => {
    const caps = (m.capabilities || []).map(c => {
      const label = _CAPABILITY_LABELS[c] || c;
      return `<span class="cap-tag">${esc(label)}</span>`;
    }).join("");
    const ctx = m.context_window ? `${Math.round(m.context_window/1000)}K` : "—";
    const maxOut = m.max_output ? `${Math.round(m.max_output/1000)}K` : "—";
    return `<div class="model-row" style="padding:10px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--divider)">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:500">${esc(m.name || m.id)}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(m.id)} · ctx ${ctx} · out ${maxOut}</div>
        <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">${caps}</div>
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        <button class="btn-icon-sm" onclick="PawzoChat.editModel(${i})" title="编辑" style="font-size:14px">${iconHtml("ri-edit-line")}</button>
        <button class="btn-icon-sm" onclick="PawzoChat.removeEditModel(${i})" title="删除">&times;</button>
      </div>
    </div>`;
  }).join("");
}

export function onProviderPresetChange() {
  const preset = $("pv-preset").value;
  const isCustom = preset === "custom";
  const fields = $("pv-custom-fields");
  if (fields) fields.style.display = isCustom ? "" : "none";
  const importBtn = $("pv-import-preset-btn");
  if (importBtn) importBtn.style.display = isCustom ? "none" : "";

  if (!isCustom) {
    const info = _providerPresets[preset];
    if (info) {
      const nameEl = $("pv-name");
      if (nameEl) {
        const cur = nameEl.value.trim();
        const isAutoName = !cur || Object.values(_providerPresets).some(p => p.name === cur || p.default_name === cur);
        if (isAutoName) nameEl.value = info.default_name || info.name;
      }
    }
  }
  onProviderTypeChange();
  updateProviderPreview();
}

export function onProviderTypeChange() {
  const preset = $("pv-preset").value;
  const isCustom = preset === "custom";
  const type = $("pv-type")?.value || "openai_compatible";
  const appendRow = $("pv-append-row");
  if (appendRow) appendRow.style.display = (isCustom && _OPENAI_ENDPOINTS[type]) ? "" : "none";
  const appendInput = $("pv-append");
  if (appendInput) {
    _providerAppendPaths[appendInput.dataset.pathType] = appendInput.checked;
    appendInput.checked = _providerAppendPaths[type] ?? true;
    appendInput.dataset.pathType = type;
  }
  const appendLabel = $("pv-append-label");
  if (appendLabel) appendLabel.textContent = `拼接 ${_OPENAI_ENDPOINTS[type] || "/chat/completions"}`;
  const fetchBtn = $("pv-fetch-models-btn");
  if (fetchBtn) fetchBtn.style.display = (isCustom && _OPENAI_ENDPOINTS[type]) ? "" : "none";
  updateProviderPreview();
}

export function updateProviderPreview() {
  const preset = $("pv-preset")?.value || "custom";
  const type = $("pv-type")?.value || "openai_compatible";
  const baseUrl = $("pv-url")?.value.trim() || "";
  const appendPath = $("pv-append")?.checked ?? true;
  const url = _previewUrl(preset, type, baseUrl, appendPath);
  const el = $("pv-preview");
  if (el) el.textContent = url || "—";
}

export function importPresetModels() {
  const preset = $("pv-preset")?.value || "custom";
  const presets = _presetModels[preset];
  if (!presets || presets.length === 0) {
    toast("该对话服务商无预设模型列表", "error");
    return;
  }
  const existingIds = new Set(_editModels.map(m => m.id));
  let added = 0;
  for (const pm of presets) {
    if (!existingIds.has(pm.id)) {
      _editModels.push(JSON.parse(JSON.stringify(pm)));
      added++;
    }
  }
  _renderModelsList();
  toast(added > 0 ? `已导入 ${added} 个模型` : "预设模型已存在", added > 0 ? "success" : "info");
}

export function fetchRemoteModels() {
  const baseUrl = ($("pv-url")?.value || "").trim();
  const defaultUrl = !baseUrl ? "" : ($("pv-type")?.value === "openai_responses"
    ? _responsesEndpointUrl(baseUrl, "/models") : baseUrl.replace(/\/+$/, "") + "/models");
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">拉取模型</div>
    <div class="form-stack" style="margin:16px 0">
      <div style="font-size:13px;color:var(--text-2)">输入模型列表 API 地址：</div>
      <input class="form-input" id="fetch-models-url" value="${esc(defaultUrl)}" placeholder="https://api.example.com/v1/models">
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.confirmFetchModels()">拉取</button>
    </div>
  </div>`);
}

export async function confirmFetchModels() {
  const url = $("fetch-models-url")?.value.trim();
  if (!url) { toast("请输入 URL", "error"); return; }

  closeOverlay();
  showLoading("拉取模型中…");

  try {
    const apiKey = $("pv-key")?.value || "";
    const res = await api.post("/api/providers/_fetch-models", {
      url,
      api_key: apiKey,
      provider_name: _editingProviderName || "",
    });

    if (res.status >= 400) {
      toast(res.data?.error || "拉取失败", "error");
      return;
    }

    const models = res.data.models || [];
    if (models.length === 0) {
      toast("未获取到任何模型", "info");
      return;
    }

    _fetchedModels = models;
    _showModelSelectionSheet();
  } catch (e) {
    toast("拉取失败", "error");
  } finally {
    hideLoading();
  }
}

function _showModelSelectionSheet() {
  const existingIds = new Set(_editModels.map(m => m.id));

  const rows = _fetchedModels.map((m, i) => {
    const isDup = existingIds.has(m.id);
    return `<label style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--divider);${isDup ? 'opacity:0.5' : ''}">
      <input type="checkbox" class="fetch-model-cb" data-idx="${i}" ${isDup ? 'disabled' : 'checked'}>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px">${esc(m.id)}</div>
        ${isDup ? '<div style="font-size:11px;color:var(--text-3)">已存在</div>' : ''}
      </div>
    </label>`;
  }).join("");

  showSheet(`<div class="sheet-body">
    <div class="sheet-title">选择要导入的模型</div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0">
      <span style="font-size:13px;color:var(--text-3)">共 ${_fetchedModels.length} 个模型</span>
      <label style="font-size:13px;display:flex;align-items:center;gap:4px;color:var(--text-2)">
        <input type="checkbox" id="fetch-select-all" checked onchange="PawzoChat.toggleFetchSelectAll(this.checked)"> 全选
      </label>
    </div>
    <div id="fetch-model-list" style="overflow-y:auto;-webkit-overflow-scrolling:touch">${rows}</div>
    <div class="form-actions mt-16">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.confirmModelSelection()">导入</button>
    </div>
  </div>`, () => {
    document.getElementById("action-sheet").style.overflowY = "";
  });

  requestAnimationFrame(() => {
    const sheet = document.getElementById("action-sheet");
    const list = document.getElementById("fetch-model-list");
    if (!sheet || !list) return;
    const maxH = parseFloat(getComputedStyle(sheet).maxHeight);
    if (!maxH || !isFinite(maxH)) return;
    const chrome = sheet.scrollHeight - list.scrollHeight;
    const available = maxH - chrome;
    if (available < list.scrollHeight) {
      list.style.maxHeight = Math.max(available, 100) + "px";
    }
    sheet.style.overflowY = "hidden";
  });
}

export function toggleFetchSelectAll(checked) {
  document.querySelectorAll(".fetch-model-cb:not(:disabled)").forEach(cb => { cb.checked = checked; });
}

export function confirmModelSelection() {
  const existingIds = new Set(_editModels.map(m => m.id));
  const checkboxes = document.querySelectorAll(".fetch-model-cb:checked:not(:disabled)");
  let added = 0;

  checkboxes.forEach(cb => {
    const idx = parseInt(cb.dataset.idx);
    const m = _fetchedModels[idx];
    if (m && !existingIds.has(m.id)) {
      const lower = m.id.toLowerCase();
      const caps = [];
      if (/gpt|claude|gemini/.test(lower)) { caps.push("vision", "tool_use"); }
      else { caps.push("tool_use"); }
      _editModels.push({
        id: m.id,
        name: m.name || m.id,
        capabilities: caps,
        context_window: null,
        max_output: null,
      });
      added++;
    }
  });

  closeOverlay();
  _renderModelsList();
  toast(added > 0 ? `已导入 ${added} 个模型，请检查能力设置` : "未导入新模型", added > 0 ? "success" : "info");
}

export function addEditModel() {
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">添加模型</div>
    <div class="form-stack" style="margin:16px 0">
      <input class="form-input" id="add-model-id" placeholder="模型 ID (必填，如 gpt-4o)">
      <input class="form-input" id="add-model-name" placeholder="显示名称 (可选)">
      <div style="font-size:13px;color:var(--text-2)">能力标记 (勾选适用项):</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <label><input type="checkbox" id="add-cap-vision"> 视觉</label>
        <label><input type="checkbox" id="add-cap-tool" checked> 工具调用</label>
      </div>
      <div class="form-columns">
        <input class="form-input" id="add-model-ctx" type="number" placeholder="上下文窗口 (可选)">
        <input class="form-input" id="add-model-out" type="number" placeholder="最大输出 (可选)">
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.confirmAddModel()">添加</button>
    </div>
  </div>`);
}

export function confirmAddModel() {
  const id = $("add-model-id")?.value.trim();
  if (!id) { toast("模型 ID 不能为空", "error"); return; }
  if (_editModels.some(m => m.id === id)) { toast("模型已存在", "error"); return; }
  const caps = [];
  if ($("add-cap-vision")?.checked) caps.push("vision");
  if ($("add-cap-tool")?.checked) caps.push("tool_use");
  const ctx = parseInt($("add-model-ctx")?.value) || null;
  const maxOut = parseInt($("add-model-out")?.value) || null;
  _editModels.push({
    id,
    name: $("add-model-name")?.value.trim() || id,
    capabilities: caps,
    context_window: ctx,
    max_output: maxOut,
  });
  closeOverlay();
  _renderModelsList();
}

export function removeEditModel(idx) {
  _editModels.splice(idx, 1);
  _renderModelsList();
}

export function editModel(idx) {
  const m = _editModels[idx];
  if (!m) return;
  const hasVision = (m.capabilities || []).includes("vision");
  const hasTool = (m.capabilities || []).includes("tool_use");
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">编辑模型</div>
    <div class="form-stack" style="margin:16px 0">
      <input class="form-input" id="edit-model-id" value="${esc(m.id)}" placeholder="模型 ID (必填，如 gpt-4o)">
      <input class="form-input" id="edit-model-name" value="${esc(m.name || '')}" placeholder="显示名称 (可选)">
      <div style="font-size:13px;color:var(--text-2)">能力标记 (勾选适用项):</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <label><input type="checkbox" id="edit-cap-vision" ${hasVision ? 'checked' : ''}> 视觉</label>
        <label><input type="checkbox" id="edit-cap-tool" ${hasTool ? 'checked' : ''}> 工具调用</label>
      </div>
      <div class="form-columns">
        <input class="form-input" id="edit-model-ctx" type="number" value="${m.context_window || ''}" placeholder="上下文窗口 (可选)">
        <input class="form-input" id="edit-model-out" type="number" value="${m.max_output || ''}" placeholder="最大输出 (可选)">
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.confirmEditModel(${idx})">保存</button>
    </div>
  </div>`);
}

export function confirmEditModel(idx) {
  const id = $("edit-model-id")?.value.trim();
  if (!id) { toast("模型 ID 不能为空", "error"); return; }
  if (_editModels.some((m, i) => i !== idx && m.id === id)) { toast("模型 ID 已存在", "error"); return; }
  const caps = [];
  if ($("edit-cap-vision")?.checked) caps.push("vision");
  if ($("edit-cap-tool")?.checked) caps.push("tool_use");
  const ctx = parseInt($("edit-model-ctx")?.value) || null;
  const maxOut = parseInt($("edit-model-out")?.value) || null;
  _editModels[idx] = {
    id,
    name: $("edit-model-name")?.value.trim() || id,
    capabilities: caps,
    context_window: ctx,
    max_output: maxOut,
  };
  closeOverlay();
  _renderModelsList();
}

export async function saveProvider(isNew, oldName) {
  const preset = $("pv-preset").value;
  const body = {
    name: $("pv-name").value.trim(),
    preset,
    api_key: $("pv-key").value,
    models: _editModels,
  };
  if (preset === "custom") {
    body.type = $("pv-type").value;
    body.base_url = $("pv-url").value.trim();
    const appendField = body.type === "openai_responses" ? "append_responses_path" : "append_chat_path";
    body[appendField] = $("pv-append")?.checked ?? true;
  }

  const nameErr = validateProviderName(body.name);
  if (nameErr) { toast(nameErr, "error"); return; }
  if (preset === "custom" && !body.base_url) { toast("请输入 Base URL", "error"); return; }

  showLoading("保存中…");
  try {
    let res;
    if (isNew) { res = await api.post("/api/providers", body); }
    else { res = await api.put(`/api/providers/${encodeURIComponent(oldName)}`, body); }
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    toast("已保存", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function deleteProvider(name) {
  const ok = await confirm("删除对话服务商", `确认删除 "${name}"？`, true);
  if (!ok) return;
  showLoading("删除中…");
  try { await api.del(`/api/providers/${encodeURIComponent(name)}`); toast("已删除", "success"); goBack(); refreshSidebar(); }
  catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

/* ============ Image Providers ============ */

let _imageProviderPresets = {};
let _imagePresetModels = {};
let _imageModelTypeOptions = [];
let _editImageModels = [];

const _IMAGE_PRESET_LABELS = {
  openai: "OpenAI", google: "Google NanoBanana", novelai: "NovelAI",
  custom: "自定义 (OpenAI 兼容)",
};
function _imagePresetLabel(id) {
  return _imageProviderPresets[id]?.name || _IMAGE_PRESET_LABELS[id] || id;
}

const _MODEL_TYPE_SHORT_LABEL = {
  openai_image: "OpenAI",
  gemini_chat_image: "Gemini Chat",
  gemini_image: "Gemini Native",
  novelai_image: "NovelAI",
};
function _imageTypeLabel(type) {
  return _MODEL_TYPE_SHORT_LABEL[type] || type || "—";
}

function _imageDefaultTypeForPreset(preset) {
  if (preset && preset !== "custom") {
    return _imageProviderPresets[preset]?.default_model_type || "openai_image";
  }
  return "openai_image";
}

function _imagePreviewUrl(preset, baseUrl) {
  if (preset && preset !== "custom") {
    const info = _imageProviderPresets[preset];
    if (!info) return "";
    return info.base_url + info.endpoint_path;
  }
  if (!baseUrl) return "";
  // For custom relays each model can route to a different endpoint, so the
  // top-level preview only shows base_url. Per-model endpoints surface in the
  // model row's type tag.
  return baseUrl.replace(/\/+$/, "");
}

function _imageModelTypeOptionsHTML(selected) {
  return _imageModelTypeOptions.map(o =>
    `<option value="${esc(o.value)}" ${o.value === selected ? "selected" : ""}>${esc(o.label)}</option>`
  ).join("");
}

async function renderSettingsImageProviders() {
  setTopBar("生图服务商", true,
    `<button class="top-btn" onclick="PawzoChat.openImageProviderTypeSheet()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/image-providers");
    const providers = res.providers || [];
    _imageProviderPresets = res.presets || {};
    _imagePresetModels = res.preset_models || {};
    _imageModelTypeOptions = res.model_type_options || [];
    if (providers.length === 0) {
      content().innerHTML = `<div class="empty-state">
        <div class="empty-text">没有已配置的生图服务商</div>
        <button onclick="PawzoChat.openImageProviderTypeSheet()">添加生图服务商</button>
      </div>`;
      return;
    }
    const testEntryCard = `<div class="card" style="margin:8px 16px;cursor:pointer" onclick="PawzoChat.openImageTest()">
      <div style="padding:14px 16px;display:flex;align-items:center;gap:12px">
        <div style="width:36px;height:36px;border-radius:8px;background:var(--primary-light);display:flex;align-items:center;justify-content:center;color:var(--primary);flex-shrink:0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v7L4.5 19a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 10V3"/><path d="M7 14h10"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:600">生图测试</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">选择服务商和模型测试调用</div>
        </div>
        <span style="color:var(--text-3);font-size:18px">›</span>
      </div>
    </div>`;
    const html = providers.map(p => {
      const presetLabel = _imagePresetLabel(p.preset);
      const tag = p.preset !== "custom"
        ? `<span style="font-size:11px;color:var(--primary);background:var(--primary-light);padding:1px 6px;border-radius:4px">${esc(presetLabel)}</span>`
        : `<span style="font-size:11px;color:var(--text-3)">自定义</span>`;
      const modelCount = (p.models || []).length;
      return `<div class="card" style="margin:8px 16px;cursor:pointer" onclick="PawzoChat.pushPage('imageProviderEdit',{name:'${esc(p.name)}'})">
        <div style="padding:14px 16px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:15px;font-weight:600">${esc(p.name)}</span>
            ${tag}
          </div>
          <div style="font-size:13px;color:var(--text-2);margin-top:4px">${modelCount} 个模型</div>
        </div>
      </div>`;
    }).join("");
    content().innerHTML = `<div class="page">${testEntryCard}${html}</div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export function openImageProviderTypeSheet() {
  const ids = Object.keys(_imageProviderPresets);
  const items = ids.map(id =>
    `<div class="sheet-item" onclick="PawzoChat.closeOverlay();PawzoChat.pushPage('imageProviderEdit',{isNew:true,preset:'${esc(id)}'})">${esc(_imagePresetLabel(id))}</div>`
  ).join("");
  const customItem = `<div class="sheet-item" onclick="PawzoChat.closeOverlay();PawzoChat.pushPage('imageProviderEdit',{isNew:true,preset:'custom'})">${esc(_IMAGE_PRESET_LABELS.custom)}</div>`;
  showSheet(`<div class="sheet-title">选择生图服务商类型</div>${items}${customItem}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
}

async function renderImageProviderEdit(data) {
  const isNew = data.isNew;
  setTopBar(isNew ? "新建生图服务商" : "编辑生图服务商", true,
    `<button class="btn-text" onclick="PawzoChat.saveImageProvider(${isNew},'${esc(data.name || "")}')">保存</button>`
  );

  let p = { name: "", preset: "", type: "openai_image", base_url: "", api_key_set: false, models: [] };

  try {
    const res = await api.get("/api/image-providers");
    _imageProviderPresets = res.presets || {};
    _imagePresetModels = res.preset_models || {};
    _imageModelTypeOptions = res.model_type_options || [];
    if (!isNew && data.name) {
      p = (res.providers || []).find(pr => pr.name === data.name) || p;
    }
  } catch (e) { /* silent */ }

  if (isNew && data.preset) p.preset = data.preset;

  _editImageModels = JSON.parse(JSON.stringify(p.models || []));

  const presetOpts = Object.keys(_imageProviderPresets)
    .map(id => `<option value="${id}" ${p.preset === id ? "selected" : ""}>${esc(_imagePresetLabel(id))}</option>`)
    .join("")
    + `<option value="custom" ${(!p.preset || p.preset === "custom") ? "selected" : ""}>自定义 (OpenAI 兼容)</option>`;

  const isCustom = !p.preset || p.preset === "custom";

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="form-group"><div class="form-row"><label>服务商</label><select id="ipv-preset" onchange="PawzoChat.onImageProviderPresetChange()">${presetOpts}</select></div></div>
      <div class="form-group"><div class="form-row"><label>名称</label><input id="ipv-name" value="${esc(isNew && !isCustom && p.preset ? (_imageProviderPresets[p.preset]?.default_name || _imageProviderPresets[p.preset]?.name || "") : p.name)}" placeholder="生图服务商名称"></div></div>
      <div id="ipv-custom-fields" style="${isCustom ? "" : "display:none"}">
        <div class="form-group"><div class="form-row" style="padding-bottom:4px"><label>Base URL</label><input id="ipv-url" value="${esc(p.base_url)}" placeholder="https://api.example.com/v1" oninput="PawzoChat.updateImageProviderPreview()"></div><div class="form-hint" style="line-height:1.5">同一服务商的不同模型可走不同接口，请在每个模型上单独设置「调用方式」。</div></div>
      </div>
      <div class="form-group"><div class="form-row"><label>API Key</label><input type="password" id="ipv-key" placeholder="${p.api_key_set ? '已设置 (留空不修改)' : '输入 API Key'}"></div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="form-group"><div class="form-row" style="flex-direction:column;align-items:flex-start;gap:4px">
        <label style="color:var(--text-3);font-size:12px">请求地址预览</label>
        <span id="ipv-preview" style="font-size:13px;color:var(--text-2);word-break:break-all"></span>
      </div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
        <span>模型列表</span>
        <div style="display:flex;gap:8px">
          <button id="ipv-import-preset-btn" class="btn-outline btn-sm" onclick="PawzoChat.importImagePresetModels()" style="${isCustom ? 'display:none' : ''}">导入预设</button>
          <button class="btn-outline btn-sm" onclick="PawzoChat.addEditImageModel()">添加</button>
        </div>
      </div>
      <div id="ipv-models-list"></div>
    </div>
    ${!isNew ? `<div class="persona-actions mt-16">
      <button class="btn-text danger" onclick="PawzoChat.deleteImageProvider('${esc(data.name)}')">删除该生图服务商</button>
    </div>` : ""}
  </div>`;

  updateImageProviderPreview();
  _renderImageModelsList();

  if (isNew && data.preset && data.preset !== "custom") {
    importImagePresetModels();
  }
}

function _renderImageModelsList() {
  const el = $("ipv-models-list");
  if (!el) return;
  if (_editImageModels.length === 0) {
    el.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:13px">暂无模型，点击"导入预设"或"添加"</div>`;
    return;
  }
  el.innerHTML = _editImageModels.map((m, i) => {
    const typeTag = `<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg);color:var(--text-2);border:1px solid var(--divider)">${esc(_imageTypeLabel(m.type))}</span>`;
    return `<div class="model-row" style="padding:10px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--divider)">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:500;display:flex;align-items:center;gap:6px">${esc(m.name || m.id)} ${typeTag}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(m.id)}</div>
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        <button class="btn-icon-sm" onclick="PawzoChat.editImageModel(${i})" title="编辑" style="font-size:14px">${iconHtml("ri-edit-line")}</button>
        <button class="btn-icon-sm" onclick="PawzoChat.removeEditImageModel(${i})" title="删除">&times;</button>
      </div>
    </div>`;
  }).join("");
}

export function onImageProviderPresetChange() {
  const preset = $("ipv-preset").value;
  const isCustom = preset === "custom";
  const fields = $("ipv-custom-fields");
  if (fields) fields.style.display = isCustom ? "" : "none";
  const importBtn = $("ipv-import-preset-btn");
  if (importBtn) importBtn.style.display = isCustom ? "none" : "";

  if (!isCustom) {
    const info = _imageProviderPresets[preset];
    if (info) {
      const nameEl = $("ipv-name");
      if (nameEl) {
        const cur = nameEl.value.trim();
        const isAutoName = !cur || Object.values(_imageProviderPresets).some(p => p.name === cur || p.default_name === cur);
        if (isAutoName) nameEl.value = info.default_name || info.name;
      }
    }
  }
  updateImageProviderPreview();
}

export function updateImageProviderPreview() {
  const preset = $("ipv-preset")?.value || "custom";
  const baseUrl = $("ipv-url")?.value.trim() || "";
  const url = _imagePreviewUrl(preset, baseUrl);
  const el = $("ipv-preview");
  if (el) el.textContent = url || "—";
}

export function importImagePresetModels() {
  const preset = $("ipv-preset")?.value || "custom";
  const presets = _imagePresetModels[preset];
  if (!presets || presets.length === 0) {
    toast("该生图服务商无预设模型列表", "error");
    return;
  }
  const existingIds = new Set(_editImageModels.map(m => m.id));
  const fallbackType = _imageDefaultTypeForPreset(preset);
  let added = 0;
  for (const pm of presets) {
    if (!existingIds.has(pm.id)) {
      _editImageModels.push({
        id: pm.id,
        name: pm.name || pm.id,
        type: pm.type || fallbackType,
      });
      added++;
    }
  }
  _renderImageModelsList();
  toast(added > 0 ? `已导入 ${added} 个模型` : "预设模型已存在", added > 0 ? "success" : "info");
}

export function addEditImageModel() {
  const preset = $("ipv-preset")?.value || "custom";
  const defaultType = _imageDefaultTypeForPreset(preset);
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">添加模型</div>
    <div class="form-stack" style="margin:16px 0">
      <input class="form-input" id="add-img-model-id" placeholder="模型 ID (必填，如 gpt-image-1)">
      <input class="form-input" id="add-img-model-name" placeholder="显示名称 (可选)">
      <div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:4px">调用方式</div>
        <select class="form-input" id="add-img-model-type">${_imageModelTypeOptionsHTML(defaultType)}</select>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.confirmAddImageModel()">添加</button>
    </div>
  </div>`);
}

export function confirmAddImageModel() {
  const id = $("add-img-model-id")?.value.trim();
  if (!id) { toast("模型 ID 不能为空", "error"); return; }
  if (_editImageModels.some(m => m.id === id)) { toast("模型已存在", "error"); return; }
  _editImageModels.push({
    id,
    name: $("add-img-model-name")?.value.trim() || id,
    type: $("add-img-model-type")?.value || _imageDefaultTypeForPreset($("ipv-preset")?.value || "custom"),
  });
  closeOverlay();
  _renderImageModelsList();
}

export function removeEditImageModel(idx) {
  _editImageModels.splice(idx, 1);
  _renderImageModelsList();
}

export function editImageModel(idx) {
  const m = _editImageModels[idx];
  if (!m) return;
  const preset = $("ipv-preset")?.value || "custom";
  const currentType = m.type || _imageDefaultTypeForPreset(preset);
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">编辑模型</div>
    <div class="form-stack" style="margin:16px 0">
      <input class="form-input" id="edit-img-model-id" value="${esc(m.id)}" placeholder="模型 ID (必填)">
      <input class="form-input" id="edit-img-model-name" value="${esc(m.name || '')}" placeholder="显示名称 (可选)">
      <div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:4px">调用方式</div>
        <select class="form-input" id="edit-img-model-type">${_imageModelTypeOptionsHTML(currentType)}</select>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.confirmEditImageModel(${idx})">保存</button>
    </div>
  </div>`);
}

export function confirmEditImageModel(idx) {
  const id = $("edit-img-model-id")?.value.trim();
  if (!id) { toast("模型 ID 不能为空", "error"); return; }
  if (_editImageModels.some((m, i) => i !== idx && m.id === id)) { toast("模型 ID 已存在", "error"); return; }
  _editImageModels[idx] = {
    id,
    name: $("edit-img-model-name")?.value.trim() || id,
    type: $("edit-img-model-type")?.value || _imageDefaultTypeForPreset($("ipv-preset")?.value || "custom"),
  };
  closeOverlay();
  _renderImageModelsList();
}

export async function saveImageProvider(isNew, oldName) {
  const preset = $("ipv-preset").value;
  const body = {
    name: $("ipv-name").value.trim(),
    preset,
    api_key: $("ipv-key").value,
    models: _editImageModels,
  };
  if (preset === "custom") {
    body.base_url = $("ipv-url").value.trim();
  }

  const nameErr = validateProviderName(body.name);
  if (nameErr) { toast(nameErr, "error"); return; }
  if (preset === "custom" && !body.base_url) { toast("请输入 Base URL", "error"); return; }

  showLoading("保存中…");
  try {
    let res;
    if (isNew) { res = await api.post("/api/image-providers", body); }
    else { res = await api.put(`/api/image-providers/${encodeURIComponent(oldName)}`, body); }
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    toast("已保存", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function deleteImageProvider(name) {
  const ok = await confirm("删除生图服务商", `确认删除 "${name}"？`, true);
  if (!ok) return;
  showLoading("删除中…");
  try { await api.del(`/api/image-providers/${encodeURIComponent(name)}`); toast("已删除", "success"); goBack(); refreshSidebar(); }
  catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

/* ============ Image Test Page ============ */

const _imageTestState = { provider: "", model: "", prompt: "", providers: [], personaId: "", personas: [] };
const _IMAGE_TEST_DEFAULT_PROMPT = "生成一张坐在窗边的可爱小猫的图片";

export async function openImageTest() {
  try {
    const res = await api.get("/api/image-providers");
    const usable = (res.providers || []).filter(p => (p.models || []).length > 0);
    if (usable.length === 0) {
      toast("请先添加生图服务商", "error");
      return;
    }
  } catch (e) { toast("加载失败", "error"); return; }
  pushPage("imageTest");
}

async function renderImageTest() {
  setTopBar("生图测试", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const [res, persRes] = await Promise.all([
      api.get("/api/image-providers"),
      api.get("/api/personas").catch(() => ({ personas: [] })),
    ]);
    _imageTestState.providers = (res.providers || []).filter(p => (p.models || []).length > 0);
    _imageTestState.personas = persRes.personas || [];
    _imageProviderPresets = res.presets || _imageProviderPresets;
    _imagePresetModels = res.preset_models || _imagePresetModels;
    _imageModelTypeOptions = res.model_type_options || _imageModelTypeOptions;
  } catch (e) {
    toast("加载失败", "error");
    return;
  }
  if (_imageTestState.providers.length === 0) {
    content().innerHTML = `<div class="empty-state">
      <div class="empty-text">没有可用的生图服务商或模型</div>
      <button onclick="PawzoChat.openImageProviderTypeSheet()">去添加</button>
    </div>`;
    return;
  }
  if (!_imageTestState.providers.find(p => p.name === _imageTestState.provider)) {
    _imageTestState.provider = _imageTestState.providers[0].name;
    _imageTestState.model = "";
  }
  const currentProvider = _imageTestState.providers.find(p => p.name === _imageTestState.provider);
  const models = currentProvider?.models || [];
  if (!models.find(m => m.id === _imageTestState.model)) {
    _imageTestState.model = models[0]?.id || "";
  }
  if (!_imageTestState.prompt) _imageTestState.prompt = _IMAGE_TEST_DEFAULT_PROMPT;

  const providerOpts = _imageTestState.providers.map(p =>
    `<option value="${esc(p.name)}" ${p.name === _imageTestState.provider ? "selected" : ""}>${esc(p.name)}</option>`
  ).join("");
  const modelOpts = models.map(m =>
    `<option value="${esc(m.id)}" ${m.id === _imageTestState.model ? "selected" : ""}>${esc(m.name || m.id)}</option>`
  ).join("");
  const personaOpts = `<option value="">不使用角色（无参考图）</option>` + _imageTestState.personas.map(pp => {
    const mode = pp.image_generation?.ref_mode || "avatar";
    const tag = mode === "none" ? "无参考图" : (mode === "custom" ? "自定义参考图" : "头像作参考");
    return `<option value="${esc(pp.id)}" ${pp.id === _imageTestState.personaId ? "selected" : ""}>${esc(pp.name)}（${tag}）</option>`;
  }).join("");

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="form-group"><div class="form-row"><label>服务商</label>
        <select id="it-provider" onchange="PawzoChat.onImageTestProviderChange()">${providerOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>模型</label>
        <select id="it-model" onchange="PawzoChat.onImageTestModelChange()">${modelOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>使用角色</label>
        <select id="it-persona" onchange="PawzoChat.onImageTestPersonaChange()">${personaOpts}</select>
      </div></div>
      <div class="form-hint">选择角色后，按该角色的"生图设置"自动注入参考图</div>
      <div class="prompt-field">
        <label class="prompt-label" for="it-prompt">提示词</label>
        <textarea class="prompt-input" id="it-prompt" rows="3" oninput="PawzoChat.onImageTestPromptInput()">${esc(_imageTestState.prompt)}</textarea>
      </div>
    </div>
    <div class="persona-actions mt-16">
      <button class="btn-primary" onclick="PawzoChat.runImageTest()">开始生成</button>
    </div>
    <div id="it-result" style="margin:16px"></div>
  </div>`;
}

export function onImageTestProviderChange() {
  _imageTestState.provider = $("it-provider")?.value || "";
  const currentProvider = _imageTestState.providers.find(p => p.name === _imageTestState.provider);
  const models = currentProvider?.models || [];
  _imageTestState.model = models[0]?.id || "";
  const sel = $("it-model");
  if (sel) {
    sel.innerHTML = models.map(m =>
      `<option value="${esc(m.id)}" ${m.id === _imageTestState.model ? "selected" : ""}>${esc(m.name || m.id)}</option>`
    ).join("");
  }
}

export function onImageTestModelChange() {
  _imageTestState.model = $("it-model")?.value || "";
}

export function onImageTestPromptInput() {
  _imageTestState.prompt = $("it-prompt")?.value || "";
}

export function onImageTestPersonaChange() {
  _imageTestState.personaId = $("it-persona")?.value || "";
}

export async function runImageTest() {
  const provider = $("it-provider")?.value || "";
  const model = $("it-model")?.value || "";
  const prompt = ($("it-prompt")?.value || "").trim();
  const personaId = $("it-persona")?.value || "";
  if (!provider) { toast("请选择服务商", "error"); return; }
  if (!model) { toast("请选择模型", "error"); return; }
  if (!prompt) { toast("请输入提示词", "error"); return; }

  const resultEl = $("it-result");
  if (resultEl) {
    resultEl.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px"><div class="spinner"></div><div style="color:var(--text-3);font-size:13px">生成中（最长 3 分钟）…</div></div>`;
  }

  const body = { model, prompt };
  if (personaId) body.persona_id = personaId;
  try {
    const res = await api.post(
      `/api/image-providers/${encodeURIComponent(provider)}/_test`,
      body,
    );
    if (res.status >= 400) {
      if (resultEl) {
        resultEl.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:12px;border:1px solid var(--danger);border-radius:8px;word-break:break-all">${esc(res.data?.error || "调用失败")}</div>`;
      }
      return;
    }
    const { image_b64, mime_type } = res.data;
    if (resultEl) {
      const img = document.createElement("img");
      img.src = `data:${mime_type || "image/png"};base64,${image_b64 || ""}`;
      img.style.maxWidth = "100%";
      img.style.borderRadius = "8px";
      img.style.display = "block";
      resultEl.replaceChildren(img);
    }
  } catch (e) {
    if (resultEl) {
      resultEl.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:12px;border:1px solid var(--danger);border-radius:8px;word-break:break-all">网络错误</div>`;
    }
  }
}

/* ============ Voice (TTS) Providers ============ */

let _voiceProviderPresets = {};
let _voicePresetModels = {};
let _voiceModelTypeOptions = [];
let _editVoiceModels = [];
let _editVoiceProvider = null;
let _voicePresetVoices = {};

function _voicePresetLabel(id) {
  return _voiceProviderPresets[id]?.name || (id === "custom" ? "自定义" : id);
}

const _VOICE_TYPE_SHORT_LABEL = {
  elevenlabs_tts: "ElevenLabs 原生",
  minimaxi_tts: "MiniMax 原生",
  mimo_tts: "MiMo 原生",
  openai_tts: "OpenAI 兼容",
};
function _voiceTypeLabel(type) {
  return _VOICE_TYPE_SHORT_LABEL[type] || type || "—";
}

function _voiceDefaultTypeForPreset(preset) {
  if (preset && preset !== "custom") {
    return _voiceProviderPresets[preset]?.default_model_type || "openai_tts";
  }
  return "openai_tts";
}

function _voicePreviewUrl(preset, baseUrl) {
  if (preset && preset !== "custom") {
    const info = _voiceProviderPresets[preset];
    if (!info) return "";
    return info.base_url + info.endpoint_path;
  }
  if (!baseUrl) return "";
  return baseUrl.replace(/\/+$/, "");
}

function _voiceModelTypeOptionsHTML(selected) {
  return _voiceModelTypeOptions.map(o =>
    `<option value="${esc(o.value)}" ${o.value === selected ? "selected" : ""}>${esc(o.label)}</option>`
  ).join("");
}

async function renderSettingsVoiceProviders() {
  setTopBar("语音服务商", true,
    `<button class="top-btn" onclick="PawzoChat.openVoiceProviderTypeSheet()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/voice-providers");
    const providers = res.providers || [];
    _voiceProviderPresets = res.presets || {};
    _voicePresetModels = res.preset_models || {};
    _voiceModelTypeOptions = res.model_type_options || [];
    _voicePresetVoices = res.preset_voices || {};
    if (providers.length === 0) {
      content().innerHTML = `<div class="empty-state">
        <div class="empty-text">没有已配置的语音服务商</div>
        <button onclick="PawzoChat.openVoiceProviderTypeSheet()">添加语音服务商</button>
      </div>`;
      return;
    }
    const testEntryCard = `<div class="card">
      <div class="card-row" onclick="PawzoChat.openVoiceTest()">
        <span class="row-icon primary">${iconHtml("ri-mic-line")}</span>
        <div class="provider-summary">
          <div class="row-label">语音测试</div>
          <div class="form-label-secondary">选择服务商和模型试听语音</div>
        </div>
        <span class="row-arrow">›</span>
      </div>
    </div>`;
    const html = providers.map(p => {
      const modelCount = (p.models || []).length;
      return `<div class="card">
        <div class="card-row" onclick="PawzoChat.pushPage('voiceProviderEdit',{name:'${esc(p.name)}'})">
          <div class="provider-summary">
            <div class="row-label">${esc(p.name)}</div>
            <div class="form-label-secondary">${esc(_voicePresetLabel(p.preset))} · ${modelCount} 个模型</div>
          </div>
          <span class="row-arrow">›</span>
        </div>
      </div>`;
    }).join("");
    content().innerHTML = `<div class="page">${testEntryCard}${html}</div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export function openVoiceProviderTypeSheet() {
  const ids = Object.keys(_voiceProviderPresets);
  const items = ids.map(id =>
    `<div class="sheet-item" onclick="PawzoChat.closeOverlay();PawzoChat.pushPage('voiceProviderEdit',{isNew:true,preset:'${esc(id)}'})">${esc(_voicePresetLabel(id))}</div>`
  ).join("");
  const customItem = `<div class="sheet-item" onclick="PawzoChat.closeOverlay();PawzoChat.pushPage('voiceProviderEdit',{isNew:true,preset:'custom'})">自定义</div>`;
  showSheet(`<div class="sheet-title">选择语音服务商类型</div>${items}${customItem}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
}

async function renderVoiceProviderEdit(data) {
  const isNew = data.isNew;
  setTopBar(isNew ? "新建语音服务商" : "编辑语音服务商", true,
    `<button class="btn-text" onclick="PawzoChat.saveVoiceProvider(${isNew},'${esc(data.name || "")}')">保存</button>`
  );

  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  let p = { name: "", preset: "", type: "openai_tts", base_url: "", api_key_set: false, models: [] };

  try {
    const res = await api.get("/api/voice-providers");
    _voiceProviderPresets = res.presets || {};
    _voicePresetModels = res.preset_models || {};
    _voiceModelTypeOptions = res.model_type_options || [];
    _voicePresetVoices = res.preset_voices || {};
    if (!isNew && data.name) {
      p = (res.providers || []).find(pr => pr.name === data.name) || p;
    }
  } catch (e) { /* silent */ }

  if (isNew && data.preset) p.preset = data.preset;

  _editVoiceProvider = isNew ? null : p;
  _editVoiceModels = JSON.parse(JSON.stringify(p.models || []));

  const presetOpts = Object.keys(_voiceProviderPresets)
    .map(id => `<option value="${id}" ${p.preset === id ? "selected" : ""}>${esc(_voicePresetLabel(id))}</option>`)
    .join("")
    + `<option value="custom" ${(!p.preset || p.preset === "custom") ? "selected" : ""}>自定义</option>`;

  const isCustom = !p.preset || p.preset === "custom";

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="form-group"><div class="form-row"><label>服务商</label><select id="vpv-preset" onchange="PawzoChat.onVoiceProviderPresetChange()">${presetOpts}</select></div></div>
      <div class="form-group"><div class="form-row"><label>名称</label><input id="vpv-name" value="${esc(isNew && !isCustom && p.preset ? (_voiceProviderPresets[p.preset]?.default_name || _voiceProviderPresets[p.preset]?.name || "") : p.name)}" placeholder="语音服务商名称"></div></div>
      <div id="vpv-custom-fields" ${isCustom ? "" : "hidden"}>
        <div class="form-group"><div class="form-row"><label>Base URL</label><input id="vpv-url" value="${esc(p.base_url)}" placeholder="https://api.example.com/v1" oninput="PawzoChat.updateVoiceProviderPreview()"></div><div class="form-hint">同一服务商的不同模型可走不同接口，请在每个模型上单独设置「调用方式」。</div></div>
      </div>
      <div class="form-group"><div class="form-row"><label>API Key</label><input type="password" id="vpv-key" placeholder="${p.api_key_set ? '已设置 (留空不修改)' : '输入 API Key'}"></div></div>
    </div>
    <div class="card">
      <div class="card-header">请求地址预览</div>
      <div id="vpv-preview" class="form-hint provider-url-preview"></div>
    </div>
    <div class="card">
      <div class="card-header-row provider-model-header">
        <span class="card-header">模型列表</span>
        <div class="form-actions">
          <button id="vpv-import-preset-btn" class="btn-outline btn-sm" onclick="PawzoChat.importVoicePresetModels()" ${isCustom ? 'hidden' : ''}>导入预设</button>
          <button class="btn-outline btn-sm" onclick="PawzoChat.addEditVoiceModel()">添加</button>
        </div>
      </div>
      <div id="vpv-models-list"></div>
    </div>
    ${!isNew ? `<div class="persona-actions mt-16">
      <button class="btn-text danger" onclick="PawzoChat.deleteVoiceProvider('${esc(data.name)}')">删除该语音服务商</button>
    </div>` : ""}
  </div>`;

  updateVoiceProviderPreview();
  _renderVoiceModelsList();

  if (isNew && data.preset && data.preset !== "custom") {
    importVoicePresetModels();
  }
}

function _renderVoiceModelsList() {
  const el = $("vpv-models-list");
  if (!el) return;
  if (_editVoiceModels.length === 0) {
    el.innerHTML = `<div class="card-empty-hint">暂无模型，点击"导入预设"或"添加"</div>`;
    return;
  }
  el.innerHTML = _editVoiceModels.map((m, i) => {
    return `<div class="form-group model-row"><div class="form-row">
      <div class="provider-summary">
        <div>${esc(m.name || m.id)}</div>
        <div class="form-label-secondary">${esc(m.id)}</div>
        <span class="cap-tag">${esc(_voiceTypeLabel(m.type))}</span>
        ${m.voice ? `<div class="form-label-secondary">默认音色：${esc(m.voice)}</div>` : ""}
      </div>
      <div class="form-actions">
        <button class="btn-icon-sm" onclick="PawzoChat.editVoiceModel(${i})" title="编辑">${iconHtml("ri-edit-line")}</button>
        <button class="btn-icon-sm" onclick="PawzoChat.removeEditVoiceModel(${i})" title="删除">&times;</button>
      </div>
    </div></div>`;
  }).join("");
}

export function onVoiceProviderPresetChange() {
  const preset = $("vpv-preset").value;
  const isCustom = preset === "custom";
  const fields = $("vpv-custom-fields");
  if (fields) fields.hidden = !isCustom;
  const importBtn = $("vpv-import-preset-btn");
  if (importBtn) importBtn.hidden = isCustom;

  if (!isCustom) {
    const info = _voiceProviderPresets[preset];
    if (info) {
      const nameEl = $("vpv-name");
      if (nameEl) {
        const cur = nameEl.value.trim();
        const isAutoName = !cur || Object.values(_voiceProviderPresets).some(p => p.name === cur || p.default_name === cur);
        if (isAutoName) nameEl.value = info.default_name || info.name;
      }
    }
  }
  updateVoiceProviderPreview();
}

export function updateVoiceProviderPreview() {
  const preset = $("vpv-preset")?.value || "custom";
  const baseUrl = $("vpv-url")?.value.trim() || "";
  const url = _voicePreviewUrl(preset, baseUrl);
  const el = $("vpv-preview");
  if (el) el.textContent = url || "—";
}

export function importVoicePresetModels() {
  const preset = $("vpv-preset")?.value || "custom";
  const presets = _voicePresetModels[preset];
  if (!presets || presets.length === 0) {
    toast("该语音服务商无预设模型列表", "error");
    return;
  }
  const existingIds = new Set(_editVoiceModels.map(m => m.id));
  const fallbackType = _voiceDefaultTypeForPreset(preset);
  let added = 0;
  for (const pm of presets) {
    if (!existingIds.has(pm.id)) {
      _editVoiceModels.push({
        id: pm.id,
        name: pm.name || pm.id,
        type: pm.type || fallbackType,
      });
      added++;
    }
  }
  _renderVoiceModelsList();
  toast(added > 0 ? `已导入 ${added} 个模型` : "预设模型已存在", added > 0 ? "success" : "info");
}

export function addEditVoiceModel() {
  const preset = $("vpv-preset")?.value || "custom";
  const defaultType = _voiceDefaultTypeForPreset(preset);
  showSheet(`<div class="sheet-body form-stack voice-model-sheet">
    <div class="sheet-title">添加模型</div>
    <div class="form-stack">
      <input class="form-input" id="add-voice-model-id" placeholder="模型 ID (必填，如 tts-1)">
      <input class="form-input" id="add-voice-model-name" placeholder="显示名称 (可选)">
      <div>
        <label class="prompt-label" for="add-voice-model-type">调用方式</label>
        <select class="form-input" id="add-voice-model-type" onchange="PawzoChat.refreshModelVoicePicker('add')">${_voiceModelTypeOptionsHTML(defaultType)}</select>
      </div>
      <div>
        <label class="prompt-label" for="add-voice-model-voice">默认音色 (voice ID, 可选)</label>
        <input class="form-input" id="add-voice-model-voice" placeholder="留空则在调用时手动指定" spellcheck="false" autocomplete="off">
        <div id="add-account-voices" hidden></div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.confirmAddVoiceModel()">添加</button>
    </div>
  </div>`);
  refreshModelVoicePicker("add");
}

export function refreshModelVoicePicker(prefix) {
  const saved = _editVoiceProvider;
  const preset = $("vpv-preset")?.value;
  const unchanged = saved && saved.api_key_set && !$("vpv-key")?.value
    && (saved.preset === "elevenlabs" || saved.models?.some(m => m.type === "elevenlabs_tts"))
    && preset === saved.preset && $("vpv-name")?.value.trim() === saved.name
    && (preset !== "custom" || $("vpv-url")?.value.trim() === saved.base_url);
  mountAccountVoicePicker($(`${prefix}-account-voices`), {
    provider: saved?.name, saved: !!unchanged,
    enabled: $(`${prefix}-voice-model-type`)?.value === "elevenlabs_tts",
    input: $(`${prefix}-voice-model-voice`),
  });
}

export function confirmAddVoiceModel() {
  const id = $("add-voice-model-id")?.value.trim();
  if (!id) { toast("模型 ID 不能为空", "error"); return; }
  if (_editVoiceModels.some(m => m.id === id)) { toast("模型已存在", "error"); return; }
  const entry = {
    id,
    name: $("add-voice-model-name")?.value.trim() || id,
    type: $("add-voice-model-type")?.value || _voiceDefaultTypeForPreset($("vpv-preset")?.value || "custom"),
  };
  const voice = $("add-voice-model-voice")?.value.trim();
  if (voice) entry.voice = voice;
  _editVoiceModels.push(entry);
  closeOverlay();
  _renderVoiceModelsList();
}

export function removeEditVoiceModel(idx) {
  _editVoiceModels.splice(idx, 1);
  _renderVoiceModelsList();
}

export function editVoiceModel(idx) {
  const m = _editVoiceModels[idx];
  if (!m) return;
  const preset = $("vpv-preset")?.value || "custom";
  const currentType = m.type || _voiceDefaultTypeForPreset(preset);
  showSheet(`<div class="sheet-body form-stack voice-model-sheet">
    <div class="sheet-title">编辑模型</div>
    <div class="form-stack">
      <input class="form-input" id="edit-voice-model-id" value="${esc(m.id)}" placeholder="模型 ID (必填)">
      <input class="form-input" id="edit-voice-model-name" value="${esc(m.name || '')}" placeholder="显示名称 (可选)">
      <div>
        <label class="prompt-label" for="edit-voice-model-type">调用方式</label>
        <select class="form-input" id="edit-voice-model-type" onchange="PawzoChat.refreshModelVoicePicker('edit')">${_voiceModelTypeOptionsHTML(currentType)}</select>
      </div>
      <div>
        <label class="prompt-label" for="edit-voice-model-voice">默认音色 (voice ID, 可选)</label>
        <input class="form-input" id="edit-voice-model-voice" value="${esc(m.voice || '')}" placeholder="留空则在调用时手动指定" spellcheck="false" autocomplete="off">
        <div id="edit-account-voices" hidden></div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.confirmEditVoiceModel(${idx})">保存</button>
    </div>
  </div>`);
  refreshModelVoicePicker("edit");
}

export function confirmEditVoiceModel(idx) {
  const id = $("edit-voice-model-id")?.value.trim();
  if (!id) { toast("模型 ID 不能为空", "error"); return; }
  if (_editVoiceModels.some((m, i) => i !== idx && m.id === id)) { toast("模型 ID 已存在", "error"); return; }
  const entry = {
    id,
    name: $("edit-voice-model-name")?.value.trim() || id,
    type: $("edit-voice-model-type")?.value || _voiceDefaultTypeForPreset($("vpv-preset")?.value || "custom"),
  };
  const voice = $("edit-voice-model-voice")?.value.trim();
  if (voice) entry.voice = voice;
  _editVoiceModels[idx] = entry;
  closeOverlay();
  _renderVoiceModelsList();
}

export async function saveVoiceProvider(isNew, oldName) {
  const preset = $("vpv-preset").value;
  const body = {
    name: $("vpv-name").value.trim(),
    preset,
    api_key: $("vpv-key").value,
    models: _editVoiceModels,
  };
  if (preset === "custom") {
    body.base_url = $("vpv-url").value.trim();
  }

  const nameErr = validateProviderName(body.name);
  if (nameErr) { toast(nameErr, "error"); return; }
  if (preset === "custom" && !body.base_url) { toast("请输入 Base URL", "error"); return; }

  showLoading("保存中…");
  try {
    let res;
    if (isNew) { res = await api.post("/api/voice-providers", body); }
    else { res = await api.put(`/api/voice-providers/${encodeURIComponent(oldName)}`, body); }
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    toast("已保存", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function deleteVoiceProvider(name) {
  const ok = await confirm("删除语音服务商", `确认删除 "${name}"？`, true);
  if (!ok) return;
  showLoading("删除中…");
  try { await api.del(`/api/voice-providers/${encodeURIComponent(name)}`); toast("已删除", "success"); goBack(); refreshSidebar(); }
  catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

/* ============ Voice Test Page ============ */

const _voiceTestState = { provider: "", model: "", voice: "", voices: new Map(), text: "", providers: [], settings: {}, controls: {}, emotion: "", revision: 0 };
const _VOICE_TEST_DEFAULT_TEXT = "你好，这是一个语音合成测试。欢迎使用 PawzoChat 的语音服务。";

export async function openVoiceTest() {
  try {
    const res = await api.get("/api/voice-providers");
    const usable = (res.providers || []).filter(p => (p.models || []).length > 0);
    if (usable.length === 0) {
      toast("请先添加语音服务商", "error");
      return;
    }
  } catch (e) { toast("加载失败", "error"); return; }
  pushPage("voiceTest");
}

async function renderVoiceTest() {
  _voiceTestState.revision++;
  setTopBar("语音测试", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  const loading = content().firstElementChild;
  try {
    const res = await api.get("/api/voice-providers");
    if (content().firstElementChild !== loading) return;
    _voiceTestState.providers = (res.providers || []).filter(p => (p.models || []).length > 0);
    const defaults = res.voice_defaults || {};
    _voiceTestState.settings = { ...defaults, ..._voiceTestState.settings,
      minimax: { ...defaults.minimax, ..._voiceTestState.settings.minimax },
      mimo: { ...defaults.mimo, ..._voiceTestState.settings.mimo },
      elevenlabs: { ...defaults.elevenlabs, ..._voiceTestState.settings.elevenlabs } };
    _voiceProviderPresets = res.presets || _voiceProviderPresets;
    _voicePresetModels = res.preset_models || _voicePresetModels;
    _voiceModelTypeOptions = res.model_type_options || _voiceModelTypeOptions;
    _voicePresetVoices = res.preset_voices || {};
  } catch (e) {
    toast("加载失败", "error");
    return;
  }
  if (_voiceTestState.providers.length === 0) {
    content().innerHTML = `<div class="empty-state">
      <div class="empty-text">没有可用的语音服务商或模型</div>
      <button onclick="PawzoChat.openVoiceProviderTypeSheet()">去添加</button>
    </div>`;
    return;
  }
  if (!_voiceTestState.providers.find(p => p.name === _voiceTestState.provider)) {
    _voiceTestState.provider = _voiceTestState.providers[0].name;
    _voiceTestState.model = "";
    _voiceTestState.voice = _voiceTestState.voices.get(_voiceTestState.provider) || "";
  }
  const currentProvider = _voiceTestState.providers.find(p => p.name === _voiceTestState.provider);
  const models = currentProvider?.models || [];
  if (!models.find(m => m.id === _voiceTestState.model)) {
    _voiceTestState.model = models[0]?.id || "";
  }
  if (!_voiceTestState.text) _voiceTestState.text = _VOICE_TEST_DEFAULT_TEXT;

  const providerOpts = _voiceTestState.providers.map(p =>
    `<option value="${esc(p.name)}" ${p.name === _voiceTestState.provider ? "selected" : ""}>${esc(p.name)}</option>`
  ).join("");
  const modelOpts = models.map(m =>
    `<option value="${esc(m.id)}" ${m.id === _voiceTestState.model ? "selected" : ""}>${esc(m.name || m.id)}</option>`
  ).join("");

  // Build voice preset list from the current model's vendor catalog (not its
  // transport type — PawAPI speaks openai_tts but serves MiniMax voices).
  const currentModel = models.find(m => m.id === _voiceTestState.model);
  const currentVoice = _voiceTestState.voice;
  const voiceOpts = voiceOptionsHtml(voiceCatalogFor(_voicePresetVoices, currentModel, models));

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="form-group"><div class="form-row"><label>服务商</label>
        <select id="vt-provider" onchange="PawzoChat.onVoiceTestProviderChange()">${providerOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>模型</label>
        <select id="vt-model" onchange="PawzoChat.onVoiceTestModelChange()">${modelOpts}</select>
      </div></div>
      <div class="prompt-field voice-field"><label class="prompt-label" for="vt-voice">音色 (voice ID)</label>
        <input class="form-input" id="vt-voice" list="vt-voice-list" oninput="PawzoChat.onVoiceTestVoiceChange()" value="${esc(currentVoice)}" placeholder="留空则使用模型默认音色" spellcheck="false" autocomplete="off">
        <datalist id="vt-voice-list">${voiceOpts}</datalist>
        <div id="vt-account-voices" hidden></div>
      </div>
      <div class="form-hint">以下参数仅用于试听。</div>
      <div id="vt-controls"></div>
      <div id="vt-emotion-control"></div>
      <div class="prompt-field"><label class="prompt-label" for="vt-text">合成文本</label>
        <textarea class="prompt-input" id="vt-text" rows="3" oninput="PawzoChat.onVoiceTestTextInput()">${esc(_voiceTestState.text)}</textarea>
      </div>
    </div>
    <div class="persona-actions mt-16">
      <button id="vt-generate" class="btn-primary" onclick="PawzoChat.runVoiceTest()">生成语音</button>
    </div>
    <div id="vt-result" class="voice-test-result mt-16" aria-live="polite"></div>
  </div>`;
  _refreshVoiceDropdown();
  _renderVoiceTestControls();
}

export function onVoiceTestProviderChange() {
  _captureVoiceTestControls();
  _voiceTestState.voices.set(_voiceTestState.provider, $("vt-voice")?.value || "");
  _voiceTestState.provider = $("vt-provider")?.value || "";
  _voiceTestState.voice = _voiceTestState.voices.get(_voiceTestState.provider) || "";
  if ($("vt-voice")) $("vt-voice").value = _voiceTestState.voice;
  const currentProvider = _voiceTestState.providers.find(p => p.name === _voiceTestState.provider);
  const models = currentProvider?.models || [];
  _voiceTestState.model = models[0]?.id || "";
  const sel = $("vt-model");
  if (sel) {
    sel.innerHTML = models.map(m =>
      `<option value="${esc(m.id)}" ${m.id === _voiceTestState.model ? "selected" : ""}>${esc(m.name || m.id)}</option>`
    ).join("");
  }
  _refreshVoiceDropdown();
  _renderVoiceTestControls();
}

export function onVoiceTestModelChange() {
  _captureVoiceTestControls();
  _voiceTestState.model = $("vt-model")?.value || "";
  _refreshVoiceDropdown();
  _renderVoiceTestControls();
}

export function onVoiceTestVoiceChange() {
  _voiceTestState.voice = $("vt-voice")?.value || "";
}

export function onVoiceTestTextInput() {
  _voiceTestState.text = $("vt-text")?.value || "";
}

function _refreshVoiceDropdown() {
  const modelId = _voiceTestState.model;
  const currentProvider = _voiceTestState.providers.find(p => p.name === _voiceTestState.provider);
  const currentModel = currentProvider?.models?.find(m => m.id === modelId);
  const voices = voiceCatalogFor(_voicePresetVoices, currentModel, currentProvider?.models);

  const voiceList = $("vt-voice-list");
  if (voiceList) {
    voiceList.innerHTML = voiceOptionsHtml(voices);
  }
  const voiceInput = $("vt-voice");
  if (voiceInput) voiceInput.placeholder = currentModel?.voice ? `留空则使用 ${currentModel.voice}` : "留空则使用模型默认音色";
}

function _captureVoiceTestControls() {
  _voiceTestState.settings = readVoiceControls(_voiceTestState.settings, _voiceTestState.controls.family, "vt");
  if ($("vt-emotion")) _voiceTestState.emotion = $("vt-emotion").value;
}

function _renderVoiceTestControls() {
  _voiceTestState.revision++;
  const provider = _voiceTestState.providers.find(p => p.name === _voiceTestState.provider);
  const model = provider?.models?.find(m => m.id === _voiceTestState.model);
  const controls = model?.tts_controls || { family: "openai" };
  _voiceTestState.controls = controls;
  mountAccountVoicePicker($("vt-account-voices"), {
    provider: provider?.name, enabled: controls.family === "elevenlabs", saved: provider?.api_key_set !== false,
    input: $("vt-voice"),
  });
  const host = $("vt-controls");
  host.innerHTML = voiceControlHtml(_voiceTestState.settings, controls, "vt");
  $("vt-emotion-control").innerHTML = voiceTestEmotionHtml(controls, _voiceTestState.emotion, _voiceTestState.settings.emotion_enabled);
  bindVoiceControls(host, "vt", enabled => {
    if ($("vt-emotion-fields")) $("vt-emotion-fields").hidden = !enabled;
  });
  host.addEventListener("input", _captureVoiceTestControls);
  host.onchange = _captureVoiceTestControls;
  if ($("vt-emotion")) $("vt-emotion").onchange = _captureVoiceTestControls;
  $("vt-result").replaceChildren();
  $("vt-generate").disabled = !model;
}

export async function runVoiceTest() {
  const provider = $("vt-provider")?.value || "";
  const model = $("vt-model")?.value || "";
  const text = ($("vt-text")?.value || "").trim();
  const voice = $("vt-voice")?.value || "";
  if (!provider) { toast("请选择服务商", "error"); return; }
  if (!model) { toast("请选择模型", "error"); return; }
  if (!text) { toast("请输入合成文本", "error"); return; }

  _captureVoiceTestControls();
  const revision = ++_voiceTestState.revision;
  const resultEl = $("vt-result"), button = $("vt-generate");
  button.disabled = true;
  const isCurrent = () => revision === _voiceTestState.revision && $("vt-result") === resultEl;
  if (resultEl) {
    resultEl.innerHTML = `<div class="form-stack voice-test-loading"><div class="spinner"></div><div class="form-label-secondary">合成中…</div></div>`;
  }

  const settings = { ..._voiceTestState.settings, provider, model, voice: voice.trim() };
  const body = { text, voice_generation: settings,
    emotion: settings.emotion_enabled && _voiceTestState.controls.emotions ? _voiceTestState.emotion : "" };
  try {
    const res = await api.post(
      `/api/voice-providers/${encodeURIComponent(provider)}/_test`,
      body,
    );
    if (!isCurrent()) return;
    if (res.status >= 400) {
      if (resultEl) {
        resultEl.innerHTML = `<div class="voice-test-error" role="alert">${esc(res.data?.error || "调用失败")}</div>`;
      }
      return;
    }
    const { audio_b64, mime_type } = res.data;
    if (resultEl) {
      const audio = document.createElement("audio");
      audio.src = `data:${mime_type || "audio/mpeg"};base64,${audio_b64 || ""}`;
      audio.controls = true;
      resultEl.replaceChildren(audio);
    }
  } catch (e) {
    if (isCurrent() && resultEl) {
      resultEl.innerHTML = `<div class="voice-test-error" role="alert">网络错误</div>`;
    }
  } finally {
    if (isCurrent()) button.disabled = false;
  }
}

function renderSettingsChat() {
  setTopBar("对话设置", true,
    `<button class="btn-text" onclick="PawzoChat.saveSettingsChat()">保存</button>`
  );
  const s = state.settings?.chat || {};
  const maxRounds = s.max_context_rounds || 20;
  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="card-header">上下文</div>
      <div class="form-group"><div class="form-row"><label>最大上下文轮次</label>
        <div class="stepper"><button onclick="PawzoChat.step('sc-ctx',-1)">−</button><span class="stepper-val" id="sc-ctx">${maxRounds}</span><button onclick="PawzoChat.step('sc-ctx',1)">+</button></div>
      </div></div>
      <div class="form-hint">LLM 每次请求携带的历史对话轮次数</div>
    </div>
    <div class="card">
      <div class="card-header">消息队列</div>
      <div class="form-group"><div class="form-row"><label>队列等待时间（秒）</label>
        <div class="stepper"><button onclick="PawzoChat.step('sc-wait',-1)">−</button><span class="stepper-val" id="sc-wait">${s.queue_wait_seconds || 7}</span><button onclick="PawzoChat.step('sc-wait',1)">+</button></div>
      </div></div>
      <div class="form-hint">收到消息后等待合并的时间</div>
    </div>
  </div>`;
}

export async function saveSettingsChat() {
  const rounds = parseInt($("sc-ctx").textContent);
  const wait = parseInt($("sc-wait").textContent);
  const patch = { max_context_rounds: rounds, queue_wait_seconds: wait };
  showLoading("保存中…");
  try {
    await api.patch("/api/settings", { chat: patch });
    state.settings = state.settings || {};
    state.settings.chat = { ...(state.settings.chat || {}), ...patch };
    toast("已保存", "success");
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

/* ============ Reply Settings ============ */

function renderSettingsReply() {
  setTopBar("回复设置", true,
    `<button class="btn-text" onclick="PawzoChat.saveSettingsReply()">保存</button>`
  );
  const s = state.settings?.reply || {};
  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="card-header">回复拆分</div>
      <div class="form-group"><div class="form-row"><label>按换行拆分</label>
        <label class="switch-wrap"><input type="checkbox" id="sr-split" ${s.split_by_newline ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-hint">将 AI 回复按换行符拆分为多条消息存储和发送</div>
    </div>
    <div class="card">
      <div class="card-header">打字模拟</div>
      <div class="form-group"><div class="form-row"><label>消息间延迟</label>
        <label class="switch-wrap"><input type="checkbox" id="sr-delay" ${s.typing_delay_enabled !== false ? "checked" : ""} onchange="PawzoChat.onTypingDelayToggle()"><span class="switch-track"></span></label>
      </div></div>
      <div class="form-hint">开启后，相邻消息之间按打字速度模拟延迟</div>
      <div id="sr-delay-fields" style="${s.typing_delay_enabled === false ? "opacity:0.45;pointer-events:none" : ""}">
      <div class="form-group"><div class="form-row"><label>打字速度</label>
        <div class="slider-wrap"><input type="range" id="sr-speed" min="0.05" max="1" step="0.05" value="${s.typing_speed || 0.2}" oninput="this.nextElementSibling.textContent=this.value"><span class="slider-val">${s.typing_speed || 0.2}</span></div>
      </div></div>
      <div class="form-group"><div class="form-row"><label>随机下限</label>
        <div class="slider-wrap"><input type="range" id="sr-rmin" min="0.01" max="0.5" step="0.01" value="${s.typing_speed_random_min || 0.05}" oninput="this.nextElementSibling.textContent=this.value"><span class="slider-val">${s.typing_speed_random_min || 0.05}</span></div>
      </div></div>
      <div class="form-group"><div class="form-row"><label>随机上限</label>
        <div class="slider-wrap"><input type="range" id="sr-rmax" min="0.01" max="0.5" step="0.01" value="${s.typing_speed_random_max || 0.1}" oninput="this.nextElementSibling.textContent=this.value"><span class="slider-val">${s.typing_speed_random_max || 0.1}</span></div>
      </div></div>
      <div class="form-hint">相邻消息之间延迟时间 = 字数 × (打字速度 + 随机值)，结果限制在 0.5~8 秒</div>
      </div>
      <div class="form-group"><div class="form-row"><label>输入指示器</label>
        <label class="switch-wrap"><input type="checkbox" id="sr-typing" ${s.show_typing_indicator ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-hint">模型思考和回复时显示"对方正在输入"</div>
    </div>
  </div>`;
}

export function onTypingDelayToggle() {
  const enabled = !!$("sr-delay")?.checked;
  const fields = $("sr-delay-fields");
  if (fields) {
    fields.style.opacity = enabled ? "" : "0.45";
    fields.style.pointerEvents = enabled ? "" : "none";
  }
}

export async function saveSettingsReply() {
  const patch = {
    typing_delay_enabled: $("sr-delay").checked,
    typing_speed: parseFloat($("sr-speed").value),
    typing_speed_random_min: parseFloat($("sr-rmin").value),
    typing_speed_random_max: parseFloat($("sr-rmax").value),
    split_by_newline: $("sr-split").checked,
    show_typing_indicator: $("sr-typing").checked,
  };
  showLoading("保存中…");
  try {
    await api.patch("/api/settings", { reply: patch });
    state.settings = state.settings || {};
    state.settings.reply = { ...(state.settings.reply || {}), ...patch };
    toast("已保存", "success");
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

/* ============ Emoji Management ============ */

const _FS_ILLEGAL_RE = /[\\/:*?"<>|]/;
function _validateFsName(name) {
  if (!name) return "名称不能为空";
  if (name.length > 50) return "名称过长（最多 50 个字符）";
  if (_FS_ILLEGAL_RE.test(name)) return "名称包含非法字符，不可使用 \\ / : * ? \" < > |";
  if (/^[. ]|[. ]$/.test(name)) return "名称不能以空格或句点开头/结尾";
  const upper = name.toUpperCase();
  const reserved = [".", "..", "CON", "PRN", "AUX", "NUL"];
  for (let i = 1; i <= 9; i++) { reserved.push("COM" + i, "LPT" + i); }
  if (reserved.includes(upper)) return "该名称是系统保留名称";
  return null;
}

function _jsArg(value) {
  return JSON.stringify(String(value ?? ""))
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function renderSettingsEmoji() {
  setTopBar("表情包管理", true,
    `<button class="top-btn" title="导入" onclick="PawzoChat.emojiImportPick()">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="top-btn" title="新建" onclick="PawzoChat.emojiAddGroup()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`
  );
  const importInputHtml = `<input type="file" id="emoji-import-file" accept=".zip" style="display:none" onchange="PawzoChat.emojiImportSubmit(this)">`;
  content().innerHTML = `${importInputHtml}<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/emoji/groups");
    const groups = res.groups || [];
    if (groups.length === 0) {
      content().innerHTML = `${importInputHtml}<div class="empty-state">
        <div class="empty-text">没有表情包分组</div>
        <button onclick="PawzoChat.emojiAddGroup()">新建分组</button>
      </div>`;
      return;
    }
    const html = groups.map(g => {
      const emoCount = g.emotions.length;
      return `<div class="card" style="margin:8px 16px;cursor:pointer" onclick="PawzoChat.pushPage('emojiGroup',{name:${_jsArg(g.name)}})">
        <div style="padding:14px 16px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:15px;font-weight:600">${esc(g.name)}</span>
            <span style="font-size:12px;color:var(--text-3)">${g.total_images} 张</span>
          </div>
          <div style="font-size:13px;color:var(--text-2);margin-top:4px">${emoCount} 个情绪分类</div>
        </div>
      </div>`;
    }).join("");
    content().innerHTML = `${importInputHtml}<div class="page">${html}</div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export function emojiAddGroup() {
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">新建分组</div>
    <div style="margin:16px 0">
      <input class="form-input" id="emoji-new-group" placeholder="输入分组名称">
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.emojiConfirmAddGroup()">创建</button>
    </div>
  </div>`);
}

export async function emojiConfirmAddGroup() {
  const name = $("emoji-new-group")?.value.trim();
  const err = _validateFsName(name);
  if (err) { toast(err, "error"); return; }
  showLoading("创建中…");
  try {
    const res = await api.post("/api/emoji/groups", { name });
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    closeOverlay();
    toast("已创建", "success");
    renderSettingsEmoji();
  } catch (e) { toast("创建失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Emoji Import / Export (single group as PawzoChat-native zip) ---- */

export function emojiImportPick() {
  const input = $("emoji-import-file");
  if (input) { input.value = ""; input.click(); }
}

export async function emojiImportSubmit(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  showLoading("导入中…");
  try {
    const base = window.PAWZOCHAT_BASE || "";
    const resp = await fetch(`${base}/api/emoji/_import`, { method: "POST", body: fd });
    const data = await resp.json();
    if (resp.status >= 400) { toast(data?.error || "导入失败", "error"); return; }
    if (data.renamed) {
      toast(`已导入，重命名为「${data.group}」（同名冲突）`, "success");
    } else {
      toast(`已导入「${data.group}」`, "success");
    }
    renderSettingsEmoji();
  } catch (e) { toast("导入失败", "error"); }
  finally { hideLoading(); }
}

export async function emojiExportGroup(name) {
  showLoading("导出中…");
  try {
    await downloadFile(
      `/api/emoji/groups/${encodeURIComponent(name)}/_export`,
      `${name}_emoji_pawzochat.zip`,
    );
    toast("已开始下载", "success");
  } catch (e) {
    toast(e?.message || "导出失败", "error");
  } finally { hideLoading(); }
}

/* ---- Emoji Group Detail ---- */

async function renderEmojiGroup(data) {
  const groupName = data.name;
  setTopBar(groupName, true,
    `<button class="top-btn" onclick="PawzoChat.emojiAddEmotion(${_jsArg(groupName)})">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/emoji/groups");
    const group = (res.groups || []).find(g => g.name === groupName);
    if (!group) { toast("分组不存在", "error"); goBack(); return; }

    let emotionsHtml = "";
    if (group.emotions.length === 0) {
      emotionsHtml = `<div class="card" style="margin:8px 16px"><div style="padding:20px;text-align:center;color:var(--text-3);font-size:14px">暂无情绪分类</div></div>`;
    } else {
      emotionsHtml = group.emotions.map(e => {
        return `<div class="card" style="margin:8px 16px;cursor:pointer" onclick="PawzoChat.pushPage('emojiEmotion',{group:${_jsArg(groupName)},emotion:${_jsArg(e.name)}})">
          <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:15px;font-weight:500">${esc(e.name)}</span>
            <span style="font-size:13px;color:var(--text-3)">${e.image_count} 张</span>
          </div>
        </div>`;
      }).join("");
    }

    content().innerHTML = `<div class="page">
      ${emotionsHtml}
      <div class="persona-actions mt-16">
        <button class="btn-text" onclick="PawzoChat.emojiExportGroup(${_jsArg(groupName)})">导出表情包分组</button>
        <button class="btn-text" onclick="PawzoChat.emojiRenameGroup(${_jsArg(groupName)})">重命名分组</button>
        <button class="btn-text danger" onclick="PawzoChat.emojiDeleteGroup(${_jsArg(groupName)})">删除分组</button>
      </div>
    </div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export function emojiAddEmotion(groupName) {
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">新建情绪分类</div>
    <div style="margin:16px 0">
      <input class="form-input" id="emoji-new-emotion" placeholder="输入情绪关键词，如 happy、sad">
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.emojiConfirmAddEmotion(${_jsArg(groupName)})">创建</button>
    </div>
  </div>`);
}

export async function emojiConfirmAddEmotion(groupName) {
  const name = $("emoji-new-emotion")?.value.trim();
  const err = _validateFsName(name);
  if (err) { toast(err, "error"); return; }
  showLoading("创建中…");
  try {
    const res = await api.post(`/api/emoji/groups/${encodeURIComponent(groupName)}/emotions`, { name });
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    closeOverlay();
    toast("已创建", "success");
    renderEmojiGroup({ name: groupName });
  } catch (e) { toast("创建失败", "error"); }
  finally { hideLoading(); }
}

export function emojiRenameGroup(oldName) {
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">重命名分组</div>
    <div style="margin:16px 0">
      <input class="form-input" id="emoji-rename-group" value="${esc(oldName)}" placeholder="输入新名称">
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.emojiConfirmRenameGroup(${_jsArg(oldName)})">保存</button>
    </div>
  </div>`);
}

export async function emojiConfirmRenameGroup(oldName) {
  const newName = $("emoji-rename-group")?.value.trim();
  if (newName === oldName) { closeOverlay(); return; }
  const err = _validateFsName(newName);
  if (err) { toast(err, "error"); return; }
  showLoading("保存中…");
  try {
    const res = await api.patch(`/api/emoji/groups/${encodeURIComponent(oldName)}`, { name: newName });
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    closeOverlay();
    toast("已重命名", "success");
    goBack();
  } catch (e) { toast("重命名失败", "error"); }
  finally { hideLoading(); }
}

export async function emojiDeleteGroup(name) {
  // Probe persona bindings up front so the confirm dialog can fold the
  // collateral warning into a single prompt (back-to-back confirms race
  // against each other in this UI — see ui.js:closeConfirm 200ms hide timer).
  let referencing = [];
  let referencesKnown = false;
  try {
    const res = await api.get(`/api/emoji/groups/${encodeURIComponent(name)}/references`);
    if (Array.isArray(res.referencing_personas)) {
      referencing = res.referencing_personas;
      referencesKnown = true;
    }
  } catch (e) { /* tolerate; fall through with empty list */ }

  const msg = referencing.length === 0
    ? `确认删除「${name}」及其所有情绪和图片？`
    : `「${name}」当前已绑定到 ${referencing.map(p => p.name).join("、")}，删除将解除绑定并清除所有情绪和图片。确认删除？`;
  const ok = await confirm("删除分组", msg, true);
  if (!ok) return;

  showLoading("删除中…");
  try {
    let url = `/api/emoji/groups/${encodeURIComponent(name)}`;
    if (referencesKnown) {
      const expectedRefs = JSON.stringify(referencing.map(p => p.id));
      url += `?force=true&expected_refs=${encodeURIComponent(expectedRefs)}`;
    }
    const res = await api.del(url);
    if (res.status >= 400) {
      toast(res.data?.error || "删除失败", "error");
      return;
    }
    toast("已删除", "success");
    goBack();
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Emoji Emotion Detail ---- */

async function renderEmojiEmotion(data) {
  const { group, emotion } = data;
  setTopBar(emotion, true,
    `<button class="top-btn" onclick="PawzoChat.emojiUploadImages(${_jsArg(group)},${_jsArg(emotion)})">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get(`/api/emoji/groups/${encodeURIComponent(group)}/emotions/${encodeURIComponent(emotion)}/images`);
    const images = res.images || [];

    let gridHtml = "";
    if (images.length === 0) {
      gridHtml = `<div class="card" style="margin:8px 16px"><div style="padding:20px;text-align:center;color:var(--text-3);font-size:14px">暂无表情包图片</div></div>`;
    } else {
      const base = window.PAWZOCHAT_BASE || "";
      const items = images.map(img => {
        return `<div class="emoji-thumb" onclick="PawzoChat.emojiImageMenu(${_jsArg(group)},${_jsArg(emotion)},${_jsArg(img.filename)})">
          <img src="${esc(base + img.url)}" alt="${esc(img.filename)}" loading="lazy">
          <div class="emoji-thumb-name">${esc(img.filename)}</div>
        </div>`;
      }).join("");
      gridHtml = `<div class="card" style="margin:8px 16px"><div class="emoji-grid">${items}</div></div>`;
    }

    content().innerHTML = `<div class="page">
      ${gridHtml}
      <div class="persona-actions mt-16">
        <button class="btn-text" onclick="PawzoChat.emojiRenameEmotion(${_jsArg(group)},${_jsArg(emotion)})">重命名分类</button>
        <button class="btn-text danger" onclick="PawzoChat.emojiDeleteEmotion(${_jsArg(group)},${_jsArg(emotion)})">删除分类</button>
      </div>
    </div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export function emojiUploadImages(group, emotion) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ".png,.gif,.jpg,.jpeg,.webp";
  input.onchange = async () => {
    if (!input.files.length) return;
    const fd = new FormData();
    for (const f of input.files) fd.append("files", f);
    try {
      const resp = await fetch(`${window.PAWZOCHAT_BASE || ""}/api/emoji/groups/${encodeURIComponent(group)}/emotions/${encodeURIComponent(emotion)}/images`, {
        method: "POST",
        body: fd,
      });
      const res = await resp.json();
      if (res.error) { toast(res.error, "error"); return; }
      toast(`已上传 ${res.saved.length} 张`, "success");
      renderEmojiEmotion({ group, emotion });
    } catch (e) { toast("上传失败", "error"); }
  };
  input.click();
}

export function emojiImageMenu(group, emotion, filename) {
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">${esc(filename)}</div>
    <div style="text-align:center;margin:16px 0">
      <img src="${window.PAWZOCHAT_BASE || ""}/emoji-static/${encodeURIComponent(group)}/${encodeURIComponent(emotion)}/${encodeURIComponent(filename)}"
        style="max-width:200px;max-height:200px;border-radius:8px">
    </div>
    <div class="form-stack">
      <button onclick="PawzoChat.emojiRenameImage(${_jsArg(group)},${_jsArg(emotion)},${_jsArg(filename)})"
        class="btn-secondary">重命名</button>
      <button onclick="PawzoChat.emojiDeleteImage(${_jsArg(group)},${_jsArg(emotion)},${_jsArg(filename)})"
        class="btn-secondary danger">删除</button>
      <button onclick="PawzoChat.closeOverlay()"
        class="btn-secondary">取消</button>
    </div>
  </div>`);
}

export function emojiRenameImage(group, emotion, oldFilename) {
  closeOverlay();
  setTimeout(() => {
    showSheet(`<div class="sheet-body">
      <div class="sheet-title">重命名图片</div>
      <div style="margin:16px 0">
        <input class="form-input" id="emoji-rename-img" value="${esc(oldFilename)}" placeholder="输入新文件名">
      </div>
      <div class="form-actions">
        <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
        <button class="btn-primary" onclick="PawzoChat.emojiConfirmRenameImage(${_jsArg(group)},${_jsArg(emotion)},${_jsArg(oldFilename)})">保存</button>
      </div>
    </div>`);
  }, 300);
}

export async function emojiConfirmRenameImage(group, emotion, oldFilename) {
  const newFilename = $("emoji-rename-img")?.value.trim();
  if (newFilename === oldFilename) { closeOverlay(); return; }
  if (!newFilename) { toast("文件名不能为空", "error"); return; }
  const stem = newFilename.replace(/\.[^.]+$/, "");
  const nameErr = _validateFsName(stem);
  if (nameErr) { toast(nameErr, "error"); return; }
  const ext = newFilename.includes(".") ? newFilename.substring(newFilename.lastIndexOf(".")).toLowerCase() : "";
  if (![".png", ".gif", ".jpg", ".jpeg", ".webp"].includes(ext)) { toast("不支持的图片格式", "error"); return; }
  showLoading("保存中…");
  try {
    const res = await api.patch(
      `/api/emoji/groups/${encodeURIComponent(group)}/emotions/${encodeURIComponent(emotion)}/images/${encodeURIComponent(oldFilename)}`,
      { filename: newFilename }
    );
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    closeOverlay();
    toast("已重命名", "success");
    renderEmojiEmotion({ group, emotion });
  } catch (e) { toast("重命名失败", "error"); }
  finally { hideLoading(); }
}

export async function emojiDeleteImage(group, emotion, filename) {
  closeOverlay();
  const ok = await confirm("删除图片", `确认删除「${filename}」？`, true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const res = await api.del(
      `/api/emoji/groups/${encodeURIComponent(group)}/emotions/${encodeURIComponent(emotion)}/images/${encodeURIComponent(filename)}`
    );
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    toast("已删除", "success");
    renderEmojiEmotion({ group, emotion });
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

export function emojiRenameEmotion(group, oldName) {
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">重命名情绪分类</div>
    <div style="margin:16px 0">
      <input class="form-input" id="emoji-rename-emo" value="${esc(oldName)}" placeholder="输入新名称">
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.emojiConfirmRenameEmotion(${_jsArg(group)},${_jsArg(oldName)})">保存</button>
    </div>
  </div>`);
}

export async function emojiConfirmRenameEmotion(group, oldName) {
  const newName = $("emoji-rename-emo")?.value.trim();
  if (newName === oldName) { closeOverlay(); return; }
  const err = _validateFsName(newName);
  if (err) { toast(err, "error"); return; }
  showLoading("保存中…");
  try {
    const res = await api.patch(
      `/api/emoji/groups/${encodeURIComponent(group)}/emotions/${encodeURIComponent(oldName)}`,
      { name: newName }
    );
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    closeOverlay();
    toast("已重命名", "success");
    goBack();
  } catch (e) { toast("重命名失败", "error"); }
  finally { hideLoading(); }
}

export async function emojiDeleteEmotion(group, name) {
  const ok = await confirm("删除情绪分类", `确认删除「${name}」及其所有图片？`, true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const res = await api.del(`/api/emoji/groups/${encodeURIComponent(group)}/emotions/${encodeURIComponent(name)}`);
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    toast("已删除", "success");
    goBack();
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

/* ============ Network Settings ============ */

function renderSettingsNetwork() {
  if (state.settings?.is_public) {
    setTopBar("网络设置", true, "");
    content().innerHTML = `<div class="page"><div class="card" style="margin:16px"><div style="padding:20px;text-align:center;color:var(--text-3);font-size:14px">网络设置仅支持从本地访问管理</div></div></div>`;
    return;
  }
  setTopBar("网络设置", true, "");
  const w = state.settings?.web || {};
  const hasPw = !!w.has_password;
  const publicOn = !!w.public_enabled;

  let publicBlock = "";
  if (publicOn) {
    const port = w.public_port || "—";
    const secret = w.public_secret || "—";
    const url = `https://你的公网IP:${port}/${secret}`;
    publicBlock = `
      <div class="card" style="margin-top:12px">
        <div class="card-header">公网访问信息</div>
        <div class="form-group"><div class="form-row">
          <label>公网端口</label>
          <span class="row-value" style="flex:1;text-align:right;user-select:text;margin-right:8px">${esc(String(port))}</span>
          <button class="btn-outline" onclick="PawzoChat.copyPublicField('port')" style="white-space:nowrap;padding:4px 12px">复制</button>
        </div></div>
        <div class="form-group"><div class="form-row">
          <label>随机路径</label>
          <span class="row-value" style="flex:1;text-align:right;user-select:text;word-break:break-all;margin-right:8px">${esc(secret)}</span>
          <button class="btn-outline" onclick="PawzoChat.copyPublicField('secret')" style="white-space:nowrap;padding:4px 12px">复制</button>
        </div></div>
        <div style="padding:0 16px 12px">
          <button class="btn-outline" onclick="PawzoChat.regeneratePublicAccess()" style="width:100%">重新生成端口和路径</button>
        </div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-header">访问地址预览</div>
        <div style="padding:4px 16px 12px;display:flex;align-items:center;gap:8px">
          <span style="flex:1;word-break:break-all;font-size:14px;color:var(--text-2);user-select:text">${esc(url)}</span>
          <button class="btn-outline" onclick="PawzoChat.copyPublicUrl()" style="white-space:nowrap">复制</button>
        </div>
      </div>`;
  }

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="card-row" onclick="PawzoChat.pushPage('settingsPassword')">
        <div class="row-icon orange">${iconHtml("ri-key-2-line")}</div>
        <span class="row-label">公网访问密码</span>
        <span class="row-value">${hasPw ? "已设置" : "未设置"}</span><span class="row-arrow">›</span>
      </div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="form-group"><div class="form-row">
        <label>对公网开放 (实验性功能)</label>
        <label class="switch-wrap"><input type="checkbox" id="sn-public" ${publicOn ? "checked" : ""} ${hasPw ? "" : "disabled"}
          onchange="PawzoChat.togglePublicAccess()"><span class="switch-track"></span></label>
      </div></div>
      ${hasPw ? "" : `<div class="form-hint">需先设置公网访问密码</div>`}
    </div>
    ${publicBlock}
  </div>`;
}

/* ---- Password sub-page ---- */

function renderSettingsPassword() {
  if (state.settings?.is_public) {
    setTopBar("公网访问密码", true, "");
    content().innerHTML = `<div class="page"><div class="card" style="margin:16px"><div style="padding:20px;text-align:center;color:var(--text-3);font-size:14px">密码设置仅支持从本地访问管理</div></div></div>`;
    return;
  }
  setTopBar("公网访问密码", true,
    `<button class="btn-text" onclick="PawzoChat.savePassword()">保存</button>`
  );
  const hasPw = !!state.settings?.web?.has_password;
  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="form-group"><div class="form-row"><label>${hasPw ? "新密码" : "设置密码"}</label>
        <input type="password" id="sn-pw" placeholder="8位以上，含大小写字母和数字"></div></div>
      <div class="form-group"><div class="form-row"><label>确认密码</label>
        <input type="password" id="sn-pw2" placeholder="再次输入密码"></div></div>
    </div>
    <div class="form-hint" style="margin:12px 16px">此密码仅用于公网访问验证，本地访问无需密码。忘记密码时可从本机直接访问面板重新设置。</div>
    ${hasPw ? `<div style="padding:24px 16px 0">
      <button class="btn-outline" onclick="PawzoChat.clearPassword()" style="width:100%;color:var(--danger);border-color:var(--danger)">关闭公网访问密码</button>
    </div>` : ""}
  </div>`;
}

export async function savePassword() {
  const pw = $("sn-pw")?.value || "";
  const pw2 = $("sn-pw2")?.value || "";
  if (!pw) { toast("请输入密码", "error"); return; }
  if (pw !== pw2) { toast("两次输入的密码不一致", "error"); return; }
  showLoading("保存中…");
  try {
    const res = await api.patch("/api/settings", { web: { password: pw } });
    if (res.status && res.status >= 400) { toast(res.data?.error || "保存失败", "error"); return; }
    if (res.data?.web) { state.settings = state.settings || {}; state.settings.web = res.data.web; }
    toast("密码已设置", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function clearPassword() {
  const ok = await confirm("关闭公网访问密码", "关闭密码后公网访问也会同时关闭，确认继续？", true);
  if (!ok) return;
  showLoading("操作中…");
  try {
    const res = await api.patch("/api/settings", { web: { password: "", public_enabled: false } });
    if (res.status && res.status >= 400) { toast(res.data?.error || "操作失败", "error"); return; }
    if (res.data?.web) { state.settings = state.settings || {}; state.settings.web = res.data.web; }
    toast("密码已关闭，公网访问已同时关闭，重启后生效", "success");
    goBack();
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export async function togglePublicAccess() {
  const publicEnabled = !!$("sn-public")?.checked;
  if (!publicEnabled) {
    await _doTogglePublic(false);
    return;
  }
  _showPublicWarning();
}

let _publicWarningTimer = null;
let _publicWarningConfirmed = false;

function _showPublicWarning() {
  _publicWarningConfirmed = false;
  let countdown = 10;

  showSheet(`<div class="sheet-body">
    <div style="text-align:center;margin-bottom:4px">
      <div class="row-icon orange" style="width:48px;height:48px;border-radius:50%;font-size:24px">
        ${iconHtml("ri-error-warning-line")}
      </div>
    </div>
    <div class="sheet-title" style="color:var(--danger)">安全风险提醒</div>
    <div style="font-size:13px;color:var(--text-2);line-height:1.7;padding:0 8px;margin-bottom:20px">
      <p style="margin-bottom:8px">开启公网访问后，您的 PawzoChat 面板将可通过互联网访问。虽然已有以下安全措施：</p>
      <div style="margin-bottom:8px;padding-left:4px">
        <div style="margin-bottom:2px">• 自签名 HTTPS 加密传输</div>
        <div style="margin-bottom:2px">• 随机端口 + 随机访问路径</div>
        <div>• 访问密码保护</div>
      </div>
      <p>但仍<strong style="color:var(--danger)">无法保证 100% 安全</strong>。自签名证书会被浏览器标记为"不受信任"，且服务暴露在公网可能面临未知安全威胁。请确保您充分理解并愿意自行承担相关风险。</p>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.cancelPublicToggle()">取消</button>
      <button class="btn-secondary" id="public-confirm-btn" disabled onclick="PawzoChat.confirmPublicToggle()">我已了解风险 (${countdown}s)</button>
    </div>
  </div>`, () => {
    if (_publicWarningTimer) { clearInterval(_publicWarningTimer); _publicWarningTimer = null; }
    if (!_publicWarningConfirmed && $("sn-public")) {
      $("sn-public").checked = false;
    }
  });

  _publicWarningTimer = setInterval(() => {
    countdown--;
    const btn = $("public-confirm-btn");
    if (!btn) { clearInterval(_publicWarningTimer); _publicWarningTimer = null; return; }
    if (countdown > 0) {
      btn.textContent = `我已了解风险 (${countdown}s)`;
    } else {
      clearInterval(_publicWarningTimer);
      _publicWarningTimer = null;
      btn.textContent = "我已了解风险";
      btn.disabled = false;
      btn.classList.replace("btn-secondary", "btn-primary");
      btn.classList.add("danger");
    }
  }, 1000);
}

export function cancelPublicToggle() {
  closeOverlay();
}

export async function confirmPublicToggle() {
  _publicWarningConfirmed = true;
  closeOverlay();
  await _doTogglePublic(true);
}

async function _doTogglePublic(enabled) {
  showLoading("保存中…");
  try {
    const res = await api.patch("/api/settings", { web: { public_enabled: enabled } });
    if (res.status && res.status >= 400) {
      toast(res.data?.error || "保存失败", "error");
      if ($("sn-public")) $("sn-public").checked = !enabled;
      return;
    }
    if (res.data?.web) { state.settings = state.settings || {}; state.settings.web = res.data.web; }
    toast("已保存，请重启 PawzoChat 生效", "success");
    renderSettingsNetwork();
  } catch (e) {
    toast("保存失败", "error");
    if ($("sn-public")) $("sn-public").checked = !enabled;
  }
  finally { hideLoading(); }
}

export async function regeneratePublicAccess() {
  const ok = await confirm("重新生成", "将生成新的公网端口和随机路径，原有的访问地址将失效。", false);
  if (!ok) return;
  showLoading("操作中…");
  try {
    const res = await api.post("/api/settings/regenerate-public", {});
    if (res.status >= 400) { toast(res.data?.error || "操作失败", "error"); return; }
    if (res.data?.web) { state.settings = state.settings || {}; state.settings.web = res.data.web; }
    toast("已重新生成，请重启 PawzoChat 生效", "success");
    renderSettingsNetwork();
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export function copyPublicUrl() {
  const w = state.settings?.web || {};
  const url = `https://你的公网IP:${w.public_port || ""}/${w.public_secret || ""}`;
  navigator.clipboard.writeText(url).then(
    () => toast("已复制到剪贴板", "success"),
    () => toast("复制失败", "error"),
  );
}

export function copyPublicField(field) {
  const w = state.settings?.web || {};
  const text = field === "port" ? String(w.public_port || "") : String(w.public_secret || "");
  if (!text) { toast("无可复制内容", "error"); return; }
  navigator.clipboard.writeText(text).then(
    () => toast("已复制到剪贴板", "success"),
    () => toast("复制失败", "error"),
  );
}

/* ============ About ============ */

async function renderSettingsAbout() {
  setTopBar("关于", true, "");
  let ver = state._version || "";
  if (!ver) {
    try { const s = await api.get("/api/status"); ver = s.version || ""; state._version = ver; } catch (_) {}
  }

  const u = state._updateInfo || {};
  let updateState = u.download_state || state._updateState || null;
  try {
    updateState = _applyUpdateState(await api.get("/api/update/state", { bypassCache: true }));
  } catch (_) {
    updateState = _applyUpdateState(updateState);
  }
  let updateHtml = "";
  if (u.has_update) {
    const latestVer = esc(u.latest_version || "");
    if (updateState?.ready) {
      updateHtml = `<div class="about-update-banner">
        <div style="font-size:14px;font-weight:500">更新包已准备完成 v${latestVer}</div>
        <button class="about-update-btn" onclick="PawzoChat.applyUpdate()">立即重启更新</button>
      </div>`;
    } else if (u.download_available) {
      updateHtml = `<div class="about-update-banner">
        <div style="font-size:14px;font-weight:500">发现新版本 v${latestVer}</div>
        <button class="about-update-btn" onclick="PawzoChat.startUpdateDownload()">下载并更新</button>
      </div>`;
    } else {
      updateHtml = `<div class="about-update-banner">
        <div style="font-size:14px;font-weight:500">发现新版本 v${latestVer}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:4px">当前平台暂无下载包</div>
      </div>`;
    }
  } else {
    updateHtml = `<button class="about-btn about-btn-outline" onclick="PawzoChat.checkForUpdate()">检查更新</button>`;
  }

  const base = window.PAWZOCHAT_BASE || "";
  content().innerHTML = `<div class="about-page">
    <div class="about-logo"><img src="${base}/static/logo.png" alt="PawzoChat"></div>
    <div class="about-name">PawzoChat</div>
    <div class="about-version">${ver ? "v" + esc(ver) : ""}</div>
    <div class="about-divider"></div>
    <div class="about-desc">拟人感 · 多功能 · 可扩展的 AI 伙伴引擎</div>
    <div class="about-author">by iwyxdxl</div>
    <div class="about-btn-group">
      <button class="about-btn about-btn-primary" onclick="PawzoChat.showQuickSetup()">快速配置</button>
      <button class="about-btn about-btn-pawapi" onclick="window.open('https://paw.v1chat.cc/console','_blank')">前往 PawAPI</button>
      ${updateHtml}
      <button class="about-btn about-btn-outline" onclick="window.open('https://github.com/iwyxdxl/PawzoChat','_blank','noopener')">获取源代码</button>
      <button class="about-btn about-btn-outline" onclick="PawzoChat.pushPage('settingsPrivacy')">隐私说明及设置</button>
      <button class="about-btn about-btn-outline" onclick="PawzoChat.pushPage('settingsStatement')">软件声明</button>
    </div>
    <div class="about-footer" style="margin-top:20px;text-align:center;font-size:11px;color:var(--text-3);opacity:0.1">i·w·y·x·d·x·l</div>
  </div>`;
}

/* ============ Privacy / Telemetry ============ */

async function renderSettingsPrivacy() {
  setTopBar("隐私说明及设置", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  let data = { enabled: true, endpoint: "" };
  try {
    data = await api.get("/api/telemetry/settings");
  } catch (e) { /* fall back to defaults */ }
  const enabled = !!data.enabled;
  const endpoint = data.endpoint || "analysis.pawzochat.com";
  let endpointHost = endpoint;
  try { endpointHost = new URL(endpoint).host || endpoint; } catch (e) { /* keep raw */ }

  const sectionTextStyle = "padding:12px 16px;font-size:14px;color:var(--text-2);line-height:1.7";
  const ulStyle = "padding-left:18px;margin:8px 0";
  const statusText = enabled ? "已开启" : "已关闭";
  const statusColor = enabled ? "var(--success,#22c55e)" : "var(--text-3)";

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="card-header">隐私说明</div>
      <div style="${sectionTextStyle}">
        我们希望了解大概有多少人在用 PawzoChat、新版本是否被升级了，因此自 PawzoChat v0.1.5 版本起添加了匿名使用统计，这仅为了帮助我们判断接下来开发什么功能、修复哪些问题，不会收集你的任何个人信息。
        <br><br>
        如果你不希望参与这项统计，你可以随时在下方关闭它。关闭后立即生效，后续不会再发送匿名使用统计。
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-header" style="color:var(--success,#22c55e)">会收集的数据</div>
      <div style="${sectionTextStyle}">
        PawzoChat 启动时，以及之后每 30 分钟，会向 <code>${esc(endpointHost)}</code> 发送一条匿名统计。统计内容只包含以下几项：
        <ul style="${ulStyle}">
          <li><b>一串随机字符串</b> — 用来区分"新用户"和"老用户"，与你的任何信息都无关</li>
          <li><b>PawzoChat 的版本号</b></li>
          <li><b>你用的是哪种操作系统</b> — Windows、macOS或Linux，不含具体版本号</li>
        </ul>
        除了完成这次网络请求所必需的连接信息外，PawzoChat 不会发送你的 IP 地址或定位信息。
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-header" style="color:var(--error,#e74c3c)">不会收集的数据</div>
      <div style="${sectionTextStyle}">
        我们承诺<b>永远不会</b>收集和发送以下任何信息：
        <ul style="${ulStyle}">
          <li>你的聊天记录、消息内容、图片、语音、文件和表情包内容</li>
          <li>你绑定的聊天账号信息（微信、QQ 等）、账号昵称、账号 ID</li>
          <li>你创建的角色设定、世界书、记忆库</li>
          <li>你配置的 API Key、模型服务商信息</li>
          <li>你的姓名、头像、电话、邮箱</li>
          <li>你电脑的型号、CPU、硬盘序列号、MAC 地址</li>
          <li>你的具体位置（城市、街道等）</li>
          <li>你电脑里的任何文件、其他软件</li>
          <li>你的浏览历史、其他应用的活动</li>
          <li>你的其他个人隐私信息</li>
        </ul>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-header">设置</div>
      <div class="form-group"><div class="form-row">
        <label>匿名使用统计</label>
        <span id="sp-tele-status" style="flex:1;text-align:right;font-size:13px;color:${statusColor};margin-right:12px">${statusText}</span>
        <label class="switch-wrap"><input type="checkbox" id="sp-tele" ${enabled ? "checked" : ""}
          onchange="PawzoChat.toggleTelemetry()"><span class="switch-track"></span></label>
      </div></div>
      <div class="form-hint">关闭后立即生效，无需重启程序。</div>
    </div>
  </div>`;
}

export async function toggleTelemetry() {
  const el = $("sp-tele");
  if (!el) return;
  const want = !!el.checked;
  const status = $("sp-tele-status");
  const syncStatus = (enabled) => {
    if (!status) return;
    status.textContent = enabled ? "已开启" : "已关闭";
    status.style.color = enabled ? "var(--success,#22c55e)" : "var(--text-3)";
  };
  el.disabled = true;
  try {
    const resp = await api.patch("/api/telemetry/settings", { enabled: want });
    if (resp.status >= 400) {
      throw new Error(resp.data?.error || "保存失败");
    }
    const actual = typeof resp.data?.enabled === "boolean" ? resp.data.enabled : want;
    el.checked = actual;
    syncStatus(actual);
    toast(actual ? "已启用匿名统计" : "已关闭匿名统计", "success");
  } catch (e) {
    el.checked = !want;
    syncStatus(!want);
    toast("保存失败", "error");
  } finally {
    el.disabled = false;
  }
}

/* ============ Software Statement ============ */

async function renderSettingsStatement() {
  setTopBar("软件声明", true, "");

  const sectionTextStyle = "padding:12px 16px;font-size:14px;color:var(--text-2);line-height:1.7";

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="card-header">法律与合规</div>
      <div style="${sectionTextStyle}">
        感谢你选择 PawzoChat！在使用本软件前，请<b>遵守你所在地区的法律法规</b>，不要将 PawzoChat 用于任何<b>违法、违规或侵害他人合法权益</b>的用途。
        <br>
        如果你使用微信、QQ 等第三方平台接入 PawzoChat 进行聊天，请<b>务必遵守对应平台的官方规则</b>（如《微信个人帐号使用规范》《腾讯微信软件许可及服务协议》《QQ 机器人开放平台开发者协议》等）。
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-header">关于 AI 生成内容</div>
      <div style="${sectionTextStyle}">
        PawzoChat 的回复由你所配置的大语言模型生成，<b>作者无法预知也无法控制 AI 的具体发言内容</b>。
        <br>
        AI 输出的观点、建议或信息仅供参考，<b>作者不对其准确性、合法性或由此产生的后果承担责任</b>，请你自行甄别与判断。
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-header">关于人设卡和世界书</div>
      <div style="${sectionTextStyle}">
        PawzoChat 兼容 SillyTavern（酒馆）格式的人设卡和世界书，<b>仅是为了让你更方便地复用已有创作</b>。
        <br>
        如果你希望使用或传播他人创作的 PawzoChat 或 SillyTavern 人设卡、世界书，<b>请务必事先取得原作者的同意</b>，并尊重原作者的署名、授权与分发要求。
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-header">关于隐私</div>
      <div style="${sectionTextStyle}">
        为了了解大概有多少人在用 PawzoChat，我们会通过<b>一串匿名随机 ID</b> 统计用户数量，<b>不包含任何个人信息</b>。
        <br>
        你可以随时选择关闭，详情请见
        <a href="javascript:void(0)" onclick="PawzoChat.pushPage('settingsPrivacy')" style="color:var(--brand,#3b82f6);text-decoration:none">隐私说明及设置</a>。
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="card-header">最后想说的</div>
      <div style="${sectionTextStyle}">
        以上声明<b>并不代表我们逃避应当承担的必要责任</b>。我们会持续完善 PawzoChat，遇到问题或建议都欢迎反馈，希望你和它都能开心相处。
      </div>
    </div>
  </div>`;
}

/* ============ Update ============ */

function _updateErrorText(code) {
  if (!code) return "操作失败";
  const mapping = {
    dev_mode: "开发环境不支持应用内更新",
    already_downloading: "已有更新下载任务正在进行",
    no_download_available: "当前版本没有可用更新包",
    staging_not_ready: "更新包尚未准备完成，请先重新下载",
  };
  return mapping[code] || code;
}

function _applyUpdateState(updateState) {
  const normalized = {
    stage: updateState?.stage || "idle",
    progress: Number.isFinite(updateState?.progress) ? updateState.progress : 0,
    ready: !!updateState?.ready,
    error: updateState?.error || "",
  };
  state._updateState = normalized;
  if (state._updateInfo) {
    state._updateInfo.download_state = normalized;
  }
  return normalized;
}

async function _pollUpdateState(timeoutMs = 180000) {
  const token = Symbol("update-poll");
  state._updatePollToken = token;
  const deadline = Date.now() + timeoutMs;

  while (state._updatePollToken === token && Date.now() < deadline) {
    try {
      // Bypass the SWR cache: a hit would return last cycle's payload and
      // yank the progress bar backwards against the live SSE updates.
      const updateState = _applyUpdateState(await api.get("/api/update/state", { bypassCache: true }));
      onUpdateProgress(updateState);
      if (updateState.ready || updateState.error) return updateState;
    } catch (_) { /* silent */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return null;
}

export async function checkForUpdate() {
  if (state._updateInfo?.reason === "dev_mode") {
    toast("开发环境下不支持检查更新", "info");
    return;
  }
  toast("正在检查更新…", "info");
  try {
    const u = await api.get("/api/update/check", { bypassCache: true });
    state._updateInfo = u;
    _applyUpdateState(u.download_state);
    if (u.reason === "dev_mode") {
      toast("开发环境下不支持检查更新", "info");
      renderSettingsAbout();
      return;
    }
    if (u.has_update) {
      toast(`发现新版本 v${u.latest_version}`, "success");
    } else if (u.error === "network_error") {
      toast("网络连接失败，无法检查更新", "error");
    } else {
      toast("当前已是最新版本", "success");
    }
    renderSettingsAbout();
  } catch (e) { toast("检查更新失败", "error"); }
}

export async function startUpdateDownload() {
  const u = state._updateInfo;
  if (!u || !u.download_available) return;
  // Guard against rapid double-clicks triggering duplicate download requests
  if (state._updateListening || state._updateState?.stage === "downloading") {
    toast("下载已在进行中", "info");
    return;
  }

  showSheet(`<div style="padding:24px">
    <div class="sheet-title">下载更新</div>
    <div style="font-size:13px;color:var(--text-2);text-align:center;margin:12px 0">
      正在下载 v${esc(u.latest_version || "")}，完成后将自动重启更新…
    </div>
    <div class="update-progress-wrap">
      <div class="update-progress-bar" id="update-progress-bar" style="width:0%"></div>
    </div>
    <div id="update-progress-text" style="text-align:center;font-size:12px;color:var(--text-3);margin-top:8px">0%</div>
    <div id="update-done-actions" style="display:none;margin-top:16px">
      <button class="btn-primary" onclick="PawzoChat.applyUpdate()">立即重启更新</button>
    </div>
    <button id="update-cancel-btn" class="btn-text" onclick="PawzoChat.closeOverlay()" style="margin-top:12px;width:100%">取消</button>
  </div>`, undefined, { dismissOverlay: false });

  state._updateListening = true;
  _applyUpdateState({ stage: "downloading", progress: 0, ready: false, error: "" });

  try {
    const res = await api.post("/api/update/download", {});
    if (res.status >= 400) {
      state._updateListening = false;
      state._updatePollToken = null;
      toast(_updateErrorText(res.data?.error), "error");
      closeOverlay();
      return;
    }
    _pollUpdateState();
  } catch (e) {
    state._updateListening = false;
    state._updatePollToken = null;
    toast("下载请求失败", "error");
    closeOverlay();
  }
}

export function onUpdateProgress(data) {
  const updateState = _applyUpdateState({
    stage: data.stage || data.status || state._updateState?.stage || "idle",
    progress: Number.isFinite(data.progress) ? data.progress : state._updateState?.progress || 0,
    ready: !!data.ready || data.done || data.stage === "ready",
    error: data.error || "",
  });

  if (!state._updateListening) return;
  const bar = document.getElementById("update-progress-bar");
  const text = document.getElementById("update-progress-text");
  const done = document.getElementById("update-done-actions");
  const cancel = document.getElementById("update-cancel-btn");

  if (updateState.error) {
    if (text) text.textContent = "下载失败";
    if (cancel) {
      cancel.textContent = "关闭";
      cancel.style.display = "";
    }
    setOverlayDismissible(true);
    state._updateListening = false;
    state._updatePollToken = null;
    toast("更新失败: " + updateState.error, "error");
    return;
  }

  const pct = updateState.progress || 0;
  if (bar) bar.style.width = pct + "%";

  if (updateState.stage === "extracting") {
    if (text) text.textContent = "正在解压…";
    if (cancel) cancel.style.display = "none";
  } else if (updateState.stage === "applying") {
    if (text) text.textContent = "正在重启更新…";
    if (cancel) cancel.style.display = "none";
  } else if (updateState.ready) {
    if (text) text.textContent = "下载完成";
    if (done) done.style.display = "";
    if (cancel) {
      cancel.textContent = "稍后再说";
      cancel.style.display = "";
    }
    state._updateListening = false;
    state._updatePollToken = null;
  } else {
    if (text) text.textContent = Math.round(pct) + "%";
    if (cancel) cancel.style.display = "";
  }
}

export async function applyUpdate() {
  closeOverlay();
  const ok = await confirm("立即重启", "应用将关闭并自动更新到新版本，更新完成后会自动重新启动。", false);
  if (!ok) return;

  // Show the restart hint first: the server is about to exit, the connection may drop at any time
  document.getElementById("app").innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;color:var(--text-2);gap:12px">
    <div style="font-size:16px;font-weight:500">正在重启更新…</div>
    <div style="font-size:13px;color:var(--text-3)">更新完成后可关闭此页面</div>
  </div>`;

  try {
    const res = await api.post("/api/update/apply", {});
    if (res.status >= 400) {
      // A genuine business error (e.g. staging not ready) — restore the page
      toast(_updateErrorText(res.data?.error), "error");
      renderSettingsAbout();
    }
  } catch (e) {
    // A connection drop caused by the server exiting is expected — don't show an error
  }
}

/* ============ Profile Edit ============ */

async function renderProfileEdit() {
  setTopBar("个人资料", true,
    `<button class="btn-text" onclick="PawzoChat.saveProfile()">保存</button>`
  );

  const profile = state.profile || { name: "我", has_avatar: false };
  const base = window.PAWZOCHAT_BASE || "";
  const avUrl = profile.has_avatar ? `${base}/api/profile/avatar` : "";

  content().innerHTML = `<div class="page">
    <input type="file" id="profile-avatar-input" accept="image/*" style="display:none" onchange="PawzoChat.onProfileAvatarSelected(this)">
    <div class="card">
      <div class="card-header">基本信息</div>
      <div class="form-group" style="display:flex;justify-content:center;padding:12px 0 4px">
        <div class="avatar-upload-wrap" onclick="document.getElementById('profile-avatar-input').click()">
          ${avatarHtml(profile.name, "lg", avUrl)}
          <div class="avatar-cam">${_CAM_SVG}</div>
        </div>
      </div>
      <div class="form-group"><div class="form-row"><label>名称</label><input id="profile-name" value="${esc(profile.name)}" placeholder="输入名称"></div></div>
    </div>
  </div>`;
}

export function onProfileAvatarSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (!file.type.startsWith("image/")) { toast("请选择图片文件", "error"); return; }
  input.value = "";

  const url = URL.createObjectURL(file);
  PawzoChat.openCropModal(url, async (blob) => {
    const fd = new FormData();
    fd.append("avatar", blob, "avatar.png");
    const base = window.PAWZOCHAT_BASE || "";
    try {
      const resp = await fetch(`${base}/api/profile/avatar`, { method: "POST", body: fd });
      const res = await resp.json();
      if (resp.status >= 400) { toast(res.error || "上传失败", "error"); return; }
      state.profile.has_avatar = true;
      toast("头像已更新", "success");
      const avDiv = content().querySelector(".avatar-upload-wrap .avatar");
      if (avDiv) {
        avDiv.style.background = "";
        avDiv.innerHTML = `<img src="${base}/api/profile/avatar?t=${Date.now()}" alt="avatar">`;
      }
    } catch (e) { toast("上传失败", "error"); }
  });
}

export async function saveProfile() {
  const name = $("profile-name")?.value?.trim();
  if (!name) { toast("名称不能为空", "error"); return; }
  if (name.length > 50) { toast("名称过长", "error"); return; }

  showLoading("保存中…");
  try {
    const res = await api.patch("/api/profile", { name });
    if (res.status >= 400) { toast(res.data?.error || "保存失败", "error"); return; }
    state.profile = { name: res.data?.name || name, has_avatar: res.data?.has_avatar ?? state.profile?.has_avatar };
    toast("已保存", "success");
    goBack();
    refreshSidebar();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

/* ============ Theme Settings ============ */

let _themeListCache = [];
let _themeEditContext = { originalName: null, css: "" };
let _themeSelectionMode = { active: false, selected: new Set() };

async function _loadThemeList() {
  try {
    const r = await api.get("/api/themes");
    _themeListCache = r.themes || [];
  } catch (e) {
    _themeListCache = [];
  }
}

async function _persistTheme(patch) {
  const cur = state.settings?.theme || { mode: "light", active: [] };
  const next = { ...cur, ...patch };
  state.settings = { ...(state.settings || {}), theme: next };
  try {
    await api.patch("/api/settings", { theme: patch });
  } catch (e) { /* ignore, UI already updated */ }
  await applyThemeFromState();
}

async function renderSettingsTheme() {
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  await _loadThemeList();
  const theme = state.settings?.theme || { mode: "light", active: [] };
  const mode = theme.mode || "light";
  const activeNames = Array.isArray(theme.active) ? theme.active : [];
  const themeModeMeta = {
    light: { icon: "ri-sun-line", tone: "peach" },
    dark: { icon: "ri-moon-clear-line", tone: "neutral" },
    auto: { icon: "ri-computer-line", tone: "indigo" },
  };

  // Reconcile selection state with current theme list (drop names that no longer exist).
  const byName = new Set(_themeListCache.map(t => t.name));
  if (_themeSelectionMode.active) {
    const cleaned = new Set();
    for (const n of _themeSelectionMode.selected) if (byName.has(n)) cleaned.add(n);
    _themeSelectionMode.selected = cleaned;
  }
  const sel = _themeSelectionMode;
  const totalThemes = _themeListCache.length;
  const selectedCount = sel.selected.size;

  // Top bar
  if (sel.active) {
    const allOn = totalThemes > 0 && selectedCount === totalThemes;
    const exportDisabled = selectedCount === 0 ? " disabled" : "";
    const topBarRight = `
      <button class="btn-text" onclick="PawzoChat.themeSelectionToggleAll()">${allOn ? "取消全选" : "全选"}</button>
      <button class="btn-text"${exportDisabled} onclick="PawzoChat.themeExportSelected()">导出</button>`;
    const topBarLeft = `<button class="btn-text" onclick="PawzoChat.themeSelectionExit()">取消</button>`;
    setTopBar(`已选 ${selectedCount} 项`, false, topBarRight, topBarLeft);
  } else {
    const selectDisabled = totalThemes === 0 ? "disabled" : "";
    const topBarRight = `
      <button class="btn-text" onclick="PawzoChat.themeImportPick()">导入</button>
      <button class="btn-text" ${selectDisabled} onclick="PawzoChat.themeSelectionEnter()">选择</button>`;
    setTopBar("主题", true, topBarRight);
  }

  const modeRow = (key, label) => {
    const meta = themeModeMeta[key] || themeModeMeta.light;
    return `
    <label class="card-row" style="cursor:pointer">
      <div class="row-icon ${meta.tone} theme-mode-icon">${iconHtml(meta.icon)}</div>
      <span class="row-label">${label}</span>
      <input type="radio" class="theme-mode-choice" name="theme-mode" value="${key}" ${mode === key ? "checked" : ""} onchange="PawzoChat.onThemeModeChange('${key}')">
    </label>`;
  };
  const activeThemes = activeNames.filter(n => byName.has(n));
  const availableThemes = _themeListCache.filter(t => !activeNames.includes(t.name));
  const enc = (s) => encodeURIComponent(s);

  const checkboxFor = (name) => {
    const checked = sel.selected.has(name) ? "checked" : "";
    return `<input type="checkbox" ${checked} onchange="PawzoChat.themeSelectionToggle(decodeURIComponent('${enc(name)}'))">`;
  };

  const activeRow = (name, idx, total) => {
    const trailing = sel.active
      ? checkboxFor(name)
      : `
      <button type="button" class="icon-action" aria-label="上移" title="上移" ${idx === 0 ? "disabled" : ""} onclick="PawzoChat.onThemeMove(decodeURIComponent('${enc(name)}'), -1)">${iconHtml("ri-arrow-up-s-line")}</button>
      <button type="button" class="icon-action" aria-label="下移" title="下移" ${idx === total - 1 ? "disabled" : ""} onclick="PawzoChat.onThemeMove(decodeURIComponent('${enc(name)}'), 1)">${iconHtml("ri-arrow-down-s-line")}</button>
      <button type="button" class="icon-action" aria-label="移出应用" title="移出应用" onclick="PawzoChat.onThemeToggle(decodeURIComponent('${enc(name)}'), false)">${iconHtml("ri-subtract-line")}</button>`;
    return `
    <div class="card-row theme-row">
      <div class="row-icon purple">${iconHtml("ri-palette-line")}</div>
      <div class="theme-row-copy">
        <div class="row-label" title="${esc(name)}">${esc(name)}</div>
        <div class="theme-layer">第 ${idx + 1} 层${idx === total - 1 ? " · 最上层" : ""}</div>
      </div>
      <div class="theme-actions">${trailing}</div>
    </div>`;
  };

  const availableRow = (t) => {
    const trailing = sel.active
      ? checkboxFor(t.name)
      : `
      <button type="button" class="icon-action" aria-label="添加到应用" title="添加到应用" onclick="PawzoChat.onThemeToggle(decodeURIComponent('${enc(t.name)}'), true)">${iconHtml("ri-add-line")}</button>
      <button type="button" class="icon-action" aria-label="编辑" title="编辑" onclick="PawzoChat.pushPage('settingsThemeEdit',decodeURIComponent('${enc(t.name)}'))">${iconHtml("ri-edit-line")}</button>
      <button type="button" class="icon-action icon-action-danger" aria-label="删除" title="删除" onclick="PawzoChat.onThemeDelete(decodeURIComponent('${enc(t.name)}'))">${iconHtml("ri-delete-bin-line")}</button>`;
    return `
    <div class="card-row theme-row">
      <div class="row-icon neutral">${iconHtml("ri-palette-line")}</div>
      <div class="theme-row-copy">
        <div class="row-label" title="${esc(t.name)}">${esc(t.name)}</div>
      </div>
      <div class="theme-actions">${trailing}</div>
    </div>`;
  };

  const activeSection = activeThemes.length
    ? activeThemes.map((name, i) => activeRow(name, i, activeThemes.length)).join("")
    : '<div class="form-hint" style="padding:12px 16px">尚未应用任何自定义主题。可从下方"可用主题"中添加。</div>';

  const availableSection = availableThemes.length
    ? availableThemes.map(availableRow).join("")
    : (_themeListCache.length === 0
        ? '<div class="form-hint" style="padding:12px 16px">还没有自定义主题。点击下方按钮添加一个。</div>'
        : '<div class="form-hint" style="padding:12px 16px">所有主题都在应用中。</div>');

  const importInput = `<input type="file" id="theme-import-file" accept=".zip,.css" style="display:none" onchange="PawzoChat.themeImportSubmit(this)">`;
  const newBtnRow = sel.active
    ? ""
    : `<div class="card-row" style="cursor:pointer;color:var(--primary)" onclick="PawzoChat.pushPage('settingsThemeEdit','')">
        <div class="row-icon primary">${iconHtml("ri-add-line")}</div>
        <span class="row-label" style="color:var(--primary)">新建自定义主题</span>
      </div>`;
  const selectionHint = sel.active
    ? `<div class="form-hint" style="padding:8px 16px 12px">勾选要分享的主题，点击右上「导出 (N)」生成 PawzoChat 主题包（.zip）。1 个为单文件，多个为合集。</div>`
    : "";

  const modeCard = sel.active ? "" : `
    <div class="card">
      <div class="card-header">外观模式</div>
      ${modeRow("light", "浅色")}
      ${modeRow("dark", "深色")}
      ${modeRow("auto", "跟随系统")}
    </div>`;

  content().innerHTML = `${importInput}<div class="page">
    ${selectionHint}
    ${modeCard}

    <div class="card">
      <div class="card-header">正在应用的主题</div>
      ${activeSection}
      ${sel.active ? "" : '<div class="form-hint" style="padding:8px 16px 12px">按从上到下的顺序依次叠加，越靠下的主题越后注入，会覆盖上方主题的同名样式。点击 − 将其移出应用；点击 ↑ ↓ 调整覆盖顺序。</div>'}
    </div>

    <div class="card">
      <div class="card-header">可用主题</div>
      ${availableSection}
      ${newBtnRow}
      ${sel.active ? "" : '<div class="form-hint" style="padding:8px 16px 12px">这里展示你创建但尚未应用的主题。点击 + 即可将其加入上方"正在应用"列表；也可以在此直接编辑或删除。</div>'}
    </div>
  </div>`;
}

/* ---- Theme Import / Export ---- */

function _toastThemeImportResult(imported, errors) {
  if (errors.length > 0) {
    const msg = imported.length > 0
      ? `已导入 ${imported.length} 个主题，${errors.length} 个失败`
      : (errors[0]?.error || "导入失败");
    toast(msg, "error");
    return;
  }
  if (imported.length === 0) {
    toast("未导入任何主题", "error");
    return;
  }
  if (imported.length === 1) {
    const it = imported[0];
    toast(it.renamed ? `已导入，重命名为「${it.name}」（同名冲突）` : `已导入「${it.name}」`, "success");
    return;
  }
  const renamed = imported.filter(x => x.renamed).length;
  toast(renamed > 0
    ? `已导入 ${imported.length} 个主题（其中 ${renamed} 个因同名重命名）`
    : `已导入 ${imported.length} 个主题`, "success");
}

export function themeImportPick() {
  const input = $("theme-import-file");
  if (input) { input.value = ""; input.click(); }
}

export async function themeImportSubmit(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  showLoading("导入中…");
  try {
    const base = window.PAWZOCHAT_BASE || "";
    const resp = await fetch(`${base}/api/themes/_import`, { method: "POST", body: fd });
    const data = await resp.json().catch(() => ({}));
    if (resp.status >= 400) { toast(data?.error || "导入失败", "error"); return; }
    const imported = Array.isArray(data.imported) ? data.imported : [];
    const errors = Array.isArray(data.errors) ? data.errors : [];
    _toastThemeImportResult(imported, errors);
    invalidateCache();
    renderSettingsTheme();
  } catch (e) { toast("导入失败", "error"); }
  finally { hideLoading(); }
}

export function themeSelectionEnter() {
  _themeSelectionMode = { active: true, selected: new Set() };
  renderSettingsTheme();
}

export function themeSelectionExit() {
  _themeSelectionMode = { active: false, selected: new Set() };
  renderSettingsTheme();
}

export function themeSelectionToggle(name) {
  if (_themeSelectionMode.selected.has(name)) {
    _themeSelectionMode.selected.delete(name);
  } else {
    _themeSelectionMode.selected.add(name);
  }
  renderSettingsTheme();
}

export function themeSelectionToggleAll() {
  const all = _themeListCache.map(t => t.name);
  if (all.length > 0 && _themeSelectionMode.selected.size === all.length) {
    _themeSelectionMode.selected = new Set();
  } else {
    _themeSelectionMode.selected = new Set(all);
  }
  renderSettingsTheme();
}

export async function themeExportSelected() {
  const names = [..._themeSelectionMode.selected];
  if (names.length === 0) { toast("请先选择主题", "error"); return; }
  showLoading("导出中…");
  try {
    const params = new URLSearchParams();
    for (const n of names) params.append("name", n);
    const fallback = names.length === 1
      ? `${names[0]}_theme_pawzochat.zip`
      : "themes_pawzochat.zip";
    await downloadFile(`/api/themes/_export?${params.toString()}`, fallback);
    toast("已开始下载", "success");
    _themeSelectionMode = { active: false, selected: new Set() };
    renderSettingsTheme();
  } catch (e) {
    toast(e?.message || "导出失败", "error");
  } finally { hideLoading(); }
}

export async function onThemeModeChange(mode) {
  await _persistTheme({ mode });
}

export async function onThemeToggle(name, enabled) {
  const cur = state.settings?.theme?.active || [];
  let next;
  if (enabled) {
    next = cur.includes(name) ? cur.slice() : [...cur, name];
  } else {
    next = cur.filter(x => x !== name);
  }
  await _persistTheme({ active: next });
  renderSettingsTheme();
}

export async function onThemeMove(name, delta) {
  const cur = (state.settings?.theme?.active || []).slice();
  const idx = cur.indexOf(name);
  if (idx < 0) return;
  const target = idx + delta;
  if (target < 0 || target >= cur.length) return;
  [cur[idx], cur[target]] = [cur[target], cur[idx]];
  await _persistTheme({ active: cur });
  renderSettingsTheme();
}

export async function onThemeDelete(name) {
  const ok = await confirm(`删除自定义主题「${name}」？`, "删除后将无法恢复", true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const r = await api.del(`/api/themes/${encodeURIComponent(name)}`);
    if (r.status >= 400) { toast(r.data?.error || "删除失败", "error"); return; }
    invalidateCache(name);
    const cur = state.settings?.theme?.active || [];
    if (cur.includes(name)) {
      state.settings.theme.active = cur.filter(x => x !== name);
    }
    await applyThemeFromState();
    toast("已删除", "success");
    renderSettingsTheme();
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

async function renderSettingsThemeEdit(name) {
  const isNew = !name;
  _themeEditContext = { originalName: name || null, css: "" };
  setTopBar(isNew ? "新建主题" : "编辑主题", true,
    `<button class="btn-text" onclick="PawzoChat.saveSettingsTheme()">保存</button>`
  );
  if (isNew) {
    content().innerHTML = _renderThemeEditForm("", "");
  } else {
    content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
    try {
      const data = await api.get(`/api/themes/${encodeURIComponent(name)}`);
      _themeEditContext.css = data.css || "";
      content().innerHTML = _renderThemeEditForm(data.name || "", data.css || "");
    } catch (e) {
      toast("加载失败", "error");
      goBack();
    }
  }
}

function _renderThemeEditForm(name, css) {
  return `<div class="page">
    <div class="card">
      <div class="card-header"><label for="st-name">主题名称</label></div>
      <div class="prompt-field">
        <input type="text" class="form-input" id="st-name" maxlength="50" placeholder="例如：粉色主题" value="${esc(name)}">
      </div>
    </div>
    <div class="card">
      <div class="card-header"><label for="st-css">自定义 CSS</label></div>
      <div class="prompt-field">
        <textarea class="prompt-input theme-css-input" id="st-css" rows="18" spellcheck="false" autocapitalize="off" autocorrect="off" aria-describedby="st-css-hint" placeholder=":root { --primary: #E91E63; }">${esc(css)}</textarea>
      </div>
      <div class="form-hint" id="st-css-hint">支持任意 CSS。可通过覆盖 <code>:root</code> 中的 CSS 变量快速换色，也可以直接覆盖具体选择器。</div>
    </div>
  </div>`;
}

export async function saveSettingsTheme() {
  const name = $("st-name")?.value?.trim();
  const css = $("st-css")?.value ?? "";
  if (!name) { toast("名称不能为空", "error"); return; }
  showLoading("保存中…");
  try {
    const ctx = _themeEditContext;
    const oldName = ctx.originalName;
    if (oldName) {
      const r = await api.put(`/api/themes/${encodeURIComponent(oldName)}`, { name, css });
      if (r.status >= 400) { toast(r.data?.error || "保存失败", "error"); return; }
      invalidateCache(oldName);
      if (name !== oldName) invalidateCache(name);
    } else {
      const r = await api.post("/api/themes", { name, css });
      if (r.status >= 400) { toast(r.data?.error || "保存失败", "error"); return; }
    }
    const active = state.settings?.theme?.active || [];
    if (active.includes(oldName || name)) {
      // Rename may have been applied server-side; refresh active list
      if (oldName && name !== oldName && active.includes(oldName)) {
        state.settings.theme.active = active.map(x => x === oldName ? name : x);
      }
      await applyThemeFromState();
    }
    toast("已保存", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Register renderers ---- */

registerTabRenderer("settings", renderSettings);
registerPageRenderer("profileEdit", renderProfileEdit);
registerPageRenderer("settingsAccounts", renderSettingsAccounts);
registerPageRenderer("accountDetail", renderAccountDetail);
registerPageRenderer("settingsProviders", renderSettingsProviders);
registerPageRenderer("providerEdit", renderProviderEdit);
registerPageRenderer("settingsImageProviders", renderSettingsImageProviders);
registerPageRenderer("imageProviderEdit", renderImageProviderEdit);
registerPageRenderer("imageTest", renderImageTest);
registerPageRenderer("settingsVoiceProviders", renderSettingsVoiceProviders);
registerPageRenderer("voiceProviderEdit", renderVoiceProviderEdit);
registerPageRenderer("voiceTest", renderVoiceTest);
registerPageRenderer("settingsChat", renderSettingsChat);
registerPageRenderer("settingsReply", renderSettingsReply);
registerPageRenderer("settingsEmoji", renderSettingsEmoji);
registerPageRenderer("emojiGroup", renderEmojiGroup);
registerPageRenderer("emojiEmotion", renderEmojiEmotion);
registerPageRenderer("settingsNetwork", renderSettingsNetwork);
registerPageRenderer("settingsPassword", renderSettingsPassword);
registerPageRenderer("settingsAbout", renderSettingsAbout);
registerPageRenderer("settingsPrivacy", renderSettingsPrivacy);
registerPageRenderer("settingsStatement", renderSettingsStatement);
registerPageRenderer("settingsTheme", renderSettingsTheme);
registerPageRenderer("settingsThemeEdit", renderSettingsThemeEdit);
