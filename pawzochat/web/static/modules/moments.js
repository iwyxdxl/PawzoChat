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
/* Moments (朋友圈) — feed, publish, settings */

import { setPromptValue } from "./prompt_textarea.js";
import { snapshotDraftFile } from "./draft_attachments.js";
import { esc, iconHtml, avatarHtml, formatMsgTime, placeActionsPop } from "./utils.js";
import { api } from "./api.js";
import { state, $, content } from "./state.js";
import { toast, confirm, showSheet, closeOverlay, showLoading, hideLoading } from "./ui.js";
import { setTopBar, goBack, pushPage, registerPageRenderer, setPageCleanup } from "./navigation.js";

const BASE = () => window.PAWZOCHAT_BASE || "";

/* ---- Shared state across pages ---- */

const _list = {
  items: [],
  hasMore: true,
  loading: false,
  observer: null,
  inListPage: false,
};

const _state = {
  isGenerating: false,
  coverUrl: "",
  personasById: {},      // pid -> {id, name, has_avatar}
};

const newPublishDraft = () => ({ text: '', files: [], reading: 0, publishing: false, selection: null });
let _publish = newPublishDraft(); // Session-only; files contain memory-backed File snapshots.
let _publishEditor = null;

// One floating actions popup at a time. Closing handlers are mounted lazily.
const _pop = {
  el: null,
  mid: null,
  outsideHandler: null,
  keyHandler: null,
};

// At most one inline composer is open at a time.
const _composer = {
  mid: null,
  replyTo: null,         // reply id we're replying to, or null for top-level
  replyToLabel: "",
  activeRid: null,       // last-tapped reply id (highlights its "..." trigger)
  outsideHandler: null,  // mounted while open; closes on click outside
};

// Edit modal target: tracked here so the inline Save button (rendered into a
// `showSheet`-managed overlay) knows what id to PATCH against. Cleared on
// every open/close so a stale handler can't accidentally write the wrong row.
const _edit = {
  kind: null,    // "moment" | "reply"
  mid: null,
  rid: null,     // only set for reply edits
};

const _settings = {
  publishers: new Set(),
  repliers: new Set(),
  probabilities: {},      // pid -> int 0..100
  memoryEnabled: {},      // pid -> bool; missing → true
  promptPost: "",
  promptReply: "",
  promptCounterReply: "",
  promptPostDefault: "",
  promptReplyDefault: "",
  promptCounterReplyDefault: "",
  personas: [],
};

/* ---- Helpers ---- */

function _avatarUrl(author) {
  if (!author) return "";
  if (author === "user") return `${BASE()}/api/profile/avatar`;
  return `${BASE()}/api/personas/${encodeURIComponent(author)}/avatar`;
}

function _hasAvatar(author) {
  if (author === "user") return !!state.profile?.has_avatar;
  const p = _state.personasById[author];
  return !!(p && p.has_avatar);
}

function _avatarBlock(author, label) {
  const url = _hasAvatar(author) ? _avatarUrl(author) : "";
  return avatarHtml(label || "?", "sm", url);
}

function _imageUrl(momentId, filename) {
  return `${BASE()}/api/moments/images/${encodeURIComponent(momentId)}/${encodeURIComponent(filename)}`;
}

/* ---- List page ---- */

function _listActionsHtml(isGenerating) {
  const dis = isGenerating ? "disabled" : "";
  const refreshTitle = isGenerating ? "正在生成…" : "刷新";
  const publishTitle = isGenerating ? "正在生成…" : "发布";
  const refreshIconCls = isGenerating ? "is-spinning" : "";
  return `
    <button class="top-btn moments-action-btn" id="m-refresh-btn" title="${refreshTitle}" ${dis} onclick="PawzoChat.momentsRefresh()">
      ${iconHtml("ri-refresh-line", refreshIconCls)}
    </button>
    <button class="top-btn moments-action-btn" id="m-publish-btn" title="${publishTitle}" ${dis} onclick="PawzoChat.momentsOpenPublish()">
      ${iconHtml("ri-camera-line")}
    </button>
    <button class="top-btn moments-action-btn" title="设置" onclick="PawzoChat.pushPage('momentsSettings',{})">
      ${iconHtml("ri-settings-3-line")}
    </button>
  `;
}

function _setListActions() {
  const actions = $("top-bar-actions");
  if (actions) actions.innerHTML = _listActionsHtml(_state.isGenerating);
}

async function renderMomentsList() {
  _list.inListPage = true;
  _list.items = [];
  _list.hasMore = true;
  _list.loading = false;

  setTopBar("朋友圈", true, _listActionsHtml(_state.isGenerating));

  content().innerHTML = `
    <input type="file" id="m-cover-file" accept="image/*" style="display:none" onchange="PawzoChat.momentsOnCoverFile(event)">
    <div class="moments-page" style="position:relative">
      <div class="moments-cover" id="m-cover" onclick="PawzoChat.momentsPickCover()">
        <div class="moments-cover-hint">点击上传朋友圈封面</div>
      </div>
      <div class="moments-feed" id="m-feed">
        <div class="loading-center"><div class="spinner"></div></div>
      </div>
      <div class="moments-bottom-sentinel" id="m-sentinel"></div>
      <div class="moments-end" id="m-end" style="display:none">— 已经到底了 —</div>
      <div class="about-footer" aria-hidden="true" style="position:absolute;right:8px;bottom:4px;font-size:11px;line-height:1;color:var(--text-3);opacity:0.1;white-space:nowrap;pointer-events:none;user-select:none">i^w^y^x^d^x^l</div>
    </div>
  `;

  // Load state + first page + cover in parallel.
  try {
    const [stateRes, settingsRes, personasRes] = await Promise.all([
      api.get("/api/moments/state"),
      api.get("/api/moments/settings"),
      api.get("/api/personas"),
    ]);
    _state.isGenerating = !!stateRes.is_generating;
    _state.coverUrl = settingsRes.cover_url || "";
    _state.personasById = {};
    for (const p of (personasRes.personas || [])) _state.personasById[p.id] = p;
    _renderCover();
    _setListActions();
  } catch (e) {
    /* tolerate; continue with defaults */
  }

  await _loadNextPage(true);
  _setupObserver();
}

