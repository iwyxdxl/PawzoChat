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
/* PawzoChat SPA — Module entry point */

import { esc, iconHtml } from "./modules/utils.js";
import { api } from "./modules/api.js";
import { state, sidebar } from "./modules/state.js";
import { closeOverlay, closeConfirm, overlayClick, step, toast, showSheet } from "./modules/ui.js";
import { openImagePreview, closeImagePreview } from "./modules/image_preview.js";
import {
  setTopBar, switchTab, goBack, pushPage,
  registerTabRenderer, registerPageRenderer,
  isDesktop, setSidebarBar,
} from "./modules/navigation.js";
import { applyThemeFromState, watchSystemTheme } from "./modules/theme.js";

import {
  chatPersonaId, renderChatList, refreshChatMessages,
  openGroupChat, handleGroupEvent, stopGroupChat, mentionGroupMember,
  filterConvs, newConversation, selectChatPersona, startChat, openChat,
  chatMore, clearChat, deleteChat,
  linkWechat, doLinkWechat, unlinkWechat, viewPersonaFromChat, viewMemoryFromChat,
  openHistoryEdit,
  onChatInput, onChatKey, sendChat,
  pickImage, onImageSelected, removePendingImage,
  pickFile, onFileSelected, removePendingFile,
  showTypingIndicator, appendAssistantMessage,
  toggleEmojiPicker, switchEmojiTab, insertEmoji, sendSticker,
  togglePlusMenu,
  quoteMessage, copyMessage, clearPendingQuote,
  playVoiceMessage, toggleVoiceTranscript,
} from "./modules/chat.js";

import { openCreateGroupDialog, openGroupSettings, saveGroupSettings } from "./modules/groups.js";

import {
  heDateChange,
  editHistoryMsg, saveHistoryMsg, cancelHistoryEdit, deleteHistoryMsg,
  heClearQuoteEdit,
  heEnterSelectMode, heExitSelectMode, heToggleSelectItem,
  heToggleSelectAllCurrentDate, heBatchDeleteSelected,
} from "./modules/history_edit.js";

import {
  filterPersonas, chatWithPersona, deletePersona, savePersona,
  switchPersonaEditTab, resetSystemInstructions, onPersonaProviderChange,
  onPersonaImageProviderChange,
  onAvatarFileSelected, openCropModal, closeCropModal, confirmCrop,
  peWorldbookAdd,
  personaImportPick, personaImportSubmit,
  personaExportPick, _personaExportGo,
  _personaExportCoverSelected, _personaExportCoverReset, _personaExportPngGo,
  onPeImgRefModeChange, onPeImgRefFileSelected, deletePersonaRefImage,
  onPeMemTriggerModeChange,
  onPersonaVoiceProviderChange, onPersonaVoiceModelChange,
} from "./modules/contacts.js";

