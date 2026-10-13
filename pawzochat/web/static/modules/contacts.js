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
import { setPromptValue } from "./prompt_textarea.js";
import { avatarHtml, personaAvatarUrl, esc, escAttr, CAP_ICONS, ILLEGAL_NAME_RE, voiceOptionsHtml, voiceCatalogFor } from "./utils.js";
import { api, downloadFile } from "./api.js";
import { state, $, content, sidebar } from "./state.js";
import { toast, confirm, showLoading, hideLoading, showSheet, closeOverlay } from "./ui.js";
import {
  setTopBar, pushPage, goBack,
  registerTabRenderer, registerPageRenderer, setPageCleanup,
  isDesktop, setSidebarBar, refreshSidebar,
} from "./navigation.js";
import { fetchWorldbookSummary, openWorldbookPicker } from "./worldbook.js";

import { initPersonaVoiceControls, refreshPersonaVoiceControls, collectPersonaVoiceSettings } from "./voice_controls.js";

const _CAM_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;

let _cropCallback = null;
let _pendingAvatarBlob = null;

// Persona-edit page state for worldbook binding. Populated in renderPersonaEdit,
// mutated by peWorldbookAdd / peWorldbookRemove, read back in savePersona.
let _peBoundWorldbooks = [];
let _peWorldbookSummary = { ok: true, globals: [], selectable: [] };
let _peMemoryGroupReads = {};
let _peMemorySources = [];
let _personaEditGeneration = 0;

function _decodeDataValue(value) {
  try {
    return decodeURIComponent(value || "");
  } catch (e) {
    return value || "";
  }
}

function _bindPeWorldbookActions() {
  const host = $("pe-worldbook-bound");
  if (!host) return;
  host.onclick = (e) => {
    const btn = e.target.closest("[data-pe-worldbook-remove]");
    if (!btn || !host.contains(btn)) return;
    peWorldbookRemove(_decodeDataValue(btn.dataset.peWorldbookRemove));
  };
}

/* ---- Contacts List (Tab) ---- */

async function renderContacts() {
  const desktop = isDesktop();
  const target = desktop ? sidebar() : content();
  const actionBtn = `<button class="top-btn" title="导入角色" onclick="PawzoChat.personaImportPick()">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="top-btn" title="新建" onclick="PawzoChat.pushPage('personaEdit',{isNew:true})">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`;

  if (desktop) setSidebarBar("通讯录", actionBtn);
  else setTopBar("通讯录", false, actionBtn);

  target.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/personas");
    state.personas = res.personas || [];
  } catch (e) { toast("加载失败", "error"); return; }

  const searchHtml = `<div class="search-bar">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input placeholder="搜索" oninput="PawzoChat.filterPersonas(this.value)">
  </div>`;

  const listHtml = state.personas.map(p => {
    const sub = [p.llm_provider, p.llm_model].filter(Boolean).join(" · ") || "未配置";
    const avUrl = personaAvatarUrl(p);
    return `<div class="card-row persona-row" onclick="PawzoChat.pushPage('personaDetail',{personaId:'${p.id}'})">
      ${avatarHtml(p.name, "", avUrl)}
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:500">${esc(p.name)}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(sub)}</div>
      </div>
      <span class="row-arrow">›</span>
    </div>`;
  }).join("");

  target.innerHTML = `<input type="file" id="persona-import-file" accept=".png,.json,.zip" style="display:none" onchange="PawzoChat.personaImportSubmit(this)">
    <div class="page" style="position:relative">${searchHtml}<div class="card" id="persona-list">${listHtml}</div>
      <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none">i'w'y'x'd'x'l</div>
    </div>`;
}

/* ---- Persona Import ---- */

export function personaImportPick() {
  // Make sure the input exists even if user navigates to detail first.
  let input = $("persona-import-file");
  if (!input) {
    input = document.createElement("input");
    input.type = "file";
    input.id = "persona-import-file";
    input.accept = ".png,.json,.zip";
    input.style.display = "none";
    input.onchange = () => personaImportSubmit(input);
    document.body.appendChild(input);
  }
  input.value = "";
  input.click();
}

export async function personaImportSubmit(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);

  showLoading("导入中…");
  try {
    const base = window.PAWZOCHAT_BASE || "";
    const resp = await fetch(`${base}/api/personas/_import`, { method: "POST", body: fd });
    const data = await resp.json();
    if (resp.status >= 400) { toast(data?.error || "导入失败", "error"); return; }

    const warnings = data.warnings || [];
    const createdBooks = data.created_worldbooks || [];
    let msg = `已导入「${data.name}」`;
    if (createdBooks.length) {
      const names = createdBooks.map(b => b.name).join("、");
      msg += `，并创建世界书：${names}`;
    }
    toast(msg, "success");
    if (warnings.length) {
      // Show non-blocking dialog listing what was skipped.
      const items = warnings.map(w => `<li style="margin:4px 0">${esc(w)}</li>`).join("");
      showSheet(`<div style="padding:24px">
        <div class="sheet-title">导入提示</div>
        <ul style="text-align:left;margin:12px 0 20px;padding-left:20px;font-size:14px;color:var(--text-2);line-height:1.6">${items}</ul>
        <button class="btn-primary" onclick="PawzoChat.closeOverlay()">知道了</button>
      </div>`);
    }
    renderContacts();
  } catch (e) { toast("导入失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Persona Export ---- */

export function personaExportPick(personaId) {
  const bookLabel = "导出时包含绑定世界书";
  const recommendedBadge = `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:10px;background:var(--primary);color:#fff;font-size:11px;font-weight:500;vertical-align:1px">推荐</span>`;
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">导出角色</div>
    <div class="form-hint" style="padding:8px 0 4px;text-align:left">选择导出格式：</div>
    <div class="card" style="margin:4px 0">
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat._personaExportGo('${personaId}','bundle')">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">PawzoChat 原生包 (.zip)${recommendedBadge}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">包含角色提示词、头像、参考图及功能配置，适用于向其他 PawzoChat 用户分享您的角色设定</div>
        </div><span class="row-arrow">›</span>
      </div>
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat._personaExportGo('${personaId}','png')">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">SillyTavern v3 PNG</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">含头像，酒馆/前端主流格式</div>
        </div><span class="row-arrow">›</span>
      </div>
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat._personaExportGo('${personaId}','json_v3')">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">SillyTavern v3 JSON</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">纯 JSON（无头像）</div>
        </div><span class="row-arrow">›</span>
      </div>
    </div>
    <div class="form-hint" style="padding:8px 0 4px;text-align:left">角色导出不含记忆条目和聊天记录，也不包含服务商配置、表情包文件或账号、群聊绑定。</div>
    <label class="card-row" style="cursor:pointer;margin:8px 0 12px">
      <input type="checkbox" id="pe-export-books" checked style="margin-right:10px">
      <div style="flex:1;min-width:0"><div style="font-size:14px">${bookLabel}</div>
      <div style="font-size:12px;color:var(--text-3);margin-top:2px">原生包独立打包；SillyTavern 格式合并为 character_book</div></div>
    </label>
    <button class="btn-secondary btn-block" onclick="PawzoChat.closeOverlay()">取消</button>
  </div>`);
}

export async function _personaExportGo(personaId, format) {
  const includeBooks = $("pe-export-books")?.checked !== false;
  if (format === "png") {
    // Defer so we can open a second sheet asking about cover image.
    closeOverlay();
    setTimeout(() => _personaExportPngPick(personaId, includeBooks), 100);
    return;
  }
  closeOverlay();
  showLoading("导出中…");
  try {
    const q = `?format=${encodeURIComponent(format)}&include_books=${includeBooks ? 1 : 0}`;
    await downloadFile(`/api/personas/${personaId}/_export${q}`, `${personaId}.bin`);
    toast("已开始下载", "success");
  } catch (e) {
    toast(e?.message || "导出失败", "error");
  } finally { hideLoading(); }
}

let _pendingExportCover = null;  // Blob | null
let _pendingExportCoverObjUrl = null;  // blob: URL to revoke
let _pendingExportOriginalAvatarUrl = "";  // snapshot of the dialog's original src

function _personaExportPngPick(personaId, includeBooks) {
  _pendingExportCover = null;
  if (_pendingExportCoverObjUrl) {
    URL.revokeObjectURL(_pendingExportCoverObjUrl);
    _pendingExportCoverObjUrl = null;
  }
  const base = window.PAWZOCHAT_BASE || "";
  const avUrl = `${base}/api/personas/${personaId}/avatar?t=${Date.now()}`;
  _pendingExportOriginalAvatarUrl = avUrl;
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">导出 v3 PNG</div>
    <div class="form-hint" style="padding:8px 0 12px;text-align:left">卡片图像将作为角色数据的容器。你可以使用当前头像，或上传一张其它图片作为这张卡的封面。</div>
    <div style="display:flex;justify-content:center;margin:8px 0 16px">
      <img id="pe-export-cover-preview" src="${avUrl}" onerror="this.style.visibility='hidden'" style="width:120px;height:120px;border-radius:16px;object-fit:cover;border:1px solid var(--border);background:var(--bg)">
    </div>
    <input type="file" id="pe-export-cover-file" accept="image/*" style="display:none" onchange="PawzoChat._personaExportCoverSelected(this)">
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="btn-outline" onclick="document.getElementById('pe-export-cover-file').click()" style="flex:1">选择其它图片</button>
      <button class="btn-outline" onclick="PawzoChat._personaExportCoverReset()" id="pe-export-cover-reset" style="flex:1;display:none">还原当前头像</button>
    </div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat._personaExportPngGo('${personaId}', ${includeBooks ? 1 : 0})">下载</button>
    </div>
  </div>`);
}

export function _personaExportCoverSelected(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) { toast("请选择图片文件", "error"); return; }
  _pendingExportCover = file;
  if (_pendingExportCoverObjUrl) {
    URL.revokeObjectURL(_pendingExportCoverObjUrl);
  }
  _pendingExportCoverObjUrl = URL.createObjectURL(file);
  const preview = $("pe-export-cover-preview");
  if (preview) {
    preview.src = _pendingExportCoverObjUrl;
    preview.style.visibility = "";
  }
  const resetBtn = $("pe-export-cover-reset");
  if (resetBtn) resetBtn.style.display = "";
}