function _renderCover() {
  const el = $("m-cover");
  if (!el) return;
  const url = _state.coverUrl ? `${BASE()}${_state.coverUrl}?t=${Date.now()}` : "";
  if (url) {
    el.style.backgroundImage = `url('${url}')`;
    el.classList.add("has-image");
    el.innerHTML = `
      <button class="moments-cover-edit" onclick="event.stopPropagation();PawzoChat.momentsCoverMenu()" title="封面操作">
        ${iconHtml("ri-more-2-fill")}
      </button>`;
  } else {
    el.style.backgroundImage = "";
    el.classList.remove("has-image");
    el.innerHTML = `<div class="moments-cover-hint">点击上传朋友圈封面</div>`;
  }
}

async function _loadNextPage(isFirst) {
  if (_list.loading) return;
  if (!_list.hasMore && !isFirst) return;
  _list.loading = true;
  let url = "/api/moments?limit=20";
  if (!isFirst && _list.items.length > 0) {
    const oldestTs = _list.items[_list.items.length - 1].timestamp;
    url += `&before=${encodeURIComponent(oldestTs)}`;
  }
  try {
    const res = await api.get(url);
    const items = res.moments || [];
    if (isFirst) {
      _list.items = items;
    } else {
      const seen = new Set(_list.items.map(m => m.id));
      for (const it of items) if (!seen.has(it.id)) _list.items.push(it);
    }
    _list.hasMore = !!res.has_more;
    _renderItems();
  } catch (e) {
    toast("加载失败", "error");
  } finally {
    _list.loading = false;
  }
}

function _renderItems() {
  const feed = $("m-feed");
  if (!feed) return;
  if (_list.items.length === 0) {
    feed.innerHTML = `<div class="moments-empty">还没有朋友圈，点击右上角刷新或发布</div>`;
    const end = $("m-end"); if (end) end.style.display = "none";
    return;
  }
  // Snapshot composer state (text + caret) so SSE-triggered re-renders
  // don't drop what the user is currently typing.
  let preserved = null;
  if (_composer.mid) {
    const inp = document.getElementById(`m-comp-input-${_composer.mid}`);
    if (inp) {
      preserved = {
        mid: _composer.mid,
        value: inp.value,
        selStart: inp.selectionStart,
        selEnd: inp.selectionEnd,
        wasFocused: document.activeElement === inp,
      };
    }
  }
  feed.innerHTML = _list.items.map(_momentHtml).join("");
  const end = $("m-end");
  if (end) end.style.display = _list.hasMore ? "none" : "";
  if (preserved) {
    const inp = document.getElementById(`m-comp-input-${preserved.mid}`);
    if (inp) {
      inp.value = preserved.value;
      if (preserved.wasFocused) {
        inp.focus();
        try { inp.setSelectionRange(preserved.selStart, preserved.selEnd); } catch (e) { /* ignore */ }
      }
    }
  }
}

function _momentHtml(m) {
  const author = m.author || "";
  const label = m.author_label || author || "?";
  const time = formatMsgTime(m.timestamp);
  const imgs = (m.images || []).filter(Boolean);
  const imgGridClass =
    imgs.length === 1 ? "moments-imgs n1"
    : imgs.length === 2 ? "moments-imgs n2"
    : imgs.length === 4 ? "moments-imgs n4"
    : "moments-imgs n3";
  const imgsHtml = imgs.length === 0 ? "" : `
    <div class="${imgGridClass}">
      ${imgs.map(fn => {
        const url = _imageUrl(m.id, fn);
        return `<div class="moments-img" style="background-image:url('${url}')" onclick="PawzoChat.openImagePreview('${url}')"></div>`;
      }).join("")}
    </div>`;

  const likesList = m.likes || [];
  const likesHtml = likesList.length === 0 ? "" : `
    <div class="moments-likes">
      ${iconHtml("ri-heart-fill")}<span class="moments-likes-names">${likesList.map(l => esc(l.author_label || l.author || "?")).join("、")}</span>
    </div>`;

  const repliesList = m.replies || [];
  const repliesHtml = repliesList.length === 0 ? "" : `
    <div class="moments-replies">
      ${repliesList.map(r => {
        const rid = esc(r.id);
        const author = esc(r.author_label || r.author || "?");
        const prefix = (r.reply_to && r.reply_to_label)
          ? `${author} 回复 ${esc(r.reply_to_label)}`
          : author;
        const activeCls = (_composer.mid === m.id && _composer.activeRid === r.id) ? " is-active" : "";
        return `<div class="moments-reply${activeCls}" data-rid="${rid}" onclick="event.stopPropagation();PawzoChat.momentsReplyTo('${esc(m.id)}','${rid}')">
          <span class="moments-reply-body"><span class="moments-reply-author">${prefix}</span><span class="moments-reply-sep">：</span><span class="moments-reply-text">${esc(r.text || "")}</span></span>
          <button class="moments-reply-more" title="操作" onclick="event.stopPropagation();PawzoChat.momentsReplyMenu(event,'${esc(m.id)}','${rid}')">${iconHtml("ri-more-fill")}</button>
        </div>`;
      }).join("")}
    </div>`;

  // Tiny divider only when both blocks are present, to mimic WeChat.
  const interactDividerHtml = (likesList.length > 0 && repliesList.length > 0)
    ? `<div class="moments-likes-divider"></div>`
    : "";
  const interactBlockHtml = (likesList.length > 0 || repliesList.length > 0)
    ? `<div class="moments-interact">${likesHtml}${interactDividerHtml}${repliesHtml}</div>`
    : "";

  const composerHtml = _composer.mid === m.id ? _composerHtml(m.id) : "";

  const textHtml = m.text ? `<div class="moments-text">${esc(m.text).replace(/\n/g, "<br>")}</div>` : "";
  return `
    <div class="moments-item" data-mid="${esc(m.id)}">
      <div class="moments-avatar">${_avatarBlock(author, label)}</div>
      <div class="moments-body">
        <div class="moments-author">${esc(label)}</div>
        ${textHtml}
        ${imgsHtml}
        <div class="moments-meta">
          <span class="moments-time">${esc(time)}</span>
          <button class="moments-more" title="操作" onclick="event.stopPropagation();PawzoChat.momentsItemMenu(event, '${esc(m.id)}')">
            ${iconHtml("ri-more-fill")}
          </button>
        </div>
        ${interactBlockHtml}
        ${composerHtml}
      </div>
    </div>`;
}

