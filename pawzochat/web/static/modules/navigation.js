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
import { state, $, content, sidebar, topTitle, topBack, topActions } from "./state.js";

const tabRenderers = {};
const tabRestoreHandlers = {};
const pageRenderers = {};
let pageCleanup = null;

export function setPageCleanup(cleanup) { pageCleanup = cleanup; }

function disposePage() {
  const cleanup = pageCleanup;
  pageCleanup = null;
  cleanup?.();
}

export function registerTabRenderer(tab, fn, onRestore) {
  tabRenderers[tab] = fn;
  tabRestoreHandlers[tab] = onRestore;
}

export function registerPageRenderer(page, fn) {
  pageRenderers[page] = fn;
}

/* ---- Layout detection ---- */

const _desktopMQ = window.matchMedia("(min-width: 768px)");

export function isDesktop() {
  return _desktopMQ.matches;
}

/* ---- Top / Sidebar bar helpers ---- */

export function setTopBar(title, showBack, actionsHtml, leftHtml) {
  topTitle().textContent = title;
  const bar = $("top-bar");
  const back = topBack();
  if (leftHtml) {
    back.classList.add("hide");
    let slot = $("top-bar-left");
    if (!slot) {
      slot = document.createElement("div");
      slot.id = "top-bar-left";
      back.parentNode.insertBefore(slot, back);
    }
    slot.innerHTML = leftHtml;
    slot.classList.remove("hide");
    bar.classList.add("contextual");
  } else {
    back.classList.toggle("hide", !showBack);
    const slot = $("top-bar-left");
    if (slot) { slot.innerHTML = ""; slot.classList.add("hide"); }
    bar.classList.remove("contextual");
  }
  topActions().innerHTML = actionsHtml || "";
  if (isDesktop()) bar.classList.remove("desktop-hidden");
}

export function setSidebarBar(title, actionsHtml) {
  const el = $("sidebar-title");
  if (el) el.textContent = title;
  const act = $("sidebar-actions");
  if (act) act.innerHTML = actionsHtml || "";
}

/* ---- Rendering ---- */

function resetContentScroll() {
  const el = content();
  if (el) el.style.overflow = "";
}

function renderCurrentTab() {
  resetContentScroll();
  const fn = tabRenderers[state.currentTab];
  if (fn) fn();
}

function renderPage(name, data) {
  disposePage();
  resetContentScroll();
  const fn = pageRenderers[name];
  if (fn) fn(data);
}

export function refreshSidebar() {
  if (!isDesktop()) return;
  renderCurrentTab();
}

/* ---- Desktop welcome screen ---- */

function showDesktopWelcome() {
  $("top-bar").classList.add("desktop-hidden");
  content().style.overflow = "";
  const base = window.PAWZOCHAT_BASE || "";
  content().innerHTML = `<div class="desktop-welcome">
    <div class="welcome-icon"><img src="${base}/static/logo.png" alt="PawzoChat"></div>
    <div class="welcome-title">PawzoChat</div>
  </div>`;
}

/* ---- Tab DOM cache ---- */

// Detach the rendered tab root before navigating away so the next visit can
// restore it instantly — preserves scroll position, input state, and event
// listeners that were attached to the live nodes. Snapshots are dropped
// wholesale on any api.invalidate (see the `pawzo:api-invalidated` listener
// below) so they can never serve data that's been overwritten by a write.
const _tabCache = new Map(); // tab -> { container, fragment, scroll, mode, chrome }

function _activeMode() {
  return isDesktop() ? "desktop" : "mobile";
}

function _tabContainer() {
  // On desktop the tab body lives in the sidebar; on mobile, in the content
  // area. Both are populated by the renderer's `target = desktop ? sidebar() : content()` pattern.
  return isDesktop() ? sidebar() : content();
}

function _snapshotChrome() {
  const slot = $("top-bar-left");
  const bar = $("top-bar");
  return {
    topTitle: $("top-bar-title")?.textContent || "",
    topActions: $("top-bar-actions")?.innerHTML || "",
    topBackHidden: $("top-bar-back")?.classList.contains("hide") ?? true,
    topLeftHtml: slot?.innerHTML || "",
    topLeftHidden: slot ? slot.classList.contains("hide") : true,
    topBarContextual: bar?.classList.contains("contextual") || false,
    sidebarTitle: $("sidebar-title")?.textContent || "",
    sidebarActions: $("sidebar-actions")?.innerHTML || "",
  };
}

function _restoreChrome(chrome) {
  if (!chrome) return;
  const tt = $("top-bar-title"); if (tt) tt.textContent = chrome.topTitle;
  const ta = $("top-bar-actions"); if (ta) ta.innerHTML = chrome.topActions;
  const tb = $("top-bar-back"); if (tb) tb.classList.toggle("hide", chrome.topBackHidden);
  // top-bar-left slot + the "contextual" class on the bar are managed by
  // setTopBar's leftHtml branch (e.g. theme selection mode). They can be left
  // dirty by a renderer that skipped a clean setTopBar call, so restore them
  // explicitly instead of trusting them to be reset by the next render.
  const slot = $("top-bar-left");
  if (slot) {
    slot.innerHTML = chrome.topLeftHtml || "";
    slot.classList.toggle("hide", chrome.topLeftHidden !== false);
  }
  const bar = $("top-bar");
  if (bar) bar.classList.toggle("contextual", !!chrome.topBarContextual);
  const st = $("sidebar-title"); if (st) st.textContent = chrome.sidebarTitle;
  const sa = $("sidebar-actions"); if (sa) sa.innerHTML = chrome.sidebarActions;
}

