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
import { esc, ILLEGAL_NAME_RE } from "./utils.js";
import { api, downloadFile } from "./api.js";
import { $, content } from "./state.js";
import { toast, confirm, showSheet, closeOverlay, showLoading, hideLoading } from "./ui.js";
import { setTopBar, goBack, pushPage, registerPageRenderer } from "./navigation.js";
import { resizePromptTextarea } from "./prompt_textarea.js";

// Edit-page state. Populated by renderWorldbookEdit, read back by saveWorldbook.
const _wb = {
  originalName: "",   // "" when creating new
  isNew: true,
  sections: [],       // [{key, value, enabled}] — enabled gates LLM injection
  boundPersonas: [],  // list of persona ids bound from this side
  personas: [],       // cached [{id, name, has_avatar, ...}] for label rendering
};

function _decodeDataValue(value) {
  try {
    return decodeURIComponent(value || "");
  } catch (e) {
    return value || "";
  }
}

function _scopeLabel(scope) {
  const rng = scope?.range === "global" ? "全局" : "选中角色";
  const kw = scope?.keyword_filter ? " · 关键词" : "";
  return rng + kw;
}

function _bindWorldbookListActions() {
  const host = $("wb-book-list");
  if (!host) return;
  host.onclick = (e) => {
    const row = e.target.closest("[data-wb-open-name]");
    if (!row || !host.contains(row)) return;
    const name = _decodeDataValue(row.dataset.wbOpenName);
    if (!name) return;
    pushPage("worldbookEdit", { name });
  };
}

function _bindBoundPersonaActions() {
  const host = $("wb-personas-bound");
  if (!host) return;
  host.onclick = (e) => {
    const btn = e.target.closest("[data-wb-remove-persona]");
    if (!btn || !host.contains(btn)) return;
    wbPersonaRemove(_decodeDataValue(btn.dataset.wbRemovePersona));
  };
}

/* ---- List page ---- */

async function renderWorldbookList() {
  const topBtns = `<button class="top-btn" title="导入" onclick="PawzoChat.wbImportPick()">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="top-btn" title="新建" onclick="PawzoChat.pushPage('worldbookEdit',{isNew:true})">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`;
  setTopBar("世界书", true, topBtns);
  content().innerHTML = `
    <input type="file" id="wb-import-file" accept=".txt,.json" style="display:none" onchange="PawzoChat.wbImportSubmit(this)">
    <div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const res = await api.get("/api/worldbooks");
    const books = res.books || [];

    if (books.length === 0) {
      content().innerHTML = `
        <input type="file" id="wb-import-file" accept=".txt,.json" style="display:none" onchange="PawzoChat.wbImportSubmit(this)">
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>
          <div class="empty-text">暂无世界书</div>
          <button onclick="PawzoChat.pushPage('worldbookEdit',{isNew:true})">新建</button>
        </div>`;
      return;
    }

    const listHtml = books.map(b => {
      const scopeText = _scopeLabel(b.scope);
      const sectionsPreview = (b.sections || []).slice(0, 3).join(" · ");
      const sub = `${b.section_count || 0} 节${sectionsPreview ? ` · ${esc(sectionsPreview)}` : ""}`;
      return `<div class="card-row" data-wb-open-name="${encodeURIComponent(b.name)}">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:500">${esc(b.name)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(scopeText)} · ${sub}</div>
        </div>
        <span class="row-arrow">›</span>
      </div>`;
    }).join("");

    content().innerHTML = `
      <input type="file" id="wb-import-file" accept=".txt,.json" style="display:none" onchange="PawzoChat.wbImportSubmit(this)">
      <div class="page">
        <div class="card" id="wb-book-list">${listHtml}</div>
      </div>`;
    _bindWorldbookListActions();
  } catch (e) { toast("加载失败", "error"); }
}

/* ---- Import ---- */

export function wbImportPick() {
  const input = $("wb-import-file");
  if (input) { input.value = ""; input.click(); }
}

/* ---- Export ---- */

export function wbExportCurrent() {
  if (_wb.isNew || !_wb.originalName) return;
  wbExportPick(_wb.originalName);
}

export function wbExportPick(name) {
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">导出「${esc(name)}」</div>
    <div class="card" style="margin:8px 0">
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat._wbExportGo('${encodeURIComponent(name)}','pawzochat')">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">PawzoChat 原生 JSON</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">保留 scope/keywords/小节结构</div>
        </div><span class="row-arrow">›</span>
      </div>
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat._wbExportGo('${encodeURIComponent(name)}','sillytavern')">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px">SillyTavern 世界书 JSON</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">转换为 entries 结构，可导入酒馆</div>
        </div><span class="row-arrow">›</span>
      </div>
    </div>
    <button class="btn-secondary btn-block" onclick="PawzoChat.closeOverlay()">取消</button>
  </div>`);
}

