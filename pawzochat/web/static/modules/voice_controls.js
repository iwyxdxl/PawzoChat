/*! PawzoChat — shared TTS controls, AGPL-3.0-or-later. */
import { esc } from "./utils.js";
import { mountAccountVoicePicker } from "./voice_picker.js";

let draft = {};
let providers = [];
let family = "openai";
let personaProvider = "";
const personaVoices = new Map();
const byId = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));

function selectedModel() {
  const provider = providers.find(p => p.name === byId("pe-voice-provider")?.value);
  return provider?.models?.find(m => m.id === byId("pe-voice-model")?.value);
}

function options(values, selected) {
  const entries = { ...values };
  if (selected && !Object.hasOwn(entries, selected)) entries[selected] = "原设置（当前服务商不适用）";
  return Object.entries(entries).map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`).join("");
}
const row = (label, control, description = "") => `<div class="form-group"><div class="form-row">${label}${control}</div>${description ? hint(description) : ""}</div>`;
const hint = text => `<div class="form-hint">${esc(text)}</div>`;
function select(id, label, values, value) {
  return row(`<label for="${id}">${label}</label>`, `<select id="${id}">${options(values, value)}</select>`);
}
function slider(id, label, range, value, suffix = "", description = "") {
  return row(`<label for="${id}">${label}</label>`, `<div class="slider-wrap"><input type="range" id="${id}" min="${range.min}" max="${range.max}" step="${range.step}" value="${value}" data-suffix="${suffix}"><span class="slider-val">${value}${suffix}</span></div>`, description);
}
function toggle(id, label, checked, description = "") {
  return row(`<label for="${id}">${label}</label>`, `<label class="switch-wrap"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}><span class="switch-track"></span></label>`, description);
}

export function voiceControlHtml(settings, controls, prefix = "pe") {
  const id = name => `${prefix}-${name}`;
  const mm = settings.minimax || {}, mi = settings.mimo || {};
  const type = controls.family;
  let html = "";
  if (type === "elevenlabs") {
    const el = settings.elevenlabs || {};
    html += slider(id("el-stability"), "稳定度", controls.stability, el.stability ?? 0.5, "", "较低时表现更丰富，较高时声音更稳定。");
    html += slider(id("el-similarity"), "音色相似度", controls.similarity_boost, el.similarity_boost ?? 0.75);
    html += toggle(id("el-audio-tags"), "声音／语气标签", el.audio_tags_enabled === true, controls.audio_tags_hint);
  } else if (type === "mimo") {
    html += select(id("mimo-dialect"), "语言／方言", controls.dialects, mi.dialect);
    html += select(id("mimo-rate"), "语速", controls.rates, mi.speaking_rate);
    html += hint("语速通过自然语言指令控制，不对应精确倍速。");
    html += `<div class="prompt-field"><label class="prompt-label" for="${prefix}-mimo-style">风格描述</label><textarea class="prompt-input" id="${prefix}-mimo-style" maxlength="4000" rows="3" placeholder="例如：温柔、放松，像在和老朋友聊天">${esc(mi.style_instruction || "")}</textarea></div>`;
  } else {
    html += slider(id("voice-speed"), "语速", controls.speed || {min: 0.5, max: 2, step: 0.1}, settings.speed ?? 1, "x");
    if (type === "minimax") {
      html += select(id("mm-language"), "语言／方言", controls.languages, mm.language_boost);
      html += hint("跟随音色时，粤语音色自动使用粤语；选择其他语言可覆盖这一设置。");
      html += slider(id("mm-volume"), "音量", controls.volume, mm.volume);
      html += slider(id("mm-pitch"), "音调", controls.pitch, mm.pitch);
      html += toggle(id("mm-interjections"), "启用语气词", mm.interjections_enabled === true);
      html += hint(controls.interjection_hint);
      html += toggle(id("mm-pause"), "启用停顿控制", mm.pause_enabled === true);
      html += hint(controls.pause_hint);
    }
  }
  if (type === "minimax" || type === "mimo" || type === "elevenlabs") {
    html += toggle(id("voice-emotion-enabled"), "启用情绪控制", settings.emotion_enabled === true, controls.emotion_hint);
  }
  return html;
}

export function readVoiceControls(settings, family, prefix = "pe") {
  const draft = clone(settings);
  const field = name => byId(`${prefix}-${name}`);
  const read = (id, target, key, transform = value => value) => {
    const el = field(id);
    if (el) target[key] = transform(el.value);
  };
  read("voice-speed", draft, "speed", Number);
  if (family === "elevenlabs") {
    draft.elevenlabs ||= {stability: 0.5, similarity_boost: 0.75, audio_tags_enabled: false};
    read("el-stability", draft.elevenlabs, "stability", Number);
    read("el-similarity", draft.elevenlabs, "similarity_boost", Number);
    if (field("el-audio-tags")) draft.elevenlabs.audio_tags_enabled = field("el-audio-tags").checked;
  }
  if (family === "minimax") {
    read("mm-language", draft.minimax, "language_boost");
    read("mm-volume", draft.minimax, "volume", Number);
    read("mm-pitch", draft.minimax, "pitch", Number);
    if (field("mm-interjections")) draft.minimax.interjections_enabled = field("mm-interjections").checked;
    if (field("mm-pause")) draft.minimax.pause_enabled = field("mm-pause").checked;
  }
  if (family === "mimo") {
    read("mimo-dialect", draft.mimo, "dialect");
    read("mimo-rate", draft.mimo, "speaking_rate");
    read("mimo-style", draft.mimo, "style_instruction");
  }
  if (field("voice-emotion-enabled")) draft.emotion_enabled = field("voice-emotion-enabled").checked;
  draft.emotion = "";
  return draft;
}

function captureControls() {
  draft = readVoiceControls(draft, family);
}

export function collectPersonaVoiceSettings() {
  captureControls();
  return { ...clone(draft), enabled: !!byId("pe-voice-en")?.checked,
    trigger_mode: byId("pe-voice-trigger-mode")?.value || "ai",
    trigger_probability: Number(byId("pe-voice-trigger-probability")?.value ?? 50),
    provider: byId("pe-voice-provider")?.value || "",
    model: byId("pe-voice-model")?.value || "",
    voice: byId("pe-voice-voice")?.value.trim() || "" };
}

export function initPersonaVoiceControls(settings, availableProviders, defaults) {
  providers = availableProviders;
  personaProvider = byId("pe-voice-provider")?.value || "";
  personaVoices.clear();
  draft = { ...clone(defaults), ...clone(settings || {}),
    minimax: { ...defaults.minimax, ...settings?.minimax },
    mimo: { ...defaults.mimo, ...settings?.mimo },
    elevenlabs: { ...defaults.elevenlabs, ...settings?.elevenlabs } };
  const triggerMode = byId("pe-voice-trigger-mode");
  if (triggerMode) triggerMode.onchange = () => {
    byId("pe-voice-probability-fields").hidden = triggerMode.value !== "probability";
  };
  const triggerControls = byId("pe-voice-trigger-controls");
  if (triggerControls) bindVoiceControls(triggerControls);
  renderControls();
}

export function refreshPersonaVoiceControls() {
  captureControls();
  const provider = byId("pe-voice-provider")?.value || "";
  const voice = byId("pe-voice-voice");
  if (voice && provider !== personaProvider) {
    personaVoices.set(personaProvider, voice.value);
    voice.value = personaVoices.get(provider) || "";
  }
  personaProvider = provider;
  renderControls();
}

function renderControls() {
  const host = byId("pe-voice-controls");
  if (!host) return;
  const model = selectedModel();
  const controls = model?.tts_controls || { family: "openai" };
  family = controls.family;
  host.innerHTML = voiceControlHtml(draft, controls);
  bindVoiceControls(host);
  const provider = providers.find(p => p.name === byId("pe-voice-provider")?.value);
  mountAccountVoicePicker(byId("pe-account-voices"), {
    provider: provider?.name, enabled: family === "elevenlabs", saved: provider?.api_key_set !== false,
    input: byId("pe-voice-voice"),
  });
}

export function bindVoiceControls(host, prefix = "pe", onEmotionChange = () => {}) {
  host.oninput = event => {
    if (event.target.type === "range") event.target.nextElementSibling.textContent = event.target.value + (event.target.dataset.suffix || "");
  };
  const emotionToggle = byId(`${prefix}-voice-emotion-enabled`);
  if (emotionToggle) emotionToggle.onchange = () => {
    onEmotionChange(emotionToggle.checked);
  };
}

export function voiceTestEmotionHtml(controls, emotion, enabled) {
  if (!controls.emotions) return "";
  return `<div id="vt-emotion-fields" ${enabled ? "" : "hidden"}>${select("vt-emotion", "本条情绪", { ...controls.emotions, "": "自动（不指定情绪）" }, emotion)}</div>`;
}
