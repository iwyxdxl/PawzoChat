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
import { esc, escAttr } from "./utils.js";
import { api } from "./api.js";
import { state, $, content } from "./state.js";
import { toast, confirm, showSheet, closeOverlay, showLoading, hideLoading } from "./ui.js";
import { setTopBar, registerPageRenderer, setPageCleanup } from "./navigation.js";

const _IMP_COLORS = ["", "#9E9E9E", "#8BC34A", "#FF9800", "#F44336", "#E91E63"];
const _IMP_LABELS = ["", "1 - 不重要", "2 - 一般", "3 - 普通", "4 - 重要", "5 - 非常重要"];
const _WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

let _memoryPage = null;
let _editingMemory = null;
let _editRequest = 0;

function _impBadge(val) {
  const v = Math.max(1, Math.min(5, val || 3));
  return `<span class="mem-imp" style="background:${_IMP_COLORS[v]}20;color:${_IMP_COLORS[v]}">${v}</span>`;
}

function _pad2(n) {
  return String(n).padStart(2, "0");
}

function _nowDatetimeLocal() {
  const now = new Date();
  return [
    now.getFullYear(),
    _pad2(now.getMonth() + 1),
    _pad2(now.getDate()),
  ].join("-") + `T${_pad2(now.getHours())}:${_pad2(now.getMinutes())}`;
}

function _readableToDatetimeLocal(createdAt) {
  const text = String(createdAt || "").trim();
  if (!text) return "";
  let m = text.match(/^(\d{4}-\d{2}-\d{2})(?:\s+\(.+?\))?\s+(\d{2}:\d{2})$/);
  if (m) return `${m[1]}T${m[2]}`;
  m = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (m) return `${m[1]}T${m[2]}`;
  return "";
}

function _datetimeLocalToReadable(value) {
  const m = String(value || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/,
  );
  if (!m) return "";
  const [, year, month, day, hour, minute] = m;
  const weekday = _WEEKDAY_LABELS[
    new Date(Number(year), Number(month) - 1, Number(day)).getDay()
  ];
  return `${year}-${month}-${day} (${weekday}) ${hour}:${minute}`;
}

function memoryEndpoint(page = _memoryPage) {
  const root = `/api/personas/${encodeURIComponent(page.personaId)}`;
  return page.mode === "group"
    ? `${root}/group-memories/${encodeURIComponent(page.groupId)}`
    : `${root}/memories`;
}

function sourceLabel(group) {
  const suffix = group.status === "deleted" ? "（已删除）" : group.status === "removed" ? "（已离群）" : "";
  return `${group.name || "群聊"}${suffix}`;
}

function renderMemoryShell(page) {
  const hasSource = page.groups.some(group => group.group_id === page.groupId);
  content().innerHTML = `<div class="page memory-page">
    <div class="memory-controls"><div class="sub-tabs" role="tablist" aria-label="记忆分区">
      <button class="sub-tab${page.mode === 'private' ? ' active' : ''}" role="tab" aria-selected="${page.mode === 'private'}" data-memory-mode="private">私聊</button>
      <button class="sub-tab${page.mode === 'group' ? ' active' : ''}" role="tab" aria-selected="${page.mode === 'group'}" data-memory-mode="group">群聊</button>
    </div>
    ${page.mode === 'group' && page.groups.length ? `<div class="card memory-group-card">
      <label class="form-row memory-group-select"><span>选择群聊</span><select id="memory-group-select">${!hasSource ? '<option value="" selected disabled>本群暂无记忆</option>' : ''}${page.groups.map(group => `<option value="${escAttr(group.group_id)}" ${group.group_id === page.groupId ? 'selected' : ''}>${esc(sourceLabel(group))}</option>`).join('')}</select></label>
      <div class="memory-group-actions" id="memory-group-actions" hidden><span id="memory-group-count"></span><button type="button" class="btn-text danger" id="memory-delete-group"></button></div>
    </div>` : ''}</div>
    <div id="memory-scope-note" class="form-hint memory-scope-note"></div>
    <div id="memory-list"><div class="loading-center"><div class="spinner"></div></div></div>
  </div>`;
  content().querySelectorAll('[data-memory-mode]').forEach(button => button.addEventListener('click', () => {
    if (_memoryPage !== page || page.mode === button.dataset.memoryMode) return;
    page.mode = button.dataset.memoryMode;
    page.data.memoryMode = page.mode;
    _editingMemory = null;
    closeOverlay();
    renderMemoryShell(page);
    loadMemoryList(page);
  }));
  $('memory-group-select')?.addEventListener('change', event => {
    page.groupId = event.target.value;
    page.data.groupId = page.groupId;
    _editingMemory = null;
    closeOverlay();
    loadMemoryList(page);
  });
  $('memory-delete-group')?.addEventListener('click', () => deleteGroupMemories(page));
}

