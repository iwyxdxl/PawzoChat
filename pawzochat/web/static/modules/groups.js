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

import { resizePromptTextarea, setPromptValue } from "./prompt_textarea.js";
import { api } from './api.js';
import { state, $, content } from './state.js';
import { avatarHtml, personaAvatarUrl, iconHtml, esc, escAttr } from './utils.js';
import { toast, closeOverlay } from './ui.js';
import { pushPage, setTopBar, registerPageRenderer, setPageCleanup, refreshSidebar } from './navigation.js';

const SEARCH_ICON_HTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

let editorGeneration = 0;
let createDialog = null;
let settingsEditor = null;

export function groupAvatarHtml(group) {
  const label = escAttr(`${group.name || '群聊'}的头像`);
  if (group.has_avatar) {
    const base = window.PAWZOCHAT_BASE || '';
    const url = `${base}/api/groups/${encodeURIComponent(group.group_id)}/avatar?v=${encodeURIComponent(group.avatar_version || '')}`;
    return `<div class="group-avatar group-avatar-custom" role="img" aria-label="${label}"><img src="${escAttr(url)}" alt=""></div>`;
  }
  const members = group.members || [];
  if (!members.length) return `<div class="group-avatar" role="img" aria-label="${label}"><span aria-hidden="true">群</span></div>`;
  const columns = Math.ceil(Math.sqrt(members.length));
  const rows = Math.ceil(members.length / columns);
  // Fit every member circle inside the outer circle, with a small edge inset.
  const diagonal = Math.hypot(columns - 1, rows - 1);
  const memberSize = (.94 - .025 * diagonal / columns) / (1 + diagonal);
  const avatars = members.map(member => {
    const persona = state.personas.find(p => p.id === member.persona_id);
    return avatarHtml(persona?.name || member.persona_id, 'sm', personaAvatarUrl(persona));
  });
  const markup = [];
  for (let i = 0; i < avatars.length; i += columns) markup.push(`<div class="group-avatar-row">${avatars.slice(i, i + columns).join('')}</div>`);
  return `<div class="group-avatar" role="img" aria-label="${label}" style="--group-member-scale:${memberSize};--group-member-gap:${.025 / columns}"><div class="group-avatar-mosaic" aria-hidden="true">${markup.join('')}</div></div>`;
}

function memberDetail(persona) {
  const model = [persona.llm_provider, persona.llm_model].filter(Boolean).join(' · ');
  const duplicate = state.personas.some(other => other.id !== persona.id && other.name === persona.name);
  return [model || '未配置模型', duplicate ? persona.id : ''].filter(Boolean).join(' · ');
}

export function openGroupSettings(groupId = null) {
  if (!groupId) return openCreateGroupDialog();
  dismissCreateDialog(createDialog, false);
  closeOverlay();
  pushPage('groupSettings', { groupId });
}

function createDialogIsCurrent(dialog) {
  return createDialog === dialog && dialog.element.isConnected
    && state.currentTab === dialog.originTab
    && state.pageStack[state.pageStack.length - 1] === dialog.originPage;
}

function dismissCreateDialog(dialog, restoreFocus = true) {
  if (!dialog) return;
  if (createDialog === dialog) createDialog = null;
  dialog.loadVersion++;
  if (dialog.element.open) dialog.element.close();
  dialog.element.remove();
  if (restoreFocus && dialog.opener?.isConnected && dialog.opener.getClientRects().length) {
    dialog.opener.focus({ preventScroll: true });
  }
}

function suggestedGroupName(dialog) {
  const names = [...dialog.selected].map(id => dialog.personas.find(persona => persona.id === id)?.name || id);
  return Array.from(names.join('、')).slice(0, 60).join('');
}

function selectedMemberLabel(dialog, persona, id) {
  const name = persona?.name || id;
  return dialog.personas.some(other => other.id !== id && other.name === name) ? `${name} · ${id}` : name;
}

function probabilitySlider(personaId, name, value, creating = false, disabled = false) {
  return `<span class="moments-pp-prob group-probability"><input type="range" class="moments-pp-prob-input" min="0" max="100" step="1" data-${creating ? 'create' : 'group'}-probability="${escAttr(personaId)}" aria-label="${escAttr(name)}的回复概率" aria-valuetext="${escAttr(value)}%" value="${escAttr(value)}" ${disabled ? 'disabled' : ''}><span class="slider-val" aria-hidden="true">${esc(value)}%</span></span>`;
}

function updateProbabilityDisplay(input) {
  const text = `${input.value}%`;
  input.nextElementSibling.textContent = text;
  input.setAttribute('aria-valuetext', text);
}

function renderCreateSettingsSummary(dialog) {
  const maximum = dialog.element.querySelector('#group-create-max-replies').value;
  const probabilities = [...dialog.selected].map(id => Number(dialog.probabilities.get(id) ?? 50));
  const uniform = !probabilities.length || probabilities.every(value => value === probabilities[0]);
  dialog.element.querySelector('#group-create-settings-summary').textContent =
    `${uniform ? `${probabilities[0] ?? 50}%` : '分别设置'} · 上限 ${maximum || '—'} 次`;
}