import {
  addAccount, openAccount, deleteAccount, saveAccountNote,
  skipAccountNote, confirmAccountNote,
  selectChannelType, submitFormAccount,
  saveProvider, deleteProvider,
  importPresetModels, addEditModel, confirmAddModel, removeEditModel,
  fetchRemoteModels, confirmFetchModels, toggleFetchSelectAll, confirmModelSelection,
  editModel, confirmEditModel,
  onProviderPresetChange, onProviderTypeChange, updateProviderPreview,
  openProviderTypeSheet,
  saveImageProvider, deleteImageProvider,
  onImageProviderPresetChange, updateImageProviderPreview,
  importImagePresetModels,
  openImageProviderTypeSheet,
  addEditImageModel, confirmAddImageModel,
  editImageModel, confirmEditImageModel, removeEditImageModel,
  openImageTest, onImageTestProviderChange, onImageTestModelChange, onImageTestPromptInput, onImageTestPersonaChange, runImageTest,
  openVoiceProviderTypeSheet,
  saveVoiceProvider, deleteVoiceProvider,
  onVoiceProviderPresetChange, updateVoiceProviderPreview,
  importVoicePresetModels,
  addEditVoiceModel, confirmAddVoiceModel,
  editVoiceModel, confirmEditVoiceModel, removeEditVoiceModel,
  openVoiceTest, onVoiceTestProviderChange, onVoiceTestModelChange, onVoiceTestVoiceChange, onVoiceTestTextInput, runVoiceTest,
  onTypingDelayToggle,
  saveSettingsChat, saveSettingsReply,
  onThemeModeChange, onThemeToggle, onThemeMove, onThemeDelete, saveSettingsTheme,
  themeImportPick, themeImportSubmit,
  themeSelectionEnter, themeSelectionExit, themeSelectionToggle, themeSelectionToggleAll,
  themeExportSelected,
  savePassword, clearPassword, togglePublicAccess,
  cancelPublicToggle, confirmPublicToggle,
  regeneratePublicAccess, copyPublicUrl, copyPublicField,
  emojiAddGroup, emojiConfirmAddGroup,
  emojiAddEmotion, emojiConfirmAddEmotion,
  emojiRenameGroup, emojiConfirmRenameGroup, emojiDeleteGroup,
  emojiRenameEmotion, emojiConfirmRenameEmotion, emojiDeleteEmotion,
  emojiUploadImages, emojiImageMenu,
  emojiRenameImage, emojiConfirmRenameImage, emojiDeleteImage,
  emojiImportPick, emojiImportSubmit, emojiExportGroup,
  onProfileAvatarSelected, saveProfile,
  checkForUpdate, startUpdateDownload, onUpdateProgress, applyUpdate,
  toggleTelemetry,
} from "./modules/settings.js";

import {
  addMemory, editMemory, saveMemory, deleteMemoryConfirm,
} from "./modules/memory.js";

import {
  mcpTransportChange,
  mcpAddEnvRow, mcpRemoveEnvRow, mcpUpdateEnvKey, mcpUpdateEnvVal,
  mcpTestConnection,
  mcpSaveServer, mcpDeleteServer,
  mcpConnect, mcpDisconnect, mcpRefresh,
  mcpToggleAdapterAdvanced, mcpAdapterServerChange,
  mcpAddAdapterParam, mcpRemoveAdpParam, mcpUpdateAdpParam,
  mcpAddAdapterMapping, mcpRemoveAdpMapping, mcpUpdateAdpMapping,
  mcpAddAdapterInject, mcpRemoveAdpInject, mcpUpdateAdpInject,
  mcpSaveAdapter, mcpDeleteAdapter,
  mcpSwitchEditMode, mcpParseJson, mcpImportJson,
  mcpSaveUrl, mcpUrlAutoName,
} from "./modules/mcp.js";

import {
  pluginToggle, pluginSaveConfig, pluginReload, pluginRefresh,
} from "./modules/plugins.js";

import {
  pluginShowInstall, pluginSourceInput, pluginStartPreview, pluginOpenTask, pluginCancelTask, pluginConfirmTask,
  pluginCheckUpdates, pluginPreviewUpgrade,
  onPluginTaskProgress, onPluginUpdatesAvailable, pluginReconnect,
} from "./modules/plugin_install.js";

import {
  showQuickSetup, submitQuickSetup, skipQuickSetup,
  checkAndShowSetup,
  qsProviderChange, qsAvatarSelected,
  qsSelectAccount, qsStartScan,
  qsChannelChange, qsSubmitForm,
  qsImportProviderChange,
  qsSetCreateMode, qsImportFilePicked, qsImportWbToggle,
  qsPasteApiKey, qsGeneratePersona, qsClearNameError,
  qsToggleCollapse, qsToggleStep4Telemetry,
  finishQuickSetup,
} from "./modules/quick_setup.js";

import {
  wbImportPick, wbImportSubmit,
  wbSave, wbDeleteCurrent,
  wbAddSection, wbRemoveSection,
  wbSectionKeyChange, wbSectionValChange, wbSectionToggle,
  wbPickerConfirm,
  wbOnRangeChange, wbOnKwToggle, wbPersonaPick, wbPersonaPickConfirm,
  wbExportPick, wbExportCurrent, _wbExportGo,
} from "./modules/worldbook.js";

