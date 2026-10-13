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
import { esc, escAttr, formatMsgTime, iconHtml } from "./utils.js";
import { api } from "./api.js";
import { renderQuoteBox } from "./quote.js";
import { $, content } from "./state.js";
import { toast, confirm, showLoading, hideLoading } from "./ui.js";
import { setTopBar, registerPageRenderer, setPageCleanup } from "./navigation.js";

let _personaId = null;
let _groupId = null;
let _historyGeneration = 0;

function messagesUrl() {
  return _groupId ? `/api/groups/${encodeURIComponent(_groupId)}/messages` : `/api/conversations/${encodeURIComponent(_personaId)}/messages`;
}

function historyMediaUrl(kind, filename) {
  const base = window.PAWZOCHAT_BASE || "";
  return _groupId ? `${base}/api/groups/${encodeURIComponent(_groupId)}/media/${kind}/${encodeURIComponent(filename)}`
    : `${base}/api/${kind === 'voice' ? 'audio' : kind}/${encodeURIComponent(_personaId)}/${encodeURIComponent(filename)}`;
}
let _messages = [];
let _dates = [];
let _currentDate = "";
let _latestDate = "";

let _selectMode = false;
// Map<globalIndex (number), { index, fingerprint, date }> — accumulates across dates
let _selected = new Map();

function _formatDateLabel(iso) {
  const parts = (iso || "").split("-");
  if (parts.length !== 3) return iso || "";
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (Number.isNaN(m) || Number.isNaN(d)) return iso;
  return `${m}月${d}日`;
}

function _setTopBarForMode() {
  if (!_selectMode) {
    setTopBar(
      "编辑历史消息",
      true,
      `<button class="btn-text" onclick="PawzoChat.heEnterSelectMode()">多选</button>`
    );
    return;
  }
  const n = _selected.size;
  const disabled = n === 0 ? " disabled" : "";
  const onClickAttr = n === 0 ? "" : ` onclick="PawzoChat.heBatchDeleteSelected()"`;
  setTopBar(
    `已选 ${n} 项`,
    false,
    `<button class="btn-text danger"${onClickAttr}${disabled}>删除所选</button>`,
    `<button class="btn-text" onclick="PawzoChat.heExitSelectMode()">取消</button>`
  );
}

function _renderEmptyPage(text = "暂无消息记录") {
  content().innerHTML = `<div class="page he-page" id="he-page">
    <div class="empty-state" style="padding:40px"><div class="empty-text">${esc(text)}</div></div>
  </div>`;
}

function _renderContent(blocks) {
  blocks = Array.isArray(blocks) ? blocks : [];
  const base = window.PAWZOCHAT_BASE || "";

  const emojiBlocks = blocks.filter(b => b.type === "emoji");
  if (emojiBlocks.length > 0) {
    return emojiBlocks
      .map(b => `<div class="he-media"><img src="${esc(base + b.url)}" alt="emoji" onclick="PawzoChat.openImagePreview(this.src)"></div>`)
      .join("");
  }

  let parts = "";
  for (const b of blocks) {
    if (b.type === "image") {
      let src = "";
      if (b.url) {
        src = /^https?:\/\//i.test(b.url) ? b.url : base + b.url;
      } else if (b.path) {
        const filename = b.path.split(/[\\/]/).pop();
        src = historyMediaUrl("images", filename);
      }
      if (src) {
        parts += `<div class="he-media"><img src="${esc(src)}" alt="image" loading="lazy" onclick="PawzoChat.openImagePreview(this.src)"></div>`;
      }
    } else if (b.type === "file") {
      const diskName = (b.path || "").split(/[\\/]/).pop() || "";
      const displayName = b.name || diskName || "文件";
      const href = diskName ? historyMediaUrl("files", diskName) : "#";
      parts += `<a class="msg-file" href="${esc(href)}" download="${esc(displayName)}" title="${esc(displayName)}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="msg-file-name">${esc(displayName)}</span>
        <svg class="msg-file-dl" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </a>`;
    } else if (b.type === "voice") {
      const fname = (b.path || "").split(/[\\/]/).pop() || "";
      const src = fname ? historyMediaUrl("voice", fname) : "";
      if (src) {
        const secs = Math.max(1, Math.round((b.duration_ms || 0) / 1000));
        parts += `<div class="msg-voice" data-src="${escAttr(src)}" title="${escAttr(b.text || "")}" onclick="PawzoChat.playVoiceMessage(this)">
          <svg class="msg-voice-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path class="v1" d="M8.5 9.5a4 4 0 010 5"/><path class="v2" d="M11.5 7a8 8 0 010 10"/><path class="v3" d="M14.5 4.5a12.5 12.5 0 010 15"/></svg>
          <span class="msg-voice-dur">${secs}″</span>
        </div>`;
      }
    } else if (b.type === "text" && b.text) {
      parts += `<div class="he-text">${esc(b.text)}</div>`;
    }
  }
  if (!parts) {
    const text = blocks.map(c => c.text || "").join("");
    return `<div class="he-text">${esc(text)}</div>`;
  }
  return parts;
}