function renderCreateMemberList(dialog) {
  const query = dialog.element.querySelector('#group-create-search').value.trim().toLocaleLowerCase();
  const matches = dialog.personas.filter(persona =>
    [persona.name, persona.id, persona.llm_provider, persona.llm_model].join(' ').toLocaleLowerCase().includes(query));
  dialog.element.querySelector('#group-create-members').innerHTML = matches.length
    ? matches.map(persona => `<label class="gc-member-row">
        <input type="checkbox" aria-label="选择${escAttr(persona.name)}" data-create-member="${escAttr(persona.id)}" ${dialog.selected.has(persona.id) ? 'checked' : ''} ${dialog.saving ? 'disabled' : ''}>
        ${avatarHtml(persona.name, 'sm', personaAvatarUrl(persona))}
        <span class="gc-member-info"><strong>${esc(persona.name)}</strong><small>${esc(memberDetail(persona))}</small></span>
      </label>`).join('')
    : `<div class="gc-empty">${dialog.personas.length ? '没有找到匹配的角色' : '通讯录中还没有角色，请先创建角色。'}</div>`;
}

function renderCreateSelection(dialog) {
  const host = dialog.element;
  const count = dialog.selected.size;
  host.querySelector('#group-create-count').textContent = `已选 ${count} 位角色`;
  host.querySelector('.gc-footer-hint').textContent = count >= 2 ? `已选 ${count} 位` : '至少选 2 位';
  host.querySelector('#group-create-selected').innerHTML = count
    ? [...dialog.selected].map(id => {
      const persona = dialog.personas.find(item => item.id === id);
      return `<button type="button" class="gc-selected-member" data-remove-member="${escAttr(id)}" aria-label="移除${escAttr(persona?.name || id)}" ${dialog.saving ? 'disabled' : ''}>
        ${avatarHtml(persona?.name || id, 'sm', personaAvatarUrl(persona))}<span>${esc(selectedMemberLabel(dialog, persona, id))}</span><span aria-hidden="true">×</span>
      </button>`;
    }).join('')
    : '<p class="gc-selection-placeholder">选择你想邀请的角色，至少 2 位。</p>';
  host.querySelector('#group-create-probabilities').innerHTML = count
    ? [...dialog.selected].map(id => {
      const persona = dialog.personas.find(item => item.id === id);
      const name = selectedMemberLabel(dialog, persona, id);
      return `<label class="gc-probability gc-member-probability"><span>${esc(name)}</span>${probabilitySlider(id, name, dialog.probabilities.get(id) ?? 50, true, dialog.saving)}</label>`;
    }).join('')
    : '<p class="gc-muted">选择成员后可分别设置回复概率。</p>';
  if (!dialog.nameEdited) host.querySelector('#group-create-name').value = suggestedGroupName(dialog);
  const button = host.querySelector('#group-create-submit');
  button.disabled = dialog.loading || dialog.saving || count < 2;
  button.textContent = dialog.saving ? '创建中…' : count ? `创建群聊 (${count})` : '创建群聊';
  renderCreateSettingsSummary(dialog);
}

function setCreateError(dialog, message) {
  const error = dialog.element.querySelector('#group-create-error');
  error.textContent = message;
  error.hidden = !message;
}

function setCreateFieldsDisabled(dialog, disabled) {
  const fields = dialog.element.querySelector('#group-create-fields');
  fields.setAttribute('aria-disabled', String(disabled));
  fields.querySelectorAll('input, button').forEach(control => { control.disabled = disabled; });
}

async function loadCreateMembers(dialog) {
  const version = ++dialog.loadVersion;
  dialog.loading = true;
  const host = dialog.element;
  host.querySelector('#group-create-members').setAttribute('aria-busy', 'true');
  host.querySelector('#group-create-members').innerHTML = '<div class="gc-empty" role="status">正在加载角色…</div>';
  host.querySelector('#group-create-search').disabled = true;
  setCreateError(dialog, '');
  renderCreateSelection(dialog);
  try {
    const response = await api.get('/api/personas', { bypassCache: true });
    if (!createDialogIsCurrent(dialog) || version !== dialog.loadVersion) return;
    if (response.error) throw new Error(response.error);
    dialog.personas = response.personas || [];
    state.personas = dialog.personas;
    renderCreateMemberList(dialog);
  } catch (error) {
    if (!createDialogIsCurrent(dialog) || version !== dialog.loadVersion) return;
    host.querySelector('#group-create-members').innerHTML = '<div class="gc-empty">角色加载失败<button type="button" class="gc-retry" data-retry-create-members>重新加载</button></div>';
    setCreateError(dialog, error.message || '加载角色失败，请重试。');
  } finally {
    if (createDialogIsCurrent(dialog) && version === dialog.loadVersion) {
      dialog.loading = false;
      host.querySelector('#group-create-members').removeAttribute('aria-busy');
      host.querySelector('#group-create-search').disabled = false;
      renderCreateSelection(dialog);
      if (window.matchMedia('(min-width: 768px)').matches) host.querySelector('#group-create-search').focus({ preventScroll: true });
    } else if (createDialog === dialog && !createDialogIsCurrent(dialog)) {
      dismissCreateDialog(dialog, false);
    }
  }
}