async function renderMemoryManage(data) {
  const page = _memoryPage = {
    personaId: data.personaId, data, groups: [], groupId: data.groupId || '',
    mode: data.memoryMode || (data.groupId ? 'group' : 'private'), catalogError: '',
  };
  page.data.memoryMode = page.mode;
  _editingMemory = null;
  const request = ++_editRequest;
  setPageCleanup(() => {
    if (_memoryPage === page) { _memoryPage = null; _editingMemory = null; ++_editRequest; closeOverlay(); }
  });
  const personaName = data.personaName || state.personas.find(persona => persona.id === page.personaId)?.name;
  setTopBar(personaName ? `${personaName}的记忆` : '记忆管理', true,
    `<button class="top-btn" id="memory-add" aria-label="新增记忆" disabled onclick="PawzoChat.addMemory()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>`
  );
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const sources = await api.get(`/api/personas/${encodeURIComponent(page.personaId)}/group-memories`, { bypassCache: true });
    if (_memoryPage !== page || request !== _editRequest) return;
    if (sources.error) throw new Error(sources.error);
    page.groups = sources.groups || [];
    // An explicit group entry must never silently open a different group's memories.
    if (!page.groupId) page.groupId = page.groups[0]?.group_id || '';
    page.data.groupId = page.groupId;
  } catch (error) {
    if (_memoryPage !== page || request !== _editRequest) return;
    page.catalogError = error.message || '群聊记忆列表加载失败';
  }
  if (_memoryPage !== page || request !== _editRequest) return;
  renderMemoryShell(page);
  await loadMemoryList(page);
}

