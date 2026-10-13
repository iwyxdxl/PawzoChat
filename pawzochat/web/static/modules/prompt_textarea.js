/*! PawzoChat — shared prompt textarea sizing, AGPL-3.0-or-later. */

const selector = 'textarea.prompt-input';
let initialized = false;

// Measuring with no inline height preserves each field's rows and CSS minimum,
// including the larger persona editor. Never change its value or selection.
export function resizePromptTextarea(input, keepCaretVisible = false) {
  if (!input?.isConnected || !input.matches(selector) || !input.getClientRects().length || !input.clientWidth) return;
  const scrollers = [];
  for (let node = input.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
      scrollers.push({ node, top: node.scrollTop });
    }
  }
  const previousHeight = input.offsetHeight;
  input.style.height = '';
  const defaultHeight = input.offsetHeight;
  const style = getComputedStyle(input);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  input.style.height = `${Math.max(defaultHeight, Math.ceil(input.scrollHeight + borders))}px`;
  for (const { node, top } of scrollers) node.scrollTop = top;

  if (keepCaretVisible && document.activeElement === input && input.offsetHeight > previousHeight
      && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
    const scroller = scrollers[0]?.node || document.scrollingElement;
    const viewport = window.visualViewport;
    const visibleBottom = Math.min(scroller.getBoundingClientRect().bottom,
      viewport ? viewport.offsetTop + viewport.height : window.innerHeight);
    const overflow = input.getBoundingClientRect().bottom - visibleBottom + 8;
    if (overflow > 0) scroller.scrollTop += overflow;
  }
}

// Assignments to .value do not fire input events; use this for async defaults,
// generated text and reset buttons. Hidden editors resize when revealed.
export function setPromptValue(input, value) {
  if (!input) return;
  input.value = value;
  resizePromptTextarea(input);
}

export function initPromptTextareas() {
  if (initialized) return;
  initialized = true;
  const observed = new Map();
  const pending = new Set();
  let frame = 0;
  const queue = input => {
    pending.add(input);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const field of pending) resizePromptTextarea(field);
      pending.clear();
    });
  };
  const refresh = () => observed.forEach((_, input) => queue(input));
  // Only width/visibility changes trigger a resize, so our height writes cannot
  // create a ResizeObserver loop. This also handles hidden tabs and <details>.
  const sizes = new ResizeObserver(entries => {
    for (const { target, contentRect } of entries) {
      if (!observed.has(target)) continue;
      if (observed.get(target) === contentRect.width) continue;
      observed.set(target, contentRect.width);
      if (contentRect.width) queue(target);
    }
  });
  const scan = root => {
    if (!root.isConnected) return;
    const fields = [...root.querySelectorAll(selector)];
    if (root.matches?.(selector)) fields.unshift(root);
    for (const input of fields) {
      if (observed.has(input)) continue;
      observed.set(input, 0);
      sizes.observe(input);
      queue(input);
    }
  };
  const mutations = new MutationObserver(records => {
    for (const input of observed.keys()) {
      if (input.isConnected) continue;
      sizes.unobserve(input);
      observed.delete(input);
      pending.delete(input);
    }
    for (const record of records) {
      if (record.type === 'attributes' || record.target.closest?.('style') || record.target.parentElement?.closest('style')) refresh();
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        scan(node);
        if (node.matches('style, link[rel="stylesheet"]')) refresh();
      }
    }
  });
  mutations.observe(document.body, { childList: true, subtree: true });
  mutations.observe(document.head, { childList: true, subtree: true, characterData: true });
  mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  document.addEventListener('input', event => {
    if (event.target.matches(selector)) resizePromptTextarea(event.target, true);
  }, true);
  document.addEventListener('toggle', event => {
    if (event.target.matches('details[open]')) {
      event.target.querySelectorAll(selector).forEach(queue);
    }
  }, true);
  document.addEventListener('load', event => {
    if (event.target.matches?.('link[rel="stylesheet"]')) refresh();
  }, true);
  window.addEventListener('resize', refresh);
  document.fonts?.ready.then(refresh);
  document.fonts?.addEventListener('loadingdone', refresh);
  scan(document.body);
}
