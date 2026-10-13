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
import { setPromptValue } from "./prompt_textarea.js";
import { api } from "./api.js";
import { showLoading, hideLoading } from "./ui.js";
import { avatarHtml, esc, iconHtml, CAP_ICONS, ILLEGAL_NAME_RE, escAttr, jsArg, voiceOptionsHtml } from "./utils.js";
import { openCropModal } from "./contacts.js";
import { switchTab } from "./navigation.js";
import { fetchQrStatus, renderVerifyInput, clearVerifyInput } from "./qr_verify.js";

const SCREEN_ID = "quick-setup-screen";
const STEP_LABELS = ["配置服务商", "新建角色", "绑定账号"];
const _CAM_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;

let _step4TelemetryEnabled = true;  // default ON in wizard regardless of config default

let _currentStep = 1;
let _newPersonaId = null;
let _pendingAvatarBlob = null;
let _qrPolling = false;
let _qrPollBaseUrl = "";
let _qrVerifyCode = "";
let _qrSession = 0;   // monotonic; bumped per scan so a superseded scan's poll loop self-cancels

// Step 3 channel picker state
let _channels = [];            // from GET /api/accounts/channels (web channel excluded server-side)
let _selectedChannelType = ""; // current dropdown value; "" = neutral placeholder
let _pendingFormChannel = "";  // channel_type of the form channel being submitted
let _pendingFormFields = [];   // its declarative fields[] schema

let _providers = [];
let _emojiGroups = [];
let _defaultSysInstr = "";
let _invitationCode = "";

let _createMode = "manual";
let _pendingImportFile = null;
let _importIncludeWorldbook = true;

let _existingNames = [];   // existing persona names (trimmed), for client-side duplicate-name check
let _generating = false;   // true while one-click persona generation runs; prevents racing the Next button

let _imageProviders = [];
let _pawapiImageReady = false;
let _pawapiDefaultImageModel = "";
let _pawapiDefaultImageModelName = "";
const _PAWAPI_DEFAULT_IMAGE_MODEL_ID = "gemini-3.1-flash-image-preview";

let _voiceProviders = [];
let _pawapiVoiceReady = false;
let _pawapiDefaultVoiceModel = "";
let _pawapiDefaultVoiceModelName = "";
let _pawapiVoiceCatalog = [];
let _voicePresetVoices = {};
const _PAWAPI_DEFAULT_VOICE_MODEL_ID = "speech-2.8-hd";

const _PAWAPI_REGISTER_BASE = "https://paw.v1chat.cc/register";
function _pawapiRegisterUrl() {
  return _invitationCode
    ? `${_PAWAPI_REGISTER_BASE}?aff=${encodeURIComponent(_invitationCode)}`
    : _PAWAPI_REGISTER_BASE;
}

/* ================================================================
   Dismiss / finish helpers
   ================================================================ */

async function _finishWizard() {
  // If user left telemetry ON in step 4, save it and send the event immediately.
  if (_step4TelemetryEnabled) {
    try {
      await api.patch("/api/telemetry/settings", { enabled: true });
      await api.post("/api/telemetry/send", { event: "quick_setup_complete" });
    } catch (_) { /* best-effort */ }
  }

  try { await api.post("/api/setup/skip", {}); } catch (_) { /* best-effort */ }
  _qrPolling = false;
  _pendingImportFile = null;
  _createMode = "manual";
  _importIncludeWorldbook = true;
  const el = document.getElementById(SCREEN_ID);
  if (!el) return;
  el.classList.add("qs-fade-out");
  el.addEventListener("animationend", () => {
    el.remove();
    api.invalidate(/^\/api\/(conversations|personas)(?:\/|\?|$)/);
    switchTab("chat", { refresh: true });
  }, { once: true });
}

/* ================================================================
   Stepper HTML
   ================================================================ */

function _stepperHtml(active) {
  // Step 4 (privacy page) is not a numbered step — show all 3 steps as done.
  const displayActive = active > 3 ? 4 : active;
  return `<div class="qs-stepper">${STEP_LABELS.map((label, i) => {
    const n = i + 1;
    const cls = n < displayActive ? "done" : n === displayActive ? "active" : "";
    return `<div class="qs-stepper-step ${cls}">` +
      `<span class="qs-stepper-dot">${n < displayActive ? "✓" : n}</span>` +
      `<span class="qs-stepper-label">${label}</span></div>`;
  }).join('<div class="qs-stepper-line"></div>')}</div>`;
}

/* ================================================================
   Step 1 — PawAPI
   ================================================================ */

function _step1Html() {
  const base = window.PAWZOCHAT_BASE || "";
  return `
  <div class="qs-header">
    <div class="qs-logo"><img src="${base}/static/logo.png" alt="PawzoChat"></div>
    <h1 class="qs-title">欢迎使用 PawzoChat</h1>
    <p class="qs-subtitle">快速配置，即刻开启 AI 对话</p>
  </div>

  <div class="qs-info-section">
    <div class="qs-info-item">
      ${iconHtml("ri-star-smile-line", "qs-info-icon")}
      <p><strong>PawAPI</strong> 是与 PawzoChat 合作的一站式 AI 服务商，支持 DeepSeek、Gemini、Claude、GPT 等多款主流大模型。我们推荐使用 PawAPI 一键配置服务商，并<strong>自动配置联网搜索和图片识别mcp功能</strong>。</p>
    </div>
    <div class="qs-info-item">
      ${iconHtml("ri-exchange-line", "qs-info-icon")}
      <p><strong>PawAPI</strong> 是专门适配新一代架构设计的 API 接口，如果您是原 <strong>WeAPI</strong> 用户，可在注册 <strong>PawAPI</strong> 账号后，<a href="https://work.weixin.qq.com/kfid/kfc499cf4c35f8ec1c1" target="_blank" rel="noopener">联系客服</a>将 <strong>WeAPI</strong> 余额迁移至新账户。</p>
    </div>
  </div>

  <div class="qs-steps">
    <div class="qs-step"><span class="qs-step-num">1</span>
      <div class="qs-step-body"><span>打开 <a id="qs-pawapi-register-link" href="${_pawapiRegisterUrl()}" target="_blank" rel="noopener">paw.v1chat.cc</a> 注册 PawAPI 账号</span></div>
    </div>
    <div class="qs-step"><span class="qs-step-num">2</span>
      <div class="qs-step-body"><span>进入控制台 → 令牌管理 → 找到初始令牌 → 点击复制</span></div>
    </div>
    <div class="qs-step"><span class="qs-step-num">3</span>
      <div class="qs-step-body"><span>将令牌粘贴到下方输入框</span></div>
    </div>
  </div>

  <div class="qs-input-group">
    <input id="qs-api-key" type="text" placeholder="在此粘贴 PawAPI 令牌（sk-...）" autocomplete="off" spellcheck="false">
    <button type="button" class="qs-btn-paste" onclick="PawzoChat.qsPasteApiKey()">粘贴</button>
  </div>

  <div class="qs-actions">
    <button class="qs-btn qs-btn-primary" id="qs-btn-submit" onclick="PawzoChat.submitQuickSetup()">下一步</button>
    <button class="qs-btn qs-btn-secondary" onclick="PawzoChat.skipQuickSetup()">跳过此步，稍后手动配置</button>
  </div>

  <div class="qs-footer">
    <p class="qs-migrate">${iconHtml("ri-information-line", "qs-migrate-icon")}<span>如果您不想使用 PawAPI，或已拥有其他服务商的 API Key，可以跳过此步骤，稍后在设置 → 服务商管理中手动添加。请放心，PawzoChat 的所有功能均可正常使用。</span></p>
  </div>`;
}

/* ================================================================
   Step 2 — Create Persona
   ================================================================ */

function _buildModelOptions(provName) {
  const prov = _providers.find(pr => pr.name === provName);
  const models = prov?.models || [];
  let opts = `<option value="" disabled selected>选择模型</option>`;
  for (const m of models) {
    const caps = (m.capabilities || []).map(c => CAP_ICONS[c] || "").join("");
    opts += `<option value="${esc(m.id)}">${esc(m.name || m.id)} ${caps}</option>`;
  }
  return opts;
}

