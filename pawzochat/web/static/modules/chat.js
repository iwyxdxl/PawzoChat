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
import { avatarHtml, personaAvatarUrl, formatTime, formatMsgTime, esc, escAttr, iconHtml, placeActionsPop, jsArg } from "./utils.js";
import { api } from "./api.js";
import { ChatHistory } from "./chat_history.js";
import { prepareDraftAttachments } from "./draft_attachments.js";
import { groupAvatarHtml, openCreateGroupDialog } from "./groups.js";
import { ChatMentions, MENTION_ALL_ID } from "./chat_mentions.js";
import { ChatMentionPicker } from "./chat_mention_picker.js";
import { renderQuoteBox } from "./quote.js";
import { state, $, content, sidebar } from "./state.js";
import { toast, confirm, confirmWithCheckbox, showSheet, closeOverlay, showLoading, hideLoading } from "./ui.js";
import {
  setTopBar, pushPage, goBack, switchTab,
  registerTabRenderer, registerPageRenderer, setPageCleanup,
  isDesktop, setSidebarBar, refreshSidebar,
} from "./navigation.js";

export let chatPersonaId = null;
export let chatGroupId = null;
let _currentGroup = null;
let _chatWindowGeneration = 0;
let _pendingReplyId = "";
let _mentions = new ChatMentions();
let _mentionEdit = null;
let _mentionPicker = null;
let _chatMenu = null;
let _suppressedAvatar = null;

function mediaUrl(kind, filename) {
  const base = window.PAWZOCHAT_BASE || "";
  return chatGroupId
    ? `${base}/api/groups/${encodeURIComponent(chatGroupId)}/media/${kind}/${encodeURIComponent(filename)}`
    : `${base}/api/${kind === 'voice' ? 'audio' : kind}/${encodeURIComponent(chatPersonaId)}/${encodeURIComponent(filename)}`;
}

function chatTitle() {
  return chatGroupId ? `${_currentGroup?.name || '群聊'} (${_currentGroup?.members?.length || 0})`
    : state.personas.find(p => p.id === chatPersonaId)?.name || chatPersonaId;
}
let _history = null;
let _temporaryMessage = 0;
const _chatObjectUrls = new Set();
let _pendingImages = [];
let _pendingFiles = [];
let _pendingQuote = "";
// Session-only drafts retain File objects, never detached DOM or blob URLs.
// Private and group conversations have separate namespaces even for equal IDs.
const _chatDrafts = new Map();
const chatDraftKey = (personaId, groupId) => groupId ? `group:${groupId}` : `private:${personaId}`;

function saveChatDraft(key, input) {
  _mentions.sync(input.value, _mentionEdit);
  if (!input.value && !_pendingImages.length && !_pendingFiles.length && !_pendingQuote) {
    _chatDrafts.delete(key);
    refreshChatDraftPreviews();
    return;
  }
  _chatDrafts.set(key, {
    text: input.value,
    images: _pendingImages.map(image => image.file),
    files: [..._pendingFiles],
    quote: _pendingQuote,
    replyId: _pendingReplyId,
    mentions: _mentions,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
    selectionDirection: input.selectionDirection,
    scrollTop: input.scrollTop,
  });
  refreshChatDraftPreviews();
}

function chatPreviewHtml(key, lastMessage) {
  const draft = _chatDrafts.get(key);
  const summary = draft ? [
    draft.images.length ? '[图片]' : '',
    ...draft.files.map(item => `[文件] ${item.name}`),
    draft.text.trim() || (draft.quote ? `[引用] ${draft.quote}` : ''),
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ') : '';
  return summary
    ? `<span class="conv-draft-label">[草稿]</span> ${esc(summary)}`
    : esc(lastMessage);
}

function conversationPreview(key, lastMessage) {
  return `<div class="conv-preview" data-draft-key="${escAttr(key)}" data-last-message="${escAttr(lastMessage)}">${chatPreviewHtml(key, lastMessage)}</div>`;
}

// Update previews in place so searches, scroll positions and cached tab DOM
// survive draft changes without fetching or rebuilding the conversation list.
function refreshChatDraftPreviews() {
  document.querySelectorAll('.conv-preview[data-draft-key]').forEach(el => {
    el.innerHTML = chatPreviewHtml(el.dataset.draftKey, el.dataset.lastMessage);
  });
}

// "via <channel>" tag under a message that arrived from an external channel.
// Web/LLM-sourced messages get no tag.
const _MSG_FRAGMENT = "lxdxywi";
function sourceBadge(source) {
  let label = "";
  if (source === "wechat") label = "微信";
  else if (source === "qq") label = "QQ";
  else if (source === _MSG_FRAGMENT) label = "";
  else if (typeof source === "string" && source.startsWith("plugin:")) label = "插件";
  return label ? `<div class="msg-source">via ${esc(label)}</div>` : "";
}

/* ---- Long-press message action popup state ---- */

const _quotePop = {
  el: null,
  quoteText: "",
  copyText: "",
  messageId: "",
  speakerId: "",
  speakerName: "",
  voiceEl: null,
  outsideHandler: null,
  keyHandler: null,
};
let _lpTimer = null;
let _lpStartX = 0;
let _lpStartY = 0;
let _suppressedVoiceEl = null;
// The click generated when releasing a long-press must not immediately close
// the just-opened popup; swallow exactly that one click in the outside-handler.
let _ignoreNextDocClick = false;
// Voice transcript expansion is UI-only, but keep it through SSE re-renders
// while the current page remains open.
const _expandedVoiceTranscripts = new Set();

/* ---- Emoji Picker State ---- */

let _emojiPickerOpen = false;
let _emojiGroups = null;
let _emojiGroupCache = {};
let _emojiActiveTab = 0;

/* ---- Plus Menu State ---- */

let _plusMenuOpen = false;

const _STANDARD_EMOJIS = [
  "\u{1F600}","\u{1F603}","\u{1F604}","\u{1F601}","\u{1F606}","\u{1F605}","\u{1F602}","\u{1F923}","\u{1F60A}","\u{1F607}",
  "\u{1F642}","\u{1F643}","\u{1F609}","\u{1F60C}","\u{1F60D}","\u{1F970}","\u{1F618}","\u{1F617}","\u{1F619}","\u{1F61A}",
  "\u{1F60B}","\u{1F61B}","\u{1F61C}","\u{1F92A}","\u{1F61D}","\u{1F911}","\u{1F917}","\u{1F92D}","\u{1F92B}","\u{1F914}",
  "\u{1F910}","\u{1F928}","\u{1F610}","\u{1F611}","\u{1F636}","\u{1F60F}","\u{1F612}","\u{1F644}","\u{1F62C}","\u{1F925}",
  "\u{1F60E}","\u{1F913}","\u{1F978}","\u{1F9D0}","\u{1F615}","\u{1F61F}","\u{1F641}","\u{2639}\u{FE0F}","\u{1F62E}","\u{1F62F}",
  "\u{1F632}","\u{1F633}","\u{1F97A}","\u{1F979}","\u{1F626}","\u{1F627}","\u{1F628}","\u{1F630}","\u{1F625}","\u{1F622}",
  "\u{1F62D}","\u{1F631}","\u{1F616}","\u{1F623}","\u{1F61E}","\u{1F613}","\u{1F629}","\u{1F62A}","\u{1F924}","\u{1F634}",
  "\u{1F637}","\u{1F912}","\u{1F915}","\u{1F922}","\u{1F92E}","\u{1F927}","\u{1F975}","\u{1F976}","\u{1F974}","\u{1F635}",
  "\u{1F621}","\u{1F620}","\u{1F92C}","\u{1F608}","\u{1F47F}","\u{1F480}","\u{1F4A9}","\u{1F921}","\u{1F47B}","\u{1F47D}",
  "\u{1F916}","\u{1F63A}","\u{1F638}","\u{1F639}","\u{1F63B}","\u{1F63C}","\u{1F63D}","\u{1F640}","\u{1F63F}","\u{1F63E}",
  "\u{1F44D}","\u{1F44E}","\u{1F44A}","\u{270A}","\u{1F91B}","\u{1F91C}","\u{1F44F}","\u{1F64C}","\u{1F450}","\u{1F932}",
  "\u{1F91D}","\u{1F64F}","\u{270C}\u{FE0F}","\u{1F91E}","\u{1F91F}","\u{1F918}","\u{1F44C}","\u{1F90C}","\u{1F448}","\u{1F449}",
  "\u{1F446}","\u{1F447}","\u{261D}\u{FE0F}","\u{1F44B}","\u{1F919}","\u{1F4AA}","\u{1F9B5}","\u{1F9B6}","\u{1F442}","\u{1F440}",
  "\u{2764}\u{FE0F}","\u{1F9E1}","\u{1F49B}","\u{1F49A}","\u{1F499}","\u{1F49C}","\u{1F5A4}","\u{1F90D}","\u{1F90E}","\u{1F494}",
  "\u{1F495}","\u{1F49E}","\u{1F493}","\u{1F497}","\u{1F496}","\u{1F498}","\u{1F49D}","\u{1F48C}","\u{1F4AF}","\u{1F4A2}",
  "\u{1F4A5}","\u{1F4AB}","\u{1F4A6}","\u{1F4A8}","\u{1F525}","\u{2B50}","\u{1F31F}","\u{2728}","\u{1F389}","\u{1F388}",
  "\u{1F381}","\u{1F380}","\u{1F3C6}","\u{1F3C5}","\u{1F947}","\u{1F948}","\u{1F949}","\u{26BD}","\u{1F3B5}","\u{1F3B6}",
  "\u{1F436}","\u{1F431}","\u{1F42D}","\u{1F439}","\u{1F430}","\u{1F98A}","\u{1F43B}","\u{1F43C}","\u{1F428}","\u{1F42F}",
  "\u{1F981}","\u{1F42E}","\u{1F437}","\u{1F438}","\u{1F435}","\u{1F412}","\u{1F414}","\u{1F427}","\u{1F426}","\u{1F985}",
  "\u{1F339}","\u{1F33B}","\u{1F337}","\u{1F338}","\u{1F33A}","\u{1F340}","\u{1F343}","\u{1F341}","\u{1F342}","\u{1F334}",
  "\u{1F349}","\u{1F34A}","\u{1F34B}","\u{1F34C}","\u{1F34D}","\u{1F34E}","\u{1F350}","\u{1F351}","\u{1F352}","\u{1F353}",
  "\u{2615}","\u{1F375}","\u{1F37A}","\u{1F37B}","\u{1F942}","\u{1F377}","\u{1F378}","\u{1F379}","\u{1F354}","\u{1F355}",
];

/* ---- Chat List (Tab) ---- */

let _chatListGeneration = 0;
async function renderChatList() {
  if (_chatMenu?.el.classList.contains('chat-launch-menu')) closeChatMenu();
  const generation = ++_chatListGeneration;
  const desktop = isDesktop();
  const target = desktop ? sidebar() : content();
  const actionBtn = `<button class="top-btn" data-new-conversation aria-label="发起聊天" aria-haspopup="menu" aria-expanded="false" onclick="PawzoChat.newConversation(this)">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  </button>`;

  if (desktop) setSidebarBar("聊天", actionBtn);
  else setTopBar("聊天", false, actionBtn);

  target.innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const [res, pres, groups] = await Promise.all([
      api.get("/api/conversations"), api.get("/api/personas"), api.get("/api/groups"),
    ]);
    if (generation !== _chatListGeneration) return;
    state.conversations = res.conversations || [];
    state.personas = pres.personas || [];
    state.groups = groups.groups || [];
  } catch (e) { toast("加载失败", "error"); return; }

  // Layout changes start a tab refresh before restoring the open page. Its
  // late response must not replace that page with the mobile conversation list.
  if (generation !== _chatListGeneration || desktop !== isDesktop()
      || state.currentTab !== "chat" || (!desktop && state.pageStack.length)) return;

  if (state.conversations.length === 0 && state.groups.length === 0) {
    target.innerHTML = `
      <div class="empty-state" style="position:relative">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <div class="empty-text">还没有对话</div>
        <button onclick="PawzoChat.newConversation()">发起新对话</button>
        <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none">i*w*y*x*d*x*l</div>
      </div>`;
    return;
  }

  const searchHtml = `<div class="search-bar">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input placeholder="搜索" oninput="PawzoChat.filterConvs(this.value)">
  </div>`;

  const conversations = [...state.conversations, ...state.groups.map(group => ({ ...group, _group: true }))]
    .sort((a, b) => String(b.updated_at || b.last_message?.timestamp || '').localeCompare(String(a.updated_at || a.last_message?.timestamp || '')));
  const listHtml = conversations.map(c => {
    if (c._group) {
      const last = c.last_message;
      const text = last?.text || (last?.content || []).map(b => b.text || ({image:'[图片]', file:'[文件]', voice:'[语音]', emoji:'[表情]'}[b.type]) || '').join('');
      const sender = last?.speaker_name || (last?.role === 'user' ? state.profile?.name || '我' : '');
      return `<div class="conv-item${desktop && chatGroupId === c.group_id ? ' active' : ''}" data-group-id="${escAttr(c.group_id)}" onclick="PawzoChat.openGroupChat(${jsArg(c.group_id)})">
        ${groupAvatarHtml(c)}<div class="conv-info"><div class="conv-name">${esc(c.name)}</div>
        ${conversationPreview(chatDraftKey(null, c.group_id), sender && text ? `${sender}：${text}` : text)}</div>
        <div class="conv-meta"><div class="conv-time">${last ? formatTime(last.timestamp) : ''}</div></div></div>`;
    }
    const pname = c.persona_name || c.persona_id;
    const persona = state.personas.find(pp => pp.id === c.persona_id);
    const avUrl = personaAvatarUrl(persona);
    const preview = c.last_message ? c.last_message.text : "";
    const time = c.last_message ? formatTime(c.last_message.timestamp) : "";
    const wechatBadge = c.wechat_linked
      ? `<span class="wechat-badge"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg></span>` : "";
    const active = (desktop && chatPersonaId === c.persona_id) ? " active" : "";
    return `<div class="conv-item${active}" data-persona-id="${c.persona_id}" onclick="PawzoChat.openChat('${c.persona_id}')">
      ${avatarHtml(pname, "", avUrl)}
      <div class="conv-info">
        <div class="conv-name">${esc(pname)} ${wechatBadge}</div>
        ${conversationPreview(chatDraftKey(c.persona_id), preview)}
      </div>
      <div class="conv-meta"><div class="conv-time">${time}</div></div>
    </div>`;
  }).join("");

  target.innerHTML = `<div class="page" id="conv-list-page" style="position:relative">${searchHtml}<div class="card" id="conv-list-items">${listHtml}</div>
    <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none">i*w*y*x*d*x*l</div>
  </div>`;
}