export async function _wbExportGo(encodedName, format) {
  closeOverlay();
  const name = _decodeDataValue(encodedName);
  showLoading("导出中…");
  try {
    await downloadFile(
      `/api/worldbooks/${encodeURIComponent(name)}/_export?format=${encodeURIComponent(format)}`,
      `${name}.json`,
    );
    toast("已开始下载", "success");
  } catch (e) {
    toast(e?.message || "导出失败", "error");
  } finally { hideLoading(); }
}

export async function wbImportSubmit(inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);

  showLoading("导入中…");
  try {
    const base = window.PAWZOCHAT_BASE || "";
    const resp = await fetch(`${base}/api/worldbooks/_import`, {
      method: "POST", body: fd,
    });
    const data = await resp.json();
    if (resp.status >= 400) { toast(data?.error || "导入失败", "error"); return; }
    const saved = data.book?.name || "";
    if (data.renamed) {
      toast(`已导入，重命名为「${saved}」（同名冲突）`, "success");
    } else {
      toast(`已导入「${saved}」`, "success");
    }
    renderWorldbookList();
  } catch (e) { toast("导入失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Edit page ---- */

async function renderWorldbookEdit(data) {
  const isNew = !!data.isNew;
  _wb.isNew = isNew;
  _wb.originalName = isNew ? "" : (data.name || "");

  const exportBtn = isNew ? "" : `<button class="btn-text" onclick="PawzoChat.wbExportCurrent()">导出</button>`;
  const saveBtn = `<button class="btn-text" onclick="PawzoChat.wbSave()">保存</button>`;
  setTopBar(isNew ? "新建世界书" : "编辑世界书", true, exportBtn + saveBtn);

  let book = { name: "", scope: { range: "selected", keyword_filter: false }, keywords: [], content: {}, bound_personas: [] };
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const [bookRes, personasRes] = await Promise.all([
      isNew ? Promise.resolve(book) : api.get(`/api/worldbooks/${encodeURIComponent(data.name)}`),
      api.get("/api/personas"),
    ]);
    book = bookRes;
    _wb.personas = personasRes.personas || [];
  } catch (e) { toast("加载失败", "error"); return; }

  const rng = book.scope?.range || "selected";
  const kwOn = !!book.scope?.keyword_filter;
  const kwText = (book.keywords || []).join(", ");

  _wb.boundPersonas = Array.isArray(book.bound_personas) ? [...book.bound_personas] : [];
  const sectionMeta = book.section_meta || {};
  _wb.sections = Object.entries(book.content || {}).map(([k, v]) => ({
    key: k,
    value: String(v),
    // Backend defaults missing/invalid meta to enabled, but check defensively
    // here too so an old export without section_meta loads as all-on.
    enabled: sectionMeta[k]?.enabled !== false,
  }));
  if (_wb.sections.length === 0) _wb.sections.push({ key: "", value: "", enabled: true });

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="card-header">基础信息</div>
      <div class="form-group"><div class="form-row">
        <label>名称</label>
        <input id="wb-name" value="${esc(book.name)}" placeholder="将作为文件名保存">
      </div></div>
      <div class="form-hint">不可使用 \\ / : * ? " &lt; &gt; |；重命名会自动更新所有角色的绑定</div>
    </div>
    <div class="card">
      <div class="card-header">作用域</div>
      <div class="form-group"><div class="form-row">
        <label>投放范围</label>
        <select id="wb-range" onchange="PawzoChat.wbOnRangeChange(this.value)">
          <option value="global" ${rng === "global" ? "selected" : ""}>全局（所有角色）</option>
          <option value="selected" ${rng === "selected" ? "selected" : ""}>选中的角色</option>
        </select>
      </div></div>
      <div class="form-group"><div class="form-row">
        <label>关键词匹配</label>
        <label class="switch-wrap"><input type="checkbox" id="wb-kw-en" ${kwOn ? "checked" : ""} onchange="PawzoChat.wbOnKwToggle(this.checked)"><span class="switch-track"></span></label>
      </div></div>
      <div id="wb-keywords-group" style="${kwOn ? "" : "display:none"}">
        <div class="form-group"><div class="form-row">
          <label>关键词</label>
          <input id="wb-keywords" value="${esc(kwText)}" placeholder="逗号或空格分隔，如：修仙,法术,炼丹">
        </div></div>
      </div>
      <div class="form-hint">若开启关键词匹配，则当用户消息命中任一关键词时才注入本书，否则始终为选定范围内的角色注入本书</div>
    </div>
    <div class="card" id="wb-personas-card" style="${rng === "selected" ? "" : "display:none"}">
      <div class="card-header-row">
        <span class="card-header" style="flex:1">绑定角色</span>
        <button class="btn-text btn-sm" onclick="PawzoChat.wbPersonaPick()">+ 选择角色</button>
      </div>
      <div id="wb-personas-bound"></div>
      <div class="form-hint">仅对此处选中的角色生效；保存时同步更新角色侧的世界书绑定</div>
    </div>
    <div class="card">
      <div class="card-header-row">
        <span class="card-header" style="flex:1">内容</span>
        <button type="button" class="btn-text btn-sm" id="wb-add-first" onclick="PawzoChat.wbAddSection('start')">+ 添加小节</button>
      </div>
      <div id="wb-sections"></div>
      <div class="wb-section-actions">
        <button type="button" class="btn-text btn-sm" id="wb-add-last" onclick="PawzoChat.wbAddSection('end')">+ 添加小节</button>
      </div>
    </div>
    ${!isNew ? `<div class="persona-actions mt-16">
      <button class="btn-text danger" onclick="PawzoChat.wbDeleteCurrent()">删除世界书</button>
    </div>` : ""}
  </div>`;

  _renderSections();
  _renderBoundPersonas();
}

function _renderBoundPersonas() {
  const host = $("wb-personas-bound");
  if (!host) return;
  const byId = new Map(_wb.personas.map(p => [p.id, p]));
  // Drop bound ids whose persona has been deleted (lazy orphan cleanup).
  _wb.boundPersonas = _wb.boundPersonas.filter(id => byId.has(id));
  if (_wb.boundPersonas.length === 0) {
    host.innerHTML = `<div class="form-hint" style="padding:8px 16px">尚未绑定任何角色</div>`;
    return;
  }
  host.innerHTML = _wb.boundPersonas.map(id => {
    const p = byId.get(id);
    const label = p?.name || id;
    const sub = [p?.llm_provider, p?.llm_model].filter(Boolean).join(" · ") || "未配置";
    return `<div class="card-row">
      <div style="flex:1;min-width:0">
        <div style="font-size:15px">${esc(label)}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(sub)}</div>
      </div>
      <button class="btn-text btn-sm danger" data-wb-remove-persona="${encodeURIComponent(id)}">移除</button>
    </div>`;
  }).join("");
  _bindBoundPersonaActions();
}

export function wbOnRangeChange(value) {
  const card = $("wb-personas-card");
  if (card) card.style.display = value === "selected" ? "" : "none";
}

export function wbOnKwToggle(checked) {
  const group = $("wb-keywords-group");
  if (group) group.style.display = checked ? "" : "none";
}

export function wbPersonaPick() {
  const bound = new Set(_wb.boundPersonas);
  if (_wb.personas.length === 0) {
    showSheet(`<div style="padding:24px">
      <div class="sheet-title">选择角色</div>
      <div class="form-hint" style="text-align:center;padding:16px 0">还没有任何角色，请先在通讯录新建。</div>
      <button class="btn-secondary btn-block" onclick="PawzoChat.closeOverlay()">关闭</button>
    </div>`);
    return;
  }
  const rowsHtml = _wb.personas.map(p => {
    const sub = [p.llm_provider, p.llm_model].filter(Boolean).join(" · ") || "未配置";
    return `<label class="card-row" style="cursor:pointer">
      <input type="checkbox" class="wb-pp-pick" value="${esc(p.id)}" ${bound.has(p.id) ? "checked" : ""} style="margin-right:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:15px">${esc(p.name)}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(sub)}</div>
      </div>
    </label>`;
  }).join("");
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">选择角色</div>
    <div class="card" style="max-height:50vh;overflow:auto;margin:8px 0">${rowsHtml}</div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.wbPersonaPickConfirm()">确定</button>
    </div>
  </div>`);
}