async function submitCreateGroup(dialog) {
  if (!createDialogIsCurrent(dialog) || dialog.loading || dialog.saving) return;
  const host = dialog.element;
  const name = host.querySelector('#group-create-name').value.trim();
  const maxReplies = Number(host.querySelector('#group-create-max-replies').value);
  const members = [...dialog.selected].map(id => ({ persona_id: id, reply_probability: Number(dialog.probabilities.get(id) ?? 50) }));
  if (members.length < 2) { setCreateError(dialog, '请至少选择两位角色。'); return; }
  if (!name || Array.from(name).length > 60) { setCreateError(dialog, '群聊名称须为 1–60 个字。'); host.querySelector('#group-create-name').focus(); return; }
  if (!Number.isSafeInteger(maxReplies) || maxReplies < 1) { setCreateError(dialog, '连续回复上限须为大于 0 的整数。'); return; }
  if (members.some(member => String(dialog.probabilities.get(member.persona_id) ?? 50).trim() === '' || !Number.isInteger(member.reply_probability) || member.reply_probability < 0 || member.reply_probability > 100)) {
    setCreateError(dialog, '回复概率须为 0–100 的整数。'); return;
  }
  dialog.saving = true;
  setCreateError(dialog, '');
  setCreateFieldsDisabled(dialog, true);
  renderCreateMemberList(dialog);
  renderCreateSelection(dialog);
  try {
    const response = await api.post('/api/groups', { name, members, max_replies: maxReplies });
    if (response.status >= 400 || !response.data?.group_id) throw new Error(response.data?.error || '创建失败，请重试。');
    if (!createDialogIsCurrent(dialog)) { if (createDialog === dialog) dismissCreateDialog(dialog, false); return; }
    dismissCreateDialog(dialog, false);
    await window.PawzoChat.openGroupChat(response.data.group_id);
    refreshSidebar();
  } catch (error) {
    if (createDialogIsCurrent(dialog)) setCreateError(dialog, error.message || '网络错误，请重试。');
  } finally {
    if (createDialogIsCurrent(dialog)) {
      dialog.saving = false;
      setCreateFieldsDisabled(dialog, false);
      renderCreateMemberList(dialog);
      renderCreateSelection(dialog);
    }
  }
}

export async function openCreateGroupDialog() {
  closeOverlay();
  dismissCreateDialog(createDialog, false);
  const element = document.createElement('dialog');
  element.id = 'group-create-dialog';
  element.className = 'group-create-dialog';
  element.setAttribute('aria-labelledby', 'group-create-title');
  element.setAttribute('aria-describedby', 'group-create-description');
  const dialog = createDialog = {
    element, opener: document.activeElement, originTab: state.currentTab,
    originPage: state.pageStack[state.pageStack.length - 1],
    personas: [], selected: new Set(), probabilities: new Map(),
    loading: true, saving: false, nameEdited: false, loadVersion: 0,
  };
  element.innerHTML = `<form class="gc-form" novalidate>
    <header class="gc-header"><div><h2 id="group-create-title">创建群聊</h2><p id="group-create-description">邀请角色一起聊天</p></div><button type="button" class="gc-close" data-cancel-create aria-label="关闭创建群聊">×</button></header>
    <div id="group-create-fields" class="gc-fields" role="group" aria-label="群聊设置">
      <section class="gc-members-pane" aria-label="选择群成员">
        <label class="gc-search">${SEARCH_ICON_HTML}<input id="group-create-search" type="search" placeholder="搜索角色" aria-label="搜索角色" autocomplete="off" disabled></label>
        <div id="group-create-members" class="gc-members" aria-busy="true"><div class="gc-empty" role="status">正在加载角色…</div></div>
      </section>
      <section class="gc-selection-pane" aria-label="群聊信息">
        <h3 id="group-create-count" aria-live="polite">已选 0 位角色</h3>
        <div id="group-create-selected" class="gc-selected"><p class="gc-selection-placeholder">请选择至少 2 位角色。</p></div>
        <label class="gc-name-field">群聊名称<input id="group-create-name" type="text" maxlength="60" placeholder="选择成员后自动填写" autocomplete="off"></label>
        <details id="group-create-advanced" class="gc-advanced"><summary>回复设置<span id="group-create-settings-summary">50% · 上限 5 次</span></summary>
          <label class="gc-probability gc-limit"><span>连续回复上限</span><span class="gc-number-unit"><input id="group-create-max-replies" type="number" min="1" step="1" value="5" required aria-label="连续角色回复上限">次</span></label>
          <p class="gc-muted">你发新消息后重新计数。一个角色的完整回复计一次；达到上限后等待你发消息。</p>
          <div id="group-create-probabilities"></div>
        </details>
        <p class="gc-settings-note">创建后仍可在群设置中调整成员和回复规则。</p>
      </section>
    </div>
    <div id="group-create-error" class="gc-error" role="alert" hidden></div>
    <footer class="gc-footer"><span class="gc-footer-hint">至少选 2 位</span><button type="button" id="group-create-cancel" class="gc-cancel" data-cancel-create>取消</button><button type="submit" id="group-create-submit" class="gc-submit" disabled>创建群聊</button></footer>
  </form>`;
  element.addEventListener('cancel', event => { event.preventDefault(); dismissCreateDialog(dialog); });
  element.addEventListener('close', () => { if (createDialog === dialog) dismissCreateDialog(dialog); });
  element.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button?.hasAttribute('data-cancel-create')) { dismissCreateDialog(dialog); return; }
    if (button?.hasAttribute('data-retry-create-members')) { loadCreateMembers(dialog); return; }
    if (button?.dataset.removeMember && !dialog.saving) {
      dialog.selected.delete(button.dataset.removeMember);
      renderCreateMemberList(dialog);
      renderCreateSelection(dialog);
      setCreateError(dialog, '');
    }
    if (event.target === element) {
      const bounds = element.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismissCreateDialog(dialog);
    }
  });
  element.addEventListener('change', event => {
    const id = event.target.dataset.createMember;
    if (!id || dialog.saving) return;
    if (event.target.checked) dialog.selected.add(id);
    else dialog.selected.delete(id);
    renderCreateSelection(dialog);
    setCreateError(dialog, '');
  });
  element.addEventListener('input', event => {
    if (event.target.id === 'group-create-search') renderCreateMemberList(dialog);
    if (event.target.id === 'group-create-name') dialog.nameEdited = !!event.target.value.trim();
    if (event.target.dataset.createProbability) {
      dialog.probabilities.set(event.target.dataset.createProbability, event.target.value);
      updateProbabilityDisplay(event.target);
    }
    if (event.target.id === 'group-create-max-replies' || event.target.dataset.createProbability) renderCreateSettingsSummary(dialog);
  });
  element.querySelector('#group-create-search').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  element.querySelector('form').addEventListener('submit', event => { event.preventDefault(); submitCreateGroup(dialog); });
  document.body.appendChild(element);
  if (!createDialogIsCurrent(dialog)) { dismissCreateDialog(dialog, false); return; }
  element.showModal();
  await loadCreateMembers(dialog);
}