export function _personaExportCoverReset() {
  _pendingExportCover = null;
  if (_pendingExportCoverObjUrl) {
    URL.revokeObjectURL(_pendingExportCoverObjUrl);
    _pendingExportCoverObjUrl = null;
  }
  const preview = $("pe-export-cover-preview");
  if (preview && _pendingExportOriginalAvatarUrl) {
    preview.src = _pendingExportOriginalAvatarUrl;
    preview.style.visibility = "";
  }
  const resetBtn = $("pe-export-cover-reset");
  if (resetBtn) resetBtn.style.display = "none";
  const fileInput = $("pe-export-cover-file");
  if (fileInput) fileInput.value = "";
}

export async function _personaExportPngGo(personaId, includeBooksInt) {
  closeOverlay();
  showLoading("导出中…");
  try {
    const url = `/api/personas/${personaId}/_export`;
    const fd = new FormData();
    fd.append("format", "png");
    fd.append("include_books", includeBooksInt ? "1" : "0");
    if (_pendingExportCover) fd.append("avatar", _pendingExportCover, "cover.png");

    await downloadFile(url, `${personaId}.png`, { method: "POST", body: fd });
    toast("已开始下载", "success");
  } catch (e) {
    toast(e?.message || "导出失败", "error");
  } finally {
    _pendingExportCover = null;
    if (_pendingExportCoverObjUrl) {
      URL.revokeObjectURL(_pendingExportCoverObjUrl);
      _pendingExportCoverObjUrl = null;
    }
    _pendingExportOriginalAvatarUrl = "";
    hideLoading();
  }
}

export function filterPersonas(val) {
  const items = document.querySelectorAll(".persona-row");
  const v = val.toLowerCase();
  items.forEach(el => {
    el.style.display = el.textContent.toLowerCase().includes(v) ? "" : "none";
  });
}

/* ---- Persona Detail ---- */

async function renderPersonaDetail(data) {
  const topBtns = `<button class="btn-text" onclick="PawzoChat.personaExportPick('${data.personaId}')">导出</button>
    <button class="btn-text" onclick="PawzoChat.pushPage('personaEdit',{personaId:'${data.personaId}'})">编辑</button>`;
  setTopBar("角色详情", true, topBtns);
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const [p, voiceInfo] = await Promise.all([
      api.get(`/api/personas/${data.personaId}`),
      api.get("/api/voice-providers").catch(() => ({providers: []})),
    ]);
    const voiceProvider = voiceInfo.providers?.find(pr => pr.name === p.voice_generation?.provider);
    const voiceControls = voiceProvider?.models?.find(m => m.id === p.voice_generation?.model)?.tts_controls;

    const prov = p.llm_provider || "未配置";
    const model = p.llm_model || "未选择";

    const pro = p.proactive || {};
    const proEnabled = !!pro.enabled;
    const proIntervalText = `${pro.min_idle_hours ?? 1.0}–${pro.max_idle_hours ?? 3.0} 小时`;
    const proConsecutiveText = `${pro.max_consecutive ?? 3} 条`;
    const qh = pro.quiet_hours || {};
    const proQuietText = qh.enabled !== false
      ? `${esc(qh.start || "22:00")} – ${esc(qh.end || "08:00")}`
      : "已关闭";

    const ig = p.image_generation || {};
    const igEnabled = !!ig.enabled;
    const refModeMap = { avatar: "使用角色头像", custom: "使用自定义形象图", none: "不使用参考图" };
    const refModeText = refModeMap[ig.ref_mode] || refModeMap.avatar;
    const refImgRow = ig.ref_mode === "custom"
      ? `<div class="card-row"><span class="row-label">自定义参考图</span><span class="row-value" style="${p.has_image_ref ? '' : 'font-style:italic;color:var(--text-3)'}">${p.has_image_ref ? '已上传' : '未上传'}</span></div>`
      : "";
    const trunc = (s, n) => {
      const t = (s || "").trim();
      return t.length > n ? esc(t.slice(0, n)) + "…" : esc(t || "未填写");
    };
    const truncStyle = (s, n) => (s || "").trim() ? '' : 'font-style:italic;color:var(--text-3)';

    const detailAvUrl = personaAvatarUrl(p);
    content().innerHTML = `<div class="page">
      <div class="persona-header">
        ${avatarHtml(p.name, "lg", detailAvUrl)}
        <div class="name">${esc(p.name)}</div>
      </div>
      <div class="card">
        <div class="card-row"><span class="row-label">服务商</span><span class="row-value">${esc(prov)}</span></div>
        <div class="card-row"><span class="row-label">模型</span><span class="row-value" style="${p.llm_model ? '' : 'font-style:italic;color:var(--text-3)'}">${esc(model)}</span></div>
        <div class="card-row"><span class="row-label">温度</span><span class="row-value">${p.temperature}</span></div>
        <div class="card-row"><span class="row-label">最大 Token</span><span class="row-value">${p.max_tokens}</span></div>
      </div>
      <div class="card">
        <div class="card-header">表情包</div>
        <div class="card-row"><span class="row-label">启用</span><span class="row-value">${p.emoji_enabled ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">分组</span><span class="row-value" style="${p.emoji_group ? '' : 'font-style:italic;color:var(--text-3)'}">${esc(p.emoji_group || '未选择')}</span></div>
        <div class="card-row"><span class="row-label">发送概率</span><span class="row-value">${p.emoji_send_probability}%</span></div>
      </div>
      <div class="card">
        <div class="card-header">记忆</div>
        <div class="card-row"><span class="row-label">状态</span><span class="row-value">${p.memory?.enabled !== false ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">记忆条数</span><span class="row-value">${p.memory_count || 0} 条</span></div>
        <div class="card-row" style="cursor:pointer" onclick="PawzoChat.pushPage('memoryManage',{personaId:'${p.id}'})">
          <span class="row-label">管理记忆</span><span class="row-arrow">›</span>
        </div>
      </div>
      <div class="card">
        <div class="card-header">主动消息</div>
        <div class="card-row"><span class="row-label">状态</span><span class="row-value">${proEnabled ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">触发间隔</span><span class="row-value">${proIntervalText}</span></div>
        <div class="card-row"><span class="row-label">连续上限</span><span class="row-value">${proConsecutiveText}</span></div>
        <div class="card-row"><span class="row-label">静默时段</span><span class="row-value">${proQuietText}</span></div>
      </div>
      <div class="card">
        <div class="card-header">生图选项</div>
        <div class="card-row"><span class="row-label">状态</span><span class="row-value">${igEnabled ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">服务商</span><span class="row-value" style="${truncStyle(ig.provider, 0)}">${esc(ig.provider || "未配置")}</span></div>
        <div class="card-row"><span class="row-label">模型</span><span class="row-value" style="${truncStyle(ig.model, 0)}">${esc(ig.model || "未选择")}</span></div>
        <div class="card-row"><span class="row-label">画面风格</span><span class="row-value" style="${truncStyle(ig.art_style, 0)}">${trunc(ig.art_style, 40)}</span></div>
        <div class="card-row"><span class="row-label">负面提示词</span><span class="row-value">${ig.negative_enabled !== false ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">参考图模式</span><span class="row-value">${esc(refModeText)}</span></div>
        ${refImgRow}
      </div>
      ${(() => {
        const vg = p.voice_generation || {};
        return `<div class="card">
        <div class="card-header">语音选项</div>
        <div class="card-row"><span class="row-label">状态</span><span class="row-value">${vg.enabled ? '已开启' : '已关闭'}</span></div>
        <div class="card-row"><span class="row-label">服务商</span><span class="row-value" style="${truncStyle(vg.provider, 0)}">${esc(vg.provider || "未配置")}</span></div>
        <div class="card-row"><span class="row-label">模型</span><span class="row-value" style="${truncStyle(vg.model, 0)}">${esc(vg.model || "未选择")}</span></div>
        ${voiceControls?.family === "elevenlabs" ? "" : `<div class="card-row"><span class="row-label">语速</span><span class="row-value">${voiceControls?.family === "mimo" ? esc(voiceControls.rates?.[vg.mimo?.speaking_rate || "auto"] || "自动") : `${vg.speed ?? 1.0}x`}</span></div>`}
        <div class="card-row"><span class="row-label">音色</span><span class="row-value" style="${truncStyle(vg.voice, 0)}">${esc(vg.voice || "模型默认")}</span></div>
      </div>`;
      })()}
      <div class="persona-actions">
        <button class="btn-primary" onclick="PawzoChat.chatWithPersona('${p.id}')">发消息</button>
        <button class="btn-text danger mt-8" onclick="PawzoChat.deletePersona('${p.id}')">删除</button>
      </div>
    </div>`;
  } catch (e) { toast("加载失败", "error"); }
}