function _defaultProviderName() {
  return (_providers.find(p => p.name === "PawAPI") || _providers[0])?.name || "";
}

function _buildProviderOptions(selectedName = "") {
  const activeName = selectedName || _defaultProviderName();
  return _providers.map(pr => {
    const sel = pr.name === activeName ? "selected" : "";
    return `<option value="${esc(pr.name)}" ${sel}>${esc(pr.name)}</option>`;
  }).join("");
}

function _hasLocalModel(providerName, modelId) {
  const prov = _providers.find(pr => pr.name === providerName);
  return !!prov && (prov.models || []).some(m => m.id === modelId);
}

async function _loadStep2Data() {
  const [provRes, emojiRes, sysRes, imgRes, voiceRes, personasRes] = await Promise.all([
    api.get("/api/providers").catch(() => ({ providers: [] })),
    api.get("/api/emoji/groups").catch(() => ({ groups: [] })),
    api.get("/api/personas/default-system-instructions").catch(() => ({ text: "" })),
    api.get("/api/image-providers").catch(() => ({ providers: [] })),
    api.get("/api/voice-providers").catch(() => ({ providers: [], preset_voices: {} })),
    api.get("/api/personas").catch(() => ({ personas: [] })),
  ]);
  _providers = provRes.providers || [];
  _emojiGroups = emojiRes.groups || [];
  _defaultSysInstr = sysRes.text || "";
  _imageProviders = imgRes.providers || [];
  _voiceProviders = voiceRes.providers || [];
  _voicePresetVoices = voiceRes.preset_voices || {};
  // Backend dedups by exact trimmed string (api_personas.py: _name_exists); mirror it here.
  _existingNames = (Array.isArray(personasRes.personas) ? personasRes.personas : [])
    .map(p => (p && p.name || "").trim())
    .filter(Boolean);
  _recomputePawapiImageState();
  _recomputePawapiVoiceState();
}

// Matches backend _name_exists: trim then exact compare, so we never reject a name the backend would accept.
function _nameExists(name) {
  const n = (name || "").trim();
  return !!n && _existingNames.some(x => x === n);
}

// Inline name-field error. Rendered inside the wizard card with inline styles so
// it stays visible regardless of the full-screen overlay's stacking order — and
// works even when the cached stylesheet is stale, unlike a toast.
function _setNameError(msg) {
  const el = document.getElementById("qs-name-error");
  if (!el) return;
  el.textContent = msg || "";
  el.style.display = msg ? "block" : "none";
}

// Wizard-local toast (see showQuickSetup). Same role as the global toast helper
// but rendered inside the overlay so it isn't hidden behind it. Colours reuse the
// cached theme vars, matching the global toast's success/error/info palette.
let _qsToastTimer = null;
function _qsToast(msg, type = "info") {
  const el = document.getElementById("qs-toast");
  if (!el) return;
  el.textContent = msg;
  el.style.background = type === "success" ? "var(--success)"
    : type === "error" ? "var(--danger)"
    : "var(--text-2)";
  el.style.opacity = "1";
  el.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(_qsToastTimer);
  _qsToastTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(-20px)";
  }, 3000);
}

function _recomputePawapiImageState() {
  const paw = (_imageProviders || []).find(p => p.name === "PawAPI");
  const models = (paw && paw.models) || [];
  if (paw && paw.api_key_set && models.length > 0) {
    const preferred = models.find(m => m.id === _PAWAPI_DEFAULT_IMAGE_MODEL_ID);
    const selected = preferred || models[0];
    _pawapiDefaultImageModel = selected.id;
    _pawapiDefaultImageModelName = selected.name || selected.id;
    _pawapiImageReady = true;
  } else {
    _pawapiDefaultImageModel = "";
    _pawapiDefaultImageModelName = "";
    _pawapiImageReady = false;
  }
}

function _recomputePawapiVoiceState() {
  const paw = (_voiceProviders || []).find(p => p.name === "PawAPI");
  const models = (paw && paw.models) || [];
  if (paw && paw.api_key_set && models.length > 0) {
    const preferred = models.find(m => m.id === _PAWAPI_DEFAULT_VOICE_MODEL_ID);
    const selected = preferred || models[0];
    _pawapiDefaultVoiceModel = selected.id;
    _pawapiDefaultVoiceModelName = selected.name || selected.id;
    // Resolve voice catalog from the selected model
    const catalogName = selected.voice_catalog || "";
    _pawapiVoiceCatalog = catalogName && _voicePresetVoices[catalogName]
      ? _voicePresetVoices[catalogName]
      : [];
    _pawapiVoiceReady = true;
  } else {
    _pawapiDefaultVoiceModel = "";
    _pawapiDefaultVoiceModelName = "";
    _pawapiVoiceCatalog = [];
    _pawapiVoiceReady = false;
  }
}

function _imgToggleHtml(idSuffix) {
  const ready = _pawapiImageReady;
  const inputId = `qs-img-en${idSuffix}`;
  const wrapClass = ready ? "qs-field qs-img-toggle" : "qs-field qs-img-toggle qs-img-toggle-disabled";
  const checked = ready ? " checked" : "";
  const disabled = ready ? "" : " disabled";
  const hint = ready
    ? `默认以角色头像作为参考图，使用 PawAPI 的 ${esc(_pawapiDefaultImageModelName || "默认生图")} 模型生成。可稍后在角色编辑页面调整。`
    : "快速配置仅支持配置 PawAPI 作为生图服务商，如果您需要使用生图功能，请稍后在「设置 → 生图服务商」中手动配置您的生图服务商，并在角色编辑页面启用生图。";
  return `
    <div class="${wrapClass}">
      <div class="qs-toggle-row">
        <label class="qs-field-label" for="${inputId}">启用生图功能</label>
        <label class="switch-wrap">
          <input type="checkbox" id="${inputId}"${checked}${disabled}>
          <span class="switch-track"></span>
        </label>
      </div>
      <div class="qs-hint qs-img-hint"><span>${hint}</span></div>
    </div>`;
}

function _buildImageGenerationPatch(checkboxId) {
  const el = document.getElementById(checkboxId);
  if (!el || !el.checked || !_pawapiImageReady || !_pawapiDefaultImageModel) return null;
  return {
    enabled: true,
    provider: "PawAPI",
    model: _pawapiDefaultImageModel,
  };
}

function _voiceToggleHtml(idSuffix) {
  const ready = _pawapiVoiceReady;
  const toggleId = `qs-voice-en${idSuffix}`;
  const wrapClass = ready ? "qs-field qs-img-toggle" : "qs-field qs-img-toggle qs-img-toggle-disabled";
  const disabled = ready ? "" : " disabled";
  const hint = ready
    ? `使用 PawAPI 的 ${esc(_pawapiDefaultVoiceModelName || "默认语音")} 模型合成语音。可稍后在角色编辑页面调整。`
    : "快速配置仅支持配置 PawAPI 作为语音服务商，如果您需要使用语音功能，请稍后在「设置 → 语音服务商」中手动配置您的语音服务商，并在角色编辑页面启用语音。";

  let voiceDropdownHtml = "";
  if (ready && _pawapiVoiceCatalog.length > 0) {
    const voiceId = `qs-voice${idSuffix}`;
    const listId = `qs-voice-list${idSuffix}`;
    voiceDropdownHtml = `
    <div class="qs-field" style="margin-top:12px">
      <label class="qs-field-label" for="${voiceId}">音色 (voice ID)</label>
      <input class="form-input" id="${voiceId}" list="${listId}" value="" placeholder="请选择音色或输入音色 ID" spellcheck="false" autocomplete="off" style="flex:1;text-align:left">
      <datalist id="${listId}">${voiceOptionsHtml(_pawapiVoiceCatalog)}</datalist>
      <div class="qs-hint qs-img-hint"><span>音色 ID 可自由输入；预设列表随所选模型的音色体系变化。可稍后在角色编辑页面调整。</span></div>
    </div>`;
  }

  return `
    <div class="${wrapClass}">
      <div class="qs-toggle-row">
        <label class="qs-field-label" for="${toggleId}">启用语音功能</label>
        <label class="switch-wrap">
          <input type="checkbox" id="${toggleId}"${disabled}>
          <span class="switch-track"></span>
        </label>
      </div>
      <div class="qs-hint qs-img-hint"><span>${hint}</span></div>
      ${voiceDropdownHtml}
    </div>`;
}