function _composerHtml(mid) {
  const placeholder = _composer.replyTo
    ? `回复 ${_composer.replyToLabel || ""}…`
    : "评论…";
  return `
    <div class="moments-composer" data-mid="${esc(mid)}" onclick="event.stopPropagation()">
      <input type="text" class="moments-composer-input" id="m-comp-input-${esc(mid)}" maxlength="500"
        placeholder="${esc(placeholder)}"
        onkeydown="if(event.key==='Enter'){event.preventDefault();PawzoChat.momentsSubmitReply('${esc(mid)}')}else if(event.key==='Escape'){PawzoChat.momentsCloseComposer()}">
      <button class="moments-composer-send" onclick="PawzoChat.momentsSubmitReply('${esc(mid)}')">发送</button>
    </div>`;
}

function _setupObserver() {
  if (_list.observer) { try { _list.observer.disconnect(); } catch (e) { /* ignore */ } }
  const sentinel = $("m-sentinel");
  if (!sentinel) return;
  _list.observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && _list.hasMore && !_list.loading) {
        _loadNextPage(false);
      }
    }
  }, { rootMargin: "200px 0px" });
  _list.observer.observe(sentinel);
}

/* ---- Refresh / Publish actions ---- */

export async function momentsRefresh() {
  if (_state.isGenerating) { toast("正在生成中…", "info"); return; }
  try {
    const res = await api.post("/api/moments/refresh", {});
    if (res.status >= 400) {
      toast(res.data?.error || "刷新失败", "error");
      return;
    }
    toast("正在生成…", "info");
  } catch (e) { toast("刷新失败", "error"); }
}

export function momentsOpenPublish() {
  if (_state.isGenerating) { toast("正在生成中…", "info"); return; }
  pushPage("momentsPublish", {});
}

export function momentsItemMenu(event, mid) {
  if (event && event.stopPropagation) event.stopPropagation();
  const anchor = event?.currentTarget || event?.target || null;
  _closeActionsPop();

  const moment = _list.items.find(m => m.id === mid);
  const liked = !!(moment?.likes || []).find(l => l.author === "user");

  const el = document.createElement("div");
  el.className = "moments-actions-pop";
  el.setAttribute("data-mid", mid);
  el.addEventListener("click", e => e.stopPropagation());
  el.innerHTML = `
    <button class="map-btn" onclick="PawzoChat.momentsLikeToggle('${esc(mid)}')">
      ${iconHtml(liked ? "ri-heart-fill" : "ri-heart-line")}<span>${liked ? "已赞" : "赞"}</span>
    </button>
    <span class="map-divider"></span>
    <button class="map-btn" onclick="PawzoChat.momentsOpenComposer('${esc(mid)}')">
      ${iconHtml("ri-chat-3-line")}<span>评论</span>
    </button>
    <span class="map-divider"></span>
    <button class="map-btn" onclick="PawzoChat.momentsEdit('${esc(mid)}')">
      ${iconHtml("ri-edit-line")}<span>编辑</span>
    </button>
    <span class="map-divider"></span>
    <button class="map-btn map-btn-danger" onclick="PawzoChat.momentsDelete('${esc(mid)}')">
      ${iconHtml("ri-delete-bin-line")}<span>删除</span>
    </button>
  `;
  document.body.appendChild(el);

  // Prefer placing the pill to the left of the "..." button — moments live
  // far enough from the right edge that left almost always wins.
  if (anchor && anchor.getBoundingClientRect) {
    const rect = anchor.getBoundingClientRect();
    el.style.visibility = "hidden";
    requestAnimationFrame(() => {
      placeActionsPop(el, rect, /* preferLeft */ true);
      el.style.visibility = "";
    });
  }

  _pop.el = el;
  _pop.mid = mid;
  _pop.outsideHandler = (e) => {
    if (_pop.el && !_pop.el.contains(e.target)) _closeActionsPop();
  };
  _pop.keyHandler = (e) => { if (e.key === "Escape") _closeActionsPop(); };
  // Defer until after this click finishes propagating.
  setTimeout(() => {
    document.addEventListener("click", _pop.outsideHandler, true);
    document.addEventListener("keydown", _pop.keyHandler);
  }, 0);
}