export function wbPersonaPickConfirm() {
  const picked = Array.from(document.querySelectorAll(".wb-pp-pick:checked")).map(el => el.value);
  _wb.boundPersonas = picked;
  closeOverlay();
  _renderBoundPersonas();
}

function wbPersonaRemove(id) {
  _wb.boundPersonas = _wb.boundPersonas.filter(x => x !== id);
  _renderBoundPersonas();
}

function _renderSections() {
  const host = $("wb-sections");
  if (!host) return;
  host.innerHTML = _wb.sections.map(_sectionHtml).join("");
}

function _sectionHtml(s, i) {
  const enabled = s.enabled !== false;
  return `
    <div class="wb-section${enabled ? "" : " wb-section-disabled"}" data-wb-section="${i}">
      <div class="wb-section-header">
        <input class="wb-sec-key" data-i="${i}" value="${esc(s.key)}" placeholder="小节名，例如：世界观" oninput="PawzoChat.wbSectionKeyChange(Number(this.dataset.i), this.value)">
        <label class="switch-wrap" title="关闭后该小节不会注入到 AI 提示词">
          <input type="checkbox" aria-label="启用小节" ${enabled ? "checked" : ""} onchange="PawzoChat.wbSectionToggle(Number(this.closest('.wb-section').dataset.wbSection), this.checked)">
          <span class="switch-track"></span>
        </label>
        <button type="button" class="btn-text btn-sm danger" onclick="PawzoChat.wbRemoveSection(Number(this.closest('.wb-section').dataset.wbSection))">删除</button>
      </div>
      <textarea class="prompt-input wb-sec-val" data-i="${i}" rows="5" placeholder="小节内容"
        oninput="PawzoChat.wbSectionValChange(Number(this.dataset.i), this.value)">${esc(s.value)}</textarea>
    </div>`;
}