export { renderChatList };

export function filterConvs(val) {
  const items = document.querySelectorAll(".conv-item");
  const v = val.toLowerCase();
  items.forEach(el => {
    const name = el.querySelector(".conv-name").textContent.toLowerCase();
    el.style.display = name.includes(v) ? "" : "none";
  });
}

function closeChatMenu(restoreFocus = false) {
  if (!_chatMenu) return;
  const { el, anchor, cleanup } = _chatMenu;
  _chatMenu = null;
  cleanup();
  el.remove();
  anchor?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && anchor?.isConnected) anchor.focus();
}

function openChatMenu(anchor, items, kind) {
  closeChatMenu();
  _closeQuotePop();
  const el = document.createElement('div');
  el.className = `moments-actions-pop chat-context-menu ${kind}`;
  el.setAttribute('role', 'menu');
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-btn';
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `${item.icon ? iconHtml(item.icon) : ''}<span>${esc(item.label)}</span>`;
    button.addEventListener('click', () => { closeChatMenu(kind === 'chat-launch-menu'); item.action(); });
    el.appendChild(button);
  }
  document.body.appendChild(el);
  anchor.setAttribute('aria-expanded', 'true');
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const edgeLeft = (viewport?.offsetLeft || 0) + 8;
  const edgeTop = (viewport?.offsetTop || 0) + 8;
  const edgeRight = edgeLeft + (viewport?.width || window.innerWidth) - 16;
  const edgeBottom = edgeTop + (viewport?.height || window.innerHeight) - 16;
  el.style.maxHeight = `${Math.max(44, edgeBottom - edgeTop)}px`;
  if (kind === 'chat-launch-menu') {
    el.style.left = `${rect.right - el.offsetWidth}px`;
    el.style.top = `${rect.bottom + 8}px`;
  } else placeActionsPop(el, rect, false);
  el.style.left = `${Math.max(edgeLeft, Math.min(parseFloat(el.style.left), edgeRight - el.offsetWidth))}px`;
  el.style.top = `${Math.max(edgeTop, Math.min(parseFloat(el.style.top), edgeBottom - el.offsetHeight))}px`;
  const outside = event => {
    if (!el.contains(event.target) && !anchor.contains(event.target)) closeChatMenu();
  };
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeChatMenu(true); }
    if (event.key === 'Tab') closeChatMenu();
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...el.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  };
  const dismiss = () => closeChatMenu();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keydown);
  window.addEventListener('resize', dismiss);
  window.addEventListener('scroll', dismiss, true);
  _chatMenu = { el, anchor, cleanup() {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keydown);
    window.removeEventListener('resize', dismiss);
    window.removeEventListener('scroll', dismiss, true);
  } };
  el.querySelector('button')?.focus({ preventScroll: true });
}

export function newConversation(anchor) {
  anchor ||= document.querySelector('[data-new-conversation]');
  if (!anchor) return;
  if (_chatMenu?.anchor === anchor) { closeChatMenu(); return; }
  openChatMenu(anchor, [
    { label: '选择聊天角色', icon: 'ri-chat-3-line', action: selectChatPersona },
    { label: '创建群聊', icon: 'ri-group-line', action: openCreateGroupDialog },
  ], 'chat-launch-menu');
}

