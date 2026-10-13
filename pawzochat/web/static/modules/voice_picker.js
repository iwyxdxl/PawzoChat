/*! PawzoChat — account voice picker, AGPL-3.0-or-later. */
import { esc } from "./utils.js";

const mounted = new WeakMap();

// Inline so the same picker also works inside a model-edit sheet.
export function mountAccountVoicePicker(host, { provider, enabled, saved = true, input }) {
  if (!host) return;
  mounted.get(host)?.controller?.abort();
  const state = { controller: null, revision: 0, token: "", search: "", voices: new Map() };
  mounted.set(host, state);
  host.replaceChildren();
  host.classList.add("voice-picker");
  host.hidden = !enabled || !input;
  if (!enabled || !input) return;
  if (!provider || !saved) {
    host.innerHTML = '<div class="form-label-secondary">保存服务商和 API Key 后可选择账户音色，也可直接填写音色 ID。</div>';
    return;
  }
  host.innerHTML = `<div class="form-stack">
    <button type="button" class="btn-outline" data-open aria-expanded="false" aria-controls="${host.id}-panel">选择账户音色</button>
    <div data-panel id="${host.id}-panel" hidden>
      <div class="form-stack">
        <input class="form-input" type="search" data-search aria-label="搜索账户音色" placeholder="搜索音色名称、描述或标签">
        <div class="form-actions">
          <button type="button" class="btn-outline" data-submit>搜索</button>
          <button type="button" class="btn-outline" data-refresh>刷新</button>
        </div>
        <div data-status class="form-label-secondary" role="status"></div>
        <div data-list class="voice-picker-list" role="group" aria-label="账户音色"></div>
        <button type="button" class="btn-outline" data-more hidden>加载更多</button>
      </div>
    </div>
  </div>`;
  const el = name => host.querySelector(`[data-${name}]`);
  const current = () => mounted.get(host) === state && host.isConnected && input.isConnected;
  const render = () => {
    el("list").innerHTML = [...state.voices.values()].map(voice =>
      `<button type="button" class="btn-outline voice-picker-option" data-voice="${esc(voice.id)}" aria-pressed="${voice.id === input.value.trim()}">
        <strong>${esc(voice.name)}</strong>
        <span class="form-label-secondary">${esc(voice.id)}</span>
        <span class="form-label-secondary">${esc([voice.category, ...Object.values(voice.labels || {})].filter(Boolean).join(" · "))}</span>
      </button>`).join("");
  };
  const load = async (more = false) => {
    state.controller?.abort();
    state.controller = new AbortController();
    const revision = ++state.revision;
    if (!more) {
      state.token = "";
      state.search = el("search").value.trim();
      state.voices.clear();
      render();
    }
    el("status").textContent = "正在加载音色…";
    el("more").hidden = true;
    const query = new URLSearchParams({search: state.search, page_size: "30"});
    if (more && state.token) query.set("next_page_token", state.token);
    try {
      // Account data must not use the general stale-while-revalidate API cache.
      const response = await fetch(`${window.PAWZOCHAT_BASE || ""}/api/voice-providers/${encodeURIComponent(provider)}/voices?${query}`, {
        signal: state.controller.signal, cache: "no-store",
      });
      const data = await response.json();
      if (!current() || revision !== state.revision) return;
      if (!response.ok) throw new Error(data.error || "加载音色失败");
      for (const voice of data.voices) state.voices.set(voice.id, voice);
      state.token = data.has_more ? data.next_page_token : "";
      render();
      el("more").hidden = !state.token;
      el("status").textContent = state.voices.size ? "选择音色后仍可手动修改 ID。" : "未找到音色，可修改搜索条件或手填 ID。";
    } catch (error) {
      if (!current() || revision !== state.revision || error.name === "AbortError") return;
      el("status").textContent = `${error.message || "加载音色失败"}；可刷新重试或手填 ID。`;
      el("more").hidden = !state.token;
    }
  };
  const setExpanded = expanded => {
    el("panel").hidden = !expanded;
    el("open").setAttribute("aria-expanded", String(expanded));
    el("open").textContent = expanded ? "收起账户音色" : "选择账户音色";
  };
  el("open").onclick = () => {
    const expanded = el("panel").hidden;
    setExpanded(expanded);
    if (expanded) load();
    else { state.revision++; state.controller?.abort(); }
  };
  el("submit").onclick = () => load();
  el("refresh").onclick = () => load();
  el("more").onclick = () => load(true);
  el("search").onkeydown = event => {
    if (event.key === "Enter") { event.preventDefault(); load(); }
  };
  el("list").onclick = event => {
    const button = event.target.closest("[data-voice]");
    if (!button || !current()) return;
    input.value = button.dataset.voice;
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
    setExpanded(false);
    el("open").focus({preventScroll: true});
    state.revision++;
    state.controller?.abort();
  };
}