export function momentsReplyMenu(event, mid, rid) {
  if (event && event.stopPropagation) event.stopPropagation();
  const anchor = event?.currentTarget || event?.target || null;
  _closeActionsPop();

  const el = document.createElement("div");
  el.className = "moments-actions-pop";
  el.setAttribute("data-mid", mid);
  el.setAttribute("data-rid", rid);
  el.addEventListener("click", e => e.stopPropagation());
  el.innerHTML = `
    <button class="map-btn" onclick="PawzoChat.momentsEditReply('${esc(mid)}','${esc(rid)}')">
      ${iconHtml("ri-edit-line")}<span>编辑</span>
    </button>
    <span class="map-divider"></span>
    <button class="map-btn map-btn-danger" onclick="PawzoChat.momentsDeleteReply('${esc(mid)}','${esc(rid)}')">
      ${iconHtml("ri-delete-bin-line")}<span>删除</span>
    </button>
  `;
  document.body.appendChild(el);

  // Reply "..." buttons hug the right edge of the reply row, so try the left
  // side first — the helper falls back to the right and clamps to the
  // viewport if neither side fully fits.
  if (anchor && anchor.getBoundingClientRect) {
    const rect = anchor.getBoundingClientRect();
    el.style.visibility = "hidden";
    requestAnimationFrame(() => {
      placeActionsPop(el, rect, /* preferLeft */ true);
      el.style.visibility = "";
    });
  }

  _pop.el = el;
  _pop.mid = mid;
  _pop.outsideHandler = (e) => {
    if (_pop.el && !_pop.el.contains(e.target)) _closeActionsPop();
  };
  _pop.keyHandler = (e) => { if (e.key === "Escape") _closeActionsPop(); };
  setTimeout(() => {
    document.addEventListener("click", _pop.outsideHandler, true);
    document.addEventListener("keydown", _pop.keyHandler);
  }, 0);
}

function _closeActionsPop() {
  if (_pop.el) {
    try { _pop.el.remove(); } catch (e) { /* ignore */ }
  }
  if (_pop.outsideHandler) {
    document.removeEventListener("click", _pop.outsideHandler, true);
  }
  if (_pop.keyHandler) {
    document.removeEventListener("keydown", _pop.keyHandler);
  }
  _pop.el = null;
  _pop.mid = null;
  _pop.outsideHandler = null;
  _pop.keyHandler = null;
}

export async function momentsLikeToggle(mid) {
  _closeActionsPop();
  const moment = _list.items.find(m => m.id === mid);
  if (!moment) return;
  const liked = !!(moment.likes || []).find(l => l.author === "user");
  try {
    const res = liked
      ? await api.del(`/api/moments/${encodeURIComponent(mid)}/like`)
      : await api.post(`/api/moments/${encodeURIComponent(mid)}/like`, {});
    if (res.status >= 400) {
      toast(res.data?.error || "操作失败", "error");
      return;
    }
    // SSE will refresh the moment; do an optimistic local patch for snappy UI.
    const userName = state.profile?.name || "我";
    if (liked) {
      moment.likes = (moment.likes || []).filter(l => l.author !== "user");
    } else {
      moment.likes = [...(moment.likes || []), { author: "user", author_label: userName }];
    }
    _renderItems();
  } catch (e) { toast("操作失败", "error"); }
}

export function momentsOpenComposer(mid) {
  _closeActionsPop();
  _composer.mid = mid;
  _composer.replyTo = null;
  _composer.replyToLabel = "";
  _composer.activeRid = null;
  _mountComposerOutside();
  _renderItems();
  _focusComposer(mid);
}

export function momentsReplyTo(mid, rid) {
  _closeActionsPop();
  const moment = _list.items.find(m => m.id === mid);
  if (!moment) return;
  const r = (moment.replies || []).find(x => x.id === rid);
  if (!r) return;
  // Replying to your own reply is a no-op (no AI counter, nothing to address).
  if (r.author === "user") {
    _composer.mid = mid;
    _composer.replyTo = null;
    _composer.replyToLabel = "";
  } else {
    _composer.mid = mid;
    _composer.replyTo = rid;
    _composer.replyToLabel = r.author_label || r.author || "";
  }
  _composer.activeRid = rid;
  _mountComposerOutside();
  _renderItems();
  _focusComposer(mid);
}

export function momentsCloseComposer() {
  if (_composer.mid === null) return;
  _composer.mid = null;
  _composer.replyTo = null;
  _composer.replyToLabel = "";
  _composer.activeRid = null;
  _unmountComposerOutside();
  _renderItems();
}

function _mountComposerOutside() {
  if (_composer.outsideHandler) return;
  const handler = (e) => {
    if (!_composer.mid) return;
    const t = e.target;
    if (t && t.closest && t.closest(".moments-composer, .moments-reply, .moments-actions-pop")) return;
    momentsCloseComposer();
  };
  _composer.outsideHandler = handler;
  // Defer past the click that opened the composer.
  setTimeout(() => {
    if (_composer.outsideHandler === handler) {
      document.addEventListener("click", handler, true);
    }
  }, 0);
}

function _unmountComposerOutside() {
  if (_composer.outsideHandler) {
    document.removeEventListener("click", _composer.outsideHandler, true);
    _composer.outsideHandler = null;
  }
}

function _focusComposer(mid) {
  // After re-render, the input exists; focus on next tick.
  setTimeout(() => {
    const inp = document.getElementById(`m-comp-input-${mid}`);
    if (inp) inp.focus();
  }, 0);
}