export async function selectChatPersona() {
  closeChatMenu();
  const page = state.pageStack.at(-1);
  const tab = state.currentTab;
  try {
    const pres = await api.get("/api/personas");
    if (state.currentTab !== tab || state.pageStack.at(-1) !== page) return;
    state.personas = pres.personas || [];
  } catch (e) { toast("加载失败", "error"); return; }

  const convSet = new Set(state.conversations.map(c => c.persona_id));
  const items = state.personas.map(p => {
    const hasConv = convSet.has(p.id);
    const sub = hasConv ? "进入对话 →" : `${p.llm_provider}`;
    const avUrl = personaAvatarUrl(p);
    return `<div class="sheet-item" onclick="PawzoChat.startChat(${jsArg(p.id)}, ${hasConv})">
      ${avatarHtml(p.name, "sm", avUrl)}
      <div style="flex:1"><div style="font-weight:500">${esc(p.name)}</div><div style="font-size:12px;color:var(--text-3)">${esc(sub)}</div></div>
    </div>`;
  }).join("");

  showSheet(`<div class="sheet-title">选择聊天角色</div>${items || '<div class="sheet-item">请先在通讯录中创建角色</div>'}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
}

export async function startChat(personaId, hasConv) {
  closeOverlay();
  const stack = state.pageStack;
  const page = stack.at(-1);
  const stillOnPage = () => state.pageStack === stack && state.pageStack.at(-1) === page;
  if (!hasConv) {
    showLoading("创建中…");
    try {
      const res = await api.post("/api/conversations", { persona_id: personaId });
      // The list may be stale, or another client may have created this chat.
      // A conflict means we can enter the existing conversation.
      if (res.status >= 400 && res.status !== 409) {
        toast(res.data?.error || "创建失败", "error");
        return;
      }
      // Successful writes already invalidate via the API fetch hook.
      if (res.status === 409) api.invalidate("/api/conversations");
      if (!stillOnPage()) return;
      if (isDesktop() || !state.pageStack.length) await renderChatList();
      if (!stillOnPage()) {
        // Navigation may have cached the list's temporary loading state.
        api.invalidate("/api/conversations");
        return;
      }
    } catch (e) {
      toast("创建失败", "error");
      return;
    } finally {
      hideLoading();
    }
  }
  openChat(personaId);
}

export async function openGroupChat(groupId) {
  state.pageStack = [];
  pushPage("chatWindow", { groupId });
  if (isDesktop()) {
    document.querySelectorAll("#sidebar-body .conv-item").forEach(el => {
      el.classList.toggle("active", el.dataset.groupId === groupId);
    });
  }
}

export async function openChat(personaId) {
  state.pageStack = [];
  pushPage("chatWindow", { personaId });

  if (isDesktop()) {
    document.querySelectorAll("#sidebar-body .conv-item").forEach(el => {
      el.classList.toggle("active", el.dataset.personaId === personaId);
    });
  }
}

function renderContentBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];
  const emojiBlocks = blocks.filter(b => b.type === "emoji");
  if (emojiBlocks.length > 0) {
    const base = window.PAWZOCHAT_BASE || "";
    return emojiBlocks
      .map(b => `<div class="msg-emoji"><img src="${esc(base + b.url)}" alt="emoji" loading="lazy" onclick="PawzoChat.openImagePreview(this.src)"></div>`)
      .join("");
  }
  const base = window.PAWZOCHAT_BASE || "";
  let parts = "";
  for (const b of blocks) {
    if (b.type === "image") {
      let src = "";
      if (b.url) {
        src = /^(https?:|blob:)/i.test(b.url) ? b.url : base + b.url;
      } else if (b.path) {
        const filename = b.path.split(/[\\/]/).pop();
        src = mediaUrl("images", filename);
      }
      if (src) {
        parts += `<div class="msg-image"><img src="${esc(src)}" alt="image" loading="lazy" onclick="PawzoChat.openImagePreview(this.src)"></div>`;
      }
    } else if (b.type === "file") {
      const diskName = (b.path || "").split(/[\\/]/).pop() || "";
      const displayName = b.name || diskName || "文件";
      const href = diskName ? mediaUrl("files", diskName) : "#";
      parts += `<a class="msg-file" href="${esc(href)}" download="${esc(displayName)}" title="${esc(displayName)}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="msg-file-name">${esc(displayName)}</span>
        <svg class="msg-file-dl" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </a>`;
    } else if (b.type === "voice") {
      const fname = (b.path || "").split(/[\\/]/).pop() || "";
      const src = fname ? mediaUrl("voice", fname) : "";
      if (src) {
        const secs = Math.max(1, Math.round((b.duration_ms || 0) / 1000));
        const voiceKey = `${chatGroupId ? "group:" + chatGroupId : chatPersonaId || ""}/${fname}`;
        const transcript = b.text || "";
        const expanded = _expandedVoiceTranscripts.has(voiceKey);
        // WeChat-style: the longer the duration, the wider the bubble (fixed
        // pixel width — the parent container is a shrink-to-fit flex item, so
        // a percentage width would collapse to the minimum content width)
        const width = Math.min(220, 84 + secs * 6);
        parts += `<div class="msg-voice-wrap" data-voice-key="${escAttr(voiceKey)}">
          <div class="msg-voice${_voiceAudio && !_voiceAudio.paused && _voiceAudio.getAttribute("src") === src ? " playing" : ""}" style="width:${width}px" data-src="${escAttr(src)}" data-transcript="${escAttr(transcript)}" onclick="PawzoChat.playVoiceMessage(this)">
            <svg class="msg-voice-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path class="v1" d="M8.5 9.5a4 4 0 010 5"/><path class="v2" d="M11.5 7a8 8 0 010 10"/><path class="v3" d="M14.5 4.5a12.5 12.5 0 010 15"/></svg>
            <span class="msg-voice-dur">${secs}″</span>
          </div>
          <div class="msg-voice-transcript"${expanded ? "" : " hidden"}>${esc(transcript)}</div>
        </div>`;
      }
    } else if (b.type === "text" && b.text) {
      parts += `<div class="msg-bubble">${esc(b.text)}</div>`;
    }
  }
  if (!parts) {
    const text = blocks.map(c => c.text || "").join("");
    return `<div class="msg-bubble">${esc(text)}</div>`;
  }
  return parts;
}

// ---- Voice bubble playback (singleton Audio; playing a new one auto-stops the previous) ----
let _voiceAudio = null;
let _voiceEl = null;

export function playVoiceMessage(el) {
  if (el === _suppressedVoiceEl) {
    _suppressedVoiceEl = null;
    return;
  }
  const src = el?.dataset?.src;
  if (!src) return;
  if (_voiceAudio && _voiceAudio.getAttribute("src") === src && !_voiceAudio.paused) {
    // Clicking the same one again = stop
    _voiceAudio.pause();
    _clearVoicePlaying();
    return;
  }
  _clearVoicePlaying();
  if (!_voiceAudio) _voiceAudio = new Audio();
  _voiceAudio.onended = _voiceAudio.onerror = () => {
    _clearVoicePlaying();
  };
  _voiceAudio.src = src;
  _voiceEl = el;
  el.classList.add("playing");
  _voiceAudio.play().catch(() => {
    el.classList.remove("playing");
    if (_voiceEl === el) _voiceEl = null;
  });
}

function _clearVoicePlaying() {
  if (_voiceEl) _voiceEl.classList.remove("playing");
  $("chat-msgs")?.querySelectorAll(".msg-voice.playing").forEach(el => el.classList.remove("playing"));
  _voiceEl = null;
}

/* ---- Quoted-message bubble + long-press quote ---- */

// WeChat-style gray quote box rendered below a message that quotes another.

// Extract the quotable text of a rendered message row from the DOM. Reading
// textContent (rather than a data-attribute) sidesteps attribute-escaping and
// always yields the original text; the ``.msg-quote`` box is excluded so
// quoting a reply quotes its own text, not what it already quoted.
function _quoteTextFromRow(row) {
  const bubbles = row.querySelectorAll(".msg-bubble");
  if (bubbles.length) {
    return Array.from(bubbles).map(b => b.textContent).join("\n").trim();
  }
  if (row.querySelector(".msg-emoji")) return "[表情]";
  if (row.querySelector(".msg-image")) return "[图片]";
  if (row.querySelector(".msg-file, .msg-file-inline")) return "[文件]";
  const voice = row.querySelector(".msg-voice");
  if (voice) {
    const transcript = (voice.dataset.transcript || "").trim();
    return transcript ? `[语音] ${transcript}` : "[语音]";
  }
  return "";
}

function _voiceFromTarget(target) {
  const direct = target?.closest?.(".msg-voice");
  if (direct) return direct;
  return target?.closest?.(".msg-voice-wrap")?.querySelector(".msg-voice") || null;
}

function _quoteTextFromVoice(voiceEl) {
  const transcript = (voiceEl?.dataset?.transcript || "").trim();
  return transcript ? `[语音] ${transcript}` : "[语音]";
}

function _closeQuotePop() {
  if (_quotePop.el) {
    try { _quotePop.el.remove(); } catch (e) { /* ignore */ }
  }
  if (_quotePop.outsideHandler) {
    document.removeEventListener("click", _quotePop.outsideHandler, true);
  }
  if (_quotePop.keyHandler) {
    document.removeEventListener("keydown", _quotePop.keyHandler);
  }
  _quotePop.el = null;
  _quotePop.quoteText = "";
  _quotePop.copyText = "";
  _quotePop.messageId = "";
  _quotePop.speakerId = "";
  _quotePop.speakerName = "";
  _quotePop.voiceEl = null;
  _quotePop.outsideHandler = null;
  _quotePop.keyHandler = null;
  _ignoreNextDocClick = false;
}

// armIgnore: swallow the one trailing click a long-press *release* generates so
// the popup is not closed immediately. A right-click/contextmenu produces no
// such click, so it must NOT arm the flag (else the first dismiss click is
// wrongly eaten — and the popup needs two clicks to close).
function _openQuotePop(row, armIgnore, voiceEl = null) {
  closeChatMenu();
  _closeQuotePop();
  const quoteText = voiceEl ? _quoteTextFromVoice(voiceEl) : _quoteTextFromRow(row);
  if (!quoteText) return;
  // Copy only the message body, excluding quoted replies and media labels.
  const copyText = voiceEl ? (voiceEl.dataset.transcript || "") : Array.from(
    row.querySelectorAll(".msg-bubble, .msg-voice"),
    el => el.classList.contains("msg-voice") ? (el.dataset.transcript || "") : el.textContent,
  ).filter(text => text.trim()).join("\n");

  const isUser = row.classList.contains("user");
  const anchor = voiceEl || row.querySelector(
    ".msg-bubble, .msg-image, .msg-emoji, .msg-file, .msg-file-inline, .msg-voice",
  ) || row;
  const rect = anchor.getBoundingClientRect();

  const el = document.createElement("div");
  el.className = "moments-actions-pop";
  el.addEventListener("click", e => e.stopPropagation());
  let buttons = "";
  if (quoteText) {
    buttons += `<button class="map-btn" onclick="PawzoChat.quoteMessage()">${iconHtml("ri-chat-quote-line")}<span>引用</span></button>`;
  }
  if (copyText.trim() || voiceEl) {
    buttons += `<button class="map-btn" onclick="PawzoChat.copyMessage()">${iconHtml("ri-file-copy-line")}<span>复制</span></button>`;
  }
  if (voiceEl) {
    const transcriptEl = voiceEl.closest(".msg-voice-wrap")?.querySelector(".msg-voice-transcript");
    if (transcriptEl && !transcriptEl.hidden) {
      buttons += `<button class="map-btn" onclick="PawzoChat.toggleVoiceTranscript()">${iconHtml("ri-eye-close-line")}<span>收起文字</span></button>`;
    } else {
      buttons += `<button class="map-btn" onclick="PawzoChat.toggleVoiceTranscript()">${iconHtml("ri-file-text-line")}<span>转文字</span></button>`;
    }
  }
  el.innerHTML = buttons;
  document.body.appendChild(el);
  el.style.visibility = "hidden";
  requestAnimationFrame(() => {
    placeActionsPop(el, rect, /* preferLeft */ isUser);
    el.style.visibility = "";
  });

  _quotePop.el = el;
  _quotePop.quoteText = quoteText;
  _quotePop.copyText = copyText;
  _quotePop.messageId = row.dataset.messageId || "";
  _quotePop.speakerId = isUser ? "" : row.dataset.speakerId || "";
  _quotePop.speakerName = row.dataset.speakerName || "";
  _quotePop.voiceEl = voiceEl;
  _ignoreNextDocClick = !!armIgnore;
  _quotePop.outsideHandler = (e) => {
    if (_ignoreNextDocClick) { _ignoreNextDocClick = false; return; }
    if (_quotePop.el && !_quotePop.el.contains(e.target)) _closeQuotePop();
  };
  _quotePop.keyHandler = (e) => { if (e.key === "Escape") _closeQuotePop(); };
  setTimeout(() => {
    document.addEventListener("click", _quotePop.outsideHandler, true);
    document.addEventListener("keydown", _quotePop.keyHandler);
  }, 0);
}

function _cancelLongPress() {
  if (_lpTimer !== null) { clearTimeout(_lpTimer); _lpTimer = null; }
}

function _onMsgPointerDown(e) {
  if (e.button !== 0) return;  // primary button / touch only; right-click uses contextmenu
  _suppressedAvatar = null;
  const avatar = e.target.closest('.avatar');
  const member = avatar && groupMemberFromAvatar(avatar);
  if (avatar && !member) return;
  // A touch release synthesizes mousedown before click, even after a long
  // press focused the composer. Cancel that default at pointerdown so it
  // cannot steal focus / move the caret; ordinary avatar clicks still work.
  if (member) e.preventDefault();
  const row = e.target.closest(".msg-row");
  if (!row) return;
  _suppressedVoiceEl = null;
  _lpStartX = e.clientX;
  _lpStartY = e.clientY;
  _cancelLongPress();
  _lpTimer = setTimeout(() => {
    _lpTimer = null;
    if (!row.isConnected) return;
    if (member) {
      _suppressedAvatar = avatar;
      mentionGroupMember(member.id);
      return;
    }
    const voiceEl = _voiceFromTarget(e.target);
    if (voiceEl) _suppressedVoiceEl = voiceEl;
    _openQuotePop(row, /* armIgnore */ true, voiceEl);
  }, 500);
}

function _onMsgPointerMove(e) {
  if (_lpTimer === null) return;
  if (Math.abs(e.clientX - _lpStartX) > 10 || Math.abs(e.clientY - _lpStartY) > 10) {
    _cancelLongPress();
  }
}

function _onMsgContextMenu(e) {
  const avatar = e.target.closest('.avatar');
  if (avatar) {
    const member = groupMemberFromAvatar(avatar);
    if (!member) return;
    e.preventDefault();
    _cancelLongPress();
    if (_suppressedAvatar === avatar) return;
    if (e.pointerType === 'touch') {
      _suppressedAvatar = avatar;
      mentionGroupMember(member.id);
    } else openChatMenu(avatar, [{ label: `@${member.name}`, action: () => mentionGroupMember(member.id) }], 'chat-avatar-menu');
    return;
  }
  const row = e.target.closest(".msg-row");
  if (!row) return;
  const voiceEl = _voiceFromTarget(e.target);
  e.preventDefault();
  _cancelLongPress();  // don't let a pending long-press timer re-open over this
  if (_quotePop.el) return;  // a touch long-press may also fire contextmenu — don't reopen
  _openQuotePop(row, /* armIgnore */ false, voiceEl);
}

// Tapping an avatar in the message stream opens its owner's page: the persona
// detail for the assistant, the user's own profile for the self side.
function _onMsgAvatarClick(e) {
  const av = e.target.closest(".avatar");
  if (!av) return;
  if (_suppressedAvatar === av) {
    _suppressedAvatar = null;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const row = av.closest(".msg-row");
  if (!row) return;
  if (row.classList.contains("assistant")) {
    const personaId = row.dataset.speakerId || chatPersonaId;
    if (personaId && state.personas.some(p => p.id === personaId)) pushPage("personaDetail", { personaId });
  } else {
    pushPage("profileEdit");
  }
}

function _setupLongPress(msgsEl) {
  if (!msgsEl) return;
  msgsEl.addEventListener("pointerdown", _onMsgPointerDown);
  msgsEl.addEventListener("pointermove", _onMsgPointerMove);
  msgsEl.addEventListener("pointerup", _cancelLongPress);
  msgsEl.addEventListener("pointercancel", _cancelLongPress);
  msgsEl.addEventListener("contextmenu", _onMsgContextMenu);
  msgsEl.addEventListener("click", _onMsgAvatarClick);
  msgsEl.addEventListener('keydown', e => {
    if (!e.target.closest('.avatar')) return;
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) _onMsgContextMenu(e);
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _onMsgAvatarClick(e); }
  });
  msgsEl.addEventListener("scroll", () => { _cancelLongPress(); _closeQuotePop(); closeChatMenu(); }, { passive: true });
}

function groupMemberFromAvatar(avatar) {
  if (!chatGroupId) return null;
  const row = avatar.closest('.msg-row.assistant');
  const id = row?.dataset.speakerId;
  if (!_currentGroup?.members?.some(member => member.persona_id === id)) return null;
  return state.personas.find(persona => persona.id === id) || null;
}

function groupMentionMembers() {
  return (_currentGroup?.members || [])
    .map(member => state.personas.find(persona => persona.id === member.persona_id))
    .filter(Boolean);
}

export function mentionGroupMember(personaId, range = null) {
  const input = $('chat-input');
  const members = groupMentionMembers();
  const persona = personaId === MENTION_ALL_ID && members.length
    ? { name: '所有人' } : members.find(member => member.id === personaId);
  if (!input || !chatGroupId || !persona) return;
  closeChatMenu();
  _closeQuotePop();
  _mentionPicker?.close();
  const result = _mentions.insert(input.value, range?.start ?? input.selectionStart, range?.end ?? input.selectionEnd, personaId, persona.name);
  input.value = result.text;
  _mentionEdit = null;
  onChatInput();
  input.focus({ preventScroll: true });
  input.setSelectionRange(result.caret, result.caret);
  _mentionPicker?.close();
}

function _renderQuotePreview() {
  const bar = $("quote-preview-bar");
  if (!bar) return;
  if (!_pendingQuote) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = `<div class="quote-preview-text">${esc(_pendingQuote)}</div>
    <button class="quote-preview-remove" onclick="PawzoChat.clearPendingQuote()" title="取消引用">&times;</button>`;
}

// Invoked by the popup's "引用" button — arm the pending quote for the next send.
export function quoteMessage() {
  const q = _quotePop.quoteText || "";
  const messageId = _quotePop.messageId;
  const speakerId = _quotePop.speakerId;
  const speakerName = _quotePop.speakerName;
  _closeQuotePop();
  if (!q) return;
  _pendingQuote = chatGroupId && speakerName ? `${speakerName}：${q}` : q;
  _pendingReplyId = chatGroupId ? messageId : "";
  _renderQuotePreview();
  const inp = $("chat-input");
  if (inp) inp.focus();
  // Prepend through the existing mention flow to preserve drafts and bind by ID.
  if (chatGroupId && speakerId && inp && !_mentions.ids(inp.value, groupMentionMembers()).includes(speakerId)) {
    mentionGroupMember(speakerId, { start: 0, end: 0 });
  }
}

export async function copyMessage() {
  const text = _quotePop.copyText;
  _closeQuotePop();
  if (!text.trim()) {
    toast("暂无可复制的文本");
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    // Support HTTP deployments and browsers that deny Clipboard API access.
    const active = document.activeElement;
    const inputSelection = typeof active?.selectionStart === "number"
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const selection = window.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;font-size:16px";
    document.body.appendChild(textarea);
    let copied = false;
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      copied = document.execCommand("copy");
    } catch { /* Report failure below; always restore focus and selection. */ }
    finally {
      textarea.remove();
      if (active?.isConnected) active.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        ranges.forEach(range => selection.addRange(range));
      }
      // DOM ranges do not preserve a textarea/input's caret or selection.
      if (active?.isConnected && inputSelection) active.setSelectionRange(...inputSelection);
    }
    if (!copied) {
      toast("复制失败，请重试", "error");
      return;
    }
  }
  toast("已复制");
}

export function toggleVoiceTranscript() {
  const voiceEl = _quotePop.voiceEl;
  const wrap = voiceEl?.closest(".msg-voice-wrap");
  const transcriptEl = wrap?.querySelector(".msg-voice-transcript");
  if (!wrap || !transcriptEl) {
    _closeQuotePop();
    return;
  }
  const visible = transcriptEl.hidden;
  const key = wrap.dataset.voiceKey || "";
  transcriptEl.hidden = !visible;
  if (key) {
    if (visible) _expandedVoiceTranscripts.add(key);
    else _expandedVoiceTranscripts.delete(key);
  }
  _closeQuotePop();
}

export function clearPendingQuote() {
  _pendingQuote = "";
  _pendingReplyId = "";
  _renderQuotePreview();
}

/* ---- Chat Window ---- */

async function renderChatWindow(data) {
  closeChatMenu();
  const generation = ++_chatWindowGeneration;
  chatPersonaId = data.personaId || null;
  chatGroupId = data.groupId || null;
  const draftKey = chatDraftKey(chatPersonaId, chatGroupId);
  _currentGroup = null;
  setPageCleanup(() => { ++_chatWindowGeneration; chatPersonaId = chatGroupId = null; });
  if (chatGroupId) {
    content().innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
    try {
      const group = await api.get(`/api/groups/${encodeURIComponent(chatGroupId)}`, { bypassCache: true });
      if (generation !== _chatWindowGeneration) return;
      if (group.error) throw new Error(group.error);
      _currentGroup = group;
    } catch (error) {
      if (generation !== _chatWindowGeneration) return;
      content().innerHTML = '<div class="empty-state">群聊不存在或加载失败</div>';
      toast(error.message || '加载失败', 'error');
      return;
    }
  }
  setTopBar(chatTitle(), true,
    `<button class="top-btn" onclick="PawzoChat.chatMore()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
    </button>`
  );

  const draft = _chatDrafts.get(draftKey);
  _chatDrafts.delete(draftKey);
  refreshChatDraftPreviews();
  _pendingImages = (draft?.images || []).map(file => ({ file, url: URL.createObjectURL(file) }));
  _pendingFiles = draft?.files || [];
  _pendingQuote = draft?.quote || "";
  _pendingReplyId = draft?.replyId || "";
  _mentions = draft?.mentions || new ChatMentions();
  _mentionEdit = null;
  _closeQuotePop();  // never let a popup (in document.body) outlive the chat that spawned it
  content().innerHTML = `<div class="chat-container">
    <div class="chat-message-pane">
      <div class="chat-messages" id="chat-msgs"></div>
      <button class="chat-to-bottom" id="chat-to-bottom" type="button" aria-label="回到底部" hidden>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 9l5 5 5-5M7 15l5 5 5-5"/></svg>
        <span>回到底部</span><span class="chat-unread-count" id="chat-unread-count" hidden></span>
      </button>
    </div>
    <div id="img-preview-bar" class="img-preview-bar" style="display:none"></div>
    <div id="file-preview-bar" class="file-preview-bar" style="display:none"></div>
    <div id="quote-preview-bar" class="quote-preview-bar" style="display:none"></div>
    <div id="emoji-picker-panel" class="emoji-picker-panel" style="display:none"></div>
    <div id="plus-menu-panel" class="plus-menu-panel" style="display:none"></div>
    <div class="chat-input-bar">
      <button class="img-upload-btn" id="emoji-picker-btn" onclick="PawzoChat.toggleEmojiPicker()" title="表情">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      </button>
      <button class="img-upload-btn" id="plus-menu-btn" onclick="PawzoChat.togglePlusMenu()" title="更多">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="7" x2="12" y2="17"/><line x1="7" y1="12" x2="17" y2="12"/></svg>
      </button>
      <textarea class="chat-input" id="chat-input" rows="1" placeholder="输入消息…" oninput="PawzoChat.onChatInput()" onkeydown="PawzoChat.onChatKey(event)"></textarea>
      <button class="send-btn" id="send-btn" onclick="PawzoChat.sendChat()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>
    <input type="file" id="img-file-input" accept="image/*" multiple style="display:none" onchange="PawzoChat.onImageSelected(this)">
    <input type="file" id="file-file-input" multiple style="display:none" onchange="PawzoChat.onFileSelected(this)">
  </div>`;

  content().style.overflow = "hidden";

  const chatInput = $("chat-input");
  if (chatInput) {
    chatInput.value = draft?.text || "";
    _renderImagePreviews();
    _renderFilePreviews();
    _renderQuotePreview();
    onChatInput();
    if (draft) {
      chatInput.setSelectionRange(draft.selectionStart, draft.selectionEnd, draft.selectionDirection);
      chatInput.scrollTop = draft.scrollTop;
    }
    if (chatGroupId) _mentionPicker = new ChatMentionPicker({
      input: chatInput,
      getQuery: () => _mentions.suggestion(chatInput.value, chatInput.selectionStart, chatInput.selectionEnd),
      getMembers: groupMentionMembers,
      onSelect: (personaId, range) => mentionGroupMember(personaId, range),
    });
    chatInput.addEventListener('beforeinput', e => {
      _mentionEdit = { start: chatInput.selectionStart, end: chatInput.selectionEnd, inputType: e.inputType };
    });
    chatInput.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) _addPendingImage(file);
        }
      }
    });
  }

  const chatContainer = content().querySelector(".chat-container");
  if (chatContainer) {
    chatContainer.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
    chatContainer.addEventListener("drop", e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer?.files) {
        for (const f of e.dataTransfer.files) {
          if (f.type.startsWith("image/")) _addPendingImage(f);
          else _addPendingFile(f);
        }
      }
    });
  }

  document.addEventListener("click", _onDocumentClickForPicker);
  _setupLongPress($("chat-msgs"));

  const emojiPanel = $("emoji-picker-panel");
  if (emojiPanel) {
    emojiPanel.addEventListener("click", e => e.stopPropagation());
  }

  _emojiPickerOpen = false;
  _emojiGroups = null;
  _emojiGroupCache = {};
  _emojiActiveTab = 0;
  _plusMenuOpen = false;

  const history = _history = new ChatHistory({
    el: $("chat-msgs"), personaId: chatPersonaId, messagesUrl: chatGroupId ? `/api/groups/${encodeURIComponent(chatGroupId)}/messages` : undefined, renderItem: renderMessage,
    onDistanceChange: distance => {
      const button = $("chat-to-bottom");
      if (button) button.hidden = distance <= 300;
    },
    onUnread: count => {
      const badge = $("chat-unread-count");
      if (badge) { badge.hidden = !count; badge.textContent = count > 99 ? "99+" : String(count); }
      $("chat-to-bottom")?.setAttribute("aria-label", count ? `回到底部，${count}条新消息` : "回到底部");
    },
    onError: message => toast(message),
    onState: chatGroupId ? updateGroupState : undefined,
  });
  history.groupId = chatGroupId;
  $("chat-to-bottom").addEventListener("click", () => history.goToBottom());
  setPageCleanup(() => {
    saveChatDraft(draftKey, chatInput);
    ++_chatWindowGeneration;
    history.destroy();
    if (_history === history) { _history = null; chatPersonaId = chatGroupId = null; _currentGroup = null; }
    _cancelLongPress();
    _closeQuotePop();
    closeChatMenu();
    _mentionPicker?.destroy();
    _mentionPicker = null;
    _mentions = new ChatMentions();
    _mentionEdit = null;
    _suppressedAvatar = null;
    document.removeEventListener("click", _onDocumentClickForPicker);
    _voiceAudio?.pause();
    _clearVoicePlaying();
    _expandedVoiceTranscripts.clear();
    for (const url of _chatObjectUrls) URL.revokeObjectURL(url);
    for (const img of _pendingImages) URL.revokeObjectURL(img.url);
    _chatObjectUrls.clear();
    _pendingImages = [];
    _pendingFiles = [];
    _pendingQuote = "";
    _pendingReplyId = "";
  });
  if (!chatGroupId && state.processingPersonas.has(chatPersonaId)) showTypingIndicator();
  history.draftValidation = validateChatAttachments(history);
}

function removeUnavailableChatAttachments(unavailable) {
  const bad = new Set(unavailable);
  for (const image of _pendingImages) if (bad.has(image)) URL.revokeObjectURL(image.url);
  _pendingImages = _pendingImages.filter(item => !bad.has(item));
  _pendingFiles = _pendingFiles.filter(item => !bad.has(item));
  _renderImagePreviews();
  _renderFilePreviews();
  onChatInput();
}

async function validateChatAttachments(history) {
  const { unavailable } = await prepareDraftAttachments([..._pendingImages, ..._pendingFiles]);
  if (_history !== history || history.destroyed) return false;
  // The send preflight owns validation once it has captured the composer.
  if (history.preparingSend) return true;
  const remaining = unavailable.filter(item => _pendingImages.includes(item) || _pendingFiles.includes(item));
  if (remaining.length) removeUnavailableChatAttachments(remaining);
  return true;
}

function renderMessage(m, previous) {
  const speakerId = chatGroupId ? m.speaker_id : chatPersonaId;
  const persona = state.personas.find(p => p.id === speakerId);
  const base = window.PAWZOCHAT_BASE || "";
  const assistant = m.role === "assistant";
  const speakerName = assistant ? m.speaker_name || persona?.name || speakerId || '已移除角色' : state.profile?.name || '我';
  let avatar = assistant
    ? avatarHtml(speakerName, "sm", personaAvatarUrl(persona))
    : avatarHtml(state.profile?.name || "我", "sm", state.profile?.has_avatar ? `${base}/api/profile/avatar` : "");
  if (chatGroupId && assistant) avatar = avatar.replace('<div ', `<div tabindex="0" role="button" aria-label="${escAttr(speakerName)}的头像" title="长按或右键 @${escAttr(speakerName)}" `);
  const showTime = !previous || new Date(m.timestamp) - new Date(previous.timestamp) > 300000;
  return `${showTime ? `<div class="msg-time">${formatMsgTime(m.timestamp)}</div>` : ""}
    <div class="msg-row ${assistant ? "assistant" : "user"}" data-message-id="${escAttr(m.local_id || '')}" data-speaker-id="${escAttr(speakerId || '')}" data-speaker-name="${escAttr(speakerName)}">
      ${avatar}<div>${chatGroupId && assistant ? `<div class="group-speaker-name">${esc(speakerName)}</div>` : ''}${renderContentBlocks(m.content || [])}
      ${renderQuoteBox(m.quote, m.quote_media || [], m.local_id, chatPersonaId, chatGroupId)}
      ${sourceBadge(m.source)}${m._failed ? '<div class="msg-send-failed">发送失败</div>' : ""}</div>
    </div>`;
}

function optimisticMessage(history, content, quote = "", metadata = {}) {
  return history.optimistic({ local_id: `pending:${++_temporaryMessage}`,
    role: "user", source: "web", timestamp: new Date().toISOString(), content, quote, ...metadata });
}

export function onChatInput() {
  const inp = $("chat-input");
  const btn = $("send-btn");
  if (!inp || !btn) return;
  _mentions.sync(inp.value, _mentionEdit);
  _mentionEdit = null;
  inp.style.height = "auto";
  inp.style.height = Math.min(inp.scrollHeight, 100) + "px";
  btn.classList.toggle("active", inp.value.trim().length > 0 || _pendingImages.length > 0 || _pendingFiles.length > 0);
  _mentionPicker?.update();
}

export function onChatKey(e) {
  if (_mentionPicker?.handleKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendChat(); }
}

export function pickImage() {
  const input = $("img-file-input");
  if (input) input.click();
}

export function onImageSelected(input) {
  if (!input.files) return;
  for (const f of input.files) {
    if (f.type.startsWith("image/")) _addPendingImage(f);
  }
  input.value = "";
}

function _addPendingImage(file) {
  const url = URL.createObjectURL(file);
  _pendingImages.push({ file, url });
  _renderImagePreviews();
  onChatInput();
}

export function removePendingImage(idx) {
  const removed = _pendingImages.splice(idx, 1);
  if (removed[0]) URL.revokeObjectURL(removed[0].url);
  _renderImagePreviews();
  onChatInput();
}

function _renderImagePreviews() {
  const bar = $("img-preview-bar");
  if (!bar) return;
  if (_pendingImages.length === 0) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = _pendingImages.map((img, i) =>
    `<div class="img-preview-thumb">
      <img src="${img.url}" alt="preview">
      <button class="img-preview-remove" onclick="PawzoChat.removePendingImage(${i})">&times;</button>
    </div>`
  ).join("");
}

export function pickFile() {
  const input = $("file-file-input");
  if (input) input.click();
}

export function onFileSelected(input) {
  if (!input.files) return;
  for (const f of input.files) {
    if (f.type.startsWith("image/")) _addPendingImage(f);
    else _addPendingFile(f);
  }
  input.value = "";
}

function _addPendingFile(file) {
  _pendingFiles.push({ file, name: file.name });
  _renderFilePreviews();
  onChatInput();
}

export function removePendingFile(idx) {
  _pendingFiles.splice(idx, 1);
  _renderFilePreviews();
  onChatInput();
}

function _renderFilePreviews() {
  const bar = $("file-preview-bar");
  if (!bar) return;
  if (_pendingFiles.length === 0) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = _pendingFiles.map((f, i) =>
    `<div class="file-preview-chip">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="file-preview-name">${esc(f.name)}</span>
      <button class="file-preview-remove" onclick="PawzoChat.removePendingFile(${i})">&times;</button>
    </div>`
  ).join("");
}

export async function sendChat() {
  const history = _history;
  const inp = $("chat-input");
  if (!history || !inp || history.preparingSend) return;
  if (history.groupId && !_currentGroup?.members?.length) { toast("请先为群聊添加角色"); return; }
  history.preparingSend = true;
  const originalText = inp.value, originalQuote = _pendingQuote, originalReply = _pendingReplyId;
  const originalImages = [..._pendingImages], originalFiles = [..._pendingFiles];
  let prepared;
  try {
    const valid = await history.draftValidation;
    history.draftValidation = null;
    if (valid === false || history.destroyed || _history !== history) return;
    prepared = await prepareDraftAttachments([...originalImages, ...originalFiles]);
    if (history.destroyed || _history !== history) return;
    // Reading files can take time. Never send stale text or clear newer edits.
    if (inp.value !== originalText || _pendingQuote !== originalQuote || _pendingReplyId !== originalReply
        || originalImages.length !== _pendingImages.length || originalFiles.length !== _pendingFiles.length
        || originalImages.some((item, i) => item !== _pendingImages[i])
        || originalFiles.some((item, i) => item !== _pendingFiles[i])) {
      toast('草稿已修改，请重新发送', 'info');
      return;
    }
    if (prepared.unavailable.length) removeUnavailableChatAttachments(prepared.unavailable);
  } finally { history.preparingSend = false; }
  const snapshots = new Map(prepared.ready.map(({ item, file }) => [item, file]));
  const text = inp.value.trim();
  const images = [..._pendingImages], files = [..._pendingFiles], quote = _pendingQuote;
  const mentions = history.groupId ? _mentions.ids(inp.value, groupMentionMembers()) : [], replyId = _pendingReplyId;
  if (!text && !images.length && !files.length) return;
  const blocks = [];
  if (text) blocks.push({ type: "text", text });
  for (const img of images) { blocks.push({ type: "image", url: img.url }); _chatObjectUrls.add(img.url); }
  for (const file of files) blocks.push({ type: "file", name: file.name });
  const key = optimisticMessage(history, blocks, quote, history.groupId ? { mentions, reply_to_message_id: replyId } : {});
  inp.value = "";
  _pendingImages = []; _pendingFiles = []; _pendingQuote = ""; _pendingReplyId = "";
  _mentions.reset(); _mentionEdit = null;
  onChatInput();
  _renderImagePreviews(); _renderFilePreviews(); _renderQuotePreview();
  try {
    let status, result;
    const url = history.messagesUrl;
    const groupPayload = history.groupId ? {
      client_message_id: (globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`), mentions, reply_to_message_id: replyId || "",
    } : {};
    if (images.length || files.length) {
      const body = new FormData();
      body.append("text", text);
      if (history.groupId) {
        body.append("client_message_id", groupPayload.client_message_id);
        body.append("mentions", JSON.stringify(mentions));
        if (replyId) body.append("reply_to_message_id", replyId);
      }
      if (quote) body.append("quote", quote);
      for (const img of images) body.append("images", snapshots.get(img));
      for (const file of files) body.append("files", snapshots.get(file));
      const response = await fetch((window.PAWZOCHAT_BASE || "") + url, { method: "POST", body });
      status = response.status; result = await response.json();
    } else {
      const response = await api.post(url, { text, ...(quote ? { quote } : {}), ...groupPayload });
      status = response.status; result = response.data;
    }
    if (status >= 400) throw new Error(result.error || "发送失败");
    if (result.persona_id && result.persona_id !== history.personaId) {
      history.acknowledge(key, null);
      if (!history.destroyed) toast("消息已转入其他对话");
    } else history.acknowledge(key, result.message);
    if (history.groupId && !history.destroyed) updateGroupState(result.state);
    for (const img of images) { URL.revokeObjectURL(img.url); _chatObjectUrls.delete(img.url); }
  } catch (error) {
    history.fail(key);
    if (!history.destroyed) toast(error.message || "网络错误", "error");
  }
}