function _hasText(blocks) {
  return Array.isArray(blocks) && blocks.some(b => b.type === "text");
}

function _textFromContent(blocks) {
  blocks = Array.isArray(blocks) ? blocks : [];
  return blocks
    .filter(b => b.type === "text")
    .map(b => b.text || "")
    .join("\n");
}

function _renderDateBar() {
  const bar = $("he-date-bar");
  if (!bar) return;

  if (_dates.length === 0) {
    bar.innerHTML = `<span class="he-date-empty">暂无消息记录</span>`;
    return;
  }

  const minDate = _dates[_dates.length - 1].date;
  const maxDate = _dates[0].date;
  const countObj = _dates.find(d => d.date === _currentDate);
  const countLabel = countObj ? `${countObj.count}条消息` : "无消息";

  bar.innerHTML = `<div class="he-date-row">
    <input type="date" id="he-date-input" value="${esc(_currentDate)}"
      min="${esc(minDate)}" max="${esc(maxDate)}"
      onchange="PawzoChat.heDateChange(this.value)">
    <span class="he-date-count">${countLabel}</span>
  </div>`;
}

function _updateDateCount() {
  const el = document.querySelector(".he-date-count");
  if (!el) return;
  const countObj = _dates.find(d => d.date === _currentDate);
  el.textContent = countObj ? `${countObj.count}条消息` : "无消息";
}

function _currentDateSelectedCount() {
  let n = 0;
  for (const m of _messages) {
    if (_selected.has(m.index)) n++;
  }
  return n;
}

function _selectAllClass() {
  const total = _messages.length;
  if (total === 0) return "";
  const sel = _currentDateSelectedCount();
  if (sel === 0) return "";
  if (sel === total) return "checked";
  return "indeterminate";
}