function _buildVoiceGenerationPatch(checkboxId) {
  const el = document.getElementById(checkboxId);
  if (!el || !el.checked || !_pawapiVoiceReady || !_pawapiDefaultVoiceModel) return null;
  const idSuffix = checkboxId.replace("qs-voice-en", "");
  const voiceInput = document.getElementById(`qs-voice${idSuffix}`);
  const voiceVal = voiceInput ? voiceInput.value.trim() : "";
  return {
    enabled: true,
    provider: "PawAPI",
    model: _pawapiDefaultVoiceModel,
    voice: voiceVal,
    speed: 1.0,
  };
}

function _step2Html() {
  const hasProviders = _providers.length > 0;
  const defaultProviderName = _defaultProviderName();
  const provOptions = _buildProviderOptions(defaultProviderName);
  const initialModelOpts = defaultProviderName
    ? _buildModelOptions(defaultProviderName)
    : `<option value="" disabled selected>先选择服务商</option>`;

  const manualActive = _createMode !== "import";
  const importFileName = _pendingImportFile ? _pendingImportFile.name : "";

  return `
  <div class="qs-header">
    <h1 class="qs-title">新建角色</h1>
    <p class="qs-subtitle">创建您的第一个 AI 角色</p>
  </div>

  <div class="qs-mode-tabs" role="tablist">
    <button type="button" class="qs-mode-tab ${manualActive ? "active" : ""}" id="qs-mode-tab-manual" onclick="PawzoChat.qsSetCreateMode('manual')">手动创建</button>
    <button type="button" class="qs-mode-tab ${manualActive ? "" : "active"}" id="qs-mode-tab-import" onclick="PawzoChat.qsSetCreateMode('import')">导入角色卡</button>
  </div>

  <input type="file" id="qs-avatar-input" accept="image/*" style="display:none" onchange="PawzoChat.qsAvatarSelected(this)">

  <div id="qs-manual-panel" class="qs-mode-panel qs-form-section"${manualActive ? "" : " hidden"}>
    <div class="qs-avatar-row">
      <div class="qs-avatar-wrap" onclick="document.getElementById('qs-avatar-input').click()">
        ${avatarHtml("?", "lg", "")}
        <div class="avatar-cam">${_CAM_SVG}</div>
      </div>
    </div>

    <div class="qs-field">
      <label class="qs-field-label">角色名称</label>
      <input id="qs-persona-name" type="text" placeholder="输入角色名称" class="qs-field-input" oninput="PawzoChat.qsClearNameError()">
      <div id="qs-name-error" style="display:none;color:var(--danger);font-size:13px;line-height:1.4;margin-top:6px"></div>
    </div>

    ${hasProviders ? `
    <div class="qs-field">
      <label class="qs-field-label">服务商</label>
      <select id="qs-provider" class="qs-field-input" onchange="PawzoChat.qsProviderChange()">
        <option value="">选择服务商</option>${provOptions}
      </select>
    </div>
    <div class="qs-field">
      <label class="qs-field-label">模型</label>
      <select id="qs-model" class="qs-field-input">${initialModelOpts}</select>
    </div>
    <div class="qs-field">
      <label class="qs-field-label">一键生成人设</label>
      <div class="qs-input-group">
        <input id="qs-gen-prompt" type="text" class="qs-field-input" placeholder="一句话描述想要的角色，如「生成xx游戏的xx角色的提示词」" autocomplete="off" spellcheck="false">
        <button type="button" class="qs-btn-paste" id="qs-gen-btn" onclick="PawzoChat.qsGeneratePersona()">生成</button>
      </div>
    </div>` : `
    <div class="qs-hint">
      ${iconHtml("ri-information-line", "qs-hint-icon")}
      <span>您还没有配置服务商，可以先创建角色，稍后在角色编辑中选择模型。</span>
    </div>`}

    <div class="qs-field">
      <label class="qs-field-label">人设设定</label>
      <textarea id="qs-character" class="prompt-input" placeholder="描述角色的背景、性格、经历…" rows="6"></textarea>
    </div>
    <div class="qs-field">
      <label class="qs-field-label">输出示例</label>
      <textarea id="qs-examples" class="prompt-input" placeholder="输入角色的经典台词作为风格参考…" rows="2"></textarea>
    </div>
    <div class="qs-field">
      <label class="qs-field-label">系统提示词</label>
      <textarea id="qs-system" class="prompt-input" rows="3">${esc(_defaultSysInstr)}</textarea>
    </div>
    ${_imgToggleHtml("")}
    ${_voiceToggleHtml("")}
  </div>

  <div id="qs-import-panel" class="qs-mode-panel"${manualActive ? " hidden" : ""}>
    <input type="file" id="qs-import-file" accept=".png,.json,.zip" style="display:none" onchange="PawzoChat.qsImportFilePicked(this)">
    <div class="qs-import-drop">
      <div class="qs-import-icon">${iconHtml("ri-upload-cloud-2-line")}</div>
      <div class="qs-import-hint">
        支持 SillyTavern v3 角色卡（.png / .json）<br>
        以及 PawzoChat 角色包（.zip）
      </div>
      <button type="button" class="qs-btn qs-btn-outline" onclick="document.getElementById('qs-import-file').click()">选择角色卡文件</button>
      <div id="qs-import-file-label" class="qs-import-file-label"${importFileName ? "" : " hidden"}>${importFileName ? `已选：${esc(importFileName)}` : ""}</div>
    </div>
    <label class="qs-import-wb-row">
      <input type="checkbox" id="qs-import-wb"${_importIncludeWorldbook ? " checked" : ""} onchange="PawzoChat.qsImportWbToggle(this)">
      <span>同时导入角色卡附带的世界书</span>
    </label>
    ${hasProviders ? `
    <div class="qs-import-config qs-form-section">
      <div class="qs-field">
        <label class="qs-field-label">服务商</label>
        <select id="qs-import-provider" class="qs-field-input" onchange="PawzoChat.qsImportProviderChange()">
          <option value="">选择服务商</option>${provOptions}
        </select>
      </div>
      <div class="qs-field">
        <label class="qs-field-label">模型</label>
        <select id="qs-import-model" class="qs-field-input">${initialModelOpts}</select>
      </div>
    </div>` : `
    <div class="qs-hint qs-import-config">
      ${iconHtml("ri-information-line", "qs-hint-icon")}
      <span>您还没有配置服务商，可以先导入角色，稍后在角色编辑中选择模型。</span>
    </div>`}
    ${_imgToggleHtml("-import")}
    ${_voiceToggleHtml("-import")}
  </div>

  <div class="qs-actions">
    <button class="qs-btn qs-btn-primary" id="qs-btn-submit" onclick="PawzoChat.submitQuickSetup()">下一步</button>
    <button class="qs-btn qs-btn-secondary" onclick="PawzoChat.skipQuickSetup()">跳过此步，稍后手动配置</button>
  </div>`;
}

/* ================================================================
   Step 3 — WeChat Bind
   ================================================================ */

async function _loadStep3Data() {
  let accounts = [], links = [];
  try {
    const [acctRes, linkRes, chanRes] = await Promise.all([
      api.get("/api/accounts"),
      api.get("/api/wechat-links"),
      api.get("/api/accounts/channels").catch(() => ({ channels: [] })),
    ]);
    accounts = acctRes.accounts || [];
    links = linkRes.links || [];
    _channels = chanRes.channels || [];
  } catch (_) { /* best-effort */ }
  // Fallback: if the channels endpoint failed/empty, synthesize a WeChat-QR
  // channel so the frictionless first-run scan still works.
  if (!_channels.length) {
    _channels = [{ type: "wechat", name: "微信", method: "qr", fields: [], hint: "" }];
  }
  return { accounts, links };
}