export function showTypingIndicator() {
  if (chatGroupId) return;
  if (!state.settings?.reply?.show_typing_indicator) return;
  const el = $("top-bar-title");
  if (el) el.textContent = "对方正在输入…";
}

function hideTypingIndicator() {
  const el = $("top-bar-title");
  if (el) el.textContent = chatTitle();
}

export function appendAssistantMessage(message, isLast) {
  if (!_history) return;
  _history.receive(message);
  if (isLast) hideTypingIndicator();
  else showTypingIndicator();
}

/* ---- Emoji Picker ---- */

function _onDocumentClickForPicker(e) {
  if (!_emojiPickerOpen && !_plusMenuOpen) return;
  const emojiPanel = $("emoji-picker-panel");
  const emojiBtn = $("emoji-picker-btn");
  const plusPanel = $("plus-menu-panel");
  const plusBtn = $("plus-menu-btn");
  const hitEmoji = (emojiPanel && emojiPanel.contains(e.target)) || (emojiBtn && emojiBtn.contains(e.target));
  const hitPlus = (plusPanel && plusPanel.contains(e.target)) || (plusBtn && plusBtn.contains(e.target));
  if (!hitEmoji && !hitPlus) {
    _closeEmojiPicker();
    _closePlusMenu();
  }
}