function _renderList() {
  const el = $("he-list");
  if (!el) return;

  if (_messages.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:40px">
      <div class="empty-text">当天暂无消息</div></div>`;
    return;
  }

  let header = "";
  if (_selectMode) {
    const cls = _selectAllClass();
    const sel = _currentDateSelectedCount();
    header = `<div class="he-select-all-bar" onclick="PawzoChat.heToggleSelectAllCurrentDate()">
      <span class="he-checkbox ${cls}"></span>
      <span>全选当天 (${sel}/${_messages.length})</span>
    </div>`;
  }

  const items = _messages
    .map(m => {
      const gi = m.index;
      const roleLabel = m.role === "user" ? "用户" : _groupId ? m.speaker_name || m.speaker_id || "已移除角色" : "助手";
      const roleCls = m.role === "user" ? "he-role-user" : "he-role-assistant";
      const canEdit = _hasText(m.content);
      const isSelected = _selectMode && _selected.has(gi);

      const itemCls = `he-item${_selectMode ? " select-mode" : ""}${isSelected ? " selected" : ""}`;
      const itemOnclick = _selectMode ? ` onclick="PawzoChat.heToggleSelectItem(${gi})"` : "";

      const cb = _selectMode
        ? `<span class="he-checkbox ${_selected.has(gi) ? "checked" : ""}"></span>`
        : "";

      const editAttrs = _selectMode ? `disabled` : `onclick="PawzoChat.editHistoryMsg(${gi})"`;
      const delAttrs = _selectMode ? `disabled` : `onclick="PawzoChat.deleteHistoryMsg(${gi})"`;
      const editBtn = canEdit
        ? `<button class="he-btn" ${editAttrs}>${iconHtml("ri-edit-line")}</button>`
        : "";

      return `<div class="${itemCls}" id="he-item-${gi}"${itemOnclick}>
      <div class="he-header">
        ${cb}
        <span class="he-role ${roleCls}">${esc(roleLabel)}</span>
        <span class="he-time">${formatMsgTime(m.timestamp)}</span>
        <span class="he-source">${esc(m.source || "")}</span>
        <span class="he-actions">
          ${editBtn}
          <button class="he-btn he-btn-del" ${delAttrs}>${iconHtml("ri-delete-bin-line")}</button>
        </span>
      </div>
      <div class="he-body">${_renderContent(m.content)}${renderQuoteBox(m.quote, m.quote_media || [], m.local_id, _personaId, _groupId)}</div>
    </div>`;
    })
    .join("");

  el.innerHTML = header + items;
}

function _scrollPage(toBottom) {
  const ct = content();
  if (!ct) return;
  const doScroll = () => { ct.scrollTop = toBottom ? ct.scrollHeight : 0; };
  requestAnimationFrame(doScroll);
  if (toBottom) {
    const list = $("he-list");
    if (list) {
      for (const img of list.querySelectorAll("img")) {
        if (!img.complete) {
          img.addEventListener("load", doScroll, { once: true });
        }
      }
    }
    setTimeout(doScroll, 200);
  }
}

async function _loadDates() {
  const generation = _historyGeneration;
  const res = await api.get(`${messagesUrl()}/dates`, { bypassCache: true });
  if (generation !== _historyGeneration) return;
  _dates = res.dates || [];
  _latestDate = _dates.length > 0 ? _dates[0].date : "";
}

async function _loadDateMessages(dateStr) {
  _currentDate = dateStr;
  const generation = _historyGeneration;
  const res = await api.get(`${messagesUrl()}?date=${encodeURIComponent(dateStr)}`, { bypassCache: true });
  if (generation !== _historyGeneration || dateStr !== _currentDate) return false;
  _messages = (res.messages || []).map((message, index) => ({ ...message, index: message.index ?? message._position ?? index }));
  return true;
}

async function _refreshHistoryView({ reloadDates = false, scrollToBottom = false } = {}) {
  const generation = _historyGeneration;
  if (reloadDates) {
    await _loadDates();
    if (generation !== _historyGeneration) return false;
    if (_dates.length === 0) {
      _renderEmptyPage();
      return false;
    }
    if (!_dates.some(d => d.date === _currentDate)) {
      _currentDate = _latestDate;
    }
    _renderDateBar();
  }

  if (!await _loadDateMessages(_currentDate) || generation !== _historyGeneration) return false;
  _renderList();
  _updateDateCount();
  if (scrollToBottom) _scrollPage(true);
  return true;
}

async function renderHistoryEdit(data) {
  const generation = ++_historyGeneration;
  setPageCleanup(() => { ++_historyGeneration; });
  _personaId = data.personaId;
  _groupId = data.groupId || null;
  _selectMode = false;
  _selected.clear();
  _setTopBarForMode();

  content().innerHTML = `<div class="page he-page" id="he-page">
    <div class="loading-center"><div class="spinner"></div></div>
  </div>`;

  try {
    await _loadDates();
  } catch (e) {
    if (generation === _historyGeneration) toast("加载失败", "error");
    return;
  }

  if (generation !== _historyGeneration) return;
  if (_dates.length === 0) {
    _renderEmptyPage();
    return;
  }

  _currentDate = _latestDate;

  content().innerHTML = `<div class="page he-page" id="he-page">
    <div class="he-date-bar" id="he-date-bar"></div>
    <div id="he-list"><div class="loading-center"><div class="spinner"></div></div></div>
  </div>`;

  _renderDateBar();

  try {
    await _refreshHistoryView({ scrollToBottom: true });
  } catch (e) {
    if (generation === _historyGeneration) toast("加载消息失败", "error");
    return;
  }
}

export async function heDateChange(dateStr) {
  const generation = _historyGeneration;
  const list = $("he-list");
  if (list) list.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  _currentDate = dateStr;

  try {
    await _refreshHistoryView({ scrollToBottom: true });
  } catch (e) {
    if (generation === _historyGeneration && dateStr === _currentDate) toast("加载消息失败", "error");
  }
}

export function editHistoryMsg(globalIndex) {
  if (_selectMode) return;
  const m = _messages.find(m => m.index === globalIndex);
  if (!m) return;

  const text = _textFromContent(m.content);
  const el = document.getElementById(`he-item-${globalIndex}`);
  if (!el) return;

  const bodyEl = el.querySelector(".he-body");
  if (!bodyEl) return;

  const quoteEditHtml = m.quote
    ? `<div class="he-quote-edit">
        <label class="he-quote-label">引用</label>
        <textarea class="he-textarea he-quote-textarea" id="he-quote-ta-${globalIndex}">${esc(m.quote)}</textarea>
        <button class="btn-text" onclick="PawzoChat.heClearQuoteEdit(${globalIndex})">清除引用</button>
      </div>`
    : "";

  bodyEl.innerHTML = `<textarea class="he-textarea" id="he-ta-${globalIndex}">${esc(text)}</textarea>
    ${quoteEditHtml}
    <div class="he-edit-actions">
      <button class="btn-text" onclick="PawzoChat.cancelHistoryEdit(${globalIndex})">取消</button>
      <button class="btn-text" style="color:var(--primary);font-weight:500" onclick="PawzoChat.saveHistoryMsg(${globalIndex})">保存</button>
    </div>`;

  const ta = document.getElementById(`he-ta-${globalIndex}`);
  if (ta) {
    ta.style.height = "auto";
    ta.style.height = Math.max(60, ta.scrollHeight) + "px";
    ta.focus();
  }
}

export function heClearQuoteEdit(globalIndex) {
  const qta = document.getElementById(`he-quote-ta-${globalIndex}`);
  if (qta) { qta.value = ""; qta.focus(); }
}

export async function saveHistoryMsg(globalIndex) {
  const generation = _historyGeneration;
  const ta = document.getElementById(`he-ta-${globalIndex}`);
  if (!ta) return;
  const newText = ta.value;

  const m = _messages.find(m => m.index === globalIndex);
  if (!m) return;

  // Sending quote explicitly clears its media association on the backend.
  // A body-only edit must leave the original quote metadata untouched.
  const qta = document.getElementById(`he-quote-ta-${globalIndex}`);
  const payload = { text: newText, fingerprint: m.fingerprint };
  if (qta && qta.value !== (m.quote || "")) payload.quote = qta.value;

  showLoading("保存中…");
  try {
    const res = _groupId
      ? await api.patch(`${messagesUrl()}/${encodeURIComponent(m.local_id)}`, payload)
      : await api.put(`/api/conversations/${_personaId}/messages/${globalIndex}`, payload);
    if (generation !== _historyGeneration) return;
    if (res.status === 409 || res.status === 404) {
      toast(res.data?.error || "消息已变化，请刷新后重试", "error");
      await _refreshHistoryView({ reloadDates: true });
      return;
    }
    if (res.status >= 400) {
      toast(res.data?.error || "保存失败", "error");
      return;
    }
    toast("已保存", "success");
    await _refreshHistoryView();
  } catch (e) {
    if (generation === _historyGeneration) toast("保存失败", "error");
  }
  finally { hideLoading(); }
}

export function cancelHistoryEdit() {
  _renderList();
}

export async function deleteHistoryMsg(globalIndex) {
  if (_selectMode) return;
  const generation = _historyGeneration;
  const m = _messages.find(msg => msg.index === globalIndex);
  if (!m) return;
  const url = _groupId ? `${messagesUrl()}/${encodeURIComponent(m.local_id)}?fingerprint=${encodeURIComponent(m.fingerprint || "")}` : `/api/conversations/${_personaId}/messages/${globalIndex}?fingerprint=${encodeURIComponent(m.fingerprint || "")}`;
  const ok = await confirm("删除消息", "确认删除这条消息？此操作不可撤销。", true);
  if (!ok || generation !== _historyGeneration) return;

  showLoading("删除中…");
  try {
    const res = await api.del(url);
    if (generation !== _historyGeneration) return;
    if (res.status === 409 || res.status === 404) {
      toast(res.data?.error || "消息已变化，请刷新后重试", "error");
      await _refreshHistoryView({ reloadDates: true });
      return;
    }
    if (res.status >= 400) {
      toast(res.data?.error || "删除失败", "error");
      return;
    }
    toast("已删除", "success");
    await _refreshHistoryView({ reloadDates: true });
  } catch (e) {
    if (generation === _historyGeneration) toast("删除失败", "error");
  }
  finally { hideLoading(); }
}

/* ============ Multiselect mode ============ */

export function heEnterSelectMode() {
  _selectMode = true;
  _selected.clear();
  _setTopBarForMode();
  _renderList();
}

export function heExitSelectMode() {
  _selectMode = false;
  _selected.clear();
  _setTopBarForMode();
  _renderList();
}

export function heToggleSelectItem(globalIndex) {
  if (!_selectMode) return;
  const gi = Number(globalIndex);
  if (_selected.has(gi)) {
    _selected.delete(gi);
  } else {
    const m = _messages.find(msg => msg.index === gi);
    if (!m) return;
    _selected.set(gi, {
      index: gi,
      local_id: m.local_id,
      fingerprint: m.fingerprint || "",
      date: _currentDate,
    });
  }
  _setTopBarForMode();
  _renderList();
}

export function heToggleSelectAllCurrentDate() {
  if (!_selectMode) return;
  if (_messages.length === 0) return;

  const sel = _currentDateSelectedCount();
  if (sel === _messages.length) {
    for (const m of _messages) {
      _selected.delete(m.index);
    }
  } else {
    for (const m of _messages) {
      _selected.set(m.index, {
        index: m.index,
        local_id: m.local_id,
        fingerprint: m.fingerprint || "",
        date: _currentDate,
      });
    }
  }
  _setTopBarForMode();
  _renderList();
}

function _groupSelectedByDate() {
  const map = new Map();
  for (const item of _selected.values()) {
    map.set(item.date, (map.get(item.date) || 0) + 1);
  }
  return [...map.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export async function heBatchDeleteSelected() {
  if (!_selectMode) return;
  const generation = _historyGeneration;
  const groupId = _groupId, personaId = _personaId, endpoint = messagesUrl();
  const total = _selected.size;
  if (total === 0) return;

  const groups = _groupSelectedByDate();
  const lines = groups.map(g => `• ${_formatDateLabel(g.date)} ${g.count}条`).join("\n");
  const desc = `将删除以下消息：\n${lines}\n共 ${total} 条。此操作不可撤销。`;

  const ok = await confirm("批量删除", desc, true);
  if (!ok || generation !== _historyGeneration) return;

  // Sort by index DESC so deleting one does not shift the indices of remaining items.
  const items = [..._selected.values()].sort((a, b) => b.index - a.index);

  showLoading(`删除中…(0/${total})`);
  let okCount = 0;
  let failCount = 0;
  try {
    for (let i = 0; i < items.length; i++) {
      if (generation !== _historyGeneration) return;
      const it = items[i];
      try {
        const res = await api.del(
          groupId ? `${endpoint}/${encodeURIComponent(it.local_id)}?fingerprint=${encodeURIComponent(it.fingerprint || "")}` : `/api/conversations/${personaId}/messages/${it.index}?fingerprint=${encodeURIComponent(it.fingerprint || "")}`
        );
        if (res.status >= 200 && res.status < 300) {
          okCount++;
        } else {
          failCount++;
        }
      } catch (e) {
        failCount++;
      }
      showLoading(`删除中…(${i + 1}/${total})`);
    }
  } finally {
    hideLoading();
  }

  if (generation !== _historyGeneration) return;
  _selected.clear();
  _selectMode = false;
  _setTopBarForMode();

  try {
    await _refreshHistoryView({ reloadDates: true });
  } catch (e) {
    /* best effort */
  }

  if (failCount === 0) {
    toast(`已删除 ${okCount} 条`, "success");
  } else if (okCount === 0) {
    toast(`删除失败`, "error");
  } else {
    toast(`已删除 ${okCount} 条，${failCount} 条失败（已变化或不存在）`, "error");
  }
}

registerPageRenderer("historyEdit", renderHistoryEdit);
