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
import { esc, CAP_ICONS } from "./utils.js";
import { api } from "./api.js";
import { $, content } from "./state.js";
import { toast, showLoading, hideLoading } from "./ui.js";
import { setTopBar, pushPage, registerPageRenderer } from "./navigation.js";

// Persona Writing Assistant: one-line request + model choice → reuses the
// existing AI call pipeline (including MCP tools like web search) to
// generate a persona draft → preview/tweak → one-click create character.
//
// Note the two distinct "system prompts":
//   - The generation-guidance prompt that drives generation is a fixed
//     internal backend constant — invisible to and never sent by the frontend.
//   - The editable "system instructions" on the page belong to the character
//     being created itself — the [系统指令] section, pre-filled with the
//     project defaults.

const _pw = {
  providers: [],          // [{name, models:[{id,name,capabilities}], ...}]
  defaultSysInstr: "",    // DEFAULT_SYSTEM_INSTRUCTIONS (from /api/personas/default-system-instructions)
};

function _providerOptions(selected) {
  return _pw.providers
    .map(pr => `<option value="${esc(pr.name)}" ${pr.name === selected ? "selected" : ""}>${esc(pr.name)}</option>`)
    .join("");
}

// Build <option>s for the model select. Always lands on a valid selection:
// the requested model if present, otherwise the provider's first model.
function _modelOptions(provName, selectedModel) {
  const prov = _pw.providers.find(pr => pr.name === provName);
  const models = prov?.models || [];
  if (!models.length) return `<option value="" disabled selected>该服务商下没有模型</option>`;
  const effective = models.some(m => m.id === selectedModel) ? selectedModel : models[0].id;
  return models.map(m => {
    const caps = (m.capabilities || []).map(c => CAP_ICONS[c] || "").join("");
    const sel = m.id === effective ? "selected" : "";
    return `<option value="${esc(m.id)}" ${sel}>${esc(m.name || m.id)} ${caps}</option>`;
  }).join("");
}

function pwOnProviderChange() {
  const provName = $("pw-provider")?.value || "";
  const modelSel = $("pw-model");
  if (modelSel) modelSel.innerHTML = _modelOptions(provName, "");
}

async function pwGenerate() {
  const provider = $("pw-provider")?.value || "";
  const model = $("pw-model")?.value || "";
  const reqText = ($("pw-request")?.value || "").trim();
  if (!provider || !model) { toast("请先选择服务商与模型", "error"); return; }
  if (!reqText) { toast("请输入生成需求", "error"); return; }

  localStorage.setItem("pw_last_provider", provider);
  localStorage.setItem("pw_last_model", model);

  const btn = $("pw-generate-btn");
  const orig = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "生成中…"; }
  try {
    const r = await api.post("/api/persona-writer/generate", { provider, model, request: reqText });
    if (r.status === 200 && r.data && r.data.ok) {
      setPromptValue($("pw-character"), r.data.character_prompt || "");
      setPromptValue($("pw-examples"), r.data.output_examples || "");
      const nameEl = $("pw-name");
      if (nameEl && r.data.name && !nameEl.value.trim()) nameEl.value = r.data.name;
      toast("生成完成", "success");
    } else {
      toast((r.data && r.data.error) || "生成失败", "error");
    }
  } catch (e) {
    toast("生成失败，请检查网络或模型配置", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig || "生成"; }
  }
}

async function pwCreatePersona() {
  const name = ($("pw-name")?.value || "").trim();
  const characterPrompt = $("pw-character")?.value || "";
  const outputExamples = $("pw-examples")?.value || "";
  const systemInstructions = $("pw-sysinstr")?.value || "";
  const provider = $("pw-provider")?.value || "";
  const model = $("pw-model")?.value || "";

  if (!name) { toast("请输入角色名称", "error"); return; }
  if (!characterPrompt.trim()) { toast("请先生成或填写人设设定", "error"); return; }

  showLoading("创建中…");
  try {
    const r = await api.post("/api/personas", {
      name,
      character_prompt: characterPrompt,
      output_examples: outputExamples,
      system_instructions: systemInstructions,
      llm_provider: provider,
      llm_model: model,
    });
    hideLoading();
    if ((r.status === 200 || r.status === 201) && r.data && r.data.ok) {
      api.invalidate("/api/personas");
      toast("角色创建成功", "success");
      pushPage("personaEdit", { personaId: r.data.id });
    } else {
      toast((r.data && r.data.error) || "创建失败", "error");
    }
  } catch (e) {
    hideLoading();
    toast("创建失败", "error");
  }
}