function _closeEmojiPicker() {
  _emojiPickerOpen = false;
  const panel = $("emoji-picker-panel");
  if (panel) panel.style.display = "none";
  const btn = $("emoji-picker-btn");
  if (btn) btn.classList.remove("active");
}

export async function toggleEmojiPicker() {
  // close plus menu if open — only one panel at a time
  if (_plusMenuOpen) _closePlusMenu();

  if (_emojiPickerOpen) {
    _closeEmojiPicker();
    return;
  }
  _emojiPickerOpen = true;
  const btn = $("emoji-picker-btn");
  if (btn) btn.classList.add("active");

  if (!_emojiGroups) {
    try {
      const res = await api.get("/api/emoji/groups");
      _emojiGroups = (res.groups || []).filter(g => g.total_images > 0);
    } catch (e) {
      _emojiGroups = [];
    }
  }

  _emojiActiveTab = 0;
  _renderEmojiPicker();
}

function _renderEmojiPicker() {
  const panel = $("emoji-picker-panel");
  if (!panel) return;
  panel.style.display = "flex";

  const groups = _emojiGroups || [];
  let tabsHtml = `<button class="ep-tab${_emojiActiveTab === 0 ? " active" : ""}" onclick="PawzoChat.switchEmojiTab(0)">Emoji</button>`;
  groups.forEach((g, i) => {
    const idx = i + 1;
    tabsHtml += `<button class="ep-tab${_emojiActiveTab === idx ? " active" : ""}" onclick="PawzoChat.switchEmojiTab(${idx})">${esc(g.name)}</button>`;
  });

  panel.innerHTML = `<div class="ep-tabs">${tabsHtml}</div><div class="ep-content" id="ep-content"></div>`;

  if (_emojiActiveTab === 0) {
    _renderStandardEmojiGrid();
  } else {
    const group = groups[_emojiActiveTab - 1];
    if (group) _renderStickerGrid(group.name);
  }
}