function _step3Html(accounts, links) {
  const linkMap = {};
  links.forEach(l => { linkMap[l.account_id] = l; });

  const hasAccounts = accounts.length > 0;
  const hasPersona = !!_newPersonaId;

  let accountListHtml = "";
  if (hasAccounts) {
    accountListHtml = accounts.map(a => {
      const linked = linkMap[a.bot_id];
      const displayName = a.note || `Bot: ${a.bot_id.substring(0, 16)}…`;
      const channelTag = a.channel_name
        ? `<span style="font-size:11px;color:var(--text-3);border:1px solid var(--divider);border-radius:6px;padding:1px 6px;flex:none">${esc(a.channel_name)}</span>`
        : "";
      const statusDot = a.online
        ? `<span class="presence-dot online"></span>`
        : `<span class="presence-dot offline"></span>`;
      const isOccupied = linked && linked.persona_id !== _newPersonaId;

      if (isOccupied) {
        return `<div class="qs-account-item disabled">
          <div class="qs-account-info">${statusDot}<span class="qs-account-name">${esc(displayName)}</span>${channelTag}</div>
          <span class="qs-account-status">已被「${esc(linked.persona_name)}」占用</span>
        </div>`;
      }

      const alreadyBound = linked && linked.persona_id === _newPersonaId;
      if (alreadyBound) {
        return `<div class="qs-account-item bound">
          <div class="qs-account-info">${statusDot}<span class="qs-account-name">${esc(displayName)}</span>${channelTag}</div>
          <span class="qs-account-status bound-label">已绑定</span>
        </div>`;
      }

      const bindBtn = hasPersona
        ? `<button class="qs-btn-sm" onclick="PawzoChat.qsSelectAccount(${jsArg(a.bot_id)})">绑定</button>`
        : "";
      return `<div class="qs-account-item">
        <div class="qs-account-info">${statusDot}<span class="qs-account-name">${esc(displayName)}</span>${channelTag}</div>
        ${bindBtn}
      </div>`;
    }).join("");
  }

  const placeholderOpt = _selectedChannelType
    ? ""
    : `<option value="" disabled selected>选择通道…</option>`;
  const channelOptions = _channels.map(c =>
    `<option value="${escAttr(c.type)}"${c.type === _selectedChannelType ? " selected" : ""}>${esc(c.name)}</option>`
  ).join("");

  return `
  <div class="qs-header">
    <h1 class="qs-title">绑定账号</h1>
    <p class="qs-subtitle">${hasPersona ? "为刚刚创建的角色绑定一个聊天账号" : "添加聊天账号，稍后可在对话中绑定角色"}</p>
  </div>

  <div id="qs-bind-content">
    ${hasAccounts ? `
    <div class="qs-section-label">已有账号</div>
    <div class="qs-account-list" id="qs-account-list">${accountListHtml}</div>` : ""}

    <div class="qs-section-label"${hasAccounts ? ' style="margin-top:16px"' : ""}>添加账号</div>
    <div class="qs-field">
      <label class="qs-field-label" for="qs-channel-select">通道</label>
      <select id="qs-channel-select" class="qs-field-input" onchange="PawzoChat.qsChannelChange()">
        ${placeholderOpt}${channelOptions}
      </select>
    </div>
    <div id="qs-channel-body"></div>
  </div>

  <div class="qs-actions" style="margin-top:20px">
    <button class="qs-btn qs-btn-primary" id="qs-btn-submit" onclick="PawzoChat.submitQuickSetup()">完成配置</button>
    <button class="qs-btn qs-btn-secondary" onclick="PawzoChat.skipQuickSetup()">跳过此步，稍后手动配置</button>
  </div>`;
}

/* ================================================================
   Step 4 — Privacy & Software Statement
   ================================================================ */

function _step4Html() {
  const sectionTextStyle = "padding:12px 16px;font-size:14px;color:var(--text-2);line-height:1.7";
  const ulStyle = "padding-left:18px;margin:8px 0";
  const headerStyle = "cursor:pointer;display:flex;align-items:center;justify-content:space-between;user-select:none";
  const checked = _step4TelemetryEnabled ? " checked" : "";
  const statusText = _step4TelemetryEnabled ? "已开启" : "已关闭";
  const statusColor = _step4TelemetryEnabled ? "var(--success,#22c55e)" : "var(--text-3)";

  return `
  <div class="qs-header">
    <h1 class="qs-title">隐私与说明</h1>
    <p class="qs-subtitle">了解软件声明和隐私政策</p>
  </div>

  <div class="card qs-collapse-card">
    <div class="card-header qs-collapse-header" onclick="PawzoChat.qsToggleCollapse(this)" style="${headerStyle}">
      <span>软件说明</span>
      <span class="qs-collapse-arrow" style="font-size:13px;color:var(--primary)">展开</span>
    </div>
    <div class="qs-collapse-body" hidden>
      <div style="${sectionTextStyle}">
        <p><b>法律与合规：</b>请遵守你所在地区的法律法规，不要将 PawzoChat 用于任何违法、违规或侵害他人合法权益的用途。如果使用微信、QQ 等第三方平台接入，请务必遵守对应平台的官方规则。</p>
        <p><b>关于 AI 生成内容：</b>PawzoChat 的回复由你所配置的大语言模型生成，作者无法预知也无法控制 AI 的具体发言内容。AI 输出的观点、建议或信息仅供参考，作者不对其准确性、合法性或由此产生的后果承担责任。</p>
        <p><b>关于人设卡和世界书：</b>PawzoChat 兼容 SillyTavern（酒馆）格式的人设卡和世界书，仅是为了让你更方便地复用已有创作。如使用或传播他人创作，请务必事先取得原作者的同意。</p>
        <p><b>最后：</b>以上声明并不代表我们逃避应当承担的必要责任。我们会持续完善 PawzoChat，遇到问题或建议都欢迎反馈。</p>
      </div>
    </div>
  </div>

  <div class="card qs-collapse-card">
    <div class="card-header qs-collapse-header" onclick="PawzoChat.qsToggleCollapse(this)" style="${headerStyle}">
      <span>隐私说明</span>
      <span class="qs-collapse-arrow" style="font-size:13px;color:var(--primary)">展开</span>
    </div>
    <div class="qs-collapse-body" hidden>
      <div style="${sectionTextStyle}">
        <p>我们希望了解大概有多少人在用 PawzoChat，因此自 v0.1.5 版本起添加了匿名使用统计。这仅为了帮助我们判断接下来开发什么功能、修复哪些问题，<b>不会收集你的任何个人信息</b>。</p>
        <p>PawzoChat 启动时，以及之后每 30 分钟，会发送一条匿名统计，只包含：</p>
        <ul style="${ulStyle}">
          <li><b>一串随机字符串</b> — 用来区分新老用户，与你的任何信息都无关</li>
          <li><b>PawzoChat 的版本号</b></li>
          <li><b>你用的是哪种操作系统</b> — Windows、macOS 或 Linux，不含具体版本号</li>
        </ul>
        <p>除了完成网络请求所必需的连接信息外，不会发送你的 IP 地址或定位信息。</p>
        <p style="color:var(--error,#e74c3c)"><b>绝不会收集：</b>聊天记录、消息内容、账号信息、角色设定、API Key、个人身份信息、设备硬件信息等任何隐私数据。</p>
      </div>
      <div class="form-group" style="border-top:1px solid var(--divider);margin:0 16px;padding:12px 0">
        <div class="form-row" style="padding:0">
          <label>匿名使用统计</label>
          <span style="flex:1;text-align:right;font-size:13px;color:${statusColor};margin-right:12px" id="qs-tele-status">${statusText}</span>
          <label class="switch-wrap"><input type="checkbox" id="qs-tele-toggle"${checked}
            onchange="PawzoChat.qsToggleStep4Telemetry()"><span class="switch-track"></span></label>
        </div>
      </div>
      <div class="form-hint">你可以随时在设置中关闭。关闭后立即生效，无需重启程序。</div>
    </div>
  </div>

  <div class="qs-actions">
    <button class="qs-btn qs-btn-primary" id="qs-btn-submit" onclick="PawzoChat.finishQuickSetup()">开始使用</button>
  </div>`;
}