async function renderPersonaWriter() {
  setTopBar("人设编写助手", true, "");
  content().innerHTML = `<div class="loading-center"><div class="spinner"></div></div>`;

  try {
    const [provRes, siRes] = await Promise.all([
      api.get("/api/providers"),
      api.get("/api/personas/default-system-instructions"),
    ]);
    _pw.providers = provRes.providers || [];
    _pw.defaultSysInstr = siRes.text || "";
  } catch (e) {
    _pw.providers = [];
    _pw.defaultSysInstr = "";
  }

  const lastProvider = localStorage.getItem("pw_last_provider") || "";
  const lastModel = localStorage.getItem("pw_last_model") || "";
  const selProvider = _pw.providers.some(p => p.name === lastProvider)
    ? lastProvider
    : (_pw.providers[0]?.name || "");

  if (!_pw.providers.length) {
    content().innerHTML = `<div class="page"><div class="empty-state">
      <div class="empty-text">尚未配置任何 LLM 服务商</div>
      <div class="form-hint" style="text-align:center">请先到「设置 → 服务商」添加带 API Key 的服务商与模型</div>
    </div></div>`;
    return;
  }

  content().innerHTML = `<div class="page">
    <div class="card">
      <div class="card-header">生成模型</div>
      <div class="form-group"><div class="form-row"><label>服务商</label>
        <select id="pw-provider" onchange="PawzoChat.pwOnProviderChange()">${_providerOptions(selProvider)}</select>
      </div></div>
      <div class="form-group"><div class="form-row"><label>模型</label>
        <select id="pw-model">${_modelOptions(selProvider, lastModel)}</select>
      </div></div>
      <div class="form-hint">🔧 表示该模型支持工具调用（如果您配置了联网搜索mcp则可进行联网搜索）</div>
    </div>

    <div class="card">
      <div class="card-header">生成需求</div>
      <div class="prompt-field"><textarea class="prompt-input" id="pw-request" placeholder="为我生成xxx游戏的xxx角色的人设"></textarea></div>
    </div>
    <div style="margin-bottom:12px">
      <button class="btn-primary" id="pw-generate-btn" onclick="PawzoChat.pwGenerate()">生成</button>
    </div>

    <div class="card">
      <div class="card-header">人设设定</div>
      <div class="prompt-field"><textarea class="prompt-input prompt-part" id="pw-character" placeholder="点击「生成」后自动填充，可手动编辑"></textarea></div>
    </div>
    <div class="card">
      <div class="card-header">输出示例</div>
      <div class="prompt-field"><textarea class="prompt-input prompt-part" id="pw-examples" placeholder="点击「生成」后自动填充，可手动编辑"></textarea></div>
      <div class="form-hint">用反斜线 \\ 分隔短句，例如：你已觉悟\\无需多言</div>
    </div>
    <div class="card">
      <div class="card-header">系统指令</div>
      <div class="prompt-field"><textarea class="prompt-input prompt-part" id="pw-sysinstr">${esc(_pw.defaultSysInstr)}</textarea></div>
      <div class="form-hint">角色的 [系统指令] 段，已预填默认值，可修改</div>
    </div>

    <div class="card">
      <div class="card-header">创建角色</div>
      <div class="form-group"><div class="form-row"><label>角色名称</label>
        <input id="pw-name" placeholder="输入角色名称">
      </div></div>
    </div>
    <div>
      <button class="btn-primary" id="pw-create-btn" onclick="PawzoChat.pwCreatePersona()">通过该人设创建角色</button>
    </div>
  </div>`;
}

registerPageRenderer("personaWriter", renderPersonaWriter);

export { pwOnProviderChange, pwGenerate, pwCreatePersona };