function bindGroupAvatarEditor(host, group, generation, save) {
  const preview = host.querySelector('#group-avatar-preview');
  const input = host.querySelector('#group-avatar-input');
  const reset = host.querySelector('#group-avatar-reset');
  let busy = false;
  let crop = null;
  let closeCrop = null;
  const current = () => generation === editorGeneration && host.isConnected;
  const setBusy = value => {
    busy = value;
    host.querySelector('.group-avatar-setting').setAttribute('aria-busy', String(value));
    preview.disabled = input.disabled = reset.disabled = save.disabled = value;
  };
  const update = next => {
    group = next;
    preview.querySelector('.group-avatar').outerHTML = groupAvatarHtml(group);
    reset.hidden = !group.has_avatar;
  };
  const persist = async blob => {
    if (!current() || busy) return;
    setBusy(true);
    const url = `/api/groups/${encodeURIComponent(group.group_id)}/avatar`;
    try {
      let response;
      if (blob) {
        const body = new FormData();
        body.append('avatar', blob, 'avatar.png');
        const result = await fetch(`${window.PAWZOCHAT_BASE || ''}${url}`, { method: 'POST', body });
        response = { status: result.status, data: await result.json() };
      } else response = await api.del(url);
      if (response.status >= 400) throw new Error(response.data?.error || '头像保存失败');
      if (!current()) return;
      update(response.data);
      toast(blob ? '群头像已更新' : '已恢复默认群头像', 'success');
      refreshSidebar();
    } catch (error) {
      if (current()) toast(error.message || '头像保存失败，请重试', 'error');
    } finally { if (current()) setBusy(false); }
  };
  preview.addEventListener('click', () => { if (!busy && !crop) input.click(); });
  reset.addEventListener('click', () => { if (!crop) persist(null); });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy || crop) return;
    if (!file.type.startsWith('image/')) { toast('请选择图片文件', 'error'); return; }
    try {
      const { openCropModal, closeCropModal, confirmCrop } = await import('./contacts.js');
      if (!current() || busy || crop) return;
      const url = URL.createObjectURL(file);
      openCropModal(url, blob => { if (current()) persist(blob); });
      crop = document.getElementById('crop-modal');
      closeCrop = closeCropModal;
      crop.classList.add('group-avatar-crop');
      crop.setAttribute('role', 'dialog');
      crop.setAttribute('aria-modal', 'true');
      crop.setAttribute('aria-label', '裁剪群头像');
      const cleanup = crop._cleanup;
      crop._cleanup = () => { cleanup?.(); URL.revokeObjectURL(url); crop = null; };
      crop.querySelector('.crop-cancel').onclick = closeCropModal;
      const confirm = crop.querySelector('.crop-ok');
      confirm.onclick = confirmCrop;
      confirm.disabled = true;
      const image = crop.querySelector('#crop-img');
      const loaded = image.onload;
      image.onload = () => { loaded(); confirm.disabled = false; };
      image.onerror = () => { closeCropModal(); if (current()) toast('无法读取这张图片，请重新选择', 'error'); };
    } catch (error) {
      if (current()) toast('无法打开头像裁剪，请重试', 'error');
    }
  });
  return () => { if (crop?.isConnected) closeCrop?.(); };
}

function groupSettingsIsCurrent(editor) {
  return settingsEditor === editor && editor.generation === editorGeneration && editor.host.isConnected;
}

function selectedGroupMembers(editor) {
  return editor.memberOrder.filter(id => editor.selected.has(id));
}

function saveGroupSettingsDraft(editor) {
  if (editor.saved) return;
  const { host } = editor;
  editor.data.draft = {
    name: host.querySelector('#group-name').value,
    maxReplies: host.querySelector('#group-max-replies').value,
    systemInstructions: host.querySelector('#group-system-instructions').value,
    selected: [...editor.selected], memberOrder: [...editor.memberOrder],
    probabilities: [...editor.probabilities], memoryEnabled: [...editor.memoryEnabled],
    groupPrompts: [...editor.groupPrompts], expandedPrompts: [...editor.expandedPrompts],
    scroll: content().scrollTop,
  };
}

