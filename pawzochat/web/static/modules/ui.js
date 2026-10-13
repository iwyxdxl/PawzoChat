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
import { state, $ } from "./state.js";
import { initPromptTextareas } from "./prompt_textarea.js";

initPromptTextareas();

let toastTimer = null;
let overlayCloseTimer = null;

export function toast(msg, type = "info") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "hide"; }, 3000);
}

let confirmCloseTimer = null;

function showConfirm(title, desc, danger, option, confirmText) {
  return new Promise(resolve => {
    const dlg = $("confirm-dialog");
    clearTimeout(confirmCloseTimer);
    dlg.querySelector(".dialog-option")?.remove();
    dlg.querySelector(".dialog-title").textContent = title;
    dlg.querySelector(".dialog-desc").textContent = desc;
    let checkbox;
    if (option) {
      const label = document.createElement("label");
      label.className = "dialog-option";
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", option.label);
      checkbox.checked = false;
      const copy = document.createElement("span");
      copy.className = "dialog-option-copy";
      const text = document.createElement("span");
      text.textContent = option.label;
      copy.append(text);
      if (option.hint) {
        const hint = document.createElement("small");
        hint.textContent = option.hint;
        copy.append(hint);
      }
      label.append(checkbox, copy);
      dlg.querySelector(".dialog-desc").after(label);
    }
    const ok = dlg.querySelector(".dialog-ok");
    ok.className = danger ? "dialog-ok danger" : "dialog-ok";
    ok.textContent = confirmText || (danger ? "删除" : "确认");
    dlg.classList.remove("hide");
    requestAnimationFrame(() => dlg.classList.add("show"));
    state.confirmCb = result => resolve({ confirmed: !!result, checked: !!checkbox?.checked });
  });
}

export async function confirm(title, desc, danger, confirmText) {
  return (await showConfirm(title, desc, danger, undefined, confirmText)).confirmed;
}

export function confirmWithCheckbox(title, desc, danger, option) {
  return showConfirm(title, desc, danger, option);
}

export function closeConfirm(result) {
  const dlg = $("confirm-dialog");
  dlg.classList.remove("show");
  clearTimeout(confirmCloseTimer);
  confirmCloseTimer = setTimeout(() => dlg.classList.add("hide"), 200);
  if (state.confirmCb) { state.confirmCb(result); state.confirmCb = null; }
}

let _onOverlayClose = null;
let _overlayDismiss = true;

export function showSheet(html, onClose, { dismissOverlay = true } = {}) {
  _onOverlayClose = onClose || null;
  _overlayDismiss = dismissOverlay;
  clearTimeout(overlayCloseTimer);
  $("sheet-content").innerHTML = html;
  $("overlay").classList.remove("hide");
  $("action-sheet").classList.remove("hide");
  $("action-sheet").scrollTop = 0;
  requestAnimationFrame(() => {
    $("overlay").classList.add("show");
    $("action-sheet").classList.add("show");
  });
}

export function setOverlayDismissible(dismissible) {
  _overlayDismiss = !!dismissible;
}

// Backdrop click handler — ignored while the current sheet is marked
// non-dismissible (e.g. the update-download progress sheet).
export function overlayClick() {
  if (_overlayDismiss) closeOverlay();
}

export function closeOverlay() {
  $("overlay").classList.remove("show");
  $("action-sheet").classList.remove("show");
  clearTimeout(overlayCloseTimer);
  overlayCloseTimer = setTimeout(() => {
    $("overlay").classList.add("hide");
    $("action-sheet").classList.add("hide");
  }, 300);
  const cb = _onOverlayClose;
  _onOverlayClose = null;
  if (cb) cb();
}

let loadingTimer = null;

export function showLoading(text = "处理中…") {
  clearTimeout(loadingTimer);
  const el = $("loading-hud");
  if (!el) return;
  const txt = el.querySelector(".loading-hud-text");
  if (txt) txt.textContent = text;
  el.classList.remove("hide");
  requestAnimationFrame(() => el.classList.add("show"));
}

export function hideLoading() {
  const el = $("loading-hud");
  if (!el) return;
  el.classList.remove("show");
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => el.classList.add("hide"), 200);
}

export function step(id, delta, min = 1) {
  const el = $(id);
  let v = parseInt(el.textContent) + delta;
  if (v < min) v = min;
  el.textContent = v;
}