export function qsToggleCollapse(headerEl) {
  const body = headerEl.nextElementSibling;
  const arrow = headerEl.querySelector(".qs-collapse-arrow");
  if (!body) return;
  if (body.hidden) {
    body.hidden = false;
    if (arrow) arrow.textContent = "收起";
  } else {
    body.hidden = true;
    if (arrow) arrow.textContent = "展开";
  }
}

export function finishQuickSetup() {
  return _finishWizard();
}

export function qsToggleStep4Telemetry() {
  const el = document.getElementById("qs-tele-toggle");
  const status = document.getElementById("qs-tele-status");
  if (!el) return;
  _step4TelemetryEnabled = !!el.checked;
  if (status) {
    status.textContent = _step4TelemetryEnabled ? "已开启" : "已关闭";
    status.style.color = _step4TelemetryEnabled ? "var(--success,#22c55e)" : "var(--text-3)";
  }
}

/* Build the QR area or declarative form for the currently selected channel. */
function _renderChannelBody() {
  _qrPolling = false;   // kill any prior QR poll before swapping the DOM it writes to
  const body = document.getElementById("qs-channel-body");
  if (!body) return;

  const ch = _channels.find(c => c.type === _selectedChannelType);
  if (!ch) { body.innerHTML = ""; return; }

  if (ch.method === "qr") {
    body.innerHTML = `<div id="qs-qr-area"></div>`;
    _startQrScan();
  } else {
    body.innerHTML = _channelFormHtml(ch);
  }
}

/* Declarative form for a form-based channel (QQ / plugin), mirroring the
   settings.js add-account form but using the wizard's qs-* styling. Field DOM
   ids use the index (not f.key) so a plugin-defined key can't break the id. */
function _channelFormHtml(ch) {
  _pendingFormChannel = ch.type;
  _pendingFormFields = ch.fields || [];

  const fieldsHtml = _pendingFormFields.map((f, i) => {
    const id = `qs-acct-field-${i}`;
    if (f.type === "checkbox") {
      return `<label style="display:flex;flex-direction:row;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="${id}"><span class="qs-field-label">${esc(f.label || f.key)}</span>
      </label>`;
    }
    const inputType = f.secret ? "password" : "text";
    const req = f.required ? ` <span style="color:var(--danger)">*</span>` : "";
    return `<div class="qs-field">
      <label class="qs-field-label" for="${id}">${esc(f.label || f.key)}${req}</label>
      <input id="${id}" type="${inputType}" class="qs-field-input" placeholder="${escAttr(f.placeholder || "")}">
    </div>`;
  }).join("");

  return `
    <div class="qs-form-section" style="margin-top:12px">
      ${ch.type === "qq" ? `<div class="qs-hint">${iconHtml("ri-information-line", "qs-hint-icon")}<span>前往 <a href="https://q.qq.com/qqbot/openclaw/" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:underline">QQ 开放平台 OpenClaw 机器人配置页面</a> 获取 AppID 和 AppSecret，并开通 C2C 私信消息权限</span></div>` : (ch.hint ? `<div class="qs-hint">${iconHtml("ri-information-line", "qs-hint-icon")}<span>${esc(ch.hint)}</span></div>` : "")}
      ${fieldsHtml}
      <div id="qs-channel-error" style="display:none;color:var(--danger);font-size:13px;line-height:1.4"></div>
      <button class="qs-btn qs-btn-outline" onclick="PawzoChat.qsSubmitForm()" style="align-self:flex-start">
        ${iconHtml("ri-add-line", "qs-btn-icon")}添加账号
      </button>
    </div>`;
}

function _setChannelError(msg) {
  const el = document.getElementById("qs-channel-error");
  if (!el) return;
  el.textContent = msg || "";
  el.style.display = msg ? "block" : "none";
}

/* ================================================================
   Render step into card
   ================================================================ */

function _renderStep(stepNum) {
  const card = document.querySelector(`#${SCREEN_ID} .qs-card`);
  if (!card) return;

  const stepperEl = card.querySelector(".qs-stepper");
  if (stepperEl) stepperEl.outerHTML = _stepperHtml(stepNum);

  const body = card.querySelector(".qs-step-body-container");
  if (!body) return;
  body.style.opacity = "0";

  setTimeout(() => {
    if (stepNum === 1) body.innerHTML = _step1Html();
    else if (stepNum === 2) body.innerHTML = _step2Html();
    else if (stepNum === 4) {
      body.innerHTML = _step4Html();
      body.style.opacity = "1";
      return;
    }
    body.style.opacity = "1";
  }, 150);
}

async function _renderStep3() {
  const card = document.querySelector(`#${SCREEN_ID} .qs-card`);
  if (!card) return;

  const stepperEl = card.querySelector(".qs-stepper");
  if (stepperEl) stepperEl.outerHTML = _stepperHtml(3);

  const body = card.querySelector(".qs-step-body-container");
  if (!body) return;

  body.style.opacity = "0";
  body.innerHTML = `<div class="qs-loading">${iconHtml("ri-loader-4-line", "qs-spinner")} 加载中…</div>`;
  body.style.opacity = "1";

  const { accounts, links } = await _loadStep3Data();
  body.style.opacity = "0";
  setTimeout(() => {
    // Default selection (per design): no accounts → preselect WeChat (the qr
    // channel) and auto-start its scan for a frictionless first-run; has
    // accounts → neutral placeholder, user picks a channel to add.
    if (accounts.length === 0) {
      const wc = _channels.find(c => c.method === "qr") || _channels[0];
      _selectedChannelType = wc ? wc.type : "";
    } else {
      _selectedChannelType = "";
    }
    body.innerHTML = _step3Html(accounts, links);
    body.style.opacity = "1";
    if (_selectedChannelType) _renderChannelBody();
  }, 150);
}

/* ================================================================
   Navigate between steps
   ================================================================ */

async function _goToStep(n) {
  _currentStep = n;
  if (n === 2) {
    const card = document.querySelector(`#${SCREEN_ID} .qs-card`);
    const body = card?.querySelector(".qs-step-body-container");
    if (body) {
      body.style.opacity = "0";
      body.innerHTML = `<div class="qs-loading">${iconHtml("ri-loader-4-line", "qs-spinner")} 加载中…</div>`;
      body.style.opacity = "1";
    }
    const stepperEl = card?.querySelector(".qs-stepper");
    if (stepperEl) stepperEl.outerHTML = _stepperHtml(2);

    await _loadStep2Data();
    if (body) {
      body.style.opacity = "0";
      setTimeout(() => {
        body.innerHTML = _step2Html();
        body.style.opacity = "1";
      }, 150);
    }
  } else if (n === 3) {
    await _renderStep3();
  } else if (n === 4) {
    _renderStep(4);
  } else {
    _renderStep(n);
  }
}

/* ================================================================
   QR scanning (Step 3)
   ================================================================ */

async function _startQrScan() {
  let area = document.getElementById("qs-qr-area");
  if (!area) {
    const wc = document.getElementById("qs-channel-body");
    if (!wc) return;
    area = document.createElement("div");
    area.id = "qs-qr-area";
    wc.appendChild(area);
  }

  // Bump the session so any previous scan's poll loop (e.g. after toggling the
  // channel dropdown WeChat → other → WeChat) self-cancels instead of racing
  // this one or killing it on the stale QR's expiry.
  const session = ++_qrSession;
  area.innerHTML = `<div class="qs-loading">${iconHtml("ri-loader-4-line", "qs-spinner")} 获取二维码…</div>`;

  try {
    const res = await api.post("/api/accounts/qr/start", {});
    if (session !== _qrSession) return;   // superseded while awaiting
    if (res.status >= 400) {
      area.innerHTML = `<div class="qs-hint">${iconHtml("ri-error-warning-line", "qs-hint-icon")}<span>获取二维码失败：${esc(res.data?.error || "未知错误")}</span></div>`;
      return;
    }
    area.innerHTML = `<div class="qs-qr-container">
      <img src="${res.data.qr_image}" alt="QR Code" class="qs-qr-img">
      <div class="qs-qr-status" id="qs-qr-status">请用微信扫描二维码</div>
    </div>`;
    _qrPolling = true;
    _qrPollBaseUrl = "";
    _qrVerifyCode = "";
    _pollQr(res.data.qrcode, session);
  } catch (e) {
    if (session !== _qrSession) return;
    area.innerHTML = `<div class="qs-hint">${iconHtml("ri-error-warning-line", "qs-hint-icon")}<span>获取二维码失败，请检查网络</span></div>`;
  }
}