async function resetGroupSystemInstructions(editor) {
  if (!groupSettingsIsCurrent(editor) || editor.saving || editor.resettingSystem) return;
  const button = editor.host.querySelector('#group-system-reset');
  const revision = editor.systemRevision;
  editor.resettingSystem = true;
  button.disabled = true;
  try {
    const response = await api.get('/api/groups/default-system-instructions', { bypassCache: true });
    if (response.error || typeof response.text !== 'string') throw new Error(response.error || '获取默认提示词失败');
    // A late response must not replace edits made while the request was loading.
    if (!groupSettingsIsCurrent(editor) || editor.saving || editor.systemRevision !== revision) return;
    setPromptValue(editor.host.querySelector('#group-system-instructions'), response.text);
    editor.systemRevision++;
    saveGroupSettingsDraft(editor);
    toast('已恢复默认，保存设置后生效', 'success');
  } catch (error) {
    if (groupSettingsIsCurrent(editor)) toast(error.message || '获取默认提示词失败', 'error');
  } finally {
    editor.resettingSystem = false;
    if (groupSettingsIsCurrent(editor)) button.disabled = editor.saving;
  }
}

function dismissMemberDialog(editor, restoreFocus = true) {
  const dialog = editor.memberDialog;
  if (!dialog) return;
  editor.memberDialog = null;
  if (dialog.element.open) dialog.element.close();
  dialog.element.remove();
  if (restoreFocus && groupSettingsIsCurrent(editor)) {
    editor.host.querySelector('#group-members-edit').focus({ preventScroll: true });
  }
}

function openMemberDialog(editor) {
  if (!groupSettingsIsCurrent(editor) || editor.saving || editor.memberDialog) return;
  const element = document.createElement('dialog');
  element.id = 'group-members-dialog';
  element.className = 'group-create-dialog group-members-dialog';
  element.setAttribute('aria-labelledby', 'group-members-title');
  element.setAttribute('aria-describedby', 'group-members-description');
  const dialog = editor.memberDialog = {
    element, selected: new Set(editor.selected), memberOrder: [...editor.memberOrder],
  };
  // Keep stale member references removable if a persona was deleted elsewhere.
  const availableIds = new Set(editor.personas.map(persona => persona.id));
  const candidates = [...editor.personas, ...selectedGroupMembers(editor)
    .filter(id => !availableIds.has(id)).map(id => ({ id, name: id, missing: true }))];
  element.innerHTML = `<form class="gc-form">
    <header class="gc-header"><div><h2 id="group-members-title">编辑群成员</h2><p id="group-members-description">勾选添加，取消勾选移除。完成后请保存设置。</p></div><button type="button" class="gc-close" data-cancel-members aria-label="关闭编辑群成员">×</button></header>
    <label class="gc-search">${SEARCH_ICON_HTML}<input id="group-members-search" type="search" placeholder="搜索角色" aria-label="搜索角色" autocomplete="off"></label>
    <div class="gc-members group-edit-options"></div>
    <footer class="gc-footer"><span id="group-members-selection-count" class="gc-footer-hint" aria-live="polite"></span><button type="button" class="gc-cancel" data-cancel-members>取消</button><button type="submit" class="gc-submit" id="group-members-done">完成</button></footer>
  </form>`;
  const updateCount = () => {
    element.querySelector('#group-members-selection-count').textContent = `已选 ${dialog.selected.size} 位`;
  };
  const renderOptions = () => {
    const query = element.querySelector('#group-members-search').value.trim().toLocaleLowerCase();
    const matches = candidates.filter(persona =>
      [persona.name, persona.id, persona.llm_provider, persona.llm_model].join(' ').toLocaleLowerCase().includes(query));
    element.querySelector('.group-edit-options').innerHTML = matches.length
      ? matches.map(persona => `<label class="gc-member-row">
          <input type="checkbox" aria-label="选择${escAttr(selectedMemberLabel(editor, persona, persona.id))}" data-group-member="${escAttr(persona.id)}" ${dialog.selected.has(persona.id) ? 'checked' : ''}>
          ${avatarHtml(persona.name, 'sm', personaAvatarUrl(persona))}
          <span class="gc-member-info"><strong>${esc(persona.name)}</strong><small>${esc(persona.missing ? '角色已不存在，可取消勾选移除' : memberDetail(persona))}</small></span>
        </label>`).join('')
      : `<div class="gc-empty">${candidates.length ? '没有找到匹配的角色' : '通讯录中还没有角色，请先创建角色。'}</div>`;
  };
  element.addEventListener('cancel', event => { event.preventDefault(); dismissMemberDialog(editor); });
  element.addEventListener('close', () => {
    if (editor.memberDialog === dialog) dismissMemberDialog(editor);
  });
  element.addEventListener('click', event => {
    if (event.target.closest('[data-cancel-members]')) { dismissMemberDialog(editor); return; }
    if (event.target === element) {
      const bounds = element.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismissMemberDialog(editor);
    }
  });
  element.addEventListener('change', event => {
    const id = event.target.dataset.groupMember;
    if (!id) return;
    if (event.target.checked) {
      dialog.selected.add(id);
      if (!dialog.memberOrder.includes(id)) dialog.memberOrder.push(id);
    } else dialog.selected.delete(id);
    updateCount();
  });
  const search = element.querySelector('#group-members-search');
  search.addEventListener('input', renderOptions);
  search.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  element.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    if (!groupSettingsIsCurrent(editor) || editor.memberDialog !== dialog) return;
    editor.selected = dialog.selected;
    editor.memberOrder = dialog.memberOrder;
    dismissMemberDialog(editor, false);
    renderGroupMembers(editor);
    saveGroupSettingsDraft(editor);
    editor.host.querySelector('#group-members-edit').focus({ preventScroll: true });
  });
  renderOptions();
  updateCount();
  document.body.appendChild(element);
  element.showModal();
  // Keep the mobile keyboard closed until the user chooses to search.
  const focusTarget = window.matchMedia('(min-width: 768px)').matches ? search : element.querySelector('.gc-close');
  focusTarget.focus({ preventScroll: true });
}