import {
  momentsRefresh, momentsOpenPublish, momentsItemMenu, momentsDelete,
  momentsLikeToggle, momentsOpenComposer, momentsReplyTo,
  momentsReplyMenu, momentsDeleteReply,
  momentsCloseComposer, momentsSubmitReply,
  momentsEdit, momentsEditReply, momentsSubmitEdit,
  momentsPickCover, momentsCoverMenu, momentsPickCoverFile,
  momentsOnCoverFile, momentsCoverDelete,
  momentsPickPubImages, momentsOnPublishFiles, momentsRemovePubImage,
  momentsSubmitPublish,
  momentsOnProbInput, momentsResetPrompt, momentsSaveSettings,
  momentsOnUpdate, momentsOnGenerating,
} from "./modules/moments.js";

import {
  pwOnProviderChange, pwGenerate, pwCreatePersona,
} from "./modules/persona_writer.js";

/* ============ Discover Tab ============ */

function renderDiscover() {
  const desktop = isDesktop();
  const target = desktop ? sidebar() : document.getElementById("content-area");

  if (desktop) setSidebarBar("发现", "");
  else setTopBar("发现", false, "");

  target.innerHTML = `<div class="page">
    <div class="card">
      <div class="card-row" onclick="PawzoChat.pushPage('momentsList',{})">
        <div class="row-icon peach">${iconHtml("ri-camera-fill")}</div>
        <span class="row-label">朋友圈</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('worldbookList',{})">
        <div class="row-icon blue">${iconHtml("ri-book-open-line")}</div>
        <span class="row-label">世界书</span><span class="row-arrow">›</span>
      </div>
      <div class="card-row" onclick="PawzoChat.pushPage('personaWriter',{})">
        <div class="row-icon purple">${iconHtml("ri-quill-pen-line")}</div>
        <span class="row-label">人设编写助手</span><span class="row-arrow">›</span>
      </div>
    </div>
  </div>`;
}

function renderPlaceholder(data) {
  setTopBar(data.name, true, "");
  document.getElementById("content-area").innerHTML = `<div class="placeholder-page">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
    <div class="title">即将推出</div>
    <div class="desc">${esc(data.desc)}</div>
  </div>`;
}

registerTabRenderer("discover", renderDiscover);
registerPageRenderer("discoverPlaceholder", renderPlaceholder);

/* ============ SSE ============ */

function initSSE() {
  if (state.sseSource) state.sseSource.close();
  state.sseSource = new EventSource((window.PAWZOCHAT_BASE || "") + "/api/events");
  state.sseSource.onopen = () => {
    pluginReconnect();
    api.invalidate(k => k.startsWith('/api/groups') || k.startsWith('/api/conversations'));
    refreshChatMessages();
    if (state.currentTab === 'chat' && (isDesktop() || state.pageStack.length === 0)) renderChatList();
  };
  state.sseSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type?.startsWith("group_")) { handleGroupEvent(data); return; }
      if (data.type === "channel_upload") {
        if (data.error) toast(`${data.name || "附件"}：${data.error}`, "error");
        else if (data.total) toast(`${data.name || "附件"} 上传 ${Math.round(data.uploaded * 100 / data.total)}%`);
      }
      if (data.type === "processing") {
        state.processingPersonas.add(data.persona_id);
        if (data.persona_id === chatPersonaId) showTypingIndicator();
      }
      if (data.type === "assistant_message") {
        if (data.is_last) state.processingPersonas.delete(data.persona_id);
        if (data.persona_id === chatPersonaId) appendAssistantMessage(data.message, data.is_last);
      }
      if (data.type === "new_message") {
        api.invalidate(k => k.startsWith("/api/conversations"));
        if (data.persona_id === chatPersonaId) refreshChatMessages();
      }
      if (data.type === "conversation_updated") {
        api.invalidate(k => k.startsWith("/api/conversations"));
        if (data.persona_id === chatPersonaId) {
          const topPage = state.pageStack[state.pageStack.length - 1];
          if (topPage?.name === "chatWindow") {
            refreshChatMessages();
          }
        }
        if (state.currentTab === "chat" && (isDesktop() || state.pageStack.length === 0)) {
          renderChatList();
        }
      }
      if (data.type === "plugin_task_progress") onPluginTaskProgress(data);
      if (data.type === "plugin_updates_available") onPluginUpdatesAvailable(data);
      if (data.type === "update_progress") {
        onUpdateProgress(data);
      }
      if (data.type === "moments_updated") {
        api.invalidate(k => k.startsWith("/api/moments"));
        momentsOnUpdate(data);
      }
      if (data.type === "moments_generating") {
        api.invalidate("/api/moments/state");
        momentsOnGenerating(data.is_generating);
      }
    } catch (err) { /* silent */ }
  };
  // EventSource reconnects automatically; onopen catches up missed messages.
  // Recreating it from onerror would leave competing reconnect timers behind.
}