async function _pollQr(qrcode, session, deadline = Date.now() + 5 * 60 * 1000) {
  if (!_qrPolling || session !== _qrSession) return;
  const statusEl = document.getElementById("qs-qr-status");
  if (!statusEl) { _qrPolling = false; return; }

  const finish = (message) => {
    _qrPolling = false;
    _qrVerifyCode = "";
    _qrPollBaseUrl = "";
    clearVerifyInput(statusEl);
    statusEl.textContent = message;
  };

  try {
    // One submission consumes the code even when the request fails.
    const verifyCode = _qrVerifyCode;
    _qrVerifyCode = "";
    const res = await fetchQrStatus(qrcode, _qrPollBaseUrl, verifyCode, deadline);
    if (!_qrPolling || session !== _qrSession || document.getElementById("qs-qr-status") !== statusEl) return;
    if (res.status === "local_timeout") {
      finish("等待已超时，请重新开始连接");
      return;
    }
    if (res.status === "error" || res.retryable === false) {
      finish(res.errmsg || res.error || "连接未完成，请重新开始");
      return;
    }
    if (res.retryable && res.error_kind !== "timeout") {
      statusEl.textContent = res.errmsg || "连接暂时中断，正在重试…";
    }
    if (res.status === "binded_redirect") {
      finish("该微信已连接，请选择已有账号");
      _qsToast("微信已连接，未更改角色绑定", "success");
      setTimeout(() => { if (session === _qrSession) _refreshStep3(); }, 800);
      return;
    }
    if (res.status === "confirmed") {
      finish("登录成功！");
      const botId = res.bot_id || "";
      if (botId && _newPersonaId) {
        try {
          const linkRes = await api.post(`/api/conversations/${_newPersonaId}/wechat-link`, { account_id: botId });
          if (linkRes.status >= 400) {
            _qsToast(linkRes.data?.error || "绑定失败，可稍后手动绑定", "error");
          } else {
            _qsToast("微信账号已绑定到新角色", "success");
          }
        } catch (_) { _qsToast("绑定失败，可稍后手动绑定", "error"); }
      } else {
        _qsToast("微信账号添加成功", "success");
      }
      // _refreshStep3 resets the channel selection to the neutral placeholder,
      // so the refreshed step won't auto-rescan.
      setTimeout(() => { if (session === _qrSession) _refreshStep3(); }, 800);
      return;
    }
    if (res.status === "scaned") {
      statusEl.textContent = "扫描成功，请在手机上确认";
    } else if (res.status === "scaned_but_redirect") {
      statusEl.textContent = "扫描成功，正在切换线路…";
      const host = res.redirect_host;
      if (host) _qrPollBaseUrl = `https://${host}`;
    } else if (res.status === "need_verifycode") {
      statusEl.textContent = "请输入手机上显示的验证码";
      renderVerifyInput(statusEl, (code) => { _qrVerifyCode = code; });
    } else if (res.status === "verify_code_blocked") {
      finish("验证码错误次数过多，请重新开始");
      return;
    } else if (res.status === "expired") {
      finish("二维码已过期，请重新开始");
      return;
    }
  } catch (_) { /* silent */ }
  setTimeout(() => _pollQr(qrcode, session, deadline), 2000);
}

async function _refreshStep3() {
  // Always return the add-account section to the neutral placeholder after a
  // refresh: _step3Html renders an empty #qs-channel-body and we don't re-call
  // _renderChannelBody here, so leaving a channel selected would show a
  // dangling (empty) body / re-fire a scan.
  _selectedChannelType = "";
  _pendingFormChannel = "";
  _pendingFormFields = [];
  const { accounts, links } = await _loadStep3Data();
  const body = document.querySelector(`#${SCREEN_ID} .qs-step-body-container`);
  if (body) {
    body.innerHTML = _step3Html(accounts, links);
  }
}

/* ================================================================
   Public exports
   ================================================================ */

export function showQuickSetup() {
  if (document.getElementById(SCREEN_ID)) return;
  _currentStep = 1;
  _newPersonaId = null;
  _pendingAvatarBlob = null;
  _pendingImportFile = null;
  _createMode = "manual";
  _importIncludeWorldbook = true;
  _qrPolling = false;
  _channels = [];
  _selectedChannelType = "";
  _pendingFormChannel = "";
  _pendingFormFields = [];
  _existingNames = [];
  _generating = false;
  _step4TelemetryEnabled = true;

  const screen = document.createElement("div");
  screen.id = SCREEN_ID;
  // The global #toast sits below this full-screen overlay (z-index) and is
  // invisible while the wizard is open, so we render a wizard-local toast inside
  // the overlay. Inline-styled (no dependency on the cached stylesheet); it lives
  // in the overlay's stacking context, so it's always on top of the card.
  screen.innerHTML = `<div class="qs-card">
    ${_stepperHtml(1)}
    <div class="qs-step-body-container">${_step1Html()}</div>
  </div>
  <div id="qs-toast" style="position:fixed;top:60px;left:50%;transform:translateX(-50%) translateY(-20px);max-width:min(80vw,420px);padding:10px 24px;border-radius:20px;font-size:14px;line-height:1.4;color:#fff;text-align:center;opacity:0;transition:opacity .3s,transform .3s;pointer-events:none;z-index:10;box-shadow:0 6px 24px rgba(0,0,0,.18)"></div>`;
  document.body.appendChild(screen);

  if (!_invitationCode) {
    api.get("/api/setup/status").then(res => {
      const code = res.invitation_code || "";
      if (!code || _currentStep !== 1) return;
      _invitationCode = code;
      const link = document.getElementById("qs-pawapi-register-link");
      if (link) link.href = _pawapiRegisterUrl();
    }).catch(() => {});
  }
}