function updateGroupMemorySummary(editor, personaId) {
  const row = editor.memberRows.get(personaId);
  if (!row) return;
  const source = editor.memorySources.get(personaId);
  const total = source?.total ?? editor.savedMembers.get(personaId)?.memory_count;
  const canView = editor.savedMembers.has(personaId);
  row.querySelector('.group-memory-manage').disabled = editor.saving || !canView;
  row.querySelector('.group-memory-count').textContent = canView
    ? `查看记忆${Number.isInteger(total) ? ` · ${total} 条` : ''}` : '保存成员后可查看';
  row.querySelector('.row-arrow').hidden = !canView;
  const error = row.querySelector('.group-memory-error');
  error.textContent = source?.error ? `最近一次记录失败：${source.error}` : '';
  error.hidden = !source?.error;
}

function renderGroupMembers(editor) {
  const ids = selectedGroupMembers(editor);
  const personaFor = id => editor.personas.find(persona => persona.id === id) || { id, name: id };
  editor.host.querySelector('#group-member-count').textContent = `${ids.length} 位`;
  editor.host.querySelector('#group-member-grid').innerHTML = ids.map(id => {
    const persona = personaFor(id);
    const name = selectedMemberLabel(editor, persona, id);
    return `<div class="group-member-tile" data-group-member-id="${escAttr(id)}">
      ${avatarHtml(persona.name, 'sm', personaAvatarUrl(persona))}<span class="group-member-name" title="${escAttr(name)}">${esc(name)}</span>
    </div>`;
  }).join('') + `<button type="button" class="group-member-tile group-members-edit" id="group-members-edit" aria-label="编辑群成员" aria-haspopup="dialog">
    <span class="group-member-edit-icon" aria-hidden="true">${iconHtml('ri-edit-line')}</span><span class="group-member-name">编辑</span>
  </button>`;
  editor.host.querySelector('#group-members-empty').hidden = ids.length > 0;
  editor.host.querySelector('#group-memory-members').innerHTML = ids.map(id => {
    const persona = personaFor(id);
    const name = selectedMemberLabel(editor, persona, id);
    const prompt = editor.groupPrompts.get(id) ?? '';
    return `<div class="group-memory-member" data-group-settings-member="${escAttr(id)}">
      <button type="button" class="group-memory-manage" data-group-memory-manage="${escAttr(id)}" aria-label="查看${escAttr(name)}的群记忆">
        ${avatarHtml(persona.name, 'sm', personaAvatarUrl(persona))}
        <span class="group-memory-info"><span class="group-memory-name" title="${escAttr(name)}">${esc(name)}</span><span class="group-memory-detail"><span class="group-memory-count"></span><span class="row-arrow" aria-hidden="true">›</span></span></span>
      </button>
      <label class="group-memory-toggle"><span>生成记忆</span><span class="switch-wrap"><input type="checkbox" data-group-memory="${escAttr(id)}" ${editor.memoryEnabled.get(id) !== false ? 'checked' : ''} aria-label="${escAttr(name)}在本群生成记忆"><span class="switch-track"></span></span></label>
      <label class="group-member-probability"><span>回复概率</span>${probabilitySlider(id, name, editor.probabilities.get(id) ?? 50)}</label>
      <details class="group-member-prompt" data-group-prompt-panel="${escAttr(id)}" ${editor.expandedPrompts.has(id) ? 'open' : ''}>
        <summary aria-label="编辑${escAttr(name)}的本群专属提示词"><span>本群专属提示词</span><span class="group-prompt-status">${prompt.trim() ? '已设置' : '未设置'}</span><span class="group-prompt-chevron" aria-hidden="true">›</span></summary>
        <div class="group-member-prompt-content">
          <textarea class="prompt-input prompt-input--plain prompt-part group-prompt-input" data-group-prompt="${escAttr(id)}" aria-label="${escAttr(name)}的本群专属提示词" placeholder="填写该角色在本群中的身份、关系或特别要求…"></textarea>
        </div>
      </details>
      <p class="group-memory-error" hidden></p>
    </div>`;
  }).join('') || '<p class="group-hint">暂无群成员，点击上方“编辑”添加后即可设置提示词、回复概率与记忆。</p>';
  editor.memberRows = new Map([...editor.host.querySelectorAll('[data-group-settings-member]')].map(row => [row.dataset.groupSettingsMember, row]));
  ids.forEach(id => {
    // HTML parsing strips a textarea's first newline; set its value directly.
    editor.memberRows.get(id).querySelector('[data-group-prompt]').value = editor.groupPrompts.get(id) ?? '';
    updateGroupMemorySummary(editor, id);
  });
}