async function loadMemoryList(page = _memoryPage) {
  if (!page || _memoryPage !== page) return;
  const request = ++_editRequest;
  _editingMemory = null;
  const list = $('memory-list'), add = $('memory-add'), note = $('memory-scope-note');
  add.disabled = true;
  const source = page.groups.find(group => group.group_id === page.groupId);
  const actions = $('memory-group-actions');
  if (actions) actions.hidden = page.mode !== 'group' || !source || !!page.catalogError;
  const action = $('memory-delete-group'), count = $('memory-group-count');
  if (action) {
    action.textContent = source?.status === 'active' ? '清空记忆' : '删除本群记忆';
    action.disabled = false;
  }
  if (count) count.textContent = `${Number(source?.total) || 0} 条记忆`;
  const notes = [];
  if (page.mode === 'group') {
    if (source?.status === 'deleted') notes.push('群聊已删除，保留的记忆仍可查看和编辑。');
    else if (source?.status === 'removed') notes.push('角色已离开此群，保留的记忆仍可查看和编辑。');
    if (source?.error) notes.push(`最近一次记忆记录失败：${source.error}`);
  }
  note.textContent = notes.join(' ');
  note.hidden = !note.textContent;
  if (page.mode === 'group' && (page.catalogError || !source)) {
    list.innerHTML = `<div class="empty-state"><div class="empty-text">${esc(page.catalogError || (page.groupId ? '本群暂无记忆' : '暂无群聊记忆'))}</div>${page.catalogError ? '<button id="memory-source-retry">重新加载</button>' : ''}</div>`;
    $('memory-source-retry')?.addEventListener('click', () => renderMemoryManage(page.data));
    return;
  }
  list.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  const endpoint = memoryEndpoint(page);
  try {
    const res = await api.get(endpoint, { bypassCache: true });
    if (_memoryPage !== page || request !== _editRequest) return;
    if (res.error) throw new Error(res.error);
    const memories = res.memories || [];
    if (source && page.mode === 'group') {
      source.total = memories.length;
      if (count) count.textContent = `${memories.length} 条记忆`;
      if (action) action.disabled = source.status === 'active' && memories.length === 0;
    }
    list.innerHTML = memories.length
      ? `${page.mode === 'private' ? `<div class="mem-count">${memories.length} 条记忆</div>` : ''}${memories.map(m => `<div class="mem-card" role="button" tabindex="0" data-memory-index="${m.index}" data-memory-fingerprint="${escAttr(m.fingerprint)}"><div class="mem-header">${_impBadge(m.importance)}<span class="mem-time">${esc(_readableToDatetimeLocal(m.created_at).replace('T', ' ') || m.created_at || '')}</span></div><div class="mem-summary">${esc(m.summary)}</div></div>`).join('')}`
      : `<div class="empty-state"><div class="empty-text">暂无记忆</div><button onclick="PawzoChat.addMemory()">手动添加</button></div>`;
    list.querySelectorAll('[data-memory-index]').forEach(card => {
      const open = () => editMemory(Number(card.dataset.memoryIndex), card.dataset.memoryFingerprint);
      card.addEventListener('click', open);
      card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
    add.disabled = false;
  } catch (error) {
    if (_memoryPage !== page || request !== _editRequest) return;
    list.innerHTML = `<div class="empty-state"><div class="empty-text">${esc(error.message || '加载失败')}</div><button id="memory-retry">重新加载</button></div>`;
    $('memory-retry')?.addEventListener('click', () => loadMemoryList(page));
  }
}

async function deleteGroupMemories(page) {
  if (_memoryPage !== page || page.mode !== 'group' || page.deletingSource) return;
  const source = page.groups.find(group => group.group_id === page.groupId);
  if (!source) return;
  const personaName = page.data.personaName || state.personas.find(persona => persona.id === page.personaId)?.name || '当前角色';
  const endpoint = memoryEndpoint(page);
  const beforeConfirm = _editRequest;
  const active = source.status === 'active';
  const title = active ? '清空记忆' : '删除本群记忆';
  const desc = active
    ? `清空「${personaName}」在「${source.name || '群聊'}」中的全部记忆。此操作不可恢复。`
    : `删除「${personaName}」在「${source.name || '群聊'}」中的全部记忆。此操作不可恢复。`;
  const ok = await confirm(title, desc, true, active ? '清空' : '删除');
  if (!ok || _memoryPage !== page || beforeConfirm !== _editRequest || page.mode !== 'group'
      || page.groupId !== source.group_id || page.deletingSource) return;
  page.deletingSource = true;
  const request = ++_editRequest;
  showLoading(active ? '清空中…' : '删除中…');
  try {
    const res = await api.del(endpoint);
    if (_memoryPage !== page || request !== _editRequest) return;
    if (res.status >= 400) { toast(res.data?.error || `${active ? '清空' : '删除'}失败`, 'error'); return; }
    const sourceDeleted = res.data?.source_deleted === true;
    toast(sourceDeleted ? '已删除本群记忆' : '已清空记忆', 'success');
    page.data.groupId = sourceDeleted ? '' : source.group_id;
    page.data.memoryMode = 'group';
    await renderMemoryManage(page.data);
  } catch (error) {
    if (_memoryPage === page && request === _editRequest) toast(`${active ? '清空' : '删除'}失败，请重试`, 'error');
  } finally {
    page.deletingSource = false;
    hideLoading();
  }
}

export function addMemory() {
  if (!_memoryPage || $('memory-add')?.disabled) return;
  ++_editRequest;
  _showMemorySheet(-1, "", 3, "");
}

export async function editMemory(index, fingerprint) {
  const page = _memoryPage;
  if (!page) return;
  const endpoint = memoryEndpoint(page);
  const request = ++_editRequest;
  try {
    const res = await api.get(endpoint, { bypassCache: true });
    if (_memoryPage !== page || request !== _editRequest) return;
    if (res.error) throw new Error(res.error);
    const mem = (res.memories || []).find(m => m.index === index);
    if (!fingerprint || !mem || mem.fingerprint !== fingerprint) {
      toast("记忆已变化，请从刷新后的列表重新打开", "error");
      await loadMemoryList(page);
      return;
    }
    _showMemorySheet(index, mem.summary, mem.importance, mem.created_at, fingerprint);
  } catch (error) { if (_memoryPage === page && request === _editRequest) toast(error.message || "加载失败", "error"); }
}

function _showMemorySheet(index, summary, importance, createdAt, fingerprint = "") {
  const page = _memoryPage;
  _editingMemory = { page, endpoint: memoryEndpoint(page), index, fingerprint };
  const isNew = index < 0;
  const title = isNew ? "新增记忆" : "编辑记忆";
  const source = page.mode === 'group' ? sourceLabel(page.groups.find(group => group.group_id === page.groupId) || {}) : '私聊';
  const rawCreatedAt = String(createdAt || "");
  const pickerValue = _readableToDatetimeLocal(rawCreatedAt) || (isNew ? _nowDatetimeLocal() : "");
  const hasInvalidTime = !!rawCreatedAt && !pickerValue;
  const impOptions = [1,2,3,4,5].map(v => `<option value="${v}" ${v === importance ? "selected" : ""}>${_IMP_LABELS[v]}</option>`).join("");
  showSheet(`<div class="memory-edit-sheet">
    <div class="memory-edit-header"><div class="sheet-title">${title}</div><div class="memory-edit-source">${esc(source)}</div></div>
    <div class="mem-edit-fields">
      <textarea id="mem-edit-summary" class="mem-edit-textarea" aria-label="记忆内容" placeholder="记下值得记住的事…" rows="5">${esc(summary)}</textarea>
      <div class="mem-edit-row"><label for="mem-edit-imp">重要度</label><select id="mem-edit-imp" class="mem-edit-input">${impOptions}</select></div>
      <div class="mem-edit-row"><label for="mem-edit-time">时间</label><div class="mem-time-wrap">
        <input id="mem-edit-time" class="mem-edit-input" type="datetime-local" step="60" value="${escAttr(pickerValue)}" data-original="${escAttr(rawCreatedAt)}">
        ${hasInvalidTime ? `<div class="mem-time-note">原时间：${esc(rawCreatedAt)}。可重新选择，留空则保留原值。</div>` : ''}
      </div></div>
    </div>
    <div class="memory-edit-actions">
      ${!isNew ? `<button type="button" class="btn-text danger memory-edit-delete" onclick="PawzoChat.deleteMemoryConfirm(${index})">删除</button>` : ''}
      <button type="button" class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button><button type="button" class="btn-primary memory-edit-save" onclick="PawzoChat.saveMemory(${index})">保存</button>
    </div>
  </div>`, () => { _editingMemory = null; ++_editRequest; });
}

export async function saveMemory(index) {
  const editing = _editingMemory;
  if (!editing || editing.index !== index || editing.page !== _memoryPage) return;
  const summary = $('mem-edit-summary')?.value?.trim();
  if (!summary) { toast('记忆内容不能为空', 'error'); return; }
  const importance = parseInt($('mem-edit-imp')?.value) || 3;
  const timeInput = $('mem-edit-time');
  const createdAt = _datetimeLocalToReadable(timeInput?.value?.trim()) || timeInput?.dataset?.original || '';
  showLoading('保存中…');
  try {
    const body = { summary, importance, created_at: createdAt };
    const res = index < 0 ? await api.post(editing.endpoint, body)
      : await api.put(`${editing.endpoint}/${index}`, { ...body, fingerprint: editing.fingerprint });
    if (_editingMemory !== editing || _memoryPage !== editing.page) return;
    if (res.status >= 400) { toast(res.data?.error || '保存失败', 'error'); return; }
    closeOverlay();
    toast('已保存', 'success');
    await loadMemoryList(editing.page);
  } catch (error) { if (_editingMemory === editing) toast('保存失败', 'error'); }
  finally { hideLoading(); }
}

export async function deleteMemoryConfirm(index) {
  const editing = _editingMemory;
  if (!editing || editing.index !== index || editing.page !== _memoryPage) return;
  closeOverlay();
  const request = _editRequest;
  const ok = await confirm('删除记忆', '确认删除这条记忆？', true);
  if (!ok || editing.page !== _memoryPage || request !== _editRequest) return;
  showLoading('删除中…');
  try {
    const res = await api.del(`${editing.endpoint}/${index}?fingerprint=${encodeURIComponent(editing.fingerprint)}`);
    if (editing.page !== _memoryPage || request !== _editRequest) return;
    if (res.status >= 400) {
      toast(res.data?.error || '删除失败', 'error');
      if ([409, 400].includes(res.status)) await loadMemoryList(editing.page);
      return;
    }
    toast('已删除', 'success');
    await loadMemoryList(editing.page);
  } catch (error) { if (editing.page === _memoryPage && request === _editRequest) toast('删除失败', 'error'); }
  finally { hideLoading(); }
}

registerPageRenderer('memoryManage', renderMemoryManage);