export async function submitQuickSetup() {
  const btn = document.getElementById("qs-btn-submit");

  if (_currentStep === 1) {
    const input = document.getElementById("qs-api-key");
    if (!input) return;
    const apiKey = input.value.trim();
    if (!apiKey) { _qsToast("请输入 PawAPI 令牌", "error"); input.focus(); return; }
    if (btn) { btn.disabled = true; btn.textContent = "正在配置…"; }
    showLoading("配置中…");
    try {
      const res = await api.post("/api/setup/quick", { api_key: apiKey });
      if (res.status >= 400) { _qsToast(res.data?.error || "配置失败", "error"); return; }
      _qsToast("PawAPI 对话/生图/语音服务商和 MCP 功能已启用", "success");
      _goToStep(2);
    } catch (e) { _qsToast("网络错误，请重试", "error"); }
    finally { hideLoading(); if (btn) { btn.disabled = false; btn.textContent = "下一步"; } }

  } else if (_currentStep === 2) {
    if (_generating) { _qsToast("正在生成人设，请稍候…", "info"); return; }
    if (_createMode === "import") {
      return _submitStep2Import(btn);
    }
    const nameEl = document.getElementById("qs-persona-name");
    if (!nameEl) return;
    const name = nameEl.value.trim();
    // Name-field errors render inline under the input (toasts are hidden behind
    // the full-screen wizard overlay).
    if (!name) { _setNameError("角色名称不能为空"); nameEl.focus(); return; }
    if (name.length > 100) { _setNameError("角色名称过长（最多 100 个字符）"); nameEl.focus(); return; }
    const bad = name.match(ILLEGAL_NAME_RE);
    if (bad) { _setNameError(`名称包含非法字符「${bad[0]}」，不可使用 \\ / : * ? " < > |`); nameEl.focus(); return; }
    if (/[. ]$/.test(name)) { _setNameError("名称不能以空格或句点结尾"); nameEl.focus(); return; }
    if (_nameExists(name)) { _setNameError(`角色名称「${name}」已存在，请换一个名称`); nameEl.focus(); nameEl.select?.(); return; }
    _setNameError("");

    const providerVal = document.getElementById("qs-provider")?.value || "";
    const modelVal = document.getElementById("qs-model")?.value || "";

    if (providerVal && !modelVal) {
      _qsToast("已选择服务商，请同时选择一个模型", "error");
      document.getElementById("qs-model")?.focus();
      return;
    }

    const hasDefaultGroup = _emojiGroups.some(g => g.name === "default");
    const body = {
      name,
      llm_provider: providerVal,
      llm_model: modelVal,
      temperature: 1.0,
      max_tokens: 2000,
      character_prompt: document.getElementById("qs-character")?.value || "",
      output_examples: document.getElementById("qs-examples")?.value || "",
      system_instructions: document.getElementById("qs-system")?.value || "",
      emoji_enabled: hasDefaultGroup,
      emoji_send_probability: 25,
      emoji_group: hasDefaultGroup ? "default" : "",
      memory: { enabled: true, max_memories: 50, include_in_prompt: true, trigger_rounds: 10, trigger_mode: "remind" },
    };
    const igPatch = _buildImageGenerationPatch("qs-img-en");
    if (igPatch) body.image_generation = igPatch;

    // Voice: if enabled, voice ID must not be empty
    const voiceEnEl = document.getElementById("qs-voice-en");
    if (voiceEnEl && voiceEnEl.checked) {
      const voiceInput = document.getElementById("qs-voice");
      if (!voiceInput || !voiceInput.value.trim()) {
        _qsToast("已启用语音功能，请选择或输入音色 (voice ID)", "error");
        voiceInput?.focus();
        return;
      }
    }
    const vgPatch = _buildVoiceGenerationPatch("qs-voice-en");
    if (vgPatch) body.voice_generation = vgPatch;

    if (btn) { btn.disabled = true; btn.textContent = "正在创建…"; }
    showLoading("创建角色中…");
    try {
      const res = await api.post("/api/personas", body);
      if (res.status >= 400) {
        // The cached list may be stale: record the name the backend flagged as a
        // duplicate so the next click is caught client-side.
        if (res.status === 409 && !_nameExists(name)) _existingNames.push(name);
        // Name conflicts surface inline under the field; other failures fall back
        // to a toast (those aren't tied to a specific field).
        if (res.status === 409 || res.data?.error?.includes("名称")) {
          _setNameError(res.data?.error || `角色名称「${name}」已存在，请换一个名称`);
          nameEl.focus();
        } else {
          _qsToast(res.data?.error || "创建失败", "error");
        }
        return;
      }
      _newPersonaId = res.data?.id || null;

      if (_pendingAvatarBlob && _newPersonaId) {
        const fd = new FormData();
        fd.append("avatar", _pendingAvatarBlob, "avatar.png");
        const base = window.PAWZOCHAT_BASE || "";
        try { await fetch(`${base}/api/personas/${_newPersonaId}/avatar`, { method: "POST", body: fd }); }
        catch (_) { /* best-effort */ }
        _pendingAvatarBlob = null;
      }

      if (_newPersonaId) {
        const convRes = await api.post("/api/conversations", { persona_id: _newPersonaId });
        if (convRes.status >= 400 && convRes.status !== 409) {
          _qsToast("对话创建失败，账号绑定可能不可用", "error");
        }
      }

      _qsToast("角色创建成功", "success");
      _goToStep(3);
    } catch (e) { _qsToast("网络错误，请重试", "error"); }
    finally { hideLoading(); if (btn) { btn.disabled = false; btn.textContent = "下一步"; } }

  } else if (_currentStep === 3) {
    _qrPolling = false;
    _goToStep(4);
  }
}

export async function skipQuickSetup() {
  if (_currentStep < 4) {
    if (_currentStep === 3) _qrPolling = false;
    _goToStep(_currentStep + 1);
  }
}

export async function checkAndShowSetup() {
  try {
    const res = await api.get("/api/setup/status");
    _invitationCode = res.invitation_code || "";
    if (res.needs_setup) showQuickSetup();
  } catch (_) { /* ignore */ }
}

/* step 2: clear the inline name error as the user edits the name */
export function qsClearNameError() { _setNameError(""); }

/* step 2: provider change */
export function qsProviderChange() {
  const provName = document.getElementById("qs-provider")?.value || "";
  const modelSel = document.getElementById("qs-model");
  if (!modelSel) return;
  if (!provName) {
    modelSel.innerHTML = `<option value="" disabled selected>先选择服务商</option>`;
    return;
  }
  modelSel.innerHTML = _buildModelOptions(provName);
}

export function qsImportProviderChange() {
  const provName = document.getElementById("qs-import-provider")?.value || "";
  const modelSel = document.getElementById("qs-import-model");
  if (!modelSel) return;
  if (!provName) {
    modelSel.innerHTML = `<option value="" disabled selected>先选择服务商</option>`;
    return;
  }
  modelSel.innerHTML = _buildModelOptions(provName);
}