async function renderGroupSettings(data) {
  const { groupId } = data;
  const generation = ++editorGeneration;
  let disposeAvatar = null;
  let disposeScroll = null;
  setPageCleanup(() => {
    editorGeneration++;
    if (settingsEditor?.generation === generation) {
      saveGroupSettingsDraft(settingsEditor);
      dismissMemberDialog(settingsEditor, false);
      settingsEditor = null;
    }
    disposeAvatar?.();
    disposeScroll?.();
  });
  setTopBar('群聊设置', true,
    '<button type="button" class="btn-text group-save" id="group-save" onclick="PawzoChat.saveGroupSettings()" disabled>保存</button>');
  const saveButton = $('group-save');
  content().innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  try {
    // Navigation rebuilds this page when the layout changes. Keep an in-flight
    // save owned by the page data so the rebuilt editor cannot submit twice.
    const pendingSave = data.pendingSave;
    if (pendingSave) {
      let response;
      try {
        response = await pendingSave;
        if (response.status >= 400) throw new Error(response.data?.error || '保存失败');
      } catch (error) {
        if (generation !== editorGeneration) return;
        toast(error.message || '保存失败', 'error');
      }
      if (generation !== editorGeneration) return;
      if (response && response.status < 400) {
        delete data.draft;
        await window.PawzoChat.openGroupChat(response.data.group_id || groupId);
        refreshSidebar();
        return;
      }
    }
    const [personas, group] = await Promise.all([
      api.get('/api/personas', { bypassCache: true }),
      api.get(`/api/groups/${encodeURIComponent(groupId)}`, { bypassCache: true }),
    ]);
    if (generation !== editorGeneration) return;
    if (personas.error) throw new Error(personas.error);
    if (group.error) throw new Error(group.error);
    state.personas = personas.personas || [];
    const savedMembers = new Map((group.members || []).map(member => [member.persona_id, member]));
    const draft = data.draft;
    const memberIds = [...savedMembers.keys()];
    content().innerHTML = `<div class="page group-settings" id="group-settings" data-group-id="${escAttr(groupId)}">
      <div class="card group-members-card"><div class="card-header">群成员<span id="group-member-count" aria-live="polite"></span></div>
        <div id="group-member-grid" class="group-member-grid"></div>
        <p id="group-members-empty" class="group-hint" hidden>暂无群成员，点击“编辑”添加角色。</p>
      </div>
      <div class="card group-details-card">
        <div class="group-identity">
          <div class="group-avatar-setting">
            <input type="file" id="group-avatar-input" accept="image/*" hidden>
            <button type="button" class="avatar-upload-wrap group-avatar-edit" id="group-avatar-preview" aria-label="更换群头像" title="更换群头像">
              ${groupAvatarHtml(group)}<span class="avatar-cam" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 5h-4l-2-2h-4L8 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"/><circle cx="12" cy="13" r="4"/></svg></span>
            </button>
            <button type="button" class="btn-text" id="group-avatar-reset" aria-label="恢复默认头像" ${group.has_avatar ? '' : 'hidden'}>恢复默认</button>
          </div>
          <label class="group-name-field"><span>群聊名称</span><input id="group-name" maxlength="60" placeholder="输入群聊名称" value="${escAttr(draft?.name ?? group.name ?? '')}"></label>
        </div>
        <div class="group-reply-settings">
          <label class="group-limit-field" for="group-max-replies"><span>连续回复上限</span><span class="group-limit-value"><input id="group-max-replies" type="number" min="1" step="1" aria-describedby="group-limit-hint" value="${escAttr(draft?.maxReplies ?? group.max_replies ?? 5)}"><span aria-hidden="true">次</span></span></label>
          <p class="group-hint" id="group-limit-hint">每位角色的完整回复计 1 次，达到上限后暂停其他角色回复。你发送新消息后重新计数。</p>
        </div>
      </div>
      <div class="card group-memory-card"><div class="card-header">成员设置</div>
        <div id="group-memory-members"></div>
        <p class="form-hint group-memory-note">回复概率仅影响本群，显式 @ 可指定成员回应。<br>记忆生成方式沿用角色设置。关闭后停止生成新记忆，已有记忆会继续读取。</p>
      </div>
      <div class="card group-system-prompt-card">
        <div class="card-header-row"><label class="card-header" for="group-system-instructions">群系统提示词</label><button type="button" class="btn-text btn-sm" id="group-system-reset" aria-label="恢复默认群系统提示词">恢复默认</button></div>
        <div class="prompt-field"><textarea class="prompt-input prompt-part group-prompt-input" id="group-system-instructions" aria-describedby="group-system-hint" placeholder="描述共同背景、群聊规则和回复格式…"></textarea></div>
        <p class="form-hint" id="group-system-hint">对本群所有角色生效，用于共同背景、群聊规则与回复格式。角色的私聊系统提示词不会带入本群。</p>
      </div>
    </div>`;
    const host = $('group-settings');
    host.querySelector('#group-system-instructions').value = draft?.systemInstructions ?? group.system_instructions ?? '';
    const editor = settingsEditor = {
      host, groupId, generation, data, saveButton, personas: state.personas, savedMembers,
      selected: new Set(draft?.selected || memberIds), memberOrder: draft?.memberOrder || memberIds,
      probabilities: new Map(draft?.probabilities || [...savedMembers].map(([id, member]) => [id, member.reply_probability])),
      memoryEnabled: new Map(draft?.memoryEnabled || [...savedMembers].map(([id, member]) => [id, member.memory_enabled !== false])),
      groupPrompts: new Map(draft?.groupPrompts || [...savedMembers].map(([id, member]) => [id, member.group_prompt ?? ''])),
      expandedPrompts: new Set(draft?.expandedPrompts || []), systemRevision: 0,
      memorySources: new Map(), memberDialog: null, saving: false, saved: false, resettingSystem: false,
    };
    renderGroupMembers(editor);
    resizePromptTextarea(host.querySelector('#group-system-instructions'));
    host.addEventListener('input', event => {
      if (!groupSettingsIsCurrent(editor)) return;
      if (event.target.dataset.groupProbability) {
        editor.probabilities.set(event.target.dataset.groupProbability, Number(event.target.value));
        updateProbabilityDisplay(event.target);
      }
      if (event.target.dataset.groupPrompt) {
        const id = event.target.dataset.groupPrompt;
        editor.groupPrompts.set(id, event.target.value);
        editor.memberRows.get(id).querySelector('.group-prompt-status').textContent = event.target.value.trim() ? '已设置' : '未设置';
      }
      if (event.target.id === 'group-system-instructions') {
        editor.systemRevision++;
      }
      saveGroupSettingsDraft(editor);
    });
    host.addEventListener('change', event => {
      if (!groupSettingsIsCurrent(editor)) return;
      if (event.target.dataset.groupMemory) editor.memoryEnabled.set(event.target.dataset.groupMemory, event.target.checked);
      saveGroupSettingsDraft(editor);
    });
    host.addEventListener('toggle', event => {
      if (!groupSettingsIsCurrent(editor)) return;
      const id = event.target.dataset.groupPromptPanel;
      if (!id) return;
      if (event.target.open) editor.expandedPrompts.add(id);
      else editor.expandedPrompts.delete(id);
      saveGroupSettingsDraft(editor);
    }, true);
    host.addEventListener('click', event => {
      if (event.target.closest('#group-members-edit')) { openMemberDialog(editor); return; }
      if (event.target.closest('#group-system-reset')) { resetGroupSystemInstructions(editor); return; }
      const button = event.target.closest('[data-group-memory-manage]');
      if (!button || button.disabled) return;
      saveGroupSettingsDraft(editor);
      const personaId = button.dataset.groupMemoryManage;
      pushPage('memoryManage', { personaId, personaName: state.personas.find(persona => persona.id === personaId)?.name, groupId });
    });
    disposeAvatar = bindGroupAvatarEditor(host, group, generation, saveButton);
    saveButton.disabled = false;
    const scroller = content();
    if (draft) scroller.scrollTop = draft.scroll || 0;
    saveGroupSettingsDraft(editor);
    const onScroll = () => {
      if (groupSettingsIsCurrent(editor) && data.draft) data.draft.scroll = scroller.scrollTop;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    disposeScroll = () => scroller.removeEventListener('scroll', onScroll);
    for (const personaId of savedMembers.keys()) {
      api.get(`/api/personas/${encodeURIComponent(personaId)}/group-memories`, { bypassCache: true }).then(response => {
        if (!groupSettingsIsCurrent(editor)) return;
        if (response.error) return;
        editor.memorySources.set(personaId, response.groups?.find(item => item.group_id === groupId) || null);
        updateGroupMemorySummary(editor, personaId);
      }).catch(() => {});
    }
  } catch (error) {
    if (generation !== editorGeneration) return;
    content().innerHTML = '<div class="empty-state">无法加载群聊设置</div>';
    toast(error.message || '加载失败', 'error');
  }
}

export async function saveGroupSettings() {
  const editor = settingsEditor;
  if (!editor || !groupSettingsIsCurrent(editor) || editor.saving || editor.memberDialog) return;
  const { host, groupId, generation } = editor;
  const button = editor.saveButton;
  if (button.disabled) return;
  const name = $('group-name').value.trim();
  const maxReplies = Number($('group-max-replies').value);
  const systemInstructions = host.querySelector('#group-system-instructions').value;
  const members = selectedGroupMembers(editor).map(id => ({
    persona_id: id,
    reply_probability: Number(editor.probabilities.get(id) ?? 50),
    memory_enabled: editor.memoryEnabled.get(id) !== false,
    group_prompt: editor.groupPrompts.get(id) ?? '',
  }));
  if (!name || Array.from(name).length > 60) { toast('请填写 1–60 字的群聊名称'); return; }
  if (!Number.isSafeInteger(maxReplies) || maxReplies < 1) { toast('回复上限须为大于 0 的整数'); return; }
  if (members.some(m => !Number.isInteger(m.reply_probability) || m.reply_probability < 0 || m.reply_probability > 100)) { toast('回复概率须为 0–100 的整数'); return; }
  editor.saving = true;
  saveGroupSettingsDraft(editor);
  const fields = [...host.querySelectorAll('input, button, textarea'), button].map(control => [control, control.disabled]);
  fields.forEach(([control]) => { control.disabled = true; });
  host.setAttribute('aria-busy', 'true');
  button.textContent = '保存中…';
  let pendingSave;
  try {
    const body = { name, members, max_replies: maxReplies, system_instructions: systemInstructions };
    pendingSave = editor.data.pendingSave = api.patch(`/api/groups/${encodeURIComponent(groupId)}`, body);
    const response = await pendingSave;
    if (response.status >= 400) throw new Error(response.data?.error || '保存失败');
    editor.saved = true;
    delete editor.data.draft;
    if (generation !== editorGeneration) return;
    await window.PawzoChat.openGroupChat(response.data.group_id || groupId);
    refreshSidebar();
  } catch (error) {
    if (generation === editorGeneration) toast(error.message || '保存失败', 'error');
  } finally {
    if (editor.data.pendingSave === pendingSave) delete editor.data.pendingSave;
    editor.saving = false;
    if (groupSettingsIsCurrent(editor)) {
      fields.forEach(([control, disabled]) => { control.disabled = disabled; });
      host.querySelector('#group-system-reset').disabled = editor.resettingSystem;
      selectedGroupMembers(editor).forEach(id => updateGroupMemorySummary(editor, id));
      host.removeAttribute('aria-busy');
      button.textContent = '保存';
    }
  }
}

registerPageRenderer('groupSettings', renderGroupSettings);