function _reindexSections() {
  $("wb-sections").querySelectorAll('.wb-section').forEach((section, i) => {
    section.dataset.wbSection = i;
    section.querySelectorAll('[data-i]').forEach(input => { input.dataset.i = i; });
  });
}

export function wbAddSection(position = 'start') {
  const host = $("wb-sections");
  if (!host) return;
  const section = { key: "", value: "", enabled: true };
  const atEnd = position === 'end';
  if (atEnd) _wb.sections.push(section);
  else _wb.sections.unshift(section);
  host.insertAdjacentHTML(atEnd ? 'beforeend' : 'afterbegin', _sectionHtml(section, 0));
  _reindexSections();
  const added = atEnd ? host.lastElementChild : host.firstElementChild;
  resizePromptTextarea(added.querySelector('textarea'));
  added.scrollIntoView({ block: 'nearest' });
  added.querySelector('.wb-sec-key').focus({ preventScroll: true });
}

export async function wbRemoveSection(i) {
  const s = _wb.sections[i];
  if (!s) return;
  const hasContent = (s.key || "").trim() || (s.value || "").trim();
  if (hasContent) {
    const label = (s.key || "").trim() || "未命名小节";
    const ok = await confirm("删除小节", `确认删除「${label}」？此操作不可撤销。`, true);
    if (!ok) return;
  }
  const element = $("wb-sections").children[i];
  if (_wb.sections.length <= 1) {
    _wb.sections[0] = { key: "", value: "", enabled: true };
    element.outerHTML = _sectionHtml(_wb.sections[0], 0);
  } else {
    _wb.sections.splice(i, 1);
    element.remove();
  }
  _reindexSections();
}

export function wbSectionKeyChange(i, val) {
  if (_wb.sections[i]) _wb.sections[i].key = val;
}

export function wbSectionValChange(i, val) {
  if (_wb.sections[i]) _wb.sections[i].value = val;
}

export function wbSectionToggle(i, checked) {
  const s = _wb.sections[i];
  if (!s) return;
  s.enabled = !!checked;
  // Keep the existing editors and their measured heights. Rebuilding the list
  // temporarily collapses long prompts and moves the reader's scroll position.
  const section = $("wb-sections")?.children[i];
  if (!section) return;
  section.querySelector('input[type="checkbox"]').checked = s.enabled;
  section.classList.toggle('wb-section-disabled', !s.enabled);
}

/* ---- Save / Delete ---- */

