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
// Keep sandboxed plugin panels as tall as their own content. This script runs
// inside the iframe, where the host cannot read the document directly.
(() => {
  if (window.__pawzoConfigResizeInstalled || window.parent === window) return;
  window.__pawzoConfigResizeInstalled = true;

  let frame = 0;
  let stopped = false;
  let contentChanged = true;
  let observedBody = null;
  let previous = null;
  let reportedHeight = null;
  let viewportWidth = window.innerWidth;

  const pixels = value => Number.parseFloat(value) || 0;

  function measure() {
    frame = 0;
    if (stopped || !document.body) return;
    const body = document.body;
    const root = document.documentElement;
    const rect = body.getBoundingClientRect();
    const style = getComputedStyle(body);
    const rootStyle = getComputedStyle(root);
    const top = rect.top + window.scrollY;
    // documentElement.scrollHeight has the iframe viewport as a lower bound,
    // so using it here would prevent a panel from shrinking after a collapse.
    let bottom = top + rect.height;
    if (document.compatMode !== "BackCompat" || body.scrollHeight > window.innerHeight) {
      bottom = Math.max(bottom, top + body.clientTop + body.scrollHeight);
    }
    const height = Math.max(1, Math.ceil(bottom + pixels(style.marginBottom)
      + pixels(rootStyle.paddingBottom) + pixels(rootStyle.borderBottomWidth)
      + pixels(rootStyle.marginBottom)));
    const current = {
      height,
      viewportHeight: window.innerHeight,
      width: rect.width,
    };
    // A viewport-sized body (for example 100vh plus padding) can otherwise
    // grow forever in response to the height we just reported. Ignore an
    // equal-sized echo of the host's own resize; actual content changes and
    // width changes must still be measured.
    const viewportDelta = previous ? current.viewportHeight - previous.viewportHeight : 0;
    const viewportEcho = !contentChanged && previous && viewportDelta !== 0
      && Math.abs(current.width - previous.width) < 1
      && Math.abs((height - previous.height) - viewportDelta) < 1;
    previous = current;
    contentChanged = false;
    if (viewportEcho || !Number.isFinite(height) || height === reportedHeight) return;
    reportedHeight = height;
    window.parent.postMessage({ type: "pawzo:config-resize", height }, "*");
  }

  function schedule(changed = false) {
    if (stopped) return;
    contentChanged ||= changed;
    if (!frame) frame = requestAnimationFrame(measure);
  }

  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => schedule()) : null;
  function observeBody() {
    if (document.body === observedBody) return;
    resizeObserver?.disconnect();
    observedBody = document.body;
    if (observedBody) resizeObserver?.observe(observedBody);
  }

  const mutationObserver = new MutationObserver(() => {
    observeBody();
    schedule(true);
  });
  mutationObserver.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
  });
  observeBody();

  const onContentChange = () => schedule(true);
  const onResize = () => {
    if (viewportWidth === window.innerWidth) return;
    viewportWidth = window.innerWidth;
    schedule(true);
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("load", onContentChange, true);
  window.addEventListener("error", onContentChange, true);
  document.fonts?.addEventListener("loadingdone", onContentChange);
  document.fonts?.ready.then(onContentChange);

  window.addEventListener("pagehide", event => {
    // A cached document resumes with the same observers and listeners.
    if (event.persisted) return;
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    mutationObserver.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener("resize", onResize);
    window.removeEventListener("load", onContentChange, true);
    window.removeEventListener("error", onContentChange, true);
    document.fonts?.removeEventListener("loadingdone", onContentChange);
  });
  schedule(true);
})();