function _saveTabDom(tab) {
  // Only snapshot tab roots — sub-pages are cheap to rebuild and may hold
  // stale form state that's confusing to "restore".
  if (state.pageStack.length !== 0) return;
  const container = _tabContainer();
  if (!container || !container.firstChild) return;
  const fragment = document.createDocumentFragment();
  while (container.firstChild) fragment.appendChild(container.firstChild);
  _tabCache.set(tab, {
    container,
    fragment,
    scroll: container.scrollTop,
    mode: _activeMode(),
    chrome: _snapshotChrome(),
  });
}

function _restoreTabDom(tab) {
  const entry = _tabCache.get(tab);
  if (!entry) return false;
  if (entry.mode !== _activeMode()) {
    // Layout flipped (e.g., window resize crossed the breakpoint) —
    // discard the stale snapshot and force a re-render.
    _tabCache.delete(tab);
    return false;
  }
  const container = _tabContainer();
  if (!container) return false;
  container.innerHTML = "";
  container.appendChild(entry.fragment);
  _restoreChrome(entry.chrome);
  _tabCache.delete(tab);
  tabRestoreHandlers[tab]?.();
  // Scroll restoration must wait for the freshly-attached subtree to lay out.
  requestAnimationFrame(() => { container.scrollTop = entry.scroll; });
  return true;
}

// Any API-level cache invalidation (writes from this client, or explicit
// invalidations from SSE handlers) may have changed data that's baked into a
// cached tab DOM snapshot. Conservative: drop them all and let the next visit
// re-render — that re-render is cheap because the SWR cache typically still
// holds the fresh response from the same write.
window.addEventListener("pawzo:api-invalidated", () => {
  _tabCache.clear();
});

/* ---- Core navigation ---- */

export function switchTab(tab, { refresh = false } = {}) {
  disposePage();
  // A workflow such as quick setup can change data behind the visible tab.
  // Do not snapshot and immediately restore that stale DOM on a forced refresh.
  if (refresh) _tabCache.delete(tab);
  if (isDesktop()) {
    state.sidebarScrollPos[state.currentTab] = sidebar()?.scrollTop || 0;
    if (!refresh || state.currentTab !== tab) _saveTabDom(state.currentTab);
    state.currentTab = tab;
    state.pageStack = [];
    document.querySelectorAll(".tab").forEach(t =>
      t.classList.toggle("active", t.dataset.tab === tab)
    );
    if (!_restoreTabDom(tab)) {
      renderCurrentTab();
      requestAnimationFrame(() => {
        const sb = sidebar();
        if (sb) sb.scrollTop = state.sidebarScrollPos[tab] || 0;
      });
    }
    // Tab roots always show the welcome screen in the content area on desktop.
    showDesktopWelcome();
  } else {
    state.tabScrollPos[state.currentTab] = content().scrollTop;
    if (!refresh || state.currentTab !== tab) _saveTabDom(state.currentTab);
    state.currentTab = tab;
    state.pageStack = [];
    document.querySelectorAll(".tab").forEach(t =>
      t.classList.toggle("active", t.dataset.tab === tab)
    );
    $("tab-bar").classList.remove("hide");
    if (!_restoreTabDom(tab)) {
      renderCurrentTab();
      content().scrollTop = state.tabScrollPos[tab] || 0;
    }
  }
}

export function pushPage(name, data) {
  if (isDesktop()) {
    // Desktop keeps the sidebar's tab content visible while the sub-page
    // takes over the main content area — no need to detach anything.
    state.pageStack.push({ name, data });
    $("top-bar").classList.remove("desktop-hidden");
    renderPage(name, data);
  } else {
    // Mobile sub-pages overwrite the same container that holds the tab root,
    // so snapshot it first to enable instant restoration on goBack.
    _saveTabDom(state.currentTab);
    state.pageStack.push({ name, data, scrollTop: content().scrollTop });
    $("tab-bar").classList.add("hide");
    renderPage(name, data);
  }
}

export function goBack() {
  if (state.pageStack.length === 0) return;
  disposePage();
  state.pageStack.pop();
  if (state.pageStack.length === 0) {
    if (isDesktop()) {
      // Sidebar already shows the tab root from before pushPage; just hide
      // the top-bar and return to the welcome content.
      showDesktopWelcome();
    } else {
      $("tab-bar").classList.remove("hide");
      if (!_restoreTabDom(state.currentTab)) {
        renderCurrentTab();
      }
    }
  } else {
    const prev = state.pageStack[state.pageStack.length - 1];
    renderPage(prev.name, prev.data);
  }
}

/* ---- Layout change handler (desktop ↔ mobile transition) ---- */

_desktopMQ.addEventListener("change", () => {
  if (!$("phone-shell")) return;
  // Drop every snapshot — they're tied to the previous layout mode.
  _tabCache.clear();
  if (state.pageStack[state.pageStack.length - 1]?.name === "chatWindow") {
    // The chat uses the same content pane in both layouts. Keep its DOM and
    // session alive so ResizeObserver can preserve the reading anchor/draft.
    $("tab-bar").classList.add("hide");
    $("top-bar").classList.remove("desktop-hidden");
    if (isDesktop()) renderCurrentTab();
    content().style.overflow = "hidden";
    return;
  }
  const savedPages = [...state.pageStack];
  switchTab(state.currentTab);
  for (const p of savedPages) {
    pushPage(p.name, p.data);
  }
});