export function switchEmojiTab(idx) {
  _emojiActiveTab = idx;
  _renderEmojiPicker();
}

function _renderStandardEmojiGrid() {
  const el = $("ep-content");
  if (!el) return;
  el.innerHTML = `<div class="emoji-grid">${
    _STANDARD_EMOJIS.map(e => `<button class="emoji-cell" onclick="PawzoChat.insertEmoji('${e}')">${e}</button>`).join("")
  }</div>`;
}

async function _renderStickerGrid(groupName) {
  const el = $("ep-content");
  if (!el) return;

  if (_emojiGroupCache[groupName]) {
    _renderStickerImages(el, _emojiGroupCache[groupName]);
    return;
  }

  el.innerHTML = `<div class="ep-loading"><div class="spinner"></div></div>`;
  try {
    const base = window.PAWZOCHAT_BASE || "";
    const res = await api.get(`/api/emoji/groups/${encodeURIComponent(groupName)}/all-images`);
    const images = res.images || [];
    _emojiGroupCache[groupName] = images;
    if (_emojiActiveTab > 0 && (_emojiGroups || [])[_emojiActiveTab - 1]?.name === groupName) {
      _renderStickerImages(el, images);
    }
  } catch (e) {
    el.innerHTML = `<div class="ep-empty">加载失败</div>`;
  }
}