export async function chatWithPersona(personaId) {
  const convRes = await api.get("/api/conversations");
  state.conversations = convRes.conversations || [];
  const exists = state.conversations.find(c => c.persona_id === personaId);
  if (!exists) {
    await api.post("/api/conversations", { persona_id: personaId });
  }

  state.currentTab = "chat";
  state.pageStack = [];
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === "chat")
  );
  refreshSidebar();
  pushPage("chatWindow", { personaId });
}

export async function deletePersona(personaId) {
  const ok = await confirm("删除角色", "私聊记录和该角色在所有群中的记忆将被删除，群聊历史保留。确认删除？", true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const res = await api.del(`/api/personas/${personaId}?delete_conversation=true`);
    if (res.status >= 400) { toast(res.data?.error || "删除失败", "error"); return; }
    toast("已删除", "success");
    goBack();
    refreshSidebar();
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Persona Edit ---- */

async function renderPersonaEdit(data) {
  const generation = ++_personaEditGeneration;
  setPageCleanup(() => {
    if (generation !== _personaEditGeneration) return;
    ++_personaEditGeneration;
    if (document.querySelector('.memory-source-sheet')) closeOverlay();
  });
  const isNew = data.isNew;
  setTopBar(isNew ? "新建角色" : "编辑角色", true,
    `<button class="btn-text" onclick="PawzoChat.savePersona(${isNew})">保存</button>`
  );
  if (data.memoryDraft) {
    const draft = data.memoryDraft;
    delete data.memoryDraft;
    content().replaceChildren(draft.fragment);
    _pendingAvatarBlob = draft.avatar;
    _peBoundWorldbooks = draft.worldbooks;
    _peMemoryGroupReads = draft.groupReads;
    _peMemorySources = draft.memorySources;
    content().scrollTop = draft.scroll;
    refreshPersonaMemorySources(data.personaId);
    return;
  }
  _pendingAvatarBlob = null;

  let providers = [];
  let emojiGroups = [];
  let imageProviders = [];
  let voiceProviders = [];
  let voicePresetVoices = {};
  let voiceDefaults = {};
  try {
    const [provRes, emojiRes, imgRes, voiceRes] = await Promise.all([
      api.get("/api/providers"),
      api.get("/api/emoji/groups"),
      api.get("/api/image-providers"),
      api.get("/api/voice-providers"),
    ]);
    providers = provRes.providers || [];
    emojiGroups = emojiRes.groups || [];
    imageProviders = (imgRes.providers || []).filter(pr => pr.api_key_set && (pr.models || []).length > 0);
    voiceProviders = (voiceRes.providers || []).filter(pr => pr.api_key_set && (pr.models || []).length > 0);
    voicePresetVoices = voiceRes.preset_voices || {};
    voiceDefaults = voiceRes.voice_defaults || {};
  } catch (e) { /* silent */ }
  if (generation !== _personaEditGeneration) return;

  // Defaults for a brand-new persona. Keep proactive defaults in sync with
  // pawzochat/transport/models.py:PROACTIVE_DEFAULTS (the Python side is the
  // source of truth; duplicated here only so the new-persona form can render
  // before any API call).
  let p = { id: "", name: "", llm_provider: "", llm_model: "", temperature: 1.0, max_tokens: 2000,
            character_prompt: "", output_examples: "", system_instructions: "",
            emoji_enabled: false, emoji_send_probability: 25, emoji_group: "", has_avatar: false,
            memory: { enabled: true, max_memories: 50, include_in_prompt: true, trigger_rounds: 10, trigger_mode: "remind" }, memory_count: 0,
            proactive: {
              enabled: false, min_idle_hours: 1.0, max_idle_hours: 3.0, max_consecutive: 3,
              prompt: "用户已经一段时间没有回复了。请根据角色设定与近期对话，主动发起一条贴合角色的简短消息。",
              quiet_hours: { enabled: true, start: "22:00", end: "08:00" },
            },
            image_generation: { enabled: false, provider: "", model: "", style_prefix: "",
              art_style: "anime style, masterpiece, best quality",
              negative_prompt: "low quality, blurry, watermark, text, signature, lowres, bad anatomy, extra fingers, jpeg artifacts",
              negative_enabled: true,
              ref_mode: "avatar", custom_ref_filename: "" },
            has_image_ref: false,
            voice_generation: { enabled: false, provider: "", model: "", voice: "", speed: 1.0 },
            bound_worldbooks: [],
            wechat_chat_type: "" };
  if (!isNew && data.personaId) {
    try {
      p = await api.get(`/api/personas/${data.personaId}`);
    } catch (e) { /* silent */ }
  }
  if (generation !== _personaEditGeneration) return;

  const worldbookSummary = await fetchWorldbookSummary();
  if (generation !== _personaEditGeneration) return;

  _peBoundWorldbooks = Array.isArray(p.bound_worldbooks) ? [...p.bound_worldbooks] : [];
  _peMemoryGroupReads = { ...(p.memory?.group_reads || {}) };
  _peMemorySources = [];
  _peWorldbookSummary = worldbookSummary;
  const worldbookReady = _peWorldbookSummary.ok !== false;

  const provOptions = providers.map(pr => `<option value="${esc(pr.name)}" ${pr.name === p.llm_provider ? "selected" : ""}>${esc(pr.name)}</option>`).join("");
  const groupOptions = emojiGroups.map(g => `<option value="${esc(g.name)}" ${g.name === p.emoji_group ? "selected" : ""}>${esc(g.name)} (${g.total_images})</option>`).join("");

  function buildModelOptions(provName) {
    const prov = providers.find(pr => pr.name === provName);
    const models = prov?.models || [];
    const hasSelection = models.some(m => m.id === p.llm_model);
    let opts = `<option value="" disabled ${hasSelection ? "" : "selected"}>选择模型</option>`;
    for (const m of models) {
      const caps = (m.capabilities || []).map(c => CAP_ICONS[c] || "").join("");
      const sel = m.id === p.llm_model ? "selected" : "";
      opts += `<option value="${esc(m.id)}" ${sel}>${esc(m.name || m.id)} ${caps}</option>`;
    }
    return opts;
  }

  window._peProviders = providers;
  window._peBuildModelOptions = buildModelOptions;
  window._peCapIcons = CAP_ICONS;

  function buildImgProviderOptions(selectedName) {
    let opts = `<option value="">选择服务商</option>`;
    const selectedExists = imageProviders.some(ip => ip.name === selectedName);
    if (selectedName && !selectedExists) {
      opts += `<option value="${esc(selectedName)}" selected disabled>${esc(selectedName)}（不可用）</option>`;
    }
    for (const ip of imageProviders) {
      const sel = ip.name === selectedName ? "selected" : "";
      opts += `<option value="${esc(ip.name)}" ${sel}>${esc(ip.name)}</option>`;
    }
    return opts;
  }
  function buildImgModelOptions(provName, selectedId) {
    const prov = imageProviders.find(ip => ip.name === provName);
    const models = prov?.models || [];
    if (!models.length && selectedId) {
      return `<option value="${esc(selectedId)}" selected disabled>${esc(selectedId)}（不可用）</option>`;
    }
    if (!models.length) return `<option value="" disabled selected>该服务商下没有模型</option>`;
    let opts = `<option value="">选择模型</option>`;
    const selectedExists = models.some(m => m.id === selectedId);
    if (selectedId && !selectedExists) {
      opts += `<option value="${esc(selectedId)}" selected disabled>${esc(selectedId)}（不可用）</option>`;
    }
    for (const m of models) {
      const sel = m.id === selectedId ? "selected" : "";
      opts += `<option value="${esc(m.id)}" ${sel}>${esc(m.name || m.id)}</option>`;
    }
    return opts;
  }
  window._peBuildImgModelOptions = buildImgModelOptions;

  function buildVoiceProviderOptions(selectedName) {
    let opts = `<option value="">选择服务商</option>`;
    const selectedExists = voiceProviders.some(vp => vp.name === selectedName);
    if (selectedName && !selectedExists) {
      opts += `<option value="${esc(selectedName)}" selected disabled>${esc(selectedName)}（不可用）</option>`;
    }
    for (const vp of voiceProviders) {
      const sel = vp.name === selectedName ? "selected" : "";
      opts += `<option value="${esc(vp.name)}" ${sel}>${esc(vp.name)}</option>`;
    }
    return opts;
  }
  function buildVoiceModelOptions(provName, selectedId) {
    const prov = voiceProviders.find(vp => vp.name === provName);
    const models = prov?.models || [];
    if (!models.length && selectedId) {
      return `<option value="${esc(selectedId)}" selected disabled>${esc(selectedId)}（不可用）</option>`;
    }
    if (!models.length) return `<option value="" disabled selected>该服务商下没有模型</option>`;
    let opts = `<option value="">选择模型</option>`;
    const selectedExists = models.some(m => m.id === selectedId);
    if (selectedId && !selectedExists) {
      opts += `<option value="${esc(selectedId)}" selected disabled>${esc(selectedId)}（不可用）</option>`;
    }
    for (const m of models) {
      const sel = m.id === selectedId ? "selected" : "";
      opts += `<option value="${esc(m.id)}" ${sel}>${esc(m.name || m.id)}</option>`;
    }
    return opts;
  }
  window._peVoiceProviders = voiceProviders;
  window._peVoicePresetVoices = voicePresetVoices;
  window._peBuildVoiceModelOptions = buildVoiceModelOptions;

  const initialModelOpts = p.llm_provider ? buildModelOptions(p.llm_provider) : `<option value="" disabled selected>先选择服务商</option>`;

  const editAvUrl = personaAvatarUrl(p);

  content().innerHTML = `<div class="page">
    <input type="hidden" id="pe-id" value="${esc(p.id)}">
    <input type="file" id="pe-avatar-input" accept="image/*" style="display:none" onchange="PawzoChat.onAvatarFileSelected(this)">
    <div class="card">
      <div class="card-header">基础信息</div>
      <div class="form-group" style="display:flex;justify-content:center;padding:12px 0 4px">
        <div class="avatar-upload-wrap" onclick="document.getElementById('pe-avatar-input').click()">
          ${avatarHtml(p.name, "lg", editAvUrl)}
          <div class="avatar-cam">${_CAM_SVG}</div>
        </div>
      </div>
      <div class="form-group"><div class="form-row"><label>角色名称</label><input id="pe-name" value="${esc(p.name)}" placeholder="输入角色名称"></div></div>
    </div>
    <div class="sub-tabs" role="tablist">
      <button type="button" class="sub-tab active" data-petab="detail" onclick="PawzoChat.switchPersonaEditTab('detail')">角色详情</button>
      <button type="button" class="sub-tab" data-petab="persona" onclick="PawzoChat.switchPersonaEditTab('persona')">角色人设</button>
      <button type="button" class="sub-tab" data-petab="image" onclick="PawzoChat.switchPersonaEditTab('image')">生图选项</button>
      <button type="button" class="sub-tab" data-petab="voice" onclick="PawzoChat.switchPersonaEditTab('voice')">语音选项</button>
    </div>
    <div id="pe-panel-detail">
    <div class="card">
      <div class="card-header">模型配置</div>
      <div class="form-group"><div class="form-row"><label>服务商</label><select id="pe-provider" onchange="PawzoChat.onPersonaProviderChange()"><option value="">选择服务商</option>${provOptions}</select></div></div>
      <div class="form-group"><div class="form-row"><label>模型</label><select id="pe-model">${initialModelOpts}</select></div></div>
      <div class="form-group">
        <div class="form-row"><label>温度</label>
          <div class="slider-wrap"><input type="range" id="pe-temp" min="0" max="2" step="0.1" value="${p.temperature}" oninput="this.nextElementSibling.textContent=this.value"><span class="slider-val">${p.temperature}</span></div>
        </div>
      </div>
      <div class="form-group"><div class="form-row"><label>最大 Token</label><input type="number" id="pe-tokens" value="${p.max_tokens}" min="100" max="100000"></div></div>
    </div>
    <div class="card">
      <div class="card-header">表情包</div>
      <div class="form-group"><div class="form-row"><label>启用表情包</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-emoji-en" ${p.emoji_enabled ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>表情包分组</label><select id="pe-emoji-group"><option value="">未选择</option>${groupOptions}</select></div></div>
      <div class="form-group"><div class="form-row"><label>发送概率</label>
        <div class="slider-wrap"><input type="range" id="pe-emoji-prob" min="0" max="100" step="1" value="${p.emoji_send_probability}" oninput="this.nextElementSibling.textContent=this.value+'%'"><span class="slider-val">${p.emoji_send_probability}%</span></div>
      </div></div>
      <div class="form-hint">每次回复后按概率自动发送该分组中匹配情绪的表情包</div>
    </div>
    <div class="card">
      <div class="card-header">记忆设置</div>
      <div class="form-group"><div class="form-row"><label>启用记忆</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-mem-en" ${p.memory?.enabled !== false ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-hint">开启后按所选触发方式记录私聊记忆。群聊是否记录由群设置中该角色的开关决定；群聊沿用这里的记忆条数、触发方式和轮数。</div>
      <div class="form-group"><div class="form-row"><label>最大记忆条数</label>
        <div class="stepper"><button onclick="PawzoChat.step('pe-mem-max',-1)">−</button><span class="stepper-val" id="pe-mem-max">${p.memory?.max_memories || 50}</span><button onclick="PawzoChat.step('pe-mem-max',1)">+</button></div>
      </div></div>
      <div class="form-group"><div class="form-row"><label>读取记忆</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-mem-inc" ${p.memory?.include_in_prompt !== false ? "checked" : ""}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-hint">控制私聊读取自己的私聊记忆，以及下方选中的群记忆。关闭不影响角色在群聊中读取本群记忆；群内读取私聊记忆仍遵循此开关。</div>
      ${!isNew && p.id ? `<button type="button" class="card-row memory-source-entry" id="pe-memory-sources"><span class="row-label">读取的群聊记忆</span><span class="row-value" id="pe-memory-sources-summary">选择群聊</span><span class="row-arrow">›</span></button><div class="form-hint" id="pe-memory-read-hint" hidden>当前私聊不读取记忆，已选群聊会在开启后生效。</div>` : ''}
      <div class="form-group"><div class="form-row"><label>触发方式</label>
        <select id="pe-mem-trigger-mode" onchange="PawzoChat.onPeMemTriggerModeChange()">
          <option value="remind" ${!["summarize", "summarize_only"].includes(p.memory?.trigger_mode) ? "selected" : ""}>AI 自主记录＋定期提醒（默认）</option>
          <option value="summarize" ${p.memory?.trigger_mode === "summarize" ? "selected" : ""}>AI 自主记录＋按轮数总结</option>
          <option value="summarize_only" ${p.memory?.trigger_mode === "summarize_only" ? "selected" : ""}>仅按轮数总结</option>
        </select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>触发轮数</label>
        <div class="stepper"><button onclick="PawzoChat.step('pe-mem-trigger',-1,0)">−</button><span class="stepper-val" id="pe-mem-trigger">${p.memory?.trigger_rounds || 0}</span><button onclick="PawzoChat.step('pe-mem-trigger',1,0)">+</button></div>
      </div></div>
      <div class="form-hint" id="pe-mem-trigger-hint">${_memoryTriggerHint(p.memory?.trigger_mode)}</div>
      ${!isNew && p.id ? `<div style="padding:8px 16px 12px">
        <button class="btn-outline" id="pe-manage-memory" style="width:100%">管理记忆</button>
      </div>` : ''}
    </div>
    ${(() => {
      const pro = p.proactive || {};
      const qh = pro.quiet_hours || {};
      const ch = p.linked_channel || "";
      const isGroup = p.wechat_chat_type === "group";
      const proDisabled = isGroup;
      const dis = proDisabled ? "disabled" : "";
      const cardStyle = proDisabled ? 'style="opacity:0.55"' : '';
      const disabledHint = isGroup
        ? '<div class="form-hint" style="color:var(--danger,#d33)">openclaw 不支持群聊主动消息，已禁用</div>'
        : '';
      const limitNote = ch === "wechat" ? `<div class="form-hint" style="background:var(--primary-light);color:var(--text-2);padding:10px 12px;margin:0 16px 4px;border-radius:8px;line-height:1.6">
        <div style="color:var(--primary);font-weight:500;margin-bottom:2px">微信通道限制</div>
        · 只能在用户最近一次消息 <b>24 小时内</b> 回复，超时后该角色的主动消息会被跳过<br>
        · 用户每次发消息后，微信最多接受机器人 <b>10 条</b> 连续回复；配额用完后主动消息会自动跳过，等用户再次发言后恢复
      </div>` : (ch === "qq"
        ? '<div class="form-hint">受 QQ 平台频控和接收设置影响，暂不可发送时会自动暂停。</div>'
        : '');
      return `<div class="card" ${cardStyle}>
      <div class="card-header">主动消息</div>
      ${disabledHint}
      ${limitNote}
      <div class="form-group"><div class="form-row"><label>启用</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-pro-en" ${pro.enabled ? "checked" : ""} ${dis}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>最小间隔（小时）</label>
        <input type="number" id="pe-pro-min" value="${pro.min_idle_hours ?? 1.0}" min="0" step="0.1" ${dis}>
      </div></div>
      <div class="form-group"><div class="form-row"><label>最大间隔（小时）</label>
        <input type="number" id="pe-pro-max" value="${pro.max_idle_hours ?? 3.0}" min="0" step="0.1" ${dis}>
      </div></div>
      <div class="form-hint">用户最近一次回复后，等待 [最小,最大] 区间内的随机时长再触发</div>
      <div class="form-group"><div class="form-row"><label>连续上限</label>
        <div class="stepper"><button onclick="PawzoChat.step('pe-pro-max-consec',-1)" ${dis}>−</button><span class="stepper-val" id="pe-pro-max-consec">${pro.max_consecutive ?? 3}</span><button onclick="PawzoChat.step('pe-pro-max-consec',1)" ${dis}>+</button></div>
      </div></div>
      <div class="form-hint">用户回消息前最多连续触发的主动消息条数</div>
      <div class="form-group"><div class="form-row"><label>静默时段</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-pro-qh-en" ${qh.enabled !== false ? "checked" : ""} ${dis}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>开始时间</label>
        <input type="time" id="pe-pro-qh-start" value="${esc(qh.start || "22:00")}" ${dis}>
      </div></div>
      <div class="form-group"><div class="form-row"><label>结束时间</label>
        <input type="time" id="pe-pro-qh-end" value="${esc(qh.end || "08:00")}" ${dis}>
      </div></div>
      <div class="form-hint">静默时段内不会触发主动消息（支持跨午夜）</div>
      <div class="prompt-field"><label class="prompt-label" for="pe-pro-prompt">自定义提示词</label>
        <textarea class="prompt-input" id="pe-pro-prompt" rows="3" placeholder="留空使用默认" ${dis}>${esc(pro.prompt || "")}</textarea>
      </div>
    </div>`;
    })()}
    </div>
    <div id="pe-panel-image" hidden>
    ${(() => {
      const ig = p.image_generation || {};
      const noProviders = imageProviders.length === 0;
      const canDisableUnavailable = noProviders && ig.enabled;
      const fieldDisabled = noProviders ? "disabled" : "";
      const checkboxDisabled = noProviders && !canDisableUnavailable ? "disabled" : "";
      const provOpts = buildImgProviderOptions(ig.provider || "");
      const modelOpts = ig.provider ? buildImgModelOptions(ig.provider, ig.model || "") : `<option value="" disabled selected>先选择服务商</option>`;
      const refMode = ig.ref_mode || "avatar";
      const refUrl = (!isNew && p.id && p.has_image_ref)
        ? `${window.PAWZOCHAT_BASE || ""}/api/personas/${p.id}/image_ref?t=${Date.now()}`
        : "";
      const customDisp = refMode === "custom" ? "" : "display:none";
      const newDisabled = isNew ? "disabled" : "";
      return `
    <div class="form-hint" style="background:var(--primary-light);color:var(--text-2);padding:10px 12px;margin:8px 16px 12px;border-radius:8px;line-height:1.6">
      开启后该角色可以在合适的对话场景下（如"拍个照"、"看看你在干嘛"）自主调用 AI 生图，并以图片消息回复。
    </div>
    ${noProviders ? '<div class="form-hint" style="color:var(--danger,#d33);padding:0 16px 8px">尚未配置可用的生图服务商。请先到「设置 → 生图服务商」中添加；已启用的角色仍可在这里关闭生图。</div>' : ''}

    <div class="card">
      <div class="card-header">服务商配置</div>
      <div class="form-group"><div class="form-row"><label>启用 AI 生图</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-img-en" ${ig.enabled ? "checked" : ""} ${checkboxDisabled}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group"><div class="form-row"><label>服务商</label>
        <select id="pe-img-provider" onchange="PawzoChat.onPersonaImageProviderChange()" ${fieldDisabled}>${provOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>模型</label>
        <select id="pe-img-model" ${fieldDisabled}>${modelOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>参考图模式</label>
        <select id="pe-img-ref-mode" onchange="PawzoChat.onPeImgRefModeChange()" ${fieldDisabled}>
          <option value="avatar" ${refMode === "avatar" ? "selected" : ""}>使用角色头像（默认）</option>
          <option value="custom" ${refMode === "custom" ? "selected" : ""}>使用自定义形象图</option>
          <option value="none" ${refMode === "none" ? "selected" : ""}>不使用参考图</option>
        </select>
      </div></div>
      <div class="form-hint">参考图会传给支持的图模型（NanoBanana、NovelAI 等），帮助保持人物外观一致；OpenAI /images/generations 不支持，会自动忽略。</div>
    </div>

    <div class="card" id="pe-img-ref-custom-block" style="${customDisp}">
      <div class="card-header">自定义参考图</div>
      <input type="file" id="pe-img-ref-input" accept="image/*" style="display:none" onchange="PawzoChat.onPeImgRefFileSelected(this)">
      <div class="form-group" style="display:flex;justify-content:center;padding:8px 0">
        <img id="pe-img-ref-preview" src="${refUrl}" alt=""
             style="max-width:160px;max-height:160px;border-radius:8px;background:var(--primary-light);${refUrl ? "" : "display:none"}">
        <div id="pe-img-ref-empty" style="${refUrl ? "display:none" : ""};padding:16px 24px;color:var(--text-3);background:var(--primary-light);border-radius:8px;font-size:13px">尚未上传</div>
      </div>
      <div class="form-group" style="display:flex;gap:8px;padding:0 16px 12px;border-top:none">
        <button class="btn-outline" style="flex:1" ${newDisabled} onclick="document.getElementById('pe-img-ref-input').click()">上传 / 替换</button>
        <button class="btn-outline" style="flex:1" ${newDisabled} onclick="PawzoChat.deletePersonaRefImage()">删除</button>
      </div>
      ${isNew ? '<div class="form-hint" style="color:var(--danger,#d33)">请先保存角色后再上传自定义参考图</div>' : ''}
    </div>

    <div class="card">
      <div class="card-header">画面风格</div>
      <div class="prompt-field">
        <textarea class="prompt-input" id="pe-img-art-style" rows="2" placeholder="例：anime style, masterpiece, best quality" ${fieldDisabled}>${esc(ig.art_style ?? "")}</textarea>
      </div>
      <div class="form-hint">描述画风（动漫/写实/油画…），会拼到每次生图 prompt 最前。</div>
    </div>

    <div class="card">
      <div class="card-header">角色形象提示</div>
      <div class="prompt-field">
        <textarea class="prompt-input" id="pe-img-style" rows="3" placeholder="例：1girl, silver hair, blue eyes, school uniform" ${fieldDisabled}>${esc(ig.style_prefix || "")}</textarea>
      </div>
      <div class="form-hint">描述角色固定形象（发色/服饰/外貌特征），跟在画面风格之后，用于保持角色一致。</div>
    </div>

    <div class="card">
      <div class="card-header-row">
        <span class="card-header" style="flex:1;padding:0">负面提示词</span>
        <label class="switch-wrap"><input type="checkbox" id="pe-img-neg-en" ${ig.negative_enabled !== false ? "checked" : ""} ${fieldDisabled}><span class="switch-track"></span></label>
      </div>
      <div class="prompt-field">
        <textarea class="prompt-input" id="pe-img-neg" rows="3" placeholder="不希望出现的内容" ${fieldDisabled}>${esc(ig.negative_prompt ?? "")}</textarea>
      </div>
      <div class="form-hint">关闭开关后将不发送负面提示词，避免不支持的服务商被干扰。</div>
    </div>`;
    })()}
    </div>
    <div id="pe-panel-voice" hidden>
    ${(() => {
      const vg = p.voice_generation || {};
      const noProviders = voiceProviders.length === 0;
      const canDisableUnavailable = noProviders && vg.enabled;
      const fieldDisabled = noProviders ? "disabled" : "";
      const checkboxDisabled = noProviders && !canDisableUnavailable ? "disabled" : "";
      const provOpts = buildVoiceProviderOptions(vg.provider || "");
      const modelOpts = vg.provider ? buildVoiceModelOptions(vg.provider, vg.model || "") : `<option value="" disabled selected>先选择服务商</option>`;
      const currentProv = voiceProviders.find(vp => vp.name === vg.provider);
      const currentModel = (currentProv?.models || []).find(m => m.id === vg.model);
      const voiceOpts = voiceOptionsHtml(
        voiceCatalogFor(voicePresetVoices, currentModel, currentProv?.models),
      );
      return `
    ${noProviders ? '<div class="form-hint" style="color:var(--danger,#d33);padding:0 16px 8px">尚未配置可用的语音服务商。请先到「设置 → 语音服务商」中添加；已启用的角色仍可在这里关闭语音。</div>' : ''}

    <div class="card">
      <div class="card-header">服务商配置</div>
      <div class="form-group"><div class="form-row"><label>启用语音消息</label>
        <label class="switch-wrap"><input type="checkbox" id="pe-voice-en" ${vg.enabled ? "checked" : ""} ${checkboxDisabled}><span class="switch-track"></span></label>
      </div></div>
      <div class="form-group" id="pe-voice-trigger-controls">
        <div class="form-group"><div class="form-row"><label for="pe-voice-trigger-mode">触发方式</label>
          <select id="pe-voice-trigger-mode" ${fieldDisabled}>
            <option value="ai" ${vg.trigger_mode !== "probability" ? "selected" : ""}>AI 自主决定（推荐）</option>
            <option value="probability" ${vg.trigger_mode === "probability" ? "selected" : ""}>按概率触发</option>
          </select>
        </div></div>
        <div class="form-group" id="pe-voice-probability-fields" ${vg.trigger_mode === "probability" ? "" : "hidden"}>
          <div class="form-row"><label for="pe-voice-trigger-probability">触发概率</label>
            <div class="slider-wrap"><input type="range" id="pe-voice-trigger-probability" min="0" max="100" step="1" value="${vg.trigger_probability ?? 50}" data-suffix="%" ${fieldDisabled}><span class="slider-val">${vg.trigger_probability ?? 50}%</span></div>
          </div>
        </div>
      </div>
      <div class="form-group"><div class="form-row"><label>服务商</label>
        <select id="pe-voice-provider" onchange="PawzoChat.onPersonaVoiceProviderChange()" ${fieldDisabled}>${provOpts}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>模型</label>
        <select id="pe-voice-model" onchange="PawzoChat.onPersonaVoiceModelChange()" ${fieldDisabled}>${modelOpts}</select>
      </div></div>
      <div class="prompt-field voice-field"><label class="prompt-label" for="pe-voice-voice">音色 (voice ID)</label>
        <input class="form-input" id="pe-voice-voice" list="pe-voice-list" value="${esc(vg.voice || "")}" placeholder="留空则使用模型默认音色" spellcheck="false" autocomplete="off" ${fieldDisabled}>
        <datalist id="pe-voice-list">${voiceOpts}</datalist>
        <div id="pe-account-voices" hidden></div>
      </div>
      <div class="form-hint">音色 ID 可自由输入；预设列表随所选模型的音色体系变化。试听请前往「设置 → 语音服务商 → 语音测试」。</div>
      <div id="pe-voice-controls"></div>
    </div>`;
    })()}
    </div>
    <div id="pe-panel-persona" hidden>
    <div class="card">
      <div class="card-header-row"><span class="card-header" style="flex:1">世界书</span><button class="btn-text btn-sm" onclick="PawzoChat.peWorldbookAdd()" ${worldbookReady ? "" : 'disabled style="opacity:.5;cursor:not-allowed" title="世界书列表加载失败"'}>+ 绑定世界书</button></div>
      ${worldbookReady ? "" : `<div class="form-hint" style="padding:0 16px 8px;color:var(--danger,#d33)">世界书列表加载失败，当前仅保留已有绑定；保存角色时不会清空它们。</div>`}
      <div id="pe-worldbook-bound"></div>
      <div class="card-header" style="margin-top:8px;font-size:13px;color:var(--text-3)">全局生效（所有角色）</div>
      <div id="pe-worldbook-globals"></div>
    </div>
    <div class="card">
      <div class="card-header">人设设定</div>
      <div class="prompt-field"><textarea class="prompt-input prompt-part" id="pe-character" placeholder="描述角色的背景、性格、经历…">${esc(p.character_prompt)}</textarea></div>
    </div>
    <div class="card">
      <div class="card-header">输出示例</div>
      <div class="prompt-field"><textarea class="prompt-input prompt-part" id="pe-examples" placeholder="输入角色的经典台词作为风格参考…">${esc(p.output_examples)}</textarea></div>
      <div class="form-hint">用于风格参考和输出格式对齐 建议填写以\\分割的多个示例 如：你好\\我是小明\\很高兴认识你</div>
    </div>
    <div class="card">
      <div class="card-header-row"><span class="card-header" style="flex:1">系统提示词</span><button class="btn-text btn-sm" onclick="PawzoChat.resetSystemInstructions()">恢复默认</button></div>
      <div class="prompt-field"><textarea class="prompt-input prompt-part" id="pe-system" placeholder="输入系统级指令…">${esc(p.system_instructions)}</textarea></div>
    </div>
    </div>
  </div>`;

  initPersonaVoiceControls(p.voice_generation, voiceProviders, voiceDefaults);
  _renderPeWorldbook();
  $('pe-memory-sources')?.addEventListener('click', () => openPersonaMemorySources(p.id));
  $('pe-mem-inc')?.addEventListener('change', updatePersonaMemorySourceSummary);
  updatePersonaMemorySourceSummary();
  refreshPersonaMemorySources(p.id);
  $('pe-manage-memory')?.addEventListener('click', () => {
    const fragment = document.createDocumentFragment();
    const scroll = content().scrollTop;
    while (content().firstChild) fragment.appendChild(content().firstChild);
    data.memoryDraft = { fragment, scroll, avatar: _pendingAvatarBlob,
      worldbooks: [..._peBoundWorldbooks], groupReads: { ..._peMemoryGroupReads }, memorySources: _peMemorySources };
    pushPage('memoryManage', { personaId: p.id, personaName: p.name });
  });

  if (isNew) {
    api.get("/api/personas/default-system-instructions").then(res => {
      if (generation !== _personaEditGeneration) return;
      const ta = $("pe-system");
      if (ta && !ta.value) setPromptValue(ta, res.text || "");
    }).catch(() => {});
  }
}

function refreshPersonaMemorySources(personaId) {
  const entry = $('pe-memory-sources');
  const generation = _personaEditGeneration;
  if (!entry) return;
  api.get(`/api/personas/${encodeURIComponent(personaId)}/group-memories`, { bypassCache: true }).then(response => {
    if (generation !== _personaEditGeneration || !entry.isConnected || $('pe-memory-sources') !== entry || response.error) return;
    _peMemorySources = response.groups || [];
    updatePersonaMemorySourceSummary();
  }).catch(() => {});
}

function updatePersonaMemorySourceSummary() {
  const summary = $('pe-memory-sources-summary');
  const count = _peMemorySources.filter(group => Object.hasOwn(_peMemoryGroupReads, group.group_id)
    ? _peMemoryGroupReads[group.group_id] : group.include_in_private !== false).length;
  if (summary) summary.textContent = `已开启 ${count}/${_peMemorySources.length}`;
  const hint = $('pe-memory-read-hint');
  if (hint) hint.hidden = $('pe-mem-inc')?.checked !== false;
}

async function openPersonaMemorySources(personaId) {
  const host = $('pe-memory-sources');
  const generation = _personaEditGeneration;
  if (!host) return;
  host.disabled = true;
  try {
    const response = await api.get(`/api/personas/${encodeURIComponent(personaId)}/group-memories`, { bypassCache: true });
    if (generation !== _personaEditGeneration || !host.isConnected) return;
    if (response.error) throw new Error(response.error);
    const groups = response.groups || [];
    _peMemorySources = groups;
    updatePersonaMemorySourceSummary();
    showSheet(`<div class="memory-source-sheet">
      <div class="sheet-title">私聊读取群记忆</div>
      <p class="form-hint memory-source-intro">选择可在私聊中回忆的群聊经历。</p>
      <div class="card memory-source-list">${groups.map(group => {
        const status = group.status === 'deleted' ? ' · 已删除' : group.status === 'removed' ? ' · 已离群' : '';
        const included = Object.hasOwn(_peMemoryGroupReads, group.group_id) ? _peMemoryGroupReads[group.group_id] : group.include_in_private !== false;
        return `<label class="card-row memory-source-row"><span class="memory-source-name"><span>${esc(group.name || '群聊')}</span><small>${Number(group.total) || 0} 条记忆${status}</small></span><span class="switch-wrap"><input type="checkbox" data-memory-source="${escAttr(group.group_id)}" ${included ? 'checked' : ''} aria-label="读取${escAttr(group.name || '群聊')}的记忆"><span class="switch-track"></span></span></label>`;
      }).join('') || '<div class="empty-state"><div class="empty-text">暂无群聊记忆</div></div>'}</div>
      <p class="form-hint memory-source-footnote">更改随角色设置一起保存。${$('pe-mem-inc')?.checked === false || $('pe-mem-en')?.checked === false ? '当前私聊未启用读取，选择会保留。' : ''}</p>
      <button type="button" class="sheet-cancel" onclick="PawzoChat.closeOverlay()">完成</button>
    </div>`);
    document.querySelectorAll('[data-memory-source]').forEach(input => input.addEventListener('change', () => {
      _peMemoryGroupReads[input.dataset.memorySource] = input.checked;
      updatePersonaMemorySourceSummary();
    }));
  } catch (error) { if (generation === _personaEditGeneration && host.isConnected) toast(error.message || '群聊记忆加载失败', 'error'); }
  finally { host.disabled = false; }
}

function _renderPeWorldbook() {
  const boundHost = $("pe-worldbook-bound");
  const globalsHost = $("pe-worldbook-globals");
  if (!boundHost || !globalsHost) return;
  const summaryOk = _peWorldbookSummary.ok !== false;

  const selectableByName = new Map(
    (_peWorldbookSummary.selectable || []).map(b => [b.name, b])
  );

  // Drop bound names whose book has been deleted (lazy orphan cleanup in UI).
  if (summaryOk) {
    _peBoundWorldbooks = _peBoundWorldbooks.filter(n => selectableByName.has(n));
  }

  if (_peBoundWorldbooks.length === 0) {
    boundHost.innerHTML = `<div class="form-hint" style="padding:8px 16px">尚未绑定任何世界书</div>`;
  } else {
    boundHost.innerHTML = _peBoundWorldbooks.map(name => {
      const b = selectableByName.get(name);
      const sub = b
        ? `${b.section_count || 0} 节${b.scope?.keyword_filter ? " · 关键词过滤" : ""}`
        : (summaryOk ? "已删除或暂不可用" : "列表加载失败，保留原绑定");
      return `<div class="card-row">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">${esc(name)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(sub)}</div>
        </div>
        <button class="btn-text btn-sm danger" data-pe-worldbook-remove="${encodeURIComponent(name)}">移除</button>
      </div>`;
    }).join("");
    _bindPeWorldbookActions();
  }

  const globals = _peWorldbookSummary.globals || [];
  if (!summaryOk) {
    globalsHost.innerHTML = `<div class="form-hint" style="padding:8px 16px">世界书列表加载失败</div>`;
  } else if (globals.length === 0) {
    globalsHost.innerHTML = `<div class="form-hint" style="padding:8px 16px">暂无全局世界书</div>`;
  } else {
    globalsHost.innerHTML = globals.map(b => {
      const sub = `${b.section_count || 0} 节${b.scope?.keyword_filter ? " · 关键词过滤" : ""}`;
      return `<div class="card-row">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px">${esc(b.name)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(sub)}</div>
        </div>
      </div>`;
    }).join("");
  }
}

export function peWorldbookAdd() {
  if (_peWorldbookSummary.ok === false) {
    toast("世界书列表加载失败，请稍后重试", "error");
    return;
  }
  openWorldbookPicker(_peBoundWorldbooks, (picked) => {
    _peBoundWorldbooks = Array.isArray(picked) ? [...picked] : [];
    _renderPeWorldbook();
  });
}

function peWorldbookRemove(name) {
  _peBoundWorldbooks = _peBoundWorldbooks.filter(n => n !== name);
  _renderPeWorldbook();
}

export function onPersonaProviderChange() {
  const provName = $("pe-provider")?.value || "";
  const modelSel = $("pe-model");
  if (!modelSel) return;
  if (!provName) {
    modelSel.innerHTML = `<option value="" disabled selected>先选择服务商</option>`;
    return;
  }
  modelSel.innerHTML = window._peBuildModelOptions(provName);
}

export function onPersonaImageProviderChange() {
  const provName = $("pe-img-provider")?.value || "";
  const modelSel = $("pe-img-model");
  if (!modelSel) return;
  if (!provName) {
    modelSel.innerHTML = `<option value="" disabled selected>先选择服务商</option>`;
    return;
  }
  modelSel.innerHTML = window._peBuildImgModelOptions(provName, "");
}

function _refreshPeVoiceDatalist() {
  const provName = $("pe-voice-provider")?.value || "";
  const modelId = $("pe-voice-model")?.value || "";
  const prov = (window._peVoiceProviders || []).find(vp => vp.name === provName);
  const model = (prov?.models || []).find(m => m.id === modelId);
  const voices = voiceCatalogFor(window._peVoicePresetVoices, model, prov?.models);
  const list = $("pe-voice-list");
  if (list) {
    list.innerHTML = voiceOptionsHtml(voices);
  }
}

export function onPersonaVoiceProviderChange() {
  const provName = $("pe-voice-provider")?.value || "";
  const modelSel = $("pe-voice-model");
  if (!modelSel) return;
  if (!provName) {
    modelSel.innerHTML = `<option value="" disabled selected>先选择服务商</option>`;
  } else {
    modelSel.innerHTML = window._peBuildVoiceModelOptions(provName, "");
  }
  _refreshPeVoiceDatalist();
  refreshPersonaVoiceControls();
}

export function onPersonaVoiceModelChange() {
  _refreshPeVoiceDatalist();
  refreshPersonaVoiceControls();
}

export function switchPersonaEditTab(name) {
  document.querySelectorAll(".sub-tab").forEach(el =>
    el.classList.toggle("active", el.dataset.petab === name)
  );
  const panels = {
    detail: document.getElementById("pe-panel-detail"),
    persona: document.getElementById("pe-panel-persona"),
    image: document.getElementById("pe-panel-image"),
    voice: document.getElementById("pe-panel-voice"),
  };
  for (const [key, el] of Object.entries(panels)) {
    if (el) el.hidden = key !== name;
  }
  if (name === "persona") {
    const area = content();
    const ta = $("pe-character");
    if (area && ta && !ta.style.minHeight) {
      ta.style.minHeight = Math.round(area.clientHeight * 0.7) + "px";
    }
  }
}

export async function savePersona(isNew) {
  const generation = _personaEditGeneration;
  const avatar = _pendingAvatarBlob;
  const name = $("pe-name").value.trim();
  if (!name) { toast("角色名称不能为空", "error"); return; }
  if (name.length > 100) { toast("角色名称过长（最多 100 个字符）", "error"); return; }
  const bad = name.match(ILLEGAL_NAME_RE);
  if (bad) { toast(`名称包含非法字符「${bad[0]}」，不可使用 \\ / : * ? " < > |`, "error"); return; }
  if (/[. ]$/.test(name)) { toast("名称不能以空格或句点结尾", "error"); return; }

  const body = {
    name,
    llm_provider: $("pe-provider").value,
    llm_model: $("pe-model").value,
    temperature: parseFloat($("pe-temp").value),
    max_tokens: parseInt($("pe-tokens").value) || 2000,
    character_prompt: $("pe-character").value,
    output_examples: $("pe-examples").value,
    system_instructions: $("pe-system").value,
    emoji_enabled: $("pe-emoji-en").checked,
    emoji_send_probability: parseInt($("pe-emoji-prob").value),
    emoji_group: $("pe-emoji-group").value,
    memory: {
      enabled: $("pe-mem-en").checked,
      max_memories: parseInt($("pe-mem-max").textContent) || 50,
      include_in_prompt: $("pe-mem-inc").checked,
      trigger_rounds: parseInt($("pe-mem-trigger").textContent) || 0,
      trigger_mode: $("pe-mem-trigger-mode")?.value || "remind",
      group_reads: { ..._peMemoryGroupReads },
    },
    bound_worldbooks: [..._peBoundWorldbooks],
  };

  if ($("pe-pro-en")) {
    body.proactive = {
      enabled: $("pe-pro-en").checked,
      min_idle_hours: parseFloat($("pe-pro-min").value) || 0,
      max_idle_hours: parseFloat($("pe-pro-max").value) || 0,
      max_consecutive: parseInt($("pe-pro-max-consec").textContent) || 3,
      prompt: $("pe-pro-prompt").value,
      quiet_hours: {
        enabled: $("pe-pro-qh-en").checked,
        start: $("pe-pro-qh-start").value || "22:00",
        end: $("pe-pro-qh-end").value || "08:00",
      },
    };
  }

  if ($("pe-img-en")) {
    body.image_generation = {
      enabled: $("pe-img-en").checked,
      provider: $("pe-img-provider")?.value || "",
      model: $("pe-img-model")?.value || "",
      style_prefix: $("pe-img-style")?.value || "",
      art_style: $("pe-img-art-style")?.value ?? "",
      negative_prompt: $("pe-img-neg")?.value ?? "",
      negative_enabled: $("pe-img-neg-en")?.checked ?? true,
      ref_mode: $("pe-img-ref-mode")?.value || "avatar",
    };
  }

  if ($("pe-voice-en")) {
    body.voice_generation = collectPersonaVoiceSettings();
  }

  showLoading("保存中…");
  try {
    let res;
    if (isNew) {
      res = await api.post("/api/personas", body);
      if (res.status >= 400) { toast(res.data.error, "error"); return; }
      if (avatar && res.data.id) {
        const fd = new FormData();
        fd.append("avatar", avatar, "avatar.png");
        const base = window.PAWZOCHAT_BASE || "";
        await fetch(`${base}/api/personas/${res.data.id}/avatar`, { method: "POST", body: fd });
        if (generation === _personaEditGeneration) _pendingAvatarBlob = null;
      }
    } else {
      const pid = $("pe-id").value.trim();
      res = await api.put(`/api/personas/${pid}`, body);
      if (res.status >= 400) { toast(res.data.error, "error"); return; }
    }
    toast("已保存", "success");
    if (generation === _personaEditGeneration) goBack();
    refreshSidebar();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function resetSystemInstructions() {
  try {
    const res = await api.get("/api/personas/default-system-instructions");
    const ta = $("pe-system");
    setPromptValue(ta, res.text || "");
    toast("已恢复默认", "success");
  } catch (e) { toast("获取默认值失败", "error"); }
}

/* ---- Avatar Crop Modal (generic, callback-based) ---- */

export function openCropModal(imgUrl, onCropped) {
  _cropCallback = onCropped;

  const modal = document.createElement("div");
  modal.className = "crop-modal";
  modal.id = "crop-modal";
  modal.innerHTML = `
    <div class="crop-viewport" id="crop-vp">
      <img id="crop-img" src="${imgUrl}">
      <div class="crop-frame"></div>
    </div>
    <div class="crop-bar">
      <button class="crop-cancel" onclick="PawzoChat.closeCropModal()">取消</button>
      <button class="crop-ok" onclick="PawzoChat.confirmCrop()">确定</button>
    </div>`;
  document.body.appendChild(modal);

  const img = document.getElementById("crop-img");
  const vp = document.getElementById("crop-vp");
  let scale = 1, imgX = 0, imgY = 0, dragging = false, lastX = 0, lastY = 0;

  img.onload = () => {
    const vpSize = vp.clientWidth;
    const minDim = Math.min(img.naturalWidth, img.naturalHeight);
    scale = vpSize / minDim;
    imgX = (vpSize - img.naturalWidth * scale) / 2;
    imgY = (vpSize - img.naturalHeight * scale) / 2;
    _applyCropTransform(img, imgX, imgY, scale);
    URL.revokeObjectURL(imgUrl);
  };

  const onDown = (e) => {
    dragging = true;
    const pt = e.touches ? e.touches[0] : e;
    lastX = pt.clientX; lastY = pt.clientY;
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    imgX += pt.clientX - lastX;
    imgY += pt.clientY - lastY;
    lastX = pt.clientX; lastY = pt.clientY;
    _applyCropTransform(img, imgX, imgY, scale);
  };
  const onUp = () => { dragging = false; };
  const onWheel = (e) => {
    e.preventDefault();
    const vpRect = vp.getBoundingClientRect();
    const cx = e.clientX - vpRect.left;
    const cy = e.clientY - vpRect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(10, scale * delta));
    imgX = cx - (cx - imgX) * (newScale / scale);
    imgY = cy - (cy - imgY) * (newScale / scale);
    scale = newScale;
    _applyCropTransform(img, imgX, imgY, scale);
  };

  vp.addEventListener("mousedown", onDown);
  vp.addEventListener("touchstart", onDown, { passive: false });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchend", onUp);
  vp.addEventListener("wheel", onWheel, { passive: false });

  modal._cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchend", onUp);
  };
  modal._cropState = () => ({ img, scale, imgX, imgY, vpSize: vp.clientWidth });
}

function _applyCropTransform(img, x, y, s) {
  img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  img.style.transformOrigin = "0 0";
}

export function closeCropModal() {
  _cropCallback = null;
  const modal = document.getElementById("crop-modal");
  if (!modal) return;
  if (modal._cleanup) modal._cleanup();
  modal.remove();
}

export function confirmCrop() {
  const modal = document.getElementById("crop-modal");
  if (!modal || !modal._cropState) return;
  const { img, scale, imgX, imgY, vpSize } = modal._cropState();

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");

  const sx = -imgX / scale;
  const sy = -imgY / scale;
  const sSize = vpSize / scale;
  ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, 256, 256);

  const cb = _cropCallback;
  canvas.toBlob((blob) => {
    if (!blob) { toast("裁剪失败", "error"); return; }
    closeCropModal();
    if (cb) cb(blob);
  }, "image/png");
}

export function onAvatarFileSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (!file.type.startsWith("image/")) { toast("请选择图片文件", "error"); return; }
  input.value = "";

  const pid = $("pe-id")?.value?.trim() || "";
  const url = URL.createObjectURL(file);
  openCropModal(url, async (blob) => {
    if (!pid) {
      _pendingAvatarBlob = blob;
      const avDiv = content().querySelector(".avatar-upload-wrap .avatar");
      if (avDiv) {
        avDiv.style.background = "";
        avDiv.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="avatar">`;
      }
      return;
    }
    const fd = new FormData();
    fd.append("avatar", blob, "avatar.png");
    const base = window.PAWZOCHAT_BASE || "";
    try {
      const resp = await fetch(`${base}/api/personas/${pid}/avatar`, { method: "POST", body: fd });
      const res = await resp.json();
      if (resp.status >= 400) { toast(res.error || "上传失败", "error"); return; }
      toast("头像已更新", "success");
      const avDiv = content().querySelector(".avatar-upload-wrap .avatar");
      if (avDiv) {
        avDiv.style.background = "";
        avDiv.innerHTML = `<img src="${base}/api/personas/${pid}/avatar?t=${Date.now()}" alt="avatar">`;
      }
    } catch (e) { toast("上传失败", "error"); }
  });
}

/* ---- Image-generation reference-image controls ---- */

export function onPeImgRefModeChange() {
  const sel = $("pe-img-ref-mode");
  const block = $("pe-img-ref-custom-block");
  if (!sel || !block) return;
  block.style.display = sel.value === "custom" ? "" : "none";
}

/* ---- Memory trigger-mode controls ---- */

function _memoryTriggerHint(mode) {
  if (mode === "summarize_only") {
    return "每累计 N 轮未总结的对话，系统自动总结为一条记忆。AI 不会自主新增或更新记忆。设为 0 关闭聊天记忆的自动写入。朋友圈记忆写入和超限合并仍按各自规则执行";
  }
  if (mode === "summarize") {
    return "AI 可自主新增或更新记忆；每累计 N 轮未总结的对话，系统自动总结为一条记忆。AI 新增或更新记忆后重新计数。设为 0 仅关闭自动总结，仍允许 AI 自主记录";
  }
  return "AI 自主决定何时新增或更新记忆。连续 N 轮未记录或更新时提醒一次，提醒后重新计数；是否记录由 AI 决定。设为 0 仅关闭提醒，仍允许 AI 自主记录";
}

export function onPeMemTriggerModeChange() {
  const sel = $("pe-mem-trigger-mode");
  const hint = $("pe-mem-trigger-hint");
  if (!sel || !hint) return;
  hint.textContent = _memoryTriggerHint(sel.value);
}

export async function onPeImgRefFileSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (!file.type.startsWith("image/")) { toast("请选择图片文件", "error"); return; }
  input.value = "";

  const pid = $("pe-id")?.value?.trim() || "";
  if (!pid) { toast("请先保存角色后再上传参考图", "error"); return; }

  const fd = new FormData();
  fd.append("image", file, file.name || "ref.png");
  const base = window.PAWZOCHAT_BASE || "";
  showLoading("上传中…");
  try {
    const resp = await fetch(`${base}/api/personas/${pid}/image_ref`, { method: "POST", body: fd });
    const res = await resp.json();
    if (resp.status >= 400) { toast(res.error || "上传失败", "error"); return; }
    toast("参考图已更新", "success");
    const img = $("pe-img-ref-preview");
    const empty = $("pe-img-ref-empty");
    if (img) {
      img.src = `${base}/api/personas/${pid}/image_ref?t=${Date.now()}`;
      img.style.display = "";
    }
    if (empty) empty.style.display = "none";
  } catch (e) { toast("上传失败", "error"); }
  finally { hideLoading(); }
}

export async function deletePersonaRefImage() {
  const pid = $("pe-id")?.value?.trim() || "";
  if (!pid) return;
  const ok = await confirm("删除参考图", "确认删除该角色的自定义参考图？", true);
  if (!ok) return;
  const base = window.PAWZOCHAT_BASE || "";
  try {
    const resp = await fetch(`${base}/api/personas/${pid}/image_ref`, { method: "DELETE" });
    const res = await resp.json();
    if (resp.status >= 400) { toast(res.error || "删除失败", "error"); return; }
    toast("已删除", "success");
    const img = $("pe-img-ref-preview");
    const empty = $("pe-img-ref-empty");
    if (img) { img.src = ""; img.style.display = "none"; }
    if (empty) empty.style.display = "";
  } catch (e) { toast("删除失败", "error"); }
}

/* ---- Register renderers ---- */

registerTabRenderer("contacts", renderContacts);
registerPageRenderer("personaDetail", renderPersonaDetail);
registerPageRenderer("personaEdit", renderPersonaEdit);