export async function momentsSubmitReply(mid) {
  const inp = document.getElementById(`m-comp-input-${mid}`);
  if (!inp) return;
  const text = (inp.value || "").trim();
  if (!text) return;
  const replyTo = _composer.mid === mid ? _composer.replyTo : null;
  try {
    const res = await api.post(`/api/moments/${encodeURIComponent(mid)}/replies`, {
      text,
      reply_to: replyTo,
    });
    if (res.status >= 400) {
      toast(res.data?.error || "评论失败", "error");
      return;
    }
    // Close composer; SSE will re-render the moment with the new reply.
    _composer.mid = null;
    _composer.replyTo = null;
    _composer.replyToLabel = "";
    _composer.activeRid = null;
    _unmountComposerOutside();
    _renderItems();
  } catch (e) { toast("评论失败", "error"); }
}

export async function momentsDeleteReply(mid, rid) {
  _closeActionsPop();
  const ok = await confirm("删除评论", "确认删除该评论？后续回复也会一并删除。", true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const res = await api.del(`/api/moments/${encodeURIComponent(mid)}/replies/${encodeURIComponent(rid)}`);
    if (res.status >= 400) { toast(res.data?.error || "删除失败", "error"); return; }
    const deleted = new Set(res.data?.deleted_ids || [rid]);
    const moment = _list.items.find(m => m.id === mid);
    if (moment) moment.replies = (moment.replies || []).filter(r => !deleted.has(r.id));
    _renderItems();
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Edit (moment text / reply text) ---- */

const _EDIT_LIMITS = { moment: 2000, reply: 500 };

function _openEditSheet({ kind, mid, rid, label, current, maxlen, rows }) {
  _closeActionsPop();
  _edit.kind = kind;
  _edit.mid = mid;
  _edit.rid = rid;
  const safeCurrent = esc(current);
  const minH = kind === "reply" ? 72 : 140;
  showSheet(
    `<div style="padding:8px 20px 20px">
      <div class="sheet-title">${esc(label)}</div>
      <div class="card" style="margin:0">
        <textarea id="m-edit-text" class="form-textarea" rows="${rows}"
          maxlength="${maxlen}"
          placeholder="${kind === "reply" ? "评论内容…" : "这一刻的想法…"}"
          style="min-height:${minH}px">${safeCurrent}</textarea>
      </div>
      <div class="form-actions" style="margin-top:14px">
        <button class="btn-secondary" onclick="PawzoChat.closeOverlay()">取消</button>
        <button class="btn-primary" onclick="PawzoChat.momentsSubmitEdit()">保存</button>
      </div>
    </div>`,
    () => { _edit.kind = null; _edit.mid = null; _edit.rid = null; },
  );
  // Focus + place caret at end so editing feels immediate.
  setTimeout(() => {
    const ta = document.getElementById("m-edit-text");
    if (!ta) return;
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* ignore */ }
  }, 50);
}

export function momentsEdit(mid) {
  const moment = _list.items.find(m => m.id === mid);
  if (!moment) return;
  _openEditSheet({
    kind: "moment",
    mid,
    rid: null,
    label: "编辑朋友圈",
    current: moment.text || "",
    maxlen: _EDIT_LIMITS.moment,
    rows: 6,
  });
}

export function momentsEditReply(mid, rid) {
  const moment = _list.items.find(m => m.id === mid);
  if (!moment) return;
  const r = (moment.replies || []).find(x => x.id === rid);
  if (!r) return;
  _openEditSheet({
    kind: "reply",
    mid,
    rid,
    label: "编辑评论",
    current: r.text || "",
    maxlen: _EDIT_LIMITS.reply,
    rows: 3,
  });
}

export async function momentsSubmitEdit() {
  const ta = document.getElementById("m-edit-text");
  if (!ta) return;
  const text = ta.value.trim();
  const { kind, mid, rid } = _edit;
  if (!kind || !mid) { closeOverlay(); return; }
  if (kind === "reply" && !text) {
    toast("评论内容不能为空", "error");
    return;
  }
  if (kind === "moment") {
    const moment = _list.items.find(m => m.id === mid);
    const hasImages = !!(moment && (moment.images || []).length);
    if (!text && !hasImages) {
      toast("文案与图片不能同时为空", "error");
      return;
    }
  }
  showLoading("保存中…");
  try {
    const url = kind === "reply"
      ? `/api/moments/${encodeURIComponent(mid)}/replies/${encodeURIComponent(rid)}`
      : `/api/moments/${encodeURIComponent(mid)}`;
    const res = await api.patch(url, { text });
    if (res.status >= 400) {
      toast(res.data?.error || "保存失败", "error");
      return;
    }
    // Optimistic local patch; SSE will reconfirm.
    const moment = _list.items.find(m => m.id === mid);
    if (moment) {
      if (kind === "moment") {
        moment.text = res.data?.text ?? text;
      } else {
        const r = (moment.replies || []).find(x => x.id === rid);
        if (r) r.text = res.data?.text ?? text;
      }
      _renderItems();
    }
    closeOverlay();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

export async function momentsDelete(mid) {
  _closeActionsPop();
  const ok = await confirm("删除朋友圈", "确认删除这条朋友圈？此操作不可撤销。", true);
  if (!ok) return;
  showLoading("删除中…");
  try {
    const res = await api.del(`/api/moments/${encodeURIComponent(mid)}`);
    if (res.status >= 400) { toast(res.data?.error || "删除失败", "error"); return; }
    // SSE will also remove it, but update locally for snappy response.
    _list.items = _list.items.filter(m => m.id !== mid);
    _renderItems();
  } catch (e) { toast("删除失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Cover ---- */

export function momentsPickCover() {
  if (_state.coverUrl) {
    // Has cover → open menu instead of immediately uploading
    momentsCoverMenu();
    return;
  }
  const inp = $("m-cover-file");
  if (inp) { inp.value = ""; inp.click(); }
}

export function momentsCoverMenu() {
  showSheet(`<div class="sheet-body">
    <div class="sheet-title">朋友圈封面</div>
    <div class="card" style="margin:8px 0">
      <div class="card-row" style="cursor:pointer" onclick="PawzoChat.closeOverlay();PawzoChat.momentsPickCoverFile()">
        <span class="row-label">更换封面</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row danger-row" style="cursor:pointer" onclick="PawzoChat.momentsCoverDelete()">
        <span class="row-label" style="color:#e15151">移除封面</span>
      </div>
    </div>
    <button class="btn-secondary btn-block" onclick="PawzoChat.closeOverlay()">取消</button>
  </div>`);
}

export function momentsPickCoverFile() {
  const inp = $("m-cover-file");
  if (inp) { inp.value = ""; inp.click(); }
}

export async function momentsOnCoverFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("cover", file);
  showLoading("上传中…");
  try {
    const r = await fetch(`${BASE()}/api/moments/cover`, { method: "POST", body: fd });
    const data = await r.json();
    if (r.status >= 400) { toast(data?.error || "上传失败", "error"); return; }
    _state.coverUrl = "/api/moments/cover";
    _renderCover();
    toast("封面已更新", "success");
  } catch (e) { toast("上传失败", "error"); }
  finally { hideLoading(); }
  event.target.value = "";
}

export async function momentsCoverDelete() {
  closeOverlay();
  const ok = await confirm("移除封面", "确认移除当前封面图？", true);
  if (!ok) return;
  showLoading("处理中…");
  try {
    const res = await api.del("/api/moments/cover");
    if (res.status >= 400) {
      toast(res.data?.error || "失败", "error");
      return;
    }
    _state.coverUrl = "";
    _renderCover();
  } catch (e) { toast("失败", "error"); }
  finally { hideLoading(); }
}

/* ---- SSE handlers ---- */

// True iff the moments list page is the currently rendered page. The
// _list.inListPage flag alone is unreliable because nothing resets it when
// the user switches to a different top-level tab — checking for the feed
// element keeps SSE side-effects scoped to when the page is actually visible.
function _isListPageVisible() {
  return _list.inListPage && !!document.getElementById("m-feed");
}

export async function momentsOnUpdate(data) {
  if (!_isListPageVisible()) return;
  const action = data.action;
  const mid = data.moment_id;
  const authorId = data.author_id;
  if (action === "author_deleted") {
    if (!authorId) return;
    _list.items = _list.items.filter(m => {
      if (m.author === authorId) return false;
      // Also strip this author from replies and likes on remaining items.
      if (m.replies) m.replies = m.replies.filter(r => r.author !== authorId);
      if (m.likes) m.likes = m.likes.filter(l => l.author !== authorId);
      return true;
    });
    _renderItems();
    return;
  }
  if (!mid) return;
  try {
    if (action === "deleted") {
      _list.items = _list.items.filter(m => m.id !== mid);
      _renderItems();
      return;
    }
    if (action === "reply_deleted") {
      const deleted = new Set(data.reply_ids || []);
      const idx = _list.items.findIndex(x => x.id === mid);
      if (idx >= 0) {
        _list.items[idx].replies =
          (_list.items[idx].replies || []).filter(r => !deleted.has(r.id));
        _renderItems();
      }
      return;
    }
    const res = await api.get(`/api/moments/${encodeURIComponent(mid)}`);
    if (!res.moment) return;
    const m = res.moment;
    const idx = _list.items.findIndex(x => x.id === mid);
    if (idx >= 0) {
      _list.items[idx] = m;
    } else if (action === "added" || action === "reply_added" || action === "like_changed") {
      // Promote off-window moments to the top only when they grew (new post,
      // new reply, or like change). Edits never reorder the feed.
      _list.items.unshift(m);
    }
    _renderItems();
  } catch (e) { /* silent */ }
}

export function momentsOnGenerating(isGenerating) {
  _state.isGenerating = !!isGenerating;
  if (_isListPageVisible()) _setListActions();
}

/* ---- Publish page ---- */

function renderMomentsPublish() {
  const draft = _publish;
  _list.inListPage = false;
  setTopBar("发布朋友圈", true, `
    <button class="btn-text" id="m-pub-submit" onclick="PawzoChat.momentsSubmitPublish()">发表</button>
  `);

  content().innerHTML = `
    <input type="file" id="m-pub-file" accept="image/*" multiple style="display:none" onchange="PawzoChat.momentsOnPublishFiles(event)">
    <div class="page moments-publish-page">
      <div class="card">
        <textarea id="m-pub-text" class="form-textarea" rows="6" placeholder="这一刻的想法…"></textarea>
      </div>
      <div class="card">
        <div class="moments-pub-imgs" id="m-pub-imgs"></div>
        <div class="moments-pub-hint">最多 9 张图片，单张上限 10 MB</div>
      </div>
    </div>
  `;
  const input = $('m-pub-text');
  const editor = _publishEditor = { draft, input };
  input.value = draft.text;
  input.addEventListener('input', () => { draft.text = input.value; });
  if (draft.selection) input.setSelectionRange(...draft.selection);
  setPageCleanup(() => {
    draft.text = input.value;
    draft.selection = [input.selectionStart, input.selectionEnd, input.selectionDirection];
    if (_publishEditor === editor) _publishEditor = null;
  });
  _renderPublishImages();
}

function _renderPublishImages() {
  const host = $("m-pub-imgs");
  if (!host || !_publishEditor) return;
  const draft = _publishEditor.draft;
  $('m-pub-submit').disabled = draft.publishing || draft.reading > 0;
  _publishEditor.input.disabled = draft.publishing;
  const disabled = draft.publishing ? ' disabled' : '';
  const thumbs = draft.files.map((f, i) => `
    <div class="m-pub-thumb" style="background-image:url('${f.dataUrl}')">
      <button class="m-pub-thumb-del"${disabled} onclick="PawzoChat.momentsRemovePubImage(${i})">×</button>
    </div>
  `).join("");
  const addBtn = draft.files.length + draft.reading < 9
    ? `<button class="m-pub-add"${disabled} onclick="PawzoChat.momentsPickPubImages()">+</button>`
    : "";
  host.innerHTML = thumbs + addBtn;
}

export function momentsPickPubImages() {
  if (_publish.publishing) return;
  const inp = $("m-pub-file");
  if (inp) { inp.value = ""; inp.click(); }
}

export async function momentsOnPublishFiles(event) {
  if (!_publishEditor || _publish.publishing || event.target !== $('m-pub-file')) return;
  const draft = _publish;
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length) return;
  const remaining = Math.max(0, 9 - draft.files.length - draft.reading);
  if (!remaining) {
    toast("已达到 9 张图片上限", "info");
    return;
  }
  const accepted = files.slice(0, remaining);
  if (files.length > remaining) toast(`仅添加前 ${remaining} 张图片`, "info");
  draft.reading += accepted.length;
  _renderPublishImages();
  for (const file of accepted) {
    try {
      if (!file.type.startsWith('image/')) {
        toast(`「${file.name}」不是图片`, 'error');
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast(`「${file.name}」超过 10 MB`, "error");
        continue;
      }
      const snapshot = await snapshotDraftFile(file);
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = fr.onabort = () => reject(fr.error || new Error('读取失败'));
        fr.readAsDataURL(snapshot);
      });
      draft.files.push({ file: snapshot, dataUrl });
    } catch {
      // Unreadable local files are silently omitted from the draft.
    } finally {
      draft.reading--;
      if (_publishEditor?.draft === draft) _renderPublishImages();
    }
  }
}

export function momentsRemovePubImage(idx) {
  if (!_publishEditor || _publish.publishing) return;
  _publish.files.splice(idx, 1);
  _renderPublishImages();
}

export async function momentsSubmitPublish() {
  const editor = _publishEditor, draft = _publish;
  if (!editor || editor.draft !== draft || draft.publishing || draft.reading) return;
  draft.text = editor.input.value;
  const text = draft.text.trim();
  if (!text && draft.files.length === 0) {
    toast("文案与图片不能同时为空", "error");
    return;
  }
  draft.publishing = true;
  _renderPublishImages();
  showLoading("发布中…");
  try {
    const fd = new FormData();
    fd.append("text", text);
    // Selection already captured every byte; these files no longer depend on disk.
    for (const { file } of draft.files) fd.append("images", file);
    const r = await fetch(`${BASE()}/api/moments`, { method: "POST", body: fd });
    const data = await r.json();
    if (r.status >= 400) {
      toast(data?.error || "发布失败", "error");
      return;
    }
    toast("已发布", "success");
    _publish = newPublishDraft();
    // A response from an old page must not navigate away from the current page.
    if (_publishEditor?.draft === draft) goBack();
  } catch (e) { toast("发布失败，草稿已保留", "error"); }
  finally {
    draft.publishing = false;
    if (_publishEditor?.draft === draft) _renderPublishImages();
    hideLoading();
  }
}

/* ---- Settings page ---- */

async function renderMomentsSettings() {
  _list.inListPage = false;
  setTopBar("朋友圈设置", true, `
    <button class="btn-text" onclick="PawzoChat.momentsSaveSettings()">保存</button>
  `);

  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;
  try {
    const res = await api.get("/api/moments/settings");
    _settings.publishers = new Set(res.publishers || []);
    _settings.repliers = new Set(res.repliers || []);
    _settings.probabilities = Object.assign({}, res.reply_probabilities || {});
    _settings.memoryEnabled = Object.assign({}, res.memory_enabled || {});
    _settings.promptPost = res.prompts?.post || "";
    _settings.promptReply = res.prompts?.reply || "";
    _settings.promptCounterReply = res.prompts?.counter_reply || "";
    _settings.promptPostDefault = res.prompts?.post_default || "";
    _settings.promptReplyDefault = res.prompts?.reply_default || "";
    _settings.promptCounterReplyDefault = res.prompts?.counter_reply_default || "";
    _settings.personas = res.personas || [];
    // Cache for avatar lookup.
    _state.personasById = {};
    for (const p of _settings.personas) _state.personasById[p.id] = p;
  } catch (e) { toast("加载失败", "error"); return; }

  const personasHtml = _settings.personas.map(_personaSettingsRow).join("");

  const personasBlock = _settings.personas.length === 0
    ? `<div class="card-empty-hint">还没有角色，请先在通讯录新建。</div>`
    : `<div class="moments-pp-list">${personasHtml}</div>`;

  content().innerHTML = `
    <div class="page">
      <div class="card">
        <div class="card-header">参与角色</div>
        ${personasBlock}
        <div class="form-hint" style="padding:6px 16px 14px">点击刷新按钮时会随机选择一位可发布朋友圈内容的角色生成朋友圈内容；其他角色会按照设置的概率触发回复该朋友圈内容</div>
      </div>
      <div class="card">
        <div class="card-header-row">
          <span class="card-header" style="flex:1">文案生成提示词</span>
          <button class="btn-text btn-sm" onclick="PawzoChat.momentsResetPrompt('post')">恢复默认</button>
        </div>
        <div class="prompt-field">
          <textarea id="m-set-post" class="prompt-input" rows="6">${esc(_settings.promptPost)}</textarea>
          <div class="form-hint">刷新朋友圈时调用 LLM 的指令模板</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header-row">
          <span class="card-header" style="flex:1">回复生成提示词</span>
          <button class="btn-text btn-sm" onclick="PawzoChat.momentsResetPrompt('reply')">恢复默认</button>
        </div>
        <div class="prompt-field">
          <textarea id="m-set-reply" class="prompt-input" rows="6">${esc(_settings.promptReply)}</textarea>
          <div class="form-hint">可用占位符：<code>{author}</code>（发布者名字）、<code>{text}</code>（朋友圈正文）</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header-row">
          <span class="card-header" style="flex:1">反向回复提示词</span>
          <button class="btn-text btn-sm" onclick="PawzoChat.momentsResetPrompt('counter_reply')">恢复默认</button>
        </div>
        <div class="prompt-field">
          <textarea id="m-set-counter" class="prompt-input" rows="6">${esc(_settings.promptCounterReply)}</textarea>
          <div class="form-hint">用户回复角色时使用。可用占位符：<code>{moment_author}</code>、<code>{moment_text}</code>、<code>{user_name}</code>、<code>{user_reply}</code>、<code>{thread}</code>（之前的对话）</div>
        </div>
      </div>
    </div>
  `;
}

function _personaSettingsRow(p) {
  const pid = esc(p.id);
  const prob = Math.max(0, Math.min(100, parseInt(_settings.probabilities[p.id], 10) || 50));
  const isReplier = _settings.repliers.has(p.id);
  const isPublisher = _settings.publishers.has(p.id);
  const isMemory = _settings.memoryEnabled[p.id] !== false;
  const avatarUrl = p.has_avatar ? _avatarUrl(p.id) : "";
  return `
    <div class="moments-pp-row" data-pid="${pid}">
      <div class="moments-pp-head">
        ${avatarHtml(p.name || "?", "sm", avatarUrl)}
        <div class="moments-pp-name">${esc(p.name)}</div>
      </div>
      <div class="moments-pp-controls">
        <label class="moments-pp-toggle">
          <span class="moments-pp-toggle-label">发布</span>
          <span class="switch-wrap">
            <input type="checkbox" class="moments-pp-pub" data-pid="${pid}" ${isPublisher ? "checked" : ""}>
            <span class="switch-track"></span>
          </span>
        </label>
        <label class="moments-pp-toggle">
          <span class="moments-pp-toggle-label">回复</span>
          <span class="switch-wrap">
            <input type="checkbox" class="moments-pp-rep" data-pid="${pid}" ${isReplier ? "checked" : ""}>
            <span class="switch-track"></span>
          </span>
        </label>
        <label class="moments-pp-toggle">
          <span class="moments-pp-toggle-label">写入记忆</span>
          <span class="switch-wrap">
            <input type="checkbox" class="moments-pp-mem" data-pid="${pid}" ${isMemory ? "checked" : ""}>
            <span class="switch-track"></span>
          </span>
        </label>
        <div class="moments-pp-prob">
          <span class="moments-pp-prob-label">触发回复朋友圈概率</span>
          <input type="range" class="moments-pp-prob-input" data-pid="${pid}" min="0" max="100" step="1" value="${prob}" oninput="PawzoChat.momentsOnProbInput(this)">
          <span class="slider-val" data-prob-label="${pid}">${prob}%</span>
        </div>
      </div>
    </div>
  `;
}

export function momentsOnProbInput(input) {
  const pid = input.dataset.pid;
  if (!pid) return;
  const v = Math.max(0, Math.min(100, parseInt(input.value, 10) || 0));
  _settings.probabilities[pid] = v;
  const lbl = document.querySelector(`[data-prob-label="${CSS.escape(pid)}"]`);
  if (lbl) lbl.textContent = `${v}%`;
}

export function momentsResetPrompt(kind) {
  if (kind === "post") {
    const el = $("m-set-post");
    setPromptValue(el, _settings.promptPostDefault);
  } else if (kind === "counter_reply") {
    const el = $("m-set-counter");
    setPromptValue(el, _settings.promptCounterReplyDefault);
  } else {
    const el = $("m-set-reply");
    setPromptValue(el, _settings.promptReplyDefault);
  }
}

export async function momentsSaveSettings() {
  const publishers = Array.from(document.querySelectorAll(".moments-pp-pub:checked")).map(el => el.dataset.pid);
  const repliers = Array.from(document.querySelectorAll(".moments-pp-rep:checked")).map(el => el.dataset.pid);
  const reply_probabilities = {};
  for (const el of document.querySelectorAll(".moments-pp-prob-input")) {
    const pid = el.dataset.pid;
    if (!pid) continue;
    reply_probabilities[pid] = Math.max(0, Math.min(100, parseInt(el.value, 10) || 0));
  }
  const memory_enabled = {};
  for (const el of document.querySelectorAll(".moments-pp-mem")) {
    const pid = el.dataset.pid;
    if (!pid) continue;
    memory_enabled[pid] = !!el.checked;
  }
  const post = $("m-set-post")?.value || "";
  const reply = $("m-set-reply")?.value || "";
  const counter_reply = $("m-set-counter")?.value || "";

  showLoading("保存中…");
  try {
    const res = await api.put("/api/moments/settings", {
      publishers,
      repliers,
      reply_probabilities,
      memory_enabled,
      prompts: { post, reply, counter_reply },
    });
    if (res.status >= 400) { toast(res.data?.error || "保存失败", "error"); return; }
    toast("已保存", "success");
    goBack();
  } catch (e) { toast("保存失败", "error"); }
  finally { hideLoading(); }
}

/* ---- Page registration ---- */

registerPageRenderer("momentsList", renderMomentsList);
registerPageRenderer("momentsPublish", renderMomentsPublish);
registerPageRenderer("momentsSettings", renderMomentsSettings);