function _renderStickerImages(el, images) {
  if (images.length === 0) {
    el.innerHTML = `<div class="ep-empty">暂无表情包</div>`;
    return;
  }
  const base = window.PAWZOCHAT_BASE || "";
  el.innerHTML = `<div class="sticker-grid">${
    images.map(img =>
      `<button class="sticker-cell" onclick="PawzoChat.sendSticker('${esc(img.url)}')"><img src="${esc(base + img.url)}" alt="${esc(img.filename)}" loading="lazy"></button>`
    ).join("")
  }</div>`;
}

/* ---- Plus Menu (图片 / 文件) ---- */

function _closePlusMenu() {
  _plusMenuOpen = false;
  const panel = $("plus-menu-panel");
  if (panel) panel.style.display = "none";
  const btn = $("plus-menu-btn");
  if (btn) btn.classList.remove("active");
}

export function togglePlusMenu() {
  // close emoji picker if open — only one panel at a time
  if (_emojiPickerOpen) _closeEmojiPicker();

  if (_plusMenuOpen) { _closePlusMenu(); return; }
  _plusMenuOpen = true;
  const btn = $("plus-menu-btn");
  if (btn) btn.classList.add("active");

  const panel = $("plus-menu-panel");
  if (!panel) return;
  panel.style.display = "flex";
  panel.innerHTML = `
    <button class="plus-menu-item" onclick="PawzoChat.pickImage();PawzoChat.togglePlusMenu()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      <span>图片</span>
    </button>
    <button class="plus-menu-item" onclick="PawzoChat.pickFile();PawzoChat.togglePlusMenu()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span>文件</span>
    </button>`;
}

export function insertEmoji(emoji) {
  const inp = $("chat-input");
  if (!inp) return;
  const start = inp.selectionStart;
  const end = inp.selectionEnd;
  const before = inp.value.substring(0, start);
  const after = inp.value.substring(end);
  inp.value = before + emoji + after;
  const newPos = start + emoji.length;
  inp.selectionStart = newPos;
  inp.selectionEnd = newPos;
  inp.focus();
  onChatInput();
}

