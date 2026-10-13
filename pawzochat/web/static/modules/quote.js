import { esc, escAttr } from "./utils.js";

// Shared by the live conversation and history editor.
export function renderQuoteBox(quote, media = [], localId = "", personaId = "", groupId = "") {
  if (!quote && !media.length) return "";
  const base = window.PAWZOCHAT_BASE || "";
  const attachments = media.map((block, i) => {
    if (block.expired || !localId) return '<div class="quote-expired">引用附件已失效</div>';
    const filename = (block.path || '').split(/[\\/]/).pop();
    const kind = block.type === 'voice' ? 'voice' : block.type === 'file' ? 'files' : 'images';
    const url = groupId
      ? block.url ? (/^https?:/i.test(block.url) ? block.url : base + block.url) : `${base}/api/groups/${encodeURIComponent(groupId)}/media/${kind}/${encodeURIComponent(filename || '')}`
      : `${base}/api/conversations/${encodeURIComponent(personaId)}/quote-media/${encodeURIComponent(localId)}/${i}`;
    if (block.type === "image" || block.type === "emoji") {
      return `<img class="quote-image" src="${escAttr(url)}" loading="lazy" alt="引用图片" onclick="PawzoChat.openImagePreview(this.src)">`;
    }
    if (block.type === "voice") {
      return `<audio controls preload="none" src="${escAttr(url)}"></audio>${block.text ? `<div>${esc(block.text)}</div>` : ""}`;
    }
    return `<a href="${escAttr(url)}" target="_blank" rel="noopener">${esc(block.name || "引用附件")}</a>`;
  }).join("");
  return `<div class="msg-quote"><div>${esc(quote || "")}</div>${attachments}</div>`;
}