/* step 2: avatar file */
export function qsAvatarSelected(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (!file.type.startsWith("image/")) { _qsToast("请选择图片文件", "error"); return; }
  input.value = "";
  const url = URL.createObjectURL(file);
  openCropModal(url, (blob) => {
    _pendingAvatarBlob = blob;
    const wrap = document.querySelector(`#${SCREEN_ID} .qs-avatar-wrap .avatar`);
    if (wrap) {
      wrap.style.background = "";
      wrap.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="avatar">`;
    }
  });
}

/* step 2: create-mode tab switch */
export function qsSetCreateMode(mode) {
  if (mode !== "manual" && mode !== "import") return;
  if (_createMode === mode) return;
  _createMode = mode;
  const manualPanel = document.getElementById("qs-manual-panel");
  const importPanel = document.getElementById("qs-import-panel");
  const manualTab = document.getElementById("qs-mode-tab-manual");
  const importTab = document.getElementById("qs-mode-tab-import");
  if (manualPanel) manualPanel.hidden = mode !== "manual";
  if (importPanel) importPanel.hidden = mode !== "import";
  if (manualTab) manualTab.classList.toggle("active", mode === "manual");
  if (importTab) importTab.classList.toggle("active", mode === "import");
}

/* step 2: import file picked */
export function qsImportFilePicked(input) {
  const file = input?.files?.[0];
  if (!file) return;
  _pendingImportFile = file;
  const label = document.getElementById("qs-import-file-label");
  if (label) {
    label.hidden = false;
    label.textContent = `已选：${file.name}`;
  }
}

/* step 2: worldbook toggle */
export function qsImportWbToggle(cb) {
  _importIncludeWorldbook = !!(cb && cb.checked);
}

async function _submitStep2Import(btn) {
  if (!_pendingImportFile) {
    _qsToast("请先选择角色卡文件", "error");
    return;
  }
  const providerVal = document.getElementById("qs-import-provider")?.value || "";
  const modelVal = document.getElementById("qs-import-model")?.value || "";
  if (_providers.length > 0 && !providerVal) {
    _qsToast("请选择本地服务商", "error");
    document.getElementById("qs-import-provider")?.focus();
    return;
  }
  if (providerVal && !modelVal) {
    _qsToast("已选择服务商，请同时选择一个模型", "error");
    document.getElementById("qs-import-model")?.focus();
    return;
  }
  if (providerVal && modelVal && !_hasLocalModel(providerVal, modelVal)) {
    _qsToast("请选择本地服务商中的模型", "error");
    document.getElementById("qs-import-model")?.focus();
    return;
  }

  // Voice: if enabled, voice ID must not be empty
  const voiceEnEl = document.getElementById("qs-voice-en-import");
  if (voiceEnEl && voiceEnEl.checked) {
    const voiceInput = document.getElementById("qs-voice-import");
    if (!voiceInput || !voiceInput.value.trim()) {
      _qsToast("已启用语音功能，请选择或输入音色 (voice ID)", "error");
      voiceInput?.focus();
      return;
    }
  }

  const fd = new FormData();
  fd.append("file", _pendingImportFile);
  fd.append("include_worldbook", _importIncludeWorldbook ? "true" : "false");

  if (btn) { btn.disabled = true; btn.textContent = "正在导入…"; }
  showLoading("导入角色中…");
  try {
    const base = window.PAWZOCHAT_BASE || "";
    const resp = await fetch(`${base}/api/personas/_import`, { method: "POST", body: fd });
    const data = await resp.json().catch(() => ({}));
    if (resp.status >= 400) {
      _qsToast(data?.error || "导入失败", "error");
      return;
    }

    _newPersonaId = data.id || null;

    let modelNotice = "";
    if (_newPersonaId) {
      const patch = {};
      if (providerVal && modelVal) {
        patch.llm_provider = providerVal;
        patch.llm_model = modelVal;
      }
      const igPatch = _buildImageGenerationPatch("qs-img-en-import");
      if (igPatch) patch.image_generation = igPatch;
      const vgPatch = _buildVoiceGenerationPatch("qs-voice-en-import");
      if (vgPatch) patch.voice_generation = vgPatch;

      if (Object.keys(patch).length > 0) {
        try {
          const llmRes = await api.put(`/api/personas/${_newPersonaId}`, patch);
          if (llmRes.status >= 400) {
            modelNotice = "，但模型配置失败，请稍后在角色设置中检查";
          }
        } catch (_) {
          modelNotice = "，但模型配置失败，请稍后在角色设置中检查";
        }
      }
      if (!providerVal || !modelVal) {
        modelNotice = modelNotice || "，请稍后在角色设置中选择模型";
      }
    }

    if (_newPersonaId) {
      const convRes = await api.post("/api/conversations", { persona_id: _newPersonaId });
      if (convRes.status >= 400 && convRes.status !== 409) {
        _qsToast("对话创建失败，账号绑定可能不可用", "error");
      }
    }

    const warn = (data.warnings || []).slice(0, 3);
    const extra = warn.length ? `（${warn.join("；")}）` : "";
    _qsToast(`已导入「${data.name || "角色"}」${extra}${modelNotice}`, "success");

    _goToStep(3);
  } catch (e) {
    _qsToast("网络错误，请重试", "error");
  } finally {
    hideLoading();
    if (btn) { btn.disabled = false; btn.textContent = "下一步"; }
  }
}

/* step 3: select existing account */
export async function qsSelectAccount(botId) {
  if (!_newPersonaId) return;
  showLoading("绑定中…");
  try {
    const res = await api.post(`/api/conversations/${_newPersonaId}/wechat-link`, { account_id: botId });
    if (res.status >= 400) { _qsToast(res.data?.error || "绑定失败", "error"); return; }
    _qsToast("已绑定到新角色", "success");
    _refreshStep3();
  } catch (e) { _qsToast("操作失败", "error"); }
  finally { hideLoading(); }
}

/* step 3: start new QR scan */
export function qsStartScan() {
  _startQrScan();
}

/* step 3: channel dropdown changed — render the QR area or declarative form */
export function qsChannelChange() {
  const sel = document.getElementById("qs-channel-select");
  _selectedChannelType = sel ? sel.value : "";
  _renderChannelBody();
}

/* step 3: submit a form-based channel account (QQ / plugin), then auto-bind */
export async function qsSubmitForm() {
  const fields = {};
  for (let i = 0; i < _pendingFormFields.length; i++) {
    const f = _pendingFormFields[i];
    const el = document.getElementById(`qs-acct-field-${i}`);
    if (!el) continue;
    if (f.type === "checkbox") {
      fields[f.key] = el.checked;
    } else {
      fields[f.key] = el.value.trim();
      if (f.required && !fields[f.key]) {
        _setChannelError(`请填写${f.label || f.key}`);
        el.focus?.();
        return;
      }
    }
  }
  _setChannelError("");
  showLoading("添加中…");
  try {
    const res = await api.post("/api/accounts", { channel_type: _pendingFormChannel, fields });
    if (res.status >= 400) { _setChannelError(res.data?.error || "添加失败"); return; }
    const botId = res.data?.bot_id || "";
    if (botId && _newPersonaId) {
      try {
        const linkRes = await api.post(`/api/conversations/${_newPersonaId}/wechat-link`, { account_id: botId });
        if (linkRes.status >= 400) {
          _qsToast(linkRes.data?.error || "已添加，但绑定失败，可稍后手动绑定", "error");
        } else {
          _qsToast("账号已添加并绑定到新角色", "success");
        }
      } catch (_) { _qsToast("已添加，但绑定失败，可稍后手动绑定", "error"); }
    } else {
      _qsToast("账号添加成功", "success");
    }
    // _refreshStep3 resets the channel selection; the new account now lists.
    _refreshStep3();
  } catch (e) {
    _setChannelError("添加失败，请稍后重试");
  } finally { hideLoading(); }
}

/* step 2: one-click persona generation (reuses persona-writer backend /api/persona-writer/generate) */
export async function qsGeneratePersona() {
  if (_generating) return;
  const provider = document.getElementById("qs-provider")?.value || "";
  const model = document.getElementById("qs-model")?.value || "";
  const reqText = (document.getElementById("qs-gen-prompt")?.value || "").trim();
  if (!provider || !model) { _qsToast("请先选择服务商与模型", "error"); return; }
  if (!reqText) { _qsToast("请输入生成需求", "error"); return; }

  const btn = document.getElementById("qs-gen-btn");
  const orig = btn ? btn.textContent : "";
  _generating = true;
  if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
  try {
    const r = await api.post("/api/persona-writer/generate", { provider, model, request: reqText });
    // Generation can take a while; by now the user may have skipped/left step 2,
    // in which case its DOM has been replaced — don't write fields or show
    // prompts, just drop this result.
    if (_currentStep !== 2) return;
    if (r.status === 200 && r.data && r.data.ok) {
      const charEl = document.getElementById("qs-character");
      setPromptValue(charEl, r.data.character_prompt || "");
      const exEl = document.getElementById("qs-examples");
      setPromptValue(exEl, r.data.output_examples || "");
      const nameEl = document.getElementById("qs-persona-name");
      const genName = (r.data.name || "").trim();
      if (nameEl && genName && !nameEl.value.trim()) nameEl.value = genName;

      // The model may return an empty or duplicate name, which the Next step would
      // then block; guide the user to fill/rename right after generation instead of
      // letting Next look broken.
      const finalName = nameEl ? nameEl.value.trim() : "";
      if (!finalName) {
        _setNameError("人设已生成，请填写角色名称后继续");
        nameEl?.focus();
      } else if (_nameExists(finalName)) {
        _setNameError(`已生成「${finalName}」，但已存在同名角色，请修改名称`);
        nameEl?.focus(); nameEl?.select?.();
      } else if (charEl && !charEl.value.trim()) {
        _setNameError("");
        _qsToast("生成完成，但人设设定为空，请补充后继续", "info");
        charEl.focus();
      } else {
        _setNameError("");
        _qsToast("生成完成", "success");
      }
    } else {
      _qsToast((r.data && r.data.error) || "生成失败", "error");
    }
  } catch (e) {
    _qsToast("生成失败，请检查网络或模型配置", "error");
  } finally {
    _generating = false;
    if (btn) { btn.disabled = false; btn.textContent = orig || "生成"; }
  }
}

/* step 1: paste API key from clipboard */
export async function qsPasteApiKey() {
  const input = document.getElementById("qs-api-key");
  if (!input) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { _qsToast("剪贴板为空", "error"); return; }
    input.value = text.trim();
    input.focus();
  } catch (_) { _qsToast("读取剪贴板失败，请手动粘贴", "error"); }
}