export async function sendSticker(stickerUrl) {
  _closeEmojiPicker();
  const history = _history;
  if (!history) return;
  if (history.groupId && !_currentGroup?.members?.length) { toast("请先为群聊添加角色"); return; }
  const metadata = history.groupId ? { client_message_id: (globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`), mentions: [], reply_to_message_id: _pendingReplyId, quote: _pendingQuote } : {};
  const key = optimisticMessage(history, [{ type: "image", url: stickerUrl }], metadata.quote || "", metadata);
  if (history.groupId) { clearPendingQuote(); onChatInput(); }
  try {
    const res = await api.post(history.messagesUrl, { sticker_url: stickerUrl, ...metadata });
    if (res.status >= 400) throw new Error(res.data?.error || "发送失败");
    const message = res.data.persona_id && res.data.persona_id !== history.personaId ? null : res.data.message;
    history.acknowledge(key, message);
    if (history.groupId && !history.destroyed) updateGroupState(res.data.state);
  } catch (error) {
    history.fail(key);
    if (!history.destroyed) toast(error.message || "网络错误", "error");
  }
}

/* ---- Chat Actions ---- */

export function chatMore() {
  if (chatGroupId) {
    showSheet(`<div class="sheet-title">群聊操作</div>
      <div class="sheet-item" onclick="PawzoChat.openGroupSettings(${jsArg(chatGroupId)})">${iconHtml('ri-group-line')}<span>群设置与成员</span></div>
      <div class="sheet-item" onclick="PawzoChat.stopGroupChat()">${iconHtml('ri-stop-circle-line')}<span>停止本轮聊天</span></div>
      <div class="sheet-item" onclick="PawzoChat.openHistoryEdit()">${iconHtml('ri-edit-line')}<span>编辑历史消息</span></div>
      <div class="sheet-item" onclick="PawzoChat.clearChat()">${iconHtml('ri-delete-bin-line')}<span>清空聊天记录</span></div>
      <div class="sheet-item danger" onclick="PawzoChat.deleteChat()">${iconHtml('ri-close-line')}<span>删除群聊</span></div>
      <div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
    return;
  }
  const conv = state.conversations.find(c => c.persona_id === chatPersonaId);
  const linked = conv?.wechat_linked;
  let items = `
    <div class="sheet-item" onclick="PawzoChat.viewPersonaFromChat()">${iconHtml("ri-id-card-line")}<span>查看角色资料</span></div>
    <div class="sheet-item" onclick="PawzoChat.viewMemoryFromChat()">${iconHtml("ri-brain-line")}<span>查看记忆</span></div>
    <div class="sheet-item" onclick="PawzoChat.openHistoryEdit()">${iconHtml("ri-edit-line")}<span>编辑历史消息</span></div>
    <div class="sheet-item" onclick="PawzoChat.clearChat()">${iconHtml("ri-delete-bin-line")}<span>清空聊天记录</span></div>
    <div class="sheet-item danger" onclick="PawzoChat.deleteChat()">${iconHtml("ri-close-line")}<span>删除对话</span></div>
    <div class="sheet-divider"></div>`;

  if (linked) {
    items += `<div class="sheet-item danger" onclick="PawzoChat.unlinkWechat()">${iconHtml("ri-smartphone-line")}<span>断开账号链接</span></div>`;
  } else {
    items += `<div class="sheet-item" onclick="PawzoChat.linkWechat()">${iconHtml("ri-smartphone-line")}<span>链接聊天账号</span></div>`;
  }

  showSheet(`<div class="sheet-title">更多操作</div>${items}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
}

export async function clearChat() {
  const history = _history;
  if (!history) return;
  closeOverlay();
  const ok = await confirm("清空聊天记录", "消息将被永久删除，但对话会保留", true);
  if (!ok) return;
  showLoading("操作中…");
  try {
    const res = history.groupId ? await api.post(`/api/groups/${encodeURIComponent(history.groupId)}/clear`, {}) : await api.del(history.messagesUrl);
    if (res.status >= 400) throw new Error(res.data?.error || "清空失败");
    if (!history.destroyed) { history.reload(); if (history.groupId) refreshChatMessages(); }
    refreshSidebar();
    toast("已清空", "success");
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export async function deleteChat() {
  const history = _history;
  if (!history) return;
  closeOverlay();
  let deleteMemories = false;
  if (history.groupId) {
    const result = await confirmWithCheckbox('删除群聊', '群聊及聊天记录将永久删除，默认保留各角色的群聊记忆。', true, {
      label: '同时删除所有角色的本群记忆',
      hint: '包括已离群的角色。勾选后不可恢复。',
    });
    if (!result.confirmed) return;
    deleteMemories = result.checked;
  } else if (!await confirm('删除对话', '确认删除这个对话？', true)) return;
  if (history.destroyed) return;
  showLoading("删除中…");
  try {
    const res = await api.del(history.groupId ? `/api/groups/${encodeURIComponent(history.groupId)}` : `/api/conversations/${encodeURIComponent(history.personaId)}`,
      deleteMemories ? { delete_memories: true } : undefined);
    if (res.status >= 400) throw new Error(res.data?.error || "删除失败");
    toast("已删除", "success");
    if (_history === history) goBack();
    _chatDrafts.delete(chatDraftKey(history.personaId, history.groupId));
    refreshSidebar();
  } catch (e) { toast(e.message || "操作失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Channel account link ---- */

export async function linkWechat() {
  closeOverlay();
  try {
    const [acctRes, linkRes] = await Promise.all([
      api.get("/api/accounts"),
      api.get("/api/wechat-links"),
    ]);
    const accounts = acctRes.accounts || [];
    const links = linkRes.links || [];
    const linkMap = {};
    links.forEach(l => { linkMap[l.account_id] = l; });

    let items = accounts.map(a => {
      const linked = linkMap[a.bot_id];
      const chTag = a.channel_name ? `<span style="color:var(--text-3);font-size:12px;margin-left:4px">[${esc(a.channel_name)}]</span>` : "";
      const idHint = `<span style="color:var(--text-3);font-size:13px;margin-left:4px">(${esc(a.bot_id.substring(0, 10))}…)</span>`;
      const label = (a.note ? `${esc(a.note)} ${idHint}` : `${esc(a.bot_id.substring(0, 12))}…`) + chTag;
      if (linked && linked.persona_id !== chatPersonaId) {
        return `<div class="sheet-item disabled">${iconHtml("ri-smartphone-line")}<span>${label} — 已被「${esc(linked.persona_name)}」占用</span></div>`;
      }
      const statusCls = a.online ? "online" : "offline";
      return `<div class="sheet-item" onclick="PawzoChat.doLinkWechat(${jsArg(a.bot_id)})">${iconHtml("ri-smartphone-line")}<span class="account-status"><span class="presence-dot ${statusCls}"></span>${label}</span></div>`;
    }).join("");

    if (accounts.length === 0) items = `<div class="sheet-item disabled">还没有添加任何账号</div>`;
    showSheet(`<div class="sheet-title">选择聊天账号</div>${items}<div class="sheet-cancel" onclick="PawzoChat.closeOverlay()">取消</div>`);
  } catch (e) { toast("加载失败", "error"); }
}

export async function doLinkWechat(accountId) {
  closeOverlay();
  showLoading("操作中…");
  try {
    const res = await api.post(`/api/conversations/${chatPersonaId}/wechat-link`, { account_id: accountId });
    if (res.status >= 400) { toast(res.data.error, "error"); return; }
    toast("已链接账号", "success");
    const convRes = await api.get("/api/conversations");
    state.conversations = convRes.conversations || [];
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export async function unlinkWechat() {
  closeOverlay();
  const ok = await confirm("断开账号链接", "断开后该账号的消息将不再进入此对话", false);
  if (!ok) return;
  showLoading("操作中…");
  try {
    await api.del(`/api/conversations/${chatPersonaId}/wechat-link`);
    toast("已断开", "success");
    const convRes = await api.get("/api/conversations");
    state.conversations = convRes.conversations || [];
  } catch (e) { toast("操作失败", "error"); }
  finally { hideLoading(); }
}

export function viewPersonaFromChat() {
  closeOverlay();
  pushPage("personaDetail", { personaId: chatPersonaId });
}

export function viewMemoryFromChat() {
  closeOverlay();
  pushPage("memoryManage", { personaId: chatPersonaId });
}

export function openHistoryEdit() {
  closeOverlay();
  pushPage("historyEdit", { personaId: chatPersonaId, groupId: chatGroupId });
}

/* ---- SSE helper ---- */

export function refreshChatMessages() {
  if (!_history) return;
  // Also clear the indicator when a round ends without a final reply bubble
  // (for example a plugin cancels it), or after reconnecting to the event stream.
  hideTypingIndicator();
  const history = _history;
  if (history.groupId) refreshGroupDetails(history);
  return history.sync();
}

function updateGroupState(next) {
  if (!_currentGroup || !next) return;
  const previous = _currentGroup.state || {};
  if (Number(next.version ?? 0) < Number(previous.version ?? 0)) return;
  _currentGroup.state = { ...previous, ...next };
  if (next.error && next.error !== previous.error) toast(typeof next.error === 'string' ? next.error : '部分角色回复失败', 'error');
}

async function refreshGroupDetails(history) {
  try {
    const group = await api.get(`/api/groups/${encodeURIComponent(history.groupId)}`, { bypassCache: true });
    if (history.destroyed || _history !== history) return;
    if (group.error) { toast(group.error, "error"); goBack(); refreshSidebar(); return; }
    const latestState = _currentGroup?.state;
    _currentGroup = group;
    if (Number(latestState?.version || 0) > Number(group.state?.version || 0)) _currentGroup.state = latestState;
    _mentionPicker?.update();
    hideTypingIndicator();
  } catch (error) {
    if (!history.destroyed) toast('群聊状态同步失败，请刷新重试', 'error');
  }
}

export function handleGroupEvent(event) {
  if (!event.group_id) return;
  api.invalidate(k => k.startsWith('/api/groups'));
  if (event.group_id === chatGroupId && _history?.groupId === event.group_id) {
    updateGroupState(event.state);
    if (event.type === 'group_message' && event.message) _history.receive(event.message);
    if (event.type === 'group_turn') for (const message of event.messages || []) _history.receive(message);
    if (event.type === 'group_updated') {
      if (event.deleted) {
        goBack();
        _chatDrafts.delete(chatDraftKey(null, event.group_id));
        refreshSidebar();
        return;
      }
      if (event.history_changed) { _history.reload(); refreshGroupDetails(_history); }
      else refreshChatMessages();
    }
  }
  if (event.type === 'group_updated' && event.deleted) {
    _chatDrafts.delete(chatDraftKey(null, event.group_id));
  }
  if (state.currentTab === 'chat' && (isDesktop() || state.pageStack.length === 0)
      && ['group_message', 'group_turn', 'group_updated'].includes(event.type)) renderChatList();
}

export async function stopGroupChat() {
  closeOverlay();
  const history = _history;
  if (!history?.groupId) return;
  try {
    const response = await api.post(`/api/groups/${encodeURIComponent(history.groupId)}/stop`, {});
    if (response.status >= 400) throw new Error(response.data?.error || '停止失败');
    if (!history.destroyed) updateGroupState(response.data.state || response.data);
  } catch (error) {
    if (!history.destroyed) toast(error.message || '停止失败', 'error');
  }
}

/* ---- Register renderers ---- */

registerTabRenderer("chat", renderChatList, refreshChatDraftPreviews);
registerPageRenderer("chatWindow", renderChatWindow);