/* ============ Public API ============ */

window.PawzoChat = {
  switchTab, goBack, pushPage,
  closeOverlay, closeConfirm, overlayClick,
  openImagePreview, closeImagePreview,
  newConversation, selectChatPersona, startChat, openChat,
  openGroupChat, openCreateGroupDialog, openGroupSettings, saveGroupSettings, stopGroupChat, mentionGroupMember,
  filterConvs, chatMore, clearChat, deleteChat,
  linkWechat, doLinkWechat, unlinkWechat, viewPersonaFromChat, viewMemoryFromChat,
  openHistoryEdit,
  heDateChange,
  editHistoryMsg, saveHistoryMsg, cancelHistoryEdit, deleteHistoryMsg,
  heClearQuoteEdit,
  heEnterSelectMode, heExitSelectMode, heToggleSelectItem,
  heToggleSelectAllCurrentDate, heBatchDeleteSelected,
  onChatInput, onChatKey, sendChat,
  pickImage, onImageSelected, removePendingImage,
  pickFile, onFileSelected, removePendingFile,
  toggleEmojiPicker, switchEmojiTab, insertEmoji, sendSticker,
  togglePlusMenu,
  quoteMessage, copyMessage, clearPendingQuote,
  playVoiceMessage, toggleVoiceTranscript,
  filterPersonas, chatWithPersona, deletePersona,
  savePersona, switchPersonaEditTab, resetSystemInstructions, onPersonaProviderChange,
  onPersonaImageProviderChange,
  onPersonaVoiceProviderChange, onPersonaVoiceModelChange,
  onAvatarFileSelected, openCropModal, closeCropModal, confirmCrop,
  peWorldbookAdd,
  personaImportPick, personaImportSubmit,
  personaExportPick, _personaExportGo,
  _personaExportCoverSelected, _personaExportCoverReset, _personaExportPngGo,
  onPeImgRefModeChange, onPeImgRefFileSelected, deletePersonaRefImage,
  onPeMemTriggerModeChange,
  addAccount, openAccount, deleteAccount, saveAccountNote, skipAccountNote, confirmAccountNote,
  selectChannelType, submitFormAccount,
  saveProvider, deleteProvider,
  importPresetModels, addEditModel, confirmAddModel, removeEditModel,
  fetchRemoteModels, confirmFetchModels, toggleFetchSelectAll, confirmModelSelection,
  editModel, confirmEditModel,
  onProviderPresetChange, onProviderTypeChange, updateProviderPreview,
  openProviderTypeSheet,
  saveImageProvider, deleteImageProvider,
  onImageProviderPresetChange, updateImageProviderPreview,
  importImagePresetModels,
  openImageProviderTypeSheet,
  addEditImageModel, confirmAddImageModel,
  editImageModel, confirmEditImageModel, removeEditImageModel,
  openImageTest, onImageTestProviderChange, onImageTestModelChange, onImageTestPromptInput, onImageTestPersonaChange, runImageTest,
  openVoiceProviderTypeSheet,
  saveVoiceProvider, deleteVoiceProvider,
  onVoiceProviderPresetChange, updateVoiceProviderPreview,
  importVoicePresetModels,
  addEditVoiceModel, confirmAddVoiceModel,
  editVoiceModel, confirmEditVoiceModel, removeEditVoiceModel,
  openVoiceTest, onVoiceTestProviderChange, onVoiceTestModelChange, onVoiceTestVoiceChange, onVoiceTestTextInput, runVoiceTest,
  onTypingDelayToggle,
  saveSettingsChat, saveSettingsReply,
  onThemeModeChange, onThemeToggle, onThemeMove, onThemeDelete, saveSettingsTheme,
  themeImportPick, themeImportSubmit,
  themeSelectionEnter, themeSelectionExit, themeSelectionToggle, themeSelectionToggleAll,
  themeExportSelected,
  savePassword, clearPassword, togglePublicAccess,
  cancelPublicToggle, confirmPublicToggle,
  regeneratePublicAccess, copyPublicUrl, copyPublicField,
  emojiAddGroup, emojiConfirmAddGroup,
  emojiAddEmotion, emojiConfirmAddEmotion,
  emojiRenameGroup, emojiConfirmRenameGroup, emojiDeleteGroup,
  emojiRenameEmotion, emojiConfirmRenameEmotion, emojiDeleteEmotion,
  emojiUploadImages, emojiImageMenu,
  emojiRenameImage, emojiConfirmRenameImage, emojiDeleteImage,
  emojiImportPick, emojiImportSubmit, emojiExportGroup,
  onProfileAvatarSelected, saveProfile,
  addMemory, editMemory, saveMemory, deleteMemoryConfirm,
  step,
  mcpTransportChange,
  mcpAddEnvRow, mcpRemoveEnvRow, mcpUpdateEnvKey, mcpUpdateEnvVal,
  mcpTestConnection,
  mcpSaveServer, mcpDeleteServer,
  mcpConnect, mcpDisconnect, mcpRefresh,
  mcpToggleAdapterAdvanced, mcpAdapterServerChange,
  mcpAddAdapterParam, mcpRemoveAdpParam, mcpUpdateAdpParam,
  mcpAddAdapterMapping, mcpRemoveAdpMapping, mcpUpdateAdpMapping,
  mcpAddAdapterInject, mcpRemoveAdpInject, mcpUpdateAdpInject,
  mcpSaveAdapter, mcpDeleteAdapter,
  mcpSwitchEditMode, mcpParseJson, mcpImportJson,
  mcpSaveUrl, mcpUrlAutoName,
  pluginToggle, pluginSaveConfig, pluginReload, pluginRefresh,
  pluginShowInstall, pluginSourceInput, pluginStartPreview, pluginOpenTask, pluginCancelTask, pluginConfirmTask,
  pluginCheckUpdates, pluginPreviewUpgrade,
  showQuickSetup, submitQuickSetup, skipQuickSetup,
  qsProviderChange, qsAvatarSelected,
  qsSelectAccount, qsStartScan,
  qsChannelChange, qsSubmitForm,
  qsImportProviderChange,
  qsSetCreateMode, qsImportFilePicked, qsImportWbToggle,
  qsPasteApiKey, qsGeneratePersona, qsClearNameError,
  qsToggleCollapse, qsToggleStep4Telemetry,
  finishQuickSetup,
  checkForUpdate, startUpdateDownload, applyUpdate,
  toggleTelemetry,
  wbImportPick, wbImportSubmit,
  wbSave, wbDeleteCurrent,
  wbAddSection, wbRemoveSection,
  wbSectionKeyChange, wbSectionValChange, wbSectionToggle,
  wbPickerConfirm,
  wbOnRangeChange, wbOnKwToggle, wbPersonaPick, wbPersonaPickConfirm,
  wbExportPick, wbExportCurrent, _wbExportGo,
  momentsRefresh, momentsOpenPublish, momentsItemMenu, momentsDelete,
  momentsLikeToggle, momentsOpenComposer, momentsReplyTo,
  momentsReplyMenu, momentsDeleteReply,
  momentsCloseComposer, momentsSubmitReply,
  momentsEdit, momentsEditReply, momentsSubmitEdit,
  momentsPickCover, momentsCoverMenu, momentsPickCoverFile,
  momentsOnCoverFile, momentsCoverDelete,
  momentsPickPubImages, momentsOnPublishFiles, momentsRemovePubImage,
  momentsSubmitPublish,
  momentsOnProbInput, momentsResetPrompt, momentsSaveSettings,
  pwOnProviderChange, pwGenerate, pwCreatePersona,
};