export async function wbSave() {
  const name = $("wb-name")?.value?.trim() || "";
  if (!name) { toast("名称不能为空", "error"); return; }
  if (name.length > 100) { toast("名称过长（最多 100 个字符）", "error"); return; }
  const bad = name.match(ILLEGAL_NAME_RE);
  if (bad) { toast(`名称包含非法字符「${bad[0]}」`, "error"); return; }
  if (/[. ]$/.test(name)) { toast("名称不能以空格或句点结尾", "error"); return; }

  const range = $("wb-range")?.value === "global" ? "global" : "selected";
  const kwEn = !!$("wb-kw-en")?.checked;
  const kwRaw = $("wb-keywords")?.value || "";
  const keywords = kwRaw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);

  const contentObj = {};
  const sectionMeta = {};
  const seen = new Set();
  for (const s of _wb.sections) {
    const k = s.key.trim();
    if (!k) continue;
    if (seen.has(k)) { toast(`小节名「${k}」重复`, "error"); return; }
    seen.add(k);
    contentObj[k] = s.value;
    sectionMeta[k] = { enabled: s.enabled !== false };
  }
  if (Object.keys(contentObj).length === 0) {
    toast("至少需要一个有内容的小节", "error"); return;
  }

  const body = {
    name,
    scope: { range, keyword_filter: kwEn },
    keywords,
    content: contentObj,
    section_meta: sectionMeta,
    // Always send bound_personas so switching range=selected→global clears bindings.
    bound_personas: range === "selected" ? [..._wb.boundPersonas] : [],
  };

  showLoading("保存中…");
  try {
    let res;
    if (_wb.isNew) {
      res = await api.post("/api/worldbooks", body);
    } else {
      res = await api.put(`/api/worldbooks/${encodeURIComponent(_wb.originalName)}`, body);
    }
    if (res.status >= 400) { toast(res.data?.error || "保存失败", "error"); return; }
    toast("已保存", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function wbDeleteCurrent() {
  if (_wb.isNew || !_wb.originalName) return;
  const ok = await confirm("删除世界书", `确认删除「${_wb.originalName}」？所有角色的绑定也会被清除。`, true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const res = await api.del(`/api/worldbooks/${encodeURIComponent(_wb.originalName)}`);
    if (res.status >= 400) { toast(res.data?.error || "删除失败", "error"); return; }
    toast("已删除", "success");
    goBack();
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Binding picker (used by contacts.js on persona edit page) ---- */

/**
 * Show a picker of non-global books and return the user's selection via the
 * ``onChange`` callback. ``currentBound`` is a list of book names already
 * bound; those appear pre-checked.
 */
export async function openWorldbookPicker(currentBound, onChange) {
  let books = [];
  try {
    const res = await api.get("/api/worldbooks");
    books = (res.books || []).filter(b => (b.scope?.range || "selected") !== "global");
  } catch (e) { toast("加载失败", "error"); return; }

  const bound = new Set(currentBound || []);
  if (books.length === 0) {
    showSheet(`<div style="padding:24px">
      <div class="sheet-title">绑定世界书</div>
      <div class="form-hint" style="text-align:center;padding:16px 0">暂无可绑定的世界书。<br>全局世界书对所有角色自动生效，无需绑定。</div>
      <button class="btn-secondary btn-block" onclick="PawzoChat.closeOverlay()">关闭</button>
    </div>`);
    return;
  }

  const rowsHtml = books.map(b => `
    <label class="card-row" style="cursor:pointer">
      <input type="checkbox" class="wb-pick" value="${encodeURIComponent(b.name)}" ${bound.has(b.name) ? "checked" : ""} style="margin-right:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:15px">${esc(b.name)}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(_scopeLabel(b.scope))} · ${b.section_count || 0} 节</div>
      </div>
    </label>`).join("");

  window._wbPickerCallback = onChange;
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">绑定世界书</div>
    <div class="card" style="max-height:50vh;overflow:auto;margin:8px 0">${rowsHtml}</div>
    <div class="form-actions">
      <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
      <button class="btn-primary" onclick="PawzoChat.wbPickerConfirm()">确定</button>
    </div>
  </div>`);
}

export function wbPickerConfirm() {
  const picked = Array.from(document.querySelectorAll(".wb-pick:checked")).map(el => _decodeDataValue(el.value));
  const cb = window._wbPickerCallback;
  window._wbPickerCallback = null;
  closeOverlay();
  if (typeof cb === "function") cb(picked);
}

/**
 * Fetch the list of books split into global and selectable. Used by the
 * persona edit page to render "bound list" and "applies globally" sections.
 */
export async function fetchWorldbookSummary() {
  try {
    const base = window.PAWZOCHAT_BASE || "";
    const resp = await fetch(`${base}/api/worldbooks`);
    const res = await resp.json();
    if (resp.status >= 400) {
      return { ok: false, globals: [], selectable: [] };
    }
    const books = res.books || [];
    const globals = books.filter(b => (b.scope?.range || "selected") === "global");
    const selectable = books.filter(b => (b.scope?.range || "selected") === "selected");
    return { ok: true, globals, selectable };
  } catch (e) {
    return { ok: false, globals: [], selectable: [] };
  }
}

registerPageRenderer("worldbookList", renderWorldbookList);
registerPageRenderer("worldbookEdit", renderWorldbookEdit);