/* ============ Init ============ */

async function loadProfile() {
  try {
    const res = await api.get("/api/profile");
    state.profile = { name: res.name || "我", has_avatar: !!res.has_avatar };
  } catch (e) { /* keep default */ }
}

async function loadThemeSettings() {
  try {
    const s = await api.get("/api/settings");
    state.settings = s;
  } catch (e) { /* keep default */ }
  try { await applyThemeFromState(); } catch (e) { /* silent */ }
  watchSystemTheme();
}

async function checkUpdateOnStartup() {
  const maxRetries = 15;
  const retryDelay = 2000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const u = await api.get("/api/update/check", { bypassCache: true });
      if (u.checking) {
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }
      state._updateInfo = u;
      if (u.download_state) state._updateState = u.download_state;
      if (u.has_update && u.latest_version) {
        await _waitOverlayClear();
        _showUpdateFoundDialog(u);
      }
      return;
    } catch (e) {
      return;
    }
  }
}

function _waitOverlayClear(maxWait = 120000) {
  return new Promise(resolve => {
    const overlay = document.getElementById("overlay");
    if (!overlay || !overlay.classList.contains("show")) {
      resolve();
      return;
    }
    const start = Date.now();
    const poll = () => {
      if (Date.now() - start > maxWait || !overlay.classList.contains("show")) {
        resolve();
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

function _showUpdateFoundDialog(u) {
  const latest = esc(u.latest_version || "");
  const current = esc(u.current_version || "");
  const changelog = (u.changelog || "").trim();
  const updateState = u.download_state || state._updateState || {};
  const canDownload = !!u.download_available;
  const ready = !!updateState.ready;

  let changelogHtml = "";
  if (changelog) {
    const lines = changelog.split("\n").slice(0, 15).join("\n");
    changelogHtml = `<div style="margin:12px 0 0;max-height:200px;overflow-y:auto;padding:10px 12px;background:var(--bg);border-radius:8px;font-size:13px;color:var(--text-2);white-space:pre-wrap;line-height:1.6;text-align:left">${esc(lines)}</div>`;
  }

  const actionBtn = ready
    ? `<button onclick="PawzoChat.applyUpdate()" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">立即重启更新</button>`
    : canDownload
      ? `<button onclick="PawzoChat.startUpdateDownload()" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">下载并更新</button>`
      : `<button onclick="PawzoChat.closeOverlay();PawzoChat.switchTab('settings');setTimeout(()=>PawzoChat.pushPage('settingsAbout'),300)" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--primary);color:#fff;font-size:15px;cursor:pointer;font-family:var(--font)">查看详情</button>`;

  showSheet(`<div style="padding:24px">
    <div style="text-align:center;margin-bottom:8px">
      <div style="width:48px;height:48px;border-radius:50%;background:var(--primary-light);color:var(--primary);display:inline-flex;align-items:center;justify-content:center;font-size:24px">
        ${iconHtml("ri-upload-2-line")}
      </div>
    </div>
    <div class="sheet-title">发现新版本</div>
    <div style="text-align:center;margin:8px 0 4px;font-size:14px;color:var(--text-2)">
      <span>v${current}</span>
      <span style="margin:0 8px;color:var(--text-3)">→</span>
      <span style="color:var(--primary);font-weight:600">v${latest}</span>
    </div>
    ${changelogHtml}
    <div style="display:flex;gap:12px;margin-top:20px">
      <button onclick="PawzoChat.closeOverlay()" style="flex:1;padding:10px;border:none;border-radius:var(--radius-btn);background:var(--bg);color:var(--text-2);font-size:15px;cursor:pointer;font-family:var(--font)">稍后再说</button>
      ${actionBtn}
    </div>
  </div>`, null, { dismissOverlay: false });
}

document.addEventListener("DOMContentLoaded", () => {
  loadProfile();
  loadThemeSettings();
  switchTab("chat");
  initSSE();
  checkAndShowSetup();
  checkUpdateOnStartup();
});
